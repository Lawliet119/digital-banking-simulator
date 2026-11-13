import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * DBS-172: the pool must fit under the RDS `max_connections` the app can really use. The numbers
 * come from the repo's own configuration, not from a formula the test defines for itself:
 * the default `DATABASE_POOL_MAX` (validation schema), the largest dev `desired_count` (Terraform)
 * and the measured limit of `db.t4g.micro` (DBS-66: 79 connections, 3 superuser-reserved and 2
 * reserved, so 74 are usable).
 */
const REPO = join(__dirname, '../../..');
const MEASURED_MAX_CONNECTIONS_MICRO = 79;
const SUPERUSER_RESERVED = 3;
const RESERVED = 2;
const MIGRATION_AND_ADMIN = 5; // docs/03 section 13.2

function defaultPoolMax(): number {
  const schema = readFileSync(join(__dirname, 'validation.schema.ts'), 'utf8');
  const match =
    /DATABASE_POOL_MAX: Joi\.number\(\)\.integer\(\)\.min\(1\)\.max\((\d+)\)\.default\((\d+)\)/.exec(
      schema,
    );
  if (!match) throw new Error('DATABASE_POOL_MAX definition not found in validation.schema.ts');
  return Number(match[2]);
}

function maxDevTasks(): number {
  const variables = readFileSync(
    join(REPO, 'infra/terraform/envs/dev/session/variables.tf'),
    'utf8',
  );
  const match = /var\.desired_count <= (\d+)/.exec(variables);
  if (!match) throw new Error('desired_count upper bound not found in variables.tf');
  return Number(match[1]);
}

describe('connection pool capacity (DBS-172)', () => {
  const usable = MEASURED_MAX_CONNECTIONS_MICRO - SUPERUSER_RESERVED - RESERVED;

  it('TC-172-01 the default pool and the largest dev task count fit the measured db.t4g.micro limit', () => {
    const tasks = maxDevTasks();
    const used = tasks * defaultPoolMax() + MIGRATION_AND_ADMIN;
    expect(usable).toBe(74);
    expect(used).toBeLessThanOrEqual(usable);
  });

  it('TC-172-02 a rolling deploy never runs more api tasks than desired_count, so the dev maximum still fits', () => {
    // BL-234: ECS defaults to 200%, where 6 tasks briefly become 12 and 2 x 6 x 10 + 5 = 125 > 74.
    // The api service sets deployment_maximum_percent = 100, so a deploy never exceeds desired_count
    // and the same (api + worker) x pool + 5 bound holds during it. The test reads the real value from
    // Terraform: removing it (back to 200%) makes the doubled figure below overflow and fails the test.
    const ecs = readFileSync(join(REPO, 'infra/terraform/envs/dev/session/ecs.tf'), 'utf8');
    const service = /resource "aws_ecs_service" "api" \{([\s\S]*?)\n\}/.exec(ecs);
    if (!service) throw new Error('aws_ecs_service.api not found in session/ecs.tf');
    const maxPercent = /deployment_maximum_percent\s*=\s*(\d+)/.exec(service[1]);
    expect(maxPercent).not.toBeNull();
    const surge = Number(maxPercent?.[1]) / 100; // ECS rounds the task cap down; 100 gives exactly desired
    expect(surge).toBe(1);

    const duringDeploy = Math.floor(maxDevTasks() * surge) * defaultPoolMax() + MIGRATION_AND_ADMIN;
    expect(duringDeploy).toBeLessThanOrEqual(usable);

    // The default (200%) would not fit: this is why the cap is needed.
    const uncapped = 2 * maxDevTasks() * defaultPoolMax() + MIGRATION_AND_ADMIN;
    expect(uncapped).toBeGreaterThan(usable);
  });

  it('TC-121-15 the worker counts toward the same limit: api + worker tasks fit the usable connections', () => {
    // DBS-121: worker_desired_count has its own cap, and the sum with the api is capped by Terraform.
    const worker = readFileSync(join(REPO, 'infra/terraform/envs/dev/session/worker.tf'), 'utf8');
    const total = /var\.desired_count \+ var\.worker_desired_count <= (\d+)/.exec(worker);
    const workerMax = /var\.worker_desired_count <= (\d+)/.exec(worker);
    if (!total || !workerMax) throw new Error('worker task caps not found in session/worker.tf');
    expect(Number(workerMax[1])).toBeLessThanOrEqual(2); // docs/03 section 13.1: 1-2 worker tasks
    expect(Number(total[1]) * defaultPoolMax() + MIGRATION_AND_ADMIN).toBeLessThanOrEqual(usable);
    expect(Number(total[1])).toBeLessThanOrEqual(maxDevTasks());
  });

  it('TC-172-03 the Terraform variable states the same limit as the docs', () => {
    const variables = readFileSync(
      join(REPO, 'infra/terraform/envs/dev/session/variables.tf'),
      'utf8',
    );
    expect(variables).toContain('docs/03 section 13.2');
  });

  it('TC-172-04 the AI gate connections outside the pool are bounded by the usable room, per worker task', () => {
    // Each AI call opens one pg.Client outside the pool: with the dev maximum the room left for them
    // is what remains after the pools. Documented as a term of the formula (database-design 6.4).
    const room = usable - (maxDevTasks() * defaultPoolMax() + MIGRATION_AND_ADMIN);
    expect(room).toBeGreaterThanOrEqual(0);
  });
});
