import { ApiProperty } from '@nestjs/swagger';

/** The movement on the reader's own account that a notice is about. */
export class NotificationTransferDto {
  @ApiProperty({ format: 'uuid', example: '3c1f3a9e-2d4b-4a57-8e0f-6b7d9c1a2e44' })
  transferId!: string;

  @ApiProperty({ enum: ['DEBIT', 'CREDIT'], description: 'DEBIT = money out' })
  direction!: 'DEBIT' | 'CREDIT';

  @ApiProperty({ type: String, example: '300000', description: 'Positive whole VND string' })
  amount!: string;

  @ApiProperty({
    type: String,
    example: '700000',
    description: "Balance of the reader's account after this movement",
  })
  balanceAfter!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'Trần Thu Hà',
    description: 'Null for a deposit',
  })
  counterpartyName!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    pattern: '^[0-9]{12}$',
    example: '100000000004',
    description: 'Null for a deposit',
  })
  counterpartyAccountNumber!: string | null;
}

/** One notice of the caller. Listed field by field: no event id, correlation id or owner id. */
export class NotificationItemDto {
  @ApiProperty({ type: String, example: '42', description: 'notification_log.id' })
  id!: string;

  @ApiProperty({ enum: ['transfer_completed', 'account_status_changed'] })
  kind!: 'transfer_completed' | 'account_status_changed';

  @ApiProperty({
    type: String,
    example: 'Giao dịch chuyển tiền đã hoàn tất.',
    description: 'Fixed generic text: no amount and no reason (BR-13)',
  })
  message!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    example: '2026-03-15T02:30:00.123456Z',
    description: 'When the event happened, UTC with exactly six fractional digits',
  })
  occurredAt!: string;

  @ApiProperty({ example: false })
  read!: boolean;

  @ApiProperty({
    type: String,
    nullable: true,
    pattern: '^[0-9]{12}$',
    example: '100000000002',
    description: "The reader's account the notice is about; null on older notices",
  })
  accountNumber!: string | null;

  @ApiProperty({
    type: () => NotificationTransferDto,
    nullable: true,
    description: 'Null for a status change and for notices written before this field existed',
  })
  transfer!: NotificationTransferDto | null;
}

export class NotificationPageDto {
  @ApiProperty({ type: [NotificationItemDto], description: 'Newest first' })
  items!: NotificationItemDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    description: 'Opaque cursor for the next page; null on the last page',
    example: 'bmV4dC1wYWdlLWN1cnNvcg',
  })
  nextCursor!: string | null;

  @ApiProperty({ type: 'integer', example: 2, description: 'All unread notices, any filter' })
  unreadCount!: number;
}

export class NotificationReadDto {
  @ApiProperty({ type: 'integer', example: 0 })
  unreadCount!: number;
}
