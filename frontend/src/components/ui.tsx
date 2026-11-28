import { useState, type ReactNode } from 'react';
import { formatDateTime } from '../lib/dates';
import { formatVnd } from '../lib/money';
import { stepPath } from '../lib/chart';
import { Icon } from './Icon';

export function Brand({ sub }: { sub?: string }) {
  return (
    <div>
      <div className="logo">
        mophong<i>.</i>
      </div>
      {sub && <div className="muted">{sub}</div>}
    </div>
  );
}

export function PageHead({
  title,
  sub,
  children,
}: {
  title: ReactNode;
  sub?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="muted">{sub}</p>}
      </div>
      {children && <div className="row">{children}</div>}
    </div>
  );
}

export type Tone = 'ok' | 'warn' | 'bad' | 'info';

export function Tag({
  tone,
  children,
  ...rest
}: { tone: Tone; children: ReactNode } & {
  'data-testid'?: string;
}) {
  return (
    <span className={`tag ${tone}`} {...rest}>
      {children}
    </span>
  );
}

/** Initials of a Vietnamese name: first and last word. */
export function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const first = words[0]?.[0] ?? '';
  const last = words.length > 1 ? (words[words.length - 1]?.[0] ?? '') : '';
  return (first + last).toUpperCase();
}

/** `+1.000 ₫` in green or `−1.000 ₫` in red. */
export function Signed({ direction, amount }: { direction: 'DEBIT' | 'CREDIT'; amount: string }) {
  const out = direction === 'DEBIT';
  return (
    <span className={out ? 'money-out' : 'money-in'}>
      {out ? '−' : '+'}
      {formatVnd(amount)}
    </span>
  );
}

export function Movement({
  direction,
  title,
  subtitle,
  amount,
  balanceAfter,
  at,
}: {
  direction: 'DEBIT' | 'CREDIT';
  title: ReactNode;
  subtitle?: ReactNode;
  amount: string;
  balanceAfter: string;
  at: string;
}) {
  const out = direction === 'DEBIT';
  return (
    <>
      <span className={`tile ${out ? 'out' : 'in'}`}>
        <Icon name={out ? 'out' : 'in'} />
      </span>
      <div className="grow">
        <div>
          <b>{title}</b>
        </div>
        <div className="muted">
          {subtitle}
          {subtitle ? ' · ' : ''}
          {formatDateTime(at)}
        </div>
      </div>
      <div className="num">
        <Signed direction={direction} amount={amount} />
        <div className="muted">Số dư {formatVnd(balanceAfter)}</div>
      </div>
    </>
  );
}

export function Steps({ at }: { at: 1 | 2 | 3 }) {
  return (
    <ol className="steps" aria-label="Các bước chuyển tiền">
      {['Nhập thông tin', 'Xác nhận', 'Biên lai'].map((label, index) => (
        <li
          key={label}
          className={index < at ? 'done' : undefined}
          aria-current={index === at - 1 ? 'step' : undefined}
        >
          <b>{index + 1}</b>
          {label}
        </li>
      ))}
    </ol>
  );
}

export function Progress({ percent, label }: { percent: number; label: string }) {
  return (
    <div
      className="bar"
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
    >
      <i style={{ width: `${percent}%` }} />
    </div>
  );
}

/** Share of `part` in `whole` as 0..100, computed with BigInt. */
export function percentOf(part: string, whole: string): number {
  const total = BigInt(whole);
  if (total <= 0n) return 0;
  const value = Number((BigInt(part) * 100n) / total);
  return Math.min(100, Math.max(0, value));
}

export function BalanceChart({ balances }: { balances: string[] }) {
  const line = stepPath(balances, 600, 150);
  if (!line) return <p className="empty">Chưa có biến động.</p>;
  return (
    <svg
      viewBox="0 0 600 150"
      width="100%"
      height="150"
      preserveAspectRatio="none"
      role="img"
      aria-label={`Số dư sau ${balances.length} giao dịch gần nhất, hiện là ${formatVnd(balances[balances.length - 1] ?? '0')}`}
    >
      <path d={`${line} V150 H0 Z`} fill="#e2f6fc" />
      <path d={line} fill="none" stroke="#1fbde6" strokeWidth="3" />
    </svg>
  );
}

export function CopyButton({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="secondary"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setDone(true));
      }}
    >
      {done ? 'Đã sao chép' : label}
    </button>
  );
}
