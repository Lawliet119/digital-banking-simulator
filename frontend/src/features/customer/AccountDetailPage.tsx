import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { call, type Schemas } from '../../api/client';
import { ApiProblem } from '../../api/problem';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { formatDateTime, vietnamDayEnd, vietnamDayStart } from '../../lib/dates';
import { formatVnd } from '../../lib/money';
import { ACCOUNT_STATUS, ACCOUNT_TYPE, TRANSFER_TYPE } from './labels';
import { keys } from './queries';

const PAGE = 20;

/** `/accounts/:id`: one owned account and its history, filtered by Vietnam calendar days. */
export function AccountDetailPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [filter, setFilter] = useState<{ from: string | null; to: string | null }>({
    from: null,
    to: null,
  });
  const [filterError, setFilterError] = useState<string | undefined>();

  const account = useQuery({
    queryKey: keys.account(id),
    queryFn: () => call(api.GET('/v1/accounts/{id}', { params: { path: { id } } })),
  });
  const history = useInfiniteQuery({
    queryKey: keys.history(id, filter.from, filter.to),
    enabled: account.isSuccess,
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last: { nextCursor: string | null }) => last.nextCursor ?? undefined,
    queryFn: ({ pageParam }): Promise<Schemas['TransactionPageDto']> =>
      call(
        api.GET('/v1/accounts/{id}/transactions', {
          params: {
            path: { id },
            query: {
              limit: PAGE,
              ...(filter.from ? { from: filter.from } : {}),
              ...(filter.to ? { to: filter.to } : {}),
              ...(pageParam ? { cursor: pageParam } : {}),
            },
          },
        }),
      ),
  });

  function applyFilter(event: FormEvent) {
    event.preventDefault();
    const from = fromDay ? vietnamDayStart(fromDay) : null;
    const to = toDay ? vietnamDayEnd(toDay) : null;
    if ((fromDay && !from) || (toDay && !to)) return setFilterError('Ngày không hợp lệ.');
    if (from && to && from >= to) return setFilterError('"Từ ngày" phải trước "Đến ngày".');
    setFilterError(undefined);
    setFilter({ from, to });
  }

  if (account.error instanceof ApiProblem && account.error.status === 404) {
    return (
      <section className="panel">
        <h1>Không tìm thấy</h1>
        <p>
          <Link to="/accounts">Về danh sách tài khoản</Link>
        </p>
      </section>
    );
  }

  const items = history.data?.pages.flatMap(page => page.items) ?? [];

  return (
    <>
      <section className="panel">
        <ErrorBanner error={account.error} />
        {account.data && (
          <>
            <h1 className="mono">{account.data.accountNumber}</h1>
            <dl className="facts">
              <dt>Loại</dt>
              <dd>{ACCOUNT_TYPE[account.data.type]}</dd>
              <dt>Trạng thái</dt>
              <dd>{ACCOUNT_STATUS[account.data.status]}</dd>
              <dt>Số dư</dt>
              <dd data-testid="balance">{formatVnd(account.data.balance)}</dd>
            </dl>
          </>
        )}
      </section>
      <section className="panel">
        <h2>Lịch sử giao dịch</h2>
        <form className="row" onSubmit={applyFilter}>
          <label>
            Từ ngày <input type="date" value={fromDay} onChange={e => setFromDay(e.target.value)} />
          </label>
          <label>
            Đến ngày <input type="date" value={toDay} onChange={e => setToDay(e.target.value)} />
          </label>
          <button type="submit">Lọc</button>
        </form>
        {filterError && (
          <p role="alert" className="error">
            {filterError}
          </p>
        )}
        <ErrorBanner error={history.error} />
        {history.isSuccess && items.length === 0 && <p>Chưa có giao dịch.</p>}
        {items.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Thời điểm</th>
                <th>Loại</th>
                <th>Tài khoản đối ứng</th>
                <th className="num">Số tiền</th>
                <th className="num">Số dư sau</th>
              </tr>
            </thead>
            <tbody>
              {items.map(item => (
                <tr key={item.entryId} data-testid="history-row">
                  <td>
                    <Link to={`/transfers/${item.transferId}`}>
                      {formatDateTime(item.createdAt)}
                    </Link>
                  </td>
                  <td>{TRANSFER_TYPE[item.type]}</td>
                  <td className="mono">{item.counterpartyAccountNumber ?? '—'}</td>
                  <td className={`num ${item.direction === 'DEBIT' ? 'debit' : 'credit'}`}>
                    {item.direction === 'DEBIT' ? '−' : '+'}
                    {formatVnd(item.amount)}
                  </td>
                  <td className="num">{formatVnd(item.balanceAfter)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {history.hasNextPage && (
          <button
            type="button"
            className="secondary"
            disabled={history.isFetchingNextPage}
            onClick={() => void history.fetchNextPage()}
          >
            {history.isFetchingNextPage ? 'Đang tải…' : 'Xem thêm'}
          </button>
        )}
      </section>
    </>
  );
}
