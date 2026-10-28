import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const runtimeKeys =
  /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|HOME|COMSPEC|PATHEXT|DOCKER_.+|TESTCONTAINERS_.+)$/i;

function safeOutput(text: string | undefined) {
  const value = text ?? '';
  const lines = value
    .trim()
    .split('\n')
    .filter(Boolean)
    .slice(0, 5)
    .map(line => {
      try {
        const data = JSON.parse(line) as Record<string, unknown>;
        return {
          pass: typeof data.pass === 'boolean' ? data.pass : undefined,
          mode:
            typeof data.mode === 'string' &&
            /^(commit|rollback|invalid|duplicate|context|transaction)$/.test(data.mode)
              ? data.mode
              : undefined,
          errorType:
            typeof data.errorType === 'string' && /^[A-Za-z]+Error$/.test(data.errorType)
              ? data.errorType
              : undefined,
        };
      } catch {
        const category = [
          'FATAL ERROR',
          'heap out of memory',
          'MODULE_NOT_FOUND',
          'ECONNREFUSED',
        ].find(marker => line.includes(marker));
        return { nonJson: true, category: category ?? 'output omitted' };
      }
    });
  return { characters: value.length, lines };
}

describe('TC-57-13 manual driver bootstraps from a clean project environment', () => {
  it.each(['api', 'worker', 'both'])(
    'commits and cleans up in the %s role without inherited project env',
    async role => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => runtimeKeys.test(key)),
      );
      let stdout: string;
      try {
        ({ stdout } = await execute(
          process.execPath,
          [
            '-r',
            require.resolve('ts-node/register'),
            '-r',
            require.resolve('tsconfig-paths/register'),
            resolve(__dirname, '../manual/outbox-writer.manual.ts'),
            'commit',
            `--role=${role}`,
          ],
          { cwd: resolve(__dirname, '../..'), env, timeout: 90000, maxBuffer: 1024 * 1024 },
        ));
      } catch (error) {
        const failure = error as Error & {
          code?: string | number;
          signal?: string;
          killed?: boolean;
          stdout?: string;
          stderr?: string;
        };
        // execFile's default message hides an empty-output exit; report bounded metadata, never
        // raw child messages, URLs, credentials or payloads from a failed process.
        throw new Error(
          `Manual driver child failed: ${JSON.stringify({
            role,
            code: failure.code,
            signal: failure.signal ?? null,
            killed: failure.killed ?? false,
            stdout: safeOutput(failure.stdout),
            stderr: safeOutput(failure.stderr),
          })}`,
        );
      }
      const result = stdout
        .trim()
        .split('\n')
        .map(line => JSON.parse(line) as Record<string, unknown>)
        .find(row => row.mode === 'commit');
      expect(result).toEqual(
        expect.objectContaining({
          mode: 'commit',
          role,
          pass: true,
          outboxRows: 1,
          cleanup: { databaseDropped: true, ownContainerStopped: true, cwdRestored: true },
        }),
      );
      expect(stdout).not.toMatch(/postgres(?:ql)?:\/\/|DATABASE_URL|password|Authorization/i);
    },
  );
});
