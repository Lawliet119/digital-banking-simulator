# SQS adapter (DBS-77)

Import `SqsModule` in consumers/relay modules and inject `SqsClient` from `@libs/sqs`.
The module registers existing `sqsConfig`: `AWS_REGION`, optional `SQS_ENDPOINT`,
`SQS_RISK_QUEUE_URL`, `SQS_NOTIFICATION_QUEUE_URL`. Pass the configured queue URL to
the methods; the adapter does not create queues. Local Compose uses ElasticMQ and
local AWS credential placeholders; cloud omits endpoint and uses the standard SDK
credential provider chain (ECS task role). No credentials are embedded in runtime code.

```ts
await sqs.send(queueUrl, JSON.stringify(event), { correlationId: event.correlationId });
const results = await sqs.processBatch(queueUrl, dlqUrl, async (body, message) => {
  // Validate body (unknown), establish correlation context, commit effect + processed_events.
  await consumer.handle(body, message);
});
// Inspect failed results for metrics/backoff. No message body or receipt in logs.
```

- `send(queue, body, attributes?)`: raw string; String attributes. SDK errors propagate.
- `receive(queue, options?)`: raw messages, **no deletion**; defaults wait 20s, max 10,
  visibility 30s. Integer ranges: wait 0–20, max 1–10, visibility 0–43200.
- `acknowledge(queue, message)`: delete receipt only after committed processing.
- `processBatch(queue, dlqUrl, handler, options?)`: one batch, handlers run concurrently.
  Await each callback before its delete. Results: acknowledged/dead-lettered/failed.
  Handler/delete failure stays unacknowledged and does not prevent peers from finishing.
  Invalid JSON goes unchanged to DLQ before source deletion; forwarding failure leaves
  source intact. Missing body/receipt returns failed. receive failures propagate.
- `onModuleDestroy()`: release SDK sockets. Nest calls it on module shutdown.

Caller owns worker-only polling, graceful loop shutdown, dedup, event schema validation,
UNKNOWN_EVENT_TYPE policy, immediate DLQ for invalid schema and visibility extension
for processing over 30 seconds. Callback must commit before resolving; never resolve
on rollback. Batch may be short/empty. Sending to DLQ and deleting source are separate
operations: duplicates remain possible and consumers need idempotency.
Do not call SQS inside a money transaction. Payload size limits belong relay validation
(BL-123); this adapter uses SDK/service limits and does not truncate payloads.

Verification: `npm run test:services -- --runInBand --runTestsByPath test/services/sqs-adapter.services-spec.ts`.
Manual: start Compose ElasticMQ, `npm run build`, then `node scripts/manual-dbs77.cjs`.
It uses isolated local queues and cleans them in finally. No AWS queues are touched.
