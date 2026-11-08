import { ApiProperty } from '@nestjs/swagger';

/**
 * One ledger line of the viewed account. Listed field by field on purpose (AC-10.2): nothing about
 * fraud flags, scores, rules or reviews can reach a customer by adding a column to a table.
 */
export class TransactionItemDto {
  @ApiProperty({ type: String, example: '9007199254740994', description: 'ledger_entries.id' })
  entryId!: string;

  @ApiProperty({ format: 'uuid' })
  transferId!: string;

  @ApiProperty({ enum: ['TRANSFER', 'DEPOSIT'] })
  type!: 'TRANSFER' | 'DEPOSIT';

  @ApiProperty({ enum: ['DEBIT', 'CREDIT'], description: 'DEBIT = money out, CREDIT = money in' })
  direction!: 'DEBIT' | 'CREDIT';

  @ApiProperty({ type: String, example: '300000', description: 'Positive whole VND string' })
  amount!: string;

  @ApiProperty({
    type: String,
    example: '700000',
    description: 'Balance of THIS account after the line',
  })
  balanceAfter!: string;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'The other account of a TRANSFER; null for a DEPOSIT (the funding account is never shown)',
  })
  counterpartyAccountId!: string | null;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-03-15T02:30:00.123456Z',
    description: 'UTC with exactly six fractional digits',
  })
  createdAt!: string;
}

export class TransactionPageDto {
  @ApiProperty({ type: [TransactionItemDto], description: 'Newest first' })
  items!: TransactionItemDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Opaque cursor for the next page; null on the last page',
  })
  nextCursor!: string | null;
}
