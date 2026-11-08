import { Injectable } from '@nestjs/common';
import { Counter, register as defaultRegister, Registry } from 'prom-client';

export type FallbackRule = 'R1' | 'R5';

const NAME = 'risk_redis_fallback_total';
const HELP = 'Feature reads answered from SQL because Redis failed or could not prove coverage';

// Same pattern as RedisMetrics: one shared Counter per process in the default registry (what a
// future /metrics endpoint exposes) and one private Counter per instance for tests.
function sharedCounter(): Counter<'rule' | 'reason'> {
  const existing = defaultRegister.getSingleMetric(NAME);
  if (existing instanceof Counter) return existing;
  return new Counter({
    name: NAME,
    help: HELP,
    labelNames: ['rule', 'reason'],
    registers: [defaultRegister],
  });
}

@Injectable()
export class RiskMetrics {
  private readonly registry = new Registry();
  private readonly local = new Counter({
    name: NAME,
    help: HELP,
    labelNames: ['rule', 'reason'],
    registers: [this.registry],
  });
  private readonly shared = sharedCounter();

  /** `error`: Redis failed (the answer is exact, it only costs SQL load); `cold`: no proof of coverage. */
  redisFallback(rule: FallbackRule, reason: 'error' | 'cold'): void {
    this.local.inc({ rule, reason });
    this.shared.inc({ rule, reason });
  }

  async count(rule: FallbackRule, reason: 'error' | 'cold'): Promise<number> {
    const values = (await this.local.get()).values;
    return values.find(v => v.labels.rule === rule && v.labels.reason === reason)?.value ?? 0;
  }
}
