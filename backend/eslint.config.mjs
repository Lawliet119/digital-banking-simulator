// @ts-check
import eslint from '@eslint/js';
import eslintPluginPrettierRecommended from 'eslint-plugin-prettier/recommended';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const aliasDeepImport = {
  group: ['@modules/*/*'],
  message:
    'Import another module only through its public index: "@modules/<name>". Do not reach into its internals.',
};

const sharedCodeImportsAModule = {
  group: ['@modules', '@modules/**', '**/modules', '**/modules/**'],
  message:
    'Shared infrastructure (common, config, database, libs) must not depend on a business module. Dependencies point from modules to infrastructure, never back.',
};

/** @param {string} up the "../" prefix that would leave the file's own module folder */
const leavesOwnModule = up => ({
  group: [`${up}**`],
  message:
    'This relative import leaves your module. For another module use "@modules/<name>" (its public index); for shared code use @common, @config, @database or @libs.',
});

const ioredisSyntaxRestrictions = [
  { selector: "ImportDeclaration[source.value=/^ioredis/]", message: 'Use @libs/redis instead of importing ioredis directly.' },
  { selector: "ImportExpression[source.value=/^ioredis/]", message: 'Use @libs/redis instead of importing ioredis directly.' },
  // A template-literal source (e.g. import(`ioredis`)) has no Literal .value, so the
  // selectors above don't match it; catch that bypass separately (DBS-76 code-review).
  { selector: "ImportExpression > TemplateLiteral[quasis.0.value.raw=/^ioredis/]", message: 'Use @libs/redis instead of importing ioredis directly.' },
  { selector: "CallExpression[callee.name='require'] > TemplateLiteral[quasis.0.value.raw=/^ioredis/]", message: 'Use @libs/redis instead of importing ioredis directly.' },
];

const moneyNumberSyntaxRestriction = {
  selector: 'CallExpression[callee.name=/^(Number|parseInt|parseFloat)$/]',
  message:
    'Do not use Number/parseInt/parseFloat in ledger or accounts modules; use @common/money instead (BR-01, ADR-07).',
};

// BL-024: every log line goes through Nest's Logger, so SafeLogger covers it. PinoLogger and
// `req.log` reach pino directly and skip that protection; contexts are opened with
// @common/logging/log-context, not with PinoLogger.runInContext.
const directPinoMessage =
  'Log through Nest\'s Logger (@nestjs/common, which goes through SafeLogger) and open contexts with @common/logging/log-context; PinoLogger and req.log bypass SafeLogger.';
const pinoSyntaxRestrictions = [
  {
    selector: "ImportDeclaration[source.value='nestjs-pino'] > ImportSpecifier[imported.name=/^(PinoLogger|InjectPinoLogger|getLoggerToken)$/]",
    message: directPinoMessage,
  },
  {
    selector: 'MemberExpression[property.name="log"][object.name=/^(req|request|res|response)$/]',
    message: directPinoMessage,
  },
  {
    selector: 'MemberExpression[property.name="log"][object.property.name=/^(req|request|res|response)$/]',
    message: directPinoMessage,
  },
];

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
  {
    files: ['src/**/*.ts'],
    ignores: ['src/libs/redis/**'],
    rules: {
      'no-restricted-modules': ['error', { paths: [{ name: 'ioredis', message: 'Use @libs/redis so timeout, breaker and fallback metric apply.' }] }],
      'no-restricted-syntax': ['error', ...ioredisSyntaxRestrictions, ...pinoSyntaxRestrictions],
    },
  },
  {
    files: ['src/libs/redis/**/*.ts'],
    rules: { 'no-restricted-syntax': ['error', ...pinoSyntaxRestrictions] },
  },
  {
    files: ['src/modules/ledger/**/*.ts', 'src/modules/accounts/**/*.ts'],
    ignores: ['**/*.spec.ts'],
    rules: {
      'no-restricted-syntax': [
        'error',
        ...ioredisSyntaxRestrictions,
        moneyNumberSyntaxRestriction,
        ...pinoSyntaxRestrictions,
      ],
    },
  },
  // Who may touch PinoLogger: the logging module itself, tests, and the files that already held one
  // before this rule (injected and handed on to ConsumerBase, read for the context, or wired in
  // main). The list only shrinks; new code uses Nest's Logger.
  {
    files: [
      'src/common/logging/**/*.ts',
      '**/*.spec.ts',
      'src/common/messaging/consumer-base.ts',
      'src/common/metrics/metrics.service.ts',
      'src/main.ts',
      'src/modules/notification/notification.consumer.ts',
      'src/modules/outbox/outbox-writer.ts',
      'src/modules/risk/risk-scoring.consumer.ts',
    ],
    rules: { 'no-restricted-syntax': ['error', ...ioredisSyntaxRestrictions] },
  },
  {
    languageOptions: {
      globals: { ...globals.node, ...globals.jest },
      sourceType: 'commonjs',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', ignoreRestSiblings: true },
      ],
      'prettier/prettier': ['error', { endOfLine: 'auto' }],
    },
  },
  // ── Module boundaries (docs/03 §5) ─────────────────────────────────────────────────────────
  // A module is reached only through its public index; never through its internals.
  //   ✔ import { AccountsService } from '@modules/accounts';
  //   ✔ import { Money } from '@common/money';            (shared folders are fine)
  //   ✔ import { CreateDto } from '../dto/create.dto';     (stays inside the same module)
  //   ✘ import … from '@modules/accounts/accounts.service';  (a sibling module's internals)
  //   ✘ import … from '../accounts/accounts.service';        (same, via a relative path)
  {
    files: ['src/**/*.ts'],
    rules: { 'no-restricted-imports': ['error', { patterns: [aliasDeepImport] }] },
  },
  // The dependency arrow points one way: modules → shared infrastructure. If `common` could import
  // a module, a shared helper would quietly start depending on business code and the "shared"
  // folders would become the place where cycles hide.
  {
    files: ['src/common/**/*.ts', 'src/config/**/*.ts', 'src/database/**/*.ts', 'src/libs/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [aliasDeepImport, sharedCodeImportsAModule] }],
    },
  },
  // A file `depth` folders below `src/modules/<name>/` may climb `depth` levels (still inside its
  // own module) but not one more. Anything further is another module or shared code, and shared
  // code is imported through its alias (@common, @config, …), never through "../".
  ...[0, 1, 2, 3].map(depth => ({
    files: [`src/modules/${'*/'.repeat(depth + 1)}*.ts`],
    rules: {
      'no-restricted-imports': [
        'error',
        { patterns: [aliasDeepImport, leavesOwnModule('../'.repeat(depth + 1))] },
      ],
    },
  })),
  {
    // Tests build objects around untyped mocks; the unsafe-* rules only add noise there.
    files: ['**/*.spec.ts', 'test/**/*.ts'],
    rules: {
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      '@typescript-eslint/unbound-method': 'off',
    },
  },
);
