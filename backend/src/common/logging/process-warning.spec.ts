import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import pino from 'pino';
import { createLoggingOptions } from './logging.options';
import { installProcessWarningLogger } from './process-warning';

/** BL-026: `process.emitWarning` goes through the JSON logger, with name and code, not the text. */
describe('BL-026 process warnings as JSON', () => {
  let output = '';
  const rows = () =>
    output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map(line => JSON.parse(line) as Record<string, unknown>);
  let proc: EventEmitter;

  beforeEach(() => {
    output = '';
    const stream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        output += chunk.toString();
        done();
      },
    });
    const logger = pino(createLoggingOptions({ role: 'worker', logLevel: 'verbose' }), stream);
    proc = new EventEmitter();
    // Stands for Node's own text printer, which is a listener of the same event.
    proc.on('warning', () => {
      output += 'TEXT ON STDERR\n';
    });
    installProcessWarningLogger(logger, proc);
  });

  it('replaces the default text printer by one JSON line with name and code', () => {
    proc.emit(
      'warning',
      Object.assign(new Error('sensitive-text-fixture'), {
        name: 'DeprecationWarning',
        code: 'DEP0040',
      }),
    );
    expect(output).not.toContain('TEXT ON STDERR');
    expect(rows()).toHaveLength(1);
    expect(rows()[0]).toMatchObject({
      level: 40,
      role: 'worker',
      correlationId: null,
      message: 'Process warning',
      warningName: 'DeprecationWarning',
      warningCode: 'DEP0040',
    });
    expect(output).not.toContain('sensitive-');
  });

  it('writes the fixed SSL mode warning of pg-connection-string, not what follows it', () => {
    proc.emit(
      'warning',
      new Error(
        "SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.\nIn the next major version ... uselibpqcompat=true&sslmode=require\n\nSee https://example.test/x?password=sensitive-pw-fixture",
      ),
    );
    expect(rows()[0]).toMatchObject({
      message:
        "SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'.",
    });
    expect(output).not.toContain('sensitive-');
    expect(output).not.toContain('example.test');
  });

  it.each([
    ['a hostile name', { name: 'postgres://u:sensitive-name-fixture@h/db' }],
    ['a hostile code', { code: 'password=sensitive-code-fixture' }],
    ['a non-error value', 'sensitive-string-fixture'],
    ['null', null],
  ])('keeps %s out of the line and does not throw', (_label, shape) => {
    const warning =
      shape !== null && typeof shape === 'object' ? Object.assign(new Error('x'), shape) : shape;
    expect(() => proc.emit('warning', warning)).not.toThrow();
    expect(rows()).toHaveLength(1);
    expect(output).not.toContain('sensitive-');
    expect(rows()[0].message).toBe('Process warning');
  });

  it('survives a warning whose properties throw', () => {
    const hostile = new Proxy(new Error('x'), {
      get() {
        throw new Error('sensitive-getter-fixture');
      },
    });
    expect(() => proc.emit('warning', hostile)).not.toThrow();
    expect(output).not.toContain('sensitive-');
  });

  it('keeps a single JSON listener when installed twice', () => {
    installProcessWarningLogger(pino({ level: 'silent' }), proc);
    expect(proc.listenerCount('warning')).toBe(1);
  });
});
