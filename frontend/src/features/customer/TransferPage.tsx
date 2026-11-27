import { useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import { callWithMeta, type Schemas } from '../../api/client';
import { ApiProblem, describeError } from '../../api/problem';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Field } from '../../components/Field';
import { beginAttempt, endAttempt, settleAttempt } from '../../lib/idempotency';
import { formatVnd, isPositive, parseVndInput } from '../../lib/money';
import { keys, useAccounts } from './queries';

const FORM = 'transfer';
const ACCOUNT_NUMBER = /^\d{12}$/;

type Recipient = Schemas['AccountLookupDto'];

/** What happened to the last press of "Chuyển". */
type Outcome =
  | { kind: 'none' }
  /** No HTTP answer, a 5xx or a 429: the server may or may not have moved the money. */
  | { kind: 'unknown'; error: unknown }
  /** A 422 rejection or another definite refusal. */
  | { kind: 'refused'; error: ApiProblem };

/**
 * `/transfer`: enter, confirm, result. The recipient is looked up only when "Kiểm tra" is pressed.
 * "Chuyển" sends one `Idempotency-Key` per attempt: pressing it again after an unknown outcome
 * resends the same key, so the money moves at most once.
 */
export function TransferPage() {
  const api = useApi();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const accounts = useAccounts();
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

  async function check() {
    if (!ACCOUNT_NUMBER.test(number)) return;
    setChecking(true);
    setLookupError(undefined);
    setRecipient(undefined);
    try {
      const { data } = await callWithMeta(
        api.GET('/v1/accounts/lookup', { params: { query: { accountNumber: number } } }),
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
      void queryClient.invalidateQueries({ queryKey: keys.accounts });
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
      <section className="panel narrow">
        <h1>Xác nhận chuyển tiền</h1>
        <dl className="facts">
          <dt>Từ tài khoản</dt>
          <dd className="mono">{source.accountNumber}</dd>
          <dt>Người nhận</dt>
          <dd data-testid="recipient-name">{recipient.ownerName}</dd>
          <dt>Số tài khoản nhận</dt>
          <dd className="mono">{recipient.accountNumber}</dd>
          <dt>Số tiền</dt>
          <dd data-testid="confirm-amount">{formatVnd(amount)}</dd>
        </dl>
        {outcome.kind === 'unknown' && (
          <div role="alert" className="error">
            <p>{describeError(outcome.error)}</p>
            <p>
              Chưa chắc giao dịch đã được thực hiện. Bấm <strong>Chuyển</strong> lần nữa: hệ thống
              nhận ra yêu cầu cũ và không trừ tiền hai lần.
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
          {/* After an unknown outcome, editing would start a second transfer: only retry is offered. */}
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
    );
  }

  return (
    <section className="panel narrow">
      <h1>Chuyển tiền</h1>
      <form onSubmit={toConfirm}>
        <div className="field">
          <label htmlFor="from">Từ tài khoản</label>
          <select id="from" value={source?.id} onChange={event => setFromId(event.target.value)}>
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
          <p role="status" className="ok" data-testid="recipient">
            Người nhận: <strong>{recipient.ownerName}</strong>
          </p>
        )}
        <ErrorBanner error={lookupError} />
        <Field
          label="Số tiền (đồng)"
          value={amountText}
          onChange={event => setAmountText(event.target.value)}
          error={amountError}
          hint={amount && isPositive(amount) ? formatVnd(amount) : undefined}
          inputMode="numeric"
          autoComplete="off"
        />
        <button type="submit" disabled={!recipient || !amount || Boolean(amountError)}>
          Tiếp tục
        </button>
      </form>
    </section>
  );
}
