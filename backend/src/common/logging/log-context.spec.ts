import { Writable } from 'node:stream';
import { PinoLogger } from 'nestjs-pino';
import { createLoggingOptions } from './logging.options';
import { bindLogContext, runAsWorker, runInLogContext } from './log-context';

const A = '34b4c724-48ad-4e8c-98ce-e16a5c03b007';
const B = '0b5f4c0e-7d9a-4f7b-9d63-5d1f0a2f9c11';

let output = '';
let logger: PinoLogger;

const rows = () =>
  output
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line) as Record<string, unknown>);
const occurrences = (text: string, key: string) => text.split(`"${key}":`).length - 1;
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

beforeAll(() => {
  const stream = new Writable({
    write(chunk: Buffer, _encoding, done) {
      output += chunk.toString();
      done();
    },
  });
  // APP_ROLE=both: the case where the default role of a line with no context is `api`.
  logger = new PinoLogger({
    pinoHttp: [createLoggingOptions({ role: 'both', logLevel: 'verbose' }), stream],
  });
});
beforeEach(() => {
  output = '';
});

describe('DBS-43 shared log context (BL-024)', () => {
  describe('bindLogContext', () => {
    it('keeps a valid role and UUID', () => {
      expect(bindLogContext({ role: 'worker', correlationId: A })).toEqual({
        role: 'worker',
        correlationId: A,
      });
    });

    it('turns anything that is not a UUID into null, and never throws', () => {
      for (const bad of ['not-a-uuid', 'password=sensitive-fixture', 42, {}, undefined, ''])
        expect(
          bindLogContext({ role: 'api', correlationId: bad as never }).correlationId,
        ).toBeNull();
    });

    it('falls back to api for an unknown role', () => {
      expect(bindLogContext({ role: 'teller' as never, correlationId: A }).role).toBe('api');
    });
  });

  describe('runInLogContext', () => {
    it('binds role and correlationId exactly once on every line of the run', async () => {
      await runInLogContext(
        async () => {
          await tick();
          logger.logger.info('First step');
          logger.warn('Second step');
        },
        { role: 'worker', correlationId: A },
      );
      expect(rows()).toHaveLength(2);
      for (const row of rows()) expect(row).toMatchObject({ role: 'worker', correlationId: A });
      expect(occurrences(output, 'correlationId')).toBe(2);
      expect(occurrences(output, 'role')).toBe(2);
    });

    it('does not mix the ids of parallel runs', async () => {
      const run = async (id: string, steps: number) => {
        await runInLogContext(
          async () => {
            for (let step = 0; step < steps; step++) {
              await tick();
              logger.logger.info({ run: id }, 'Step done');
            }
          },
          { role: 'api', correlationId: id },
        );
      };
      await Promise.all([run(A, 5), run(B, 3)]);
      const logged = rows();
      expect(logged).toHaveLength(8);
      for (const row of logged) expect(row.correlationId).toBe(row.run);
    });

    it('ignores a later attempt to bind another correlationId or role', () => {
      runInLogContext(
        () => {
          logger.assign({ correlationId: B, role: 'worker' });
          logger.logger.child({ correlationId: B }).child({ role: 'worker' }).info('Fixed message');
          logger.logger.info('Fixed message');
        },
        { role: 'api', correlationId: A },
      );
      expect(rows()).toHaveLength(2);
      for (const row of rows()) expect(row).toMatchObject({ role: 'api', correlationId: A });
      expect(occurrences(output, 'correlationId')).toBe(2);
      expect(occurrences(output, 'role')).toBe(2);
    });

    it('does not let code outside the helper smuggle a sensitive binding into every line', () => {
      runInLogContext(
        () => {
          logger.assign({
            authorization: 'Bearer sensitive-token-fixture',
            password: 'sensitive-password-fixture',
            note: 'password=sensitive-inline-fixture',
            batch: 7,
          });
          logger.logger.info('Fixed message');
        },
        { role: 'worker', correlationId: A },
      );
      expect(output).not.toContain('sensitive-');
      expect(rows()[0]).toMatchObject({
        authorization: '[Redacted]',
        password: '[Redacted]',
        batch: 7,
      });
    });

    it('replaces an invalid correlationId bound by other code by a marker instead of writing it', () => {
      logger.logger
        .child({ correlationId: 'forged-by-someone', role: 'teller' })
        .info('Fixed message');
      expect(rows()[0]).toMatchObject({ role: 'api', correlationId: '[Invalid]' });
      expect(output).not.toContain('forged-by-someone');
      expect(occurrences(output, 'correlationId')).toBe(1);
    });

    it('starts from the root, so a run started inside a request does not inherit its id', () => {
      runInLogContext(
        () => {
          runInLogContext(() => logger.logger.info('Detached job'), {
            role: 'worker',
            correlationId: null,
          });
        },
        { role: 'api', correlationId: A },
      );
      expect(rows()[0]).toMatchObject({ role: 'worker', correlationId: null });
    });

    it('runs the callback without a context, and still returns its value, when there is no logger', () => {
      const root = (PinoLogger as { root?: unknown }).root;
      Object.defineProperty(PinoLogger, 'root', { value: undefined, configurable: true });
      try {
        expect(runInLogContext(() => 'done', { role: 'worker', correlationId: A })).toBe('done');
      } finally {
        Object.defineProperty(PinoLogger, 'root', { value: root, configurable: true });
      }
    });
  });

  describe('runAsWorker', () => {
    it('gives a background task role=worker and no correlationId under APP_ROLE=both', async () => {
      logger.logger.info('Outside any task');
      await runAsWorker(async () => {
        await tick();
        logger.logger.info('Background tick');
      });
      const [outside, inside] = rows();
      expect(outside).toMatchObject({ appRole: 'both', role: 'api' });
      expect(inside).toMatchObject({ appRole: 'both', role: 'worker', correlationId: null });
    });
  });
});
