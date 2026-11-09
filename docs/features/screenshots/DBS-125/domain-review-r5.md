<!-- Reviewer: same subagent (Opus, effort medium), 2026-11-10, round 5 on the round-4 fixes. Raw reply below, unedited. -->

| # | Severity | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|

I found no open or new issues; R4-1, R4-2 and R4-3 are all resolved.

- **R4-1:** The "wait out the visibility" option is gone, and the doc now gives the real reason. Valid messages are hidden for 1800 s, so `change-message-visibility 0` always lowers the delay. That takes ElasticMQ down the path that rebuilds the queue from `messagesById` (`UpdateVisibilityTimeoutOps` L29-34, `filterNot` L200-206). Every delete happens during the scan, before any of these calls, so deleted poison messages are dropped before the redrive. The "do not redrive when no valid message is left" rule covers the case with nothing to un-hide.
- **The risk DLQ in M-125-03:** after its `{not json` is deleted, a dead entry stays in ElasticMQ's internal queue, because it is not redriven and nothing rebuilds the queue. This does not break the expected "both DLQs 0": `get-queue-attributes` counts from `messagesById`, which no longer holds that message (`QueueActorQueueOps.getQueueStatistics` L60, `messageQueue.all`, same code in the 2026-04-05 image, commit 85de3b7).
- **R4-2:** A 1800 s visibility plus "keep only the newest handle per `MessageId`" fits ElasticMQ's rule that only the latest receipt works (`UpdateVisibilityTimeoutOps` L24).
- **R4-3:** The tested image digest is recorded, and pinning the image is handed off to BL-225.

Verdict: APPROVE
