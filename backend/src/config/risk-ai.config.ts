import { registerAs } from '@nestjs/config';
import { validateEnv } from './validation.schema';

export const riskAiConfig = registerAs('riskAi', () => {
  const env = validateEnv(process.env);
  return {
    approved: env.RISK_AI_EGRESS_APPROVED,
    policyRevision: env.RISK_AI_POLICY_REVISION,
    dailyRequestLimit: env.RISK_AI_DAILY_REQUEST_CAP,
    concurrentLimit: env.RISK_AI_CONCURRENCY,
    gateTimeoutMs: env.RISK_AI_GATE_TIMEOUT_MS,
    apiKey: env.OPENAI_API_KEY,
  };
});
