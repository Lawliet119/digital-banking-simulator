import * as publicApi from '@modules/identity';
import type { CurrentUserInfo, Role } from '@modules/identity';

describe('identity public API (index.ts)', () => {
  it('TC-51-13 exports the role values other modules need', () => {
    expect(publicApi.ROLES).toEqual(['customer', 'operator', 'auditor', 'admin']);
    expect(typeof publicApi.Roles).toBe('function');
    expect(typeof publicApi.RolesGuard).toBe('function');
    expect(typeof publicApi.CurrentUser).toBe('function');
    expect(typeof publicApi.rolesFromGroups).toBe('function');
  });

  it('TC-51-13 still exports what DBS-50 and DBS-52 published', () => {
    expect(typeof publicApi.IdentityModule).toBe('function');
    expect(typeof publicApi.JwtAuthGuard).toBe('function');
    expect(typeof publicApi.JwksVerifierService).toBe('function');
    expect(typeof publicApi.IdentityService).toBe('function');
    expect(typeof publicApi.TokenExpiredError).toBe('function');
    expect(typeof publicApi.TokenVerificationError).toBe('function');
  });

  it('TC-51-13 exports the Role and CurrentUserInfo types (checked by the compiler, so typecheck goes red if one goes missing)', () => {
    const role: Role = 'operator';
    const who: CurrentUserInfo = { userId: 'u', sub: 's', roles: [role] };

    expect(who.roles).toEqual(['operator']);
  });
});
