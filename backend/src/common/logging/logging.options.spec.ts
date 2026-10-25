import { Writable } from 'node:stream';
import pino from 'pino';
import { createLoggingOptions, safeErrorMetadata } from './logging.options';

function capture(role: 'api' | 'worker' | 'both' = 'api', logLevel = 'verbose') {
  let output = '';
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  const logger = pino(createLoggingOptions({ role, logLevel }), stream);
  return {
    logger,
    text: () => output,
    rows: () =>
      output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>),
  };
}

describe('DBS-42 JSON logging options', () => {
  it.each([
    ['api', 'api'],
    ['worker', 'worker'],
    ['both', 'api'],
  ] as const)('TC-42-01 emits the required JSON fields for %s', (role, expected) => {
    const log = capture(role);
    log.logger.info('Application started');
    expect(log.rows()).toHaveLength(1);
    expect(log.rows()[0]).toMatchObject({
      level: 30,
      message: 'Application started',
      role: expected,
      appRole: role,
      correlationId: null,
    });
    expect(log.rows()[0].time).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
  });

  it.each([
    ['fatal', [60]],
    ['error', [50, 60]],
    ['warn', [40, 50, 60]],
    ['log', [30, 40, 50, 60]],
    ['debug', [20, 30, 40, 50, 60]],
    ['verbose', [10, 20, 30, 40, 50, 60]],
    ['invalid', [30, 40, 50, 60]],
  ])('TC-42-02 respects LOG_LEVEL=%s', (level, expected) => {
    const log = capture('api', level);
    for (const method of ['trace', 'debug', 'info', 'warn', 'error', 'fatal'] as const) {
      log.logger[method]('Fixed diagnostic');
    }
    expect(log.rows().map(row => row.level)).toEqual(expected);
  });

  it('TC-42-03 redacts nested secrets, arrays and bodies, preserving safe metadata', () => {
    const log = capture();
    log.logger.info(
      {
        authorization: 'Bearer sensitive-auth-fixture',
        profile: {
          Password: 'sensitive-password-fixture',
          access_token: 'sensitive-token-fixture',
        },
        items: [{ refreshToken: 'sensitive-refresh-fixture', accountNumber: '9876543210987654' }],
        req: {
          body: { account: 'sensitive-body-fixture' },
          headers: { cookie: 'sensitive-cookie-fixture' },
        },
        attempt: 2,
      },
      'Operation completed',
    );
    for (const secret of ['sensitive-', '9876543210987654'])
      expect(log.text()).not.toContain(secret);
    expect(log.rows()[0].attempt).toBe(2);
    expect(log.rows()[0].message).toBe('Operation completed');
  });

  describe('TC-42-03 key redaction and string scanning', () => {
    const SECRET_KEYS = [
      'accountNo',
      'accountNum',
      'toAccountNo',
      'cardNo',
      'cardNum',
      'pan',
      'cardPan',
      'card_pan',
      'panNumber',
      'apiKey',
      'api_key',
      'privateKey',
      'credentials',
      'pwd',
      'jwt',
      'passphrase',
      'connectionString',
      'databaseUrl',
      'securityCode',
      'cardSecurityCode',
      'otp',
      'smsOtp',
      'otpCode',
      'otp_value',
      'totp',
      'totpCode',
      'mfaCode',
      'smsCode',
      'verificationCode',
      'pin',
      'newPin',
      'pinCode',
      'cardPin',
      'cvc',
      'cvc2',
      'sid',
      'sessionId',
      'pass',
      'dsn',
      'signature',
    ];

    it.each(SECRET_KEYS)('redacts the key %s', key => {
      const log = capture();
      log.logger.info({ [key]: 'sensitive-key-fixture', attempt: 1 }, 'Fixed message');
      expect(log.text()).not.toContain('sensitive-');
      expect(log.rows()[0].attempt).toBe(1);
    });

    it('omits headers and rawHeaders entirely', () => {
      const log = capture();
      log.logger.info(
        {
          headers: { 'x-api-key': 'sensitive-header' },
          rawHeaders: ['Authorization', 'sensitive-raw'],
        },
        'Fixed message',
      );
      expect(log.text()).not.toContain('sensitive-');
    });

    it('keeps near-miss keys that only contain a short secret word', () => {
      const log = capture();
      const safe = {
        footprint: 'safe-1',
        panel: 'safe-2',
        span: 'safe-3',
        snapshotPolicy: 'safe-4',
        notPaid: 'safe-5',
        cardNotPresent: 'safe-6',
        accountNotFound: 'safe-7',
        status: 'safe-8',
      };
      log.logger.info(safe, 'Fixed message');
      expect(log.rows()[0]).toMatchObject(safe);
    });

    it('scans every string value, not only message', () => {
      const log = capture();
      log.logger.info(
        {
          a: 'postgres://u:sensitive-uri@h/db',
          b: 'Bearer sensitive-bearer',
          c: 'Basic c2Vuc2l0aXZlLWJhc2ljOnB3',
          d: '{"password":"sensitive-json"}',
          e: 'eyJhbGciOiJIUzI1.eyJzdWIiOiJzZW5zaXRpdmU.sensitive_signature',
          nested: [{ f: 'password=sensitive-kv' }],
        },
        'Fixed message',
      );
      expect(log.text()).not.toContain('sensitive');
      expect(log.text()).not.toContain('c2Vuc2l0aXZl');
    });

    it('leaves ordinary identifiers and codes untouched', () => {
      const log = capture();
      const ordinary = {
        id: '12345678-1234-4234-8234-123456789012',
        at: '2026-10-25T10:24:44.824Z',
        sqlstate: '40P01',
        errorCode: 'SERVICE_TEMPORARILY_UNAVAILABLE',
      };
      log.logger.info(ordinary, 'Fixed message');
      expect(log.rows()[0]).toMatchObject(ordinary);
    });

    it('does not scan a very long string, so it cannot stall the event loop', () => {
      const log = capture();
      const started = Date.now();
      log.logger.info({ big: 'eyJ'.repeat(20_000), edge: 'a'.repeat(4096) }, 'Fixed message');
      expect(Date.now() - started).toBeLessThan(50);
      expect(log.rows()[0].big).toBe('[Omitted]');
      expect(log.rows()[0].edge).toBe('a'.repeat(4096));
    });
  });

  it('TC-42-04 never serializes raw Error messages, stacks, causes, SQL or parameters', () => {
    const log = capture();
    const error = Object.assign(new Error('postgres://u:sensitive-uri-fixture@host/db'), {
      code: '40P01',
      query: 'sensitive-sql-fixture',
      parameters: ['sensitive-param-fixture'],
      cause: new Error('sensitive-cause-fixture'),
    });
    log.logger.error({ err: error, nested: { failure: error } }, 'Operation failed');
    expect(log.text()).not.toContain('sensitive-');
    expect(log.rows()[0].err).toEqual({ errorType: 'Error', code: '40P01' });
    expect(safeErrorMetadata({ code: 'untrusted-arbitrary-code' })).toEqual({
      errorType: 'NonError',
    });
  });

  it('TC-42-03 sanitizes interpolation arguments before rendering diagnostic messages', () => {
    const log = capture();
    log.logger.info('Diagnostic %j', { password: 'sensitive-format-fixture' });
    log.logger.info({ attempt: 1 }, 'Diagnostic %s', 'Bearer sensitive-format-bearer');
    log.logger.info('Account %s', '9876543210987654');
    expect(log.text()).not.toContain('sensitive-');
    expect(log.text()).not.toContain('9876543210987654');
    expect(log.rows()[1].attempt).toBe(1);
  });

  it('TC-42-04 projects plain serialized errors to safe technical fields', () => {
    const log = capture();
    log.logger.error(
      {
        err: { message: 'postgres://u:sensitive-plain-error@host/db', code: '40P01' },
        nested: [
          { failure: { message: 'sensitive-nested-error', stack: 'sensitive-stack-fixture' } },
        ],
      },
      'Operation failed',
    );
    expect(log.text()).not.toContain('sensitive-');
    expect(log.rows()[0].err).toEqual({ errorType: 'NonError', code: '40P01' });
  });

  it('TC-42-01 keeps the mandatory envelope for a top-level serialized error', () => {
    const log = capture('worker');
    log.logger.error({ message: 'sensitive-serialized-error', code: '40P01' }, 'Operation failed');
    expect(log.rows()[0]).toMatchObject({
      role: 'worker',
      correlationId: null,
      level: 50,
      message: 'Operation failed',
      err: { errorType: 'NonError', code: '40P01' },
    });
    expect(log.text()).not.toContain('sensitive-');
  });

  it('TC-42-03 removes callable serialization hooks from nested objects and arrays', () => {
    const log = capture();
    const hostile = {
      toJSON() {
        return { password: 'sensitive-tojson-fixture' };
      },
    };
    log.logger.info({ metadata: hostile, items: [hostile] }, 'Fixed message');
    expect(log.text()).not.toContain('sensitive-');
    expect(log.rows()[0].message).toBe('Fixed message');
  });

  describe('TC-42-04 safeErrorMetadata', () => {
    it('never throws on a revoked Proxy or a throwing getter', () => {
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      const throwingCode = {
        get code(): string {
          throw new Error('sensitive-getter-fixture');
        },
      };
      const throwingDriver = {
        get driverError(): never {
          throw new Error('sensitive-getter-fixture');
        },
      };
      for (const hostile of [revoked.proxy, throwingCode, throwingDriver])
        expect(safeErrorMetadata(hostile)).toEqual({ errorType: 'NonError' });
    });

    it('keeps any 5-character SQLSTATE found on driverError', () => {
      expect(safeErrorMetadata({ driverError: { code: '22P02' } })).toEqual({
        errorType: 'NonError',
        code: '22P02',
      });
      expect(safeErrorMetadata({ driverError: { code: '25P02' } }).code).toBe('25P02');
      expect(safeErrorMetadata({ driverError: { code: 'sensitive-code-fixture' } })).toEqual({
        errorType: 'NonError',
      });
      expect(safeErrorMetadata({ driverError: { code: 'ab12c' } })).toEqual({
        errorType: 'NonError',
      });
    });

    it('keeps a bare code only for the allowlisted classes and network codes', () => {
      for (const code of ['28P01', '3D000', '25P03', '40P01', '23505', 'ECONNREFUSED'])
        expect(safeErrorMetadata({ code }).code).toBe(code);
      for (const code of ['22P02', 'AB12C', 'untrusted-arbitrary-code'])
        expect(safeErrorMetadata({ code })).toEqual({ errorType: 'NonError' });
    });

    it('finds the code on error, driverError or cause in the order pg-error.util uses', () => {
      expect(safeErrorMetadata({ cause: { code: '40P01' } }).code).toBe('40P01');
      expect(safeErrorMetadata({ cause: { driverError: { code: '23505' } } }).code).toBe('23505');
      expect(safeErrorMetadata({ code: '40001', cause: { code: '40P01' } }).code).toBe('40001');
    });
  });

  it('TC-42-01 preserves request bindings without replacing them by null', () => {
    const log = capture('both');
    log.logger
      .child({ role: 'worker', correlationId: '34b4c724-48ad-4e8c-98ce-e16a5c03b007' })
      .info('Message handled');
    expect(log.rows()[0]).toMatchObject({
      role: 'worker',
      correlationId: '34b4c724-48ad-4e8c-98ce-e16a5c03b007',
    });
  });
});
