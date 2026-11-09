import { AppRole } from '@common/app-role/app-role';
import { AuditHttpModule, AuditModule } from './audit';
import { HealthModule } from './health';
import { AccountsModule } from '@modules/accounts';
import { LedgerReconciliationModule } from './ledger';
import { modulesForRole } from './index';
import { OutboxModule } from './outbox';
import { RiskModule } from './risk';
import { SessionRevocationModule } from './identity';

describe('modulesForRole', () => {
  it('TC-114-10 installs the real revocation cache module in api/both, not worker-only', () => {
    expect(modulesForRole(AppRole.Api)).toContain(SessionRevocationModule);
    expect(modulesForRole(AppRole.Both)).toContain(SessionRevocationModule);
    expect(modulesForRole(AppRole.Worker)).not.toContain(SessionRevocationModule);
  });
  it('TC-103-19 loads the audit query API only for api/both while preserving the writer', () => {
    expect(modulesForRole(AppRole.Api)).toContain(AuditHttpModule);
    expect(modulesForRole(AppRole.Both)).toContain(AuditHttpModule);
    expect(modulesForRole(AppRole.Worker)).not.toContain(AuditHttpModule);
    for (const role of Object.values(AppRole)) {
      expect(modulesForRole(role).filter(module => module === AuditModule)).toHaveLength(1);
    }
  });

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

  it('TC-117-01 loads LedgerReconciliationModule only for worker/both and never for api', () => {
    expect(modulesForRole(AppRole.Api)).not.toContain(LedgerReconciliationModule);
    expect(modulesForRole(AppRole.Worker)).toContain(LedgerReconciliationModule);
    expect(modulesForRole(AppRole.Both)).toContain(LedgerReconciliationModule);
  });
});
