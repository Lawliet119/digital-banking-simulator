import { registerAs } from '@nestjs/config';
import { parsePositiveMoney } from '../common/money';
import { validateEnv } from './validation.schema';

/** Business limits (docs/BRD.md BR-06) and protection thresholds (NFR-SEC-05, same file). */
export const limitsConfig = registerAs('limits', () => {
  const env = validateEnv(process.env);
  return {
    transfer: {
      /** Maximum amount of one transfer, in dong. `Money` (`bigint`): money is never a float (BR-01). */
      perTx: parsePositiveMoney(env.TRANSFER_LIMIT_PER_TX),
      /** Maximum total a source account may send per day (Vietnam time), in dong. */
      perDay: parsePositiveMoney(env.TRANSFER_LIMIT_PER_DAY),
    },
    idempotencyKeyRetentionDays: env.IDEMPOTENCY_KEY_RETENTION_DAYS,
    rateLimit: {
      transfersPerMinute: env.RATE_LIMIT_TRANSFERS_PER_MINUTE,
      requestsPerIpPerMinute: env.RATE_LIMIT_REQUESTS_PER_IP_PER_MINUTE,
    },
  };
});
