import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * What a party of a transfer may know about it (UC-7). Field by field on purpose (AC-10.2, AC-5.8):
 * nothing about fraud flags, and for a REJECTED transfer nothing that tells why the destination
 * was refused beyond the reason code, so "does not exist", "is the funding account" and "is
 * LOCKED" cannot be told apart (BL-175).
 */
export class TransferStatusDto {
  @ApiProperty({ format: 'uuid', example: '7d9c2b10-5c11-4a7e-9b28-1f0d9e8c7b6a' })
  transferId!: string;

  @ApiProperty({ enum: ['TRANSFER', 'DEPOSIT'], example: 'TRANSFER' })
  type!: 'TRANSFER' | 'DEPOSIT';

  @ApiProperty({ enum: ['COMPLETED', 'REJECTED'], example: 'COMPLETED' })
  status!: 'COMPLETED' | 'REJECTED';

  @ApiPropertyOptional({
    enum: [
      'ACCOUNT_NOT_ACTIVE',
      'LIMIT_PER_TX_EXCEEDED',
      'LIMIT_PER_DAY_EXCEEDED',
      'INSUFFICIENT_FUNDS',
    ],
    example: 'INSUFFICIENT_FUNDS',
    description: 'Only for a REJECTED transfer',
  })
  rejectReason?: string;

  @ApiProperty({ type: String, example: '300000', description: 'Positive whole VND string' })
  amount!: string;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '11111111-1111-4111-8111-111111111111',
    description: 'Source account; absent for a DEPOSIT (the funding account is never shown)',
  })
  fromAccountId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    example: '22222222-2222-4222-8222-222222222222',
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
