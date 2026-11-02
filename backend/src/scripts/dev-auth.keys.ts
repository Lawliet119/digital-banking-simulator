/**
 * `npm run auth:dev-keys` (DBS-53, ADR-06): writes a development signing key and its JWKS into
 * `.auth-local/`. Never part of the production build (tsconfig.build.json excludes dev-auth*).
 */
import { runKeysCli } from './dev-auth';

void runKeysCli(process.argv.slice(2), {
  nodeEnv: process.env.NODE_ENV,
  cwd: process.cwd(),
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
}).then(code => {
  process.exitCode = code;
});
