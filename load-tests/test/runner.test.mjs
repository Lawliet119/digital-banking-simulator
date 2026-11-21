import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { runChecked } = require("../run.cjs");
const { assertDuplicateCounts } = require("../postflight.cjs");

test("TC-165-05 runner preserves k6 failure and still calls checker", async () => {
  const calls = [];
  const result = await runChecked({
    load: () => {
      calls.push("k6");
      return 99;
    },
    check: () => {
      calls.push("checker");
      return 0;
    },
  });
  assert.equal(result, 99);
  assert.deepEqual(calls, ["k6", "checker"]);
});
test("TC-165-05 runner fails on a thrown load error or checker error", async () => {
  let checked = false;
  assert.notEqual(
    await runChecked({
      load: () => {
        throw new Error("offline");
      },
      check: () => {
        checked = true;
        return 0;
      },
    }),
    0,
  );
  assert(checked);
  assert.equal(await runChecked({ load: () => 0, check: () => 2 }), 2);
  assert.notEqual(
    await runChecked({
      load: () => 0,
      check: () => {
        throw new Error("DB down");
      },
    }),
    0,
  );
});
test("TC-165-02 negative control: balanced extra transactions must fail cardinality", () => {
  assert.doesNotThrow(() =>
    assertDuplicateCounts({ transfers: 3, entries: 6, keys: 3, badKeys: 0 }, 3),
  );
  assert.throws(
    () =>
      assertDuplicateCounts(
        { transfers: 4, entries: 8, keys: 3, badKeys: 0 },
        3,
      ),
    /cardinality/i,
  );
  assert.throws(
    () =>
      assertDuplicateCounts(
        { transfers: 3, entries: 6, keys: 3, badKeys: 1 },
        3,
      ),
    /cardinality/i,
  );
  assert.throws(
    () =>
      assertDuplicateCounts(
        { transfers: 0, entries: 0, keys: 0, badKeys: 0 },
        0,
      ),
    /cardinality/i,
  );
});

// DBS-166 (TC-166-10..12): `backend/test/support/invariants.ts` chỉ re-export từ BL-128, nên chạy nó thoát 0 mà không
// in gì. Runner phải chạy CLI thật và chỉ nhận PASS khi thoát 0 kèm báo cáo PASS trên stdout.
const { checkerExit, checkerFile } = require("../run.cjs");

test("TC-166-10 runner runs the real checker CLI, not the re-export", async () => {
  const { readFileSync } = await import("node:fs");
  assert.match(checkerFile.replaceAll("\\", "/"), /backend\/src\/scripts\/invariants\/invariants\.ts$/);
  assert.match(readFileSync(checkerFile, "utf8"), /require\.main === module/);
  assert.doesNotMatch(readFileSync(new URL("../run.cjs", import.meta.url), "utf8"), /test\/support\/invariants/);
});
test("TC-166-11 silent exit 0 is not a pass (negative control for the re-export)", () => {
  assert.equal(checkerExit({ status: 0, stdout: "", stderr: "" }), 2);
  assert.equal(checkerExit({ status: 0, stdout: "banner only\n", stderr: "" }), 2);
  assert.equal(checkerExit({ status: 0, stdout: '{"status":"FAIL"}\n', stderr: "" }), 2);
});
test("TC-166-12 exit code mapping keeps violation and error codes", () => {
  assert.equal(checkerExit({ status: 0, stdout: '{"status":"PASS","totals":{}}\n', stderr: "" }), 0);
  assert.equal(checkerExit({ status: 1, stdout: '{"status":"FAIL"}\n', stderr: "" }), 1);
  assert.equal(checkerExit({ status: 2, stdout: "", stderr: "CHECK_ERROR" }), 2);
  assert.equal(checkerExit({ status: null, stdout: "", stderr: "" }), 2);
  assert.equal(checkerExit({ status: 0, stdout: 'x\n{"status":"PASS"}\n', stderr: "" }), 0);
});
