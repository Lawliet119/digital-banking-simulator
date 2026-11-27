import { ApiProperty } from '@nestjs/swagger';

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
}
