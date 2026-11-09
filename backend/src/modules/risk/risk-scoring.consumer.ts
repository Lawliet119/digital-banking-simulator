import { Inject, Injectable, Logger } from '@nestjs/common';
import { type ConfigType } from '@nestjs/config';
import { PinoLogger } from 'nestjs-pino';
import { DataSource, type EntityManager } from 'typeorm';
import { sqsConfig } from '@config/sqs.config';
import type { DomainEvent } from '@common/events';
import { ConsumerBase, type UnknownEventPolicy } from '@common/messaging';
import { TransactionService } from '@database/transaction.service';
import { PoisonMessageError, SqsClient } from '@libs/sqs';
import { AuditService } from '@modules/audit';
import type { FeatureInput } from './ai/ai-contract';
import { toAiFeatureInput } from './ai/feature-projection';
import { RuleSetRepository } from './config/rule-set.repository';
import type { RuleSet } from './config/rule-set';
import { OnlineFeatureProvider } from './features/online-feature-provider';
import { ScoringService, type ScoringConfig, type ScoringResult } from './scoring.service';

/** `processed_events.consumer` of this module. */
export const RISK_CONSUMER = 'risk';

/** What `prepare` hands to the transaction; `won` is set there when this delivery made the decision. */
interface Prepared {
  readonly transferId: string;
  readonly ruleSetVersion: number;
  readonly result: ScoringResult;
  readonly snapshot: FeatureInput;
  won: boolean;
}

/** No conflict target: both unique indexes of risk_decisions are arbiters, so a loser gets 0 rows, never 23505 (RSK-01). */
const CLAIM_DECISION = `
  INSERT INTO risk_decisions
    (transfer_id, event_id, rule_set_version, mode, rule_score, feature_snapshot, ai_status, ai_applied_weight)
  VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8)
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
  /** Versions already warned about: their AI call is not wired yet (one warning each). */
  private readonly warnedVersions = new Set<number>();

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
    const features = await this.features.extract(transfer);
    const result = this.scoring.score(transfer, features, this.scoringConfig(ruleSet));
    if (!result) return null;
    const decision: Prepared = {
      transferId: transfer.transferId,
      ruleSetVersion: ruleSet.version,
      result,
      snapshot: toAiFeatureInput(transfer, features),
      won: false,
    };
    return decision;
  }

  /**
   * ADR-14 (b): a broken `ai.*` block is scored with the version's own mode, which records
   * `CONFIG_INVALID` with no AI weight. A valid block cannot be honoured until the AI call is wired
   * (DoD #9), so the rules alone score it and the decision says `rule_only`: what was really done.
   */
  private scoringConfig(ruleSet: RuleSet): ScoringConfig {
    if (ruleSet.mode !== 'rules_with_external_ai' || ruleSet.aiConfigInvalid) return ruleSet;
    if (!this.warnedVersions.has(ruleSet.version)) {
      this.warnedVersions.add(ruleSet.version);
      this.logger.warn(
        { ruleSetVersion: ruleSet.version },
        'Rule set asks for AI, which is not wired yet: scoring rule_only',
      );
    }
    return { ...ruleSet, mode: 'rule_only' };
  }

  protected async apply(
    event: DomainEvent,
    manager: EntityManager,
    prepared?: unknown,
  ): Promise<void> {
    const decision = prepared as Prepared | null | undefined;
    if (!decision) return;
    decision.won = false; // a deadlock retry runs this again from the start
    const { result } = decision;
    const claimed: unknown[] = await manager.query(CLAIM_DECISION, [
      decision.transferId,
      event.eventId,
      decision.ruleSetVersion,
      result.mode,
      result.ruleScore,
      JSON.stringify(decision.snapshot),
      result.aiStatus,
      result.aiAppliedWeight,
    ]);
    if (claimed.length === 0) return; // another event of this transfer decided first
    decision.won = true;
    if (result.level === 'LOW') return;
    await manager.query(
      `INSERT INTO fraud_flags(transfer_id, score, risk_level, rule_set_version) VALUES ($1, $2, $3, $4)`,
      [decision.transferId, result.score, result.level, decision.ruleSetVersion],
    );
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
    if (!decision?.won) return;
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
