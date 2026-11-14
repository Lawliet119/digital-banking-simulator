import { performance } from 'node:perf_hooks';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { DataSource, type EntityManager } from 'typeorm';
import { sqsConfig } from '@config/sqs.config';
import type { DomainEvent } from '@common/events';
import { ConsumerBase, type UnknownEventPolicy } from '@common/messaging';
import { MetricsService } from '@common/metrics';
import { TransactionService } from '@database/transaction.service';
import { PoisonMessageError, SqsClient } from '@libs/sqs';
import { AuditService } from '@modules/audit';
import type { AiAssessment, FeatureInput } from './ai/ai-contract';
import { AssessmentMemo } from './ai/assessment-memo';
import { persistedAssessment } from './ai/persisted-assessment';
import { RiskAiService } from './ai/risk-ai.service';
import { toAiFeatureInput } from './ai/feature-projection';
import { RuleSetRepository } from './config/rule-set.repository';
import { OnlineFeatureProvider } from './features/online-feature-provider';
import { countDecision } from './risk-scoring.metrics';
import { ScoringService, type ScoringResult } from './scoring.service';

/** `processed_events.consumer` of this module. */
export const RISK_CONSUMER = 'risk';

/** What `prepare` hands to the transaction; `won` is set there when this delivery made the decision. */
interface Prepared {
  readonly transferId: string;
  readonly ruleSetVersion: number;
  readonly result: ScoringResult;
  readonly snapshot: FeatureInput;
  readonly assessment?: AiAssessment;
  won: boolean;
  /** `fraud_flags.created_at - transfers.created_at` in ms, set in `apply` when this delivery wrote a flag. */
  flagLagMs?: number;
}

/** No conflict target: both unique indexes of risk_decisions are arbiters, so a loser gets 0 rows, never 23505 (RSK-01). */
const CLAIM_DECISION = `
  INSERT INTO risk_decisions
    (transfer_id, event_id, rule_set_version, mode, rule_score, feature_snapshot, ai_status, ai_applied_weight,
     probability, provider, requested_model, response_model, rubric_sha256, input_sha256, provider_request_id)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9, $10, $11, $12, $13, $14, $15)
  ON CONFLICT DO NOTHING
  RETURNING transfer_id`;

/**
 * Consumer of `risk-events` (UC-9, DBS-111): scores every completed TRANSFER with R1 to R6, records
 * one immutable decision per transfer (ADR-14, RSK-01) and, at MEDIUM or HIGH, a flag with its rule
 * hits and an audit row, all in one transaction after the `processed_events` claim of `ConsumerBase`.
 *
 * Redis and the feature queries run in `prepare`, before the transaction opens. A rule or feature
 * error is thrown: nothing is written, the message is retried and dead-lettered at the fifth
 * receive (ADR-14). Only a broken `ai.*` block is recorded (`CONFIG_INVALID`) instead of failing.
 * Customers never see any of this (AC-10.2): nothing here is exposed by the API or logged in full.
 */
@Injectable()
export class RiskScoringConsumer extends ConsumerBase {
  protected readonly consumerName = RISK_CONSUMER;
  private readonly logger = new Logger(RiskScoringConsumer.name);
  /** A retry of the same event reuses the AI answer already paid for (see AssessmentMemo). */
  private readonly paidAssessments = new AssessmentMemo();

  constructor(
    tx: TransactionService,
    sqs: SqsClient,
    pino: PinoLogger,
    @Inject(sqsConfig.KEY) private readonly config: ConfigType<typeof sqsConfig>,
    private readonly ruleSets: RuleSetRepository,
    private readonly features: OnlineFeatureProvider,
    private readonly scoring: ScoringService,
    private readonly audit: AuditService,
    private readonly db: DataSource,
    private readonly ai: RiskAiService,
    /** Absent in a test that builds the consumer by hand: then nothing is measured. */
    @Optional() private readonly metrics?: MetricsService,
  ) {
    super(tx, sqs, pino);
  }

  protected queueUrl(): string | undefined {
    return this.config.riskQueueUrl;
  }

  /** BL-010: a type this worker does not know yet is kept for replay, not dropped. */
  protected override get unknownEventPolicy(): UnknownEventPolicy {
    return 'dead-letter';
  }

  /**
   * True when this event, or another event of the same transfer, was already handled. Only saves
   * the Redis and SQL reads of a duplicate: the claims inside the transaction are what decide.
   */
  protected async earlyDedup(event: DomainEvent & { transferId: string }): Promise<boolean> {
    const [row] = await this.db.query<{ done: boolean }[]>(
      `SELECT EXISTS (SELECT 1 FROM processed_events WHERE consumer = $1 AND event_id = $2)
           OR EXISTS (SELECT 1 FROM risk_decisions WHERE transfer_id = $3) AS done`,
      [RISK_CONSUMER, event.eventId, event.transferId],
    );
    return row.done;
  }

  /** Returns the decision to record, or `null` when there is nothing to score (see §2 of the design). */
  protected override async prepare(event: DomainEvent): Promise<unknown> {
    if (event.eventType !== 'TransferCompleted') {
      throw new PoisonMessageError('Only TransferCompleted belongs on risk-events');
    }
    if (event.type !== 'TRANSFER') return null; // a deposit is never scored (FR-RSK-01)
    if (await this.earlyDedup(event)) return null;
    // The narrowing above makes this a TRANSFER event (the rules' `TransferEvent`).
    const transfer = event;
    const ruleSet = await this.ruleSets.current();
    const selectedAtMonotonicMs = performance.now();
    const features = await this.features.extract(transfer);
    const snapshot = toAiFeatureInput(transfer, features);
    const baseline = this.scoring.score(transfer, features, ruleSet);
    if (!baseline) return null;
    let assessment: AiAssessment | undefined;
    if (baseline.mode === 'rules_with_external_ai' && baseline.aiStatus !== 'CONFIG_INVALID') {
      assessment = this.paidAssessments.get(event.eventId);
      if (!assessment) {
        const aiStartedAt = performance.now();
        try {
          assessment = await this.ai.evaluate(snapshot, ruleSet, selectedAtMonotonicMs);
        } finally {
          // Admission (gate) and provider request together, whatever the outcome: a slow
          // UNAVAILABLE is exactly what `risk_ai_call_duration_ms` must show (BL-204).
          this.metrics?.recordDistribution(
            'risk_ai_call_duration_ms',
            performance.now() - aiStartedAt,
          );
        }
        this.paidAssessments.remember(event.eventId, assessment);
      }
    }
    const result = assessment
      ? this.scoring.applyAssessment(baseline, ruleSet, assessment)
      : baseline;
    const decision: Prepared = {
      transferId: transfer.transferId,
      ruleSetVersion: ruleSet.version,
      result,
      snapshot,
      assessment,
      won: false,
    };
    return decision;
  }

  protected async apply(
    event: DomainEvent,
    manager: EntityManager,
    prepared?: unknown,
  ): Promise<void> {
    const decision = prepared as Prepared | null | undefined;
    if (!decision) return;
    decision.won = false; // a deadlock retry runs this again from the start
    decision.flagLagMs = undefined;
    const { result } = decision;
    const ai = persistedAssessment(result.aiStatus, decision.assessment);
    const claimed: unknown[] = await manager.query(CLAIM_DECISION, [
      decision.transferId,
      event.eventId,
      decision.ruleSetVersion,
      result.mode,
      result.ruleScore,
      JSON.stringify(decision.snapshot),
      result.aiStatus,
      result.aiAppliedWeight,
      ai.probability,
      ai.provider,
      ai.requestedModel,
      ai.responseModel,
      ai.rubricSha256,
      ai.inputSha256,
      ai.requestId,
    ]);
    if (claimed.length === 0) return; // another event of this transfer decided first
    decision.won = true;
    if (result.level === 'LOW') return;
    // `occurredAt` is `transfers.created_at` and `created_at` of the flag is the clock of the same
    // database, so the difference is the SLO measure of docs/03 §14 (transfer -> flag, p95 < 5 s).
    const flagged = await manager.query<{ lag_ms: number }[]>(
      `INSERT INTO fraud_flags(transfer_id, score, risk_level, rule_set_version) VALUES ($1, $2, $3, $4)
       RETURNING (EXTRACT(EPOCH FROM created_at - $5::timestamptz) * 1000)::float8 AS lag_ms`,
      [decision.transferId, result.score, result.level, decision.ruleSetVersion, event.occurredAt],
    );
    decision.flagLagMs = Number(flagged[0]?.lag_ms);
    for (const hit of result.hits) {
      await manager.query(
        `INSERT INTO fraud_rule_hits(transfer_id, rule_id, weight, explanation) VALUES ($1, $2, $3, $4)`,
        [decision.transferId, hit.id, hit.weight, hit.explanation],
      );
    }
    await this.audit.record(manager, {
      actor: null,
      role: 'worker',
      action: 'fraud.flagged',
      outcome: 'SUCCESS',
      target: { type: 'transfer', id: decision.transferId },
      correlationId: event.correlationId,
      metadata: { count: result.hits.length },
    });
  }

  protected override onCommitted(event: DomainEvent, prepared?: unknown): void {
    const decision = prepared as Prepared | null | undefined;
    this.paidAssessments.forget(event.eventId);
    if (!decision?.won) return;
    // Labels are the fixed `ai_status` values only; no id, no amount (see risk-scoring.metrics).
    countDecision(decision.result.aiStatus);
    if (decision.flagLagMs !== undefined && Number.isFinite(decision.flagLagMs)) {
      this.metrics?.recordDistribution('risk_transfer_to_flag_ms', decision.flagLagMs);
    }
    // Ids, the level and the rule ids only: no amount and no explanation in the logs.
    this.logger.log(
      {
        eventId: event.eventId,
        transferId: decision.transferId,
        riskLevel: decision.result.level,
        ruleSetVersion: decision.ruleSetVersion,
        rules: decision.result.hits.map(hit => hit.id),
      },
      'Risk decision recorded',
    );
  }
}
