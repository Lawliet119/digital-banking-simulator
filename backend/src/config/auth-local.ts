/**
 * Fixed identity of the local development token issuer (DBS-53, ADR-06). Local mode keeps every
 * check JwksVerifierService makes for Cognito (`iss`, `client_id`, `token_use`, `exp`); these two
 * constants are the values a token must carry, so a local token travels the same code path as a
 * Cognito one and differs only in where the signing key comes from.
 *
 * They are constants, not environment variables: nothing about them is a secret or a per-machine
 * choice, and a new variable would be a new thing to forget to forbid in staging and production.
 * Imported by the verifier (what to accept) and by the token minter (what to sign).
 */
export const LOCAL_ISSUER = 'https://dbs.local/auth';
export const LOCAL_CLIENT_ID = 'dbs-local-client';
