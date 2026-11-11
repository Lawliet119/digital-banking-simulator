import { BadRequestException } from '@nestjs/common';
import type { Features, TransferEvent } from './features/feature-provider';
import { parseRuleSet } from './config/rule-set';
import { ScoringService } from './scoring.service';

const RULE_KEYS: Record<string, readonly string[]> = {
  R1: ['enabled', 'weight', 'maxTransfers', 'windowMinutes'],
  R2: ['enabled', 'weight', 'medianMultiplier', 'historyDays', 'minHistory'],
  R3: ['enabled', 'weight', 'maxAccountAgeHoursExclusive', 'minAmountExclusive'],
  R4: ['enabled', 'weight', 'reverseWindowMinutes'],
  R5: ['enabled', 'weight', 'minNewRecipients', 'windowMinutes', 'noveltyDays'],
  R6: ['enabled', 'weight', 'minBalancePercent', 'minBalance'],
};
const RULE_IDS = Object.keys(RULE_KEYS);
const EXEMPTION_KEY = ['sameOwnerExempt'] as const;
const NO_OPTIONAL_KEYS: readonly string[] = [];
const AI_KEYS = [
  'provider',
  'model',
  'rubric',
  'threshold',
  'weight',
  'maxAdmissionDelayMs',
  'requestTimeoutMs',
] as const;

// Every rule validates its configuration before scoring this valid synthetic transfer.
const PROBE: TransferEvent = {
  eventType: 'TransferCompleted',
  eventId: '00000000-0000-4000-8000-000000000001',
  correlationId: '00000000-0000-4000-8000-000000000002',
  transferId: '00000000-0000-4000-8000-000000000003',
  fromAccountId: '00000000-0000-4000-8000-000000000004',
  toAccountId: '00000000-0000-4000-8000-000000000005',
  fromUserId: '00000000-0000-4000-8000-000000000006',
  toUserId: '00000000-0000-4000-8000-000000000007',
  type: 'TRANSFER',
  amount: '1',
  fromBalanceBefore: '1',
  sameOwner: false,
  occurredAt: '2026-01-02T00:00:00.000Z',
  fromAccountCreatedAt: '2026-01-01T00:00:00.000Z',
  toAccountCreatedAt: '2026-01-01T00:00:00.000Z',
};
const FACTS: Features = {
  txCount10m: 1,
  txCount1h: 1,
  historyCount30d: 0,
  medianAmount30dTimes2: null,
  reverseTransferOccurredAt: null,
  newRecipients1h: 1,
  distinctRecipients24h: 1,
  sumOut24h: '1',
  smallTxCount24h: 1,
};
const scoring = new ScoringService();

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function keys(value: unknown, required: readonly string[], optional: readonly string[] = []): void {
  if (
    !object(value) ||
    required.some(key => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(key => !required.includes(key) && !optional.includes(key))
  ) {
    throw new BadRequestException('Invalid risk configuration');
  }
}

/** Strict write boundary; the worker retains its separate legacy/fallback read policy. */
export function validateRiskConfig(raw: unknown): Record<string, unknown> {
  keys(raw, ['mode', 'thresholds', 'rules'], ['ai', 'ml']);
  if (!object(raw)) throw new BadRequestException('Invalid risk configuration');
  if (raw.mode !== 'rule_only' && raw.mode !== 'rules_with_external_ai') {
    throw new BadRequestException('Invalid risk configuration');
  }
  keys(raw.thresholds, ['medium', 'high']);
  keys(raw.rules, RULE_IDS);
  if (!object(raw.rules)) throw new BadRequestException('Invalid risk configuration');
  for (const [id, expected] of Object.entries(RULE_KEYS)) {
    const optional = id === 'R5' || id === 'R6' ? EXEMPTION_KEY : NO_OPTIONAL_KEYS;
    keys(raw.rules[id], expected, optional);
  }
  if (Object.hasOwn(raw, 'ml')) {
    keys(raw.ml, ['enabled']);
    if (!object(raw.ml) || raw.ml.enabled !== false) {
      throw new BadRequestException('Invalid risk configuration');
    }
  }
  const hasAi = Object.hasOwn(raw, 'ai');
  if (hasAi || raw.mode === 'rules_with_external_ai') keys(raw.ai, AI_KEYS);
  try {
    const selected = parseRuleSet(1, raw);
    if (hasAi && parseRuleSet(1, { ...raw, mode: 'rules_with_external_ai' }).aiConfigInvalid) {
      throw new BadRequestException('Invalid risk configuration');
    }
    scoring.score(PROBE, FACTS, selected);
    return raw;
  } catch {
    throw new BadRequestException('Invalid risk configuration');
  }
}
