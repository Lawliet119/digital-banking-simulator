import test from "node:test";
import assert from "node:assert/strict";
import {
  workload,
  validateFixture,
  requireBudget,
  sameCompletedBodies,
} from "../lib/config.js";

test("TC-165-01 baseline measures each plateau and each read route at 80/20 for 15 minutes", () => {
  const plan = workload("baseline");
  for (const rate of [12, 60, 120]) {
    const read = plan.scenarios[`read_${rate}`],
      write = plan.scenarios[`write_${rate}`];
    assert.equal(read.rate + write.rate, rate * 5);
    assert.equal(read.rate / write.rate, 4);
    assert.equal(read.duration, "900s");
    for (const operation of ["balance", "history"]) {
      assert.deepEqual(
        plan.thresholds[`read_latency{plateau:${rate},operation:${operation}}`],
        ["p(95)<150"],
      );
    }
    assert.deepEqual(plan.thresholds[`transfer_latency{plateau:${rate}}`], [
      "p(95)<300",
      "p(99)<1000",
    ]);
  }
  assert.deepEqual(plan.thresholds.system_errors, ["rate<0.001"]);
  assert.deepEqual(plan.thresholds.dropped_iterations, ["count==0"]);
  assert(!plan.systemTags.includes("url"));
  assert(!plan.systemTags.includes("error"));
});

test("TC-165-01 smoke keeps NFR thresholds and labels actual reduced rate", () => {
  const p = workload("baseline", true);
  assert.equal(p.scenarios.read_5.rate + p.scenarios.write_5.rate, 25);
  assert.equal(p.scenarios.read_5.tags.profile, "smoke");
  assert.deepEqual(p.thresholds["transfer_latency{plateau:5}"], [
    "p(95)<300",
    "p(99)<1000",
  ]);
});

test("TC-165-02 hot is 20/s; stress exceeds120; duplicate uses10 simultaneous calls", () => {
  assert.equal(workload("hot-account").scenarios.hot.rate, 20);
  assert.equal(workload("hot-account").scenarios.hot.duration, "900s");
  assert.deepEqual(workload("hot-account").thresholds.transfer_latency, [
    "p(95)<1000",
  ]);
  assert.equal(workload("stress").scenarios.write_240.rate, 240);
  assert.equal(workload("duplicate").batchPerHost, 10);
  assert.equal(workload("rate-limit").scenarios.boundary.iterations, 1);
});

test("TC-165-06 malformed fixture/target/token is rejected before load", () => {
  assert.throws(() => validateFixture({}, "http://localhost:3000"), /fixture/i);
  assert.throws(() => workload("unknown"), /scenario/i);
});

test("TC-165-02 preflight refuses insufficient balance or remaining daily limit", () => {
  const row = { balance: "18000000", spent: "182000000" };
  assert.doesNotThrow(() => requireBudget(row, 18000));
  assert.throws(
    () => requireBudget({ ...row, balance: "17999999" }, 18000),
    /budget/i,
  );
  assert.throws(
    () => requireBudget({ ...row, spent: "182000001" }, 18000),
    /budget/i,
  );
});

test("TC-165-02 duplicate compares JSON semantics despite jsonb key order", () => {
  assert(
    sameCompletedBodies([
      { transferId: "a", status: "COMPLETED" },
      { status: "COMPLETED", transferId: "a" },
    ]),
  );
  assert(
    !sameCompletedBodies([
      { transferId: "a", status: "COMPLETED" },
      { status: "COMPLETED", transferId: "b" },
    ]),
  );
  assert(
    !sameCompletedBodies([
      { transferId: "a", status: "COMPLETED" },
      { status: "COMPLETED", transferId: "a", leaked: true },
    ]),
  );
});
