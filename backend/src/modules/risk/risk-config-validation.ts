import { BadRequestException } from '@nestjs/common';
import { parseRuleSet } from './config/rule-set';

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

/**
 * Strict write boundary (BL-188). Besides the exact key sets it runs `parseRuleSet`, the check the
 * worker applies when it reads a version, and that check asks each rule to accept its own
 * parameters: there is no second list of ranges to drift from the rules. The worker keeps its
 * separate lenient read policy for `ai.*`; the API does not.
 */
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
    parseRuleSet(1, raw);
    if (hasAi && parseRuleSet(1, { ...raw, mode: 'rules_with_external_ai' }).aiConfigInvalid) {
      throw new BadRequestException('Invalid risk configuration');
    }
    return raw;
  } catch {
    throw new BadRequestException('Invalid risk configuration');
  }
}
