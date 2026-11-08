import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { AuditReason } from '@modules/audit';
import { assertValidMetadata } from '@modules/audit/audit-metadata.guard';
import {
  MAX_REASON_LENGTH,
  fingerprintReason,
  parseAccountUuid,
  parseStatusReason,
  resolveLockReason,
  resolveUnlockReason,
} from './operator-account-status.dto';

describe('operator-account-status.dto (TC-113-12)', () => {
  describe('parseAccountUuid', () => {
    it('normalizes valid uppercase/mixed-case UUIDs to canonical lowercase', () => {
      expect(parseAccountUuid('2E859A80-D4D0-471D-8CEE-E9D0DE9D4BC7')).toBe(
        '2e859a80-d4d0-471d-8cee-e9d0de9d4bc7',
      );
      expect(parseAccountUuid('  2e859a80-d4d0-471d-8cee-e9d0de9d4bc7  ')).toBe(
        '2e859a80-d4d0-471d-8cee-e9d0de9d4bc7',
      );
    });

    it.each(['', 'not-a-uuid', '2e859a80-d4d0-471d-8cee-e9d0de9d4bc7; DROP TABLE accounts'])(
      'rejects malformed account UUID %j with BadRequestException',
      value => {
        expect(() => parseAccountUuid(value)).toThrow(BadRequestException);
      },
    );
  });

  describe('parseStatusReason', () => {
    it('accepts valid reason strings, trims whitespace, and normalizes NFC', () => {
      const decomposed = 'Kh\u0061\u0301ch y\u00eau c\u1ea7u kh\u00f3a';
      const normalized = parseStatusReason({ reason: `  ${decomposed}  ` });
      expect(normalized).toBe('Khách yêu cầu khóa');
    });

    it('accepts boundary lengths of 1 character and 200 characters (code points)', () => {
      expect(parseStatusReason({ reason: 'A' })).toBe('A');
      const maxReason = 'Đ'.repeat(MAX_REASON_LENGTH);
      expect(parseStatusReason({ reason: maxReason })).toBe(maxReason);
    });

    it('rejects missing, non-object, array, or extra properties on body', () => {
      expect(() => parseStatusReason(null)).toThrow(BadRequestException);
      expect(() => parseStatusReason(undefined)).toThrow(BadRequestException);
      expect(() => parseStatusReason('CONFIRMED_FRAUD')).toThrow(BadRequestException);
      expect(() => parseStatusReason(['CONFIRMED_FRAUD'])).toThrow(BadRequestException);
      expect(() => parseStatusReason({})).toThrow(BadRequestException);
      expect(() => parseStatusReason({ reason: 'CONFIRMED_FRAUD', status: 'ACTIVE' })).toThrow(
        BadRequestException,
      );
    });

    it('rejects non-string, empty/whitespace, > 200 chars, control chars, and lone surrogates', () => {
      expect(() => parseStatusReason({ reason: 123 })).toThrow(BadRequestException);
      expect(() => parseStatusReason({ reason: '' })).toThrow(BadRequestException);
      expect(() => parseStatusReason({ reason: '   \t  ' })).toThrow(BadRequestException);
      expect(() => parseStatusReason({ reason: 'A'.repeat(MAX_REASON_LENGTH + 1) })).toThrow(
        BadRequestException,
      );
      expect(() => parseStatusReason({ reason: 'Line1\nLine2' })).toThrow(BadRequestException);
      expect(() => parseStatusReason({ reason: 'Null\u0000byte' })).toThrow(BadRequestException);
      expect(() => parseStatusReason({ reason: 'C1\u0085control' })).toThrow(BadRequestException);
      expect(() => parseStatusReason({ reason: 'Lone\uD800surrogate' })).toThrow(
        BadRequestException,
      );
    });
  });

  describe('resolveLockReason & resolveUnlockReason & fingerprintReason', () => {
    it('maps known lock reason codes and falls back to OPERATOR_LOCK for free text', () => {
      expect(resolveLockReason('CONFIRMED_FRAUD')).toBe(AuditReason.CONFIRMED_FRAUD);
      expect(resolveLockReason('SUSPICIOUS_ACTIVITY')).toBe(AuditReason.SUSPICIOUS_ACTIVITY);
      expect(resolveLockReason('CUSTOMER_REQUEST')).toBe(AuditReason.CUSTOMER_REQUEST);
      expect(resolveLockReason('COMPLIANCE_HOLD')).toBe(AuditReason.COMPLIANCE_HOLD);
      expect(resolveLockReason('OPERATOR_LOCK')).toBe(AuditReason.OPERATOR_LOCK);
      expect(resolveLockReason('Nghi ngờ giao dịch bất thường tại quầy')).toBe(
        AuditReason.OPERATOR_LOCK,
      );
    });

    it('maps known unlock reason codes and falls back to OPERATOR_UNLOCK for free text', () => {
      expect(resolveUnlockReason('CUSTOMER_REQUEST')).toBe(AuditReason.CUSTOMER_REQUEST);
      expect(resolveUnlockReason('COMPLIANCE_HOLD')).toBe(AuditReason.COMPLIANCE_HOLD);
      expect(resolveUnlockReason('OPERATOR_UNLOCK')).toBe(AuditReason.OPERATOR_UNLOCK);
      expect(resolveUnlockReason('CONFIRMED_FRAUD')).toBe(AuditReason.OPERATOR_UNLOCK);
      expect(resolveUnlockReason('Đã xác minh chính chủ tại quầy')).toBe(
        AuditReason.OPERATOR_UNLOCK,
      );
    });

    it('computes 32-hex SHA-256 over the exact NFC+trimmed reason and passes assertValidMetadata', () => {
      const reason = 'Đã xác minh chính chủ tại quầy';
      const fp = fingerprintReason(reason);
      const expected = createHash('sha256').update(reason, 'utf8').digest('hex').slice(0, 32);
      expect(fp).toBe(expected);
      expect(fp).toMatch(/^[0-9a-f]{32}$/);

      expect(() =>
        assertValidMetadata({
          id: fp,
          reason: resolveLockReason(reason),
        }),
      ).not.toThrow();
      expect(() =>
        assertValidMetadata({
          id: fp,
          reason: resolveUnlockReason(reason),
        }),
      ).not.toThrow();
    });
  });
});

