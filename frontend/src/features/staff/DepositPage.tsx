import { useState, type FormEvent } from 'react';
import { call, callWithMeta, type Schemas } from '../../api/client';
import { ApiProblem, describeError } from '../../api/problem';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Field } from '../../components/Field';
import { beginAttempt, endAttempt, isDefinite, settleAttempt } from '../../lib/idempotency';
import { formatVnd, isPositive, parseVndInput } from '../../lib/money';
import { ACCOUNT_STATUS } from '../customer/labels';

const FORM = 'deposit';
const ACCOUNT_NUMBER = /^\d{12}$/;

type Target = Schemas['OperatorAccountDto'];

/**
 * `/operator/deposit`: cash in at the counter. The account is found by its number through the
 * operator search; the deposit carries an `Idempotency-Key` with the same retry rule as a
 * transfer: after an unknown outcome only the same request can be sent again.
 */
export function DepositPage() {
  const api = useApi();
  const [number, setNumber] = useState('');
  const [target, setTarget] = useState<Target | undefined>();
  const [findError, setFindError] = useState<unknown>();
  const [amountText, setAmountText] = useState('');
  const [sending, setSending] = useState(false);
  const [unknown, setUnknown] = useState<unknown>();
  const [refused, setRefused] = useState<unknown>();
  const [done, setDone] = useState<{ transferId: string; amount: string } | undefined>();

  const amount = parseVndInput(amountText);
  const amountError =
    amountText && (amount === null || !isPositive(amount))
      ? 'Số tiền là số nguyên đồng lớn hơn 0.'
      : undefined;
  const locked = unknown !== undefined; // an attempt may have gone through: nothing may change

  async function find(event: FormEvent) {
    event.preventDefault();
    setTarget(undefined);
    setFindError(undefined);
    try {
      const page = await call(
        api.GET('/v1/operator/accounts', { params: { query: { q: number } } }),
      );
      const match = page.items.find(item => item.accountNumber === number);
      if (match) setTarget(match);
      else setFindError(new ApiProblem(404, 'ACCOUNT_NOT_FOUND', undefined, undefined));
    } catch (error) {
      setFindError(error);
    }
  }

  async function send() {
    if (!target || !amount) return;
    const key = beginAttempt(FORM);
    setSending(true);
    setRefused(undefined);
    let status: number | undefined;
    try {
      const { data } = await callWithMeta(
        api.POST('/v1/operator/deposits', {
          params: { header: { 'Idempotency-Key': key } },
          body: { toAccountId: target.id, amount },
        }),
      );
      status = 201;
      setUnknown(undefined);
      setDone({ transferId: data.transferId, amount });
      setAmountText('');
    } catch (error) {
      status = error instanceof ApiProblem ? error.status : undefined;
      if (isDefinite(status)) {
        setUnknown(undefined);
        setRefused(error);
      } else {
        setUnknown(error);
      }
    } finally {
      settleAttempt(FORM, status);
      setSending(false);
    }
  }

  return (
    <section className="panel narrow">
      <h1>Nạp tiền tại quầy</h1>
      <form className="row bottom" onSubmit={event => void find(event)}>
        <Field
          label="Số tài khoản"
          value={number}
          onChange={event => {
            setNumber(event.target.value.trim());
            setTarget(undefined);
            setDone(undefined);
          }}
          inputMode="numeric"
          maxLength={12}
          disabled={locked}
          autoComplete="off"
        />
        <button
          type="submit"
          className="secondary"
          disabled={locked || !ACCOUNT_NUMBER.test(number)}
        >
          Tìm
        </button>
      </form>
      <ErrorBanner error={findError} />
      {target && (
        <>
          <dl className="facts">
            <dt>Chủ tài khoản</dt>
            <dd data-testid="deposit-owner">{target.ownerName}</dd>
            <dt>Trạng thái</dt>
            <dd>{ACCOUNT_STATUS[target.status]}</dd>
          </dl>
          <Field
            label="Số tiền (đồng)"
            value={amountText}
            onChange={event => {
              setAmountText(event.target.value);
              setDone(undefined);
              endAttempt(FORM); // a different amount is a different deposit
            }}
            error={amountError}
            hint={amount && isPositive(amount) ? formatVnd(amount) : undefined}
            inputMode="numeric"
            disabled={locked}
            autoComplete="off"
          />
          {unknown !== undefined && (
            <div role="alert" className="error">
              <p>{describeError(unknown)}</p>
              <p>
                Chưa chắc đã nạp. Bấm <strong>Nạp tiền</strong> lần nữa: hệ thống nhận ra yêu cầu cũ
                và không nạp hai lần.
              </p>
            </div>
          )}
          <ErrorBanner error={refused} />
          <button
            type="button"
            disabled={sending || !amount || Boolean(amountError)}
            onClick={() => void send()}
          >
            {sending ? 'Đang nạp…' : 'Nạp tiền'}
          </button>
        </>
      )}
      {done && (
        <p role="status" className="ok" data-testid="deposit-done">
          Đã nạp {formatVnd(done.amount)}. Mã giao dịch{' '}
          <span className="mono">{done.transferId}</span>
        </p>
      )}
    </section>
  );
}
