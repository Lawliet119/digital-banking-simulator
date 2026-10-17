declare global {
  interface BigInt {
    /** Optional on purpose: it does not exist until `installBigIntJson()` adds it. */
    toJSON?(): string;
  }
}

/** 2^53 + 1: the smallest integer a JS number cannot hold. A lossy toJSON gets it wrong. */
const PROBE = 2n ** 53n + 1n;
const PROBE_TEXT = '9007199254740993';

/**
 * Makes `JSON.stringify` accept a bigint by writing it as a decimal STRING
 * (`{"amount":"9007199254740993"}`), which is also how money travels on the wire.
 *
 * Without it `JSON.stringify(1n)` throws `TypeError: Do not know how to serialize a BigInt`, and a
 * response, an SQS payload or a `jsonb` audit value that carries a bigint dies as a 500 or in the
 * worker. `formatMoney` / `formatBalance` remain the official way to turn money into a string; this
 * is the net under them, so a place that forgot to format produces a string instead of an error.
 *
 * It patches `BigInt.prototype`, which is process-wide, so:
 *  - calling it twice changes nothing;
 *  - a `toJSON` that already exists is kept if it keeps every digit;
 *  - one that does not (the common `return Number(this)` snippet rounds 9007199254740993 to
 *    9007199254740992) would reintroduce silently the loss this module exists to prevent, so
 *    it throws. Better a failed start than a ledger amount that is off by one.
 */
export function installBigIntJson(): void {
  if ('toJSON' in BigInt.prototype) {
    if (BigInt.prototype.toJSON?.call(PROBE) !== PROBE_TEXT) {
      throw new Error(
        'BigInt.prototype.toJSON is already defined and does not keep every digit of a bigint ' +
          '(2^53 + 1 does not serialize exactly). Remove it so that @common/money can install a ' +
          'lossless one.',
      );
    }
    return;
  }
  Object.defineProperty(BigInt.prototype, 'toJSON', {
    value: function toJSON(this: bigint): string {
      return this.toString();
    },
    writable: true,
    configurable: true, // tests delete it
    enumerable: false, // must not appear when someone iterates the prototype
  });
}
