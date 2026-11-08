import { DataSource } from 'typeorm';
import { TransferFacts, factQueries } from '@modules/risk/features/transfer-facts';
import { TransferFixture } from '../support/transfer-facts-fixture';
import { createTempDatabase, migrate, type TempDatabase } from '../support/temp-database';

const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
/** The event time of every test: a millisecond instant, as `Date#toISOString()` produces it. */
const OCC = Date.parse('2026-10-19T03:15:42.123Z');
/** An ISO instant `deltaMs` from OCC; `micros` adds sub-millisecond digits like the real column. */
const at = (deltaMs: number, micros = 0): string =>
  new Date(OCC + deltaMs).toISOString().replace('Z', `${String(micros).padStart(3, '0')}Z`);

/** DBS-109: the SQL half of the online feature provider, on real PostgreSQL. */
describe('TransferFacts (real PostgreSQL)', () => {
  let db: TempDatabase;
  let source: DataSource;
  let facts: TransferFacts;
  let fixture: TransferFixture;
  const q = (sql: string, args: unknown[] = []): Promise<Record<string, unknown>[]> =>
    db.runner.query(sql, args) as Promise<Record<string, unknown>[]>;

  beforeAll(async () => {
    db = await createTempDatabase();
    await migrate(db.url);
    source = await new DataSource({ type: 'postgres', url: db.url }).initialize();
    facts = new TransferFacts(source);
    fixture = new TransferFixture(db.runner);
  });
  afterAll(async () => {
    await source?.destroy();
    await db?.drop();
  });

  describe('windowTransfers (R1)', () => {
    it('TC-109-02 counts (occ - w, occ] at millisecond resolution, the current transfer once', async () => {
      const [a, b] = await fixture.accounts(2);
      const edge = await fixture.transfer({ from: a, to: b, at: at(-10 * MIN, 999) });
      const justIn = await fixture.transfer({ from: a, to: b, at: at(-10 * MIN + 1, 0) });
      const mid = await fixture.transfer({ from: a, to: b, at: at(-5 * MIN) });
      // 123456 microseconds: the event says .123, so this must still be inside the window.
      const current = await fixture.transfer({ from: a, to: b, at: at(0, 456) });
      const later = await fixture.transfer({ from: a, to: b, at: at(1) });
      await fixture.transfer({ from: a, to: b, at: at(-1 * MIN), status: 'REJECTED' });
      await fixture.transfer({ from: a, to: b, at: at(-1 * MIN), type: 'DEPOSIT' });

      const ten = (await facts.windowTransfers(a, OCC, 10 * MIN)).map(r => r.id).sort();
      expect(ten).toEqual([justIn.id, mid.id, current.id].sort());
      expect(ten).not.toContain(edge.id);
      expect(ten).not.toContain(later.id);

      const hour = await facts.windowTransfers(a, OCC, HOUR);
      expect(hour.map(r => r.id)).toContain(edge.id);
      expect(hour.find(r => r.id === current.id)?.atMs).toBe(OCC);
    });

    it('TC-109-02 another account is not counted', async () => {
      const [a, b, c] = await fixture.accounts(3);
      await fixture.transfer({ from: c, to: b, at: at(-1000) });
      const mine = await fixture.transfer({ from: a, to: b, at: at(0) });
      expect((await facts.windowTransfers(a, OCC, 10 * MIN)).map(r => r.id)).toEqual([mine.id]);
    });
  });

  describe('history (R2)', () => {
    const history = async (amounts: string[], offsets?: number[]) => {
      const [a, b] = await fixture.accounts(2);
      for (const [i, amount] of amounts.entries())
        await fixture.transfer({
          from: a,
          to: b,
          amount,
          at: at(-(offsets?.[i] ?? (i + 1) * HOUR)),
        });
      return facts.history(a, OCC);
    };

    it('TC-109-03 twice the median is an exact integer string, for odd and even counts', async () => {
      expect(await history(['100', '200', '300', '400', '500'])).toEqual({
        count: 5,
        median2: '600',
      });
      expect(await history(['100', '200', '300', '400', '500', '601'])).toEqual({
        count: 6,
        median2: '700',
      });
      expect(await history(['1', '2'])).toEqual({ count: 2, median2: '3' });
    });

    it('TC-109-03 no history is count 0 and no median, and a huge amount stays exact', async () => {
      expect(await history([])).toEqual({ count: 0, median2: null });
      const big = '9223372036854775807';
      expect(await history([big, big, big, big, big])).toEqual({
        count: 5,
        median2: '18446744073709551614',
      });
    });

    it('TC-109-03 window is [occ - 30d, occ): the 30-day mark is in, the current instant and later are out', async () => {
      const [a, b] = await fixture.accounts(2);
      await fixture.transfer({ from: a, to: b, amount: '10', at: at(-30 * DAY) }); // in
      await fixture.transfer({ from: a, to: b, amount: '10', at: at(-30 * DAY - 1) }); // out
      await fixture.transfer({ from: a, to: b, amount: '10', at: at(0, 5) }); // the current one
      await fixture.transfer({ from: a, to: b, amount: '10', at: at(5) }); // later
      await fixture.transfer({ from: a, to: b, amount: '10', at: at(-DAY), status: 'REJECTED' });
      expect((await facts.history(a, OCC)).count).toBe(1);
    });
  });

  describe('reverseTransfer (R4)', () => {
    it('TC-109-03 finds the latest reverse transfer in [occ - 1h, occ), REJECTED never counts', async () => {
      const [a, b] = await fixture.accounts(2);
      await fixture.transfer({ from: b, to: a, at: at(-50 * MIN, 7) });
      await fixture.transfer({ from: b, to: a, at: at(-20 * MIN, 250) });
      await fixture.transfer({ from: b, to: a, at: at(-2 * MIN), status: 'REJECTED' });
      expect(await facts.reverseTransfer(a, b, OCC)).toBe(new Date(OCC - 20 * MIN).toISOString());
    });

    it('TC-109-03 the one-hour mark is in, one millisecond earlier and the current instant are out', async () => {
      const [a, b, c, d] = await fixture.accounts(4);
      await fixture.transfer({ from: b, to: a, at: at(-HOUR) });
      expect(await facts.reverseTransfer(a, b, OCC)).toBe(new Date(OCC - HOUR).toISOString());
      await fixture.transfer({ from: d, to: c, at: at(-HOUR - 1) });
      expect(await facts.reverseTransfer(c, d, OCC)).toBeNull();
      await fixture.transfer({ from: d, to: a, at: at(0, 1) });
      expect(await facts.reverseTransfer(a, d, OCC)).toBeNull();
    });

    it('TC-109-03 only a REJECTED reverse transfer, or none, gives null', async () => {
      const [a, b] = await fixture.accounts(2);
      expect(await facts.reverseTransfer(a, b, OCC)).toBeNull();
      await fixture.transfer({ from: b, to: a, at: at(-MIN), status: 'REJECTED' });
      expect(await facts.reverseTransfer(a, b, OCC)).toBeNull();
    });
  });

  describe('outflow24h', () => {
    it('TC-109-03 counts recipients, sums and small transfers in (occ - 24h, occ], current included', async () => {
      const [a, b, c] = await fixture.accounts(3);
      await fixture.transfer({ from: a, to: b, amount: '40000', at: at(-HOUR) }); // small (< 10% of 500000)
      await fixture.transfer({ from: a, to: b, amount: '60000', at: at(-2 * HOUR) });
      await fixture.transfer({ from: a, to: c, amount: '100000', at: at(0, 9) });
      await fixture.transfer({ from: a, to: c, amount: '1', at: at(-DAY) }); // exactly 24h: out
      await fixture.transfer({ from: a, to: c, amount: '1', at: at(-DAY + 1) }); // in
      const out = await facts.outflow24h(a, OCC, 500_000n);
      expect(out).toEqual({ distinctRecipients: 2, sum: '200001', small: 2 });
    });

    it('TC-109-03 no transfers is zeros', async () => {
      const [a] = await fixture.accounts(1);
      expect(await facts.outflow24h(a, OCC, 500_000n)).toEqual({
        distinctRecipients: 0,
        sum: '0',
        small: 0,
      });
    });
  });

  describe('R5 recipients', () => {
    it('TC-109-04 isNewRecipient: not new when the sender paid them in the 30 days before, ignoring the current transfer', async () => {
      const [a, b, c] = await fixture.accounts(3);
      const current = await fixture.transfer({ from: a, to: b, at: at(0, 10) });
      expect(await facts.isNewRecipient(a, b, current.id, OCC)).toBe(true);
      await fixture.transfer({ from: a, to: b, at: at(-29 * DAY) });
      expect(await facts.isNewRecipient(a, b, current.id, OCC)).toBe(false);
      // Older than 30 days, rejected, or from somebody else: still new.
      await fixture.transfer({ from: a, to: c, at: at(-30 * DAY - 1) });
      await fixture.transfer({ from: a, to: c, at: at(-DAY), status: 'REJECTED' });
      await fixture.transfer({ from: b, to: c, at: at(-DAY) });
      const toC = await fixture.transfer({ from: a, to: c, at: at(0, 11) });
      expect(await facts.isNewRecipient(a, c, toC.id, OCC)).toBe(true);
    });

    it('TC-109-04 newRecipientsInWindow: one entry per new recipient, old recipients and outsiders excluded', async () => {
      const [a, ...others] = await fixture.accounts(8);
      const [r1, r2, r3, old, outside, rejected] = others;
      await fixture.transfer({ from: a, to: r1, at: at(-50 * MIN) });
      await fixture.transfer({ from: a, to: r1, at: at(-10 * MIN) }); // second to r1: still one recipient
      await fixture.transfer({ from: a, to: r2, at: at(-30 * MIN) });
      await fixture.transfer({ from: a, to: r3, at: at(0, 3) }); // the current transfer
      await fixture.transfer({ from: a, to: old, at: at(-3 * DAY) }); // paid before the window
      await fixture.transfer({ from: a, to: old, at: at(-20 * MIN) }); // so not new now
      await fixture.transfer({ from: a, to: outside, at: at(-HOUR) }); // exactly 1h: out
      await fixture.transfer({ from: a, to: rejected, at: at(-MIN), status: 'REJECTED' });
      const found = await facts.newRecipientsInWindow(a, OCC, HOUR);
      expect(found.map(r => r.recipientId).sort()).toEqual([r1, r2, r3].sort());
      expect(found.find(r => r.recipientId === r1)?.atMs).toBe(OCC - 50 * MIN);
    });
  });

  describe('plans', () => {
    /** 40,000 transfers from 400 senders so the planner has a reason to prefer the indexes. */
    beforeAll(async () => {
      const senders = await fixture.accounts(400);
      const [target] = await fixture.accounts(1);
      await q(
        `INSERT INTO transfers(type,from_account_id,to_account_id,amount,status,reject_reason,initiated_by,correlation_id,created_at)
         SELECT 'TRANSFER', s.id, $2::uuid, 1000 + g, CASE WHEN g % 7 = 0 THEN 'REJECTED' ELSE 'COMPLETED' END,
                CASE WHEN g % 7 = 0 THEN 'INSUFFICIENT_FUNDS' END,
                (SELECT initiated_by FROM transfers LIMIT 1), gen_random_uuid(),
                $3::timestamptz - (g * interval '10 minutes')
         FROM unnest($1::uuid[]) AS s(id), generate_series(1, 100) AS g`,
        [senders, target, new Date(OCC).toISOString()],
      );
      await q('VACUUM (ANALYZE) transfers');
    });

    const explain = async (sql: string, params: unknown[]) => {
      const rows = (await q(`EXPLAIN (ANALYZE, FORMAT JSON) ${sql}`, params)) as {
        'QUERY PLAN': { Plan: unknown; 'Execution Time': number }[];
      }[];
      const root = rows[0]['QUERY PLAN'][0];
      return { text: JSON.stringify(root.Plan), ms: root['Execution Time'] };
    };

    it('TC-109-05 R1, R2, R4 and R5 queries use the partial indexes and never scan transfers', async () => {
      const [{ id: sender }] = (await q(
        `SELECT from_account_id AS id FROM transfers GROUP BY 1 HAVING count(*) > 50 LIMIT 1`,
      )) as { id: string }[];
      const [{ id: other }] = (await q(
        `SELECT to_account_id AS id FROM transfers WHERE from_account_id=$1 LIMIT 1`,
        [sender],
      )) as { id: string }[];
      const queries = factQueries(sender, other, '00000000-0000-4000-8000-000000000009', OCC);
      let r2r4r5 = 0;
      for (const [name, query] of Object.entries(queries)) {
        const plan = await explain(query.sql, query.params);
        expect([name, /"Node Type":"Seq Scan"/.test(plan.text)]).toEqual([name, false]);
        expect([name, /transfers_(account|pair)_completed_idx/.test(plan.text)]).toEqual([
          name,
          true,
        ]);
        if (name === 'history' || name === 'reverse' || name === 'newRecipients') r2r4r5 += plan.ms;
      }
      expect(r2r4r5).toBeLessThanOrEqual(30);
    });
  });
});
