import { registerAs } from '@nestjs/config';
import { validateEnv } from './validation.schema';

export const sqsConfig = registerAs('sqs', () => {
  const env = validateEnv(process.env);
  return {
    region: env.AWS_REGION,
    /** Set only for local ElasticMQ; undefined on AWS so the SDK uses the real endpoint. */
    endpoint: env.SQS_ENDPOINT,
    riskQueueUrl: env.SQS_RISK_QUEUE_URL,
    notificationQueueUrl: env.SQS_NOTIFICATION_QUEUE_URL,
  };
});
