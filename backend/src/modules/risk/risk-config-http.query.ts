import { BadRequestException, type PipeTransform } from '@nestjs/common';

export interface RiskConfigQuery {
  limit: number;
  before: number | null;
}

function positiveInt(value: unknown, max: number): number {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value) || value.length > 10) {
    throw new BadRequestException('Invalid risk configuration query');
  }
  const result = Number(value);
  if (!Number.isSafeInteger(result) || result > max) {
    throw new BadRequestException('Invalid risk configuration query');
  }
  return result;
}

export class RiskConfigQueryPipe implements PipeTransform<unknown, RiskConfigQuery> {
  transform(value: unknown): RiskConfigQuery {
    if (typeof value !== 'object' || value === null || Array.isArray(value)) {
      throw new BadRequestException('Invalid risk configuration query');
    }
    const query = value as Record<string, unknown>;
    if (Object.keys(query).some(key => key !== 'limit' && key !== 'before')) {
      throw new BadRequestException('Invalid risk configuration query');
    }
    return {
      limit: query.limit === undefined ? 50 : positiveInt(query.limit, 100),
      before: query.before === undefined ? null : positiveInt(query.before, 2_147_483_647),
    };
  }
}

export function parseRiskConfigVersion(value: unknown): number {
  return positiveInt(value, 2_147_483_647);
}
