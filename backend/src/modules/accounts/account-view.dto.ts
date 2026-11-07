import { ApiProperty } from '@nestjs/swagger';
import { formatBalance, parseBalance } from '@common/money';

export class AccountViewDto {
  @ApiProperty({ format: 'uuid', example: '2e859a80-d4d0-471d-8cee-e9d0de9d4bc7' })
  id!: string;
  @ApiProperty({ enum: ['CHECKING', 'SAVINGS'], example: 'CHECKING' })
  type!: 'CHECKING' | 'SAVINGS';
  @ApiProperty({ enum: ['ACTIVE', 'LOCKED'], example: 'ACTIVE' })
  status!: 'ACTIVE' | 'LOCKED';
  @ApiProperty({
    type: String,
    example: '0',
    description: 'Exact decimal VND balance from PostgreSQL',
  })
  balance!: string;
  @ApiProperty({ format: 'date-time', example: '2026-11-04T00:00:00.000Z' })
  createdAt!: string;
  @ApiProperty({ format: 'date-time', example: '2026-11-04T00:00:00.000Z' })
  updatedAt!: string;
}

export type AccountReadRow = Omit<AccountViewDto, 'createdAt' | 'updatedAt'> & {
  createdAt: Date;
  updatedAt: Date;
};

/** Explicit whitelist prevents private joined columns from escaping if SQL grows later. */
export function toAccountView(row: AccountReadRow): AccountViewDto {
  return {
    id: row.id,
    type: row.type,
    status: row.status,
    balance: formatBalance(parseBalance(row.balance)),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
