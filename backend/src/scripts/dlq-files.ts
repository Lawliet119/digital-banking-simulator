import { appendFileSync, closeSync, mkdirSync, openSync, writeSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * Files the DLQ tools write for the operator (BL-360, BL-372): the quarantine file of
 * `dlq:age-check` (message bodies that were deleted from SQS) and the record file of `dlq:resend`.
 * They are created exclusively: a name that is already used is an error, never an overwrite,
 * because the previous content may be the only copy of a message that is no longer in SQS.
 */

/** The file already exists. The message is a fixed sentence: it never carries a path or a body. */
export class QuarantineFileExistsError extends Error {
  constructor() {
    super('The file already exists and is never overwritten: choose a new file name');
    this.name = 'QuarantineFileExistsError';
  }
}

/**
 * Creates `path` (and its parent directories, mode 0o700) with `text`, mode 0o600. Throws
 * `QuarantineFileExistsError` when the file exists; any other failure (permission, full disk) is
 * thrown as it is. Nothing is written when it throws before the file is created.
 */
export function createExclusiveFile(path: string, text = ''): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new QuarantineFileExistsError();
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
