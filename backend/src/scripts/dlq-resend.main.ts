/**
 * `npm run --silent dlq:resend -- --from-dlq <DLQ url> --to-queue <queue url> --record-file <path>
 * (--all | --event-id <uuid>...)` (BL-372): after the cause is fixed, sends the chosen DLQ messages
 * back to the source queue, keeping `OriginalSentTimestamp`, and records each one. See
 * `dlq-resend.ts` and `docs/runbooks/dlq-redrive.md`.
 */
import { runDlqResendCli } from './dlq-resend';

void runDlqResendCli(process.argv.slice(2), {
  stdout: text => process.stdout.write(text),
  stderr: text => process.stderr.write(text),
  env: process.env,
  now: () => Date.now(),
}).then(code => {
  process.exitCode = code;
});
