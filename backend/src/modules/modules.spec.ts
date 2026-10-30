import { AppRole } from '@common/app-role/app-role';
import { HealthModule } from './health';
import { modulesForRole } from './index';
import { RiskModule } from './risk';

describe('modulesForRole', () => {
  it('an api instance serves HTTP, so it loads the health probes', () => {
    expect(modulesForRole(AppRole.Api)).toContain(HealthModule);
  });

  it('a worker instance has no HTTP listener, so it loads no controllers', () => {
    expect(modulesForRole(AppRole.Worker)).not.toContain(HealthModule);
  });

  it('a combined instance loads everything an api instance does', () => {
    for (const module of modulesForRole(AppRole.Api)) {
      expect(modulesForRole(AppRole.Both)).toContain(module);
    }
  });

  it('never lists the same module twice', () => {
    const both = modulesForRole(AppRole.Both);
    expect(new Set(both).size).toBe(both.length);
  });

  it.each([AppRole.Api, AppRole.Worker, AppRole.Both])(
    'TC-59-03 registers the risk module once for role %s',
    role => {
      expect(modulesForRole(role).filter(module => module === RiskModule)).toHaveLength(1);
    },
  );
});
