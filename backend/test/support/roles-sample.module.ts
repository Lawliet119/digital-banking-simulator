import { Controller, Get, Module, Post } from '@nestjs/common';
import { Public } from '../../src/common/auth/public.decorator';
import { CurrentUser, Roles, type CurrentUserInfo } from '../../src/modules/identity';

/**
 * Sample endpoints for the DBS-51 role tests. They exist only in tests: the task delivers the
 * mechanism, and the real `/v1/operator/...` routes belong to the tasks that build them.
 *
 * Every handler records that it ran. A role test that only looks at the status code cannot tell a
 * guard that blocked the call from one that let it through and failed later, so each 403 is
 * checked together with "the handler did not run".
 */
const counts = new Map<string, number>();

export const calls = {
  hit(name: string): void {
    counts.set(name, (counts.get(name) ?? 0) + 1);
  },
  count(name: string): number {
    return counts.get(name) ?? 0;
  },
  total(): number {
    let sum = 0;
    for (const value of counts.values()) sum += value;
    return sum;
  },
  reset(): void {
    counts.clear();
  },
};

function ran(handler: string): { handler: string } {
  calls.hit(handler);
  return { handler };
}

@Controller('sample')
export class SampleController {
  @Get('customer')
  @Roles('customer')
  customer(): { handler: string } {
    return ran('customer');
  }

  @Get('operator')
  @Roles('operator')
  operator(): { handler: string } {
    return ran('operator');
  }

  @Get('auditor')
  @Roles('auditor')
  auditor(): { handler: string } {
    return ran('auditor');
  }

  @Get('admin')
  @Roles('admin')
  admin(): { handler: string } {
    return ran('admin');
  }

  @Get('staff')
  @Roles('operator', 'admin')
  staff(): { handler: string } {
    return ran('staff');
  }

  @Post('echo-admin')
  @Roles('admin')
  echoAdmin(): { handler: string } {
    return ran('echo-admin');
  }

  /** No @Roles and no @Public: any valid token (decision G1). */
  @Get('any')
  any(): { handler: string } {
    return ran('any');
  }

  @Get('public')
  @Public()
  open(): { handler: string } {
    return ran('public');
  }

  /** A mistake a developer could make: it can never work, because there is no caller. */
  @Get('public-roles')
  @Public()
  @Roles('admin')
  publicRoles(): { handler: string } {
    return ran('public-roles');
  }

  @Get('whoami')
  whoami(@CurrentUser() who: CurrentUserInfo): CurrentUserInfo {
    calls.hit('whoami');
    return who;
  }
}

@Controller('sample-class')
@Roles('operator')
export class ClassLevelSampleController {
  @Get('inherited')
  inherited(): { handler: string } {
    return ran('class-inherited');
  }

  @Get('admin-only')
  @Roles('admin')
  adminOnly(): { handler: string } {
    return ran('class-admin-only');
  }
}

@Module({ controllers: [SampleController, ClassLevelSampleController] })
export class RolesSampleModule {}
