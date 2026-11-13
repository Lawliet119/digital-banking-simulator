import { ErrorCode } from '@common/errors/error-code.enum';
import {
  AuditReason,
  NestedTransactionError,
  type AuditMetadata,
  type AuditOutcome,
  type AuditRecordInput,
} from './audit.types';
import {
  AUDIT_ACTIONS,
  AUDIT_ACTOR_ROLES,
  AUDIT_TARGET_TYPES,
  actorRoleOf,
} from './audit.registry';

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
      const _fraudConfirmed: AuditMetadata = { reason: AuditReason.CONFIRMED_FRAUD };
      const _fraudFalsePositive: AuditMetadata = { reason: AuditReason.FRAUD_FALSE_POSITIVE };
      // @ts-expect-error -- a free sentence is not a member of either registry
      const _r3: AuditMetadata = { reason: 'khach khong phai chu tai khoan' };
    };
  });

  it('TC-19-01 the compiler closes action, actor role and target type (BL-019)', () => {
    // Nothing here runs: every `@ts-expect-error` line must be a compile error, so a typo in a
    // caller fails `tsc` instead of becoming a second spelling of an action in audit_log.
    const _typeChecks = (): void => {
      // @ts-expect-error -- 'transfer.send' is not a registered action
      const _a1: AuditRecordInput = { ...VALID_INPUT, action: 'transfer.send' };
      // @ts-expect-error -- 'superuser' is neither a role nor 'worker'
      const _a2: AuditRecordInput = { ...VALID_INPUT, role: 'superuser' };
      // @ts-expect-error -- 'system' was never written by any caller; the worker role is 'worker'
      const _a3: AuditRecordInput = { ...VALID_INPUT, role: 'system' };
      // @ts-expect-error -- 'acount' is a typo of a target type
      const _a4: AuditRecordInput = { ...VALID_INPUT, target: { type: 'acount', id: 'x' } };

      // The registered values still compile, including a role list for a multi-group caller.
      const _ok1: AuditRecordInput = { ...VALID_INPUT, action: 'access.denied' };
      const _ok2: AuditRecordInput = { ...VALID_INPUT, role: 'operator,auditor' };
      const _ok3: AuditRecordInput = { ...VALID_INPUT, role: 'worker' };
    };
  });

  it('TC-19-02 the registries hold every value once, with no blanks', () => {
    for (const registry of [AUDIT_ACTIONS, AUDIT_ACTOR_ROLES, AUDIT_TARGET_TYPES]) {
      expect(new Set(registry).size).toBe(registry.length);
      for (const value of registry) expect(value).toMatch(/^[a-z][a-z_.]*$/);
    }
    expect(AUDIT_ACTOR_ROLES).toEqual(['customer', 'operator', 'auditor', 'admin', 'worker']);
    expect(AUDIT_ACTIONS).toContain('access.denied');
    expect(AUDIT_TARGET_TYPES).toContain('route');
  });

  it('TC-19-03 actorRoleOf keeps one role as is and joins several in the order given', () => {
    expect(actorRoleOf(['customer'])).toBe('customer');
    expect(actorRoleOf(['operator', 'auditor'])).toBe('operator,auditor');
    expect(() => actorRoleOf([])).toThrow();
  });

  it('accepts a fully valid AuditRecordInput', () => {
    expect(VALID_INPUT.outcome).toBe('SUCCESS');
  });

  it('NestedTransactionError has a fixed message and never echoes input', () => {
    const error = new NestedTransactionError();

    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe('NestedTransactionError');
    expect(error.message).toBeTruthy();
  });
});
