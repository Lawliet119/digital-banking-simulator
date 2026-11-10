import { ApiProperty } from '@nestjs/swagger';

/**
 * One ledger line of the viewed account. Listed field by field on purpose (AC-10.2): nothing about
 * fraud flags, scores, rules or reviews can reach a customer by adding a column to a table.
 */
export class TransactionItemDto {
  @ApiProperty({ type: String, example: '9007199254740994', description: 'ledger_entries.id' })
  entryId!: string;

  @ApiProperty({ format: 'uuid', example: '3c1f3a9e-2d4b-4a57-8e0f-6b7d9c1a2e44' })
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
    example: 'bf9c3419-51ff-4e55-b03c-3296f0419c03',
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
    example: 'bmV4dC1wYWdlLWN1cnNvcg',
  })
  nextCursor!: string | null;
}
