// AC-5.10 (DBS-185): làm một giao dịch chuyển tiền «nằm giữa transaction» đủ lâu để dừng task api, rồi thăm dò kết quả.
// Chạy TRONG task `dbs-migrate` bằng `node -e "$(cat …)"` (qua --overrides; xem ac-5-10-tools.py). Image chỉ có dist/ và
// node_modules/, nên require('pg') tìm từ /app. Không in mật khẩu. DDL duy nhất: hàm và trigger tạm `dbs185_slow`.
// MODE=slow-on:  SLEEP_SECONDS (mặc định 115, dưới statement_timeout 120 s của api). Trigger BEFORE INSERT trên ledger_entries chỉ gọi pg_sleep rồi trả về.
// MODE=slow-off: chờ tới khi không còn backend nào giữ ledger_entries, rồi gỡ trigger và hàm (thử lại khi lock_timeout 3 s; tối đa 240 s).
// MODE=watch:    WATCH_SECONDS (mặc định 170). Mỗi 2 s ghi backend đang giữa transaction (khóa idempotency_keys).
// MODE=probe:    ACCOUNT_ID, TO_ACCOUNT_ID, IDEM_KEY, INFLIGHT_PID (đều tùy chọn). Chỉ đọc.
// Kết nối: DATABASE_URL, hoặc DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD (+ DATABASE_SSL, DATABASE_SSL_CA_PATH).
const fs = require('fs');
const { Client } = require('pg');
const env = process.env;
const log = o => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
function cfg(extra) {
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL, ...extra };
  const c = { host: env.DB_HOST, port: Number(env.DB_PORT || 5432), database: env.DB_NAME, user: env.DB_USER, password: env.DB_PASSWORD, ...extra };
  if (env.DATABASE_SSL === 'true') c.ssl = { ca: fs.readFileSync(env.DATABASE_SSL_CA_PATH, 'utf8') };
  return c;
}
async function withClient(extra, fn) {
  const c = new Client(cfg(extra));
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end().catch(() => undefined);
  }
}
const intEnv = (k, d, lo, hi) => {
  const n = Number(env[k] || d);
  if (!Number.isInteger(n) || n < lo || n > hi) throw new Error(k + ' must be an integer ' + lo + '..' + hi);
  return n;
};
const DROP_TRIGGER = 'DROP TRIGGER IF EXISTS dbs185_slow ON public.ledger_entries';
const DROP_FUNCTION = 'DROP FUNCTION IF EXISTS public.dbs185_slow()';

async function slowOn() {
  const n = Number(env.SLEEP_SECONDS || 115);
  if (!Number.isInteger(n) || n < 1 || n > 600) throw new Error('SLEEP_SECONDS must be an integer 1..600');
  await withClient({}, async c => {
    await c.query(DROP_TRIGGER);
    await c.query(`CREATE OR REPLACE FUNCTION public.dbs185_slow() RETURNS trigger LANGUAGE plpgsql AS $f$ BEGIN PERFORM pg_sleep(${n}); RETURN NULL; END $f$`);
    await c.query('CREATE TRIGGER dbs185_slow BEFORE INSERT ON public.ledger_entries FOR EACH STATEMENT EXECUTE FUNCTION public.dbs185_slow()');
    log({ event: 'SLOW_ON', sleepSeconds: n });
  });
}

async function slowOff() {
  const deadline = Date.now() + 240000;
  const BUSY = `SELECT count(DISTINCT l.pid)::int AS n FROM pg_locks l JOIN pg_class r ON r.oid = l.relation
    WHERE r.relname = 'ledger_entries' AND l.locktype = 'relation' AND l.granted AND l.mode = 'RowExclusiveLock' AND l.pid <> pg_backend_pid()`;
  await withClient({ lock_timeout: 3000, statement_timeout: 20000 }, async c => {
    for (;;) {
      const busy = (await c.query(BUSY)).rows[0].n;
      if (busy === 0) {
        try {
          await c.query(DROP_TRIGGER);
          await c.query(DROP_FUNCTION);
          const left = (await c.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'dbs185_slow'")).rows[0].n;
          log({ event: 'SLOW_OFF', triggerPresent: left });
          if (left === 0) return;
        } catch (e) {
          if (!e || e.code !== '55P03') throw e;
        }
      }
      if (Date.now() > deadline) throw new Error('slow-off timed out: trigger may still exist, busy backends ' + busy);
      await sleep(2000);
    }
  });
}

// Backend giữa transaction = đang giữ RowExclusiveLock trên idempotency_keys (claimKey đã chạy); kèm các khóa quan hệ khác của nó.
const WATCH_SQL = `SELECT l.pid, string_agg(c.relname || ':' || l.mode, ',' ORDER BY c.relname, l.mode) AS locks
  FROM pg_locks l JOIN pg_class c ON c.oid = l.relation
  WHERE l.locktype = 'relation' AND l.granted AND l.pid <> pg_backend_pid()
    AND c.relname IN ('idempotency_keys', 'transfers', 'ledger_entries', 'accounts')
  GROUP BY l.pid HAVING bool_or(c.relname = 'idempotency_keys' AND l.mode = 'RowExclusiveLock')`;

async function watch() {
  const secs = intEnv('WATCH_SECONDS', 170, 10, 600);
  await withClient({}, async c => {
    log({ event: 'READY', watchSeconds: secs });
    for (const end = Date.now() + secs * 1000; Date.now() < end; await sleep(2000)) {
      const r = (await c.query(WATCH_SQL)).rows;
      log({ event: 'sample', inflight: r.map(x => ({ pid: x.pid, locks: x.locks })) });
    }
    log({ event: 'DONE' });
  });
}

async function probe() {
  await withClient({}, async c => {
    try {
      await c.query('BEGIN READ ONLY');
      const q = async (sql, p) => (await c.query(sql, p)).rows;
      const accounts = [env.ACCOUNT_ID, env.TO_ACCOUNT_ID].filter(Boolean);
      const out = { event: 'probe' };
      if (env.IDEM_KEY) {
        out.keyRows = await q('SELECT user_id, response_code, transfer_id FROM idempotency_keys WHERE idem_key = $1', [env.IDEM_KEY]);
      }
      if (accounts.length) {
        out.balances = await q('SELECT id, balance::text AS balance FROM accounts WHERE id = ANY($1::uuid[]) ORDER BY id', [accounts]);
        out.transfers = (await q('SELECT count(*)::int AS n FROM transfers WHERE from_account_id = ANY($1::uuid[])', [accounts]))[0].n;
        out.entries = await q(
          'SELECT direction, count(*)::int AS n, COALESCE(sum(amount), 0)::text AS amount FROM ledger_entries WHERE account_id = ANY($1::uuid[]) GROUP BY direction ORDER BY direction',
          [accounts],
        );
      }
      if (env.INFLIGHT_PID) {
        out.inflightLocks = (await q('SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1::int AND pid <> pg_backend_pid()', [env.INFLIGHT_PID]))[0].n;
      }
      out.triggerPresent = (await q("SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'dbs185_slow'"))[0].n;
      out.reconciliation = await q(
        'SELECT id, started_at, finished_at, status, mismatched_accounts, total_debit::text AS total_debit, total_credit::text AS total_credit, total_balance::text AS total_balance FROM reconciliation_runs ORDER BY id DESC LIMIT 3',
      );
      log(out);
    } finally {
      await c.query('ROLLBACK').catch(() => undefined);
    }
  });
}

const modes = { 'slow-on': slowOn, 'slow-off': slowOff, watch, probe };
(modes[env.MODE] || (() => Promise.reject(new Error('MODE must be slow-on, slow-off, watch or probe'))))().catch(e => {
  log({ event: 'ERROR', message: String((e && e.message) || e).slice(0, 200) });
  process.exitCode = 1;
});
