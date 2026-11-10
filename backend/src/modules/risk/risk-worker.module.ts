import { Module } from '@nestjs/common';
import { ConfigModule, type ConfigType } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { limitsConfig } from '@config/limits.config';
import { sqsConfig } from '@config/sqs.config';
import { databaseConfig } from '@config/database.config';
import { riskAiConfig } from '@config/risk-ai.config';
import { RiskAiService } from './ai/risk-ai.service';
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
    ConfigModule.forFeature(databaseConfig),
    ConfigModule.forFeature(riskAiConfig),
    SqsModule,
    RedisModule,
    AuditModule,
  ],
  providers: [
    RiskMetrics,
    ScoringService,
    {
      provide: RiskAiService,
      inject: [riskAiConfig.KEY, databaseConfig.KEY],
      useFactory: (
        ai: ConfigType<typeof riskAiConfig>,
        database: ConfigType<typeof databaseConfig>,
      ) => new RiskAiService(ai, database),
    },
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
      inject: [TransferFacts, limitsConfig.KEY],
      useFactory: (facts: TransferFacts, limits: ConfigType<typeof limitsConfig>) =>
        new OnlineFeatureProvider({
          facts,
          perTxLimit: limits.transfer.perTx,
        }),
    },
    RiskScoringConsumer,
  ],
  exports: [RiskScoringConsumer],
})
export class RiskWorkerModule {}
