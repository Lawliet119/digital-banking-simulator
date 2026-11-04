import { ErrorCode } from '@common/errors/error-code.enum';
import { assertValidMetadata, serializeMetadata } from './audit-metadata.guard';
import { AuditMetadataError, AuditReason } from './audit.types';

describe('assertValidMetadata (DBS-56)', () => {
  describe('TC-56-07d accepts', () => {
    it.each([
      ['omitted', undefined],
      ['empty object', {}],
      ['id only', { id: '11111111-1111-1111-1111-111111111111' }],
      ['reason from ErrorCode', { reason: ErrorCode.ACCOUNT_NOT_ACTIVE }],
      ['reason from AuditReason', { reason: AuditReason.NOT_OWNER }],
      ['count zero', { count: 0 }],
      ['all three valid fields', { id: 'abc123', reason: AuditReason.NO_PERMISSION, count: 3 }],
    ])('%s', (_label, metadata) => {
      expect(() => assertValidMetadata(metadata)).not.toThrow();
    });
  });

  describe('TC-56-07b/07c rejects', () => {
    it.each([
      ['array instead of object', ['a', 'b']],
      ['null', null],
      ['string', 'not an object'],
      [
        'extra key built via spread (bypasses compile-time check)',
        { ...{ id: 'a' }, email: 'a@b.com' },
      ],
      ['id not a string (number)', { id: 12345 }],
      ['id not a string (array)', { id: ['abc'] }],
      ['id not a string (boolean)', { id: true }],
      ['id with a space', { id: 'has space' }],
      ['id longer than 36 chars', { id: 'a'.repeat(37) }],
      ['reason not a string (number)', { reason: 12345 }],
      ['reason as a free sentence', { reason: 'khach khong phai chu tai khoan' }],
      ['reason that looks like a code but is not registered', { reason: 'NGUYENVANA' }],
      ['count negative', { count: -1 }],
      ['count not an integer', { count: 1.5 }],
      ['count not a safe integer', { count: Number.MAX_SAFE_INTEGER + 1 }],
    ])('%s', (_label, metadata) => {
      expect(() => assertValidMetadata(metadata as never)).toThrow(AuditMetadataError);
    });

    it('error message never echoes the rejected value', () => {
      try {
        assertValidMetadata({ reason: 'ten khach hang that' } as never);
        throw new Error('expected assertValidMetadata to throw');
      } catch (error) {
        expect(error).toBeInstanceOf(AuditMetadataError);
        expect((error as Error).message).not.toContain('ten khach hang that');
      }
    });
  });

  describe('serializeMetadata (vòng 2: validate trên cùng giá trị sẽ được ghi vào DB)', () => {
    it('TC-56-14 rejects a non-enumerable toJSON() that would leak PII past Object.keys', () => {
      const metadata = { id: '11111111-1111-1111-1111-111111111111' };
      Object.defineProperty(metadata, 'toJSON', {
        value: () => ({ email: 'victim@example.com' }),
        enumerable: false,
      });

      expect(Object.keys(metadata)).toEqual(['id']); // the old guard would have passed this

      expect(() => serializeMetadata(metadata as never)).toThrow(AuditMetadataError);
    });

    it('TC-56-15 rejects a Date (JSON.stringify turns it into a bare string, not a valid object)', () => {
      expect(() => serializeMetadata(new Date() as never)).toThrow(AuditMetadataError);
    });

    it.each([
      ['omitted', undefined],
      ['empty object', {}],
      ['id only', { id: '11111111-1111-1111-1111-111111111111' }],
      ['reason from ErrorCode', { reason: ErrorCode.ACCOUNT_NOT_ACTIVE }],
      ['reason from AuditReason', { reason: AuditReason.NOT_OWNER }],
      ['count zero', { count: 0 }],
      ['all three valid fields', { id: 'abc123', reason: AuditReason.NO_PERMISSION, count: 3 }],
    ])('TC-56-16 accepts %s and returns its JSON serialization', (_label, metadata) => {
      expect(serializeMetadata(metadata)).toBe(JSON.stringify(metadata ?? {}));
    });

    it('TC-56-16b rejects an explicit null (must not be defaulted to {} the way omitted is)', () => {
      expect(() => serializeMetadata(null as never)).toThrow(AuditMetadataError);
    });

    it('TC-56-17 propagates an error from JSON.stringify itself, unwrapped', () => {
      const metadata = {
        get count(): number {
          throw new Error('boom');
        },
      };

      expect(() => serializeMetadata(metadata as never)).toThrow('boom');
    });
  });
});
