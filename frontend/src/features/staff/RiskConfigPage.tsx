import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { call, type Schemas } from '../../api/client';
import { ApiProblem } from '../../api/problem';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Icon } from '../../components/Icon';
import { PageHead, Progress, Tag } from '../../components/ui';
import { formatDateTime } from '../../lib/dates';
import { readRules, readThresholds } from '../../lib/risk-config';
import { RULE_NAME } from './labels';

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
  const config = latest.data?.config;
  const thresholds = readThresholds(config);

  return (
    <>
      <PageHead
        title="Cấu hình luật gian lận"
        sub={
          latest.data && (
            <>
              Phiên bản đang hiệu lực:{' '}
              <strong data-testid="latest-version">{latest.data.version}</strong> (
              {formatDateTime(latest.data.createdAt)})
            </>
          )
        }
      >
        <Link to="/admin/risk-config/new" className="button">
          <Icon name="plus" size={18} /> Tạo phiên bản mới
        </Link>
      </PageHead>
      <ErrorBanner error={latest.error} />
      {latest.data === null && <p className="panel">Chưa có phiên bản nào.</p>}
      <div className="split">
        <div className="col">
          <div className="grid tight">
            {readRules(config).map(rule => (
              <section key={rule.id} className="panel" data-testid="rule-card">
                <div className="row between">
                  <span className="tile info">{rule.id}</span>
                  <Tag tone={rule.enabled ? 'ok' : 'bad'}>{rule.enabled ? 'Bật' : 'Tắt'}</Tag>
                </div>
                <b>{RULE_NAME[rule.id]}</b>
                <div className="row between">
                  <span className="muted">Trọng số</span>
                  <b>{rule.weight}</b>
                </div>
                <Progress
                  percent={Math.min(100, Math.max(0, rule.weight))}
                  label={`Trọng số ${rule.id}`}
                />
              </section>
            ))}
          </div>
          {config && (
            <details className="panel">
              <summary>Xem đầy đủ (JSON)</summary>
              <pre className="code">{JSON.stringify(config, null, 2)}</pre>
            </details>
          )}
        </div>
        <div className="col">
          {thresholds && (
            <section className="panel">
              <h2>Ngưỡng gắn cờ</h2>
              <div className="row between">
                <Tag tone="warn">Trung bình</Tag>
                <b>từ {thresholds.medium}</b>
              </div>
              <div className="row between">
                <Tag tone="bad">Cao</Tag>
                <b>từ {thresholds.high}</b>
              </div>
            </section>
          )}
          <section className="panel">
            <h2>Lịch sử phiên bản</h2>
            <ErrorBanner error={versions.error} />
            <ul className="items">
              {items.map(item => (
                <li key={item.version} className="item">
                  <div className="grow">
                    <button
                      type="button"
                      className="chip"
                      aria-pressed={shown === item.version}
                      onClick={() => setShown(item.version)}
                    >
                      Phiên bản {item.version}
                    </button>
                    <div className="muted">
                      {formatDateTime(item.createdAt)}
                      {item.createdBy ? ` · ${item.createdBy}` : ''}
                    </div>
                  </div>
                </li>
              ))}
            </ul>
            {versions.hasNextPage && (
              <button
                type="button"
                className="secondary"
                onClick={() => void versions.fetchNextPage()}
              >
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
        </div>
      </div>
    </>
  );
}
