import { BadRequestException, Injectable, type PipeTransform } from '@nestjs/common';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{6}Z$/;
export interface FraudQuery {
  status: string;
  level: string | null;
  limit: number;
  after: { rank: number; time: string; id: string } | null;
}
export function cursorFor(
  query: FraudQuery,
  row: { riskLevel: string; createdAt: string; transferId: string },
): string {
  return Buffer.from(
    JSON.stringify([
      query.status,
      query.level,
      row.riskLevel === 'HIGH' ? 0 : 1,
      row.createdAt,
      row.transferId,
    ]),
  ).toString('base64url');
}
@Injectable()
export class FraudQueryPipe implements PipeTransform<unknown, FraudQuery> {
  transform(value: unknown): FraudQuery {
    const bad = (): never => {
      throw new BadRequestException('Invalid fraud query');
    };
    if (!value || typeof value !== 'object' || Array.isArray(value)) return bad();
    const q = value as Record<string, unknown>;
    if (Object.keys(q).some(key => !['review_status', 'level', 'limit', 'cursor'].includes(key)))
      return bad();
    const status = q.review_status ?? 'OPEN';
    const level = q.level ?? null;
    if (
      typeof status !== 'string' ||
      !['OPEN', 'CONFIRMED_FRAUD', 'FALSE_POSITIVE'].includes(status)
    )
      return bad();
    if (level !== null && (typeof level !== 'string' || !['MEDIUM', 'HIGH'].includes(level)))
      return bad();
    if (
      q.limit !== undefined &&
      (typeof q.limit !== 'string' || !/^(?:[1-9]\d?|100)$/.test(q.limit))
    )
      return bad();
    const result: FraudQuery = { status, level, limit: Number(q.limit ?? 20), after: null };
    if (q.cursor !== undefined) {
      if (
        typeof q.cursor !== 'string' ||
        q.cursor.length > 512 ||
        !/^[A-Za-z0-9_-]+$/.test(q.cursor)
      )
        return bad();
      let decoded: unknown;
      try {
        decoded = JSON.parse(Buffer.from(q.cursor, 'base64url').toString('utf8'));
      } catch {
        return bad();
      }
      if (!Array.isArray(decoded) || decoded.length !== 5) return bad();
      const [s, l, rank, time, id] = decoded as unknown[];
      if (
        s !== status ||
        l !== level ||
        (rank !== 0 && rank !== 1) ||
        typeof time !== 'string' ||
        !TIME.test(time) ||
        time.startsWith('0000-') ||
        !Number.isFinite(Date.parse(time)) ||
        typeof id !== 'string' ||
        !UUID.test(id)
      )
        return bad();
      // Validate the calendar without using the millisecond Date as the pagination key.
      if (new Date(time).toISOString().slice(0, 23) !== time.slice(0, 23)) return bad();
      result.after = { rank, time, id };
    }
    return result;
  }
}
