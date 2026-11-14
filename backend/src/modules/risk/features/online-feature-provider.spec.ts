import type { TransferEvent } from './feature-provider';
import { OnlineFeatureProvider } from './online-feature-provider';
import type { TransferFacts } from './transfer-facts';

const OCC = Date.parse('2026-11-09T03:00:00.000Z');
const event = {
  transferId: 'current',
  fromAccountId: 'from',
  toAccountId: 'to',
  occurredAt: new Date(OCC).toISOString(),
} as TransferEvent;

describe('OnlineFeatureProvider SQL contract', () => {
  const setup = () => {
    const facts = {
      snapshot: jest.fn(),
      velocity: jest.fn().mockResolvedValue({ tenMinutes: 1, hour: 1, includesCurrent: true }),
      newRecipientCount: jest.fn().mockResolvedValue(1),
      history: jest.fn().mockResolvedValue({ count: 6, median2: '80000' }),
      reverseTransfer: jest.fn().mockResolvedValue(null),
      outflow24h: jest.fn().mockResolvedValue({ distinctRecipients: 1, sum: '40000', small: 1 }),
    };
    facts.snapshot.mockImplementation((read: (inner: unknown) => Promise<unknown>) => read(facts));
    const provider = new OnlineFeatureProvider({
      facts: facts as unknown as TransferFacts,
      perTxLimit: 500_000n,
    });
    return { facts, provider };
  };

  it('reads committed facts on every extraction, including redelivery', async () => {
    const { facts, provider } = setup();
    await provider.extract(event);
    await provider.extract(event);
    expect(facts.velocity).toHaveBeenCalledTimes(2);
    expect(facts.newRecipientCount).toHaveBeenCalledTimes(2);
    expect(facts.velocity).toHaveBeenLastCalledWith('from', 'current', OCC);
  });

  it('reads all five SELECTs through the one snapshot it opens, not through the outer facts', async () => {
    const { facts, provider } = setup();
    const inner = {
      velocity: jest.fn().mockResolvedValue({ tenMinutes: 2, hour: 2, includesCurrent: true }),
      newRecipientCount: jest.fn().mockResolvedValue(2),
      history: jest.fn().mockResolvedValue({ count: 0, median2: null }),
      reverseTransfer: jest.fn().mockResolvedValue(null),
      outflow24h: jest.fn().mockResolvedValue({ distinctRecipients: 2, sum: '80000', small: 2 }),
    };
    facts.snapshot.mockImplementation((read: (f: unknown) => Promise<unknown>) => read(inner));
    expect(await provider.extract(event)).toMatchObject({ txCount10m: 2, newRecipients1h: 2 });
    expect(facts.snapshot).toHaveBeenCalledTimes(1);
    for (const method of Object.values(inner)) expect(method).toHaveBeenCalledTimes(1);
    for (const method of ['velocity', 'newRecipientCount', 'history', 'reverseTransfer'] as const)
      expect(facts[method]).not.toHaveBeenCalled();
    expect(facts.outflow24h).not.toHaveBeenCalled();
  });

  it('propagates a snapshot failure without features', async () => {
    const { facts, provider } = setup();
    const failure = new Error('cannot open snapshot');
    facts.snapshot.mockRejectedValue(failure);
    await expect(provider.extract(event)).rejects.toBe(failure);
  });

  it('adds a missing current transfer exactly once to SQL counts', async () => {
    const { facts, provider } = setup();
    facts.velocity.mockResolvedValue({ tenMinutes: 1, hour: 2, includesCurrent: false });
    expect(await provider.extract(event)).toMatchObject({ txCount10m: 2, txCount1h: 3 });
  });

  it('returns null median below five historical transfers', async () => {
    const { facts, provider } = setup();
    facts.history.mockResolvedValue({ count: 4, median2: '80000' });
    expect(await provider.extract(event)).toMatchObject({
      historyCount30d: 4,
      medianAmount30dTimes2: null,
    });
  });

  it.each(['velocity', 'newRecipientCount', 'history', 'reverseTransfer', 'outflow24h'] as const)(
    'propagates %s failure without partial features',
    async method => {
      const { facts, provider } = setup();
      const failure = new Error('SQL unavailable');
      facts[method].mockRejectedValue(failure);
      await expect(provider.extract(event)).rejects.toBe(failure);
    },
  );
});
