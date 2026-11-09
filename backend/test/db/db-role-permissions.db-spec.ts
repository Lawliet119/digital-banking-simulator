import { randomUUID } from 'node:crypto';
import {
  createRolePermissionsFixture,
  expectAclDenied,
  rollbackProbe,
  protectedMutations,
  flagInsert,
  transferInsert,
  auditInsert,
  assertRuntimeRole,
  assertMoneyUnchanged,
  type RolePermissionsFixture,
} from '../support/db-role-permissions';
import { assertDockerAvailable } from '../support/postgres.container';

describe('DBS-122 actual LOGIN role permissions on isolated PostgreSQL 17', () => {
  let fixture: RolePermissionsFixture;

  beforeAll(async () => {
    fixture = await createRolePermissionsFixture();
  });
  afterEach(async () => {
    if (fixture) await assertMoneyUnchanged(fixture);
  });
  afterAll(async () => {
    await fixture?.close();
  });

  it('TC-122-01 real API/worker sessions are unprivileged nonowners; HTTP creates nonempty money data', async () => {
    await assertRuntimeRole(fixture.api, 'dbs_api');
    await assertRuntimeRole(fixture.worker, 'dbs_worker');
    expect(fixture.transfers).toHaveLength(3);
    for (const table of ['transfers', 'ledger_entries', 'audit_log']) {
      const [{ count }] = await fixture.owner.query<{ count: string }[]>(
        `SELECT count(*)::text AS count FROM ${table}`,
      );
      expect(Number(count)).toBeGreaterThan(0);
    }
  });

  it.each(protectedMutations)(
    'TC-122-02 API %s %s is denied by ACL, not append-only trigger',
    async (verb, table, column) => {
      const [{ granted }] = await fixture.api.query<{ granted: boolean }[]>(
        `SELECT has_table_privilege(current_user, $1, $2)
        OR ($2 = 'UPDATE' AND has_any_column_privilege(current_user, $1, 'UPDATE')) AS granted`,
        [table, verb],
      );
      expect(granted).toBe(false);
      const rows = await fixture.owner.query<{ id: string }[]>(
        `SELECT id FROM ${table} ORDER BY id LIMIT 1`,
      );
      expect(rows).toHaveLength(1);
      const before = await fixture.owner.query(`SELECT * FROM ${table} ORDER BY id`);
      const sql =
        verb === 'UPDATE'
          ? `UPDATE ${table} SET ${column} = ${column} WHERE id = $1`
          : `DELETE FROM ${table} WHERE id = $1`;
      expect(await expectAclDenied(fixture.api, sql, [rows[0].id])).toBe('42501');
      expect(await fixture.owner.query(`SELECT * FROM ${table} ORDER BY id`)).toEqual(before);
    },
  );

  it('TC-122-03 worker cannot INSERT transfers using valid VALUES without a forbidden SELECT', async () => {
    const input = transferInsert(fixture, randomUUID());
    // The exact statement succeeds as dbs_api and rolls back: FK/check errors cannot masquerade as ACL denial.
    await rollbackProbe(fixture.api, input.sql, input.args);
    expect(await expectAclDenied(fixture.worker, input.sql, input.args)).toBe('42501');
  });

  it('TC-122-04 API cannot INSERT fraud_flags; identical input is valid under worker', async () => {
    const input = flagInsert(fixture.transfers[1].id);
    await rollbackProbe(fixture.worker, input.sql, input.args);
    expect(await expectAclDenied(fixture.api, input.sql, input.args)).toBe('42501');
    expect(
      await fixture.owner.query('SELECT * FROM fraud_flags WHERE transfer_id=$1', [
        fixture.transfers[1].id,
      ]),
    ).toEqual([]);
  });

  it('TC-122-05 worker can commit fraud_flags and audit_log without audit SELECT/RETURNING', async () => {
    const transfer = fixture.transfers[0];
    const flag = flagInsert(transfer.id),
      audit = auditInsert(transfer);
    await fixture.worker.transaction(async manager => {
      await manager.query(flag.sql, flag.args);
      await manager.query(audit.sql, audit.args);
    });
    expect(
      await fixture.owner.query(
        'SELECT score, risk_level, review_status FROM fraud_flags WHERE transfer_id=$1',
        [transfer.id],
      ),
    ).toEqual([{ score: 75, risk_level: 'HIGH', review_status: 'OPEN' }]);
    expect(
      await fixture.owner.query(
        "SELECT correlation_id, actor_role, outcome FROM audit_log WHERE action='fraud.flagged' AND target_id=$1",
        [transfer.id],
      ),
    ).toEqual([
      { correlation_id: transfer.correlationId, actor_role: 'worker', outcome: 'SUCCESS' },
    ]);
  });

  it('TC-122-06 worker cannot SELECT transfers; view returns exact committed transfer facts', async () => {
    expect(await expectAclDenied(fixture.worker, 'SELECT * FROM transfers')).toBe('42501');
    const ids = fixture.transfers.map(t => t.id);
    const rows = await fixture.worker.query(
      'SELECT * FROM v_transfer_facts WHERE id=ANY($1::uuid[]) ORDER BY id',
      [ids],
    );
    const expected = await fixture.owner.query(
      'SELECT id,type,from_account_id,to_account_id,amount,status,created_at FROM transfers WHERE id=ANY($1::uuid[]) ORDER BY id',
      [ids],
    );
    expect(rows).toHaveLength(3);
    expect(rows).toEqual(expected);
  });

  it('TC-122-07 negative control detects excess GRANT; rollback and revoke restore deny', async () => {
    const input = flagInsert(fixture.transfers[2].id);
    try {
      await fixture.owner.query('GRANT INSERT ON fraud_flags TO dbs_api');
      await expect(expectAclDenied(fixture.api, input.sql, input.args)).rejects.toThrow(
        'Forbidden statement unexpectedly succeeded',
      );
    } finally {
      await fixture.owner.query('REVOKE INSERT ON fraud_flags FROM dbs_api');
    }
    expect(
      await fixture.owner.query('SELECT * FROM fraud_flags WHERE transfer_id=$1', [
        fixture.transfers[2].id,
      ]),
    ).toEqual([]);
    expect(await expectAclDenied(fixture.api, input.sql, input.args)).toBe('42501');
  });

  it('TC-122-08 injected unavailable Docker fails clearly instead of skipping', async () => {
    await expect(
      assertDockerAvailable(
        () => Promise.reject(new Error('fixture unreachable')),
        'DBS-122 role permissions',
      ),
    ).rejects.toThrow(/Docker is not running or unreachable.*DBS-122 role permissions/);
  });
});
