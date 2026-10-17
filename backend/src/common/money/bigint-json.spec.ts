import { installBigIntJson } from './bigint-json';

/**
 * These tests rewrite `BigInt.prototype.toJSON`. Jest gives every test FILE its own realm, so the
 * change cannot leak into other files; inside this file each test starts and ends without one.
 */
function removeToJson(): void {
  delete BigInt.prototype.toJSON;
}

describe('installBigIntJson (DBS-22)', () => {
  beforeEach(removeToJson);
  afterEach(removeToJson);

  it('TC-22-22 without it JSON.stringify refuses a bigint; with it a bigint becomes a string', () => {
    expect(() => JSON.stringify({ amount: 1n })).toThrow(TypeError);

    installBigIntJson();

    expect(JSON.stringify({ amount: 9_007_199_254_740_993n })).toBe(
      '{"amount":"9007199254740993"}',
    );
    expect(
      JSON.stringify({ list: [1n, 2n], nested: { max: 2n ** 63n - 1n }, negative: -300_000n }),
    ).toBe('{"list":["1","2"],"nested":{"max":"9223372036854775807"},"negative":"-300000"}');
  });

  it('TC-22-23 is idempotent, keeps a lossless toJSON, refuses a lossy one, leaves numbers alone', () => {
    installBigIntJson();
    const installed = BigInt.prototype.toJSON;
    installBigIntJson();
    expect(BigInt.prototype.toJSON).toBe(installed);
    // Not enumerable: it must not show up when somebody iterates the prototype.
    expect(Object.keys(BigInt.prototype)).not.toContain('toJSON');
    expect(JSON.stringify({ a: 1.5, b: 2n })).toBe('{"a":1.5,"b":"2"}');

    // Somebody else already defined a toJSON that keeps every digit: leave it alone.
    removeToJson();
    const lossless = function (this: bigint): string {
      return this.toString();
    };
    BigInt.prototype.toJSON = lossless;
    installBigIntJson();
    expect(BigInt.prototype.toJSON).toBe(lossless);

    // ... but one that rounds (the common `Number(this)` snippet) would silently turn
    // 9007199254740993 into 9007199254740992 everywhere a format call was forgotten: fail at start.
    removeToJson();
    BigInt.prototype.toJSON = function (this: bigint) {
      return Number(this);
    } as unknown as () => string;
    expect(() => installBigIntJson()).toThrow(/loses|precision|digit/i);
  });
});
