describe('bigint-json.bootstrap (DBS-22)', () => {
  afterEach(() => {
    delete BigInt.prototype.toJSON;
  });

  it('TC-22-24 importing the bootstrap file is enough to make bigint JSON-safe', async () => {
    delete BigInt.prototype.toJSON;
    expect(() => JSON.stringify(1n)).toThrow(TypeError);

    // A fresh module registry, so the file really runs now even if an earlier import cached it.
    await jest.isolateModulesAsync(async () => {
      await import('./bigint-json.bootstrap');
    });

    expect(JSON.stringify(2n ** 53n + 1n)).toBe('"9007199254740993"');
  });
});
