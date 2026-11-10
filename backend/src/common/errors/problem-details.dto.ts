import { ApiProperty, ApiPropertyOptional, getSchemaPath } from '@nestjs/swagger';
import { ErrorCode } from './error-code.enum';

/**
 * Standard RFC 7807 Problem Details representation for OpenAPI and error responses.
 */
export class ProblemDetailsDto {
  @ApiProperty({
    type: String,
    example: 'about:blank',
    description: 'URI reference identifying the problem type (RFC 7807)',
  })
  type!: string;

  @ApiProperty({
    type: String,
    example: 'Unprocessable Entity',
    description: 'Short human-readable summary of the problem status',
  })
  title!: string;

  @ApiProperty({
    type: Number,
    example: 422,
    description: 'HTTP status code',
  })
  status!: number;

  @ApiProperty({
    type: String,
    example: 'Insufficient funds',
    description: 'Human-readable explanation specific to this occurrence',
  })
  detail!: string;

  @ApiPropertyOptional({
    enum: ErrorCode,
    example: ErrorCode.INSUFFICIENT_FUNDS,
    description:
      'Stable machine-readable error code for client branching (docs/03 §7.1). Absent on 404 or validation errors.',
  })
  errorCode?: ErrorCode;

  @ApiProperty({
    type: String,
    format: 'uuid',
    example: 'd461b1d0-dba2-4e40-8304-d91f7b7132c9',
    description: 'Correlation UUID for tracing the request across logs and audit',
  })
  correlationId!: string;

  @ApiPropertyOptional({
    type: [String],
    example: ['amount must be a positive whole VND string (1..9223372036854775807)'],
    description: 'Array of validation error details for HTTP 400 Bad Request',
  })
  errors?: string[];

  @ApiPropertyOptional({
    type: String,
    format: 'uuid',
    example: '7d9c2b10-5c11-4a7e-9b28-1f0d9e8c7b6a',
    description: 'Persisted transfer UUID when a transfer is rejected (HTTP 422)',
  })
  transferId?: string;
}

/** Content descriptor helper for application/problem+json in OpenAPI */
export function problemContent(
  schemaClass: new (...args: unknown[]) => unknown = ProblemDetailsDto,
  examples?: Record<string, { summary?: string; description?: string; value: unknown }>,
) {
  return {
    'application/problem+json': {
      schema: { $ref: getSchemaPath(schemaClass) },
      ...(examples ? { examples } : {}),
    },
  };
}
