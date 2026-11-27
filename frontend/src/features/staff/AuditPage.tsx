import { useInfiniteQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { call, type Schemas } from '../../api/client';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { formatDateTime } from '../../lib/dates';
import { AUDIT_OUTCOME } from './labels';

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
    setFilters(next);
  }

  const set = (key: keyof typeof form) => (event: { target: { value: string } }) =>
    setForm(current => ({ ...current, [key]: event.target.value }));
  const items = entries.data?.pages.flatMap(page => page.entries) ?? [];

  return (
    <section className="panel">
      <h1>Nhật ký kiểm toán</h1>
      <form className="grid-form" onSubmit={search}>
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
          <input value={form.action} onChange={set('action')} placeholder="ví dụ transfer.create" />
        </label>
        <label>
          Từ (giờ Việt Nam)
          <input type="datetime-local" value={form.from} onChange={set('from')} />
        </label>
        <label>
          Đến (giờ Việt Nam)
          <input type="datetime-local" value={form.to} onChange={set('to')} />
        </label>
        <button type="submit">Tra cứu</button>
      </form>
      <ErrorBanner error={entries.error} />
      {entries.isSuccess && items.length === 0 && <p>Không có bản ghi.</p>}
      {items.length > 0 && (
        <table>
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
                <td>{formatDateTime(entry.occurredAt)}</td>
                <td className="mono">{entry.action}</td>
                <td>{AUDIT_OUTCOME[entry.outcome]}</td>
                <td>{entry.actorRole}</td>
                <td className="mono">
                  {entry.target.type}:{entry.target.id.slice(0, 8)}
                </td>
                <td className="mono">{entry.correlationId.slice(0, 8)}…</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
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
  );
}
