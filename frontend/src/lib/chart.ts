/**
 * Points of a step chart of balances, oldest first, in a `width` × `height` box. Money stays a
 * `BigInt` until the very last step, where only a screen position is computed from the ratio.
 */
export function stepPath(balances: readonly string[], width: number, height: number): string {
  if (balances.length === 0) return '';
  const values = balances.map(value => BigInt(value));
  const max = values.reduce((a, b) => (b > a ? b : a), 0n);
  const scale = 10_000n;
  const y = (value: bigint): number => {
    const ratio = max === 0n ? 0 : Number((value * scale) / max) / Number(scale);
    return Math.round((height - ratio * (height - 8)) * 10) / 10;
  };
  const step = width / values.length;
  return values
    .map((value, index) => {
      const x = Math.round(index * step * 10) / 10;
      const next = Math.round((index + 1) * step * 10) / 10;
      return `${index === 0 ? `M${x} ${y(value)}` : `V${y(value)}`} H${next}`;
    })
    .join(' ');
}
