import { createHash } from 'node:crypto';
import type { AccountsService } from '@modules/accounts';
import { LedgerPostingService } from './ledger-posting.service';

// hashRequest touches no database, so the collaborator can be empty.
const posting = new LedgerPostingService({} as AccountsService);
const sha256 = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

describe('LedgerPostingService.hashRequest (ADR-05: sorted-key canonical body)', () => {
  it('TC-79-11 gives the same hash whatever order the caller wrote the keys in', () => {
    const forward = posting.hashRequest('/v1/transfers', {
      amount: '1',
      fromAccountId: 'a',
      toAccountId: 'b',
    });
    const backward = posting.hashRequest('/v1/transfers', {
      toAccountId: 'b',
      fromAccountId: 'a',
      amount: '1',
    });
    expect(backward).toBe(forward);
  });

  it('TC-79-11 sorts nested objects too, but never reorders array elements', () => {
    const body = (inner: Record<string, unknown>, list: string[]) =>
      ({ z: inner, a: list }) as unknown as Record<string, string>;
    expect(posting.hashRequest('/p', body({ b: '1', a: '2' }, ['x', 'y']))).toBe(
      posting.hashRequest('/p', body({ a: '2', b: '1' }, ['x', 'y'])),
    );
    expect(posting.hashRequest('/p', body({ a: '2' }, ['x', 'y']))).not.toBe(
      posting.hashRequest('/p', body({ a: '2' }, ['y', 'x'])),
    );
  });

  it('TC-79-11 changes when the amount, a party or the path changes', () => {
    const base = { amount: '9007199254740993', fromAccountId: 'a', toAccountId: 'b' };
    const hash = posting.hashRequest('/v1/transfers', base);
    // …992 and …993 are the same JavaScript number: only the string keeps them apart.
    expect(posting.hashRequest('/v1/transfers', { ...base, amount: '9007199254740992' })).not.toBe(
      hash,
    );
    expect(posting.hashRequest('/v1/transfers', { ...base, toAccountId: 'c' })).not.toBe(hash);
    expect(posting.hashRequest('/v1/operator/deposits', base)).not.toBe(hash);
  });

  it('TC-79-11 keeps the hash that bodies written in alphabetical order already had', () => {
    const body = { amount: '300000', fromAccountId: 'a', toAccountId: 'b' };
    expect(posting.hashRequest('/v1/transfers', body)).toBe(
      sha256({ method: 'POST', path: '/v1/transfers', body }),
    );
  });
});
