import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  type HealthCheckResult,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';
import { Public } from '@common/auth/public.decorator';
import { RedisClient, RedisUnavailableError } from '@libs/redis';

export type ReadinessResult = HealthCheckResult & { redis: 'up' | 'degraded' };

/**
 * Probes for the load balancer. Mounted without a version prefix (`/health/live`,
 * `/health/ready`) so the path stays stable across API versions.
 *
 * Only PostgreSQL gates readiness (docs/03 §9.3). Redis is reported informationally:
 * its outage/timeout must not take instances out of ALB rotation (DBS-78).
 *
 * Both routes are @Public(): the ALB and any uninstrumented client call them with no token
 * (DBS-50 — JwtAuthGuard is the default global guard, so every other controller needs one).
 */
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
@Public()
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
    private readonly redis: RedisClient,
  ) {}

  /** The process is up. Used as the liveness probe: a failure restarts the task. */
  @Get('live')
  @ApiOperation({
    summary: 'Liveness probe',
    description:
      '[Public] The process is up. Used as the liveness probe: a failure restarts the task.',
  })
  @ApiOkResponse({
    description: 'Process is healthy and running.',
    schema: {
      type: 'object',
      required: ['status'],
      properties: {
        status: { type: 'string', enum: ['ok'], example: 'ok' },
      },
    },
  })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** The process can reach PostgreSQL. A failure removes the task from the load balancer. */
  @Get('ready')
  @ApiOperation({
    summary: 'Readiness: PostgreSQL required, Redis informational (up/degraded)',
    description:
      '[Public] The process can reach PostgreSQL. A failure removes the task from the load balancer. Redis is informational.',
  })
  @ApiOkResponse({
    description:
      'PostgreSQL ready. Redis is informational and may be degraded without draining the task.',
    schema: {
      type: 'object',
      required: ['status', 'info', 'error', 'details', 'redis'],
      properties: {
        status: { type: 'string', enum: ['ok'], example: 'ok' },
        redis: { type: 'string', enum: ['up', 'degraded'], example: 'up' },
        info: {
          type: 'object',
          additionalProperties: true,
          example: { database: { status: 'up' } },
        },
        error: { type: 'object', additionalProperties: true, example: {} },
        details: {
          type: 'object',
          additionalProperties: true,
          example: { database: { status: 'up' } },
        },
      },
    },
  })
  @HealthCheck()
  async ready(): Promise<ReadinessResult> {
    const database = await this.health.check([
      () => this.db.pingCheck('database', { timeout: 1500 }),
    ]);
    let redis: 'up' | 'degraded';
    try {
      redis = (await this.redis.ping()) === 'PONG' ? 'up' : 'degraded';
    } catch (error) {
      if (!(error instanceof RedisUnavailableError)) throw error;
      redis = 'degraded';
    }
    return { ...database, redis };
  }
}
