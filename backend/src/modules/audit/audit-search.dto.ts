import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import type { AuditEntriesPage, AuditEntry } from './audit-search.query';
import type { AuditOutcome } from './audit.types';

export class AuditTargetDto {
  @ApiProperty({ type: String, example: 'transfer' })
  type!: string;

  @ApiProperty({ type: String, example: '22222222-2222-4222-8222-222222222222' })
  id!: string;
}

export class AuditEntryDto implements AuditEntry {
  @ApiProperty({
    type: String,
    description: 'Exact positive PostgreSQL bigint as a decimal string',
    example: '9007199254740994',
  })
  id!: string;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'UTC with exactly six fractional digits; microseconds are preserved',
    example: '2026-11-04T08:10:00.123456Z',
  })
  occurredAt!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  actorUserId!: string | null;

  @ApiProperty({ type: String, example: 'customer' })
  actorRole!: string;

  @ApiProperty({ type: String, example: 'transfer.create' })
  action!: string;

  @ApiProperty({ enum: ['SUCCESS', 'REJECTED', 'DENIED'] })
  outcome!: AuditOutcome;

  @ApiProperty({ type: AuditTargetDto })
  target!: AuditTargetDto;

  @ApiProperty({ type: String, format: 'uuid' })
  correlationId!: string;

  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Stored audit metadata; never expanded with user/customer profile data',
    example: {},
  })
  metadata!: Record<string, unknown>;
}

export class AuditEntriesPageDto implements AuditEntriesPage {
  @ApiProperty({ type: [AuditEntryDto] })
  entries!: AuditEntryDto[];

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 512,
    description: 'Filter-bound keyset cursor; null when there is no next page',
  })
  nextCursor!: string | null;
}

export class AuditSearchProblemDto {
  @ApiProperty({ type: String, example: 'about:blank' })
  type!: string;

  @ApiProperty({ type: String })
  title!: string;

  @ApiProperty({ type: Number })
  status!: number;

  @ApiProperty({ type: String })
  detail!: string;

  @ApiProperty({ type: String, format: 'uuid' })
  correlationId!: string;

  @ApiPropertyOptional({
    type: String,
    description: 'Present for guard/transient errors; absent for validation and unexpected errors',
  })
  errorCode?: string;

  @ApiPropertyOptional({
    type: [String],
    description: 'Fixed validation messages; rejected values are never echoed',
  })
  errors?: string[];
}
