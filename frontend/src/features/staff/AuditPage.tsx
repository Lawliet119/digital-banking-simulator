import { useInfiniteQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { call, type Schemas } from '../../api/client';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Icon } from '../../components/Icon';
import { PageHead, Tag } from '../../components/ui';
import { formatDateTime } from '../../lib/dates';
import { AUDIT_OUTCOME, AUDIT_TONE } from './labels';

interface Filters {
  actorUserId?: string;
  action?: string;
  correlationId?: string;
  from?: string;
  to?: string;
}

/** `datetime-local` (Vietnam time, no seconds) → UTC `Z`, or undefined when empty or invalid. */
function vietnamLocalToUtc(value: string): string | undefined {
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value)) return undefined;
  const date = new Date(`${value}:00+07:00`);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
}

/**
 * `/audit`: read-only search of the audit log by actor, action, time window or correlation id.
 * There is no button that writes anything on this screen.
 */
export function AuditPage() {
  const api = useApi();
  const [form, setForm] = useState({ actor: '', action: '', correlation: '', from: '', to: '' });
  const [filters, setFilters] = useState<Filters | undefined>();
  const [chosenId, setChosenId] = useState<string | undefined>();
  const entries = useInfiniteQuery({
    queryKey: ['auditor', 'entries', filters],
    enabled: filters !== undefined,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    queryFn: ({ pageParam }): Promise<Schemas['AuditEntriesPageDto']> =>
      call(
        api.GET('/v1/audit/entries', {
          params: { query: { ...filters, limit: 50, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
  });

  function search(event: FormEvent) {
    event.preventDefault();
    const next: Filters = {};
    if (form.actor.trim()) next.actorUserId = form.actor.trim();
    if (form.action.trim()) next.action = form.action.trim();
    if (form.correlation.trim()) next.correlationId = form.correlation.trim();
    const from = vietnamLocalToUtc(form.from);
    const to = vietnamLocalToUtc(form.to);
    if (from) next.from = from;
    if (to) next.to = to;
    setChosenId(undefined);
    setFilters(next);
  }

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm(current => ({ ...current, [key]: event.target.value }));
  const items = entries.data?.pages.flatMap(page => page.entries) ?? [];
  const chosen = items.find(entry => entry.id === chosenId);

  return (
    <>
      <PageHead title="Nhật ký kiểm toán" />
      <form className="panel grid-form" onSubmit={search}>
        <label>
          Mã truy vết (correlationId)
          <input value={form.correlation} onChange={set('correlation')} autoComplete="off" />
        </label>
        <label>
          Người thực hiện (userId)
          <input value={form.actor} onChange={set('actor')} autoComplete="off" />
        </label>
        <label>
          Hành động
          <input value={form.action} onChange={set('action')} placeholder="ví dụ transfer" />
        </label>
        <label>
          Từ (giờ Việt Nam)
          <input type="datetime-local" value={form.from} onChange={set('from')} />
        </label>
        <label>
          Đến (giờ Việt Nam)
          <input type="datetime-local" value={form.to} onChange={set('to')} />
        </label>
        <button type="submit" className="dark">
          <Icon name="search" size={18} /> Tra cứu
        </button>
      </form>
      <ErrorBanner error={entries.error} />
      {entries.isSuccess && items.length === 0 && <p className="panel empty">Không có bản ghi.</p>}
      {items.length > 0 && (
        <div className={chosen ? 'split wide' : 'col'}>
          <section className="panel">
            <div className="scroll">
              <table className="compact">
                <thead>
                  <tr>
                    <th>Thời điểm</th>
                    <th>Hành động</th>
                    <th>Kết quả</th>
                    <th>Vai trò</th>
                    <th>Đối tượng</th>
                    <th>Mã truy vết</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(entry => (
                    <tr key={entry.id} data-testid="audit-row">
                      <td>
                        <button
                          type="button"
                          className="link"
                          aria-pressed={entry.id === chosenId}
                          onClick={() => setChosenId(entry.id)}
                        >
                          {formatDateTime(entry.occurredAt)}
                        </button>
                      </td>
                      <td className="mono">{entry.action}</td>
                      <td>
                        <Tag tone={AUDIT_TONE[entry.outcome]}>{AUDIT_OUTCOME[entry.outcome]}</Tag>
                      </td>
                      <td>{entry.actorRole}</td>
                      <td className="mono">
                        {entry.target.type}:{entry.target.id.slice(0, 8)}
                      </td>
                      <td className="mono">{entry.correlationId.slice(0, 8)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {entries.hasNextPage && (
              <button
                type="button"
                className="secondary"
                disabled={entries.isFetchingNextPage}
                onClick={() => void entries.fetchNextPage()}
              >
                Xem thêm
              </button>
            )}
          </section>
          {chosen && (
            <section className="panel" aria-label="Bản ghi đã chọn">
              <h2>Bản ghi đã chọn</h2>
              <pre className="code" data-testid="audit-record">
                {JSON.stringify(chosen, null, 2)}
              </pre>
            </section>
          )}
        </div>
      )}
    </>
  );
}
