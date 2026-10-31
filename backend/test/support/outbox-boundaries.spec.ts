import { resolve } from 'node:path';
import { execFileSync } from 'node:child_process';
import type { Linter } from 'eslint';

describe('TC-57-12 imports to the outbox module obey the existing ESLint boundaries', () => {
  function lint(source: string): Linter.LintMessage[] {
    // ESLint loads the real ESM config outside Jest's VM. The snippet stays in memory, and the
    // built-in JS parser suffices for its plain import: no generated TypeScript file is needed.
    const result = execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `import { ESLint, Linter } from 'eslint';
         const eslint = new ESLint();
         const config = await eslint.calculateConfigForFile('src/modules/identity/identity.controller.ts');
         const messages = new Linter().verify(process.argv[1], {
           languageOptions: { ecmaVersion: 'latest', sourceType: 'module' },
           rules: { 'no-restricted-imports': config.rules['no-restricted-imports'] },
         });
         process.stdout.write(JSON.stringify(messages));`,
        source,
      ],
      { cwd: resolve(__dirname, '../..'), encoding: 'utf8' },
    );
    return JSON.parse(result) as Linter.LintMessage[];
  }

  it('accepts a producer import through the public outbox index', () => {
    expect(lint("import { OutboxWriter } from '@modules/outbox';")).toEqual([]);
  });

  it.each(['@modules/outbox/outbox-writer', '../outbox/outbox-writer'])(
    'rejects the deep import %s',
    path => {
      const messages = lint(`import { OutboxWriter } from '${path}';`);
      expect(messages).toHaveLength(1);
      expect(messages[0]).toMatchObject({ ruleId: 'no-restricted-imports', severity: 2 });
    },
  );
});
