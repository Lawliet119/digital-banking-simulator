/**
 * The `Idempotency-Key` of a money form (`POST /v1/transfers`, `POST /v1/operator/deposits`).
 *
 * One key per attempt to do one thing. Pressing the button again after a network error, a
 * timeout, a 5xx or a 429 must send the SAME key: the server may have done it already, and only
 * the key lets it answer with the first result instead of moving the money twice. A definite
 * answer (2xx, or a 4xx other than 429) ends the attempt; the next submit gets a new key.
 *
 * Kept in sessionStorage so a reload of the tab keeps the key; never localStorage.
 */

export type KeyStore = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const PREFIX = 'dbs.idem.';

function browserStore(): KeyStore {
  return sessionStorage;
}

/** The key of the attempt in progress for `formId`, or a new one. */
export function beginAttempt(formId: string, store: KeyStore = browserStore()): string {
  const existing = store.getItem(PREFIX + formId);
  if (existing) return existing;
  const key = crypto.randomUUID();
  store.setItem(PREFIX + formId, key);
  return key;
}

/** Forgets the key: the server gave a definite answer. */
export function endAttempt(formId: string, store: KeyStore = browserStore()): void {
  store.removeItem(PREFIX + formId);
}

/**
 * Whether an outcome is definite. `status` is `undefined` when no HTTP answer arrived (network
 * error, timeout): the request may or may not have reached the server.
 */
export function isDefinite(status: number | undefined): boolean {
  if (status === undefined) return false;
  if (status === 429) return false;
  return status < 500;
}

/** Ends the attempt only when the outcome is definite. Returns whether it did. */
export function settleAttempt(
  formId: string,
  status: number | undefined,
  store: KeyStore = browserStore(),
): boolean {
  if (!isDefinite(status)) return false;
  endAttempt(formId, store);
  return true;
}
