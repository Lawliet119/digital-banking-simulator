import { ROLES, rolesFromGroups } from './roles';

describe('rolesFromGroups', () => {
  it('TC-51-01 lists the four roles in a fixed order', () => {
    expect(ROLES).toEqual(['customer', 'operator', 'auditor', 'admin']);
  });

  it.each([[undefined], [[]]])(
    'TC-51-01 treats a token with no group (%p) as customer (ADR-06)',
    groups => {
      expect(rolesFromGroups(groups)).toEqual(['customer']);
    },
  );

  it('TC-51-02 maps a single group to that role, without adding customer', () => {
    expect(rolesFromGroups(['operator'])).toEqual(['operator']);
    expect(rolesFromGroups(['admin'])).toEqual(['admin']);
  });

  it('TC-51-02 keeps every valid role of a multi-group token, in the fixed order, once each', () => {
    expect(rolesFromGroups(['auditor', 'operator', 'operator'])).toEqual(['operator', 'auditor']);
    expect(rolesFromGroups(['admin', 'customer', 'auditor', 'operator'])).toEqual([
      'customer',
      'operator',
      'auditor',
      'admin',
    ]);
  });

  it.each([['Admin'], ['ops'], ['constructor'], ['__proto__'], ['toString'], ['hasOwnProperty']])(
    'TC-51-03 treats the unknown group %p alone as customer',
    group => {
      expect(rolesFromGroups([group])).toEqual(['customer']);
    },
  );

  it('TC-51-03 drops unknown groups next to a valid one', () => {
    expect(rolesFromGroups(['xyz', 'auditor'])).toEqual(['auditor']);
    expect(rolesFromGroups(['__proto__', 'admin', 'constructor'])).toEqual(['admin']);
  });

  it.each([
    ['a string', 'admin'],
    ['null', null],
    ['an empty object', {}],
    ['an array-like object', { '0': 'admin', length: 1 }],
    ['a nested array', [['admin']]],
    ['non-string members', [1, {}]],
    ['a trailing space', ['admin ']],
    ['upper case', ['ADMIN']],
    ['a number', 7],
    ['a boolean', true],
  ])('TC-51-04 treats a wrongly typed claim (%s) as customer', (_label, groups) => {
    expect(rolesFromGroups(groups)).toEqual(['customer']);
  });

  it('TC-51-04 keeps the valid string members of an array that also holds junk', () => {
    expect(rolesFromGroups([1, 'auditor'])).toEqual(['auditor']);
  });

  it('TC-51-04 returns a new array every call, so a caller cannot change what the next call sees', () => {
    const first = rolesFromGroups(['operator']);
    first.push('admin');

    expect(rolesFromGroups(['operator'])).toEqual(['operator']);
    expect(rolesFromGroups(undefined)).not.toBe(rolesFromGroups(undefined));
  });
});
