import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { runChecked } = require('../run.cjs');
const { assertDuplicateCounts } = require('../postflight.cjs');

test('TC-165-05 runner preserves k6 failure and still calls checker', async () => {
  const calls = [];
  const result = await runChecked({ load: () => { calls.push('k6'); return 99; }, check: () => { calls.push('checker'); return 0; } });
  assert.equal(result, 99);
  assert.deepEqual(calls, ['k6', 'checker']);
});
test('TC-165-05 runner fails on a thrown load error or checker error', async () => {
  let checked = false;
  assert.notEqual(await runChecked({ load: () => { throw new Error('offline'); }, check: () => { checked = true; return 0; } }), 0);
  assert(checked);
  assert.equal(await runChecked({ load: () => 0, check: () => 2 }), 2);
  assert.notEqual(await runChecked({ load: () => 0, check: () => { throw new Error('DB down'); } }), 0);
});
test('TC-165-02 negative control: balanced extra transactions must fail cardinality', () => {
  assert.doesNotThrow(() => assertDuplicateCounts({ transfers: 3, entries: 6, keys: 3, badKeys: 0 }, 3));
  assert.throws(() => assertDuplicateCounts({ transfers: 4, entries: 8, keys: 3, badKeys: 0 }, 3), /cardinality/i);
  assert.throws(() => assertDuplicateCounts({ transfers: 3, entries: 6, keys: 3, badKeys: 1 }, 3), /cardinality/i);
  assert.throws(() => assertDuplicateCounts({ transfers: 0, entries: 0, keys: 0, badKeys: 0 }, 0), /cardinality/i);
});
