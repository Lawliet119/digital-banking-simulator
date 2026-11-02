import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createLocalJWKSet, type JWK, type JWTVerifyGetKey } from 'jose';
import { ConfigValidationError } from '@config/validation.schema';

/** RFC 7518 §6.3.2 private-key members of an RSA JWK (`oth`: extra primes). */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth'];

/**
 * Every refusal is a `ConfigValidationError` naming `AUTH_LOCAL_JWKS_PATH`: `main.ts` logs only
 * the key names of that error type, so the operator sees which setting is wrong. The text never
 * carries the path or anything read from the file (a wrong path can be a secret location, and a
 * file the operator mistook for the JWKS can be a private key).
 */
function refuse(reason: string): never {
  throw new ConfigValidationError(`AUTH_LOCAL_JWKS_PATH: ${reason}`, ['AUTH_LOCAL_JWKS_PATH']);
}

/**
 * Reads the JWKS written by `npm run auth:dev-keys` (DBS-53, AUTH_MODE=local) once, at startup,
 * and returns a key resolver that never touches the network. The path is relative to the working
 * directory (`backend/`), like the env files.
 *
 * Accepts only RSA public keys: a JWKS holding a private member is rejected so that pointing the
 * setting at the wrong file cannot end with a private key sitting in the app's memory.
 */
export function loadLocalJwks(path: string): JWTVerifyGetKey {
  let text: string;
  try {
    text = readFileSync(resolve(process.cwd(), path), 'utf8');
  } catch {
    return refuse('the file cannot be read');
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return refuse('the file is not valid JSON');
  }

  const keys = (parsed as { keys?: unknown } | null)?.keys;
  if (!Array.isArray(keys) || keys.length === 0) {
    return refuse('the file has no keys');
  }
  for (const key of keys as unknown[]) {
    if (typeof key !== 'object' || key === null || (key as JWK).kty !== 'RSA') {
      return refuse('every key must be an RSA public key');
    }
    if (PRIVATE_MEMBERS.some(member => member in key)) {
      return refuse('the file holds a private key; only public keys are accepted');
    }
  }
  return createLocalJWKSet({ keys: keys as JWK[] });
}
