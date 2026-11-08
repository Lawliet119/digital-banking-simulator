import { Injectable } from '@nestjs/common';
import { Counter, register as defaultRegister, Registry } from 'prom-client';

export type RateLimitScope = 'ip' | 'user';

// Same pattern as RedisMetrics: one shared Counter per process in the default registry (what a
// future /metrics endpoint exposes) and one private Counter per instance for tests.
function sharedCounter(): Counter<'scope'> {
  const existing = defaultRegister.getSingleMetric('rate_limited_total');
  if (existing instanceof Counter) return existing;
  return new Counter({
    name: 'rate_limited_total',
    help: 'Requests refused with 429 RATE_LIMITED',
    labelNames: ['scope'],
    registers: [defaultRegister],
  });
}

@Injectable()
export class RateLimitMetrics {
  private readonly registry = new Registry();
  private readonly local = new Counter({
    name: 'rate_limited_total',
    help: 'Requests refused with 429 RATE_LIMITED',
    labelNames: ['scope'],
    registers: [this.registry],
  });
  private readonly shared = sharedCounter();

  limited(scope: RateLimitScope): void {
    this.local.inc({ scope });
    this.shared.inc({ scope });
  }

  async count(scope: RateLimitScope): Promise<number> {
    const values = (await this.local.get()).values;
    return values.find(v => v.labels.scope === scope)?.value ?? 0;
  }
}
