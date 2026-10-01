import { Controller, Get, VERSION_NEUTRAL } from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import {
  HealthCheck,
  type HealthCheckResult,
  HealthCheckService,
  TypeOrmHealthIndicator,
} from '@nestjs/terminus';

/**
 * Probes for the load balancer. Mounted without a version prefix (`/health/live`,
 * `/health/ready`) so the path stays stable across API versions.
 *
 * Redis is deliberately NOT part of readiness: the system is correct without it (docs/03 §9.3),
 * so a Redis outage must not take instances out of rotation. It will be reported as "degraded"
 * on a separate status endpoint, never as "down".
 */
@ApiTags('health')
@Controller({ path: 'health', version: VERSION_NEUTRAL })
export class HealthController {
  constructor(
    private readonly health: HealthCheckService,
    private readonly db: TypeOrmHealthIndicator,
  ) {}

  /** The process is up. Used as the liveness probe: a failure restarts the task. */
  @Get('live')
  @ApiOperation({ summary: 'Liveness probe' })
  live(): { status: 'ok' } {
    return { status: 'ok' };
  }

  /** The process can reach PostgreSQL. A failure removes the task from the load balancer. */
  @Get('ready')
  @HealthCheck()
  @ApiOperation({ summary: 'Readiness probe (checks PostgreSQL)' })
  ready(): Promise<HealthCheckResult> {
    return this.health.check([() => this.db.pingCheck('database', { timeout: 1500 })]);
  }
}
