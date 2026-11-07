import { Injectable } from '@nestjs/common';
import { Counter, register as defaultRegister, Registry } from 'prom-client';

// A future HTTP /metrics endpoint typically calls prom-client's defaultRegister.metrics(), which
// only sees metrics registered there. Each RedisClient DI instance owns its own RedisMetrics (and
// its own isolated Registry for metrics()/count(), relied on by tests that construct several
// instances), so this shared Counter is created once per process and reused by every instance
// instead of re-registered, which prom-client rejects as a duplicate name.
function sharedFallbackCounter(): Counter<string> {
  const existing = defaultRegister.getSingleMetric('redis_fallback_total');
  if (existing instanceof Counter) return existing;
  return new Counter({
    name: 'redis_fallback_total',
    help: 'Redis operational commands rejected at the caller fallback boundary',
    registers: [defaultRegister],
  });
}

@Injectable()
export class RedisMetrics {
  private readonly registry = new Registry();
  private readonly fallback = new Counter({
    name: 'redis_fallback_total',
    help: 'Redis operational commands rejected at the caller fallback boundary',
    registers: [this.registry],
  });
  private readonly shared = sharedFallbackCounter();
  increment(): void {
    this.fallback.inc();
    this.shared.inc();
  }
  metrics(): Promise<string> {
    return this.registry.metrics();
  }
  async count(): Promise<number> {
    return (await this.fallback.get()).values[0]?.value ?? 0;
  }
}
