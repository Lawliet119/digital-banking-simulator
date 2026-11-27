import { ApiProperty } from '@nestjs/swagger';
import { IsIn } from 'class-validator';

export const CUSTOMER_ACCOUNT_TYPES = ['CHECKING', 'SAVINGS'] as const;
export type CustomerAccountType = (typeof CUSTOMER_ACCOUNT_TYPES)[number];

export class CreateAccountDto {
  @ApiProperty({ enum: CUSTOMER_ACCOUNT_TYPES, example: 'CHECKING' })
  @IsIn(CUSTOMER_ACCOUNT_TYPES)
  type!: CustomerAccountType;
}

export class OpenedAccountDto {
  @ApiProperty({ format: 'uuid', example: '8f78e873-7dab-481a-9bbf-577d35e49dd7' })
  id!: string;

  @ApiProperty({
    type: String,
    pattern: '^[0-9]{12}$',
    example: '100000000001',
    description: 'Customer-facing account number: 12 digits, unique',
  })
  accountNumber!: string;

  @ApiProperty({ enum: CUSTOMER_ACCOUNT_TYPES, example: 'CHECKING' })
  type!: CustomerAccountType;

  @ApiProperty({ enum: ['ACTIVE'], example: 'ACTIVE' })
  status!: 'ACTIVE';

  @ApiProperty({ type: String, example: '0', description: 'Exact decimal string in VND' })
  balance!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-04T00:00:00.000Z' })
  createdAt!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-04T00:00:00.000Z' })
  updatedAt!: string;
}
