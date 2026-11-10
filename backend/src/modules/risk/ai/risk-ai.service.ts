import { Logger } from '@nestjs/common';
import type { ConfigType } from '@nestjs/config';
import { databaseConfig } from '@config/database.config';
import { riskAiConfig } from '@config/risk-ai.config';
import { buildSslOptions } from '@database/pg-ssl';
import type { RuleSet } from '../config/rule-set';
import { AiGate } from './ai-gate';
import type { AiAssessment, FeatureInput } from './ai-contract';
import { assess, resolveDecisionAiStatus } from './openai-decisions';

/** Worker-only composition. No endpoint is configurable; the assessor seam is for loopback tests. */
export class RiskAiService {
  private readonly gate: AiGate;

  constructor(
    private readonly config?: ConfigType<typeof riskAiConfig>,
    database?: ConfigType<typeof databaseConfig>,
    private readonly assessor: typeof assess = assess,
  ) {
    this.gate = new AiGate(
      config?.approved &&
        config.policyRevision &&
        config.dailyRequestLimit &&
        config.concurrentLimit &&
        config.gateTimeoutMs &&
        database
        ? {
            connectionString: database.url,
            ssl: buildSslOptions({ enabled: database.ssl, caPath: database.sslCaPath }),
            policy: {
              revision: config.policyRevision,
              dailyRequestLimit: config.dailyRequestLimit,
              concurrentLimit: config.concurrentLimit,
            },
            deadlineMs: config.gateTimeoutMs,
          }
        : undefined,
    );
    // An approved egress whose gate can never open would silently record UNAVAILABLE for every transfer.
    const problem = config?.approved ? this.gate.configurationProblem() : undefined;
    if (problem) {
      new Logger(RiskAiService.name).error(
        `RISK_AI_EGRESS_APPROVED is true but the AI gate cannot open: ${problem}. Every AI-scored transfer will record UNAVAILABLE.`,
      );
    }
  }

  async evaluate(
    snapshot: FeatureInput,
    ruleSet: RuleSet,
    selectedAtMonotonicMs: number,
  ): Promise<AiAssessment> {
    const ai = ruleSet.ai!; // Called only after ScoringService validated this version's AI block.
    const answer = await this.assessor(snapshot, {
      enabled: true,
      apiKey: this.config?.apiKey || null,
      model: ai.model,
      rubric: ai.rubric,
      requestTimeoutMs: ai.requestTimeoutMs,
      maxAdmissionDelayMs: ai.maxAdmissionDelayMs,
      selectedAtMonotonicMs,
      tryAcquire: () => this.gate.tryAcquire(),
    });
    return { ...answer, status: resolveDecisionAiStatus('rules_with_external_ai', answer.status) };
  }
}
