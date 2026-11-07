import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { type ConfigType } from '@nestjs/config';
import { redisConfig } from '@config/redis.config';
import { RedisClient } from './redis.client';
import { RedisMetrics } from './redis.metrics';

@Module({
  imports: [ConfigModule.forFeature(redisConfig)],
  providers: [
    RedisMetrics,
    {
      provide: RedisClient,
      inject: [redisConfig.KEY, RedisMetrics],
      useFactory: (config: ConfigType<typeof redisConfig>, metrics: RedisMetrics) =>
        new RedisClient(config, metrics, { lazyConnect: true }),
    },
  ],
  exports: [RedisClient, RedisMetrics],
})
export class RedisModule {}
