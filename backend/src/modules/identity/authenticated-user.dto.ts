import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class CognitoAccessTokenClaimsDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '6b94c714-3182-4a66-92a2-0123456789ab',
    description: 'Subject UUID from Cognito token',
  })
  sub!: string;

  @ApiProperty({
    type: String,
    example: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_example',
    description: 'Issuer URL of the identity provider',
  })
  iss!: string;

  @ApiProperty({
    type: String,
    example: 'example-client-id',
    description: 'Client identifier for the Cognito user pool app',
  })
  client_id!: string;

  @ApiProperty({
    enum: ['access'],
    example: 'access',
    description: 'Token use type; must be access for API calls',
  })
  token_use!: 'access';

  @ApiProperty({
    type: Number,
    example: 1793577600,
    description: 'Issued-at timestamp (epoch seconds)',
  })
  iat!: number;

  @ApiProperty({
    type: Number,
    example: 1793578500,
    description: 'Expiration timestamp (epoch seconds)',
  })
  exp!: number;

  @ApiPropertyOptional({
    type: [String],
    example: ['customer'],
    description: 'Cognito groups assigned to the user',
  })
  'cognito:groups'?: string[];
}

export class AuthenticatedUserDto {
  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '6b94c714-3182-4a66-92a2-0123456789ab',
    description: 'Cognito subject identifier',
  })
  sub!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    example: '0f6a3d52-8c1b-4e7a-b6d4-2c9e1a7f5b30',
    description: 'Internal database user UUID (users.id)',
  })
  userId!: string;

  @ApiProperty({
    type: [String],
    example: ['customer'],
    description: 'User roles / groups resolved by identity guard',
  })
  groups!: string[];

  @ApiProperty({
    enum: ['access'],
    example: 'access',
    description: 'Token type verified by the guard',
  })
  tokenUse!: 'access';

  @ApiProperty({
    type: CognitoAccessTokenClaimsDto,
    description: 'Raw verified claims from the Cognito RS256 token',
  })
  claims!: CognitoAccessTokenClaimsDto;
}
