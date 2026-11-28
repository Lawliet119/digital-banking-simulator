import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { callWithMeta, type Schemas } from '../../api/client';
import { ApiProblem, describeError } from '../../api/problem';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Field } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { initials, PageHead, Steps, Tag } from '../../components/ui';
import { beginAttempt, endAttempt, settleAttempt } from '../../lib/idempotency';
import { formatVnd, isPositive, parseVndInput } from '../../lib/money';
import { LimitPanel } from './Panels';
import { keys, useAccounts, useRecipients } from './queries';

const FORM = 'transfer';
const ACCOUNT_NUMBER = /^\d{12}$/;
const PRESETS = ['100000', '500000', '1000000', '5000000'];

type Recipient = Schemas['AccountLookupDto'];

/** What happened to the last press of "Chuyển". */
type Outcome =
  | { kind: 'none' }
  /** No HTTP answer, a 5xx or a 429: the server may or may not have moved the money. */
  | { kind: 'unknown'; error: unknown }
  /** A 422 rejection or another definite refusal. */
  | { kind: 'refused'; error: ApiProblem };

/**
 * `/transfer`: enter, confirm, result. The recipient is looked up only when "Kiểm tra" or a
 * recent recipient is pressed. "Chuyển" sends one `Idempotency-Key` per attempt: pressing it
 * again after an unknown outcome resends the same key, so the money moves at most once.
 */
export function TransferPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const accounts = useAccounts();
  const recipients = useRecipients();
  const active = accounts.data?.filter(account => account.status === 'ACTIVE') ?? [];

  const [fromId, setFromId] = useState('');
  const [number, setNumber] = useState('');
  const [amountText, setAmountText] = useState('');
  const [recipient, setRecipient] = useState<Recipient | undefined>();
  const [lookupError, setLookupError] = useState<unknown>();
  const [checking, setChecking] = useState(false);
  const [step, setStep] = useState<'enter' | 'confirm'>('enter');
  const [sending, setSending] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>({ kind: 'none' });

  const source = active.find(account => account.id === fromId) ?? active[0];
  const amount = parseVndInput(amountText);
  const amountError =
    amountText && (amount === null || !isPositive(amount))
      ? 'Số tiền là số nguyên đồng lớn hơn 0, ví dụ 1.500.000.'
      : undefined;
  const numberError =
    number && !ACCOUNT_NUMBER.test(number) ? 'Số tài khoản gồm đúng 12 chữ số.' : undefined;
  // Only a figure to show: the server decides whether the balance is enough.
  const after =
    source && amount && isPositive(amount) ? BigInt(source.balance) - BigInt(amount) : undefined;

  async function check(wanted = number) {
    if (!ACCOUNT_NUMBER.test(wanted)) return;
    setChecking(true);
    setLookupError(undefined);
    setRecipient(undefined);
    try {
      const { data } = await callWithMeta(
        api.GET('/v1/accounts/lookup', { params: { query: { accountNumber: wanted } } }),
      );
      setRecipient(data);
    } catch (error) {
      setLookupError(error);
    } finally {
      setChecking(false);
    }
  }

  function toConfirm(event: FormEvent) {
    event.preventDefault();
    if (!source || !recipient || !amount || !isPositive(amount)) return;
    endAttempt(FORM); // a new transfer starts here: never reuse the key of an earlier one
    setOutcome({ kind: 'none' });
    setStep('confirm');
  }

  async function send() {
    if (!source || !recipient || !amount) return;
    const key = beginAttempt(FORM);
    setSending(true);
    let status: number | undefined;
    try {
      const { data } = await callWithMeta(
        api.POST('/v1/transfers', {
          params: { header: { 'Idempotency-Key': key } },
          body: { fromAccountId: source.id, toAccountId: recipient.accountId, amount },
        }),
      );
      status = 201;
      void queryClient.invalidateQueries({ queryKey: ['customer'] });
      void navigate(`/transfers/${data.transferId}`);
    } catch (error) {
      status = error instanceof ApiProblem ? error.status : undefined;
      if (settleOutcome(error, status) === 'definite') {
        void queryClient.invalidateQueries({ queryKey: keys.accounts });
      }
    } finally {
      settleAttempt(FORM, status);
      setSending(false);
    }
  }

  function settleOutcome(error: unknown, status: number | undefined): 'definite' | 'unknown' {
    if (error instanceof ApiProblem && status !== undefined && status < 500 && status !== 429) {
      setOutcome({ kind: 'refused', error });
      return 'definite';
    }
    setOutcome({ kind: 'unknown', error });
    return 'unknown';
  }

  if (accounts.isPending) return <p aria-busy="true">Đang tải…</p>;
  if (active.length === 0) {
    return (
      <section className="panel">
        <h1>Chuyển tiền</h1>
        <ErrorBanner error={accounts.error} />
        <p>
          Bạn chưa có tài khoản đang hoạt động. <Link to="/accounts">Mở tài khoản</Link>
        </p>
      </section>
    );
  }

  if (step === 'confirm' && source && recipient && amount) {
    const refused = outcome.kind === 'refused' ? outcome.error : undefined;
    return (
      <>
        <PageHead title="Xác nhận chuyển tiền" sub="Kiểm tra kỹ trước khi chuyển." />
        <Steps at={2} />
        <section className="panel narrow">
          <div className="center">
            <div className="eyebrow">Số tiền chuyển</div>
            <div className="big huge" data-testid="confirm-amount">
              {formatVnd(amount)}
            </div>
          </div>
          <dl className="facts">
            <dt>Từ tài khoản</dt>
            <dd className="mono">{source.accountNumber}</dd>
            <dt>Người nhận</dt>
            <dd data-testid="recipient-name">{recipient.ownerName}</dd>
            <dt>Số tài khoản nhận</dt>
            <dd className="mono">{recipient.accountNumber}</dd>
            <dt>Số dư hiện tại</dt>
            <dd>{formatVnd(source.balance)}</dd>
            {after !== undefined && after >= 0n && (
              <>
                <dt>Số dư sau chuyển</dt>
                <dd>{formatVnd(after.toString())}</dd>
              </>
            )}
          </dl>
          {outcome.kind === 'unknown' && (
            <div role="alert" className="error">
              <p>{describeError(outcome.error)}</p>
              <p>
                Chưa chắc giao dịch đã được thực hiện. Bấm <strong>Chuyển</strong> lần nữa: bạn
                không bị trừ tiền hai lần.
              </p>
            </div>
          )}
          {refused && (
            <div role="alert" className="error" data-testid="reject-reason">
              <p>{describeError(refused)}</p>
              {refused.transferId && (
                <p>
                  <Link to={`/transfers/${refused.transferId}`}>Xem giao dịch bị từ chối</Link>
                </p>
              )}
            </div>
          )}
          <div className="row">
            {outcome.kind !== 'refused' && (
              <button type="button" disabled={sending} onClick={() => void send()}>
                {sending ? 'Đang chuyển…' : 'Chuyển'}
              </button>
            )}
            {/* After an unknown outcome, editing would start a second transfer: only retry. */}
            {outcome.kind !== 'unknown' && (
              <button
                type="button"
                className="secondary"
                disabled={sending}
                onClick={() => setStep('enter')}
              >
                {outcome.kind === 'refused' ? 'Sửa và thử lại' : 'Quay lại'}
              </button>
            )}
          </div>
        </section>
      </>
    );
  }

  const recent = recipients.data?.items ?? [];
  return (
    <>
      <PageHead title="Chuyển tiền" sub="Trong cùng ngân hàng." />
      <Steps at={1} />
      <div className="split">
        <section className="panel">
          <form className="col" onSubmit={toConfirm}>
            <div className="field">
              <label htmlFor="from">Từ tài khoản</label>
              <select
                id="from"
                value={source?.id}
                onChange={event => setFromId(event.target.value)}
              >
                {active.map(account => (
                  <option key={account.id} value={account.id}>
                    {account.accountNumber} · {formatVnd(account.balance)}
                  </option>
                ))}
              </select>
            </div>
            <div className="row bottom">
              <Field
                label="Số tài khoản nhận"
                value={number}
                onChange={event => {
                  setNumber(event.target.value.trim());
                  setRecipient(undefined);
                  setLookupError(undefined);
                }}
                error={numberError}
                inputMode="numeric"
                autoComplete="off"
                maxLength={12}
              />
              <button
                type="button"
                className="secondary"
                disabled={checking || !ACCOUNT_NUMBER.test(number)}
                onClick={() => void check()}
              >
                {checking ? 'Đang kiểm tra…' : 'Kiểm tra'}
              </button>
            </div>
            {recipient && (
              <div role="status" className="choice" data-testid="recipient">
                <span className="tile in">{initials(recipient.ownerName)}</span>
                <div className="grow">
                  <b>{recipient.ownerName}</b>
                  <div className="muted mono">{recipient.accountNumber}</div>
                </div>
                <Tag tone="ok">Đúng người nhận</Tag>
              </div>
            )}
            <ErrorBanner error={lookupError} />
            <div className="amount-field">
              <Field
                label="Số tiền (đồng)"
                value={amountText}
                onChange={event => setAmountText(event.target.value)}
                error={amountError}
                hint={amount && isPositive(amount) ? formatVnd(amount) : undefined}
                inputMode="numeric"
                autoComplete="off"
              />
            </div>
            <div className="row" role="group" aria-label="Số tiền chọn nhanh">
              {PRESETS.map(preset => (
                <button
                  key={preset}
                  type="button"
                  className="chip"
                  aria-pressed={amount === preset}
                  onClick={() => setAmountText(formatVnd(preset).replace(' ₫', ''))}
                >
                  {formatVnd(preset)}
                </button>
              ))}
            </div>
            <button type="submit" disabled={!recipient || !amount || Boolean(amountError)}>
              Tiếp tục <Icon name="arrow" size={18} />
            </button>
          </form>
        </section>
        <div className="col">
          <section className="panel">
            <h2>Người nhận gần đây</h2>
            <ErrorBanner error={recipients.error} />
            {recipients.isSuccess && recent.length === 0 && (
              <p className="muted">Chưa có người nhận nào.</p>
            )}
            <ul className="items">
              {recent.map(item => (
                <li key={item.accountId} className="item" data-testid="recent-recipient">
                  <span className="tile">{initials(item.ownerName)}</span>
                  <div className="grow">
                    <b>{item.ownerName}</b>
                    <div className="muted mono">{item.accountNumber}</div>
                  </div>
                  <button
                    type="button"
                    className="chip"
                    aria-label={`Chọn ${item.ownerName}`}
                    onClick={() => {
                      setNumber(item.accountNumber);
                      void check(item.accountNumber);
                    }}
                  >
                    Chọn
                  </button>
                </li>
              ))}
            </ul>
          </section>
          <LimitPanel accountId={source?.id} />
        </div>
      </div>
    </>
  );
}
