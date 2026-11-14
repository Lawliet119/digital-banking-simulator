import type { Logger } from 'pino';

/**
 * `process.emitWarning` (the `sslmode` warning of pg-connection-string, deprecations) would print
 * text to stderr, and its message can quote a connection string. This sends it to the JSON logger
 * instead (BL-026): one `warn` line with the warning's `name` and `code`, and the message only when
 * it is one of the fixed texts below (then the fixed part alone, never what follows it).
 */
const WARNING_NAME = /^[A-Za-z]{1,64}$/;
const WARNING_CODE = /^[A-Za-z0-9_.-]{1,64}$/;
const FIXED_WARNINGS: readonly RegExp[] = [
  /^SECURITY WARNING: The SSL modes 'prefer', 'require', and 'verify-ca' are treated as aliases for 'verify-full'\./,
];

interface WarningSource {
  on(event: 'warning', listener: (warning: unknown) => void): unknown;
  removeAllListeners(event: 'warning'): unknown;
}

function readText(record: object, key: string): string | undefined {
  const value = (record as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : undefined;
}

function describeWarning(warning: unknown): { fields: Record<string, string>; message: string } {
  const fields: Record<string, string> = {};
  let message = 'Process warning';
  if (warning === null || typeof warning !== 'object') return { fields, message };
  const name = readText(warning, 'name');
  if (name !== undefined && WARNING_NAME.test(name)) fields.warningName = name;
  const code = readText(warning, 'code');
  if (code !== undefined && WARNING_CODE.test(code)) fields.warningCode = code;
  const text = readText(warning, 'message');
  if (text !== undefined && text.length <= 4096) {
    for (const pattern of FIXED_WARNINGS) {
      const match = pattern.exec(text);
      if (match) {
        message = match[0];
        break;
      }
    }
  }
  return { fields, message };
}

/**
 * Takes over the `warning` event: Node prints its text by a listener of that same event, so the
 * default listeners are removed first. Call it once, where the process logger is built. It never
 * throws: a warning whose properties throw still gives the fixed line.
 */
export function installProcessWarningLogger(logger: Logger, source: WarningSource = process): void {
  source.removeAllListeners('warning');
  source.on('warning', warning => {
    try {
      let described: { fields: Record<string, string>; message: string };
      try {
        described = describeWarning(warning);
      } catch {
        described = { fields: {}, message: 'Process warning' };
      }
      logger.warn(described.fields, described.message);
    } catch {
      /* a warning must never become a crash */
    }
  });
}
