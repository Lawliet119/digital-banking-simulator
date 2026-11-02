# DBS-77 · SQS adapter

## 1. Scope

Board Dev, High, In Progress; DBS-40 Done. Main has ElasticMQ Testcontainers and AWS SDK as devDependency, no runtime adapter. User continues prior workflow (implement/test/manual/commit/push/Draft PR without gate pauses). No sheet edits or merge.

## 2. Behaviour

SqsClient.send(queueUrl, body:string, attributes:Record<string,string>) sends raw body with String message attributes. receive(queueUrl, options) returns raw SDK messages with body, receipt handle, attributes; defaults long poll 20 seconds, batch 10, visibility 30 seconds. Valid options: wait 0..20, batch 1..10, visibility 0..43200, all integers. SDK credentials use standard provider chain; endpoint/region from existing sqs.config.ts. No hardcoded cloud credentials or automatic polling.

acknowledge(queue,message) deletes by receipt handle, only after caller's transaction committed. processBatch(queue, dlqUrl, handler, options) receives one batch, parses JSON and awaits each handler before deleting that message. Parse failure sends original body/attributes to DLQ and only then deletes source (BL-010); DLQ failure leaves original for redelivery. Valid JSON is unknown: schema/UNKNOWN_EVENT_TYPE policy remains consumer-owned, no event validation stub. Handler/delete failure returns failed per message, continues other messages; failures are never deleted by that path. At-least-once means caller needs processed_events dedup, and visibility extension for long handlers belongs consumer. No logs of bodies/errors/receipt handles. SQS send/receive errors propagate.

## 3. Architecture

Public @libs/sqs exports SqsClient and SqsModule. Injectable client receives typed sqsConfig, creates one SDK client, destroys it on Nest shutdown. SqsModule registers config feature, exports client; modules must import it explicitly. No AppModule import or worker loop in this task. Move existing SDK dependency from dev to runtime at same locked version, no new SDK version or env vars. Caller supplies queue URLs from existing config, and DLQ URL explicitly from consumer wiring (no invented env).

## 4. Tests

| Case | Proof |
|---|---|
| TC-77-01 | Unit verifies longpoll/batch/visibility/attribute SDK parameters, options boundaries, config endpoint/region and destroy |
| TC-77-02 | Real ElasticMQ Testcontainers send/receive preserves body + correlationId and returns receipt; receive alone never deletes |
| TC-77-03 | Real batch: handler rejection message reappears after visibility, successful peer gone; handler pending message remains in-flight and not deleted |
| TC-77-04 | Invalid JSON -> DLQ before source acknowledgement; failed DLQ send leaves source; schema handling remains consumer-owned |
| TC-77-05 | Multiple messages processed, no empty-batch failure; SDK receive/send/delete errors propagate or mark individual failed appropriately |
| Process | CI, Dev review, merge, full PR DoD table |

## 5. Manual

Commands from repo: `docker compose up -d elasticmq`; `cd backend`; `npm run build`; `node scripts/manual-dbs77.cjs`. Driver kept in PR, reads compiled adapter and points only to localhost:9324. It creates isolated queues with unique generated names, and in finally destroys adapter and deletes only queues created by script. Captures exact code SHA/output without credentials/body PII. AWS credentials used only local placeholders in driver. No AWS resource creation.

| Step | Action | Expected output/assertion |
|---|---|---|
| M-77-01 | Send JSON with correlationId String attribute, receive through adapter | Body and attribute match; receipt exists; print roundtrip PASS |
| M-77-02 | Batch callback succeeds; poll source | Success acknowledged; no source messages; print success PASS |
| M-77-03 | Callback rejects with visibility 0; receive again | Failed result and same MessageId redelivered; print redelivery PASS; explicitly acknowledge probe |
| M-77-04 | Send malformed JSON; processBatch with isolated DLQ | No callback invocation, source absent, raw body in DLQ; print malformed PASS |
| M-77-05 | receive with maxMessages=11 | Reject RangeError before transport; print boundary PASS |
| M-77-06 | finally delete isolated queues | Every DeleteQueue succeeds, print cleanup PASS and exit 0. Assertion or transport failure exits nonzero and still attempts cleanup |

## 6. Review

Independent subagent review: initial 1 should-fix (manual needed concrete steps and boundary); fixed §5, final APPROVE with no outstanding findings. [Raw final reply](screenshots/DBS-77/domain-review.md).

## 7. Plan

Tests first (missing module red), implement adapter/module, move SDK to dependencies and update lock metadata. Add the new ElasticMQ suite as a step in existing e2e CI job (required job names unchanged). Run unit/typecheck/lint/build/e2e/services with real container; manual on final commit, save output, docs/index/backlog, push Draft PR. BL-010 parsing included, schema decisions handed to consumers; BL-009 and BL-123 worker serialization/context/relay payload limits remain out of scope. Back out by removing unconsumed adapter/module and dependency move.

## 8. Results

Code `6db1e91`. Test-first unit red TS2307 missing sqs.client. Baseline main lint/typecheck/unit 770/770/e2e 135/135 passed. Final lint/typecheck/build passed, unit 775/775 and E2E 135/135 passed. New tests: 5 unit (SDK input/validation/DI/shutdown/error paths) and 5 services (real ElasticMQ Testcontainers dynamic port), no skips. SDK dependency moved to runtime at existing locked 3.1157.0; npm ls --omit=dev confirms present. No SDK version upgrade. New CI step runs services suite inside existing e2e job, preserves required job names.

Manual M-77-01..06 on final code commit `6db1e91` passed: String attributes and large integer string roundtrip, success delete, failed-handler redelivery same MessageId, malformed JSON in DLQ/no business callback/source gone, invalid batch rejected, isolated queues deleted. [Transcript](screenshots/DBS-77/manual-test.txt), [output excerpt](screenshots/DBS-77/01-manual-output.png). Driver remains in PR for review replay. No live AWS call made; real cloud transport not claimed, config and SDK provider-chain wiring covered by unit and local protocol evidence.

| DoD | Tests | Result |
|---|---|---|
| Send/receive longpoll/batch | TC-77-01/02/03/05 | Unit defaults and real batch of more than one message; exact raw body + attributes |
| Delete after processing, failure stays | TC-77-03/05 | Real pending callback remains in-flight; rejected handler redelivers; successful peers removed; unit delete failure returns failed |
| Config local/cloud | TC-77-01, Nest DI test | Uses existing config and provider chain, local real ElasticMQ; cloud not provisioned |
| JSON parse BL-010 | TC-77-04 | Real DLQ forwarding and real unavailable-DLQ preservation; schema/unknown type remains consumer handoff |
| CI/Dev review/merge | Draft PR checks | CI via PR checks; Dev review/merge pending BL-139 |

No money, auth, ownership endpoint or database change. Caller owns permission, schema validation, dedup and committed transaction lifecycle. BL-009/123 remain worker/relay tasks; BL-010 partially delivered, consumer validation still open. BL-139 tracks review/merge. Manual output has only local generated queue names and no credentials or user data. User requested prior workflow without gate pauses; independent design review, tests and manual completed before Draft PR.

## 9. Docs

Sources: docs/03 §10, ADR-03, event-contract, libs README, sqs.config.ts, BACKLOG BL-010/009/123. Update adapter README, feature index and backlog handoffs.

Updated [adapter README](../../backend/src/libs/sqs/README.md), libs README, feature index, backlog, CI e2e step. No architecture/env/ADR changes.
