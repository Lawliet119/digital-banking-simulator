import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import type { AccountOwnershipAction, AccountOwnershipContext, AccountsService } from './index';

const run = promisify(execFile);
const BACKEND_DIR = resolve(__dirname, '../../..');
const REPO_ROOT = resolve(BACKEND_DIR, '..');

describe('DBS-55 accounts public import boundary', () => {
  it('TC-86-08 exposes a mandatory trusted ownership context instead of a bare user id', () => {
    const action: AccountOwnershipAction = 'account.read';
    const context: AccountOwnershipContext = {
      userId: '10000000-0000-4000-8000-000000000001',
      role: 'customer',
      action,
      correlationId: '86000000-0000-4000-8000-000000000001',
    };
    type Args = Parameters<AccountsService['getOwnedAccount']>;
    const args: Args = ['3a000000-0000-4000-8000-000000000001', context];
    // The compile check must fail if the old, unauditable overload is ever restored.
    // @ts-expect-error A verified internal id alone is no longer an ownership context.
    const legacy: Args = ['3a000000-0000-4000-8000-000000000001', context.userId];
    // @ts-expect-error The context is mandatory, even for an account that belongs to the caller.
    const absent: Args = ['3a000000-0000-4000-8000-000000000001'];
    expect(args[1]).toBe(context);
    expect(legacy).toHaveLength(2);
    expect(absent).toHaveLength(1);
  });

  it('TC-55-14 effective eslint permits the index and rejects both kinds of deep import', async () => {
    // Run the real ESM config outside Jest's CommonJS transform, then exercise its effective rule.
    const script = [
      "import { ESLint, Linter } from 'eslint';",
      'const config = await new ESLint().calculateConfigForFile("src/modules/ledger/probe.ts");',
      'const rule = config.rules["no-restricted-imports"];',
      'const linter = new Linter();',
      'const report = {};',
      'for (const path of ["@modules/accounts", "@modules/accounts/accounts.service", "../accounts/accounts.service"]) {',
      '  const source = "import { AccountsService } from " + JSON.stringify(path) + ";";',
      '  report[path] = linter.verify(source, { languageOptions: { sourceType: "module", ecmaVersion: 2022 }, rules: { "no-restricted-imports": rule } }).map(message => message.ruleId);',
      '}',
      'process.stdout.write(JSON.stringify(report));',
    ].join('\n');
    // Start from outside backend/ so an inherited cwd cannot resolve eslint and the test goes red.
    const original = process.cwd();
    process.chdir(REPO_ROOT);
    let stdout: string;
    try {
      ({ stdout } = await run(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        cwd: BACKEND_DIR,
        timeout: 20_000,
      }));
    } finally {
      process.chdir(original);
    }
    const report = JSON.parse(stdout) as Record<string, string[]>;
    expect(report['@modules/accounts']).toEqual([]);
    expect(report['@modules/accounts/accounts.service']).toEqual(['no-restricted-imports']);
    expect(report['../accounts/accounts.service']).toEqual(['no-restricted-imports']);
  }, 25_000);
});
