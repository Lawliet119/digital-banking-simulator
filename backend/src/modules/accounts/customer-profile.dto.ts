import { Transform } from 'class-transformer';
import { IsString, Length, Matches } from 'class-validator';
import { ApiProperty } from '@nestjs/swagger';

export class CreateCustomerProfileDto {
  @ApiProperty({ example: 'Nguyễn Minh Anh', minLength: 1, maxLength: 200 })
  @Transform(({ value }: { value: unknown }) =>
    typeof value === 'string' ? value.normalize('NFC').trim() : value,
  )
  @IsString()
  @Length(1, 200)
  // Explicitly reject ASCII control characters in a human display name.
  // eslint-disable-next-line no-control-regex
  @Matches(/^[^\u0000-\u001f\u007f]*$/)
  fullName!: string;
}

export class CustomerProfileDto {
  @ApiProperty({ format: 'uuid', example: 'c747b4f1-7a29-45e3-8538-b7639ce6cd23' })
  id!: string;

  @ApiProperty({ example: 'Nguyễn Minh Anh' })
  fullName!: string;

  @ApiProperty({ format: 'date-time', example: '2026-11-02T00:00:00.000Z' })
  createdAt!: string;
}
