import { describe, expect, it } from 'vitest';
import { beginAttempt, endAttempt, isDefinite, settleAttempt, type KeyStore } from './idempotency';

function memoryStore(): KeyStore & { size(): number } {
  const map = new Map<string, string>();
  return {
    getItem: key => map.get(key) ?? null,
    setItem: (key, value) => void map.set(key, value),
    removeItem: key => void map.delete(key),
    size: () => map.size,
  };
}

describe('idempotency keys', () => {
  it('gives the same key to every retry of one attempt', () => {
    const store = memoryStore();
    const first = beginAttempt('transfer', store);
    expect(first).toMatch(/^[0-9a-f-]{36}$/);
    expect(beginAttempt('transfer', store)).toBe(first);
  });

  it.each([
    ['a network error or timeout', undefined],
    ['a 500', 500],
    ['a 503', 503],
    ['a 429', 429],
  ])('keeps the key after %s', (_name, status) => {
    const store = memoryStore();
    const key = beginAttempt('transfer', store);
    expect(settleAttempt('transfer', status, store)).toBe(false);
    expect(beginAttempt('transfer', store)).toBe(key);
  });

  it.each([
    ['a 201', 201],
    ['a 200 replay', 200],
    ['a 422 rejection', 422],
    ['a 400', 400],
    ['a 409', 409],
  ])('changes the key after %s', (_name, status) => {
    const store = memoryStore();
    const key = beginAttempt('transfer', store);
    expect(settleAttempt('transfer', status, store)).toBe(true);
    expect(beginAttempt('transfer', store)).not.toBe(key);
  });

  it('keeps one key per form', () => {
    const store = memoryStore();
    expect(beginAttempt('transfer', store)).not.toBe(beginAttempt('deposit', store));
    endAttempt('transfer', store);
    expect(store.size()).toBe(1);
  });

  it('treats only 2xx and non-429 4xx as definite', () => {
    expect([undefined, 201, 422, 429, 500, 503].map(isDefinite)).toEqual([
      false,
      true,
      true,
      false,
      false,
      false,
    ]);
  });
});
