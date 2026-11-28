import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { call } from '../../api/client';
import { ApiProblem } from '../../api/problem';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Icon } from '../../components/Icon';
import { PageHead, Steps } from '../../components/ui';
import { formatDateTime } from '../../lib/dates';
import { formatVnd } from '../../lib/money';
import { REJECT_REASON, TRANSFER_STATUS, TRANSFER_TYPE } from './labels';
import { keys } from './queries';

/** `/transfers/:id`: the receipt of one transfer as the server shows it to this customer. */
export function TransferStatusPage() {
  const { id = '' } = useParams();
  const api = useApi();
  const transfer = useQuery({
    queryKey: keys.transfer(id),
    queryFn: () => call(api.GET('/v1/transfers/{id}', { params: { path: { id } } })),
  });

  if (transfer.error instanceof ApiProblem && transfer.error.status === 404) {
    return (
      <section className="panel">
        <h1>Không tìm thấy</h1>
        <p>
          <Link to="/accounts">Về danh sách tài khoản</Link>
        </p>
      </section>
    );
  }
  const data = transfer.data;
  const done = data?.status === 'COMPLETED';
  return (
    <>
      <PageHead title="Biên lai giao dịch">
        <button type="button" className="secondary" onClick={() => window.print()}>
          In biên lai
        </button>
        <Link to="/transfer" className="button">
          Chuyển tiếp
        </Link>
      </PageHead>
      <Steps at={3} />
      <section className="panel narrow">
        <ErrorBanner error={transfer.error} />
        {transfer.isPending && <p aria-busy="true">Đang tải…</p>}
        {data && (
          <>
            <div className="col center" style={{ alignItems: 'center' }}>
              <span className={`tile ${done ? 'in' : 'out'}`}>
                <Icon name={done ? 'check' : 'lock'} size={24} />
              </span>
              <span className={`tag ${done ? 'ok' : 'bad'}`} data-testid="transfer-status">
                {TRANSFER_STATUS[data.status]}
              </span>
              <div className="big huge">{formatVnd(data.amount)}</div>
            </div>
            <dl className="facts">
              {data.rejectReason && (
                <>
                  <dt>Lý do</dt>
                  <dd data-testid="transfer-reason">{REJECT_REASON[data.rejectReason]}</dd>
                </>
              )}
              <dt>Loại</dt>
              <dd>{TRANSFER_TYPE[data.type]}</dd>
              {data.fromAccountNumber && (
                <>
                  <dt>Từ tài khoản</dt>
                  <dd className="mono">{data.fromAccountNumber}</dd>
                </>
              )}
              {data.toAccountNumber && (
                <>
                  <dt>Đến tài khoản</dt>
                  <dd className="mono">{data.toAccountNumber}</dd>
                </>
              )}
              <dt>Thời điểm</dt>
              <dd>{formatDateTime(data.createdAt)}</dd>
              <dt>Mã giao dịch</dt>
              <dd className="mono" data-testid="transfer-id">
                {data.transferId}
              </dd>
            </dl>
          </>
        )}
        <Link to="/accounts" className="button secondary">
          Về danh sách tài khoản
        </Link>
      </section>
    </>
  );
}
