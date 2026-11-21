// BL-218: DBS-136 với worker THẬT (tiến trình `node dist/main`, APP_ROLE=worker, full AppModule),
// hard-kill giữa lúc dọn rồi chạy lại. Cần `npm run build` trước và Docker.
// Dựng PG17, ElasticMQ, Valkey RIÊNG (dbs-bl218-*), không đụng Compose dùng chung; xóa hết ở cuối.
const { resolve } = require('node:path');
process.chdir(resolve(__dirname, '..'));
process.env.NODE_ENV = 'test';
require('ts-node/register');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { execFileSync, spawn } = require('node:child_process');
const { setTimeout: sleep } = require('node:timers/promises');
const { createDedupCleanupFixture } = require('../test/support/dedup-cleanup');
const { ELASTICMQ_IMAGE } = require('../test/support/elasticmq.container');

const ROWS = 100_000;
const NAMES = ['dbs-bl218-mq', 'dbs-bl218-valkey'];
const docker = (...args) => execFileSync('docker', args, { encoding: 'utf8' }).trim();
const hostPort = (name, port) => docker('port', name, String(port)).split('\n')[0].split(':').pop();

function startWorker(env) {
  const child = spawn(process.execPath, ['dist/main'], {
    env: { ...process.env, ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  const take = chunk => lines.push(...String(chunk).split('\n').filter(Boolean));
  child.stdout.on('data', take);
  child.stderr.on('data', take);
  return { child, lines };
}

async function waitFor(check, label, ms = 60_000) {
  const end = Date.now() + ms;
  for (;;) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timeout: ${label}`);
    await sleep(40);
  }
}

function hardKill(child) {
  // Không chạy shutdown hook. Windows: kill() đã là TerminateProcess; nơi khác là SIGKILL.
  child.kill('SIGKILL');
}

const exited = child =>
  child.exitCode !== null || child.signalCode !== null
    ? Promise.resolve()
    : new Promise(resolve => child.once('exit', resolve));

const moneySnapshot = async owner => ({
  accounts: await owner.query('SELECT id,balance::text FROM accounts ORDER BY id'),
  transfers: await owner.query('SELECT count(*)::int AS n FROM transfers'),
  ledgerEntries: await owner.query('SELECT count(*)::int AS n FROM ledger_entries'),
});

async function main() {
  const git = (...a) => execFileSync('git', a, { encoding: 'utf8' }).trim();
  const dirty = git('status', '--porcelain', '--', '.')
    .split(String.fromCharCode(10))
    .filter(Boolean).length;
  console.log(
    git('describe', '--always', '--dirty', '--abbrev=40'),
    '| file đổi chưa commit:',
    dirty,
  );
  let f;
  const extra = [];
  let worker;
  let passed = false;
  try {
    f = await createDedupCleanupFixture();
    for (const name of NAMES) {
      try {
        docker('rm', '-f', '-v', name); // bỏ container sót của lần chạy trước
      } catch {
        // chưa có thì thôi
      }
    }
    for (const [name, args] of [
      [
        'dbs-bl218-mq',
        [
          '-p',
          '127.0.0.1::9324',
          '-v',
          `${resolve('..', 'infra', 'local', 'elasticmq.conf')}:/opt/elasticmq.conf:ro`,
          ELASTICMQ_IMAGE,
        ],
      ],
      ['dbs-bl218-valkey', ['-p', '127.0.0.1::6379', 'valkey/valkey:8-alpine']],
    ]) {
      extra.push(name);
      docker('run', '-d', '--name', name, ...args);
    }
    const mq = `http://127.0.0.1:${hostPort('dbs-bl218-mq', 9324)}`;
    const env = {
      NODE_ENV: 'development',
      APP_ROLE: 'worker',
      LOG_LEVEL: 'debug',
      DATABASE_URL: f.workerUrl,
      REDIS_URL: `redis://127.0.0.1:${hostPort('dbs-bl218-valkey', 6379)}`,
      SQS_ENDPOINT: mq,
      SQS_RISK_QUEUE_URL: `${mq}/000000000000/risk-events`,
      SQS_NOTIFICATION_QUEUE_URL: `${mq}/000000000000/notification-events`,
      AWS_REGION: 'ap-southeast-1',
      AWS_ACCESS_KEY_ID: 'local',
      AWS_SECRET_ACCESS_KEY: 'local',
    };

    // Dữ liệu: một khoản nạp tiền thật qua HTTP (key còn hạn), rồi INPUT metadata quá hạn/còn hạn.
    const key = 'bl218-live-key';
    await f.deposit(key);
    const [{ id: actor }] = await f.owner.query('SELECT id FROM users LIMIT 1');
    await f.owner.query(
      `INSERT INTO idempotency_keys(user_id,idem_key,request_hash,response_code,response_body,created_at)
       SELECT $1,'old-'||g,$2,201,'{}',now()-interval '8 days'-make_interval(secs=>g) FROM generate_series(1,${ROWS}) g`,
      [actor, 'a'.repeat(64)],
    );
    await f.owner.query(
      `INSERT INTO processed_events(consumer,event_id,processed_at)
       SELECT 'old',gen_random_uuid(),now()-interval '8 days'-make_interval(secs=>g) FROM generate_series(1,${ROWS}) g`,
    );
    await f.owner.query(
      `INSERT INTO idempotency_keys(user_id,idem_key,request_hash,response_code,response_body,created_at)
       SELECT $1,'fresh-'||g,$2,201,'{}',now()-interval '1 day' FROM generate_series(1,50) g`,
      [actor, 'b'.repeat(64)],
    );
    await f.owner.query(
      `INSERT INTO processed_events(consumer,event_id,processed_at)
       SELECT 'fresh',gen_random_uuid(),now()-interval '1 day' FROM generate_series(1,50) g`,
    );
    const money = await moneySnapshot(f.owner);
    const before = await f.counts();
    assert.equal(before.keys, ROWS + 51);
    assert.equal(before.marks, ROWS + 50);
    console.log(
      `M01 SEED: idempotency_keys=${before.keys} (${ROWS} quá hạn, 51 còn hạn gồm key của khoản nạp), processed_events=${before.marks} (${ROWS} quá hạn, 50 còn hạn)`,
    );

    worker = startWorker(env);
    console.log(`M02 worker pid=${worker.child.pid} đã chạy bằng node dist/main`);
    // Kill ngay khi đã xóa được một phần nhưng chưa xong.
    const partial = await waitFor(async () => {
      if (worker.child.exitCode !== null)
        throw new Error('worker thoát sớm, exit=' + worker.child.exitCode);
      const c = await f.counts();
      return c.keys < before.keys && c.keys > 51 + 1000 ? c : null;
    }, 'worker bắt đầu dọn');
    hardKill(worker.child);
    await exited(worker.child);
    const afterKill = await f.counts();
    assert.ok(
      afterKill.keys > 51 && afterKill.keys < before.keys,
      'kill không rơi vào giữa lúc dọn idempotency_keys, chạy lại',
    );
    assert.ok(afterKill.marks >= 50);
    console.log(
      `M03 HARD-KILL giữa chừng: thấy keys=${partial.keys}; sau khi chết keys=${afterKill.keys} marks=${afterKill.marks} (idempotency_keys còn dư chưa dọn hết; processed_events đã dọn xong trước khi kill, 50 còn hạn + mark của consumer thật)`,
    );
    execFileSync(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        '-r',
        'tsconfig-paths/register',
        'src/scripts/invariants/invariants.ts',
      ],
      {
        env: { ...process.env, DATABASE_URL: f.ownerUrl },
        stdio: 'inherit',
      },
    );
    console.log('M03 checker tiền sau kill: exit 0');

    worker = startWorker(env);
    await waitFor(async () => {
      const c = await f.counts();
      return c.keys === 51 && (await f.labels()).marks.every(m => m !== 'old') ? c : null;
    }, 'worker mới dọn hết phần dư');
    const final = await f.labels();
    assert.equal(final.keys.filter(k => k.startsWith('old-')).length, 0);
    assert.ok(final.keys.includes(key));
    assert.equal(final.keys.filter(k => k.startsWith('fresh-')).length, 50);
    assert.equal(final.marks.filter(m => m === 'old').length, 0);
    assert.equal(final.marks.filter(m => m === 'fresh').length, 50);
    console.log(
      `M04 RESTART: worker mới dọn hết phần quá hạn; còn đúng 51 key (gồm key khoản nạp), 50 mark 'fresh' còn hạn, cộng ${final.marks.length - 50} mark do consumer thật của worker ghi cho khoản nạp`,
    );
    await sleep(2000);
    assert.equal(worker.child.exitCode, null, 'worker phải còn sống sau khi dọn');
    await f.invariants();
    assert.deepEqual(await moneySnapshot(f.owner), money);
    execFileSync(
      process.execPath,
      [
        '-r',
        'ts-node/register',
        '-r',
        'tsconfig-paths/register',
        'src/scripts/invariants/invariants.ts',
      ],
      {
        env: { ...process.env, DATABASE_URL: f.ownerUrl },
        stdio: 'inherit',
      },
    );
    console.log(
      'M05 checker tiền sau restart: exit 0; balance từng tài khoản, số transfers và số ledger_entries giống hệt trước khi worker chạy',
    );
    passed = true;
    console.log('--- log worker (30 dòng cuối) ---');
    console.log(worker.lines.slice(-30).join('\n'));
  } finally {
    if (worker && !passed) {
      console.log(
        `worker exitCode=${worker.child.exitCode}; log:\n${worker.lines.slice(-15).join('\n')}`,
      );
    }
    if (worker?.child.exitCode === null) hardKill(worker.child);
    const cleanupErrors = [];
    for (const name of extra) {
      try {
        docker('rm', '-f', '-v', name);
      } catch (error) {
        cleanupErrors.push(error);
      }
    }
    try {
      if (f) await f.close();
      const left = docker('ps', '-aq', '--filter', 'name=dbs-bl218-');
      if (left || (f && docker('ps', '-aq', '--filter', `id=${f.containerId}`))) {
        throw new Error('container dbs-bl218-* hoặc PG riêng còn sót');
      }
    } catch (error) {
      cleanupErrors.push(error);
    }
    if (cleanupErrors.length) {
      console.error('M06 dọn container THẤT BẠI:', cleanupErrors.map(e => e.message).join(' | '));
      process.exitCode = 1;
    } else {
      console.log(
        'M06 dọn: PG/ElasticMQ/Valkey riêng đã xóa (đã kiểm docker ps); Compose dùng chung không đụng',
      );
    }
  }
  console.log('RESULT PASS: 6/6 bước');
}
main().catch(error => {
  console.error('MANUAL FAILED:', error.name, error.code ?? '', error.message);
  process.exitCode = 1;
});
