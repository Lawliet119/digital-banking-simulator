import { describe, expect, it } from 'vitest';
import { describeCognitoError, passwordOk, PASSWORD_RULES } from './cognito-words';

const named = (name: string) => Object.assign(new Error('raw service text'), { name });

describe('password rules', () => {
  it('accepts a password that meets the pool policy', () => {
    expect(passwordOk('Mat-khau-2026')).toBe(true);
    expect(passwordOk('Mat khau 2026')).toBe(true);
  });

  it.each([
    ['Ngan-2026', 'Ít nhất 12 ký tự'],
    ['khong-hoa-2026', 'Có chữ hoa'],
    ['KHONG-THUONG-2026', 'Có chữ thường'],
    ['Khong-co-so-nao', 'Có chữ số'],
    ['KhongKyTuDacBiet2026', 'Có ký tự đặc biệt'],
  ])('%s fails "%s" only', (password, rule) => {
    expect(passwordOk(password)).toBe(false);
    expect(PASSWORD_RULES.filter(([, test]) => !test(password)).map(([label]) => label)).toEqual([
      rule,
    ]);
  });
});

describe('describeCognitoError', () => {
  it('does not tell an unknown email from a wrong password', () => {
    expect(describeCognitoError(named('UserNotFoundException'))).toBe(
      describeCognitoError(named('NotAuthorizedException')),
    );
  });

  it('never shows the raw service message', () => {
    for (const name of ['CodeMismatchException', 'SomethingNew']) {
      expect(describeCognitoError(named(name))).not.toContain('raw service text');
    }
  });

  it('reports a failed fetch as a network problem', () => {
    expect(describeCognitoError(new TypeError('Failed to fetch'))).toBe(
      'Không kết nối được máy chủ đăng nhập.',
    );
  });
});
