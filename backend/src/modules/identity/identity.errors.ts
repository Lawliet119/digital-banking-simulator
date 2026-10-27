/** The access token's `exp` has passed. */
export class TokenExpiredError extends Error {}

/**
 * Every other verification failure: missing/malformed token, bad signature, unknown kid,
 * wrong `iss` / `client_id` / `token_use`. Never carries the raw token.
 */
export class TokenVerificationError extends Error {
  constructor(
    message: string,
    override readonly cause?: unknown,
  ) {
    super(message);
  }
}
