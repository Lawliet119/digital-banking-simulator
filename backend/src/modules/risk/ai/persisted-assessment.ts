import type { AiAssessment, AiStatus } from './ai-contract';

/** The `risk_decisions` columns that come from the provider's answer. */
export interface PersistedAssessment {
  readonly probability: number | null;
  readonly provider: string | null;
  readonly requestedModel: string | null;
  readonly responseModel: string | null;
  readonly rubricSha256: string | null;
  readonly inputSha256: string | null;
  readonly requestId: string | null;
}

const EMPTY: PersistedAssessment = {
  probability: null,
  provider: null,
  requestedModel: null,
  responseModel: null,
  rubricSha256: null,
  inputSha256: null,
  requestId: null,
};

/**
 * Columns to store next to the *final* `aiStatus`. `ScoringService.applyAssessment` may turn a
 * provider SUCCEEDED into INVALID_RESPONSE (probability out of range) or CONFIG_INVALID (weight would
 * overflow the score); the table then requires `probability IS NULL` (and, for CONFIG_INVALID, no
 * `response_model` or `provider_request_id`). Binding the raw answer instead would fail the CHECK,
 * dead-letter the event and spend the AI budget again on every retry.
 */
export function persistedAssessment(
  aiStatus: AiStatus,
  assessment: AiAssessment | undefined,
): PersistedAssessment {
  if (!assessment) return EMPTY;
  return {
    probability: aiStatus === 'SUCCEEDED' ? assessment.probability : null,
    provider: assessment.provider,
    requestedModel: assessment.requestedModel,
    responseModel: aiStatus === 'CONFIG_INVALID' ? null : assessment.responseModel,
    rubricSha256: assessment.rubricSha256,
    inputSha256: assessment.inputSha256,
    requestId: aiStatus === 'CONFIG_INVALID' ? null : assessment.requestId,
  };
}
