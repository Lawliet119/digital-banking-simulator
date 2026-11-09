<!-- Reviewer: same subagent (Opus, effort medium), 2026-11-10, round 2 on the revised §1–§5. Raw reply below, unedited. -->

| # | Severity | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| R2-1 (new; also on round-1 #1 and #9) | should-fix | §1 G1-2 (separating poison messages, reading the DLQ), §5 M-125-03 | The new "save the bodies, then `delete-message` each poison message" step will fail if it follows the read step as written. ElasticMQ only deletes a message when the receipt handle is the **latest** one (`deliveryReceipts.lastOption.contains(receipt)`), otherwise it returns `InvalidReceiptHandle`. With `--visibility-timeout 0`, any later receive of the DLQ (a second read, the read that saves to a file, another operator) gives the message a new receipt and the old handles stop working. On AWS, SQS also expects the most recent receipt handle. Also, with visibility 0 the same ≤10 messages come back on every read, so a DLQ with more than 10 messages cannot be fully read and the poison messages beyond the first 10 cannot all be found. | ElasticMQ `core/.../operations/DeleteMessageOps.scala` L13-21; `MoveMessagesAsyncOps` (redrive moves everything, so any poison message left behind is redriven) | Split the runbook into two kinds of read. (a) Peek with visibility 0 only to look at messages. (b) To remove poison messages, receive with a real visibility (for example 300 s), save the body, and delete using the handle from **that same** receive. Repeat until `ApproximateNumberOfMessages` reaches 0, so the whole DLQ has been read. Then run the redrive after those messages become visible again. M-125-03 must follow the same sequence. |
| R2-2 (new) | should-fix | §1 G1-1, §3 `failFor: Set<string>`, §4 TC-125-01/03 | `failFor` is keyed by an `eventId` that the test can only learn **after** the transfer commits, because `eventId` is created in `outbox_events` and is not in the HTTP response. The relay polls every 500 ms and the notification poller is already waiting on a 1 s long poll. So between "the POST returns, the test looks up the `eventId`, then adds it to `failFor`", the event can already be published and processed successfully. The test would then fail intermittently: `handle` = 1, `notification_log` has 2 rows, and nothing goes to the DLQ. | `outbox-relay.service.ts` `RELAY_IDLE_DELAY_MS = 500`; `consumer-base.ts` `process`/`apply` (no pause between receive and apply) | Key the failure on something known **before** the request is sent. For example, fail `TransferCompleted` events whose `type = 'TRANSFER'` and whose `fromAccountId` is the account chosen for the test. Or start the notification poller only after the failure rule is set. Then read the `eventId` afterwards for the assertions. |

Every other round-1 finding is resolved:

- **#2:** `--destination-arn` is now always given and the ARN is read from `QueueArn`.
- **#3:** every count is filtered by `eventId`, and the deposits are processed before the failure starts.
- **#4:** TC-125-03 now checks exactly 2 `notification_log` rows, 1 `processed_events` row and 1 `handle` call.
- **#5:** the timing is now ≈ 75–80 s.
- **#6:** the timing evidence works. The message in the DLQ is a new `SendMessage` from `deadLetter`, so its `SentTimestamp` is the time of the 5th receive. `transfers.created_at` uses `clock_timestamp()`. With 5 receives the gap is about 75 s; with 4 it would be about 35 s, so the two cases can be told apart.
- **#7, #8 and #10** are resolved.
- **#9:** the IAM and read flags are fixed; the part about deleting messages is covered by R2-1.
- **#1:** the tests no longer depend on each other. `PurgeQueue` on ElasticMQ empties the queue at once, including messages in flight (`ClearQueue` calls `messageQueue.clear()`), and there is no 60 s limit, so purging at the start of each test is safe. The runbook part of #1 is covered by R2-1.

The `CHECK (false) NOT VALID` constraint is valid PostgreSQL: new INSERTs fail with `23514`, existing rows are kept, and nothing on the risk path writes to `notification_log`.

Verdict: REVISE
