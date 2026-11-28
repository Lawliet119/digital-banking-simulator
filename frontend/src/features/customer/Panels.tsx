import { ErrorBanner } from '../../components/ErrorBanner';
import { Progress, percentOf } from '../../components/ui';
import { formatVnd } from '../../lib/money';
import { useLimits, useSummary } from './queries';

/** What the account has sent today against the daily limit. */
export function LimitPanel({ accountId }: { accountId: string | undefined }) {
  const limits = useLimits(accountId);
  const data = limits.data;
  return (
    <section className="panel">
      <h2>Hạn mức chuyển hôm nay</h2>
      <ErrorBanner error={limits.error} />
      {data && (
        <>
          <div className="row between">
            <span className="muted">Đã dùng {formatVnd(data.sentToday)}</span>
            <b>{formatVnd(data.perDay)}</b>
          </div>
          <Progress percent={percentOf(data.sentToday, data.perDay)} label="Hạn mức ngày đã dùng" />
          <div className="row between">
            <span className="muted">Còn lại</span>
            <b data-testid="limit-remaining">{formatVnd(data.remainingToday)}</b>
          </div>
          <p className="muted">Tối đa {formatVnd(data.perTransaction)} mỗi giao dịch</p>
        </>
      )}
    </section>
  );
}

/** Money in and out over the last 30 days, or today. */
export function FlowPanel({ days }: { days: 1 | 30 }) {
  const summary = useSummary(days);
  const data = summary.data;
  return (
    <section className="panel">
      <h2>{days === 1 ? 'Hôm nay' : '30 ngày qua'}</h2>
      <ErrorBanner error={summary.error} />
      {data && (
        <>
          <div className="row between">
            <span className="muted">Tiền vào</span>
            <span className="money-in" data-testid="flow-in">
              +{formatVnd(data.totalIn)}
            </span>
          </div>
          <div className="row between">
            <span className="muted">Tiền ra</span>
            <span className="money-out" data-testid="flow-out">
              −{formatVnd(data.totalOut)}
            </span>
          </div>
          <p className="muted">Không tính chuyển giữa các tài khoản của bạn.</p>
        </>
      )}
    </section>
  );
}
