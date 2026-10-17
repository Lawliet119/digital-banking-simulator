// Import for its side effect, at the top of `main.ts`, so that EVERY app role (api and worker) can
// serialize a bigint. The worker has no HTTP server and so never goes through `configureHttpApp`,
// yet it writes SQS payloads, outbox rows and audit `jsonb` with JSON.stringify.
import { installBigIntJson } from './bigint-json';

installBigIntJson();
