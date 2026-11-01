import { Reflector } from '@nestjs/core';
import { DECORATORS } from '@nestjs/swagger';
import { ROLES_KEY, Roles } from './roles.decorator';
import type { Role } from './roles';

class SampleController {
  @Roles('operator', 'admin')
  staff(): void {}

  admin(): void {}
}

@Roles('auditor')
class ClassLevelController {
  inherited(): void {}

  @Roles('admin')
  override(): void {}
}

describe('Roles decorator', () => {
  const reflector = new Reflector();

  it('TC-51-05 stores the allowed roles under ROLES_KEY on a method', () => {
    expect(reflector.get<Role[]>(ROLES_KEY, SampleController.prototype.staff)).toEqual([
      'operator',
      'admin',
    ]);
  });

  it('TC-51-05 leaves a method without @Roles with no metadata at all (undefined, not [])', () => {
    expect(reflector.get<Role[] | undefined>(ROLES_KEY, SampleController.prototype.admin)).toBe(
      undefined,
    );
  });

  it('TC-51-05 stores the allowed roles on a class', () => {
    expect(reflector.get<Role[]>(ROLES_KEY, ClassLevelController)).toEqual(['auditor']);
  });

  it('TC-51-05 a method-level @Roles replaces the class-level one instead of merging', () => {
    const forMethod = (name: 'inherited' | 'override') =>
      reflector.getAllAndOverride<Role[]>(ROLES_KEY, [
        ClassLevelController.prototype[name],
        ClassLevelController,
      ]);

    expect(forMethod('inherited')).toEqual(['auditor']);
    expect(forMethod('override')).toEqual(['admin']);
  });

  it('TC-51-05 does not let the caller change the stored list afterwards', () => {
    const roles: [Role, ...Role[]] = ['operator'];
    class Probe {
      @Roles(...roles)
      handler(): void {}
    }
    roles.push('admin');

    expect(reflector.get<Role[]>(ROLES_KEY, Probe.prototype.handler)).toEqual(['operator']);
  });

  it('TC-51-05 throws at declaration time when called with no role', () => {
    expect(() => {
      // @ts-expect-error a role list must have at least one member
      Roles();
    }).toThrow(/at least one role/i);
  });

  it('TC-51-05 throws at declaration time for a name that is not a role', () => {
    expect(() => {
      Roles('superuser' as unknown as Role);
    }).toThrow(/superuser/);
    expect(() => {
      Roles('operator', '__proto__' as unknown as Role);
    }).toThrow(/__proto__/);
  });

  it('TC-51-05 documents the roles and the 403 for OpenAPI (x-roles, FORBIDDEN response)', () => {
    const extensions = Reflect.getMetadata(
      DECORATORS.API_EXTENSION,
      SampleController.prototype.staff,
    ) as Record<string, unknown> | undefined;
    const responses = Reflect.getMetadata(
      DECORATORS.API_RESPONSE,
      SampleController.prototype.staff,
    ) as Record<string, unknown> | undefined;

    expect(extensions).toEqual({ 'x-roles': ['operator', 'admin'] });
    expect(responses).toHaveProperty('403');
  });
});
