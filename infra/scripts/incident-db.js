// Kịch bản sự cố trên cloud (DBS-184): ép và gỡ lỗi consumer notification không đổi code, bằng một CHECK luôn sai trên
// notification_log. Chạy TRONG task `dbs-migrate` (role dbs_migrator, chủ bảng) bằng `node -e "$(cat …)"` qua --overrides
// (xem ac-5-10-tools.py overrides --script). Không in mật khẩu. DDL duy nhất: thêm và gỡ constraint `dbs183_block`.
// MODE=notification-block:   ADD CONSTRAINT dbs183_block CHECK (false) NOT VALID (mọi INSERT mới vào notification_log lỗi 23514)
// MODE=notification-unblock: DROP CONSTRAINT IF EXISTS dbs183_block
// MODE=notification-check:   chỉ đọc: constraint còn không (pg_constraint), số dòng notification_log
// DDL chạy tự động commit, lock_timeout 3 s, thử lại tới 5 lần (khóa độc quyền có thể xếp hàng sau giao dịch của worker).
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
const STATE = "SELECT count(*)::int AS n FROM pg_constraint c JOIN pg_class r ON r.oid = c.conrelid WHERE r.relname = 'notification_log' AND c.conname = 'dbs183_block'";
const ADD = 'ALTER TABLE public.notification_log ADD CONSTRAINT dbs183_block CHECK (false) NOT VALID';
const DROP = 'ALTER TABLE public.notification_log DROP CONSTRAINT IF EXISTS dbs183_block';

async function ddl(sql, wantBlocked) {
  await withClient({ lock_timeout: 3000 }, async c => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        await c.query(sql);
      } catch (e) {
        if (e && e.code === '42710' && wantBlocked) break; // constraint already exists
        if (!e || e.code !== '55P03') throw e;
        log({ event: 'RETRY', attempt, reason: 'lock_timeout' });
        await sleep(2000);
        continue;
      }
      break;
    }
    const n = (await c.query(STATE)).rows[0].n;
    log({ event: wantBlocked ? 'BLOCKED' : 'UNBLOCKED', blocked: n > 0 });
    if ((n > 0) !== wantBlocked) throw new Error('constraint state is not the expected one');
  });
}

async function check() {
  await withClient({}, async c => {
    const blocked = (await c.query(STATE)).rows[0].n > 0;
    const rows = (await c.query('SELECT count(*)::int AS n FROM notification_log')).rows[0].n;
    log({ event: 'check', blocked, notificationLogRows: rows });
  });
}

const modes = {
  'notification-block': () => ddl(ADD, true),
  'notification-unblock': () => ddl(DROP, false),
  'notification-check': check,
};
(modes[env.MODE] || (() => Promise.reject(new Error('MODE must be notification-block, notification-unblock or notification-check'))))().catch(e => {
  log({ event: 'ERROR', message: String((e && e.message) || e).slice(0, 200) });
  process.exitCode = 1;
});
