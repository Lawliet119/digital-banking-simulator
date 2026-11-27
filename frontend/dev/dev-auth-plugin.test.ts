import { describe, expect, it } from 'vitest';
import { parseDevTokenQuery, tokenCommand } from './dev-auth-plugin';

const q = (text: string) => new URLSearchParams(text);

describe('parseDevTokenQuery', () => {
  it('accepts one of the four roles and a plain sub', () => {
    expect(parseDevTokenQuery(q('role=operator&sub=op-1'))).toEqual({
      role: 'operator',
      sub: 'op-1',
    });
  });

  it.each([
    ['an unknown role', 'role=root&sub=a'],
    ['a role with different case', 'role=Admin&sub=a'],
    ['a sub with a space', 'role=customer&sub=a%20b'],
    ['a sub with a shell character', 'role=customer&sub=a;rm'],
    ['a sub longer than 64', `role=customer&sub=${'a'.repeat(65)}`],
    ['an empty sub', 'role=customer&sub='],
    ['a missing sub', 'role=customer'],
    ['a repeated role', 'role=customer&role=admin&sub=a'],
    ['an extra parameter', 'role=customer&sub=a&exp=1'],
  ])('refuses %s', (_name, text) => {
    expect(parseDevTokenQuery(q(text))).toHaveProperty('error');
  });
});

describe('tokenCommand', () => {
  it('passes role and sub as separate arguments', () => {
    const args = tokenCommand('customer', 'abc-1');
    expect(args.slice(-4)).toEqual(['--role', 'customer', '--sub', 'abc-1']);
  });
});
