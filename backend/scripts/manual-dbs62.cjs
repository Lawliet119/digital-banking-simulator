// Disposable local HTTP exercise. Never logs JWTs, keys or connection credentials.
process.env.NODE_ENV = 'test';
require('ts-node/register');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const {
  startPostgresContainer,
  stopPostgresContainer,
} = require('../test/support/postgres.container');
const { createTempDatabase, migrate } = require('../test/support/temp-database');
const { startOnboardingApp } = require('../test/support/onboarding-app');

async function main() {
  console.log(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  let db, stack;
  try {
    const postgres = await startPostgresContainer();
    process.env.DATABASE_URL = postgres.databaseUrl;
    db = await createTempDatabase();
    await migrate(db.url);
    stack = await startOnboardingApp(db.url);
    const query = (sql, args = []) => db.runner.query(sql, args);
    const user = async () => {
      const sub = randomUUID();
      return { sub, token: await stack.issuer.token('customer', { sub }) };
    };
    const http = async (method, token, body) => {
      const response = await fetch(stack.url + '/v1/customers/me', {
        method,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          'Content-Type': 'application/json',
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      const bodyResult = await response.json();
      console.log(
        JSON.stringify({
          method,
          path: '/v1/customers/me',
          status: response.status,
          correlationId: response.headers.get('x-correlation-id'),
          body: bodyResult,
        }),
      );
      return { status: response.status, body: bodyResult };
    };
    const a = await user();
    assert.equal((await http('GET', a.token)).status, 404);
    const created = await http('POST', a.token, { fullName: '  Nguyễn Minh Anh  ' });
    assert.equal(created.status, 200);
    assert.equal(created.body.fullName, 'Nguyễn Minh Anh');
    assert.deepEqual(
      await query(
        "SELECT count(*)::int AS n FROM audit_log WHERE action='customer.created' AND target_id=$1",
        [created.body.id],
      ),
      [{ n: 1 }],
    );
    console.log('M-62-01 PASS: GET 404 -> POST 200; normalized demo profile; creation audit=1');
    const replay = await http('POST', a.token, { fullName: 'Tên khác' });
    const read = await http('GET', a.token);
    assert.equal(replay.status, 200);
    assert.equal(read.status, 200);
    assert.deepEqual(replay.body, created.body);
    assert.deepEqual(read.body, created.body);
    console.log('M-62-02 PASS: replay and GET return the same id, original name and timestamp');
    const b = await user();
    const parallel = await Promise.all(
      Array.from({ length: 20 }, () => http('POST', b.token, { fullName: 'Trần Thu Hà' })),
    );
    parallel.forEach(response => {
      assert.equal(response.status, 200);
      assert.deepEqual(response.body, parallel[0].body);
    });
    assert.deepEqual(
      await query(
        'SELECT count(*)::int AS n FROM customers c JOIN users u ON c.user_id=u.id WHERE u.cognito_sub=$1',
        [b.sub],
      ),
      [{ n: 1 }],
    );
    assert.deepEqual(
      await query(
        "SELECT count(*)::int AS n FROM audit_log WHERE action='customer.created' AND target_id=$1",
        [parallel[0].body.id],
      ),
      [{ n: 1 }],
    );
    console.log(
      'M-62-03 PASS: 20 concurrent HTTP requests -> 20x200; customer=1, creation audit=1',
    );
    const anonymous = await http('POST', undefined, { fullName: 'Demo' });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.errorCode, 'UNAUTHENTICATED');
    const operator = await stack.issuer.token('operator', { sub: randomUUID() });
    const denied = await http('POST', operator, { fullName: 'Demo' });
    assert.equal(denied.status, 403);
    assert.equal(denied.body.errorCode, 'FORBIDDEN');
    assert.equal((await http('POST', a.token, { fullName: '  ' })).status, 400);
    assert.equal(
      (await http('POST', a.token, { fullName: 'Demo', userId: randomUUID() })).status,
      400,
    );
    console.log('M-62-04 PASS: 401 UNAUTHENTICATED, 403 FORBIDDEN; invalid/forged body400');
    const c = await user();
    await query(
      "CREATE FUNCTION dbs62_manual_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$",
    );
    await query(
      'CREATE TRIGGER dbs62_manual_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION dbs62_manual_fail()',
    );
    try {
      const failed = await http('POST', c.token, { fullName: 'Phạm Ngọc Lan' });
      assert.equal(failed.status, 500);
      assert.equal(failed.body.detail, 'Internal server error');
      assert.deepEqual(
        await query(
          'SELECT count(*)::int AS n FROM customers c JOIN users u ON c.user_id=u.id WHERE u.cognito_sub=$1',
          [c.sub],
        ),
        [{ n: 0 }],
      );
    } finally {
      await query('DROP TRIGGER dbs62_manual_fail ON audit_log');
      await query('DROP FUNCTION dbs62_manual_fail()');
    }
    const recovered = await http('POST', c.token, { fullName: 'Phạm Ngọc Lan' });
    assert.equal(recovered.status, 200);
    const [audit] = await query(
      "SELECT metadata FROM audit_log WHERE action='customer.created' AND target_id=$1",
      [recovered.body.id],
    );
    assert.deepEqual(audit.metadata, { id: recovered.body.id });
    console.log(
      'M-62-05 PASS: real audit INSERT failure -> sanitized500, customer=0; recovery200, metadata only id',
    );
  } finally {
    try {
      await stack?.close();
    } finally {
      try {
        await db?.drop();
      } finally {
        await stopPostgresContainer();
      }
    }
    console.log('M-62-06 PASS: app/JWKS/temp database/owned PostgreSQL container cleaned up');
  }
}
main().catch(error => {
  console.error(error.name + ': ' + error.message);
  process.exitCode = 1;
});
