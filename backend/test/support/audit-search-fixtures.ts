import { DataSource, type QueryRunner } from 'typeorm';
import { TransactionService } from '../../src/database/transaction.service';
import { AuditService } from '../../src/modules/audit';
import { createTempDatabase, migrate, type TempDatabase } from './temp-database';

export const SEARCH_FIXTURE = {
  actorUserId: '11111111-1111-4111-8111-111111111111',
  otherActorUserId: '22222222-2222-4222-8222-222222222222',
  auditorUserId: '33333333-3333-4333-8333-333333333333',
  correlationId: '623abce9-69a0-4d3d-90e0-bc21c75aa361',
  sortCorrelationId: 'c2b45275-9d6c-4fd8-9053-84ce31c8fa6d',
  performanceCorrelationId: 'f0e09d29-2097-450e-8b28-7100e99f48db',
  boundaryCorrelationId: 'f373c5b7-9265-433b-a606-364214e269f4',
  systemCorrelationId: 'b746bbdf-830d-42d1-a463-d035f5ff6009',
} as const;

/** Seed SQL: identity/audit input metadata only, never balances, transfers or ledger rows. */
export async function seedAuditSearchData(
  runner: QueryRunner,
  options: { large?: boolean } = {},
): Promise<void> {
  await runner.query(
    `INSERT INTO users(id,cognito_sub) VALUES
    ($1,'khach-mai-thu-huong'),($2,'khach-tran-minh-an'),($3,'dev-auditor')`,
    [SEARCH_FIXTURE.actorUserId, SEARCH_FIXTURE.otherActorUserId, SEARCH_FIXTURE.auditorUserId],
  );
  const rows: [string, string, string | null, string, string][] = [
    [
      '9007199254740994',
      '2026-11-04T08:10:00.123456Z',
      SEARCH_FIXTURE.actorUserId,
      'transfer.create',
      SEARCH_FIXTURE.correlationId,
    ],
    [
      '9007199254740993',
      '2026-11-04T08:10:00.123456Z',
      SEARCH_FIXTURE.actorUserId,
      'transfer.create',
      SEARCH_FIXTURE.correlationId,
    ],
    [
      '9007199254740995',
      '2026-11-04T08:10:00.123455Z',
      SEARCH_FIXTURE.actorUserId,
      'transfer.create',
      SEARCH_FIXTURE.correlationId,
    ],
    ...['9', '10', '9999999999999999', '10000000000000000'].map(
      id =>
        [
          id,
          '2026-11-04T08:20:00.123456Z',
          SEARCH_FIXTURE.actorUserId,
          'account.read',
          SEARCH_FIXTURE.sortCorrelationId,
        ] as [string, string, string, string, string],
    ),
    [
      '101',
      '2026-11-04T08:00:00.000000Z',
      SEARCH_FIXTURE.actorUserId,
      'transfer.create',
      SEARCH_FIXTURE.boundaryCorrelationId,
    ],
    [
      '102',
      '2026-11-04T09:00:00.000000Z',
      SEARCH_FIXTURE.actorUserId,
      'transfer.create',
      SEARCH_FIXTURE.boundaryCorrelationId,
    ],
    [
      '103',
      '2026-11-04T08:10:00.123456Z',
      SEARCH_FIXTURE.otherActorUserId,
      'account.read',
      SEARCH_FIXTURE.boundaryCorrelationId,
    ],
    [
      '104',
      '2026-11-04T08:30:00.000000Z',
      null,
      'fixture.cleanup',
      SEARCH_FIXTURE.systemCorrelationId,
    ],
    [
      '201',
      '2026-11-03T08:30:00.000000Z',
      null,
      'audit.fixture',
      SEARCH_FIXTURE.performanceCorrelationId,
    ],
  ];
  for (const [id, time, actor, action, correlation] of rows) {
    await runner.query(
      `INSERT INTO audit_log
      (id,occurred_at,actor_user_id,actor_role,action,outcome,target_type,target_id,correlation_id,metadata)
      OVERRIDING SYSTEM VALUE VALUES ($1::bigint,$2::timestamptz,$3::uuid,$4,$5,'SUCCESS','fixture',$6,$7::uuid,'{}'::jsonb)`,
      [
        id,
        time,
        actor,
        actor === null ? 'system' : 'customer',
        action,
        SEARCH_FIXTURE.actorUserId,
        correlation,
      ],
    );
  }
  // Explicit IDs include 9/10 and values above 2^53; the next real self-audit must not collide.
  await runner.query(
    "SELECT setval(pg_get_serial_sequence('audit_log','id'),(SELECT max(id) FROM audit_log),true)",
  );
  if (options.large) {
    await runner.query(
      `INSERT INTO audit_log
      (occurred_at,actor_user_id,actor_role,action,outcome,target_type,target_id,correlation_id,metadata)
      SELECT '2026-10-01T00:00:00Z'::timestamptz + i * interval '1 microsecond',
        $1::uuid,'customer','audit.fixture','SUCCESS','fixture',$2,md5(i::text)::uuid,'{}'::jsonb
      FROM generate_series(1,50000) AS i`,
      [SEARCH_FIXTURE.otherActorUserId, SEARCH_FIXTURE.otherActorUserId],
    );
    await runner.query('ANALYZE audit_log');
  }
}

export interface AuditSearchFixture {
  db: TempDatabase;
  source: DataSource;
  transactions: TransactionService;
  audit: AuditService;
  close(): Promise<void>;
}

export function searchTransactionConfig(url: string) {
  return {
    url,
    poolMax: 15,
    ssl: false,
    sslCaPath: undefined,
    lockTimeoutMs: 2000,
    statementTimeoutMs: 5000,
    idleInTransactionTimeoutMs: 10000,
  };
}

export async function createAuditSearchFixture(
  options: { large?: boolean } = {},
): Promise<AuditSearchFixture> {
  const db = await createTempDatabase();
  let source: DataSource | undefined;
  try {
    await migrate(db.url);
    await seedAuditSearchData(db.runner, options);
    source = await new DataSource({
      type: 'postgres',
      url: db.url,
      extra: { max: 15 },
    }).initialize();
    const transactions = new TransactionService(source, searchTransactionConfig(db.url));
    return {
      db,
      source,
      transactions,
      audit: new AuditService(transactions),
      async close() {
        try {
          if (source?.isInitialized) await source.destroy();
        } finally {
          await db.drop();
        }
      },
    };
  } catch (error) {
    try {
      if (source?.isInitialized) await source.destroy();
    } finally {
      await db.drop();
    }
    throw error;
  }
}
