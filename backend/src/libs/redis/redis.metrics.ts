import { Injectable } from '@nestjs/common';
import { Counter, Registry } from 'prom-client';

@Injectable()
export class RedisMetrics {
  private readonly registry = new Registry();
  private readonly fallback = new Counter({
    name: 'redis_fallback_total',
    help: 'Redis operational commands rejected at the caller fallback boundary',
    registers: [this.registry],
  });
  increment(): void {
    this.fallback.inc();
  }
  metrics(): Promise<string> {
    return this.registry.metrics();
  }
  async count(): Promise<number> {
    return (await this.fallback.get()).values[0]?.value ?? 0;
  }
}
