import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { TransactionItemDto } from '@modules/ledger';

export class ReviewFraudDto {
  @ApiProperty({ enum: ['CONFIRMED_FRAUD', 'FALSE_POSITIVE'], example: 'FALSE_POSITIVE' })
  @IsIn(['CONFIRMED_FRAUD', 'FALSE_POSITIVE'])
  decision!: 'CONFIRMED_FRAUD' | 'FALSE_POSITIVE';

  @ApiPropertyOptional({ maxLength: 1000, example: 'Đã xác minh với khách hàng' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  note?: string;
}

export class FraudFlagDto {
  @ApiProperty({ format: 'uuid', example: '11111111-1111-4111-8111-111111111111' })
  transferId!: string;
  @ApiProperty({ format: 'uuid', example: '22222222-2222-4222-8222-222222222222' })
  fromAccountId!: string;
  @ApiProperty({ format: 'uuid', example: '33333333-3333-4333-8333-333333333333' })
  toAccountId!: string;
  @ApiProperty({ example: 45, description: 'Tổng điểm rule và AI; không tự cộng hits' })
  score!: number;
  @ApiProperty({ enum: ['MEDIUM', 'HIGH'], example: 'MEDIUM' }) riskLevel!: string;
  @ApiProperty({ enum: ['OPEN', 'CONFIRMED_FRAUD', 'FALSE_POSITIVE'], example: 'OPEN' })
  reviewStatus!: string;
  @ApiProperty({ example: 2 }) ruleSetVersion!: number;
  @ApiProperty({ format: 'date-time', example: '2026-11-10T10:00:00.123456Z' }) createdAt!: string;
}
export class FraudHitDto {
  @ApiProperty({ enum: ['R1', 'R2', 'R3', 'R4', 'R5', 'R6'], example: 'R1' }) ruleId!: string;
  @ApiProperty({ example: 30 }) weight!: number;
  @ApiProperty({ example: '6 giao dịch trong 10 phút' }) explanation!: string;
}
export class FraudAiDto {
  @ApiProperty({ example: 'SUCCEEDED' }) status!: string;
  @ApiProperty({ type: Number, nullable: true, example: 0.95 }) probability!: number | null;
  @ApiProperty({ type: String, nullable: true, example: 'gpt-6-luna' }) model!: string | null;
  @ApiProperty({ type: String, nullable: true, example: '0'.repeat(64) }) rubricSha256!:
    string | null;
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

export class FraudProblemDto {
  @ApiProperty({ example: 'about:blank' }) type!: string;
  @ApiProperty({ example: 'Conflict' }) title!: string;
  @ApiProperty({ example: 409 }) status!: number;
  @ApiProperty({ example: 'Fraud flag already reviewed' }) detail!: string;
  @ApiProperty({ format: 'uuid' }) correlationId!: string;
  @ApiPropertyOptional({
    example: 'FLAG_ALREADY_REVIEWED',
    description: 'Mã lỗi khi có; lỗi validation và not found không có errorCode',
  })
  errorCode?: string;
  @ApiPropertyOptional({ type: [String] }) errors?: string[];
}
