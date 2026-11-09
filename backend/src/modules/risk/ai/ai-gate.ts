import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import type { PermitResult } from './ai-contract';

export interface AiGatePolicy {
  revision: string;
  dailyRequestLimit: number;
  concurrentLimit: number;
}

export interface AiGateOptions {
  connectionString: string;
  policy: AiGatePolicy;
  /** Explicit database admission deadline; asynchronous cleanup never extends this deadline. */
  deadlineMs: number;
}

interface PgClient {
  connect(): Promise<void>;
  query(sql: string, values: unknown[]): Promise<{ rows: { result: string }[] }>;
  end(): Promise<void>;
  on(event: 'error', listener: () => void): void;
}

// pg is already a runtime dependency; keep its untyped API confined to this boundary.
const { Client } = createRequire(__filename)('pg') as {
  Client: new (options: Record<string, unknown>) => PgClient;
};

/** Shared durable reservations. Never activates a provider or replenishes a reservation. */
export class AiGate {
  constructor(private readonly options?: AiGateOptions) {}

  async tryAcquire(): Promise<PermitResult> {
    const options = this.options;
    if (!this.valid(options)) return { kind: 'unavailable' };
    const token = randomUUID();
    try {
      const result = await this.execute(
        options,
        'SELECT public.ai_gate_acquire($1::uuid,$2::text,$3::integer,$4::integer) AS result',
        [
          token,
          options.policy.revision,
          options.policy.dailyRequestLimit,
          options.policy.concurrentLimit,
        ],
      );
      if (result === 'budget_exhausted') return { kind: 'budget_exhausted' };
      if (result !== 'granted') return { kind: 'unavailable' };
      let released = false;
      return {
        kind: 'granted',
        release: () => {
          if (released) return;
          released = true;
          // Failure intentionally leaves capacity stranded; no unbounded retry or refund.
          void this.execute(options, 'SELECT public.ai_gate_release($1::uuid) AS result', [
            token,
          ]).catch(() => undefined);
        },
      };
    } catch {
      // A commit may have succeeded. Never retry an ambiguous reservation or expose DB details.
      return { kind: 'unavailable' };
    }
  }

  private valid(options: AiGateOptions | undefined): options is AiGateOptions {
    const positive = (n: unknown): n is number =>
      typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 2147483647;
    return (
      !!options &&
      typeof options.connectionString === 'string' &&
      options.connectionString.length > 0 &&
      positive(options.deadlineMs) &&
      !!options.policy &&
      typeof options.policy.revision === 'string' &&
      options.policy.revision.length > 0 &&
      options.policy.revision.length <= 128 &&
      positive(options.policy.dailyRequestLimit) &&
      positive(options.policy.concurrentLimit)
    );
  }

  private async execute(options: AiGateOptions, sql: string, values: unknown[]): Promise<string> {
    const ms = options.deadlineMs;
    const client = new Client({
      connectionString: options.connectionString,
      connectionTimeoutMillis: ms,
      query_timeout: ms,
      statement_timeout: ms,
      lock_timeout: ms,
      application_name: 'fraud-ai-gate',
    });
    // EventEmitter errors must not become uncaught exceptions; no connection details are logged.
    client.on('error', () => undefined);
    let timer: NodeJS.Timeout | undefined;
    // ES2022 project lib does not expose Promise.withResolvers.
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error('AI gate deadline')), ms);
    });
    const operation = async () => {
      await client.connect();
      const response = await client.query(sql, values);
      return response.rows[0]?.result;
    };
    try {
      return await Promise.race([operation(), deadline]);
    } finally {
      clearTimeout(timer);
      // pg end destroys the socket for a running query. Never await network cleanup.
      void client.end().catch(() => undefined);
    }
  }
}
