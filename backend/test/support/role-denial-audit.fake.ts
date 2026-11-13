import type { Provider } from '@nestjs/common';
import { RoleDenialAudit, type RoleDenial } from '../../src/modules/identity';

/**
 * A stand-in for the audit module's `RoleDenialAudit` in the role tests that run without a
 * database (BL-132). `RolesGuard` needs the port to boot; here it only remembers what the guard
 * handed over, so a test can assert one entry per 403 and none for an allowed request or a 401.
 * The real row is proved against PostgreSQL in test/db/auth-attacks.db-spec.ts.
 */
export class FakeRoleDenialAudit extends RoleDenialAudit {
  readonly denials: RoleDenial[] = [];
  /** Set to make the next writes fail, to prove the guard fails closed. */
  failure: Error | undefined;

  recordRoleDenied(denial: RoleDenial): Promise<void> {
    if (this.failure) return Promise.reject(this.failure);
    this.denials.push(denial);
    return Promise.resolve();
  }
}

export function fakeRoleDenialAuditProvider(fake: FakeRoleDenialAudit): Provider {
  return { provide: RoleDenialAudit, useValue: fake };
}
