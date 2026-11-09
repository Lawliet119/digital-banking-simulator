// Real HTTP + PostgreSQL ACL checks, independently driven outside Jest.
const { resolve } = require('node:path');
process.chdir(resolve(__dirname, '..'));
process.env.NODE_ENV = 'test';
require('ts-node/register');
require('tsconfig-paths/register');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');
const {
  createRolePermissionsFixture,
  expectAclDenied,
  rollbackProbe,
  protectedMutations,
  flagInsert,
  transferInsert,
  auditInsert,
  assertRuntimeRole,
  assertMoneyUnchanged,
} = require('../test/support/db-role-permissions');

async function main() {
  console.log(execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim());
  console.log('DBS-122 actual LOGIN / PostgreSQL 17 / independent manual driver');
  let fixture;
  try {
    fixture = await createRolePermissionsFixture();
    for (const [source, role] of [
      [fixture.api, 'dbs_api'],
      [fixture.worker, 'dbs_worker'],
    ]) {
      console.log('M01 role:', JSON.stringify(await assertRuntimeRole(source, role)));
    }
    const counts = await fixture.owner.query(`SELECT
      (SELECT count(*)::int FROM transfers) AS transfers,
      (SELECT count(*)::int FROM ledger_entries) AS ledger_entries,
      (SELECT count(*)::int FROM audit_log) AS audit_log`);
    assert.equal(counts[0].transfers, 4);
    assert.equal(counts[0].ledger_entries, 8);
    assert.ok(counts[0].audit_log > 0);
    await assertMoneyUnchanged(fixture);
    console.log(
      'M01 PASS: HTTP onboarding/accounts/deposit/3 transfers; counts=',
      JSON.stringify(counts),
      'invariants=PASS debit=credit=1006000',
    );

    for (const [verb, table, column] of protectedMutations) {
      const [{ granted }] = await fixture.api.query(
        `SELECT has_table_privilege(current_user,$1,$2)
        OR ($2='UPDATE' AND has_any_column_privilege(current_user,$1,'UPDATE')) AS granted`,
        [table, verb],
      );
      assert.equal(granted, false);
      const [row] = await fixture.owner.query(`SELECT id FROM ${table} ORDER BY id LIMIT 1`);
      assert.ok(row);
      const before = await fixture.owner.query(`SELECT * FROM ${table} ORDER BY id`);
      const sql =
        verb === 'UPDATE'
          ? `UPDATE ${table} SET ${column}=${column} WHERE id=$1`
          : `DELETE FROM ${table} WHERE id=$1`;
      const code = await expectAclDenied(fixture.api, sql, [row.id]);
      assert.deepEqual(await fixture.owner.query(`SELECT * FROM ${table} ORDER BY id`), before);
      await assertMoneyUnchanged(fixture);
      console.log(
        `M02 PASS: dbs_api ${verb} ${table}; SQLSTATE=${code} routine=aclcheck_error; nonempty rows unchanged`,
      );
    }

    const transfer = transferInsert(fixture, randomUUID());
    await rollbackProbe(fixture.api, transfer.sql, transfer.args);
    assert.equal(await expectAclDenied(fixture.worker, transfer.sql, transfer.args), '42501');
    const flag = flagInsert(fixture.transfers[1].id);
    await rollbackProbe(fixture.worker, flag.sql, flag.args);
    assert.equal(await expectAclDenied(fixture.api, flag.sql, flag.args), '42501');
    await assertMoneyUnchanged(fixture);
    console.log(
      'M03 PASS: worker INSERT transfers=42501; API INSERT fraud_flags=42501; identical valid-input controls roll back',
    );

    const committed = fixture.transfers[0];
    const allowedFlag = flagInsert(committed.id),
      audit = auditInsert(committed);
    await fixture.worker.transaction(async manager => {
      await manager.query(allowedFlag.sql, allowedFlag.args);
      await manager.query(audit.sql, audit.args);
    });
    const persistedFlags = await fixture.owner.query(
      'SELECT score,risk_level,review_status FROM fraud_flags WHERE transfer_id=$1',
      [committed.id],
    );
    assert.deepEqual(persistedFlags, [{ score: 75, risk_level: 'HIGH', review_status: 'OPEN' }]);
    const persistedAudits = await fixture.owner.query(
      "SELECT actor_role,outcome,correlation_id FROM audit_log WHERE action='fraud.flagged' AND target_id=$1",
      [committed.id],
    );
    assert.deepEqual(persistedAudits, [
      { actor_role: 'worker', outcome: 'SUCCESS', correlation_id: committed.correlationId },
    ]);
    assert.equal(await expectAclDenied(fixture.worker, 'SELECT * FROM transfers'), '42501');
    const ids = fixture.transfers.map(t => t.id);
    const view = await fixture.worker.query(
      'SELECT * FROM v_transfer_facts WHERE id=ANY($1::uuid[]) ORDER BY id',
      [ids],
    );
    const expected = await fixture.owner.query(
      'SELECT id,type,from_account_id,to_account_id,amount,status,created_at FROM transfers WHERE id=ANY($1::uuid[]) ORDER BY id',
      [ids],
    );
    assert.equal(view.length, 3);
    assert.deepEqual(view, expected);
    await assertMoneyUnchanged(fixture);
    console.log(
      'M04 PASS: worker COMMIT flag=',
      JSON.stringify(persistedFlags),
      'audit=',
      JSON.stringify(persistedAudits),
    );
    console.log(
      'M04 PASS: worker SELECT transfers=42501; view returns exact 3 committed facts; connection recovered',
    );

    const negative = flagInsert(fixture.transfers[2].id);
    try {
      await fixture.owner.query('GRANT INSERT ON fraud_flags TO dbs_api');
      await assert.rejects(
        () => expectAclDenied(fixture.api, negative.sql, negative.args),
        /Forbidden statement unexpectedly succeeded/,
      );
    } finally {
      await fixture.owner.query('REVOKE INSERT ON fraud_flags FROM dbs_api');
    }
    assert.deepEqual(
      await fixture.owner.query('SELECT * FROM fraud_flags WHERE transfer_id=$1', [
        fixture.transfers[2].id,
      ]),
      [],
    );
    assert.equal(await expectAclDenied(fixture.api, negative.sql, negative.args), '42501');
    await assertMoneyUnchanged(fixture);
    console.log(
      'M05 PASS: excess GRANT detected; accidental allowed write rolled back; REVOKE restores 42501; money unchanged',
    );
  } finally {
    if (fixture) {
      const containerId = fixture.containerId;
      await fixture.close();
      const running = execFileSync('docker', ['ps', '-aq', '--filter', `id=${containerId}`], {
        encoding: 'utf8',
      }).trim();
      assert.equal(running, '', 'Owned PostgreSQL container must be removed');
      assert.equal(fixture.api.isInitialized, false);
      assert.equal(fixture.worker.isInitialized, false);
      assert.equal(fixture.owner.isInitialized, false);
      console.log(
        'M06 PASS: app/pools closed; owned PostgreSQL container removed; shared Compose untouched',
      );
    }
  }
  console.log(
    'RESULT PASS: 6/6 manual steps; no SQL financial seed, no AWS, no shared role mutation',
  );
}

main().catch(error => {
  // Avoid dumping connection options, query parameters or secrets on a failed setup.
  console.error('MANUAL FAILED:', error.name, error.code ?? '', error.message);
  process.exitCode = 1;
});
