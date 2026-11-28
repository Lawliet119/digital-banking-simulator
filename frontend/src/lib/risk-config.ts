export const RULE_IDS = ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'] as const;
export type RuleId = (typeof RULE_IDS)[number];

export interface RuleView {
  id: RuleId;
  enabled: boolean;
  weight: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The rules of a configuration that can be drawn: those with a boolean `enabled` and a numeric
 * `weight`. Only for display; what is valid is the server's decision.
 */
export function readRules(config: unknown): RuleView[] {
  const rules = record(record(config)?.rules);
  return RULE_IDS.flatMap(id => {
    const rule = record(rules?.[id]);
    return rule && typeof rule.enabled === 'boolean' && typeof rule.weight === 'number'
      ? [{ id, enabled: rule.enabled, weight: rule.weight }]
      : [];
  });
}

export function readThresholds(config: unknown): { medium: number; high: number } | undefined {
  const thresholds = record(record(config)?.thresholds);
  const { medium, high } = thresholds ?? {};
  return typeof medium === 'number' && typeof high === 'number' ? { medium, high } : undefined;
}

/** The JSON text of a configuration, or `undefined` when the text is not a JSON object. */
export function parseConfig(text: string): Record<string, unknown> | undefined {
  try {
    return record(JSON.parse(text));
  } catch {
    return undefined;
  }
}

/** The same configuration text with one weight changed; unchanged when the rule is not there. */
export function withWeight(text: string, id: RuleId, weight: number): string {
  const config = parseConfig(text);
  const rule = record(record(config?.rules)?.[id]);
  if (!config || !rule) return text;
  rule.weight = weight;
  return JSON.stringify(config, null, 2);
}
