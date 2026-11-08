import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * What a party of a transfer may know about it (UC-7). Field by field on purpose (AC-10.2, AC-5.8):
 * nothing about fraud flags, and for a REJECTED transfer nothing that tells why the destination
 * was refused beyond the reason code, so "does not exist", "is the funding account" and "is
 * LOCKED" cannot be told apart (BL-175).
 */
export class TransferStatusDto {
  @ApiProperty({ format: 'uuid' })
  transferId!: string;

  @ApiProperty({ enum: ['TRANSFER', 'DEPOSIT'] })
  type!: 'TRANSFER' | 'DEPOSIT';

  @ApiProperty({ enum: ['COMPLETED', 'REJECTED'] })
  status!: 'COMPLETED' | 'REJECTED';

  @ApiPropertyOptional({
    enum: [
      'ACCOUNT_NOT_ACTIVE',
      'LIMIT_PER_TX_EXCEEDED',
      'LIMIT_PER_DAY_EXCEEDED',
      'INSUFFICIENT_FUNDS',
    ],
    description: 'Only for a REJECTED transfer',
  })
  rejectReason?: string;

  @ApiProperty({ type: String, example: '300000', description: 'Positive whole VND string' })
  amount!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Source account; absent for a DEPOSIT (the funding account is never shown)',
  })
  fromAccountId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Destination account; only for a COMPLETED transfer, never for a REJECTED one',
  })
  toAccountId?: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-03-15T02:30:00.123456Z',
    description: 'UTC with exactly six fractional digits',
  })
  createdAt!: string;
}
