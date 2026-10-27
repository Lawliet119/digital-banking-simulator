import { AppRole } from '@common/app-role/app-role';
import { HealthModule } from './health';
import { AccountsModule } from '@modules/accounts';
import { modulesForRole } from './index';

describe('modulesForRole', () => {
  it('TC-55-15 accounts is public and loads in api/both, without starting in worker', () => {
    expect(modulesForRole(AppRole.Api)).toContain(AccountsModule);
    expect(modulesForRole(AppRole.Both)).toContain(AccountsModule);
    expect(modulesForRole(AppRole.Worker)).not.toContain(AccountsModule);
  });
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
});
