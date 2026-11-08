import type { Features, TransferEvent } from './feature-provider';
import { countTransfersInWindow, type TransferStamp } from './velocity-count';
import { R1VelocityRule } from '../rules/r1-velocity.rule';
import type { RuleParams } from '../rules/rule';

const NOW = '2026-10-19T03:15:42.123Z';
const current: TransferStamp = { transferId: 'cur', occurredAt: NOW };
const ago = (ms: number, transferId: string): TransferStamp => ({
  transferId,
  occurredAt: new Date(Date.parse(NOW) - ms).toISOString(),
});
const MIN = 60_000;

describe('DBS-93 DoD 2 reference count behind txCount10m', () => {
  it('TC-93-05a counts the current transfer once, even with no history', () => {
    expect(countTransfersInWindow(current, [], 10)).toBe(1);
  });

  it('TC-93-05a counts only transfers inside (occurredAt - 10 min, occurredAt]', () => {
    const history = [
      ago(1, 'a'),
      ago(10 * MIN - 1, 'edge-in'),
      ago(10 * MIN, 'edge-out'),
      ago(11 * MIN, 'old'),
      ago(3 * 60 * MIN, 'much-older'),
    ];
    expect(countTransfersInWindow(current, history, 10)).toBe(3); // current, a, edge-in
  });

  it('preserves nanosecond order at both ends of the event-contract window', () => {
    const precise = { transferId: 'cur', occurredAt: '2026-10-19T12:00:00.000000001Z' };
    expect(
      countTransfersInWindow(
        precise,
        [{ transferId: 'edge', occurredAt: '2026-10-19T11:50:00.000000001Z' }],
        10,
      ),
    ).toBe(1);
    expect(
      countTransfersInWindow(
        precise,
        [{ transferId: 'inside', occurredAt: '2026-10-19T11:50:00.000000002Z' }],
        10,
      ),
    ).toBe(2);
    expect(
      countTransfersInWindow(
        precise,
        [{ transferId: 'future', occurredAt: '2026-10-19T12:00:00.000000002Z' }],
        10,
      ),
    ).toBe(1);
  });

  it('TC-93-05a does not count the same transferId twice, nor the current one again', () => {
    const history = [ago(MIN, 'a'), ago(MIN, 'a'), ago(2 * MIN, 'a'), { ...current }];
    expect(countTransfersInWindow(current, history, 10)).toBe(2); // current, a
  });

  it('TC-93-05a ignores transfers that happened after occurredAt (late event, windows end at occurredAt)', () => {
    const later: TransferStamp = {
      transferId: 'later',
      occurredAt: new Date(Date.parse(NOW) + MIN).toISOString(),
    };
    expect(countTransfersInWindow(current, [later], 10)).toBe(1);
  });

  it.each([
    [{ transferId: 'x', occurredAt: 'not-a-date' }, 10],
    [current, 0],
    [current, -5],
    [current, 1.5],
    [current, NaN],
  ])('TC-93-05a rejects bad input %#', (stamp, windowMinutes) => {
    expect(() => countTransfersInWindow(current, [stamp], windowMinutes)).toThrow(Error);
  });

  it('TC-93-05a fed into R1: five in the window do not flag, a sixth flags, duplicates and old ones do not push it over', () => {
    const rule = new R1VelocityRule();
    const params: RuleParams = {
      enabled: true,
      weight: 30,
      thresholds: { maxTransfers: 5, windowMinutes: 10 },
    };
    const event = { type: 'TRANSFER', occurredAt: NOW } as unknown as TransferEvent;
    const evaluate = (history: TransferStamp[]) =>
      rule.evaluate(
        event,
        { txCount10m: countTransfersInWindow(current, history, 10) } as Features,
        params,
      );
    const four = [1, 2, 3, 4].map(i => ago(i * MIN, `t${i}`));
    expect(evaluate(four)).toBeNull(); // 4 + current = 5
    expect(evaluate([...four, ago(5 * MIN, 't5')])).toMatchObject({ id: 'R1' }); // 6
    // Retried deliveries of the same transfers and transfers outside the window add nothing.
    expect(evaluate([...four, ...four, ago(11 * MIN, 'old1'), ago(30 * MIN, 'old2')])).toBeNull();
  });
});
