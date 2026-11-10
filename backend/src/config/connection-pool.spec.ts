/**
 * DBS-172: Connection Pool Sizing & Capacity Planning Verification.
 * Formula:
 *   total_connections = (N_api * pool_api) + (N_worker * pool_worker) + safety_buffer <= max_connections
 */

export interface RdsInstanceClass {
  name: string;
  ramBytes: number;
}

export const RDS_INSTANCE_CLASSES: Record<string, RdsInstanceClass> = {
  'db.t4g.micro': { name: 'db.t4g.micro', ramBytes: 1 * 1024 * 1024 * 1024 }, // 1 GiB
  'db.t4g.small': { name: 'db.t4g.small', ramBytes: 2 * 1024 * 1024 * 1024 }, // 2 GiB
  'db.t4g.medium': { name: 'db.t4g.medium', ramBytes: 4 * 1024 * 1024 * 1024 }, // 4 GiB
  'db.t4g.large': { name: 'db.t4g.large', ramBytes: 8 * 1024 * 1024 * 1024 }, // 8 GiB
};

/**
 * AWS RDS PostgreSQL default formula:
 * max_connections = LEAST({DBInstanceClassMemory / 9531392}, 5000)
 */
export function calculateRdsMaxConnections(ramBytes: number): number {
  return Math.min(Math.floor(ramBytes / 9531392), 5000);
}

export interface PoolPlanningInputs {
  apiTasks: number;
  apiPoolMax: number;
  workerTasks: number;
  workerPoolMax: number;
  adminSafetyBuffer: number;
}

export function calculateTotalConnections(inputs: PoolPlanningInputs): number {
  return (
    inputs.apiTasks * inputs.apiPoolMax +
    inputs.workerTasks * inputs.workerPoolMax +
    inputs.adminSafetyBuffer
  );
}

export function isPoolCapacitySafe(
  inputs: PoolPlanningInputs,
  instance: RdsInstanceClass,
): { safe: boolean; totalUsed: number; maxConnections: number; headroomPercent: number } {
  const maxConnections = calculateRdsMaxConnections(instance.ramBytes);
  const totalUsed = calculateTotalConnections(inputs);
  const headroomPercent = ((maxConnections - totalUsed) / maxConnections) * 100;
  return {
    safe: totalUsed <= maxConnections,
    totalUsed,
    maxConnections,
    headroomPercent,
  };
}

describe('DBS-172: Connection Pool Sizing and Capacity Planning', () => {
  it('TC-172-01: db.t4g.micro allocates 112 max_connections on AWS RDS PostgreSQL', () => {
    const maxConn = calculateRdsMaxConnections(RDS_INSTANCE_CLASSES['db.t4g.micro'].ramBytes);
    expect(maxConn).toBe(112);
  });

  it('TC-172-02: default production deployment (2 API tasks, 2 Worker tasks, poolMax 10) fits comfortably in db.t4g.micro with > 50% headroom', () => {
    const deployment: PoolPlanningInputs = {
      apiTasks: 2,
      apiPoolMax: 10,
      workerTasks: 2,
      workerPoolMax: 10,
      adminSafetyBuffer: 15, // Migrator task, psql, cloudwatch monitoring
    };

    const result = isPoolCapacitySafe(deployment, RDS_INSTANCE_CLASSES['db.t4g.micro']);
    expect(result.safe).toBe(true);
    expect(result.totalUsed).toBe(55);
    expect(result.maxConnections).toBe(112);
    expect(result.headroomPercent).toBeGreaterThanOrEqual(50);
  });

  it('TC-172-03: scaling to 5 API tasks and 3 Worker tasks fits db.t4g.small (225 connections)', () => {
    const scaledDeployment: PoolPlanningInputs = {
      apiTasks: 5,
      apiPoolMax: 15,
      workerTasks: 3,
      workerPoolMax: 15,
      adminSafetyBuffer: 20,
    };

    const smallResult = isPoolCapacitySafe(scaledDeployment, RDS_INSTANCE_CLASSES['db.t4g.small']);
    expect(smallResult.safe).toBe(true);
    expect(smallResult.totalUsed).toBe(140);
    expect(smallResult.maxConnections).toBe(225);
    expect(smallResult.headroomPercent).toBeGreaterThan(35);
  });

  it('TC-172-04: maximum single-instance poolMax (50) with 2 API + 1 Worker requires db.t4g.small or larger', () => {
    const maxedPool: PoolPlanningInputs = {
      apiTasks: 2,
      apiPoolMax: 50,
      workerTasks: 1,
      workerPoolMax: 50,
      adminSafetyBuffer: 15,
    };

    // 2*50 + 1*50 + 15 = 165 -> Exceeds micro (112), but safe on small (225)
    const microResult = isPoolCapacitySafe(maxedPool, RDS_INSTANCE_CLASSES['db.t4g.micro']);
    expect(microResult.safe).toBe(false);

    const smallResult = isPoolCapacitySafe(maxedPool, RDS_INSTANCE_CLASSES['db.t4g.small']);
    expect(smallResult.safe).toBe(true);
  });
});
