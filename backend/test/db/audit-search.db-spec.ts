import { randomBytes, randomUUID } from 'node:crypto';
import type { EntityManager } from 'typeorm';
import { TransactionService } from '../../src/database/transaction.service';
import type { TransactionOptions } from '../../src/database/transaction.helper';
import { AuditService } from '../../src/modules/audit';
import { AuditSearchService } from '../../src/modules/audit/audit-search.service';
import {
  buildAuditSearchSql,
  parseAuditSearchQuery,
  type AuditEntriesPage,
} from '../../src/modules/audit/audit-search.query';
import {
  createAuditSearchFixture,
  SEARCH_FIXTURE as F,
  searchTransactionConfig,
  type AuditSearchFixture,
} from '../support/audit-search-fixtures';

describe('Audit search on real PostgreSQL (DBS-103)', () => {
  let fixture: AuditSearchFixture;
  let service: AuditSearchService;
  beforeAll(async () => {
    fixture = await createAuditSearchFixture({ large: true });
    service = new AuditSearchService(fixture.transactions, fixture.audit);
  });
  afterAll(async () => {
    await fixture?.close();
  });
  const caller = () => ({ userId: F.auditorUserId, correlationId: randomUUID() });
  function search(raw: Record<string, string> = {}) {
    return service.search(parseAuditSearchQuery(raw), caller());
  }
  async function rows(correlationId: string) {
    return fixture.source.query<Record<string, unknown>[]>(
      'SELECT * FROM audit_log WHERE correlation_id=$1::uuid',
      [correlationId],
    );
  }
  async function pages(correlationId: string, limit: string): Promise<string[]> {
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const page: AuditEntriesPage = await search({
        correlationId,
        limit,
        ...(cursor === null ? {} : { cursor }),
      });
      ids.push(...page.entries.map(entry => entry.id));
      cursor = page.nextCursor;
    } while (cursor !== null);
    return ids;
  }

  it('TC-103-04 each filter and their combination select the expected stored rows', async () => {
    const interval = { from: '2026-11-04T08:00:00Z', to: '2026-11-04T09:00:00Z' };
    expect((await search({ actorUserId: F.actorUserId, ...interval })).entries).toHaveLength(8);
    expect(
      (await search({ actorUserId: F.otherActorUserId, ...interval })).entries.map(
        entry => entry.id,
      ),
    ).toEqual(['103']);
    expect((await search({ action: 'transfer.create', ...interval })).entries).toHaveLength(4);
    expect(
      (await search({ correlationId: F.correlationId.toUpperCase() })).entries.map(
        entry => entry.id,
      ),
    ).toEqual(['9007199254740994', '9007199254740993', '9007199254740995']);
    expect(
      (
        await search({
          actorUserId: F.actorUserId,
          action: 'transfer.create',
          correlationId: F.correlationId,
          ...interval,
        })
      ).entries,
    ).toHaveLength(3);
    expect(
      (await search({ correlationId: F.boundaryCorrelationId, ...interval })).entries.map(
        entry => entry.id,
      ),
    ).toEqual(['103', '101']);
    expect(
      (
        await search({ correlationId: F.boundaryCorrelationId, from: '2026-11-04T09:00:00Z' })
      ).entries.map(entry => entry.id),
    ).toEqual(['102']);
    expect(
      (await search({ correlationId: F.boundaryCorrelationId, to: '2026-11-04T08:00:00Z' }))
        .entries,
    ).toEqual([]);
    expect(
      (await search({ correlationId: F.systemCorrelationId })).entries[0].actorUserId,
    ).toBeNull();
  });

  it('TC-103-05/10 commits exactly one self-audit even for an empty lookup', async () => {
    const current = caller();
    const queryCorrelation = randomUUID();
    const page = await service.search(
      parseAuditSearchQuery({ correlationId: queryCorrelation }),
      current,
    );
    expect(page).toEqual({ entries: [], nextCursor: null });
    const audit = await rows(current.correlationId);
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({
      actor_user_id: current.userId,
      actor_role: 'auditor',
      action: 'audit.search',
      outcome: 'SUCCESS',
      target_type: 'audit_search',
      target_id: current.correlationId,
      metadata: {},
    });
    expect(audit[0].correlation_id).not.toBe(queryCorrelation);
    expect(
      (await search({ action: 'audit.search' })).entries.some(
        entry => entry.correlationId === current.correlationId,
      ),
    ).toBe(true);
  });

  it.each(['1', '2', '100'])(
    'TC-103-08 numeric mixed-length IDs and microseconds page precisely at limit%s',
    async limit => {
      const precision = await pages(F.correlationId, limit);
      expect(precision).toEqual(['9007199254740994', '9007199254740993', '9007199254740995']);
      expect(new Set(precision).size).toBe(3);
      expect(await pages(F.sortCorrelationId, limit)).toEqual([
        '10000000000000000',
        '9999999999999999',
        '10',
        '9',
      ]);
      expect(
        (
          await search({
            correlationId: F.correlationId,
            from: '2026-11-04T08:10:00.123455Z',
            to: '2026-11-04T08:10:00.123456Z',
          })
        ).entries.map(entry => entry.id),
      ).toEqual(['9007199254740995']);
      const tied = await search({
        correlationId: F.correlationId,
        from: '2026-11-04T08:10:00.123456Z',
        to: '2026-11-04T08:10:00.123457Z',
      });
      expect(tied.entries.map(entry => entry.id)).toEqual(['9007199254740994', '9007199254740993']);
      expect(tied.entries.every(entry => entry.occurredAt === '2026-11-04T08:10:00.123456Z')).toBe(
        true,
      );
    },
  );

  it('TC-103-09 a newer committed row and later self-audits do not shift older pages', async () => {
    const correlationId = randomUUID();
    const insert = async (time: string) => {
      const [row] = await fixture.source.query<{ id: string }[]>(
        `INSERT INTO audit_log(occurred_at,actor_role,action,outcome,target_type,target_id,correlation_id) VALUES ($1::timestamptz,'system','fixture.live','SUCCESS','fixture','source',$2::uuid) RETURNING id::text AS id`,
        [time, correlationId],
      );
      return row.id;
    };
    const older = await insert('2026-11-04T08:00:00.000000Z');
    const newest = await insert('2026-11-04T08:10:00.000000Z');
    const first = await search({ correlationId, limit: '1' });
    expect(first.entries.map(entry => entry.id)).toEqual([newest]);
    const later = await insert('2026-11-04T08:20:00.000000Z');
    const second = await search({ correlationId, limit: '2', cursor: first.nextCursor! });
    expect(second.entries.map(entry => entry.id)).toEqual([older]);
    expect(second.nextCursor).toBeNull();
    expect((await search({ correlationId })).entries.map(entry => entry.id)).toEqual([
      later,
      newest,
      older,
    ]);
  });

  it('TC-103-11 SHARE lock permits SELECT but refuses the mandatory INSERT; recovery records once', async () => {
    await fixture.db.runner.startTransaction();
    const failed = caller();
    try {
      await fixture.db.runner.query('LOCK TABLE audit_log IN SHARE MODE');
      expect(
        (await fixture.source.query<{ count: string }[]>('SELECT count(*) FROM audit_log'))[0]
          .count,
      ).not.toBe('0');
      await expect(
        service.search(parseAuditSearchQuery({ correlationId: F.correlationId }), failed),
      ).rejects.toMatchObject({ code: '55P03' });
      expect(await rows(failed.correlationId)).toHaveLength(0);
    } finally {
      await fixture.db.runner.rollbackTransaction();
    }
    const recovered = caller();
    expect(
      (await service.search(parseAuditSearchQuery({ correlationId: F.correlationId }), recovered))
        .entries,
    ).toHaveLength(3);
    expect(await rows(recovered.correlationId)).toHaveLength(1);
  });

  it('TC-103-12 an actual INSERT followed by SELECT42501 rolls the self-audit back', async () => {
    const role = `audit_search_test_${randomBytes(6).toString('hex')}`;
    if (!/^audit_search_test_[0-9a-f]{12}$/.test(role)) throw new Error('unsafe fixture role');
    await fixture.db.runner.query(`CREATE ROLE "${role}" NOLOGIN NOSUPERUSER`);
    const current = caller();
    try {
      await fixture.db.runner.query(`GRANT INSERT ON audit_log TO "${role}"`);
      class RestrictedTransactions extends TransactionService {
        override run<T>(
          fn: (manager: EntityManager) => Promise<T>,
          options: TransactionOptions = {},
        ): Promise<T> {
          return super.run(async manager => {
            await manager.query(`SET LOCAL ROLE "${role}"`);
            return fn(manager);
          }, options);
        }
      }
      const tx = new RestrictedTransactions(
        fixture.source,
        searchTransactionConfig(fixture.db.url),
      );
      const audit = new AuditService(tx);
      let inserted = false;
      const actualRecord = audit.record.bind(audit);
      jest.spyOn(audit, 'record').mockImplementation(async (manager, input) => {
        await actualRecord(manager, input);
        inserted = true;
      });
      const restricted = new AuditSearchService(tx, audit);
      await expect(restricted.search(parseAuditSearchQuery({}), current)).rejects.toMatchObject({
        code: '42501',
      });
      expect(inserted).toBe(true);
      expect(await rows(current.correlationId)).toHaveLength(0);
    } finally {
      await fixture.db.runner.query(`REVOKE ALL ON audit_log FROM "${role}"`);
      await fixture.db.runner.query(`DROP ROLE "${role}"`);
    }
  });

  it('TC-103-13 ten concurrent real searches retain actor/correlation attribution', async () => {
    const names = [
      'nguyen-minh-an',
      'tran-thu-ha',
      'le-quoc-bao',
      'pham-ngoc-lan',
      'hoang-thanh-tung',
      'vu-khanh-linh',
      'dang-anh-khoa',
      'do-thuy-trang',
      'bui-gia-huy',
      'ngo-phuong-mai',
    ];
    const users = await fixture.source.query<{ id: string }[]>(
      'INSERT INTO users(cognito_sub) SELECT unnest($1::text[]) RETURNING id',
      [names.map(name => `kiem-toan-${name}`)],
    );
    const callers = users.map(user => ({ userId: user.id, correlationId: randomUUID() }));
    const pages = await Promise.all(
      callers.map(current =>
        service.search(parseAuditSearchQuery({ correlationId: randomUUID() }), current),
      ),
    );
    expect(pages.every(page => page.entries.length === 0)).toBe(true);
    const auditRows = await fixture.source.query<Record<string, unknown>[]>(
      'SELECT * FROM audit_log WHERE correlation_id=ANY($1::uuid[])',
      [callers.map(current => current.correlationId)],
    );
    expect(auditRows).toHaveLength(10);
    for (const current of callers)
      expect(auditRows.filter(row => row.correlation_id === current.correlationId)).toEqual([
        expect.objectContaining({
          actor_user_id: current.userId,
          actor_role: 'auditor',
          action: 'audit.search',
        }),
      ]);
  });

  it('TC-103-14 hostile action remains an exact parameter and never broadens the result', async () => {
    expect((await search({ action: "transfer.create' OR 1=1 --" })).entries).toEqual([]);
    expect((await search({ action: 'transfer.create' })).entries.length).toBeGreaterThan(1);
  });

  it('TC-103-18 real service SQL chooses the correlation index in all five warm <=10ms plans', async () => {
    await fixture.db.runner.query('ANALYZE audit_log');
    const [{ count }] = await fixture.source.query<{ count: string }[]>(
      'SELECT count(*) FROM audit_log',
    );
    expect(BigInt(count)).toBeGreaterThanOrEqual(50000n);
    const built = buildAuditSearchSql(
      parseAuditSearchQuery({ correlationId: F.performanceCorrelationId, limit: '50' }),
    );
    expect((await search({ correlationId: F.performanceCorrelationId })).entries).toHaveLength(1);
    const usesCorrelationIndex = (node: unknown): boolean => {
      if (node === null || typeof node !== 'object' || Array.isArray(node)) return false;
      const value = node as Record<string, unknown>;
      if (
        value['Node Type'] === 'Index Scan' &&
        value['Index Name'] === 'audit_log_correlation_idx'
      ) {
        return true;
      }
      return Array.isArray(value.Plans) && value.Plans.some(usesCorrelationIndex);
    };
    expect(
      usesCorrelationIndex({
        'Node Type': 'Bitmap Index Scan',
        'Index Name': 'audit_log_correlation_idx',
      }),
    ).toBe(false);
    const times: number[] = [];
    let warmupExecutionMs: number | undefined;
    for (let i = 0; i < 6; i++) {
      const result = await fixture.source.query<
        { 'QUERY PLAN': { Plan: unknown; 'Execution Time': number }[] }[]
      >(`EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ${built.sql}`, built.parameters);
      const plan = result[0]['QUERY PLAN'][0];
      expect(usesCorrelationIndex(plan.Plan)).toBe(true);
      if (i !== 0) {
        times.push(plan['Execution Time']);
      } else warmupExecutionMs = plan['Execution Time'];
    }
    console.log(
      JSON.stringify({
        case: 'TC-103-18',
        fixtureRows: count,
        warmupExecutionMs,
        warmExecutionMs: times,
      }),
    );
    expect(times).toHaveLength(5);
    for (const executionMs of times) expect(executionMs).toBeLessThanOrEqual(10);
  });
});
