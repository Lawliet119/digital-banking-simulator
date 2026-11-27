import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { call } from '../../api/client';
import { ApiProblem } from '../../api/problem';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { formatDateTime } from '../../lib/dates';
import { formatVnd } from '../../lib/money';
import { TRANSFER_TYPE } from '../customer/labels';
import { REVIEW_STATUS, RISK_LEVEL } from './labels';

type Decision = 'CONFIRMED_FRAUD' | 'FALSE_POSITIVE';

/**
 * `/operator/fraud-flags/:transferId`. The score is the server's `score`: the UI never adds up
 * the rule weights, the list of rules may be empty when only the AI raised the flag, and the AI
 * part is shown on its own (BL-042). A flag is reviewed once; afterwards the form is read-only.
 */
export function FraudFlagDetailPage() {
  const { transferId = '' } = useParams();
  const api = useApi();
  const queryClient = useQueryClient();
  const key = ['operator', 'fraud-flags', 'detail', transferId];
  const flag = useQuery({
    queryKey: key,
    queryFn: () =>
      call(api.GET('/v1/operator/fraud-flags/{transferId}', { params: { path: { transferId } } })),
  });
  const [decision, setDecision] = useState<Decision | ''>('');
  const [note, setNote] = useState('');
  const review = useMutation({
    mutationFn: (chosen: Decision) =>
      call(
        api.POST('/v1/operator/fraud-flags/{transferId}/review', {
          params: { path: { transferId } },
          body: { decision: chosen, ...(note.trim() ? { note: note.trim() } : {}) },
        }),
      ),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });

  if (flag.error instanceof ApiProblem && flag.error.status === 404) {
    return (
      <section className="panel">
        <h1>Không tìm thấy cờ</h1>
        <Link to="/operator/fraud-flags">Về danh sách cờ</Link>
      </section>
    );
  }
  const data = flag.data;
  const alreadyReviewed =
    review.error instanceof ApiProblem && review.error.errorCode === 'FLAG_ALREADY_REVIEWED';

  function submit(event: FormEvent) {
    event.preventDefault();
    if (decision) review.mutate(decision);
  }

  return (
    <>
      <section className="panel">
        <h1>Cờ gian lận</h1>
        <ErrorBanner error={flag.error} />
        {data && (
          <dl className="facts">
            <dt>Giao dịch</dt>
            <dd className="mono">{data.transferId}</dd>
            <dt>Điểm</dt>
            <dd data-testid="flag-score">{data.score}</dd>
            <dt>Mức rủi ro</dt>
            <dd>{RISK_LEVEL[data.riskLevel]}</dd>
            <dt>Review</dt>
            <dd data-testid="flag-review-status">{REVIEW_STATUS[data.reviewStatus]}</dd>
            <dt>Phiên bản luật</dt>
            <dd>{data.ruleSetVersion}</dd>
            <dt>Thời điểm</dt>
            <dd>{formatDateTime(data.createdAt)}</dd>
            <dt>Từ tài khoản</dt>
            <dd className="mono">{data.fromAccountId}</dd>
            <dt>Đến tài khoản</dt>
            <dd className="mono">{data.toAccountId}</dd>
          </dl>
        )}
      </section>
      {data && (
        <section className="panel">
          <h2>Luật trúng</h2>
          {data.hits.length === 0 ? (
            <p className="muted">Không có luật nào trúng (cờ có thể do AI tạo).</p>
          ) : (
            <ul>
              {data.hits.map(hit => (
                <li key={hit.ruleId} data-testid="flag-hit">
                  <strong>{hit.ruleId}</strong> (trọng số {hit.weight}): {hit.explanation}
                </li>
              ))}
            </ul>
          )}
          <h2>Đánh giá AI</h2>
          {data.aiAssessment ? (
            <dl className="facts">
              <dt>Trạng thái</dt>
              <dd>{data.aiAssessment.status}</dd>
              <dt>Xác suất</dt>
              <dd>{data.aiAssessment.probability ?? '—'}</dd>
              <dt>Mô hình</dt>
              <dd>{data.aiAssessment.model ?? '—'}</dd>
            </dl>
          ) : (
            <p className="muted">Không có đánh giá AI cho giao dịch này.</p>
          )}
          <h2>Giao dịch gần đây của tài khoản gửi</h2>
          {data.recentTransactions.length === 0 ? (
            <p className="muted">Không có.</p>
          ) : (
            <table>
              <tbody>
                {data.recentTransactions.map(item => (
                  <tr key={item.entryId}>
                    <td>{formatDateTime(item.createdAt)}</td>
                    <td>{TRANSFER_TYPE[item.type]}</td>
                    <td className="mono">{item.counterpartyAccountNumber ?? '—'}</td>
                    <td className="num">
                      {item.direction === 'DEBIT' ? '−' : '+'}
                      {formatVnd(item.amount)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      )}
      {data && (
        <section className="panel narrow">
          <h2>Review</h2>
          {data.reviewStatus !== 'OPEN' || review.isSuccess || alreadyReviewed ? (
            <p role="status" data-testid="review-closed">
              {alreadyReviewed ? 'Cờ này đã được review.' : 'Đã review: '}
              {!alreadyReviewed && REVIEW_STATUS[data.reviewStatus]}
            </p>
          ) : (
            <form onSubmit={submit}>
              <fieldset>
                <legend>Kết luận</legend>
                {(['CONFIRMED_FRAUD', 'FALSE_POSITIVE'] as const).map(option => (
                  <label key={option} className="choice">
                    <input
                      type="radio"
                      name="decision"
                      checked={decision === option}
                      onChange={() => setDecision(option)}
                    />
                    {REVIEW_STATUS[option]}
                  </label>
                ))}
              </fieldset>
              <div className="field">
                <label htmlFor="note">Ghi chú (không bắt buộc)</label>
                <textarea
                  id="note"
                  rows={3}
                  maxLength={500}
                  value={note}
                  onChange={event => setNote(event.target.value)}
                />
              </div>
              <ErrorBanner error={review.error} />
              <button type="submit" disabled={!decision || review.isPending}>
                Gửi review
              </button>
            </form>
          )}
        </section>
      )}
    </>
  );
}
