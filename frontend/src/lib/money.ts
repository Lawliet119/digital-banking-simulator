/**
 * Money is a string of whole đồng, exactly as the API sends it (BR-01). It never becomes a
 * JavaScript number: above 2^53 a number silently rounds. Everything here goes through BigInt.
 */

const INTEGER = /^-?\d+$/;

/** `"1234567"` → `"1.234.567 ₫"`; `"-5000"` → `"-5.000 ₫"`. A malformed value is shown as is. */
export function formatVnd(amount: string): string {
  if (!INTEGER.test(amount)) return amount;
  const value = BigInt(amount);
  const negative = value < 0n;
  const digits = (negative ? -value : value).toString();
  const grouped = digits.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${negative ? '-' : ''}${grouped} ₫`;
}

/**
 * What a person types into an amount field → the API string, or `null` when it is not a whole,
 * non-negative number of đồng. Dots and spaces are thousand separators (`"1.234.567"`); a comma
 * or a sign is refused, so `"1,5"` is never read as one and a half million or as 15.
 */
export function parseVndInput(text: string): string | null {
  const compact = text.trim().replace(/[.\s]/g, '');
  if (!/^\d+$/.test(compact)) return null;
  // Separators must sit between groups of three: "1.23.4" is a typo, not 1234.
  const trimmed = text.trim();
  if (/[.\s]/.test(trimmed) && !/^\d{1,3}([.\s]\d{3})+$/.test(trimmed)) return null;
  return BigInt(compact).toString();
}

/** True when the API string is strictly greater than zero. */
export function isPositive(amount: string): boolean {
  return INTEGER.test(amount) && BigInt(amount) > 0n;
}
