import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';
import { ApiProperty } from '@nestjs/swagger';

/** What a customer learns about a recipient from the number: who to confirm with, nothing else. */
export class AccountLookupDto {
  @ApiProperty({ format: 'uuid', example: '2e859a80-d4d0-471d-8cee-e9d0de9d4bc7' })
  accountId!: string;

  @ApiProperty({ type: String, pattern: '^[0-9]{12}$', example: '100000000001' })
  accountNumber!: string;

  @ApiProperty({ type: String, example: 'Nguyễn Minh Anh' })
  ownerName!: string;
}

const ACCOUNT_NUMBER = /^[0-9]{12}$/;

/** `?accountNumber=<12 digits>` and nothing else; anything different is a 400, not a 404. */
export function parseLookupQuery(raw: unknown): string {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new BadRequestException({ errors: ['query must contain scalar parameters'] });
  }
  const query = raw as Record<string, unknown>;
  if (Object.keys(query).some(key => key !== 'accountNumber')) {
    throw new BadRequestException({ errors: ['unknown query parameter'] });
  }
  const value = query.accountNumber;
  if (typeof value !== 'string' || !ACCOUNT_NUMBER.test(value)) {
    throw new BadRequestException({ errors: ['accountNumber must be exactly 12 digits'] });
  }
  return value;
}

@Injectable()
export class LookupQueryPipe implements PipeTransform<unknown, string> {
  transform(value: unknown): string {
    return parseLookupQuery(value);
  }
}
