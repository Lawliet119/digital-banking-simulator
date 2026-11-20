import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname, join, parse, resolve } from 'node:path';

/**
 * Files the DLQ tools write for the operator (BL-360, BL-372): the quarantine file of
 * `dlq:age-check` (message bodies that were deleted from SQS) and the record file of `dlq:resend`.
 * They are created exclusively: a name that is already used is an error, never an overwrite,
 * because the previous content may be the only copy of a message that is no longer in SQS.
 */

/** The file already exists. The message is a fixed sentence: it never carries a path or a body. */
export class FileExistsError extends Error {
  constructor() {
    super('The file already exists and is never overwritten: choose a new file name');
    this.name = 'FileExistsError';
  }
}

/** The path would put message data in a place the operator did not mean (BL-360, review #7). */
export class UnsafeFilePathError extends Error {
  constructor() {
    super(
      'The file path starts with ~ or is inside a git tree: use an absolute path outside the repo',
    );
    this.name = 'UnsafeFilePathError';
  }
}

/**
 * Refuses a path that starts with `~` (a shell that did not expand it, such as Git Bash after `--option=`,
 * would make a folder named `~`) and a path whose folder, or any folder above it, has a `.git`: these files
 * hold message bodies or event ids and the repository is public.
 */
export function assertSafeOutputPath(path: string): void {
  if (path.startsWith('~')) throw new UnsafeFilePathError();
  let dir = dirname(resolve(path));
  for (;;) {
    if (existsSync(join(dir, '.git'))) throw new UnsafeFilePathError();
    const parent = dirname(dir);
    if (parent === dir || dir === parse(dir).root) return;
    dir = parent;
  }
}

/**
 * Creates `path` (and its parent directories, mode 0o700) with `text`, mode 0o600. Throws
 * `FileExistsError` when the file exists; any other failure (permission, full disk) is
 * thrown as it is. Nothing is written when it throws before the file is created.
 */
export function createExclusiveFile(path: string, text = ''): void {
  assertSafeOutputPath(path);
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new FileExistsError();
    throw error;
  }
  try {
    if (text !== '') writeSync(fd, text);
  } finally {
    closeSync(fd);
  }
}

/** Adds one line to a file made by `createExclusiveFile`. */
export function appendLine(path: string, line: string): void {
  appendFileSync(path, `${line}\n`);
}
