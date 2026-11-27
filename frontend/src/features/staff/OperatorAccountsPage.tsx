import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { call, type Schemas } from '../../api/client';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { ACCOUNT_STATUS, ACCOUNT_TYPE } from '../customer/labels';

type Account = Schemas['OperatorAccountDto'];

/**
 * `/operator/accounts`: find a customer's account by name, by 12-digit number (exact) or by
 * UUID; lock or unlock it with a mandatory reason. The reason goes to the audit log only; the
 * customer is never told it (BR-13).
 */
export function OperatorAccountsPage() {
  const api = useApi();
  const [text, setText] = useState('');
  const [q, setQ] = useState('');
  const results = useQuery({
    queryKey: ['operator', 'accounts', q],
    enabled: q.length > 0,
    queryFn: () => call(api.GET('/v1/operator/accounts', { params: { query: { q } } })),
  });

  function search(event: FormEvent) {
    event.preventDefault();
    setQ(text.trim());
  }

  return (
    <section className="panel">
      <h1>Tìm tài khoản</h1>
      <form className="row bottom" onSubmit={search}>
        <div className="field">
          <label htmlFor="q">Tên khách, số tài khoản hoặc mã tài khoản</label>
          <input
            id="q"
            value={text}
            maxLength={100}
            onChange={event => setText(event.target.value)}
            autoComplete="off"
          />
        </div>
        <button type="submit" disabled={!text.trim()}>
          Tìm
        </button>
      </form>
      <ErrorBanner error={results.error} />
      {results.data && results.data.items.length === 0 && <p>Không có kết quả.</p>}
      {results.data && results.data.items.length > 0 && (
        <table>
          <thead>
            <tr>
              <th>Số tài khoản</th>
              <th>Chủ tài khoản</th>
              <th>Loại</th>
              <th>Trạng thái</th>
              <th>Thao tác</th>
            </tr>
          </thead>
          <tbody>
            {results.data.items.map(account => (
              <AccountRow key={account.id} account={account} q={q} />
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

function AccountRow({ account, q }: { account: Account; q: string }) {
  const api = useApi();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const locking = account.status === 'ACTIVE';
  const change = useMutation({
    mutationFn: () =>
      call(
        locking
          ? api.POST('/v1/operator/accounts/{id}/lock', {
              params: { path: { id: account.id } },
              body: { reason: reason.trim() },
            })
          : api.POST('/v1/operator/accounts/{id}/unlock', {
              params: { path: { id: account.id } },
              body: { reason: reason.trim() },
            }),
      ),
    onSuccess: () => {
      setOpen(false);
      setReason('');
      void queryClient.invalidateQueries({ queryKey: ['operator', 'accounts', q] });
    },
  });

  return (
    <tr data-testid="operator-account-row">
      <td className="mono">{account.accountNumber}</td>
      <td>{account.ownerName}</td>
      <td>{ACCOUNT_TYPE[account.type]}</td>
      <td data-testid="account-status">{ACCOUNT_STATUS[account.status]}</td>
      <td>
        {!open && (
          <button type="button" className="secondary" onClick={() => setOpen(true)}>
            {locking ? 'Khóa' : 'Mở khóa'}
          </button>
        )}
        {open && (
          <form
            className="row"
            onSubmit={event => {
              event.preventDefault();
              if (reason.trim()) change.mutate();
            }}
          >
            <input
              aria-label="Lý do"
              placeholder="Lý do (bắt buộc)"
              value={reason}
              maxLength={500}
              onChange={event => setReason(event.target.value)}
            />
            <button type="submit" disabled={!reason.trim() || change.isPending}>
              {locking ? 'Xác nhận khóa' : 'Xác nhận mở khóa'}
            </button>
            <button type="button" className="secondary" onClick={() => setOpen(false)}>
              Hủy
            </button>
            <ErrorBanner error={change.error} />
          </form>
        )}
      </td>
    </tr>
  );
}
