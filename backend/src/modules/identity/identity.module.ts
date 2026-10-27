import { Module } from '@nestjs/common';
import { IdentityController } from './identity.controller';
import { JwksVerifierService } from './jwks-verifier.service';
import { JwtAuthGuard } from './jwt-auth.guard';

@Module({
  controllers: [IdentityController],
  providers: [JwksVerifierService, JwtAuthGuard],
  exports: [JwksVerifierService, JwtAuthGuard],
})
export class IdentityModule {}
