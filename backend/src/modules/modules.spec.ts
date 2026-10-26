import { AppRole } from '@common/app-role/app-role';
import { AuditModule } from './audit';
import { HealthModule } from './health';
import { modulesForRole } from './index';

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

  it('TC-56-13 audit is a library both api and worker load, since both write audit rows', () => {
    expect(modulesForRole(AppRole.Api)).toContain(AuditModule);
    expect(modulesForRole(AppRole.Worker)).toContain(AuditModule);
  });
});
