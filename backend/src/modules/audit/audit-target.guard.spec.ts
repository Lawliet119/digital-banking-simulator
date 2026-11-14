import type { EntityManager } from 'typeorm';
import { AUDIT_TARGET_TYPES, type AuditTargetType } from './audit.registry';
import { AuditService } from './audit.service';
import { AuditTargetError, type AuditRecordInput } from './audit.types';
import { assertValidTarget } from './audit-target.guard';

const UUID = '22222222-2222-2222-2222-222222222222';
const FINGERPRINT = 'a'.repeat(32);

const VALID: Record<AuditTargetType, string[]> = {
  account: [UUID, UUID.toUpperCase(), 'invalid'],
  customer: [UUID],
  fraud_flag: [UUID],
  transfer: [UUID],
  user: [UUID],
  account_search: [FINGERPRINT, '0123456789abcdef0123456789abcdef'],
  audit_search: [UUID],
  fraud_flag_search: [UUID],
  risk_rule_set: ['1', '42', '2147483647'],
  route: ['GET /v1/audit/entries', 'POST /v1/operator/deposits', 'GET (unknown route)'],
};

const INVALID: Record<AuditTargetType, string[]> = {
  account: ['', 'not-a-uuid', 'Nguyen Van A', `${UUID}x`, "' OR 1=1 --"],
  customer: ['invalid', '', UUID.slice(1)],
  fraud_flag: ['invalid', '1'],
  transfer: ['invalid', '', 'a@b.com'],
  user: ['', 'invalid'],
  account_search: ['nguyen van a', FINGERPRINT.toUpperCase(), 'a'.repeat(31), 'a'.repeat(33)],
  audit_search: [FINGERPRINT, ''],
  fraud_flag_search: ['abc', ''],
  risk_rule_set: ['0', '-1', '01', '1.5', '2147483648', '12345678901', '', 'v2'],
  route: ['', 'GET', 'get /v1/x', 'GET /v1/x?token=abc', 'GET /v1/x\nPOST /v1/y', '/v1/x'],
};

describe('audit target id guard (BL-019)', () => {
  it('has a format for every target type of the registry, and a case list for each', () => {
    expect(Object.keys(VALID).sort()).toEqual([...AUDIT_TARGET_TYPES].sort());
    expect(Object.keys(INVALID).sort()).toEqual([...AUDIT_TARGET_TYPES].sort());
  });

  describe.each(AUDIT_TARGET_TYPES)('%s', type => {
    it.each(VALID[type])('accepts %j', id => {
      expect(() => assertValidTarget({ type, id })).not.toThrow();
    });
    it.each(INVALID[type])('rejects %j', id => {
      expect(() => assertValidTarget({ type, id })).toThrow(AuditTargetError);
    });
  });

  it('rejects an unknown or inherited type and a non-string id, without echoing the value', () => {
    for (const target of [
      { type: 'constructor', id: UUID },
      { type: '__proto__', id: UUID },
      { type: 'unknown', id: UUID },
      { type: 'account', id: 42 },
      { type: 'account', id: null },
      { type: undefined, id: UUID },
    ]) {
      expect(() => assertValidTarget(target as never)).toThrow(AuditTargetError);
    }
    try {
      assertValidTarget({ type: 'transfer', id: 'secret-value' });
    } catch (error) {
      expect((error as Error).message).not.toContain('secret-value');
    }
  });

  it('AuditService.record rejects a malformed target before calling manager.query', async () => {
    const query = jest.fn().mockResolvedValue(undefined);
    const service = new AuditService({} as never);
    const input: AuditRecordInput = {
      actor: UUID,
      role: 'operator',
      action: 'fraud_flag.view',
      outcome: 'SUCCESS',
      target: { type: 'fraud_flag', id: 'Nguyen Van A' },
      correlationId: UUID,
    };
    await expect(service.record({ query } as unknown as EntityManager, input)).rejects.toThrow(
      AuditTargetError,
    );
    expect(query).not.toHaveBeenCalled();
  });
});
