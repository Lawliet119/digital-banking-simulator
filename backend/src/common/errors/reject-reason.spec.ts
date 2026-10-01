import { ErrorCode } from './error-code.enum';
import { isRejectReason, REJECT_REASONS } from './reject-reason';

describe('ErrorCode', () => {
  it('uses the member name as its value, so a code is greppable and never drifts from its name', () => {
    for (const [name, value] of Object.entries(ErrorCode)) {
      expect(value).toBe(name);
    }
  });
});

describe('RejectReason', () => {
  it('is exactly the four business rejections of a transfer', () => {
    expect([...REJECT_REASONS].sort()).toEqual(
      [
        ErrorCode.ACCOUNT_NOT_ACTIVE,
        ErrorCode.INSUFFICIENT_FUNDS,
        ErrorCode.LIMIT_PER_DAY_EXCEEDED,
        ErrorCode.LIMIT_PER_TX_EXCEEDED,
      ].sort(),
    );
  });

  it('recognises a reject reason and refuses other codes or free text', () => {
    expect(isRejectReason(ErrorCode.INSUFFICIENT_FUNDS)).toBe(true);
    expect(isRejectReason(ErrorCode.RATE_LIMITED)).toBe(false);
    expect(isRejectReason(ErrorCode.IDEMPOTENCY_KEY_REUSED)).toBe(false);
    expect(isRejectReason('SOMETHING_ELSE')).toBe(false);
    expect(isRejectReason(undefined)).toBe(false);
  });
});
