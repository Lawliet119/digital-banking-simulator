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

/** @param {string} up the "../" prefix that would leave the file's own module folder */
const leavesOwnModule = up => ({
  group: [`${up}**`],
  message:
    'This relative import leaves your module. For another module use "@modules/<name>" (its public index); for shared code use @common, @config, @database or @libs.',
});

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'eslint.config.mjs'] },
  eslint.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,
  eslintPluginPrettierRecommended,
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
