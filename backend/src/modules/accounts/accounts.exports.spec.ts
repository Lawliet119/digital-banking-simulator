import { execFileSync } from 'node:child_process';

describe('DBS-55 accounts public import boundary', () => {
  it('TC-55-14 effective eslint permits the index and rejects both kinds of deep import', () => {
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
    const report = JSON.parse(
      execFileSync(process.execPath, ['--input-type=module', '-e', script], {
        encoding: 'utf8',
        cwd: process.cwd(),
      }),
    ) as Record<string, string[]>;
    expect(report['@modules/accounts']).toEqual([]);
    expect(report['@modules/accounts/accounts.service']).toEqual(['no-restricted-imports']);
    expect(report['../accounts/accounts.service']).toEqual(['no-restricted-imports']);
  });
});
