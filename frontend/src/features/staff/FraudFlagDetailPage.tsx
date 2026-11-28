import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import { call } from '../../api/client';
import { ApiProblem } from '../../api/problem';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Movement, PageHead, Tag } from '../../components/ui';
import { formatDateTime } from '../../lib/dates';
import { formatVnd } from '../../lib/money';
import { TRANSFER_TYPE } from '../customer/labels';
import { REVIEW_STATUS, REVIEW_TONE, RISK_LEVEL, RISK_TONE, RULE_NAME } from './labels';

type Decision = 'CONFIRMED_FRAUD' | 'FALSE_POSITIVE';

const DECISIONS: [Decision, string][] = [
  ['CONFIRMED_FRAUD', 'Cân nhắc khóa tài khoản'],
  ['FALSE_POSITIVE', 'Giao dịch hợp lệ'],
];

const RADIUS = 50;
const LENGTH = 2 * Math.PI * RADIUS;

/** The server's score as a ring; the number in the middle is the value itself. */
function Gauge({ score, color }: { score: number; color: string }) {
  const filled = (Math.min(100, Math.max(0, score)) / 100) * LENGTH;
  return (
    <svg width="160" height="160" viewBox="0 0 120 120" role="img" aria-label={`Điểm ${score}`}>
      <circle cx="60" cy="60" r={RADIUS} fill="none" stroke="#e9ecf0" strokeWidth="10" />
      <circle
        cx="60"
        cy="60"
        r={RADIUS}
        fill="none"
        stroke={color}
        strokeWidth="10"
        strokeLinecap="round"
        strokeDasharray={`${filled} ${LENGTH}`}
        transform="rotate(-90 60 60)"
      />
      <text
        x="60"
        y="66"
        textAnchor="middle"
        fontSize="30"
        fontWeight="800"
        fill="#0b0f19"
        data-testid="flag-score"
      >
        {score}
      </text>
      <text x="60" y="84" textAnchor="middle" fontSize="9" fill="#8a919d">
        trên 100
      </text>
    </svg>
  );
}

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
    onSettled: () => queryClient.invalidateQueries({ queryKey: ['operator'] }),
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
      <PageHead title="Chi tiết cờ gian lận" sub={<span className="mono">{data?.transferId}</span>}>
        <Link to="/operator/fraud-flags" className="button secondary">
          Về danh sách
        </Link>
      </PageHead>
      <ErrorBanner error={flag.error} />
      {flag.isPending && <p aria-busy="true">Đang tải…</p>}
      {data && (
        <div className="split">
          <div className="col">
            <section className="panel">
              <div className="row" style={{ gap: '1.75rem' }}>
                <Gauge
                  score={data.score}
                  color={data.riskLevel === 'HIGH' ? '#dc2626' : '#f59e0b'}
                />
                <div className="col grow">
                  <Tag tone={RISK_TONE[data.riskLevel]}>Mức {RISK_LEVEL[data.riskLevel]}</Tag>
                  <div className="big">{formatVnd(data.amount)}</div>
                </div>
              </div>
              <dl className="facts">
                <dt>Người gửi</dt>
                <dd>
                  {data.fromOwnerName}{' '}
                  <span className="mono">{data.fromAccountNumber ?? data.fromAccountId}</span>
                </dd>
                <dt>Người nhận</dt>
                <dd>
                  {data.toOwnerName}{' '}
                  <span className="mono">{data.toAccountNumber ?? data.toAccountId}</span>
                </dd>
                <dt>Thời điểm</dt>
                <dd>{formatDateTime(data.createdAt)}</dd>
                <dt>Phiên bản luật</dt>
                <dd>{data.ruleSetVersion}</dd>
                <dt>Review</dt>
                <dd>
                  <Tag tone={REVIEW_TONE[data.reviewStatus]} data-testid="flag-review-status">
                    {REVIEW_STATUS[data.reviewStatus]}
                  </Tag>
                </dd>
              </dl>
            </section>
            <section className="panel">
              <h2>Luật trúng</h2>
              {data.hits.length === 0 ? (
                <p className="muted">Không có luật nào trúng (cờ có thể do AI tạo).</p>
              ) : (
                <ul className="items">
                  {data.hits.map(hit => (
                    <li key={hit.ruleId} className="item" data-testid="flag-hit">
                      <span className="tile warn">{hit.ruleId}</span>
                      <div className="grow">
                        <b>{RULE_NAME[hit.ruleId]}</b>
                        <div className="muted">{hit.explanation}</div>
                      </div>
                      <b aria-label={`Trọng số ${hit.weight}`}>+{hit.weight}</b>
                    </li>
                  ))}
                </ul>
              )}
            </section>
            <section className="panel">
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
            </section>
            <section className="panel">
              <h2>Giao dịch gần đây của tài khoản gửi</h2>
              {data.recentTransactions.length === 0 ? (
                <p className="muted">Không có.</p>
              ) : (
                <ul className="items">
                  {data.recentTransactions.map(item => (
                    <li key={item.entryId} className="item">
                      <Movement
                        direction={item.direction}
                        title={TRANSFER_TYPE[item.type]}
                        subtitle={item.counterpartyAccountNumber}
                        amount={item.amount}
                        balanceAfter={item.balanceAfter}
                        at={item.createdAt}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
          <section className="panel">
            <h2>Kết luận</h2>
            {data.reviewStatus !== 'OPEN' || review.isSuccess || alreadyReviewed ? (
              <p role="status" className="notice" data-testid="review-closed">
                {alreadyReviewed ? 'Cờ này đã được review.' : 'Đã review: '}
                {!alreadyReviewed && REVIEW_STATUS[data.reviewStatus]}
              </p>
            ) : (
              <form className="col" onSubmit={submit}>
                <fieldset aria-label="Kết luận">
                  {DECISIONS.map(([option, hint]) => (
                    <label key={option} className="choice">
                      <input
                        type="radio"
                        name="decision"
                        checked={decision === option}
                        onChange={() => setDecision(option)}
                      />
                      <span>
                        <b>{REVIEW_STATUS[option]}</b>
                        <span className="muted"> · {hint}</span>
                      </span>
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
                <p className="muted">Mỗi cờ chỉ review được một lần.</p>
              </form>
            )}
          </section>
        </div>
      )}
    </>
  );
}
