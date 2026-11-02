/**
 * `npm run --silent auth:dev-token -- --role <customer|operator|auditor|admin>` (DBS-53, ADR-06):
 * prints one signed access token and nothing else on stdout. Never part of the production build.
 */
import { runTokenCli } from './dev-auth';

void runTokenCli(process.argv.slice(2), {
  nodeEnv: process.env.NODE_ENV,
  cwd: process.cwd(),
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
}).then(code => {
  process.exitCode = code;
});
