import { createHash } from 'node:crypto';
import { createServer, IncomingMessage, Server, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { performance } from 'node:perf_hooks';
import type { AiAssessment, DecisionOptions } from './ai-contract';
import { assess, createLoopbackAdapter } from './openai-decisions';

const FEATURES = {
  amount: '20000000',
  fromBalanceBefore: '22000000',
  accountAgeHours: 3,
  sameOwner: false,
  txCount10m: 2,
  txCount1h: 3,
  historyCount30d: 6,
  medianAmount30d: '5000000.5',
  minutesSinceReverse: null,
  newRecipients1h: 2,
  distinctRecipients24h: 3,
};
const RUBRIC =
  'Given only the supplied numeric transaction features, is this completed transfer sufficiently unusual to warrant an operator review? Consider legitimate patterns, including transfers between accounts of the same owner. Do not infer missing facts, claim fraud, or decide whether to block a transfer.';
const SECRET = 'synthetic-key-not-a-real-credential';
const PRIVATE_RESPONSE = 'provider-private-body-must-never-be-exposed';
const RESPONSE_LIMIT = 65536;
const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
const predicate = (probability: unknown = 0.42) => ({
  type: 'predicate',
  name: 'needs_operator_review',
  probability,
});
const successfulBody = (probability = 0.42) => ({
  answers: [predicate(probability)],
  model: 'returned-provider-model',
});
const validUsage = {
  input_tokens: 17,
  input_tokens_details: { cached_tokens: 3, cache_write_tokens: 2 },
  output_tokens: 0,
  output_tokens_details: { reasoning_tokens: 0 },
  total_tokens: 17,
};

interface CapturedRequest {
  method: string | undefined;
  url: string | undefined;
  headers: IncomingMessage['headers'];
  body: string;
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => {
    resolve = done;
  });
  return { promise, resolve };
}

async function within<T>(promise: Promise<T>, milliseconds = 2000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error('Loopback operation did not finish')),
          milliseconds,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

// These fixtures exercise real HTTP, not provider quality or a live OpenAI account.
describe('OpenAI Decisions HTTP behavior (TC-AI-01/03/04/05/10)', () => {
  let server: Server;
  let url: string;
  let evaluate: typeof assess;
  let requests: CapturedRequest[];
  let sockets: Set<Socket>;
  let respond: (request: IncomingMessage, response: ServerResponse) => void;
  let release: jest.Mock;
  let tryAcquire: jest.Mock;
  let logSpies: jest.SpyInstance[];

  function options(overrides: Partial<DecisionOptions> = {}): DecisionOptions {
    return {
      enabled: true,
      apiKey: SECRET,
      model: 'gpt-6-luna',
      requestTimeoutMs: 1000,
      maxAdmissionDelayMs: 1000,
      selectedAtMonotonicMs: performance.now(),
      tryAcquire,
      ...overrides,
    };
  }

  function send(response: ServerResponse, body: unknown, status = 200) {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  function expectOutcome(
    result: AiAssessment,
    status: AiAssessment['status'],
    probability: number | null = null,
  ) {
    expect(result).toMatchObject({
      status,
      probability,
      provider: 'openai',
      requestedModel: 'gpt-6-luna',
      rubricSha256: sha256(RUBRIC),
      inputSha256: sha256(JSON.stringify(FEATURES)),
    });
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(JSON.stringify(result)).not.toContain(PRIVATE_RESPONSE);
  }

  function expectOneRequestAndRelease() {
    expect(requests).toHaveLength(1);
    expect(tryAcquire).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledTimes(1);
  }

  beforeEach(async () => {
    requests = [];
    sockets = new Set();
    release = jest.fn();
    tryAcquire = jest.fn(() => ({ kind: 'granted' as const, release }));
    logSpies = ['log', 'info', 'warn', 'error', 'debug'].map(method =>
      jest.spyOn(console, method as 'log').mockImplementation(() => undefined),
    );
    respond = (_request, response) => send(response, successfulBody());
    server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on('data', (chunk: Buffer) => chunks.push(chunk));
      request.on('end', () => {
        requests.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks).toString('utf8'),
        });
        respond(request, response);
      });
    });
    server.on('connection', socket => {
      sockets.add(socket);
      socket.on('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        server.removeListener('error', reject);
        resolve();
      });
    });
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected an ephemeral TCP listener');
    url = `http://127.0.0.1:${address.port}/v1/decisions`;
    evaluate = createLoopbackAdapter(url);
  });

  afterEach(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve, reject) => {
      server.close(error => (error ? reject(error) : resolve()));
    });
    const logs = logSpies
      .flatMap(spy => spy.mock.calls as unknown[][])
      .map(call => call.map(String).join(' '))
      .join('\n');
    for (const spy of logSpies) spy.mockRestore();
    expect(logs).not.toContain(SECRET);
    expect(logs).not.toContain(PRIVATE_RESPONSE);
    expect(logs).not.toContain(FEATURES.amount);
    expect(logs).not.toContain(FEATURES.medianAmount30d);
    expect(logs).not.toContain('private@example.test');
  });

  it.each([0, 1])('returns SUCCEEDED without losing boundary probability %s', async probability => {
    respond = (_request, response) => send(response, successfulBody(probability));
    const result = await evaluate(FEATURES, options());
    expectOutcome(result, 'SUCCEEDED', probability);
    expect(result).toMatchObject({
      responseModel: 'returned-provider-model',
      requestId: null,
      usage: null,
    });
    expectOneRequestAndRelease();
  });

  it('sends only the exact allowlisted JSON, fixed predicate and intended authentication', async () => {
    await evaluate(FEATURES, options());
    expectOneRequestAndRelease();
    const [request] = requests;
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/v1/decisions');
    expect(request.headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(request.headers['content-type']).toMatch(/^application\/json(?:;|$)/);
    const body = JSON.parse(request.body) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(['input', 'model', 'questions']);
    expect(body.model).toBe('gpt-6-luna');
    expect(body.questions).toEqual([
      { type: 'predicate', name: 'needs_operator_review', instructions: RUBRIC },
    ]);
    expect(body.input).toEqual([
      expect.objectContaining({ role: 'user', content: [{ type: 'input_json', data: FEATURES }] }),
    ]);
    expect(request.body).not.toContain(SECRET);
    expect(request.body).not.toContain('Authorization');
  });

  it('canonicalizes reordered input before hashing and sending, preserving exact monetary strings', async () => {
    const exact = {
      ...FEATURES,
      amount: '9007199254740993',
      fromBalanceBefore: '9223372036854775807',
    };
    const result = await evaluate(Object.fromEntries(Object.entries(exact).reverse()), options());
    expect(result.status).toBe('SUCCEEDED');
    expect(result.inputSha256).toBe(sha256(JSON.stringify(exact)));
    const body = JSON.parse(requests[0].body) as { input: { content: { data: unknown }[] }[] };
    expect(JSON.stringify(body.input[0].content[0].data)).toBe(JSON.stringify(exact));
    expectOneRequestAndRelease();
  });

  it.each(['accountId', 'email', 'name', 'scenario', 'label', 'history', 'comment'])(
    'rejects extra %s before acquiring a permit or sending PII',
    async field => {
      const result = await evaluate({ ...FEATURES, [field]: 'private@example.test' }, options());
      expect(result).toMatchObject({ status: 'CONFIG_INVALID', probability: null });
      expect(JSON.stringify(result)).not.toContain('private@example.test');
      expect(requests).toHaveLength(0);
      expect(tryAcquire).not.toHaveBeenCalled();
      expect(release).not.toHaveBeenCalled();
    },
  );

  it.each([
    ['missing feature', { ...FEATURES, sameOwner: undefined }],
    ['nonfinite feature', { ...FEATURES, accountAgeHours: NaN }],
    ['invalid monetary string', { ...FEATURES, amount: '020000000' }],
  ])('maps %s to CONFIG_INVALID without a request', async (_description, features) => {
    const result = await evaluate(features, options());
    expect(result).toMatchObject({ status: 'CONFIG_INVALID', probability: null });
    expect(requests).toHaveLength(0);
    expect(tryAcquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it.each([
    ['disabled', { enabled: false }],
    ['missing key', { apiKey: null }],
    ['empty key', { apiKey: '' }],
  ])('returns DISABLED for %s without admission or network', async (_description, override) => {
    const result = await evaluate(FEATURES, options(override));
    expect(result).toMatchObject({ status: 'DISABLED', probability: null });
    expect(requests).toHaveLength(0);
    expect(tryAcquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it.each([
    ['empty model', { model: '' }],
    ['key with trailing whitespace', { apiKey: `${SECRET} ` }],
    ['zero deadline', { requestTimeoutMs: 0 }],
    ['negative deadline', { requestTimeoutMs: -1 }],
    ['infinite deadline', { requestTimeoutMs: Infinity }],
    ['NaN deadline', { requestTimeoutMs: NaN }],
    ['deadline above Node timer maximum', { requestTimeoutMs: 2147483648 }],
    ['zero admission window', { maxAdmissionDelayMs: 0 }],
    ['infinite admission window', { maxAdmissionDelayMs: Infinity }],
    ['nonfinite selection time', { selectedAtMonotonicMs: NaN }],
  ])('rejects %s without admission or network', async (_description, override) => {
    const result = await evaluate(FEATURES, options(override));
    expect(result).toMatchObject({ status: 'CONFIG_INVALID', probability: null });
    expect(requests).toHaveLength(0);
    expect(tryAcquire).not.toHaveBeenCalled();
    expect(release).not.toHaveBeenCalled();
  });

  it('maps a named refusal to REFUSED and does not expose provider text', async () => {
    respond = (_request, response) =>
      send(response, {
        answers: [{ type: 'refusal', name: 'needs_operator_review', reason: PRIVATE_RESPONSE }],
      });
    const result = await evaluate(FEATURES, options());
    expectOutcome(result, 'REFUSED');
    expect(result).toMatchObject({ responseModel: null, requestId: null, usage: null });
    expectOneRequestAndRelease();
  });

  it.each([
    ['missing answers', {}],
    ['empty answers', { answers: [] }],
    ['nonarray answers', { answers: predicate() }],
    ['duplicate named answers', { answers: [predicate(), predicate()] }],
    ['unexpected additional answer', { answers: [predicate(), { ...predicate(), name: 'other' }] }],
    ['wrong name', { answers: [{ ...predicate(), name: 'fraud' }] }],
    ['missing name', { answers: [{ type: 'predicate', probability: 0.4 }] }],
    ['null name', { answers: [{ ...predicate(), name: null }] }],
    ['wrong type', { answers: [{ ...predicate(), type: 'score' }] }],
    ['missing type', { answers: [{ name: 'needs_operator_review', probability: 0.4 }] }],
    ['missing probability', { answers: [{ type: 'predicate', name: 'needs_operator_review' }] }],
    ['null probability', { answers: [predicate(null)] }],
    ['string probability', { answers: [predicate('0.4')] }],
    ['boolean probability', { answers: [predicate(true)] }],
    ['array probability', { answers: [predicate([0.4])] }],
    ['negative probability', { answers: [predicate(-0.01)] }],
    ['probability above one', { answers: [predicate(1.01)] }],
    ['refusal for wrong question', { answers: [{ type: 'refusal', name: 'other' }] }],
    ['refusal for unnamed question', { answers: [{ type: 'refusal', name: null }] }],
    ['null answer', { answers: [null] }],
    ['null response', null],
    ['array response', []],
  ])('maps %s to INVALID_RESPONSE without retrying', async (_description, body) => {
    respond = (_request, response) => send(response, body);
    const result = await evaluate(FEATURES, options());
    expectOutcome(result, 'INVALID_RESPONSE');
    expectOneRequestAndRelease();
  });

  it.each([
    ['malformed JSON', `{${PRIVATE_RESPONSE}`],
    [
      'NaN token',
      '{"answers":[{"name":"needs_operator_review","type":"predicate","probability":NaN}]}',
    ],
    [
      'overflowing finite JSON number',
      '{"answers":[{"name":"needs_operator_review","type":"predicate","probability":1e999}]}',
    ],
    ['empty body', ''],
  ])('rejects %s safely', async (_description, body) => {
    respond = (_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(body);
    };
    const result = await evaluate(FEATURES, options());
    expectOutcome(result, 'INVALID_RESPONSE');
    expectOneRequestAndRelease();
  });

  it.each([400, 401, 402, 403, 408, 429, 500, 502, 503])(
    'maps HTTP %s to UNAVAILABLE, releases once and never retries',
    async status => {
      respond = (_request, response) =>
        send(
          response,
          {
            ...successfulBody(),
            error: { message: `${PRIVATE_RESPONSE} ${SECRET}` },
          },
          status,
        );
      const result = await evaluate(FEATURES, options());
      expectOutcome(result, 'UNAVAILABLE');
      expect(result.usage).toBeNull();
      expectOneRequestAndRelease();
    },
  );

  it('does not follow redirects or forward credentials to another path', async () => {
    respond = (request, response) => {
      if (request.url === '/v1/decisions') {
        response.writeHead(307, { location: url.replace('/v1/decisions', '/redirect-target') });
        response.end();
      } else {
        send(response, successfulBody());
      }
    };
    const result = await evaluate(FEATURES, options());
    expectOutcome(result, 'UNAVAILABLE');
    expectOneRequestAndRelease();
  });

  it('maps an actual disconnected socket to UNAVAILABLE and releases once', async () => {
    respond = request => request.socket.destroy();
    const result = await evaluate(FEATURES, options());
    expectOutcome(result, 'UNAVAILABLE');
    expectOneRequestAndRelease();
  });

  it('accepts a valid response at the byte limit', async () => {
    const base = JSON.stringify({ ...successfulBody(), padding: '' });
    const body = JSON.stringify({
      ...successfulBody(),
      padding: 'x'.repeat(RESPONSE_LIMIT - Buffer.byteLength(base)),
    });
    expect(Buffer.byteLength(body)).toBe(RESPONSE_LIMIT);
    respond = (_request, response) => response.end(body);
    const result = await evaluate(FEATURES, options());
    expectOutcome(result, 'SUCCEEDED', 0.42);
    expectOneRequestAndRelease();
  });

  it('enforces the response cap in UTF-8 bytes rather than characters', async () => {
    const body = JSON.stringify({ ...successfulBody(), padding: 'é'.repeat(40000) });
    expect(body.length).toBeLessThan(RESPONSE_LIMIT);
    expect(Buffer.byteLength(body)).toBeGreaterThan(RESPONSE_LIMIT);
    respond = (_request, response) => {
      response.writeHead(200, {
        'content-type': 'application/json',
        'content-length': Buffer.byteLength(body),
      });
      response.end(body);
    };
    const result = await evaluate(FEATURES, options());
    expectOutcome(result, 'INVALID_RESPONSE');
    expectOneRequestAndRelease();
  });

  it('cancels an oversized chunked body before EOF instead of waiting for the deadline', async () => {
    const closed = deferred();
    respond = (_request, response) => {
      response.once('close', closed.resolve);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.write('{"padding":"');
      response.write('x'.repeat(RESPONSE_LIMIT));
      // Deliberately no end: a reader that buffers until EOF must not pass.
    };
    const result = await within(evaluate(FEATURES, options({ requestTimeoutMs: 1500 })));
    expectOutcome(result, 'INVALID_RESPONSE');
    await within(closed.promise);
    expectOneRequestAndRelease();
  });

  it.each(['headers', 'body'])(
    'actually aborts a stalled %s phase and releases its permit',
    async phase => {
      const closed = deferred();
      const received = deferred();
      respond = (_request, response) => {
        response.once('close', closed.resolve);
        if (phase === 'body') {
          response.writeHead(200, { 'content-type': 'application/json' });
          response.write('{"answers":[');
        }
        received.resolve();
        // No response completion in either case; only client abort closes the socket.
      };
      const startedAt = performance.now();
      const pending = evaluate(FEATURES, options({ requestTimeoutMs: 200 }));
      await within(received.promise);
      expect(release).not.toHaveBeenCalled();
      const result = await within(pending);
      expect(performance.now() - startedAt).toBeLessThan(2000);
      expectOutcome(result, 'UNAVAILABLE');
      expect(result.usage).toBeNull();
      await within(closed.promise);
      expectOneRequestAndRelease();
    },
  );

  it.each([
    ['budget_exhausted', 'BUDGET_EXHAUSTED'],
    ['unavailable', 'UNAVAILABLE'],
  ] as const)(
    'preserves provenance for denied %s admission without a request',
    async (kind, status) => {
      tryAcquire.mockReturnValue({ kind });
      const result = await evaluate(FEATURES, options());
      expectOutcome(result, status);
      expect(result).toMatchObject({ responseModel: null, requestId: null, usage: null });
      expect(requests).toHaveLength(0);
      expect(tryAcquire).toHaveBeenCalledTimes(1);
      expect(release).not.toHaveBeenCalled();
    },
  );

  it('never sends once selection has exceeded its admission deadline', async () => {
    const result = await evaluate(
      FEATURES,
      options({
        selectedAtMonotonicMs: performance.now() - 100,
        maxAdmissionDelayMs: 10,
      }),
    );
    expectOutcome(result, 'UNAVAILABLE');
    expect(requests).toHaveLength(0);
    // Early deadline rejection need not acquire; every granted permit must be released.
    expect(tryAcquire.mock.calls.length).toBeLessThanOrEqual(1);
    expect(release).toHaveBeenCalledTimes(tryAcquire.mock.calls.length);
  });

  it('rechecks monotonic admission time after acquisition and releases an expired grant', async () => {
    let now = 100;
    const originalClock = Object.getOwnPropertyDescriptor(performance, 'now');
    Object.defineProperty(performance, 'now', { configurable: true, value: () => now });
    tryAcquire.mockImplementation(() => {
      now = 151;
      return { kind: 'granted', release };
    });
    try {
      const result = await evaluate(
        FEATURES,
        options({ selectedAtMonotonicMs: 100, maxAdmissionDelayMs: 50 }),
      );
      expectOutcome(result, 'UNAVAILABLE');
      expect(requests).toHaveLength(0);
      expect(tryAcquire).toHaveBeenCalledTimes(1);
      expect(release).toHaveBeenCalledTimes(1);
    } finally {
      if (originalClock) Object.defineProperty(performance, 'now', originalClock);
      else Reflect.deleteProperty(performance, 'now');
    }
  });

  it('returns only safe provider provenance and projected token usage', async () => {
    respond = (_request, response) => {
      response.setHeader('x-request-id', 'req_synthetic_123');
      send(response, {
        ...successfulBody(),
        usage: { ...validUsage, private: PRIVATE_RESPONSE },
        secret: SECRET,
        raw: PRIVATE_RESPONSE,
      });
    };
    const result = await evaluate(FEATURES, options());
    expectOutcome(result, 'SUCCEEDED', 0.42);
    expect(result.responseModel).toBe('returned-provider-model');
    expect(result.requestId).toBe('req_synthetic_123');
    expect(result.usage).toEqual({ inputTokens: 17, cachedTokens: 3, cacheWriteTokens: 2 });
    expect(Object.keys(result).sort()).toEqual(
      [
        'status',
        'probability',
        'provider',
        'requestedModel',
        'responseModel',
        'requestId',
        'rubricSha256',
        'inputSha256',
        'usage',
      ].sort(),
    );
    expectOneRequestAndRelease();
  });

  it('does not disclose a credential echoed in provider metadata', async () => {
    respond = (_request, response) => {
      response.setHeader('x-request-id', SECRET);
      send(response, { answers: [predicate()], model: SECRET });
    };
    const result = await evaluate(FEATURES, options());
    expect(result.status).toBe('SUCCEEDED');
    expect(JSON.stringify(result)).not.toContain(SECRET);
    expect(result.responseModel).toBeNull();
    expect(result.requestId).toBeNull();
  });

  it.each([null, 7, {}, ''])('drops invalid response model metadata (%j)', async model => {
    respond = (_request, response) => send(response, { answers: [predicate()], model });
    const result = await evaluate(FEATURES, options());
    expectOutcome(result, 'SUCCEEDED', 0.42);
    expect(result.responseModel).toBeNull();
    expectOneRequestAndRelease();
  });

  it('drops an empty request ID rather than inventing provenance', async () => {
    respond = (_request, response) => {
      response.setHeader('x-request-id', '');
      send(response, successfulBody());
    };
    const result = await evaluate(FEATURES, options());
    expectOutcome(result, 'SUCCEEDED', 0.42);
    expect(result.requestId).toBeNull();
    expectOneRequestAndRelease();
  });

  it('does not invent response model, request ID or zero usage when absent', async () => {
    respond = (_request, response) => send(response, { answers: [predicate()] });
    const result = await evaluate(FEATURES, options());
    expectOutcome(result, 'SUCCEEDED', 0.42);
    expect(result).toMatchObject({ responseModel: null, requestId: null, usage: null });
    expectOneRequestAndRelease();
  });

  it('preserves legitimate zero usage', async () => {
    respond = (_request, response) =>
      send(response, {
        ...successfulBody(),
        usage: {
          ...validUsage,
          input_tokens: 0,
          input_tokens_details: { cached_tokens: 0, cache_write_tokens: 0 },
        },
      });
    const result = await evaluate(FEATURES, options());
    expectOutcome(result, 'SUCCEEDED', 0.42);
    expect(result.usage).toEqual({ inputTokens: 0, cachedTokens: 0, cacheWriteTokens: 0 });
    expectOneRequestAndRelease();
  });

  it.each([
    ['negative input', { ...validUsage, input_tokens: -1 }],
    ['fractional input', { ...validUsage, input_tokens: 1.5 }],
    ['unsafe input', { ...validUsage, input_tokens: Number.MAX_SAFE_INTEGER + 1 }],
    ['string input', { ...validUsage, input_tokens: '17' }],
    ['null input', { ...validUsage, input_tokens: null }],
    [
      'negative cached',
      { ...validUsage, input_tokens_details: { cached_tokens: -1, cache_write_tokens: 0 } },
    ],
    [
      'fractional cached',
      { ...validUsage, input_tokens_details: { cached_tokens: 0.5, cache_write_tokens: 0 } },
    ],
    [
      'unsafe cache write',
      {
        ...validUsage,
        input_tokens_details: { cached_tokens: 0, cache_write_tokens: Number.MAX_SAFE_INTEGER + 1 },
      },
    ],
    ['missing cache write', { ...validUsage, input_tokens_details: { cached_tokens: 0 } }],
    ['missing token details', { input_tokens: 17 }],
    ['null usage', null],
  ])('drops %s usage without losing a valid predicate', async (_description, usage) => {
    respond = (_request, response) => send(response, { ...successfulBody(), usage });
    const result = await evaluate(FEATURES, options());
    expectOutcome(result, 'SUCCEEDED', 0.42);
    expect(result.usage).toBeNull();
    expectOneRequestAndRelease();
  });

  it('retains valid response provenance and usage even for a refusal', async () => {
    respond = (_request, response) => {
      response.setHeader('x-request-id', 'req_refused');
      send(response, {
        model: 'refusal-model',
        answers: [{ type: 'refusal', name: 'needs_operator_review' }],
        usage: validUsage,
      });
    };
    const result = await evaluate(FEATURES, options());
    expectOutcome(result, 'REFUSED');
    expect(result).toMatchObject({
      responseModel: 'refusal-model',
      requestId: 'req_refused',
      usage: { inputTokens: 17, cachedTokens: 3, cacheWriteTokens: 2 },
    });
    expectOneRequestAndRelease();
  });

  it.each([
    'https://example.test/v1/decisions',
    'http://192.0.2.1/v1/decisions',
    'http://127.0.0.1.example.test/v1/decisions',
  ])('rejects nonloopback test endpoints (%s)', endpoint => {
    expect(() => createLoopbackAdapter(endpoint)).toThrow();
    expect(requests).toHaveLength(0);
  });

  it('keeps the public entry point disabled without touching any transport', async () => {
    const result = await assess(FEATURES, options({ enabled: false }));
    expect(result).toMatchObject({ status: 'DISABLED', probability: null });
    expect(tryAcquire).not.toHaveBeenCalled();
    expect(requests).toHaveLength(0);
  });
});
