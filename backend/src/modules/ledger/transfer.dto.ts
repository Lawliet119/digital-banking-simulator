import { Transform } from 'class-transformer';
import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsMoneyAmount } from '@common/money';

export class TransferDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Source account owned by the authenticated customer',
  })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID()
  fromAccountId!: string;

  @ApiProperty({ format: 'uuid', description: 'Distinct destination customer account' })
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
  @ApiProperty({ format: 'uuid' })
  transferId!: string;
  @ApiProperty({ enum: ['COMPLETED'], example: 'COMPLETED' })
  status!: 'COMPLETED';
}
