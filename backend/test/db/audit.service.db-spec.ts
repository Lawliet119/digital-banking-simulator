import { randomBytes, randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { ErrorCode } from '@common/errors/error-code.enum';
import { TransactionService } from '@database/transaction.service';
import { AuditService } from '../../src/modules/audit/audit.service';
import type { AuditOutcome, AuditRecordInput } from '../../src/modules/audit/audit.types';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

/**
 * Integration coverage for `AuditService` on real PostgreSQL: fail-closed rollback, the DENIED
 * pattern via `recordDenied()`, and the role-grant shape `record()` actually needs. Schema/DDL
 * itself is DBS-26/27's job (`audit-schema.db-spec.ts`) — not repeated here.
 *
 * Uses a *permanent* scratch table (`fc_scratch`), never `CREATE TEMP TABLE`: temp-table DDL is
 * itself transactional, so a row "surviving" or "disappearing" after rollback would prove nothing
 * — the table itself would be gone either way.
 */
describe('AuditService against real PostgreSQL (DBS-56)', () => {
  let db: TempDatabase;
  let dataSource: DataSource;
  let transactionService: TransactionService;
  let auditService: AuditService;
  let userId: string;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    dataSource = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    transactionService = new TransactionService(dataSource, {
      url: db.url,
      poolMax: 5,
      ssl: false,
      sslCaPath: undefined,
      lockTimeoutMs: 2000,
      statementTimeoutMs: 5000,
      idleInTransactionTimeoutMs: 10000,
    });
    auditService = new AuditService(transactionService);
    await db.runner.query('CREATE TABLE fc_scratch (id uuid PRIMARY KEY)');
    const [row] = await db.runner.query(
      "INSERT INTO users(cognito_sub) VALUES ('audit-db-spec-56') RETURNING id",
    );
    userId = row.id as string;
  });

  afterAll(async () => {
    await dataSource.destroy();
    await db.drop();
  });

  function input(overrides: Partial<AuditRecordInput> = {}): AuditRecordInput {
    return {
      actor: userId,
      role: 'operator',
      action: 'ledger.transfer',
      outcome: 'SUCCESS',
      target: { type: 'account', id: randomUUID() },
      correlationId: randomUUID(),
      ...overrides,
    };
  }

  async function auditRows(correlationId: string): Promise<Record<string, unknown>[]> {
    const rows = await db.runner.query('SELECT * FROM audit_log WHERE correlation_id = $1', [
      correlationId,
    ]);
    return rows as Record<string, unknown>[];
  }

  async function scratchHas(id: string): Promise<boolean> {
    const rows = await db.runner.query('SELECT 1 FROM fc_scratch WHERE id = $1', [id]);
    return rows.length === 1;
  }

  it('TC-56-04 SUCCESS round-trips all 8 columns; id/occurred_at auto-populate', async () => {
    const i = input({ metadata: { id: 'a1b2', reason: ErrorCode.ACCOUNT_NOT_ACTIVE, count: 2 } });
    await transactionService.run(manager => auditService.record(manager, i));

    const [row] = await auditRows(i.correlationId);
    expect(row.id).not.toBeNull();
    expect(row.occurred_at).not.toBeNull();
    expect(row.actor_user_id).toBe(i.actor);
    expect(row.actor_role).toBe(i.role);
    expect(row.action).toBe(i.action);
    expect(row.outcome).toBe('SUCCESS');
    expect(row.target_type).toBe(i.target.type);
    expect(row.target_id).toBe(i.target.id);
    expect(row.correlation_id).toBe(i.correlationId);
    expect(row.metadata).toEqual(i.metadata);
  });

  it('TC-56-04b inserts under a role granted INSERT only (no SELECT) on audit_log', async () => {
    const role = `audit_rw_test_${randomBytes(6).toString('hex')}`;
    if (!/^audit_rw_test_[0-9a-f]{12}$/.test(role)) throw new Error('unsafe fixture role name');
    await db.runner.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER`);
    try {
      await db.runner.query(`GRANT INSERT ON audit_log TO "${role}"`);
      const hasSelect = await db.runner.query(
        "SELECT has_table_privilege($1, 'audit_log', 'SELECT') AS allowed",
        [role],
      );
      expect(hasSelect[0].allowed).toBe(false);

      const i = input();
      await transactionService.run(async manager => {
        await manager.query(`SET LOCAL ROLE "${role}"`);
        await auditService.record(manager, i);
      });

      expect(await auditRows(i.correlationId)).toHaveLength(1);
    } finally {
      await db.runner.query(`REVOKE ALL ON audit_log FROM "${role}"`);
      await db.runner.query(`DROP ROLE "${role}"`);
    }
  });

  it('TC-56-04c metadata omitted stores {} rather than NULL', async () => {
    const i = input();
    await transactionService.run(manager => auditService.record(manager, i));
    const [row] = await auditRows(i.correlationId);
    expect(row.metadata).toEqual({});
  });

  it('TC-56-05 a failing record() rolls back a real other-table write too', async () => {
    const scratchId = randomUUID();
    const i = input({ actor: randomUUID() }); // not a real users.id -> FK violation

    await expect(
      transactionService.run(async manager => {
        await manager.query('INSERT INTO fc_scratch(id) VALUES ($1)', [scratchId]);
        await auditService.record(manager, i);
      }),
    ).rejects.toThrow();

    expect(await scratchHas(scratchId)).toBe(false);
    expect(await auditRows(i.correlationId)).toHaveLength(0);
  });

  it('TC-56-05b positive control: the same flow commits when record() succeeds', async () => {
    const scratchId = randomUUID();
    const i = input();

    await transactionService.run(async manager => {
      await manager.query('INSERT INTO fc_scratch(id) VALUES ($1)', [scratchId]);
      await auditService.record(manager, i);
    });

    expect(await scratchHas(scratchId)).toBe(true);
    expect(await auditRows(i.correlationId)).toHaveLength(1);
  });

  it('TC-56-06 recordDenied() commits a DENIED row standalone', async () => {
    const { outcome: _outcome, ...withoutOutcome } = input();
    const correlationId = withoutOutcome.correlationId;

    await auditService.recordDenied(withoutOutcome);

    const rows = await auditRows(correlationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].outcome).toBe('DENIED');
  });

  it('TC-56-06b negative control: record(DENIED) nested in a run() that throws is lost', async () => {
    const i = input({ outcome: 'DENIED' });

    await expect(
      transactionService.run(async manager => {
        await auditService.record(manager, i);
        throw new Error('simulated 404 thrown after a nested, not standalone, DENIED record');
      }),
    ).rejects.toThrow('simulated 404');

    expect(await auditRows(i.correlationId)).toHaveLength(0);
  });

  it('TC-56-06c DENIED survives an unrelated outer business rollback', async () => {
    const { outcome: _outcome, ...withoutOutcome } = input();
    const correlationId = withoutOutcome.correlationId;

    // recordDenied() runs to completion (commits) BEFORE the business run() below starts.
    await auditService.recordDenied(withoutOutcome);

    const scratchId = randomUUID();
    await expect(
      transactionService.run(async manager => {
        await manager.query('INSERT INTO fc_scratch(id) VALUES ($1)', [scratchId]);
        throw new Error('unrelated business failure');
      }),
    ).rejects.toThrow('unrelated business failure');

    const deniedRows = await auditRows(correlationId);
    expect(deniedRows).toHaveLength(1);
    expect(deniedRows[0].outcome).toBe('DENIED');
    expect(await scratchHas(scratchId)).toBe(false);
  });

  it('TC-56-06d recordDenied() itself rejects on an invalid correlationId; nothing commits', async () => {
    const { outcome: _outcome, ...withoutOutcome } = input({ correlationId: 'not-a-uuid' });

    await expect(auditService.recordDenied(withoutOutcome)).rejects.toThrow();
  });

  it('TC-56-09 actor null, role free text, for a system action', async () => {
    const i = input({ actor: null, role: 'system' });
    await transactionService.run(manager => auditService.record(manager, i));

    const [row] = await auditRows(i.correlationId);
    expect(row.actor_user_id).toBeNull();
    expect(row.actor_role).toBe('system');
  });

  it('TC-56-10 an outcome CHECK violation fails closed, with a real other write rolled back', async () => {
    const scratchId = randomUUID();
    const i = input({ outcome: 'BOGUS' as AuditOutcome });

    await expect(
      transactionService.run(async manager => {
        await manager.query('INSERT INTO fc_scratch(id) VALUES ($1)', [scratchId]);
        await auditService.record(manager, i);
      }),
    ).rejects.toMatchObject({
      driverError: { code: '23514', constraint: 'audit_log_outcome_check' },
    });

    expect(await scratchHas(scratchId)).toBe(false);
  });

  it('TC-56-10b hazard: catching the record() rejection makes run() resolve with nothing stored', async () => {
    const scratchId = randomUUID();
    const i = input({ actor: randomUUID() }); // FK violation

    // This deliberately violates the "never catch inside the callback" rule (behaviour #2) to
    // demonstrate the hazard it warns about — this is not a passing case for the rule itself.
    const result = await transactionService.run(async manager => {
      await manager.query('INSERT INTO fc_scratch(id) VALUES ($1)', [scratchId]);
      try {
        await auditService.record(manager, i);
      } catch {
        // swallowed on purpose
      }
      return 'looks fine';
    });

    expect(result).toBe('looks fine');
    expect(await scratchHas(scratchId)).toBe(false);
    expect(await auditRows(i.correlationId)).toHaveLength(0);
  });

  it('TC-56-11 an invalid correlationId fails closed, with a real other write rolled back', async () => {
    const scratchId = randomUUID();
    const i = input({ correlationId: 'not-a-uuid' });

    await expect(
      transactionService.run(async manager => {
        await manager.query('INSERT INTO fc_scratch(id) VALUES ($1)', [scratchId]);
        await auditService.record(manager, i);
      }),
    ).rejects.toMatchObject({ driverError: { code: '22P02' } });

    expect(await scratchHas(scratchId)).toBe(false);
  });
});
