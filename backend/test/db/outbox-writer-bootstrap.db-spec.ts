import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';

const execute = promisify(execFile);
const runtimeKeys =
  /^(PATH|SYSTEMROOT|WINDIR|TEMP|TMP|USERPROFILE|HOME|COMSPEC|PATHEXT|DOCKER_.+|TESTCONTAINERS_.+)$/i;

describe('TC-57-13 manual driver bootstraps from a clean project environment', () => {
  it.each(['api', 'worker', 'both'])(
    'commits and cleans up in the %s role without inherited project env',
    async role => {
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([key]) => runtimeKeys.test(key)),
      );
      const { stdout } = await execute(
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
      );
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
