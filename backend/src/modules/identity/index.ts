export { IdentityModule } from './identity.module';
export { JwtAuthGuard } from './jwt-auth.guard';
export type { RequestWithUser } from './jwt-auth.guard';
export { JwksVerifierService } from './jwks-verifier.service';
export type { AuthenticatedUser, CognitoAccessTokenClaims } from './jwt-claims';
export { TokenExpiredError, TokenVerificationError } from './identity.errors';
