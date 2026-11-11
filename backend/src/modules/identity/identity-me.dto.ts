import { ApiProperty } from '@nestjs/swagger';

/**
 * Response of `GET /v1/identity/me` (DBS-137): the caller as the guard verified it. Documentation
 * only, the handler still returns `AuthenticatedUser`. `claims` is a free-form object whose example
 * is minimal on purpose: no token id (`jti`) and nothing a client could replay.
 */
export class IdentityMeDto {
  @ApiProperty({
    description: 'Cognito subject of the token',
    example: 'a3f1c2d4-5b6e-4f80-9a1b-2c3d4e5f6a7b',
  })
  sub!: string;

  @ApiProperty({
    description: 'Internal users.id the guard resolved from the subject',
    format: 'uuid',
    example: '3c1f3a9e-2d4b-4a57-8e0f-6b7d9c1a2e44',
  })
  userId!: string;

  @ApiProperty({
    type: [String],
    description: 'Cognito groups; empty means customer',
    example: ['customer'],
  })
  groups!: string[];

  @ApiProperty({ enum: ['access'], example: 'access' })
  tokenUse!: 'access';

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Verified token claims',
    example: {
      sub: 'a3f1c2d4-5b6e-4f80-9a1b-2c3d4e5f6a7b',
      token_use: 'access',
      'cognito:groups': ['customer'],
      iat: 1794300000,
      exp: 1794300900,
    },
  })
  claims!: Record<string, unknown>;
}
