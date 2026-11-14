import { Injectable } from '@nestjs/common';
import { Counter, register as defaultRegister, Registry } from 'prom-client';

// Same pattern as RedisMetrics: one shared Counter per process in the default registry (what a
// future /metrics endpoint exposes) and one private Counter per instance for tests.
// BL-204: there is no `risk_redis_fallback_total` any more. `OnlineFeatureProvider` reads SQL only
// (BL-187), so a feature read has no Redis to fall back from; only the rule configuration does.
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

@Injectable()
export class RiskMetrics {
  private readonly registry = new Registry();
  private readonly localConfig = new Counter({
    name: CONFIG_NAME,
    help: CONFIG_HELP,
    labelNames: ['reason'],
    registers: [this.registry],
  });
  private readonly sharedConfig = sharedConfigCounter();

  configFallback(reason: ConfigFallbackReason): void {
    this.localConfig.inc({ reason });
    this.sharedConfig.inc({ reason });
  }

  /** The fallbacks of one reason, or of all reasons when none is given. */
  async configFallbackCount(reason?: ConfigFallbackReason): Promise<number> {
    const values = (await this.localConfig.get()).values;
    return values
      .filter(v => reason === undefined || v.labels.reason === reason)
      .reduce((sum, v) => sum + v.value, 0);
  }
}
