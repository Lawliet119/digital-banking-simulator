import { Counter, register } from 'prom-client';
import type { TransferCompleted } from '@common/events';
import type { AiAssessment, AiStatus } from './ai/ai-contract';
import type { Features, TransferEvent } from './features/feature-provider';
import { R1VelocityRule } from './rules/r1-velocity.rule';
import { R2UnusualAmountRule } from './rules/r2-unusual-amount.rule';
import { R3NewAccountLargeTransferRule } from './rules/r3-new-account-large-transfer.rule';
import { R4RoundTripRule } from './rules/r4-round-trip.rule';
import { R5FanOutRule } from './rules/r5-fan-out.rule';
import { R6DrainRule } from './rules/r6-drain.rule';
import type { RiskRule, RuleHit, RuleId, RuleParams } from './rules/rule';

const MAX_SCORE = 2_147_483_647;
const rules: readonly RiskRule[] = [
  new R1VelocityRule(),
  new R2UnusualAmountRule(),
  new R3NewAccountLargeTransferRule(),
  new R4RoundTripRule(),
  new R5FanOutRule(),
  new R6DrainRule(),
];
const existingCounter = register.getSingleMetric('risk_unsupported_mode_total');
const unsupportedMode =
  existingCounter instanceof Counter
    ? existingCounter
    : new Counter({
        name: 'risk_unsupported_mode_total',
        help: 'Risk scoring attempts that fall back to rule-only for an unsupported mode',
        registers: [register],
      });

export interface ScoringConfig {
  readonly mode?: string;
  readonly thresholds: { readonly medium: number; readonly high: number };
  readonly rules: Readonly<Record<RuleId, RuleParams>>;
  readonly ai?: { readonly threshold: number; readonly weight: number };
}

export interface ScoringResult {
  readonly mode: 'rule_only' | 'rules_with_external_ai';
  readonly hits: readonly RuleHit[];
  readonly ruleScore: number;
  readonly aiAppliedWeight: number;
  readonly score: number;
  readonly level: 'LOW' | 'MEDIUM' | 'HIGH';
  readonly aiStatus: AiStatus;
}

/** Scores already-extracted facts. It never reads a store or calls the external provider. */
export class ScoringService {
  score(
    event: TransferCompleted,
    features: Features,
    config: ScoringConfig,
    assessment?: AiAssessment | null,
  ): ScoringResult | null {
    if (!event || (event.type as string) !== 'TRANSFER') return null;
    if (!config || typeof config !== 'object' || Array.isArray(config)) {
      throw new Error('Invalid risk scoring configuration');
    }
    const mode =
      config.mode === undefined || config.mode === 'rule_only'
        ? 'rule_only'
        : config.mode === 'rules_with_external_ai'
          ? 'rules_with_external_ai'
          : 'rule_only';
    if (
      config.mode !== undefined &&
      config.mode !== 'rule_only' &&
      config.mode !== 'rules_with_external_ai'
    ) {
      unsupportedMode.inc();
    }
    const medium = config.thresholds?.medium;
    const high = config.thresholds?.high;
    if (
      !Number.isSafeInteger(medium) ||
      !Number.isSafeInteger(high) ||
      medium < 1 ||
      high <= medium ||
      high > MAX_SCORE
    ) {
      throw new Error('Invalid risk level configuration');
    }
    if (!config.rules || typeof config.rules !== 'object' || Array.isArray(config.rules)) {
      throw new Error('Invalid risk rule configuration');
    }
    const hits: RuleHit[] = [];
    let ruleScore = 0;
    for (const rule of rules) {
      const params = config.rules[rule.id];
      if (!params || typeof params !== 'object' || Array.isArray(params)) {
        throw new Error('Invalid risk rule configuration');
      }
      const hit = rule.evaluate(event as TransferEvent, features, params);
      if (hit === null) continue;
      if (
        hit.id !== rule.id ||
        hit.weight !== params.weight ||
        typeof hit.explanation !== 'string' ||
        hit.explanation.length === 0
      ) {
        throw new Error('Invalid risk rule result');
      }
      ruleScore += hit.weight;
      if (!Number.isSafeInteger(ruleScore) || ruleScore < 0 || ruleScore > MAX_SCORE) {
        throw new Error('Risk rule score overflow');
      }
      hits.push(hit);
    }

    let aiStatus: AiStatus = 'DISABLED';
    let aiAppliedWeight = 0;
    if (mode === 'rules_with_external_ai') {
      let threshold: unknown;
      let weight: unknown;
      try {
        const ai = config.ai;
        if (ai && typeof ai === 'object' && !Array.isArray(ai)) {
          threshold = ai.threshold;
          weight = ai.weight;
        }
      } catch {
        // An unusable AI configuration must not discard a valid baseline.
      }
      if (
        typeof threshold !== 'number' ||
        !Number.isFinite(threshold) ||
        threshold <= 0 ||
        threshold > 1 ||
        typeof weight !== 'number' ||
        !Number.isInteger(weight) ||
        weight < 0 ||
        weight > MAX_SCORE
      ) {
        aiStatus = 'CONFIG_INVALID';
      } else if (assessment === null || assessment === undefined) {
        aiStatus = 'UNAVAILABLE';
      } else if (typeof assessment !== 'object') {
        aiStatus = 'INVALID_RESPONSE';
      } else {
        try {
          if (Array.isArray(assessment)) throw new Error('Invalid AI assessment');
          const status = assessment.status;
          const probability = assessment.probability;
          if (status === 'SUCCEEDED') {
            if (
              typeof probability !== 'number' ||
              !Number.isFinite(probability) ||
              probability < 0 ||
              probability > 1
            ) {
              aiStatus = 'INVALID_RESPONSE';
            } else if (probability >= threshold && ruleScore + weight > MAX_SCORE) {
              aiStatus = 'CONFIG_INVALID';
            } else {
              aiStatus = 'SUCCEEDED';
              if (probability >= threshold) aiAppliedWeight = weight;
            }
          } else if (status === 'DISABLED') {
            aiStatus = 'CONFIG_INVALID';
          } else if (
            probability === null &&
            (status === 'CONFIG_INVALID' ||
              status === 'REFUSED' ||
              status === 'INVALID_RESPONSE' ||
              status === 'UNAVAILABLE' ||
              status === 'BUDGET_EXHAUSTED')
          ) {
            aiStatus = status;
          } else {
            aiStatus = 'INVALID_RESPONSE';
          }
        } catch {
          // Malformed AI assessment: keep the independently computed rule score.
          aiStatus = 'INVALID_RESPONSE';
          aiAppliedWeight = 0;
        }
      }
    }
    const score = ruleScore + aiAppliedWeight;
    return {
      mode,
      hits,
      ruleScore,
      aiAppliedWeight,
      score,
      level: score >= high ? 'HIGH' : score >= medium ? 'MEDIUM' : 'LOW',
      aiStatus,
    };
  }
}
