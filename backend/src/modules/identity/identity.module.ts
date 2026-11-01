import { Module } from '@nestjs/common';
import { IdentityController } from './identity.controller';
import { IdentityService } from './identity.service';
import { JwksVerifierService } from './jwks-verifier.service';
import { JwtAuthGuard } from './jwt-auth.guard';

// IdentityService is exported too: JwtAuthGuard is the global APP_GUARD (app.module.ts), so Nest
// resolves its dependencies from AppModule's injector, not from this module's.
@Module({
  controllers: [IdentityController],
  providers: [JwksVerifierService, IdentityService, JwtAuthGuard],
  exports: [JwksVerifierService, IdentityService, JwtAuthGuard],
})
export class IdentityModule {}
