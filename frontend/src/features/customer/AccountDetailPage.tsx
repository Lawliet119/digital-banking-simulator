import { useInfiniteQuery, useQuery } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { call, type Schemas } from '../../api/client';
import { ApiProblem } from '../../api/problem';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { CopyButton, PageHead, Signed, Tag } from '../../components/ui';
import { formatDateTime, vietnamDayEnd, vietnamDayStart } from '../../lib/dates';
import { formatVnd } from '../../lib/money';
import { ACCOUNT_STATUS, ACCOUNT_TYPE, TRANSFER_TYPE } from './labels';
import { LimitPanel } from './Panels';
import { keys } from './queries';

const PAGE = 20;

const DIRECTIONS = [
  ['', 'Tất cả'],
  ['CREDIT', 'Tiền vào'],
  ['DEBIT', 'Tiền ra'],
] as const;

type Direction = (typeof DIRECTIONS)[number][0];

/** `/accounts/:id`: one owned account and its history, filtered by side and Vietnam days. */
export function AccountDetailPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const [fromDay, setFromDay] = useState('');
  const [toDay, setToDay] = useState('');
  const [direction, setDirection] = useState<Direction>('');
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
    queryKey: keys.history(id, filter.from, filter.to, direction),
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
              ...(direction ? { direction } : {}),
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
  const data = account.data;

  return (
    <>
      <PageHead
        title={<span className="mono">{data?.accountNumber ?? '…'}</span>}
        sub={data ? `Tài khoản ${ACCOUNT_TYPE[data.type].toLowerCase()}` : undefined}
      >
        {data && <CopyButton text={data.accountNumber} label="Sao chép số tài khoản" />}
        <Link to="/transfer" className="button">
          Chuyển khoản
        </Link>
      </PageHead>
      <ErrorBanner error={account.error} />
      <div className="split">
        {data && (
          <section className="balance-card">
            <div className="row between">
              <b>{ACCOUNT_TYPE[data.type]}</b>
              <Tag tone={data.status === 'ACTIVE' ? 'ok' : 'bad'}>
                {ACCOUNT_STATUS[data.status]}
              </Tag>
            </div>
            <div>
              <div>Số dư khả dụng</div>
              <div className="big huge" data-testid="balance">
                {formatVnd(data.balance)}
              </div>
            </div>
          </section>
        )}
        {data && <LimitPanel accountId={data.id} />}
      </div>
      <section className="panel">
        <h2>Lịch sử giao dịch</h2>
        <div className="row between">
          <div className="row" role="group" aria-label="Lọc theo chiều tiền">
            {DIRECTIONS.map(([value, label]) => (
              <button
                key={label}
                type="button"
                className="chip"
                aria-pressed={direction === value}
                onClick={() => setDirection(value)}
              >
                {label}
              </button>
            ))}
          </div>
          <form className="row bottom" onSubmit={applyFilter}>
            <label className="field">
              <span className="label">Từ ngày</span>
              <input type="date" value={fromDay} onChange={e => setFromDay(e.target.value)} />
            </label>
            <label className="field">
              <span className="label">Đến ngày</span>
              <input type="date" value={toDay} onChange={e => setToDay(e.target.value)} />
            </label>
            <button type="submit" className="secondary">
              Lọc
            </button>
          </form>
        </div>
        {filterError && (
          <p role="alert" className="error">
            {filterError}
          </p>
        )}
        <ErrorBanner error={history.error} />
        {history.isSuccess && items.length === 0 && <p className="empty">Chưa có giao dịch.</p>}
        {items.length > 0 && (
          <div className="scroll">
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
                    <td className="num">
                      <Signed direction={item.direction} amount={item.amount} />
                    </td>
                    <td className="num">{formatVnd(item.balanceAfter)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
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
