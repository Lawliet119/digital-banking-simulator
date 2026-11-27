import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { call } from '../../api/client';
import { ApiProblem } from '../../api/problem';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { formatDateTime } from '../../lib/dates';
import { formatVnd } from '../../lib/money';
import { REJECT_REASON, TRANSFER_STATUS, TRANSFER_TYPE } from './labels';
import { keys } from './queries';

/** `/transfers/:id`: one transfer as the server shows it to this customer. */
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
  return (
    <section className="panel narrow">
      <h1>Giao dịch</h1>
      <ErrorBanner error={transfer.error} />
      {transfer.isPending && <p aria-busy="true">Đang tải…</p>}
      {data && (
        <dl className="facts">
          <dt>Trạng thái</dt>
          <dd
            data-testid="transfer-status"
            className={data.status === 'COMPLETED' ? 'ok' : 'error'}
          >
            {TRANSFER_STATUS[data.status]}
          </dd>
          {data.rejectReason && (
            <>
              <dt>Lý do</dt>
              <dd data-testid="transfer-reason">{REJECT_REASON[data.rejectReason]}</dd>
            </>
          )}
          <dt>Loại</dt>
          <dd>{TRANSFER_TYPE[data.type]}</dd>
          <dt>Số tiền</dt>
          <dd>{formatVnd(data.amount)}</dd>
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
      )}
      <p>
        <Link to="/accounts">Về danh sách tài khoản</Link> · <Link to="/transfer">Chuyển tiếp</Link>
      </p>
    </section>
  );
}
