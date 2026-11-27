import { useInfiniteQuery } from '@tanstack/react-query';
import { call, type Schemas } from '../../api/client';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { formatDateTime } from '../../lib/dates';
import { POLL_INTERVAL_MS } from '../../lib/polling';
import { NOTIFICATION_KIND } from './labels';
import { keys } from './queries';

/** `/notifications`: the customer's notices, newest first, refreshed every 10 seconds. */
export function NotificationsPage() {
  const api = useApi();
  const notices = useInfiniteQuery({
    queryKey: keys.notifications,
    refetchInterval: POLL_INTERVAL_MS,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    queryFn: ({ pageParam }): Promise<Schemas['NotificationPageDto']> =>
      call(
        api.GET('/v1/notifications', {
          params: { query: { limit: 20, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
  });
  const items = notices.data?.pages.flatMap(page => page.items) ?? [];
  return (
    <section className="panel">
      <h1>Thông báo</h1>
      <ErrorBanner error={notices.error} />
      {notices.isPending && <p aria-busy="true">Đang tải…</p>}
      {notices.isSuccess && items.length === 0 && <p>Chưa có thông báo.</p>}
      <ul className="notices" aria-live="polite">
        {items.map(item => (
          <li key={item.id} data-testid="notification">
            <span className="tag">{NOTIFICATION_KIND[item.kind]}</span> {item.message}
            <br />
            <small className="muted">{formatDateTime(item.occurredAt)}</small>
          </li>
        ))}
      </ul>
      {notices.hasNextPage && (
        <button
          type="button"
          className="secondary"
          disabled={notices.isFetchingNextPage}
          onClick={() => void notices.fetchNextPage()}
        >
          {notices.isFetchingNextPage ? 'Đang tải…' : 'Xem thêm'}
        </button>
      )}
    </section>
  );
}
