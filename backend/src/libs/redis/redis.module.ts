import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { redisConfig } from '@config/redis.config';
import { RedisClient } from './redis.client';
import { RedisMetrics } from './redis.metrics';

@Module({
  imports: [ConfigModule.forFeature(redisConfig)],
  providers: [RedisClient, RedisMetrics],
  exports: [RedisClient, RedisMetrics],
})
export class RedisModule {}
