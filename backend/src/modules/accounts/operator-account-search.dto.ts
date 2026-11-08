import { ApiProperty } from '@nestjs/swagger';

/** Four fields and no balance (FR-ACC-04): the operator finds the account, not what is in it. */
export class OperatorAccountDto {
  @ApiProperty({ format: 'uuid', example: '2e859a80-d4d0-471d-8cee-e9d0de9d4bc7' })
  id!: string;

  @ApiProperty({ enum: ['CHECKING', 'SAVINGS'], example: 'CHECKING' })
  type!: 'CHECKING' | 'SAVINGS';

  @ApiProperty({ enum: ['ACTIVE', 'LOCKED'], example: 'ACTIVE' })
  status!: 'ACTIVE' | 'LOCKED';

  @ApiProperty({ type: String, example: 'Nguyễn Minh Anh' })
  ownerName!: string;
}

export class OperatorAccountSearchDto {
  @ApiProperty({ type: [OperatorAccountDto], description: 'At most 20, ordered by owner name' })
  items!: OperatorAccountDto[];
}
