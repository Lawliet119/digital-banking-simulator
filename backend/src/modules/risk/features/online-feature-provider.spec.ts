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
  const accountFacts = (over: Record<string, unknown> = {}) => ({
    history: { count: 6, median2: '80000' },
    velocity: { tenMinutes: 1, hour: 1, includesCurrent: true },
    outflow: { distinctRecipients: 1, sum: '40000', small: 1 },
    ...over,
  });
  const setup = () => {
    const facts = {
      snapshot: jest.fn(),
      accountFacts: jest.fn().mockResolvedValue(accountFacts()),
      newRecipientCount: jest.fn().mockResolvedValue(1),
      reverseTransfer: jest.fn().mockResolvedValue(null),
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
    expect(facts.accountFacts).toHaveBeenCalledTimes(2);
    expect(facts.newRecipientCount).toHaveBeenCalledTimes(2);
    expect(facts.accountFacts).toHaveBeenLastCalledWith('from', 'current', OCC, 500_000n);
  });

  it('reads the three SELECTs through the one snapshot it opens, not through the outer facts', async () => {
    const { facts, provider } = setup();
    const inner = {
      accountFacts: jest.fn().mockResolvedValue(
        accountFacts({
          velocity: { tenMinutes: 2, hour: 2, includesCurrent: true },
          history: { count: 0, median2: null },
          outflow: { distinctRecipients: 2, sum: '80000', small: 2 },
        }),
      ),
      newRecipientCount: jest.fn().mockResolvedValue(2),
      reverseTransfer: jest.fn().mockResolvedValue(null),
    };
    facts.snapshot.mockImplementation((read: (f: unknown) => Promise<unknown>) => read(inner));
    expect(await provider.extract(event)).toMatchObject({ txCount10m: 2, newRecipients1h: 2 });
    expect(facts.snapshot).toHaveBeenCalledTimes(1);
    for (const method of Object.values(inner)) expect(method).toHaveBeenCalledTimes(1);
    for (const method of ['accountFacts', 'newRecipientCount', 'reverseTransfer'] as const)
      expect(facts[method]).not.toHaveBeenCalled();
  });

  it('TC-173-05 scans the account once: history, velocity and outflow come from one accountFacts call', async () => {
    const { facts, provider } = setup();
    await provider.extract(event);
    expect(facts.accountFacts).toHaveBeenCalledTimes(1);
    expect(facts.accountFacts).toHaveBeenCalledWith('from', 'current', OCC, 500_000n);
  });

  it('propagates a snapshot failure without features', async () => {
    const { facts, provider } = setup();
    const failure = new Error('cannot open snapshot');
    facts.snapshot.mockRejectedValue(failure);
    await expect(provider.extract(event)).rejects.toBe(failure);
  });

  it('adds a missing current transfer exactly once to SQL counts', async () => {
    const { facts, provider } = setup();
    facts.accountFacts.mockResolvedValue(
      accountFacts({ velocity: { tenMinutes: 1, hour: 2, includesCurrent: false } }),
    );
    expect(await provider.extract(event)).toMatchObject({ txCount10m: 2, txCount1h: 3 });
  });

  it('returns null median below five historical transfers', async () => {
    const { facts, provider } = setup();
    facts.accountFacts.mockResolvedValue(accountFacts({ history: { count: 4, median2: '80000' } }));
    expect(await provider.extract(event)).toMatchObject({
      historyCount30d: 4,
      medianAmount30dTimes2: null,
    });
  });

  it.each(['accountFacts', 'newRecipientCount', 'reverseTransfer'] as const)(
    'propagates %s failure without partial features',
    async method => {
      const { facts, provider } = setup();
      const failure = new Error('SQL unavailable');
      facts[method].mockRejectedValue(failure);
      await expect(provider.extract(event)).rejects.toBe(failure);
    },
  );
});
