import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { TransactionItemDto } from '@modules/ledger';

export class ReviewFraudDto {
  @ApiProperty({ enum: ['CONFIRMED_FRAUD', 'FALSE_POSITIVE'] })
  @IsIn(['CONFIRMED_FRAUD', 'FALSE_POSITIVE'])
  decision!: 'CONFIRMED_FRAUD' | 'FALSE_POSITIVE';

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class FraudFlagDto {
  @ApiProperty({ format: 'uuid' }) transferId!: string;
  @ApiProperty({ format: 'uuid' }) fromAccountId!: string;
  @ApiProperty({ format: 'uuid' }) toAccountId!: string;
  @ApiProperty() score!: number;
  @ApiProperty({ enum: ['MEDIUM', 'HIGH'] }) riskLevel!: string;
  @ApiProperty({ enum: ['OPEN', 'CONFIRMED_FRAUD', 'FALSE_POSITIVE'] }) reviewStatus!: string;
  @ApiProperty() ruleSetVersion!: number;
  @ApiProperty() createdAt!: string;
}
export class FraudHitDto {
  @ApiProperty({ enum: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'] }) ruleId!: string;
  @ApiProperty() weight!: number;
  @ApiProperty() explanation!: string;
}
export class FraudAiDto {
  @ApiProperty() status!: string;
  @ApiProperty({ type: Number, nullable: true }) probability!: number | null;
  @ApiProperty({ type: String, nullable: true }) model!: string | null;
  @ApiProperty({ type: String, nullable: true }) rubricSha256!: string | null;
}
export class FraudDetailDto extends FraudFlagDto {
  @ApiProperty({ type: [FraudHitDto] }) hits!: FraudHitDto[];
  @ApiProperty({
    type: [TransactionItemDto],
    description: 'Latest 10 movements of the sender account',
  })
  recentTransactions!: TransactionItemDto[];
  @ApiProperty({ type: FraudAiDto, nullable: true }) aiAssessment!: FraudAiDto | null;
}
export class FraudListDto {
  @ApiProperty({ type: [FraudFlagDto] }) items!: FraudFlagDto[];
  @ApiProperty({ type: String, nullable: true }) nextCursor!: string | null;
}
