import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { call } from '../../api/client';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { BalanceChart, Movement, PageHead, Tag } from '../../components/ui';
import { formatVnd } from '../../lib/money';
import { ACCOUNT_STATUS, ACCOUNT_TYPE, TRANSFER_TYPE } from './labels';
import { FlowPanel, LimitPanel } from './Panels';
import { useAccounts, useProfile, useRecentMovements } from './queries';

/** `/accounts`: the customer's overview: balances, recent movements, limits. */
export function AccountsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const profile = useProfile();
  const accounts = useAccounts();
  const [type, setType] = useState<'CHECKING' | 'SAVINGS'>('CHECKING');
  const open = useMutation({
    mutationFn: () => call(api.POST('/v1/accounts', { body: { type } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['customer'] }),
  });
  const list = accounts.data ?? [];
  const main = list[0];
  const recent = useRecentMovements(main?.id);
  const movements = recent.data?.items ?? [];
  // BigInt: balances may be larger than a JavaScript number can hold exactly.
  const total = list.reduce((sum, account) => sum + BigInt(account.balance), 0n).toString();

  return (
    <>
      <PageHead title={`Chào ${profile.data?.fullName ?? 'bạn'}`} />
      <ErrorBanner error={accounts.error} />
      {accounts.isPending && <p aria-busy="true">Đang tải…</p>}
      {accounts.data && list.length === 0 && <p className="panel">Bạn chưa có tài khoản nào.</p>}
      {list.length > 0 && (
        <div className="grid">
          <section className="panel">
            <span className="eyebrow">Tổng số dư</span>
            <div className="big" data-testid="total-balance">
              {formatVnd(total)}
            </div>
            <span className="muted">{list.length} tài khoản</span>
          </section>
          {list.map((account, index) => (
            <section
              key={account.id}
              className={`balance-card ${index % 2 ? 'alt' : ''}`}
              data-testid="account-row"
            >
              <div className="row between">
                <b>{ACCOUNT_TYPE[account.type]}</b>
                <Tag tone="ok">{ACCOUNT_STATUS[account.status]}</Tag>
              </div>
              <div>
                <Link to={`/accounts/${account.id}`} className="mono">
                  {account.accountNumber}
                </Link>
                <div className="big" data-testid="balance">
                  {formatVnd(account.balance)}
                </div>
              </div>
            </section>
          ))}
        </div>
      )}

      <div className="split">
        <div className="col">
          {main && (
            <section className="panel">
              <div className="row between">
                <h2>Giao dịch gần đây</h2>
                <Link to={`/accounts/${main.id}`}>Xem tất cả</Link>
              </div>
              <ErrorBanner error={recent.error} />
              {recent.isSuccess && movements.length === 0 && (
                <p className="empty">Chưa có giao dịch.</p>
              )}
              <ul className="items">
                {movements.slice(0, 5).map(item => (
                  <li key={item.entryId}>
                    <Link to={`/transfers/${item.transferId}`} className="item">
                      <Movement
                        direction={item.direction}
                        title={TRANSFER_TYPE[item.type]}
                        subtitle={item.counterpartyAccountNumber}
                        amount={item.amount}
                        balanceAfter={item.balanceAfter}
                        at={item.createdAt}
                      />
                    </Link>
                  </li>
                ))}
              </ul>
            </section>
          )}
          <section className="panel">
            <h2>Mở tài khoản mới</h2>
            <div className="row">
              <label className="row nowrap">
                <span className="label">Loại</span>
                <select
                  value={type}
                  onChange={event => setType(event.target.value as 'CHECKING' | 'SAVINGS')}
                >
                  <option value="CHECKING">{ACCOUNT_TYPE.CHECKING}</option>
                  <option value="SAVINGS">{ACCOUNT_TYPE.SAVINGS}</option>
                </select>
              </label>
              <button type="button" disabled={open.isPending} onClick={() => open.mutate()}>
                {open.isPending ? 'Đang mở…' : 'Mở tài khoản'}
              </button>
            </div>
            <ErrorBanner error={open.error} />
          </section>
        </div>
        {main && (
          <div className="col">
            <section className="panel">
              <h2>Biến động số dư · {ACCOUNT_TYPE[main.type]}</h2>
              <BalanceChart balances={[...movements].reverse().map(item => item.balanceAfter)} />
            </section>
            <FlowPanel days={30} />
            <LimitPanel accountId={main.id} />
          </div>
        )}
      </div>
    </>
  );
}
