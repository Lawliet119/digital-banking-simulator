import { Module, type Provider } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { runsHttp } from './common/app-role/app-role';
import { ConfigModule } from './config/config.module';
import { DatabaseModule } from './database/database.module';
import { JwtAuthGuard, RolesGuard } from '@modules/identity';
import { modulesForRole } from './modules';
import { LoggingModule } from './common/logging/logging.module';

// JwtAuthGuard (DBS-50) is the default guard for every HTTP route — opt out with @Public(), never
// by omitting @UseGuards(). Only registered when this process serves HTTP: a `worker`-role
// process never imports IdentityModule (see modules/index.ts), so JwksVerifierService would be
// missing from the container and boot would crash if this ran unconditionally. CanActivate has no
// meaning for a worker anyway — it guards requests, and a worker has none.
//
// RolesGuard (DBS-51) is the second global guard and must stay after JwtAuthGuard: it reads
// `request.user`, which JwtAuthGuard sets. It only needs Reflector, so unlike JwtAuthGuard it
// adds nothing to IdentityModule's exports. A route with no @Roles needs only a valid token, so a
// developer who forgets @Roles opens the route to every role: test/roles-app.e2e-spec.ts fails
// when a route has neither @Roles nor @Public().
const httpGuardProviders: Provider[] = runsHttp()
  ? [
      { provide: APP_GUARD, useClass: JwtAuthGuard },
      { provide: APP_GUARD, useClass: RolesGuard },
    ]
  : [];

/**
 * Root module. Cross-cutting infrastructure is always loaded; business modules are chosen by
 * `APP_ROLE` in `modules/index.ts`.
 */
@Module({
  imports: [ConfigModule, LoggingModule, DatabaseModule, ...modulesForRole()],
  providers: httpGuardProviders,
})
export class AppModule {}
