import { randomUUID } from 'node:crypto';
import { DataSource } from 'typeorm';
import { TransferFixture } from '../support/transfer-facts-fixture';
import {
  createTempDatabase,
  migrate,
  migrateThrough,
  type TempDatabase,
} from '../support/temp-database';

/**
 * BL-223: the cross-table invariants of ADR-14 that no single-table CHECK can hold, enforced by
 * DEFERRABLE INITIALLY DEFERRED constraint triggers, so they are judged once, at COMMIT, when the
 * decision, the flag and its hits are all there. Design: FRAUD-API-01 §3.8 "Bất biến" and
 * docs/features/RSK-01-risk-decisions-migration.md. Rule set v1 is medium 40 / high 70; v2 below is
 * medium 20 / high 45.
 */
const MIGRATION = 'AddRiskInvariantTriggers1795000006000';
const HEX = 'a'.repeat(64);

type Step = [sql: string, args: unknown[]];

interface Case {
  transfer: string;
  version?: number;
  ruleScore: number;
  /** A positive weight makes it an AI decision (SUCCEEDED, applied weight). */
  aiWeight?: number;
  flag?: { score: number; level: string };
  hits?: [rule: string, weight: number][];
}

/** The statements one transaction of the writer (DBS-111) issues, in its order. */
function steps(c: Case): Step[] {
  const ai = (c.aiWeight ?? 0) > 0;
  const out: Step[] = [
    [
      `INSERT INTO risk_decisions(transfer_id,event_id,rule_set_version,mode,rule_score,feature_snapshot,
         ai_status,ai_applied_weight,probability,provider,requested_model,rubric_sha256,input_sha256)
       VALUES($1,$2,$3,$4,$5,'{}'::jsonb,$6,$7,$8,$9,$10,$11,$11)`,
      [
        c.transfer,
        randomUUID(),
        c.version ?? 1,
        ai ? 'rules_with_external_ai' : 'rule_only',
        c.ruleScore,
        ai ? 'SUCCEEDED' : 'DISABLED',
        c.aiWeight ?? 0,
        ai ? 0.95 : null,
        ai ? 'openai' : null,
        ai ? 'safe-model' : null,
        ai ? HEX : null,
      ],
    ],
  ];
  if (c.flag) {
    out.push([
      'INSERT INTO fraud_flags(transfer_id,score,risk_level,rule_set_version) VALUES($1,$2,$3,$4)',
      [c.transfer, c.flag.score, c.flag.level, c.version ?? 1],
    ]);
  }
  for (const [rule, weight] of c.hits ?? []) {
    out.push([
      "INSERT INTO fraud_rule_hits(transfer_id,rule_id,weight,explanation) VALUES($1,$2,$3,'x')",
      [c.transfer, rule, weight],
    ]);
  }
  return out;
}

describe('BL-223 cross-table invariants of risk_decisions, fraud_flags and fraud_rule_hits', () => {
  let db: TempDatabase;
  let fixture: TransferFixture;
  let from: string;
  let to: string;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);

  /** A new transfer, so that no case sees the committed rows of another. */
  const transfer = async (
    opts: { type?: 'TRANSFER' | 'DEPOSIT'; status?: 'COMPLETED' | 'REJECTED' } = {},
  ) => (await fixture.transfer({ from, to, at: new Date().toISOString(), ...opts })).id;

  /** Runs the statements in one transaction on `runner`; resolves with the COMMIT outcome. */
  async function commit(
    runner: { query(sql: string, args?: unknown[]): Promise<unknown> },
    work: Step[],
  ): Promise<void> {
    await runner.query('BEGIN');
    try {
      for (const [sql, args] of work) await runner.query(sql, args);
    } catch (error) {
      await runner.query('ROLLBACK');
      throw new Error(`a statement failed before COMMIT: ${(error as Error).message}`);
    }
    try {
      await runner.query('COMMIT');
    } catch (error) {
      await runner.query('ROLLBACK').catch(() => undefined);
      throw error;
    }
  }

  const rejects = (constraint: string) => ({ driverError: { code: '23514', constraint } });
  const count = async (table: string, id: string) =>
    (
      (await q(`SELECT count(*)::int AS n FROM ${table} WHERE transfer_id=$1`, [id])) as {
        n: number;
      }[]
    )[0].n;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    fixture = new TransferFixture(db.runner);
    [from, to] = await fixture.accounts(2);
    await q(`INSERT INTO risk_rule_sets(version,config)
      SELECT 2, jsonb_set(jsonb_set(config,'{thresholds,medium}','20'),'{thresholds,high}','45')
        FROM risk_rule_sets WHERE version=1`);
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('TC-BL223-01 the four invariants are constraint triggers, deferrable and initially deferred', async () => {
    const rows = await q(
      `SELECT c.relname AS tbl, t.tgname, t.tgdeferrable, t.tginitdeferred,
              (t.tgtype & 1) = 1 AS per_row, (t.tgtype & 2) = 0 AS is_after, t.tgconstraint <> 0 AS is_constraint
         FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE t.tgisinternal = false AND t.tgdeferrable
          AND c.relname IN ('risk_decisions','fraud_flags','fraud_rule_hits')
        ORDER BY c.relname, t.tgname`,
    );
    expect(rows).toEqual(
      [
        'fraud_flags.fraud_flags_level_threshold',
        'fraud_flags.fraud_flags_rule_score_hits',
        'fraud_flags.fraud_flags_score_decision',
        'fraud_rule_hits.fraud_rule_hits_rule_score_hits',
        'risk_decisions.risk_decisions_completed_transfer',
      ].map(name => {
        const [tbl, tgname] = name.split('.');
        return {
          tbl,
          tgname,
          tgdeferrable: true,
          tginitdeferred: true,
          per_row: true,
          is_after: true,
          is_constraint: true,
        };
      }),
    );
  });

  describe('what the writer legitimately produces commits', () => {
    it.each<[string, Omit<Case, 'transfer'>]>([
      ['LOW without a flag', { ruleScore: 30 }],
      [
        'MEDIUM at exactly the medium threshold',
        { ruleScore: 40, flag: { score: 40, level: 'MEDIUM' }, hits: [['R1', 40]] },
      ],
      [
        'MEDIUM just under the high threshold',
        {
          ruleScore: 69,
          flag: { score: 69, level: 'MEDIUM' },
          hits: [
            ['R1', 30],
            ['R2', 39],
          ],
        },
      ],
      [
        'HIGH at exactly the high threshold',
        {
          ruleScore: 70,
          flag: { score: 70, level: 'HIGH' },
          hits: [
            ['R1', 30],
            ['R3', 40],
          ],
        },
      ],
      [
        'rules plus the applied AI weight',
        { ruleScore: 30, aiWeight: 15, flag: { score: 45, level: 'MEDIUM' }, hits: [['R1', 30]] },
      ],
      [
        'an AI-only flag: rule_score 0, no hit',
        { ruleScore: 0, aiWeight: 55, flag: { score: 55, level: 'MEDIUM' } },
      ],
      [
        'another rule-set version with its own thresholds',
        { version: 2, ruleScore: 45, flag: { score: 45, level: 'HIGH' }, hits: [['R5', 45]] },
      ],
    ])('TC-BL223-02 %s', async (_name, c) => {
      const id = await transfer();
      await commit(db.runner, steps({ transfer: id, ...c }));
      expect(await count('risk_decisions', id)).toBe(1);
      expect(await count('fraud_flags', id)).toBe(c.flag ? 1 : 0);
    });

    it('TC-BL223-02b the order of the writes inside the transaction does not matter', async () => {
      const id = await transfer();
      const [decision, flag, hit] = steps({
        transfer: id,
        ruleScore: 45,
        flag: { score: 45, level: 'MEDIUM' },
        hits: [['R1', 45]],
      });
      // The flag key needs the decision first, the hit key needs the flag: only the checks are late.
      await commit(db.runner, [decision, flag, hit]);
      expect(await count('fraud_rule_hits', id)).toBe(1);
    });
  });

  describe('invariant 1: a decision exists only for a COMPLETED TRANSFER', () => {
    it.each<[string, { type?: 'TRANSFER' | 'DEPOSIT'; status?: 'COMPLETED' | 'REJECTED' }]>([
      ['a REJECTED transfer', { status: 'REJECTED' }],
      ['a DEPOSIT', { type: 'DEPOSIT' }],
    ])('TC-BL223-03 refuses a decision for %s at COMMIT', async (_name, kind) => {
      const id = await transfer(kind);
      await expect(commit(db.runner, steps({ transfer: id, ruleScore: 0 }))).rejects.toMatchObject(
        rejects('risk_decisions_completed_transfer'),
      );
      expect(await count('risk_decisions', id)).toBe(0);
    });
  });

  describe('invariant 2: rule_score = sum(fraud_rule_hits.weight) when there is a flag', () => {
    it.each<[string, Omit<Case, 'transfer'>]>([
      [
        'hits add up to less',
        {
          ruleScore: 70,
          flag: { score: 70, level: 'HIGH' },
          hits: [
            ['R1', 30],
            ['R3', 35],
          ],
        },
      ],
      [
        'hits add up to more',
        {
          ruleScore: 45,
          flag: { score: 45, level: 'MEDIUM' },
          hits: [
            ['R1', 30],
            ['R2', 25],
          ],
        },
      ],
      [
        'a flag with no hit although rule_score is above 0',
        { ruleScore: 45, flag: { score: 45, level: 'MEDIUM' } },
      ],
      [
        'hits on a flag whose decision has rule_score 0 (AI-only)',
        { ruleScore: 0, aiWeight: 55, flag: { score: 55, level: 'MEDIUM' }, hits: [['R1', 55]] },
      ],
    ])('TC-BL223-04 refuses at COMMIT: %s', async (_name, c) => {
      const id = await transfer();
      await expect(commit(db.runner, steps({ transfer: id, ...c }))).rejects.toMatchObject(
        rejects('risk_decisions_rule_score_hits'),
      );
      expect(await count('risk_decisions', id)).toBe(0);
      expect(await count('fraud_flags', id)).toBe(0);
    });

    it('TC-BL223-04b a later transaction cannot drop a hit from a committed flag', async () => {
      const id = await transfer();
      await commit(
        db.runner,
        steps({
          transfer: id,
          ruleScore: 70,
          flag: { score: 70, level: 'HIGH' },
          hits: [
            ['R1', 30],
            ['R3', 40],
          ],
        }),
      );
      await expect(
        commit(db.runner, [
          ["DELETE FROM fraud_rule_hits WHERE transfer_id=$1 AND rule_id='R3'", [id]],
        ]),
      ).rejects.toMatchObject(rejects('risk_decisions_rule_score_hits'));
      expect(await count('fraud_rule_hits', id)).toBe(2);
    });
  });

  describe('invariant 3: fraud_flags.score = rule_score + ai_applied_weight', () => {
    it.each<[string, Omit<Case, 'transfer'>]>([
      [
        'flag score above the decision total',
        { ruleScore: 45, flag: { score: 50, level: 'MEDIUM' }, hits: [['R1', 45]] },
      ],
      [
        'flag score below the decision total',
        { ruleScore: 55, flag: { score: 45, level: 'MEDIUM' }, hits: [['R1', 55]] },
      ],
      [
        'AI weight left out of the flag',
        { ruleScore: 40, aiWeight: 15, flag: { score: 40, level: 'MEDIUM' }, hits: [['R1', 40]] },
      ],
      [
        'AI weight counted twice',
        { ruleScore: 40, aiWeight: 15, flag: { score: 70, level: 'HIGH' }, hits: [['R1', 40]] },
      ],
    ])('TC-BL223-05 refuses at COMMIT: %s', async (_name, c) => {
      const id = await transfer();
      await expect(commit(db.runner, steps({ transfer: id, ...c }))).rejects.toMatchObject(
        rejects('fraud_flags_score_decision'),
      );
      expect(await count('fraud_flags', id)).toBe(0);
    });

    it('TC-BL223-05b an UPDATE of the score is judged at COMMIT too', async () => {
      const id = await transfer();
      await commit(
        db.runner,
        steps({
          transfer: id,
          ruleScore: 45,
          flag: { score: 45, level: 'MEDIUM' },
          hits: [['R1', 45]],
        }),
      );
      await expect(
        commit(db.runner, [['UPDATE fraud_flags SET score=50 WHERE transfer_id=$1', [id]]]),
      ).rejects.toMatchObject(rejects('fraud_flags_score_decision'));
      expect(
        (
          (await q('SELECT score FROM fraud_flags WHERE transfer_id=$1', [id])) as {
            score: number;
          }[]
        )[0].score,
      ).toBe(45);
    });
  });

  describe('invariant 4: the flag level follows the thresholds of its rule-set version', () => {
    it.each<[string, Omit<Case, 'transfer'>]>([
      [
        'HIGH below the high threshold (v1: 45 is MEDIUM)',
        { ruleScore: 45, flag: { score: 45, level: 'HIGH' }, hits: [['R1', 45]] },
      ],
      [
        'MEDIUM at the high threshold (v1: 70 is HIGH)',
        { ruleScore: 70, flag: { score: 70, level: 'MEDIUM' }, hits: [['R1', 70]] },
      ],
      [
        'MEDIUM far above the high threshold',
        { ruleScore: 95, flag: { score: 95, level: 'MEDIUM' }, hits: [['R1', 95]] },
      ],
      [
        'a flag below the medium threshold (a LOW decision has no flag)',
        { ruleScore: 39, flag: { score: 39, level: 'MEDIUM' }, hits: [['R1', 39]] },
      ],
      ['a flag at score 0', { ruleScore: 0, flag: { score: 0, level: 'MEDIUM' } }],
      [
        'v2 thresholds apply to a v2 flag (45 is HIGH there, not MEDIUM)',
        { version: 2, ruleScore: 45, flag: { score: 45, level: 'MEDIUM' }, hits: [['R1', 45]] },
      ],
    ])('TC-BL223-06 refuses at COMMIT: %s', async (_name, c) => {
      const id = await transfer();
      await expect(commit(db.runner, steps({ transfer: id, ...c }))).rejects.toMatchObject(
        rejects('fraud_flags_level_threshold'),
      );
      expect(await count('fraud_flags', id)).toBe(0);
    });

    it('TC-BL223-06b a rule-set version without usable thresholds cannot back a flag', async () => {
      await q(
        'INSERT INTO risk_rule_sets(version,config) VALUES(3,\'{"thresholds":{"medium":"40"}}\'::jsonb)',
      );
      const id = await transfer();
      await expect(
        commit(
          db.runner,
          steps({
            transfer: id,
            version: 3,
            ruleScore: 45,
            flag: { score: 45, level: 'MEDIUM' },
            hits: [['R1', 45]],
          }),
        ),
      ).rejects.toMatchObject(rejects('fraud_flags_level_threshold'));
    });
  });

  it('TC-BL223-07 nothing is raised before COMMIT: the statements pass and only the commit is refused', async () => {
    const id = await transfer();
    const work = steps({
      transfer: id,
      ruleScore: 45,
      flag: { score: 99, level: 'HIGH' },
      hits: [['R1', 45]],
    });
    await q('BEGIN');
    try {
      for (const [sql, args] of work) await q(sql, args); // none of these throws
      expect(await count('fraud_flags', id)).toBe(1); // visible inside the transaction
    } finally {
      await q('ROLLBACK');
    }
    await expect(commit(db.runner, work)).rejects.toMatchObject({ driverError: { code: '23514' } });
  });

  describe('as the real dbs_worker login (no SELECT on transfers)', () => {
    let worker: DataSource;
    beforeAll(async () => {
      const PASSWORD = 'role-test-only'; // the same as db-roles.db-spec, so files never fight over it
      await q(`ALTER ROLE dbs_worker LOGIN PASSWORD '${PASSWORD}'`);
      const url = new URL(db.url);
      url.username = 'dbs_worker';
      url.password = PASSWORD;
      worker = await new DataSource({ type: 'postgres', url: url.toString() }).initialize();
    });
    afterAll(async () => {
      await worker?.destroy();
    });

    it('TC-BL223-08 the worker commits a consistent decision, flag and hits', async () => {
      const id = await transfer();
      const runner = worker.createQueryRunner();
      try {
        await runner.connect();
        await commit(
          runner,
          steps({
            transfer: id,
            ruleScore: 75,
            flag: { score: 75, level: 'HIGH' },
            hits: [
              ['R3', 35],
              ['R5', 40],
            ],
          }),
        );
      } finally {
        await runner.release();
      }
      expect(await count('fraud_rule_hits', id)).toBe(2);
    });

    it('TC-BL223-08b the worker is refused an inconsistent flag and a decision for a REJECTED transfer', async () => {
      const runner = worker.createQueryRunner();
      try {
        await runner.connect();
        const wrongLevel = await transfer();
        await expect(
          commit(
            runner,
            steps({
              transfer: wrongLevel,
              ruleScore: 75,
              flag: { score: 75, level: 'MEDIUM' },
              hits: [['R3', 75]],
            }),
          ),
        ).rejects.toMatchObject(rejects('fraud_flags_level_threshold'));
        const rejected = await transfer({ status: 'REJECTED' });
        await expect(
          commit(runner, steps({ transfer: rejected, ruleScore: 0 })),
        ).rejects.toMatchObject(rejects('risk_decisions_completed_transfer'));
      } finally {
        await runner.release();
      }
    });
  });
});

describe('BL-223 revert of the invariant triggers', () => {
  let db: TempDatabase;
  const q = (sql: string, args: unknown[] = []) => db.runner.query(sql, args);
  const triggers = async () =>
    (
      (await q(
        `SELECT count(*)::int AS n FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
          WHERE NOT t.tgisinternal AND t.tgdeferrable
            AND c.relname IN ('risk_decisions','fraud_flags','fraud_rule_hits')`,
      )) as { n: number }[]
    )[0].n;

  beforeAll(async () => {
    db = await createTempDatabase();
  });
  afterAll(async () => {
    await db?.drop();
  });

  it('TC-BL223-09 revert drops triggers and functions and keeps the table; running again restores them', async () => {
    await migrateThrough(db.url, MIGRATION);
    expect(await triggers()).toBe(5);
    await migrate(db.url, 'undoLast');
    expect(await triggers()).toBe(0);
    expect(
      await q(
        "SELECT count(*)::int AS n FROM pg_proc WHERE pronamespace = 'public'::regnamespace AND proname LIKE 'risk\\_check\\_%'",
      ),
    ).toEqual([{ n: 0 }]);
    expect(await q("SELECT to_regclass('public.risk_decisions') AS t")).toEqual([
      { t: 'risk_decisions' },
    ]);
    await migrate(db.url);
    expect(await triggers()).toBe(5);
  });
});
