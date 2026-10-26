import { ErrorCode } from '@common/errors/error-code.enum';
import {
  AuditReason,
  type AuditMetadata,
  type AuditOutcome,
  type AuditRecordInput,
} from './audit.types';

const VALID_INPUT: AuditRecordInput = {
  actor: '11111111-1111-1111-1111-111111111111',
  role: 'operator',
  action: 'ledger.transfer',
  outcome: 'SUCCESS',
  target: { type: 'account', id: '22222222-2222-2222-2222-222222222222' },
  correlationId: '33333333-3333-3333-3333-333333333333',
};

describe('audit types (DBS-56)', () => {
  it('TC-56-07/08 the compiler enforces AuditMetadata and AuditOutcome', () => {
    // Nothing here runs. Every `@ts-expect-error` line must be a compile error: see
    // event-types.spec.ts for why this file never executes the lines below.
    const _typeChecks = (): void => {
      // TC-56-07: a fresh object literal with an extra key is rejected at compile time.
      // @ts-expect-error -- metadata must not carry a free-text email
      const _m1: AuditMetadata = { id: 'a', email: 'a@b.com' };
      // @ts-expect-error -- metadata must not carry a customer name
      const _m2: AuditMetadata = { reason: ErrorCode.ACCOUNT_NOT_ACTIVE, fullName: 'Nguyen Van A' };

      // TC-56-08: outcome is closed to the three statuses the DB CHECK allows.
      // @ts-expect-error -- "PENDING" is not a valid AuditOutcome
      const _o1: AuditOutcome = 'PENDING';
      // @ts-expect-error -- outcome is required
      const _o2: AuditRecordInput = { ...VALID_INPUT, outcome: undefined };

      // reason accepts the two closed registries, nothing else.
      const _r1: AuditMetadata = { reason: ErrorCode.ACCOUNT_NOT_ACTIVE };
      const _r2: AuditMetadata = { reason: AuditReason.NOT_OWNER };
      // @ts-expect-error -- a free sentence is not a member of either registry
      const _r3: AuditMetadata = { reason: 'khach khong phai chu tai khoan' };
    };
  });

  it('accepts a fully valid AuditRecordInput', () => {
    expect(VALID_INPUT.outcome).toBe('SUCCESS');
  });
});
