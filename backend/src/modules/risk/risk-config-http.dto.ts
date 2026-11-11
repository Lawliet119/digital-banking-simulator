import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

export class CreateRiskConfigDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Complete versioned R1–R6 configuration and optional AI block',
    example: {
      mode: 'rule_only',
      thresholds: { medium: 40, high: 70 },
      rules: { R1: { enabled: true, weight: 30 } },
    },
  })
  @IsObject()
  config!: Record<string, unknown>;
}

export class RiskConfigVersionDto {
  @ApiProperty({ type: Number, example: 1 }) version!: number;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    example: { mode: 'rule_only', thresholds: { medium: 40, high: 70 } },
  })
  config!: Record<string, unknown>;
  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    example: '3c1f3a9e-2d4b-4a57-8e0f-6b7d9c1a2e44',
  })
  createdBy!: string | null;
  @ApiProperty({ type: String, format: 'date-time', example: '2026-11-10T09:15:00.123Z' })
  createdAt!: Date;
}

export class RiskConfigListDto {
  @ApiProperty({ type: [RiskConfigVersionDto] }) items!: RiskConfigVersionDto[];
  @ApiProperty({ type: Number, nullable: true, example: 1 }) nextBefore!: number | null;
}
