import type { Features, TransferEvent } from '../features/feature-provider';

export type { TransferEvent } from '../features/feature-provider';

export type RuleId = 'R1' | 'R2' | 'R3' | 'R4' | 'R5' | 'R6';

export interface RuleHit {
  readonly id: RuleId;
  readonly weight: number;
  readonly explanation: string;
}

/** Versioned rule settings are validated by the later risk-config task. */
export interface RuleParams {
  readonly enabled: boolean;
  readonly weight: number;
  readonly thresholds: Readonly<Record<string, number | string>>;
}

/** Rules are synchronous and must not access Redis, SQL, HTTP or the system clock. */
export interface RiskRule {
  readonly id: RuleId;
  evaluate(event: TransferEvent, features: Features, params: RuleParams): RuleHit | null;
}
