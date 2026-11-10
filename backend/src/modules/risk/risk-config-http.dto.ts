import { ApiProperty } from '@nestjs/swagger';
import { IsObject } from 'class-validator';

export class CreateRiskConfigDto {
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Complete versioned R1–R6 configuration and optional AI block',
  })
  @IsObject()
  config!: Record<string, unknown>;
}

export class RiskConfigVersionDto {
  @ApiProperty({ type: Number, example: 1 }) version!: number;
  @ApiProperty({ type: 'object', additionalProperties: true }) config!: Record<string, unknown>;
  @ApiProperty({ type: String, format: 'uuid', nullable: true }) createdBy!: string | null;
  @ApiProperty({ type: String, format: 'date-time' }) createdAt!: Date;
}

export class RiskConfigListDto {
  @ApiProperty({ type: [RiskConfigVersionDto] }) items!: RiskConfigVersionDto[];
  @ApiProperty({ type: Number, nullable: true }) nextBefore!: number | null;
}
