export interface FeatureInput {
  amount: string;
  fromBalanceBefore: string;
  accountAgeHours: number;
  sameOwner: boolean;
  txCount10m: number;
  txCount1h: number;
  historyCount30d: number;
  medianAmount30d: string | null;
  minutesSinceReverse: number | null;
  newRecipients1h: number;
  distinctRecipients24h: number;
}

export type AiStatus =
  | 'DISABLED'
  | 'CONFIG_INVALID'
  | 'SUCCEEDED'
  | 'REFUSED'
  | 'INVALID_RESPONSE'
  | 'UNAVAILABLE'
  | 'BUDGET_EXHAUSTED';

export interface AiAssessment {
  status: AiStatus;
  probability: number | null;
  provider: 'openai' | null;
  requestedModel: string | null;
  responseModel: string | null;
  requestId: string | null;
  rubricSha256: string | null;
  inputSha256: string | null;
  usage: { inputTokens: number; cachedTokens: number; cacheWriteTokens: number } | null;
}

export type PermitResult =
  { kind: 'granted'; release: () => void } | { kind: 'budget_exhausted' } | { kind: 'unavailable' };

export interface DecisionOptions {
  enabled: boolean;
  apiKey: string | null;
  model: string;
  requestTimeoutMs: number;
  maxAdmissionDelayMs: number;
  selectedAtMonotonicMs: number;
  tryAcquire: () => PermitResult;
}
