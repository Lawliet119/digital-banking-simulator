import { useInfiniteQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { call, type Schemas } from '../../api/client';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Icon } from '../../components/Icon';
import { PageHead, Signed, Tag } from '../../components/ui';
import { formatDateTime } from '../../lib/dates';
import { formatVnd } from '../../lib/money';
import { POLL_INTERVAL_MS } from '../../lib/polling';
import { FlowPanel } from './Panels';
import { keys } from './queries';

const FILTERS = [
  ['all', 'Tất cả'],
  ['in', 'Tiền vào'],
  ['out', 'Tiền ra'],
  ['account', 'Tài khoản'],
] as const;

type Filter = (typeof FILTERS)[number][0];
type Notice = Schemas['NotificationItemDto'];

/** `/notifications`: the customer's notices with what moved, newest first, every 10 seconds. */
export function NotificationsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const [filter, setFilter] = useState<Filter>('all');
  const notices = useInfiniteQuery({
    queryKey: keys.notifications(filter),
    refetchInterval: POLL_INTERVAL_MS,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    queryFn: ({ pageParam }): Promise<Schemas['NotificationPageDto']> =>
      call(
        api.GET('/v1/notifications', {
          params: { query: { limit: 20, filter, ...(pageParam ? { cursor: pageParam } : {}) } },
        }),
      ),
  });
  const items = notices.data?.pages.flatMap(page => page.items) ?? [];
  const unread = notices.data?.pages[0]?.unreadCount ?? 0;
  const markRead = useMutation({
    mutationFn: (upToId: string) => call(api.POST('/v1/notifications/read', { body: { upToId } })),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: keys.allNotifications });
      void queryClient.invalidateQueries({ queryKey: keys.unread });
    },
  });
  const newest = items[0];

  return (
    <>
      <PageHead title="Thông báo" sub={unread ? `${unread} chưa đọc` : undefined}>
        <button
          type="button"
          className="secondary"
          disabled={!newest || unread === 0 || markRead.isPending}
          onClick={() => newest && markRead.mutate(newest.id)}
        >
          Đánh dấu đã đọc
        </button>
      </PageHead>
      <div className="split">
        <section className="panel">
          <div className="row" role="group" aria-label="Lọc thông báo">
            {FILTERS.map(([value, label]) => (
              <button
                key={value}
                type="button"
                className="chip"
                aria-pressed={filter === value}
                onClick={() => setFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <ErrorBanner error={notices.error ?? markRead.error} />
          {notices.isPending && <p aria-busy="true">Đang tải…</p>}
          {notices.isSuccess && items.length === 0 && <p className="empty">Chưa có thông báo.</p>}
          <ul className="items" aria-live="polite">
            {items.map(item => (
              <li key={item.id} data-testid="notification" className="item top">
                <NoticeBody item={item} />
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
        <FlowPanel days={1} />
      </div>
    </>
  );
}

function NoticeBody({ item }: { item: Notice }) {
  const transfer = item.transfer;
  const out = transfer?.direction === 'DEBIT';
  return (
    <>
      <span className={`tile ${transfer ? (out ? 'out' : 'in') : 'warn'}`}>
        <Icon name={transfer ? (out ? 'out' : 'in') : 'lock'} />
      </span>
      <div className="grow">
        <div className="row">
          <b>{item.message}</b>
          {!item.read && <Tag tone="info">Mới</Tag>}
        </div>
        {transfer?.counterpartyName && (
          <div>
            {out ? 'Đến' : 'Từ'} <b>{transfer.counterpartyName}</b> ·{' '}
            <span className="mono">{transfer.counterpartyAccountNumber}</span>
          </div>
        )}
        {item.accountNumber && (
          <div className="muted">
            Tài khoản <span className="mono">{item.accountNumber}</span>
            {transfer && <> · Số dư {formatVnd(transfer.balanceAfter)}</>}
          </div>
        )}
        <div className="muted">
          {formatDateTime(item.occurredAt)}
          {transfer && (
            <>
              {' · '}
              <Link to={`/transfers/${transfer.transferId}`}>Xem biên lai</Link>
            </>
          )}
        </div>
      </div>
      {transfer && <Signed direction={transfer.direction} amount={transfer.amount} />}
    </>
  );
}
