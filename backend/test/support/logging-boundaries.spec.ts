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
    const messages = lint('src/common/messaging/consumer-base.ts', "import Redis from 'ioredis';");
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
  ])('the inventory of existing users: %s may still import PinoLogger', file => {
    // The files that held a PinoLogger before this rule (injected and handed to ConsumerBase, read
    // for the context, or wired in main). The list shrinks; a new file must use Nest's Logger.
    expect(lint(file, "import { PinoLogger } from 'nestjs-pino';")).toEqual([]);
  });
});
