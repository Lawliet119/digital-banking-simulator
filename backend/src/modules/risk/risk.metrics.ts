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

const CONFIG_NAME = 'risk_config_redis_fallback_total';
const CONFIG_HELP =
  'Rule configuration reads answered from PostgreSQL because Redis failed or held a bad value';

/** `error`: a Redis call failed; `corrupt`: Redis answered with a value that cannot be used. */
export type ConfigFallbackReason = 'error' | 'corrupt';

function sharedConfigCounter(): Counter<'reason'> {
  const existing = defaultRegister.getSingleMetric(CONFIG_NAME);
  if (existing instanceof Counter) return existing;
  return new Counter({
    name: CONFIG_NAME,
    help: CONFIG_HELP,
    labelNames: ['reason'],
    registers: [defaultRegister],
  });
}

// BL-188: a rule-set selection that could not be proven fresh within the 60-second budget (SQL read of
// 60 s or more, or a local clock that went backwards or ran inconsistently while selecting). It is the signal
// for the assumptions of BUG-20261109-risk-config-freshness §2, so it has no label: any increase is an event.
const FRESHNESS_NAME = 'risk_config_freshness_exceeded_total';
const FRESHNESS_HELP =
  'Rule set selections discarded because the 60-second freshness bound could not be proven';

function sharedFreshnessCounter(): Counter {
  const existing = defaultRegister.getSingleMetric(FRESHNESS_NAME);
  if (existing instanceof Counter) return existing;
  return new Counter({ name: FRESHNESS_NAME, help: FRESHNESS_HELP, registers: [defaultRegister] });
}

@Injectable()
export class RiskMetrics {
  private readonly registry = new Registry();
  private readonly localFreshness = new Counter({
    name: FRESHNESS_NAME,
    help: FRESHNESS_HELP,
    registers: [this.registry],
  });
  private readonly sharedFreshness = sharedFreshnessCounter();
  private readonly localConfig = new Counter({
    name: CONFIG_NAME,
    help: CONFIG_HELP,
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly sharedConfig = sharedConfigCounter();

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

  configFallback(reason: ConfigFallbackReason): void {
    this.localConfig.inc({ reason });
    this.sharedConfig.inc({ reason });
  }

  /** A rule-set selection was discarded because its freshness could not be proven (BL-188). */
  configFreshnessExceeded(): void {
    this.localFreshness.inc();
    this.sharedFreshness.inc();
  }

  async configFreshnessExceededCount(): Promise<number> {
    return (await this.localFreshness.get()).values.reduce((sum, v) => sum + v.value, 0);
  }

  /** The fallbacks of one reason, or of all reasons when none is given. */
  async configFallbackCount(reason?: ConfigFallbackReason): Promise<number> {
    const values = (await this.localConfig.get()).values;
    return values
      .filter(v => reason === undefined || v.labels.reason === reason)
      .reduce((sum, v) => sum + v.value, 0);
  }

  async count(rule: FallbackRule, reason: 'error' | 'cold'): Promise<number> {
    const values = (await this.local.get()).values;
    return values.find(v => v.labels.rule === rule && v.labels.reason === reason)?.value ?? 0;
  }
}
