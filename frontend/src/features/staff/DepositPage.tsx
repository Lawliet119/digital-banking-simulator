import { useState, type FormEvent } from 'react';
import { call, callWithMeta, type Schemas } from '../../api/client';
import { ApiProblem, describeError } from '../../api/problem';
import { useApi } from '../../auth/AuthProvider';
import { ErrorBanner } from '../../components/ErrorBanner';
import { Field } from '../../components/Field';
import { Icon } from '../../components/Icon';
import { initials, PageHead, Tag } from '../../components/ui';
import { beginAttempt, endAttempt, isDefinite, settleAttempt } from '../../lib/idempotency';
import { formatVnd, isPositive, parseVndInput } from '../../lib/money';
import { ACCOUNT_STATUS, ACCOUNT_TYPE } from '../customer/labels';

const FORM = 'deposit';
const ACCOUNT_NUMBER = /^\d{12}$/;
const PRESETS = ['500000', '1000000', '5000000', '10000000'];

type Target = Schemas['OperatorAccountDto'];

interface Done {
  transferId: string;
  amount: string;
  ownerName: string;
  accountNumber: string;
}

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
  const [done, setDone] = useState<Done | undefined>();

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

  function changeAmount(text: string) {
    setAmountText(text);
    setDone(undefined);
    endAttempt(FORM); // a different amount is a different deposit
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
      setDone({
        transferId: data.transferId,
        amount,
        ownerName: target.ownerName,
        accountNumber: target.accountNumber,
      });
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
    <>
      <PageHead title="Nạp tiền tại quầy" />
      <div className="split">
        <section className="panel">
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
              <div className="choice">
                <span className="tile info">{initials(target.ownerName)}</span>
                <div className="grow">
                  <b data-testid="deposit-owner">{target.ownerName}</b>
                  <div className="muted">
                    {ACCOUNT_TYPE[target.type]} ·{' '}
                    <span className="mono">{target.accountNumber}</span>
                  </div>
                </div>
                <Tag tone={target.status === 'ACTIVE' ? 'ok' : 'bad'}>
                  {ACCOUNT_STATUS[target.status]}
                </Tag>
              </div>
              <div className="amount-field">
                <Field
                  label="Số tiền (đồng)"
                  value={amountText}
                  onChange={event => changeAmount(event.target.value)}
                  error={amountError}
                  hint={amount && isPositive(amount) ? formatVnd(amount) : undefined}
                  inputMode="numeric"
                  disabled={locked}
                  autoComplete="off"
                />
              </div>
              <div className="row" role="group" aria-label="Số tiền chọn nhanh">
                {PRESETS.map(preset => (
                  <button
                    key={preset}
                    type="button"
                    className="chip"
                    disabled={locked}
                    aria-pressed={amount === preset}
                    onClick={() => changeAmount(formatVnd(preset).replace(' ₫', ''))}
                  >
                    {formatVnd(preset)}
                  </button>
                ))}
              </div>
              {unknown !== undefined && (
                <div role="alert" className="error">
                  <p>{describeError(unknown)}</p>
                  <p>
                    Chưa chắc đã nạp. Bấm <strong>Nạp tiền</strong> lần nữa: tiền không bị nạp hai
                    lần.
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
        </section>
        {done && (
          <section role="status" className="panel" data-testid="deposit-done">
            <div className="row nowrap">
              <span className="tile in">
                <Icon name="check" />
              </span>
              <h2>Đã nạp {formatVnd(done.amount)}</h2>
            </div>
            <dl className="facts">
              <dt>Người nhận</dt>
              <dd>{done.ownerName}</dd>
              <dt>Số tài khoản</dt>
              <dd className="mono">{done.accountNumber}</dd>
              <dt>Mã giao dịch</dt>
              <dd className="mono">{done.transferId}</dd>
            </dl>
          </section>
        )}
      </div>
    </>
  );
}
