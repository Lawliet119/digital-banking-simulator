import { Transform } from 'class-transformer';
import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsMoneyAmount } from '@common/money';

export class TransferDto {
  @ApiProperty({
    format: 'uuid',
    example: '11111111-1111-4111-8111-111111111111',
    description: 'Source account owned by the authenticated customer',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID()
  fromAccountId!: string;

  @ApiProperty({
    format: 'uuid',
    example: '22222222-2222-4222-8222-222222222222',
    description: 'Distinct destination customer account',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID()
  toAccountId!: string;

  @ApiProperty({
    type: String,
    example: '300000',
    description: 'Positive canonical whole VND string, at most 9223372036854775807',
  })
  @IsMoneyAmount()
  amount!: string;
}

export class TransferResultDto {
  @ApiProperty({
    format: 'uuid',
    example: '7d9c2b10-5c11-4a7e-9b28-1f0d9e8c7b6a',
    description: 'Committed transfer UUID',
  })
  transferId!: string;
  @ApiProperty({ enum: ['COMPLETED'], example: 'COMPLETED' })
  status!: 'COMPLETED';
}
