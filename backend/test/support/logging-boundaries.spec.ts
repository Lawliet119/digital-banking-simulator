import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import type { Linter } from 'eslint';

/**
 * BL-024 (3): code outside `common/logging` logs through Nest's `Logger` (which goes through
 * `SafeLogger`), never through `PinoLogger` or `req.log`, which only get the protection inside the
 * pino hook. ESLint loads the real ESM config outside Jest's VM, as in outbox-boundaries.spec.ts.
 */
describe('BL-024 logging boundaries in ESLint', () => {
  function lint(file: string, source: string): Linter.LintMessage[] {
    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { ESLint, Linter } from 'eslint';
         const eslint = new ESLint();
         const config = await eslint.calculateConfigForFile(process.argv[1]);
         const messages = new Linter().verify(process.argv[2], {
           languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
           rules: { 'no-restricted-syntax': config.rules['no-restricted-syntax'] },
         });
         process.stdout.write(JSON.stringify(messages));`,
        file,
        source,
      ],
      { cwd: resolve(__dirname, '../..'), encoding: 'utf8' },
    );
    return JSON.parse(result) as Linter.LintMessage[];
  }

  const business = 'src/modules/accounts/accounts.service.ts';
  const direct: [string, string][] = [
    ['PinoLogger import', "import { PinoLogger } from 'nestjs-pino';"],
    ['InjectPinoLogger import', "import { InjectPinoLogger } from 'nestjs-pino';"],
    ['aliased PinoLogger import', "import { PinoLogger as Pino } from 'nestjs-pino';"],
    ['req.log call', 'req.log.info({ id }, "Fixed message");'],
    ['request.log call', 'request.log.warn("Fixed message");'],
    ['res.log call', 'res.log.error("Fixed message");'],
    ['this.req.log call', 'this.req.log.info("Fixed message");'],
  ];

  it.each(direct)('rejects a %s in business code', (_name, source) => {
    const messages = lint(business, source);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      ruleId: 'no-restricted-syntax',
      severity: 2,
      message: expect.stringMatching(/SafeLogger|@nestjs\/common/),
    });
  });

  it('keeps the ledger money rule next to the logging rule', () => {
    const messages = lint(
      'src/modules/ledger/transfer.service.ts',
      "import { PinoLogger } from 'nestjs-pino'; const a = Number(x);",
    );
    expect(messages.map(message => message.message)).toEqual([
      expect.stringMatching(/SafeLogger/),
      expect.stringMatching(/@common\/money/),
    ]);
  });

  it.each([
    "import { Logger } from '@nestjs/common'; new Logger('X').log('Fixed message');",
    "import { LoggerModule } from 'nestjs-pino';",
    "import { runAsWorker } from '@common/logging/log-context';",
    "import { Logger as PinoNestLogger } from 'nestjs-pino';",
  ])('accepts %s', source => {
    expect(lint(business, source)).toEqual([]);
  });

  it.each([
    'src/common/logging/http-logging.ts',
    'src/common/logging/log-context.spec.ts',
    'src/modules/outbox/outbox.module.spec.ts',
  ])('lets %s use PinoLogger', file => {
    expect(lint(file, "import { PinoLogger } from 'nestjs-pino';")).toEqual([]);
  });

  it('still rejects ioredis in the files that may use PinoLogger', () => {
    const messages = lint('src/common/logging/http-logging.ts', "import Redis from 'ioredis';");
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatch(/@libs\/redis/);
  });

  it.each([
    'src/common/messaging/consumer-base.ts',
    'src/common/metrics/metrics.service.ts',
    'src/main.ts',
    'src/modules/notification/notification.consumer.ts',
    'src/modules/outbox/outbox-writer.ts',
    'src/modules/risk/risk-scoring.consumer.ts',
  ])('%s, once exempt, is held to the rule like any other file', file => {
    // The six files that held a PinoLogger before BL-024 now go through SafeLogger and
    // `currentLogger()`; the only exemptions left are the logging module and tests.
    const messages = lint(file, "import { PinoLogger } from 'nestjs-pino';");
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatch(/SafeLogger/);
  });

  it.each([
    ['a variable', 'logger.setBindings({ fullName });'],
    ['a member', 'this.logger.setBindings({ role: "api" });'],
    ['a call result', 'currentLogger().setBindings({ correlationId: "x" });'],
  ])('rejects setBindings() on %s, which skips the onChild hook', (_name, source) => {
    const messages = lint(business, source);
    expect(messages).toHaveLength(1);
    expect(messages[0].message).toMatch(/setBindings\(\) skips the onChild hook/);
  });

  it('lets the logging module and tests call setBindings()', () => {
    expect(lint('src/common/logging/log-context.ts', 'logger.setBindings({});')).toEqual([]);
    expect(lint('src/common/logging/log-context.spec.ts', 'logger.setBindings({});')).toEqual([]);
  });

  it('accepts child(), which goes through the onChild hook', () => {
    expect(lint(business, 'const child = currentLogger().child({ a: 1 });')).toEqual([]);
  });
});
