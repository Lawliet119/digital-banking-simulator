import { AppRole } from '@common/app-role/app-role';
import { AuditModule } from './audit';
import { HealthModule } from './health';
import { AccountsModule } from '@modules/accounts';
import { modulesForRole } from './index';
import { OutboxModule } from './outbox';
import { RiskModule } from './risk';

describe('modulesForRole', () => {
  it.each(Object.values(AppRole))('TC-57-12 loads the outbox writer once in the %s role', role => {
    expect(modulesForRole(role).filter(module => module === OutboxModule)).toHaveLength(1);
  });

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

  it('TC-56-13 audit is a library both api and worker load, since both write audit rows', () => {
    expect(modulesForRole(AppRole.Api)).toContain(AuditModule);
    expect(modulesForRole(AppRole.Worker)).toContain(AuditModule);
  });

  it.each([AppRole.Api, AppRole.Worker, AppRole.Both])(
    'TC-59-03 registers the risk module once for role %s',
    role => {
      expect(modulesForRole(role).filter(module => module === RiskModule)).toHaveLength(1);
    },
  );
});
