// Real local HTTP exercise on an owned disposable database. No JWT/credential logging.
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
const { checkLedgerInvariants } = require('../test/support/invariants');

async function main() {
  console.log(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  let db, app;
  try {
    process.env.DATABASE_URL = (await startPostgresContainer()).databaseUrl;
    db = await createTempDatabase();
    await migrate(db.url);
    app = await startOnboardingApp(db.url);
    const q = (sql, args = []) => db.runner.query(sql, args);
    const http = async (path, token, body) => {
      const response = await fetch(app.url + path, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
        },
        body: JSON.stringify(body),
      });
      const result = {
        status: response.status,
        correlationId: response.headers.get('x-correlation-id'),
        body: await response.json(),
      };
      console.log(JSON.stringify({ method: 'POST', path, ...result }));
      return result;
    };
    const customer = async name => {
      const sub = randomUUID(),
        token = await app.issuer.token('customer', { sub });
      const result = await http('/v1/customers/me', token, { fullName: name });
      assert.equal(result.status, 200);
      return { sub, token, id: result.body.id };
    };
    const open = (user, type = 'CHECKING') => http('/v1/accounts', user.token, { type });
    const count = async user =>
      (await q('SELECT count(*)::int AS n FROM accounts WHERE customer_id=$1', [user.id]))[0].n;
    const invariants = async () => {
      const report = await checkLedgerInvariants(db.runner);
      assert.equal(report.status, 'PASS');
      console.log(JSON.stringify({ ledgerInvariants: report }));
    };
    const a = await customer('Nguyễn Minh Anh');
    for (const type of ['CHECKING', 'SAVINGS']) {
      const res = await open(a, type);
      assert.equal(res.status, 201);
      assert.equal(res.body.type, type);
      assert.equal(res.body.balance, '0');
      assert.equal(res.body.status, 'ACTIVE');
    }
    assert.equal(await count(a), 2);
    const successes = await q(
      "SELECT count(*)::int AS n FROM audit_log al JOIN accounts a ON a.id=al.target_id::uuid WHERE al.action='account.open' AND al.outcome='SUCCESS' AND a.customer_id=$1",
      [a.id],
    );
    assert.deepEqual(successes, [{ n: 2 }]);
    await invariants();
    console.log(
      'M-63-01 PASS: CHECKING/SAVINGS201, balance string0 ACTIVE, owned rows2, SUCCESS audits2',
    );

    assert.equal((await open(a)).status, 201);
    const fourth = await open(a);
    assert.equal(fourth.status, 409);
    assert.equal(fourth.body.errorCode, 'ACCOUNT_LIMIT_REACHED');
    assert.equal(await count(a), 3);
    const [rejection] = await q(
      "SELECT outcome,metadata FROM audit_log WHERE action='account.open' AND correlation_id=$1",
      [fourth.correlationId],
    );
    assert.deepEqual(rejection, {
      outcome: 'REJECTED',
      metadata: { reason: 'ACCOUNT_LIMIT_REACHED', count: 3 },
    });
    await invariants();
    console.log(
      'M-63-02 PASS: third201/fourth409 ACCOUNT_LIMIT_REACHED, rows3, rejection audit committed',
    );

    const b = await customer('Trần Thu Hà');
    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, i) => open(b, i % 2 ? 'SAVINGS' : 'CHECKING')),
    );
    assert.equal(responses.filter(r => r.status === 201).length, 3);
    assert.equal(
      responses.filter(r => r.status === 409 && r.body.errorCode === 'ACCOUNT_LIMIT_REACHED')
        .length,
      7,
    );
    assert.equal(await count(b), 3);
    const audits = await q(
      "SELECT al.outcome,count(*)::int AS n FROM audit_log al JOIN users u ON u.id=al.actor_user_id WHERE al.action='account.open' AND u.cognito_sub=$1 GROUP BY al.outcome ORDER BY al.outcome",
      [b.sub],
    );
    assert.deepEqual(audits, [
      { outcome: 'REJECTED', n: 7 },
      { outcome: 'SUCCESS', n: 3 },
    ]);
    console.log(JSON.stringify({ parallelAuditCounts: audits }));
    await invariants();
    console.log('M-63-03 PASS: ten concurrent POSTs ->exact3x201+7x409; account3/audit3+7');

    assert.equal((await http('/v1/accounts', a.token, { type: 'SYSTEM' })).status, 400);
    assert.equal(
      (await http('/v1/accounts', a.token, { type: 'CHECKING', customerId: b.id })).status,
      400,
    );
    const anonymous = await http('/v1/accounts', undefined, { type: 'CHECKING' });
    assert.equal(anonymous.status, 401);
    assert.equal(anonymous.body.errorCode, 'UNAUTHENTICATED');
    const operator = await app.issuer.token('operator', { sub: randomUUID() });
    const forbidden = await http('/v1/accounts', operator, { type: 'CHECKING' });
    assert.equal(forbidden.status, 403);
    assert.equal(forbidden.body.errorCode, 'FORBIDDEN');
    const missingToken = await app.issuer.token('customer', { sub: randomUUID() });
    const missing = await http('/v1/accounts', missingToken, { type: 'CHECKING' });
    assert.equal(missing.status, 404);
    assert.deepEqual(
      await q(
        "SELECT outcome,target_type FROM audit_log WHERE action='account.open' AND correlation_id=$1",
        [missing.correlationId],
      ),
      [{ outcome: 'REJECTED', target_type: 'user' }],
    );
    await invariants();
    console.log(
      'M-63-04 PASS: SYSTEM/forged owner400; anonymous401, operator403, unonboarded404 with persisted REJECTED',
    );

    const c = await customer('Phạm Ngọc Lan');
    await q(
      "CREATE FUNCTION dbs63_manual_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'audit unavailable'; END $$",
    );
    await q(
      'CREATE TRIGGER dbs63_manual_fail BEFORE INSERT ON audit_log FOR EACH ROW EXECUTE FUNCTION dbs63_manual_fail()',
    );
    try {
      const failed = await open(c);
      assert.equal(failed.status, 500);
      assert.equal(failed.body.detail, 'Internal server error');
      assert.equal(await count(c), 0);
    } finally {
      await q('DROP TRIGGER dbs63_manual_fail ON audit_log');
      await q('DROP FUNCTION dbs63_manual_fail()');
    }
    const recovered = await open(c);
    assert.equal(recovered.status, 201);
    assert.equal(recovered.body.balance, '0');
    assert.equal(await count(c), 1);
    await invariants();
    console.log(
      'M-63-05 PASS: real audit INSERT failure ->sanitized500/account0; recovery201/account1/zero',
    );
  } finally {
    try {
      await app?.close();
    } finally {
      try {
        await db?.drop();
      } finally {
        await stopPostgresContainer();
      }
    }
    console.log('M-63-06 PASS: app/JWKS/temp database/owned PostgreSQL17 cleaned up');
  }
}
main().catch(error => {
  console.error(error.name + ': ' + error.message);
  process.exitCode = 1;
});
