import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { call } from '../../api/client';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { formatVnd } from '../../lib/money';
import { ACCOUNT_STATUS, ACCOUNT_TYPE } from './labels';
import { keys, useAccounts, useProfile } from './queries';

/** `/accounts`: the customer's accounts and their committed balances; open a new one. */
export function AccountsPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const profile = useProfile();
  const accounts = useAccounts();
  const [type, setType] = useState<'CHECKING' | 'SAVINGS'>('CHECKING');
  const open = useMutation({
    mutationFn: () => call(api.POST('/v1/accounts', { body: { type } })),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: keys.accounts }),
  });

  return (
    <>
      <section className="panel">
        <h1>Tài khoản của {profile.data?.fullName ?? 'bạn'}</h1>
        <ErrorBanner error={accounts.error} />
        {accounts.isPending && <p aria-busy="true">Đang tải…</p>}
        {accounts.data && accounts.data.length === 0 && <p>Bạn chưa có tài khoản nào.</p>}
        {accounts.data && accounts.data.length > 0 && (
          <table>
            <thead>
              <tr>
                <th>Số tài khoản</th>
                <th>Loại</th>
                <th>Trạng thái</th>
                <th className="num">Số dư</th>
              </tr>
            </thead>
            <tbody>
              {accounts.data.map(account => (
                <tr key={account.id} data-testid="account-row">
                  <td>
                    <Link to={`/accounts/${account.id}`} className="mono">
                      {account.accountNumber}
                    </Link>
                  </td>
                  <td>{ACCOUNT_TYPE[account.type]}</td>
                  <td>{ACCOUNT_STATUS[account.status]}</td>
                  <td className="num" data-testid="balance">
                    {formatVnd(account.balance)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="panel">
        <h2>Mở tài khoản mới</h2>
        <div className="row">
          <label>
            Loại{' '}
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
    </>
  );
}
