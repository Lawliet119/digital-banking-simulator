import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { call, type Schemas } from '../../api/client';
import { ApiProblem } from '../../api/problem';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { formatDateTime } from '../../lib/dates';

/** The newest committed version, or `null` when none exists yet (404). */
export function useLatestRiskConfig() {
  const api = useApi();
  return useQuery({
    queryKey: ['admin', 'risk-config', 'latest'],
    queryFn: async () => {
      try {
        return await call(api.GET('/v1/admin/risk-config'));
      } catch (error) {
        if (error instanceof ApiProblem && error.status === 404) return null;
        throw error;
      }
    },
  });
}

/** `/admin/risk-config`: the version in force and the list of versions. */
export function RiskConfigPage() {
  const api = useApi();
  const latest = useLatestRiskConfig();
  const [shown, setShown] = useState<number | undefined>();
  const versions = useInfiniteQuery({
    queryKey: ['admin', 'risk-config', 'versions'],
    initialPageParam: undefined as number | undefined,
    getNextPageParam: (last: { nextBefore: number | null }) => last.nextBefore ?? undefined,
    queryFn: ({ pageParam }): Promise<Schemas['RiskConfigListDto']> =>
      call(
        api.GET('/v1/admin/risk-config/versions', {
          params: { query: { limit: 20, ...(pageParam ? { before: pageParam } : {}) } },
        }),
      ),
  });
  const one = useQuery({
    queryKey: ['admin', 'risk-config', 'version', shown],
    enabled: shown !== undefined,
    queryFn: () =>
      call(
        api.GET('/v1/admin/risk-config/versions/{version}', {
          params: { path: { version: String(shown ?? 0) } },
        }),
      ),
  });
  const items = versions.data?.pages.flatMap(page => page.items) ?? [];

  return (
    <>
      <section className="panel">
        <h1>Cấu hình luật gian lận</h1>
        <ErrorBanner error={latest.error} />
        {latest.data === null && <p>Chưa có phiên bản nào.</p>}
        {latest.data && (
          <>
            <p>
              Phiên bản đang hiệu lực:{' '}
              <strong data-testid="latest-version">{latest.data.version}</strong>{' '}
              <span className="muted">({formatDateTime(latest.data.createdAt)})</span>
            </p>
            <pre className="code">{JSON.stringify(latest.data.config, null, 2)}</pre>
          </>
        )}
        <Link to="/admin/risk-config/new">Tạo phiên bản mới</Link>
      </section>
      <section className="panel">
        <h2>Các phiên bản</h2>
        <ErrorBanner error={versions.error} />
        <ul>
          {items.map(item => (
            <li key={item.version}>
              <button type="button" className="link" onClick={() => setShown(item.version)}>
                Phiên bản {item.version}
              </button>{' '}
              <span className="muted">
                {formatDateTime(item.createdAt)}
                {item.createdBy ? ` · ${item.createdBy}` : ''}
              </span>
            </li>
          ))}
        </ul>
        {versions.hasNextPage && (
          <button type="button" className="secondary" onClick={() => void versions.fetchNextPage()}>
            Xem thêm
          </button>
        )}
        {shown !== undefined && (
          <>
            <h3>Phiên bản {shown}</h3>
            <ErrorBanner error={one.error} />
            {one.data && <pre className="code">{JSON.stringify(one.data.config, null, 2)}</pre>}
          </>
        )}
      </section>
    </>
  );
}
