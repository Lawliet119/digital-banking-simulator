import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { call, type Schemas } from '../../api/client';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Icon } from '../../components/Icon';
import { PageHead, Tag } from '../../components/ui';
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
  const [chosenId, setChosenId] = useState<string | undefined>();
  const results = useQuery({
    queryKey: ['operator', 'accounts', q],
    enabled: q.length > 0,
    queryFn: () => call(api.GET('/v1/operator/accounts', { params: { query: { q } } })),
  });
  const items = results.data?.items ?? [];
  const chosen = items.find(account => account.id === chosenId);

  function search(event: FormEvent) {
    event.preventDefault();
    setChosenId(undefined);
    setQ(text.trim());
  }

  return (
    <>
      <PageHead title="Tìm tài khoản" sub="Theo tên khách, số tài khoản hoặc mã tài khoản." />
      <form className="panel" onSubmit={search}>
        <div className="row bottom">
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
          <button type="submit" className="dark" disabled={!text.trim()}>
            <Icon name="search" size={18} /> Tìm
          </button>
        </div>
      </form>
      <ErrorBanner error={results.error} />
      {results.data && (
        <div className={chosen ? 'split' : 'col'}>
          <section className="panel scroll">
            {items.length === 0 ? (
              <p className="empty">Không có kết quả.</p>
            ) : (
              <table>
                <thead>
                  <tr>
                    <th>Chủ tài khoản</th>
                    <th>Số tài khoản</th>
                    <th>Loại</th>
                    <th>Trạng thái</th>
                    <th className="num">Thao tác</th>
                  </tr>
                </thead>
                <tbody>
                  {items.map(account => (
                    <tr key={account.id} data-testid="operator-account-row">
                      <td>
                        <b>{account.ownerName}</b>
                      </td>
                      <td className="mono">{account.accountNumber}</td>
                      <td>{ACCOUNT_TYPE[account.type]}</td>
                      <td>
                        <Tag
                          tone={account.status === 'ACTIVE' ? 'ok' : 'bad'}
                          data-testid="account-status"
                        >
                          {ACCOUNT_STATUS[account.status]}
                        </Tag>
                      </td>
                      <td className="num">
                        <button
                          type="button"
                          className="chip"
                          aria-pressed={account.id === chosenId}
                          onClick={() => setChosenId(account.id)}
                        >
                          {account.status === 'ACTIVE' ? 'Khóa' : 'Mở khóa'}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
          {chosen && (
            <StatusPanel
              key={`${chosen.id}-${chosen.status}`}
              account={chosen}
              q={q}
              onClose={() => setChosenId(undefined)}
            />
          )}
        </div>
      )}
    </>
  );
}

function StatusPanel({
  account,
  q,
  onClose,
}: {
  account: Account;
  q: string;
  onClose: () => void;
}) {
  const api = useApi();
  const queryClient = useQueryClient();
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
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: ['operator', 'accounts', q] });
      onClose();
    },
  });
  const title = locking ? 'Khóa tài khoản' : 'Mở khóa tài khoản';

  return (
    <form
      className="panel"
      data-testid="lock-panel"
      aria-label={title}
      onSubmit={event => {
        event.preventDefault();
        if (reason.trim()) change.mutate();
      }}
    >
      <div className="row nowrap">
        <span className={`tile ${locking ? 'out' : 'in'}`}>
          <Icon name="lock" />
        </span>
        <div>
          <h2>{title}</h2>
          <div className="muted">
            {account.ownerName} · <span className="mono">{account.accountNumber}</span>
          </div>
        </div>
      </div>
      <div className="field">
        <label htmlFor="reason">Lý do (bắt buộc)</label>
        <textarea
          id="reason"
          rows={3}
          maxLength={200}
          value={reason}
          onChange={event => setReason(event.target.value)}
        />
      </div>
      {locking && <p className="warning">Khách sẽ bị đăng xuất ngay.</p>}
      <ErrorBanner error={change.error} />
      <div className="row">
        <button
          type="submit"
          className={locking ? 'danger grow' : 'grow'}
          disabled={!reason.trim() || change.isPending}
        >
          {locking ? 'Xác nhận khóa' : 'Xác nhận mở khóa'}
        </button>
        <button type="button" className="secondary" onClick={onClose}>
          Hủy
        </button>
      </div>
    </form>
  );
}
