import { registerAs } from '@nestjs/config';
import { validateEnv } from './validation.schema';

/**
 * Metric export (DBS-144, docs/03 §14). `enabled` is the explicit METRICS_EMF when set, otherwise
 * on in the deployed environments (staging, production), where the `awslogs` driver turns the
 * EMF lines into CloudWatch metrics, and off elsewhere so a developer's terminal stays quiet.
 */
export const metricsConfig = registerAs('metrics', () => {
  const env = validateEnv(process.env);
  return {
    enabled: env.METRICS_EMF ?? (env.NODE_ENV === 'staging' || env.NODE_ENV === 'production'),
    flushMs: env.METRICS_FLUSH_MS,
  };
});
