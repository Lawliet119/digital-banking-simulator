import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import { createLoopbackAdapter } from '../../src/modules/risk/ai/openai-decisions';

async function runTimeoutFixture() {
  assert.deepEqual(process.argv.slice(2), ['--timeout']);
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk as Uint8Array));
  const features: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));

  let requests = 0;
  let acquisitions = 0;
  let releases = 0;
  let headersFlushed = false;
  let requestStartedAt: number | null = null;
  const sockets = new Set<Socket>();
  const server = createServer((request, response) => {
    requests += 1;
    requestStartedAt ??= performance.now();
    request.resume();
    response.writeHead(200, { 'content-type': 'application/json' });
    response.flushHeaders();
    headersFlushed = true;
    // Never end the response: the adapter's deadline must cover body reads,
    // not merely the arrival of successful HTTP headers.
  });
  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  let watchdog: NodeJS.Timeout | undefined;
  let observable: Record<string, unknown>;
  try {
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.off('error', reject);
        resolve();
      });
    });
    const address = server.address();
    assert(address !== null && typeof address !== 'string');
    const assess = createLoopbackAdapter(`http://127.0.0.1:${address.port}/v1/decisions`);
    const startedAt = performance.now();
    const result = await Promise.race([
      assess(features, {
        enabled: true,
        apiKey: 'synthetic-loopback-only-not-a-credential',
        model: 'gpt-6-luna',
        requestTimeoutMs: 200,
        maxAdmissionDelayMs: 1000,
        selectedAtMonotonicMs: performance.now(),
        tryAcquire: () => {
          acquisitions += 1;
          return {
            kind: 'granted',
            release: () => {
              releases += 1;
            },
          };
        },
      }),
      new Promise<never>((_resolve, reject) => {
        watchdog = setTimeout(() => reject(new Error('FIXTURE_DEADLINE_EXCEEDED')), 2000);
      }),
    ]);
    const finishedAt = performance.now();
    const elapsedMs = finishedAt - startedAt;
    assert.equal(result.status, 'UNAVAILABLE');
    assert.equal(result.probability, null);
    assert.equal(result.provider, 'openai');
    assert.equal(result.requestedModel, 'gpt-6-luna');
    assert.equal(requests, 1);
    assert.equal(acquisitions, 1);
    assert.equal(releases, 1);
    assert.equal(headersFlushed, true);
    assert(requestStartedAt !== null);
    assert(elapsedMs >= 150);
    assert(elapsedMs <= 2000);
    observable = {
      fixture: 'loopback-timeout-after-headers',
      status: result.status,
      probability: result.probability,
      elapsedMs,
      requestElapsedMs: finishedAt - requestStartedAt,
      requests,
      permitAcquisitions: acquisitions,
      permitReleases: releases,
      headersFlushed,
    };
  } finally {
    clearTimeout(watchdog);
    // Destroy held-open connections even if an assertion or the watchdog fails.
    // Closing the listener alone would wait forever for this deliberately hung body.
    const closed = server.listening
      ? new Promise<void>((resolve, reject) => {
          server.close(error => (error ? reject(error) : resolve()));
        })
      : Promise.resolve();
    for (const socket of sockets) socket.destroy();
    server.closeAllConnections();
    await closed;
  }
  console.log(JSON.stringify(observable));
}

void runTimeoutFixture().catch(() => {
  // Never print stdin, an exception, headers, provider data, or credentials.
  console.log(JSON.stringify({ fixture: 'loopback-timeout-after-headers', status: 'FAILED' }));
  process.exitCode = 1;
});
