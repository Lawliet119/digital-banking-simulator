/**
 * Machine-readable error codes carried in the `errorCode` field of an error response.
 *
 * Why this exists: the human `detail` text is reworded and translated over time, so a client
 * (or a test) that branches on it breaks the next time someone improves the wording. A client
 * that must behave differently for two errors sharing an HTTP status needs a value that is
 * stable by contract. Tests assert on these codes, never on message text.
 *
 * Rule: add a member only when a client must branch on it. An error nobody branches on needs a
 * good `detail`, not a code.
 *
 * The first four members double as the stored `transfers.reject_reason` of a REJECTED transfer
 * (see reject-reason.ts), so the value in the database equals the value on the wire.
 */
export enum ErrorCode {
  // ── Business rejections of a transfer / deposit (HTTP 422, status = REJECTED) ──
  /** Source or destination account is not ACTIVE (locked or missing). BR-05, BR-12. */
  ACCOUNT_NOT_ACTIVE = 'ACCOUNT_NOT_ACTIVE',
  /** Amount exceeds the per-transaction limit. BR-06. */
  LIMIT_PER_TX_EXCEEDED = 'LIMIT_PER_TX_EXCEEDED',
  /** Amount would push today's outgoing total over the daily limit. BR-06. */
  LIMIT_PER_DAY_EXCEEDED = 'LIMIT_PER_DAY_EXCEEDED',
  /** Source balance is lower than the amount. BR-03. */
  INSUFFICIENT_FUNDS = 'INSUFFICIENT_FUNDS',

  // ── Idempotency ──
  /** A transfer or deposit was sent without the `Idempotency-Key` header (HTTP 400). */
  IDEMPOTENCY_KEY_REQUIRED = 'IDEMPOTENCY_KEY_REQUIRED',
  /** The same `Idempotency-Key` was reused with a different request body (HTTP 422). BR-07. */
  IDEMPOTENCY_KEY_REUSED = 'IDEMPOTENCY_KEY_REUSED',

  // ── Accounts ──
  /** The customer already has the maximum number of accounts (HTTP 409). BR-14. */
  ACCOUNT_LIMIT_REACHED = 'ACCOUNT_LIMIT_REACHED',

  // ── Session ──
  /**
   * The presented token was issued before the user's sessions were revoked, e.g. an operator
   * locked the account (HTTP 401). Distinct from an expired token: re-using the same token
   * will never work, so the client must sign in again. BR-12.
   */
  SESSION_REVOKED = 'SESSION_REVOKED',

  // ── Protection ──
  /** Too many requests (HTTP 429). */
  RATE_LIMITED = 'RATE_LIMITED',
  /**
   * A transient database failure (deadlock that survived retries, lost connection). The request
   * made no change; the client should retry with the SAME `Idempotency-Key` (HTTP 503 +
   * `Retry-After`).
   */
  SERVICE_TEMPORARILY_UNAVAILABLE = 'SERVICE_TEMPORARILY_UNAVAILABLE',
}
