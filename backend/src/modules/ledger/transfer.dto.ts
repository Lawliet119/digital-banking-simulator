import { Transform } from 'class-transformer';
import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsMoneyAmount } from '@common/money';

export class TransferDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Source account owned by the authenticated customer',
    example: '8b3609fb-96a7-434b-a7ba-2ba171955e6d',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID()
  fromAccountId!: string;

  @ApiProperty({
    format: 'uuid',
    description: 'Distinct destination customer account',
    example: 'bf9c3419-51ff-4e55-b03c-3296f0419c03',
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
  @ApiProperty({ format: 'uuid', example: '3c1f3a9e-2d4b-4a57-8e0f-6b7d9c1a2e44' })
  transferId!: string;
  @ApiProperty({ enum: ['COMPLETED'], example: 'COMPLETED' })
  status!: 'COMPLETED';
}
