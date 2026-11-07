import { toAccountView, type AccountReadRow } from './account-view.dto';

describe('DBS-64 exact money DTO boundary (not a ledger/API nonzero fixture)', () => {
  const row = (balance: string): AccountReadRow => ({
    id: '2e859a80-d4d0-471d-8cee-e9d0de9d4bc7',
    type: 'CHECKING',
    status: 'ACTIVE',
    balance,
    createdAt: new Date('2026-11-04T00:00:00.000Z'),
    updatedAt: new Date('2026-11-04T00:00:00.000Z'),
  });
  it.each(['0', '9007199254740993', '9223372036854775807'])(
    'preserves exact bigint %s as string',
    balance => {
      expect(toAccountView(row(balance)).balance).toBe(balance);
    },
  );
  it.each([42, '01', '1.5', '9223372036854775808'])('rejects invalid/numeric money %s', balance => {
    expect(() => toAccountView({ ...row('0'), balance } as AccountReadRow)).toThrow();
  });
  it('whitelists response fields and serializes ISO dates including LOCKED accounts', () => {
    const input = {
      ...row('0'),
      status: 'LOCKED' as const,
      userId: 'private-user',
      fullName: 'private-name',
      fraudFlag: true,
    };
    expect(toAccountView(input)).toEqual({
      id: input.id,
      type: 'CHECKING',
      status: 'LOCKED',
      balance: '0',
      createdAt: '2026-11-04T00:00:00.000Z',
      updatedAt: '2026-11-04T00:00:00.000Z',
    });
  });
});
