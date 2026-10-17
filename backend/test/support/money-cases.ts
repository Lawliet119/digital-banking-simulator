/**
 * Data shared by the specs of `@common/money` (DBS-22 §4). Lives under `test/` on purpose:
 * `nest build` ships `src/` only, so test data never reaches `dist/`.
 *
 * One table per type, because the two types disagree on purpose: "-1" is not a `Money` but is a
 * valid `Balance`. Within one type, `parseMoney`, `parsePositiveMoney`, `tryParseMoney` and
 * `@IsMoneyAmount` all read the same table, so they cannot drift apart while the tests stay green.
 */
export interface RejectCase {
  readonly input: string;
  /** `MoneyError.reason` the parser must give for this input. */
  readonly reason: 'INVALID' | 'OVERFLOW';
}

const invalid = (...inputs: string[]): RejectCase[] =>
  inputs.map(input => ({ input, reason: 'INVALID' }));
const overflow = (...inputs: string[]): RejectCase[] =>
  inputs.map(input => ({ input, reason: 'OVERFLOW' }));

/** Strings `Money` refuses (docs/features/DBS-22 §2.3). "0" is NOT here: it is a valid Money. */
export const MONEY_REJECT: readonly RejectCase[] = [
  ...invalid(
    '-1',
    '-0',
    '+1',
    '01',
    '00',
    '0001',
    '1.5',
    '1.0',
    '1.',
    '.5',
    '1e3',
    '1E3',
    ' 1',
    '1 ',
    '1\n',
    '\t1',
    '',
    '1,000',
    '1.000.000',
    '1_000',
    '0x10',
    'NaN',
    'Infinity',
    '１２', // full-width digits
    '٣', // Arabic-Indic digit
  ),
  ...overflow(
    '9223372036854775808', // 2^63
    '99999999999999999999', // 20 digits
    '1' + '0'.repeat(999),
    '9'.repeat(100_000), // must be refused at once, not hang
  ),
];

/** Strings `Balance` refuses (docs/features/DBS-22 §2.4). */
export const BALANCE_REJECT: readonly RejectCase[] = [
  ...invalid(
    '-0',
    '--1',
    '+1',
    '-',
    '-01',
    '01',
    '1.5',
    '-1.5',
    '1e3',
    ' -1',
    '- 1',
    '−1', // Unicode minus sign
    '',
    '1 ',
    '-1\n',
  ),
  ...overflow(
    '9223372036854775808', // 2^63
    '-9223372036854775809', // -2^63 - 1
    '1' + '0'.repeat(999),
    '-' + '9'.repeat(1000),
  ),
];

/** Values that are not strings at all. Only a string is ever accepted as money. */
export const NON_STRING_INPUTS: readonly unknown[] = [
  1000,
  Number('9007199254740993'), // what the JS number parser makes of 2^53 + 1: 9007199254740992
  1000n,
  null,
  undefined,
  true,
  {},
  [],
  ['1'],
  new String('1'), // a String object must be refused too
];

/** Strings `Money` accepts, with the exact value they stand for. */
export const MONEY_ACCEPT: readonly (readonly [string, bigint])[] = [
  ['0', 0n],
  ['1', 1n],
  ['500000', 500_000n],
  ['1500000', 1_500_000n],
  ['9007199254740993', 9_007_199_254_740_993n], // 2^53 + 1
  ['9223372036854775807', 9_223_372_036_854_775_807n], // 2^63 - 1
];
