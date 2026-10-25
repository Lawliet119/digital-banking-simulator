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
          g: 'PGPASSWORD=sensitive-pg',
          h: 'db_password=sensitive-db',
          i: 'client_secret=sensitive-cs',
          j: '{"access_token":"sensitive-at"}',
          k: 'refreshToken: sensitive-rt',
          l: 'apiKey=sensitive-ak',
          m: 'Authorization: Token sensitive-tk',
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
      log.logger.info({ big: 'eyJ'.repeat(20_000), edge: 'a'.repeat(4096) }, 'Fixed message');
      expect(log.rows()[0].big).toBe('[Omitted]');
      expect(log.rows()[0].edge).toBe('a'.repeat(4096));
    });

    it('bounds the total scan work of one call, not only each string', () => {
      const log = capture();
      const hostile = 'eyJ-'.repeat(1024); // 4096 characters, worst case for a JWT pattern
      const started = Date.now();
      log.logger.info({ list: Array.from({ length: 200 }, () => hostile) }, 'Fixed message');
      const list = log.rows()[0].list as string[];
      expect(list).toHaveLength(200);
      expect(list.filter(value => value === '[Omitted]').length).toBeGreaterThan(150);
      expect(Date.now() - started).toBeLessThan(250);
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

    it('prefers the error own code like pg-error.util, and trusts a copied driver code', () => {
      expect(safeErrorMetadata({ code: 'ERR_WRAPPED', driverError: { code: '40P01' } })).toEqual({
        errorType: 'NonError',
      });
      expect(safeErrorMetadata({ code: '22P02', driverError: { code: '22P02' } }).code).toBe(
        '22P02',
      );
    });

    it('keeps a driver SQLSTATE when pino logs the error itself, not only through Nest', () => {
      const log = capture();
      log.logger.error(Object.assign(new Error('sensitive-x'), { driverError: { code: '22P02' } }));
      expect(log.rows()[0].err).toEqual({ errorType: 'Error', code: '22P02' });
      expect(log.text()).not.toContain('sensitive-');
    });

    it('finds the code on error, driverError or cause in the order pg-error.util uses', () => {
      expect(safeErrorMetadata({ cause: { code: '40P01' } }).code).toBe('40P01');
      expect(safeErrorMetadata({ cause: { driverError: { code: '23505' } } }).code).toBe('23505');
      expect(safeErrorMetadata({ code: '40001', cause: { code: '40P01' } }).code).toBe('40001');
    });
  });

  describe('TC-42-14 envelope, message and hostile values', () => {
    const ID = '34b4c724-48ad-4e8c-98ce-e16a5c03b007';
    const occurrences = (text: string, key: string) => text.split(`"${key}":`).length - 1;

    it('writes each envelope key once even when the caller sends them, valid UUID included', () => {
      const log = capture('api');
      log.logger.info(
        { role: 'worker', correlationId: ID, level: 99, time: 'x', appRole: 'z', msg: 'y' },
        'Fixed message',
      );
      for (const key of ['level', 'time', 'message', 'appRole', 'role', 'correlationId'])
        expect(occurrences(log.text(), key)).toBe(1);
      expect(log.rows()[0]).toMatchObject({
        level: 30,
        appRole: 'api',
        role: 'api',
        correlationId: null,
        message: 'Fixed message',
      });
    });

    it('lets a bound role and correlationId win and drops the caller copy', () => {
      const log = capture('both');
      log.logger
        .child({ role: 'api', correlationId: ID })
        .info({ role: 'worker', correlationId: 'forged' }, 'Fixed message');
      expect(occurrences(log.text(), 'role')).toBe(1);
      expect(occurrences(log.text(), 'correlationId')).toBe(1);
      expect(log.rows()[0]).toMatchObject({ role: 'api', correlationId: ID });
    });

    it('does not mutate the caller object', () => {
      const log = capture();
      const domain = { role: 'teller', message: 'domain text', attempt: 1 };
      log.logger.info(domain, 'Fixed message');
      expect(domain).toEqual({ role: 'teller', message: 'domain text', attempt: 1 });
      expect(log.rows()[0].attempt).toBe(1);
    });

    it('always writes message as a string', () => {
      const log = capture();
      log.logger.info(42 as never);
      log.logger.info(true as never);
      log.logger.info({ message: { nested: 'sensitive-message-fixture' } }, 'Fixed message');
      expect(log.text()).not.toContain('sensitive-');
      for (const row of log.rows()) expect(typeof row.message).toBe('string');
      expect(log.rows()[2].message).toBe('Fixed message');
      expect(occurrences(log.text().split('\n')[2], 'message')).toBe(1);
    });

    it('drops arguments that fill no placeholder instead of appending them', () => {
      const log = capture();
      const loose = log.logger as unknown as { info: (...args: unknown[]) => void };
      loose.info('Paid %s', 'invoice', 'sensitive-extra-fixture');
      expect(log.rows()[0].message).toBe('Paid invoice');
      expect(log.text()).not.toContain('sensitive-');
    });

    it('survives a throwing getter or revoked Proxy nested in a value', () => {
      const log = capture();
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      const nasty = {
        fine: 1,
        get bad(): never {
          throw new Error('sensitive-getter-fixture');
        },
      };
      expect(() =>
        log.logger.info({ attempt: 1, meta: nasty, list: [nasty, revoked.proxy, 2] }, 'Fixed'),
      ).not.toThrow();
      const row = log.rows()[0];
      expect(row).toMatchObject({ attempt: 1, role: 'api', correlationId: null, message: 'Fixed' });
      expect(row.meta).toMatchObject({ fine: 1, bad: '[Omitted]' });
      expect((row.list as unknown[])[2]).toBe(2);
      expect(log.text()).not.toContain('sensitive-');
    });

    it('keeps the healthy fields next to a top-level throwing getter', () => {
      const log = capture();
      const topLevel = {
        ok: 1,
        get bad(): never {
          throw new Error('sensitive-top-level-fixture');
        },
      };
      expect(() => log.logger.info(topLevel, 'Fixed message')).not.toThrow();
      expect(log.rows()[0]).toMatchObject({ ok: 1, bad: '[Omitted]', role: 'api' });
      expect(log.text()).not.toContain('sensitive-');
    });

    it('falls back to a fixed line when the hook itself fails, and never throws', () => {
      const log = capture();
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      expect(() => log.logger.info(revoked.proxy, 'Fixed message')).not.toThrow();
      expect(log.rows()[0]).toMatchObject({
        level: 30,
        role: 'api',
        correlationId: null,
        message: 'Log call failed',
      });
    });

    it('does not throw when even the fallback write fails', () => {
      const failing = {
        write(): never {
          throw new Error('sensitive-stream-fixture');
        },
      };
      const logger = pino(createLoggingOptions({ role: 'api', logLevel: 'verbose' }), failing);
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      expect(() => logger.info('Fixed message')).not.toThrow();
      expect(() => logger.info(revoked.proxy, 'Fixed message')).not.toThrow();
    });

    it('keeps the date, buffer and shared-object cases readable', () => {
      const log = capture();
      const shared = { x: 1 };
      log.logger.info(
        { d: new Date('2026-10-25T10:00:00.000Z'), buf: Buffer.from('ab'), s1: shared, s2: shared },
        'Fixed message',
      );
      const row = log.rows()[0];
      expect(row.d).toBe('2026-10-25T10:00:00.000Z');
      expect(row.buf).toBeUndefined();
      expect(row.s2).toEqual({ x: 1 });
    });

    it('does not hang on a cyclic object and keeps a short number in the message', () => {
      const log = capture();
      const cyclic: Record<string, unknown> = { id: 1 };
      cyclic.self = cyclic;
      log.logger.info(cyclic, 'Fixed message');
      const loose = log.logger as unknown as { info: (...args: unknown[]) => void };
      loose.info('Count %s', '1234567');
      expect(log.rows()[0]).toMatchObject({ id: 1, self: { id: 1, self: '[Omitted]' } });
      expect(log.rows()[1].message).toBe('Count 1234567');
    });

    it('records, as the DBS-43 baseline, that bindings made by other code are not cleaned', () => {
      const log = capture();
      const child = log.logger.child({ correlationId: ID });
      child.child({ correlationId: 'second' }).info('Fixed message');
      // Pino resets its bindings formatter for every child, so DBS-42 cannot filter these.
      expect(occurrences(log.text(), 'correlationId')).toBe(2);
    });

    it('regression: a serialized error shape is still reduced to safe fields', () => {
      const log = capture();
      log.logger.error({ name: 'Err', message: 'sensitive-shape-fixture' }, 'Operation failed');
      log.logger.error({ err: 'postgres://u:sensitive-uri-fixture@h/db' }, 'Operation failed');
      log.logger.info('Number %s', '9876543210987654');
      expect(log.text()).not.toContain('sensitive-');
      expect(log.text()).not.toContain('9876543210987654');
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
