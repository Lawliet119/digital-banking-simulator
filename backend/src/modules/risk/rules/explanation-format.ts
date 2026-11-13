/**
 * The one number and money format of the R1-R6 explanations (BL-184 H7, BL-207(e)): Vietnamese
 * style, a dot between thousands and a comma for decimals (`20.000.000đ`, `12,5`, `99,99`), as in
 * the guide's sample. Everything works on bigint and digit strings: `Number` and `toLocaleString`
 * lose digits above 2^53 and depend on the runtime's ICU data.
 */

/** Dots between groups of three digits of a non-negative integer string. */
export function groupThousands(digits: string): string {
  return digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
}

/** Whole dong with the currency suffix, e.g. `20.000.000đ`. */
export function formatDong(amount: bigint): string {
  return `${groupThousands(amount.toString())}đ`;
}

/**
 * Half a doubled amount, in dong: the exact median is kept as twice its value so an even history
 * stays an integer, and a half shows as `,5` (`1.000.000,5đ`).
 */
export function formatDongHalf(twice: bigint): string {
  const half = groupThousands((twice / 2n).toString());
  return `${half}${twice % 2n === 1n ? ',5' : ''}đ`;
}

/** `hundredths / 100` with exactly two decimals, e.g. `99,99`. */
export function formatFixed2(hundredths: bigint): string {
  const fraction = (hundredths % 100n).toString().padStart(2, '0');
  return `${groupThousands((hundredths / 100n).toString())},${fraction}`;
}

/** `hundredths / 100` without trailing zeros, e.g. `12,5` or `5`. */
export function formatTrimmed2(hundredths: bigint): string {
  const fraction = (hundredths % 100n).toString().padStart(2, '0').replace(/0+$/, '');
  const whole = groupThousands((hundredths / 100n).toString());
  return fraction === '' ? whole : `${whole},${fraction}`;
}
