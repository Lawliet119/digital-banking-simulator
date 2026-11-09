<!-- Reviewer: same subagent (Opus, effort medium), 2026-11-10, round 3 on the round-2 fixes. Raw reply below, unedited. -->

All four round-2 findings are resolved:

- **v2-1:** queues are now counted with `get-queue-attributes` on three attributes, and `queue-census.ts` is no longer used for that.
- **v2-2:** M-124-04 now runs in one script, spaces transfers 1 s apart, polls tightly, records `NotVisible`, and retries on 0 or 10.
- **v2-3:** stray processes are found with `Get-CimInstance` on `CommandLine`.
- **v2-4:** the wait condition now includes the queue counts, and TC-124-02 stops the TC-124-01 instances first.

The docker `-v` recipe now matches DBS-91 (run from the repo root). AWS CLI v2.39.5 is installed on this machine. The revised lines add two small new problems:

| # | Severity | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| 1 | minor | §5 Chuẩn bị (queue count command) | The `aws … sqs get-queue-attributes` command has no `--queue-url`, which is required, so it fails as written. It also needs dummy credentials and a region (`AWS_ACCESS_KEY_ID=local`, `AWS_SECRET_ACCESS_KEY=local`, `AWS_DEFAULT_REGION=us-east-1`); the census script sets those defaults, but the CLI does not. | `get-queue-attributes` always needs a queue URL; DBS-73 §M-73-02 names the queue; `test/manual/queue-census.ts` (sets `AWS_ACCESS_KEY_ID`/`SECRET` itself, region `us-east-1`) | Add `--queue-url http://localhost:9334/000000000000/risk-events`, and the same command for `risk-events-dlq`, plus the three env vars. |
| 2 | minor | §5 Chuẩn bị (stray process check) | The filter looks for `CommandLine` containing `distmain`. That string never appears: the real command line is `node dist/main` (or `dist\main`), so the check always finds nothing. | §5 says the processes start with `node dist/main` | Filter with `-match 'dist[\/]main'`, for example `powershell -Command "Get-CimInstance Win32_Process -Filter \"Name='node.exe'\" \| ? CommandLine -match 'dist[\/]main' \| select ProcessId,CommandLine"`. |

Verdict: APPROVE
