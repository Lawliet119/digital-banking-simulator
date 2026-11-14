/**
 * `npm run --silent dlq:age-check -- --queue-url <DLQ url>` (BL-210): lists, and with
 * `--delete-stale` removes, the DLQ messages first sent more than 6 days ago, before a redrive.
 * See `dlq-age-check.ts` and `docs/runbooks/dlq-redrive.md`.
 */
import { runDlqAgeCheckCli } from './dlq-age-check';

void runDlqAgeCheckCli(process.argv.slice(2), {
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
  env: process.env,
  now: () => Date.now(),
}).then(code => {
  process.exitCode = code;
});
