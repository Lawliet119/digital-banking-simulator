import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

const backend = resolve(__dirname, '..');
const syntheticKey = 'synthetic-cli-key-do-not-echo';
const privateMarker = 'synthetic-private-id-do-not-echo';
const features = {
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

// Keep the actual CLI/parser/adapter in the child, but fail closed before any
// fetch, TCP connection or DNS lookup can leave this process, including in CI.
const offlineEntrypoint = `
  let networkAttempts = 0;
  const denyNetwork = () => {
    networkAttempts += 1;
    throw new Error('TEST_NETWORK_FORBIDDEN');
  };
  globalThis.fetch = denyNetwork;
  require('node:net').Socket.prototype.connect = denyNetwork;
  require('node:dns').lookup = denyNetwork;
  process.on('exit', () => {
    if (networkAttempts !== 0) {
      process.stderr.write('TEST_NETWORK_FORBIDDEN\\n');
      process.exitCode = 97;
    }
  });
  require('ts-node/register');
  require('tsconfig-paths/register');
  require(require('node:path').resolve(process.argv[1]));
`;

function runCli(input: string, args: string[] = [], apiKey = syntheticKey) {
  const result = spawnSync(
    process.execPath,
    ['-e', offlineEntrypoint, 'src/scripts/fraud-ai-evaluate.ts', ...args],
    {
      cwd: backend,
      encoding: 'utf8',
      input,
      timeout: 10_000,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024,
      env: {
        ...process.env,
        NODE_ENV: 'test',
        NODE_OPTIONS: '',
        TS_NODE_TRANSPILE_ONLY: 'true',
        OPENAI_API_KEY: apiKey,
      },
    },
  );

  expect(result.error).toBeUndefined();
  expect(result.signal).toBeNull();
  expect(result.stderr).toBe('');
  const output = result.stdout + result.stderr;
  expect(output).not.toContain('TEST_NETWORK_FORBIDDEN');
  expect(output).not.toContain(syntheticKey);
  expect(output).not.toContain(privateMarker);
  expect(output).not.toContain(input);
  const lines = result.stdout.trim().split('\n');
  expect(lines).toHaveLength(1);
  const assessment = JSON.parse(lines[0]) as Record<string, unknown>;

  // Output is the safe public result, not an error object, raw input, or a
  // provider payload hidden beside the status.
  expect(Object.keys(assessment).sort()).toEqual(
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
  expect(assessment.probability).toBeNull();
  expect([null, 'openai']).toContain(assessment.provider);
  for (const field of ['requestedModel', 'responseModel', 'requestId']) {
    expect(assessment[field] === null || typeof assessment[field] === 'string').toBe(true);
  }
  for (const field of ['rubricSha256', 'inputSha256']) {
    expect(
      assessment[field] === null ||
        (typeof assessment[field] === 'string' && /^[a-f0-9]{64}$/.test(assessment[field])),
    ).toBe(true);
  }
  expect(assessment.usage).toBeNull();
  return { exitCode: result.status, assessment };
}

describe('FRAUD-API-02 CLI (real TypeScript subprocess, network forbidden)', () => {
  it.each([
    ['a synthetic configured key', syntheticKey],
    ['no configured key', ''],
  ])('TC-AI-06 defaults to DISABLED with %s', (_label, apiKey) => {
    const { exitCode, assessment } = runCli(JSON.stringify(features), [], apiKey);
    expect(exitCode).toBe(0);
    expect(assessment.status).toBe('DISABLED');
  });

  it('TC-AI-06 --live without a key remains DISABLED and offline', () => {
    const { exitCode, assessment } = runCli(JSON.stringify(features), ['--live'], '');
    expect(exitCode).toBe(0);
    expect(assessment.status).toBe('DISABLED');
  });

  it.each([
    ['malformed JSON', `{"id":"${privateMarker}",`],
    ['noncanonical amount', JSON.stringify({ ...features, amount: '01' })],
    [
      'an otherwise valid feature object with an extra ID',
      JSON.stringify({ ...features, id: privateMarker }),
    ],
  ])('TC-AI-06 rejects %s without echoing input', (_label, input) => {
    const { exitCode, assessment } = runCli(input);
    expect(exitCode).toBe(2);
    expect(assessment.status).toBe('CONFIG_INVALID');
  });

  it('TC-AI-06 validates forbidden fields before --live can enable network', () => {
    const { exitCode, assessment } = runCli(JSON.stringify({ ...features, id: privateMarker }), [
      '--live',
    ]);
    expect(exitCode).toBe(2);
    expect(assessment.status).toBe('CONFIG_INVALID');
  });
});
