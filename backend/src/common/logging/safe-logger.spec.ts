import { Logger as NestLogger, type LoggerService } from '@nestjs/common';
import { Writable } from 'node:stream';
import { Logger, PinoLogger } from 'nestjs-pino';
import { createLoggingOptions } from './logging.options';
import { SafeLogger } from './safe-logger';

const LEVELS = ['log', 'error', 'warn', 'debug', 'verbose', 'fatal'] as const;

describe('SafeLogger', () => {
  it.each(LEVELS)('TC-42-14 passes %s calls, with their context, to the inner logger', level => {
    const inner = { [level]: jest.fn() } as unknown as LoggerService;
    new SafeLogger(inner)[level]?.('Fixed message', 'Ctx');
    expect((inner as unknown as Record<string, jest.Mock>)[level]).toHaveBeenCalledWith(
      'Fixed message',
      'Ctx',
    );
  });

  it('TC-42-14 writes a fixed line at the same level when the inner call throws', () => {
    const warn = jest
      .fn()
      .mockImplementationOnce(() => {
        throw new Error('sensitive-inner-fixture');
      })
      .mockImplementation(() => undefined);
    const logger = new SafeLogger({ log: jest.fn(), error: jest.fn(), warn });
    expect(() => logger.warn({ any: 'thing' }, 'Ctx')).not.toThrow();
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenLastCalledWith('Log call failed');
  });

  it('TC-42-14 does not throw when the fixed line cannot be written either', () => {
    const broken = () => {
      throw new Error('sensitive-inner-fixture');
    };
    const logger = new SafeLogger({ log: broken, error: broken, warn: broken });
    expect(() => logger.error('Fixed message')).not.toThrow();
    expect(() => logger.log('Fixed message')).not.toThrow();
  });

  describe('through the Nest static Logger and nestjs-pino', () => {
    let output = '';
    let safe: SafeLogger;
    const rows = () =>
      output
        .trim()
        .split('\n')
        .filter(Boolean)
        .map(line => JSON.parse(line) as Record<string, unknown>);

    beforeAll(() => {
      const stream = new Writable({
        write(chunk: Buffer, _encoding, done) {
          output += chunk.toString();
          done();
        },
      });
      const pino = new Logger(
        new PinoLogger({
          pinoHttp: [createLoggingOptions({ role: 'api', logLevel: 'warn' }), stream],
        }),
        {},
      );
      safe = new SafeLogger(pino);
      NestLogger.overrideLogger(safe);
    });
    beforeEach(() => {
      output = '';
    });
    afterAll(() => {
      NestLogger.overrideLogger(false);
    });

    const hostile = () => {
      const revoked = Proxy.revocable({}, {});
      revoked.revoke();
      return revoked.proxy;
    };
    const throwingGetter = () => ({
      get bad(): never {
        throw new Error('sensitive-getter-fixture');
      },
    });

    it('TC-42-14 turns a top-level hostile object into a fixed line with the envelope', () => {
      const log = new NestLogger('Ctx');
      for (const value of [hostile(), throwingGetter()])
        expect(() => log.error(value, 'sensitive-message-fixture')).not.toThrow();
      const logged = rows();
      expect(logged.length).toBeGreaterThan(0);
      for (const row of logged)
        expect(row).toMatchObject({
          level: 50,
          role: 'api',
          correlationId: null,
          message: expect.any(String),
        });
      expect(output).not.toContain('sensitive-');
      expect(logged.some(row => row.message === 'Log call failed')).toBe(true);
    });

    it('TC-42-14 writes nothing when the failed call was below the configured level', () => {
      const log = new NestLogger('Ctx');
      expect(() => log.log(hostile())).not.toThrow();
      expect(() => log.debug(hostile())).not.toThrow();
      expect(output).toBe('');
    });
  });
});
