// AC-5.10 (DBS-185): giữ khóa dòng tài khoản và thăm dò trạng thái, chạy TRONG task `dbs-migrate` bằng
// `node -e "$(cat …)"` (qua --overrides; xem ac-5-10-tools.py). Image chỉ có dist/ và node_modules/, nên
// require('pg') tìm từ /app. Chỉ SELECT, BEGIN, ROLLBACK; không ghi gì, không in mật khẩu.
// MODE=hold:  ACCOUNT_ID, HOLD_SECONDS (mặc định 60). Giữ FOR UPDATE rồi mỗi 2 s ghi một dòng mẫu.
// MODE=probe: ACCOUNT_ID, TO_ACCOUNT_ID, IDEM_KEY, WAITER_PID (đều tùy chọn).
// Kết nối: DATABASE_URL, hoặc DB_HOST, DB_PORT, DB_NAME, DB_USER, DB_PASSWORD (+ DATABASE_SSL, DATABASE_SSL_CA_PATH).
const fs = require('fs');
const { Client } = require('pg');
const env = process.env;
const log = o => console.log(JSON.stringify({ t: new Date().toISOString(), ...o }));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const need = k => {
  if (!env[k]) throw new Error('missing env ' + k);
  return env[k];
};
function cfg() {
  if (env.DATABASE_URL) return { connectionString: env.DATABASE_URL };
  const c = { host: env.DB_HOST, port: Number(env.DB_PORT || 5432), database: env.DB_NAME, user: env.DB_USER, password: env.DB_PASSWORD };
  if (env.DATABASE_SSL === 'true') c.ssl = { ca: fs.readFileSync(env.DATABASE_SSL_CA_PATH, 'utf8') };
  return c;
}
// Waiter = backend đang chờ xid của bên giữ khóa; kèm các khóa quan hệ nó đã giữ (idempotency_keys cho thấy claimKey đã chạy).
const WAITER_SQL = `SELECT l.pid, COALESCE((SELECT string_agg(DISTINCT c.relname || ':' || x.mode, ',') FROM pg_locks x
  JOIN pg_class c ON c.oid = x.relation WHERE x.locktype = 'relation' AND x.pid = l.pid AND x.granted AND c.relname IN ('idempotency_keys', 'accounts')), '') AS locks
  FROM pg_locks l WHERE l.locktype = 'transactionid' AND NOT l.granted AND l.transactionid = $1::xid`;

async function hold() {
  const secs = Number(env.HOLD_SECONDS || 60);
  const a = new Client(cfg());
  const b = new Client(cfg());
  await a.connect();
  await b.connect();
  try {
    await a.query('BEGIN');
    await a.query('SELECT id FROM accounts WHERE id = $1 FOR UPDATE', [need('ACCOUNT_ID')]);
    const h = (await a.query('SELECT pg_current_xact_id()::text AS xid, pg_backend_pid() AS pid')).rows[0];
    log({ event: 'LOCKED', holderXid: h.xid, holderPid: h.pid, holdSeconds: secs });
    for (const end = Date.now() + secs * 1000; Date.now() < end; await sleep(2000)) {
      const w = (await b.query(WAITER_SQL, [h.xid])).rows;
      log({ event: 'sample', waiters: w.map(r => ({ pid: r.pid, locks: r.locks })) });
    }
  } finally {
    await a.query('ROLLBACK').catch(() => undefined);
    log({ event: 'RELEASED' });
    await a.end().catch(() => undefined);
    await b.end().catch(() => undefined);
  }
}

async function probe() {
  const c = new Client(cfg());
  await c.connect();
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
    if (env.WAITER_PID) {
      out.waiterLocks = (await q('SELECT count(*)::int AS n FROM pg_locks WHERE pid = $1::int AND pid <> pg_backend_pid()', [env.WAITER_PID]))[0].n;
    }
    out.reconciliation = await q(
      'SELECT id, started_at, finished_at, status, mismatched_accounts, total_debit::text AS total_debit, total_credit::text AS total_credit, total_balance::text AS total_balance FROM reconciliation_runs ORDER BY id DESC LIMIT 3',
    );
    log(out);
  } finally {
    await c.query('ROLLBACK').catch(() => undefined);
    await c.end().catch(() => undefined);
  }
}

const modes = { hold, probe };
(modes[env.MODE] || (() => Promise.reject(new Error('MODE must be hold or probe'))))().catch(e => {
  log({ event: 'ERROR', message: String((e && e.message) || e).slice(0, 200) });
  process.exitCode = 1;
});
