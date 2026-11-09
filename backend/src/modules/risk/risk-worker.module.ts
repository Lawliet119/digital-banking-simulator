import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { limitsConfig } from '@config/limits.config';
import { sqsConfig } from '@config/sqs.config';
import { RedisClient, RedisModule } from '@libs/redis';
import { SqsModule } from '@libs/sqs';
import { AuditModule } from '@modules/audit';
import { RuleSetRepository } from './config/rule-set.repository';
import { OnlineFeatureProvider } from './features/online-feature-provider';
import { TransferFacts } from './features/transfer-facts';
import { RiskScoringConsumer } from './risk-scoring.consumer';
import { RiskMetrics } from './risk.metrics';
import { ScoringService } from './scoring.service';

/**
 * Worker-only half of risk (DBS-111): the `risk-events` consumer and what it reads with. Listed in
 * `workerModules`; the consumer also checks `runsWorkers()` before it polls. Shared `RiskModule`
 * stays the home of anything an `api` instance will need (the review API).
 */
@Module({
  imports: [
    ConfigModule.forFeature(sqsConfig),
    ConfigModule.forFeature(limitsConfig),
    SqsModule,
    RedisModule,
    AuditModule,
  ],
  providers: [
    RiskMetrics,
    ScoringService,
    {
      provide: TransferFacts,
      inject: [DataSource],
      useFactory: (db: DataSource) => new TransferFacts(db),
    },
    {
      provide: RuleSetRepository,
      inject: [RedisClient, DataSource, RiskMetrics],
      useFactory: (redis: RedisClient, db: DataSource, metrics: RiskMetrics) =>
        new RuleSetRepository({ redis, db, metrics }),
    },
    {
      provide: OnlineFeatureProvider,
      inject: [TransferFacts, RedisClient, limitsConfig.KEY, RiskMetrics],
      useFactory: (
        facts: TransferFacts,
        redis: RedisClient,
        limits: ConfigType<typeof limitsConfig>,
        metrics: RiskMetrics,
      ) => {
        const provider = new OnlineFeatureProvider({
          facts,
          redis,
          perTxLimit: limits.transfer.perTx,
          metrics,
        });
        // BL-205 item 8: a starting worker trusts no counter left by the one before it. Done
        // here, before any consumer loop can start, so the first event already sees it.
        provider.invalidateCounters();
        return provider;
      },
    },
    RiskScoringConsumer,
  ],
  exports: [RiskScoringConsumer],
})
export class RiskWorkerModule {}
