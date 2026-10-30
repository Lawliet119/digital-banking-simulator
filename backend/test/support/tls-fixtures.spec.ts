import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

// Jest runs from backend/, so git paths are taken from the repo root, not process.cwd().
const repoRoot = resolve(__dirname, '../../..');
const fixtures = ['ca.pem', 'other-ca.pem', 'server.pem', 'server.key'].map(
  name => `backend/test/support/tls-fixtures/${name}`,
);

function git(...args: string[]): number | null {
  return spawnSync('git', args, { cwd: repoRoot, stdio: 'ignore' }).status;
}

// --no-index applies the .gitignore rules even to tracked files; without it check-ignore
// says "not ignored" for anything already committed, including a file added with -f.
const ignored = (path: string) => git('check-ignore', '-q', '--no-index', path) === 0;

describe('TC-67-14 TLS fixtures reach a clean checkout', () => {
  it.each(fixtures)('%s is not ignored by .gitignore', path => {
    expect(ignored(path)).toBe(false);
  });

  it.each(fixtures)('%s is tracked by git', path => {
    expect(git('ls-files', '--error-unmatch', path)).toBe(0);
  });
});

describe('TC-67-15 the exception opens only those four files', () => {
  it.each([
    'backend/test/support/tls-fixtures/ca.key',
    'backend/test/support/other.pem',
    'backend/server.key',
    'infra/x.pem',
    '.env',
    'backend/.env',
  ])('%s is still ignored', path => {
    expect(ignored(path)).toBe(true);
  });
});
