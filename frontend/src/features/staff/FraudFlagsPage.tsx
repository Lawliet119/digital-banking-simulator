import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { call, type Schemas } from '../../api/client';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Icon, type IconName } from '../../components/Icon';
import { PageHead, Tag } from '../../components/ui';
import { formatDateTime } from '../../lib/dates';
import { formatVnd } from '../../lib/money';
import { POLL_INTERVAL_MS } from '../../lib/polling';
import { REVIEW_STATUS, REVIEW_TONE, RISK_LEVEL, RISK_TONE } from './labels';

type Level = 'MEDIUM' | 'HIGH' | '';
type Review = 'OPEN' | 'CONFIRMED_FRAUD' | 'FALSE_POSITIVE' | '';

const LEVELS: [Level, string][] = [
  ['', 'Tất cả mức'],
  ['HIGH', RISK_LEVEL.HIGH],
  ['MEDIUM', RISK_LEVEL.MEDIUM],
];

const REVIEWS: [Review, string][] = [
  ['OPEN', REVIEW_STATUS.OPEN],
  ['CONFIRMED_FRAUD', REVIEW_STATUS.CONFIRMED_FRAUD],
  ['FALSE_POSITIVE', REVIEW_STATUS.FALSE_POSITIVE],
  ['', 'Tất cả'],
];

const COUNTS: [keyof Schemas['FraudSummaryDto'], string, string, IconName][] = [
  ['open', REVIEW_STATUS.OPEN, 'warn', 'flag'],
  ['confirmedFraud', REVIEW_STATUS.CONFIRMED_FRAUD, 'out', 'lock'],
  ['falsePositive', REVIEW_STATUS.FALSE_POSITIVE, 'in', 'check'],
];

/** `/operator/fraud-flags`: counts per review state, then flags newest first, every 10 seconds. */
export function FraudFlagsPage() {
  const api = useApi();
  const [level, setLevel] = useState<Level>('');
  const [review, setReview] = useState<Review>('OPEN');
  const summary = useQuery({
    queryKey: ['operator', 'fraud-summary'],
    refetchInterval: POLL_INTERVAL_MS,
    queryFn: () => call(api.GET('/v1/operator/fraud-flags/summary')),
  });
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
    <>
      <PageHead title="Cờ gian lận" sub="Tự làm mới mỗi 10 giây." />
      <ErrorBanner error={summary.error} />
      <div className="grid tight">
        {COUNTS.map(([key, label, tone, icon]) => (
          <section key={key} className="card row nowrap">
            <span className={`tile ${tone}`}>
              <Icon name={icon} />
            </span>
            <div>
              <div className="eyebrow">{label}</div>
              <div className="big" data-testid={`count-${key}`}>
                {summary.data?.[key] ?? '—'}
              </div>
            </div>
          </section>
        ))}
      </div>
      <section className="panel">
        <div className="row between">
          <div className="row" role="group" aria-label="Lọc theo mức rủi ro">
            {LEVELS.map(([value, label]) => (
              <button
                key={label}
                type="button"
                className="chip"
                aria-pressed={level === value}
                onClick={() => setLevel(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <div className="row" role="group" aria-label="Lọc theo trạng thái review">
            {REVIEWS.map(([value, label]) => (
              <button
                key={label}
                type="button"
                className="chip"
                aria-pressed={review === value}
                onClick={() => setReview(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>
        <ErrorBanner error={flags.error} />
        {flags.isSuccess && items.length === 0 && <p className="empty">Không có cờ nào.</p>}
        {items.length > 0 && (
          <div className="scroll">
            <table>
              <thead>
                <tr>
                  <th>Thời điểm</th>
                  <th>Giao dịch</th>
                  <th>Từ → Đến</th>
                  <th className="num">Số tiền</th>
                  <th>Điểm</th>
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
                    <td>
                      {flag.fromOwnerName ?? '—'} → {flag.toOwnerName ?? '—'}
                    </td>
                    <td className="num">{formatVnd(flag.amount)}</td>
                    <td>
                      <b>{flag.score}</b>
                    </td>
                    <td>
                      <Tag tone={RISK_TONE[flag.riskLevel]}>{RISK_LEVEL[flag.riskLevel]}</Tag>
                    </td>
                    <td>
                      <Tag tone={REVIEW_TONE[flag.reviewStatus]}>
                        {REVIEW_STATUS[flag.reviewStatus]}
                      </Tag>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
    </>
  );
}
