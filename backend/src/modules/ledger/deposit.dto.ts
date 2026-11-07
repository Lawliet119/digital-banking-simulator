import { Transform } from 'class-transformer';
import { IsUUID } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';
import { IsMoneyAmount } from '@common/money';

export class DepositDto {
  @ApiProperty({ format: 'uuid', example: 'a03bcc94-55e2-4d1d-8d64-d130dc1b2566' })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.toLowerCase() : value,
  )
  @IsUUID()
  toAccountId!: string;

  @ApiProperty({
    type: String,
    example: '1000000',
    description: 'Positive whole VND, canonical decimal string <=9223372036854775807',
  })
  @IsMoneyAmount()
  amount!: string;
}

export class DepositResultDto {
  @ApiProperty({ format: 'uuid' })
  transferId!: string;
  @ApiProperty({ enum: ['COMPLETED'], example: 'COMPLETED' })
  status!: 'COMPLETED';
}
