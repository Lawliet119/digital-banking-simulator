import { useInfiniteQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { call, type Schemas } from '../../api/client';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { formatDateTime } from '../../lib/dates';
import { POLL_INTERVAL_MS } from '../../lib/polling';
import { REVIEW_STATUS, RISK_LEVEL } from './labels';

type Level = 'MEDIUM' | 'HIGH' | '';
type Review = 'OPEN' | 'CONFIRMED_FRAUD' | 'FALSE_POSITIVE' | '';

/** `/operator/fraud-flags`: flags newest first, filtered, refreshed every 10 seconds. */
export function FraudFlagsPage() {
  const api = useApi();
  const [level, setLevel] = useState<Level>('');
  const [review, setReview] = useState<Review>('OPEN');
  const flags = useInfiniteQuery({
    queryKey: ['operator', 'fraud-flags', level, review],
    refetchInterval: POLL_INTERVAL_MS,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    queryFn: ({ pageParam }): Promise<Schemas['FraudListDto']> =>
      call(
        api.GET('/v1/operator/fraud-flags', {
          params: {
            query: {
              limit: 20,
              ...(level ? { level } : {}),
              ...(review ? { review_status: review } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
  });
  const items = flags.data?.pages.flatMap(page => page.items) ?? [];

  return (
    <section className="panel">
      <h1>Cờ gian lận</h1>
      <div className="row">
        <label>
          Mức rủi ro{' '}
          <select value={level} onChange={event => setLevel(event.target.value as Level)}>
            <option value="">Tất cả</option>
            <option value="HIGH">{RISK_LEVEL.HIGH}</option>
            <option value="MEDIUM">{RISK_LEVEL.MEDIUM}</option>
          </select>
        </label>
        <label>
          Review{' '}
          <select value={review} onChange={event => setReview(event.target.value as Review)}>
            <option value="">Tất cả</option>
            <option value="OPEN">{REVIEW_STATUS.OPEN}</option>
            <option value="CONFIRMED_FRAUD">{REVIEW_STATUS.CONFIRMED_FRAUD}</option>
            <option value="FALSE_POSITIVE">{REVIEW_STATUS.FALSE_POSITIVE}</option>
          </select>
        </label>
        <span className="muted">Tự làm mới mỗi 10 giây</span>
      </div>
      <ErrorBanner error={flags.error} />
      {flags.isSuccess && items.length === 0 && <p>Không có cờ nào.</p>}
      {items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Thời điểm</th>
              <th>Giao dịch</th>
              <th className="num">Điểm</th>
              <th>Mức</th>
              <th>Review</th>
            </tr>
          </thead>
          <tbody>
            {items.map(flag => (
              <tr key={flag.transferId} data-testid="flag-row">
                <td>{formatDateTime(flag.createdAt)}</td>
                <td>
                  <Link to={`/operator/fraud-flags/${flag.transferId}`} className="mono">
                    {flag.transferId.slice(0, 8)}…
                  </Link>
                </td>
                <td className="num">{flag.score}</td>
                <td>{RISK_LEVEL[flag.riskLevel]}</td>
                <td>{REVIEW_STATUS[flag.reviewStatus]}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {flags.hasNextPage && (
        <button
          type="button"
          className="secondary"
          disabled={flags.isFetchingNextPage}
          onClick={() => void flags.fetchNextPage()}
        >
          Xem thêm
        </button>
      )}
    </section>
  );
}
