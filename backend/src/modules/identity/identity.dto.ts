import { ApiProperty } from '@nestjs/swagger';

export class CognitoClaimsDto {
  @ApiProperty({ example: 'cognito-sub-12345' })
  sub!: string;

  @ApiProperty({ example: 'https://cognito-idp.ap-southeast-1.amazonaws.com/ap-southeast-1_xxxx' })
  iss!: string;

  @ApiProperty({ example: 'app-client-id-xxxx' })
  client_id!: string;

  @ApiProperty({ enum: ['access', 'id'], example: 'access' })
  token_use!: 'access' | 'id';

  @ApiProperty({ example: 1731250000 })
  exp!: number;

  @ApiProperty({ example: 1731246400 })
  iat!: number;

  @ApiProperty({ type: [String], example: ['customer'] })
  'cognito:groups'?: string[];
}

export class AuthenticatedUserDto {
  @ApiProperty({ example: 'cognito-sub-12345' })
  sub!: string;

  @ApiProperty({ format: 'uuid', example: '11111111-1111-4111-8111-111111111111' })
  userId!: string;

  @ApiProperty({ type: [String], example: ['customer'] })
  groups!: string[];

  @ApiProperty({ enum: ['access'], example: 'access' })
  tokenUse!: 'access';

  @ApiProperty({ type: CognitoClaimsDto })
  claims!: CognitoClaimsDto;
}
