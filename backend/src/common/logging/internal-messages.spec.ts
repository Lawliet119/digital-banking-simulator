import { Logger as NestLogger } from '@nestjs/common';
import { Writable } from 'node:stream';
import { Logger, PinoLogger } from 'nestjs-pino';
import { createLoggingOptions } from './logging.options';
import { SafeLogger } from './safe-logger';

/**
 * BL-026: Nest and TypeORM report their own failures through the static `Logger` with the error
 * text in the message. The text can carry SQL or a credential, so by default only the context and
 * the error type survive (`Diagnostic event`). A fixed message, matched against an allowlist bound
 * to its `context`, is the one exception and is logged word for word.
 */
describe('BL-026 allowlist of fixed internal messages', () => {
  let output = '';
  const rows = () =>
    output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
  const stack = 'Error: x\n    at Object.<anonymous> (file.js:1:1)';

  beforeAll(() => {
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        output += chunk.toString();
        done();
      },
    });
    const pino = new Logger(
      new PinoLogger({
        pinoHttp: [createLoggingOptions({ role: 'api', logLevel: 'verbose' }), stream],
      }),
      {},
    );
    NestLogger.overrideLogger(new SafeLogger(pino));
  });
  afterAll(() => {
    NestLogger.overrideLogger(false);
  });
  beforeEach(() => {
    output = '';
  });

  it('logs the TypeORM connection retry verbatim, with its context', () => {
    new NestLogger('TypeOrmModule').error(
      'Unable to connect to the database. Retrying (2)...',
      stack,
    );
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      level: 50,
      context: 'TypeOrmModule',
      message: 'Unable to connect to the database. Retrying (2)...',
      err: { errorType: 'Error' },
    });
    expect(output).not.toContain('file.js');
  });

  it('logs the first sentence of a Nest dependency error and nothing after it', () => {
    const error = new Error(
      "Nest can't resolve dependencies of the AccountsService (?). Please make sure that the argument PinoLogger at index [0] is available in the AccountsModule module.\n\nPotential solutions:\n- postgres://u:sensitive-uri-fixture@h/db",
    );
    new NestLogger('ExceptionHandler').error(error);
    expect(rows()[0]).toMatchObject({
      context: 'ExceptionHandler',
      message:
        "Nest can't resolve dependencies of the AccountsService (?). Please make sure that the argument PinoLogger at index [0] is available in the AccountsModule module.",
    });
    expect(output).not.toContain('sensitive-');
  });

  it.each([
    [
      'a connection message that adds the driver text (verboseRetryLog)',
      'TypeOrmModule',
      'Unable to connect to the database. Message: password authentication failed for user "banking" password=sensitive-pw-fixture. Retrying (1)...',
    ],
    [
      'a retry message with a datasource name',
      'TypeOrmModule',
      'Unable to connect to the database (sensitive-name-fixture). Retrying (1)...',
    ],
    [
      'SQL text',
      'ExceptionHandler',
      "select * from customers where full_name = 'sensitive-name-fixture'",
    ],
    [
      'a driver error with a URI',
      'ExceptionHandler',
      'connect ECONNREFUSED postgres://u:sensitive-uri-fixture@127.0.0.1:5432/banking',
    ],
    [
      'a dependency error that smuggles text in an identifier slot',
      'ExceptionHandler',
      "Nest can't resolve dependencies of the X (password=sensitive-pw-fixture). Please make sure",
    ],
    [
      'an allowlisted message under another context',
      'AccountsService',
      'Unable to connect to the database. Retrying (1)...',
    ],
    [
      'a prefix with no boundary',
      'TypeOrmModule',
      'Unable to connect to the database. Retrying (1)... sensitive-tail-fixture',
    ],
  ])('keeps %s out of the line', (_label, context, text) => {
    const log = new NestLogger(context);
    if (context === 'ExceptionHandler') log.error(new Error(text));
    else log.error(text, stack);
    expect(rows()).toHaveLength(1);
    expect(output).not.toContain('sensitive-');
    expect(output).not.toContain('banking');
    expect(output).not.toMatch(/select \*|ECONNREFUSED postgres/i);
    expect(rows()[0]).toMatchObject({ context, err: { errorType: 'Error' } });
    expect(rows()[0].message).toBe('Diagnostic event');
  });

  it('an explicit message from the caller is never replaced by the allowlist', () => {
    new NestLogger('TypeOrmModule').error(
      { err: new Error('Unable to connect to the database. Retrying (1)...') },
      'Fixed message',
    );
    expect(rows()[0].message).toBe('Fixed message');
  });
});
