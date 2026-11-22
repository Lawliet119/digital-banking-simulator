import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lib = require("../lib/flag-latency.cjs");
const cli = require("../flag-latency.cjs");
const CLI = resolve(import.meta.dirname, "../flag-latency.cjs");

// DBS-174 TC-174-01..: windows from aggregate.json, explicit windows, measure loop with a fake pg client.

const aggregate = {
  window: { start: "2026-11-22T10:00:00.000Z", end: "2026-11-22T10:46:00.000Z" },
  plateaus: { 120: { windowSeconds: 900 }, 12: { windowSeconds: 899.998 }, 60: { windowSeconds: 900.03 } },
};

test("TC-174-01 plateauWindows chains the plateaus from window.start in rate order, not key insertion order", () => {
  const w = lib.plateauWindows(aggregate);
  assert.deepEqual(w.map((x) => x.label), ["12rps", "60rps", "120rps"]);
  assert.equal(w[0].from, "2026-11-22T10:00:00.000Z");
  assert.equal(w[0].to, w[1].from);
  assert.equal(w[1].to, w[2].from);
  assert.equal(Date.parse(w[2].to) - Date.parse(w[0].from), 899998 + 900030 + 900000);
});

test("TC-174-02 plateauWindows returns nothing for a run without plateaus or without a start", () => {
  assert.deepEqual(lib.plateauWindows({ window: { start: "2026-11-22T10:00:00Z" }, plateaus: {} }), []);
  assert.deepEqual(lib.plateauWindows({ plateaus: { 120: { windowSeconds: 900 } } }), []);
  assert.deepEqual(lib.plateauWindows({ window: { start: "x" }, plateaus: { 120: { windowSeconds: 900 } } }), []);
  assert.deepEqual(lib.plateauWindows(null), []);
});

test("TC-174-03 parseWindow accepts label=from,to and refuses an empty or reversed window", () => {
  assert.deepEqual(lib.parseWindow("p120=2026-11-22T10:00:00Z,2026-11-22T10:15:00Z"), {
    label: "p120",
    from: "2026-11-22T10:00:00.000Z",
    to: "2026-11-22T10:15:00.000Z",
  });
  assert.throws(() => lib.parseWindow("p=2026-11-22T10:15:00Z,2026-11-22T10:00:00Z"), /không hợp lệ/);
  assert.throws(() => lib.parseWindow("p=2026-11-22T10:00:00Z,2026-11-22T10:00:00Z"), /không hợp lệ/);
  assert.throws(() => lib.parseWindow("nope"), /không hợp lệ/);
});

// Fake pg client: answers by the first words of the SQL, counting undecided calls to simulate the worker catching up.
function fakeClient({ undecidedSequence, summary, minutes = [], modes = [], sources = [] }) {
  const seen = [];
  let undecidedCalls = 0;
  return {
    seen,
    async query(sql, params) {
      seen.push({ sql, params });
      if (sql.includes("NOT EXISTS (SELECT 1 FROM risk_decisions")) {
        const n = undecidedSequence[Math.min(undecidedCalls++, undecidedSequence.length - 1)];
        return { rows: [{ undecided: n }] };
      }
      if (sql.includes("percentile_cont(ARRAY[0.5, 0.95, 0.99])")) return { rows: [summary] };
      if (sql.includes("GROUP BY mode, ai_status")) return { rows: modes };
      if (sql.includes("floor(EXTRACT(EPOCH")) return { rows: minutes };
      if (sql.includes("GROUP BY 1 ORDER BY 2 DESC")) return { rows: sources };
      throw new Error(`unexpected SQL: ${sql.slice(0, 60)}`);
    },
  };
}

const summary = {
  transfers: 100,
  decided: 100,
  flagged: 40,
  decision_pct: [120.123, 480.555, 900],
  decision_max: 1500,
  decision_avg: 200.1,
  flag_pct: [130, 500, 950],
  flag_max: 1600,
  flag_avg: 210,
};

test("TC-174-04 measureWindow maps rows to p50/p95/p99, SLO verdict, modes, per-minute and anonymised source rows", async () => {
  const client = fakeClient({
    undecidedSequence: [0],
    summary,
    modes: [{ mode: "rule_only", ai_status: "DISABLED", n: 100 }],
    minutes: [{ minute: 0, transfers: 50, decided: 50, flagged: 20, decision_p95: 400, decision_max: 800, flag_p95: 410 }],
    sources: [
      { account: "0b7e2d5e-0000-4000-8000-000000000001", rows: 9000 },
      { account: "0b7e2d5e-0000-4000-8000-000000000002", rows: 30 },
    ],
  });
  const w = await lib.measureWindow(client, { label: "120rps", from: "2026-11-22T10:00:00.000Z", to: "2026-11-22T10:15:00.000Z" });
  assert.deepEqual(w.decisionLagMs, { p50: 120.12, p95: 480.56, p99: 900, max: 1500, mean: 200.1 });
  assert.equal(w.flagLagMs.p95, 500);
  assert.equal(w.decisionP95UnderSlo, true);
  assert.equal(w.flagP95UnderSlo, true);
  assert.equal(w.undecided, 0);
  assert.equal(w.flagged, 40);
  assert.deepEqual(w.modes, [{ mode: "rule_only", aiStatus: "DISABLED", decisions: 100 }]);
  assert.equal(w.perMinute[0].flagP95Ms, 410);
  assert.deepEqual(w.sourceAccountRows30d, [
    { source: "nguon-1", rows30d: 9000 },
    { source: "nguon-2", rows30d: 30 },
  ]);
  assert.ok(!JSON.stringify(w).includes("0b7e2d5e"), "account ids must not reach the report");
  for (const call of client.seen) assert.deepEqual(call.params, ["2026-11-22T10:00:00.000Z", "2026-11-22T10:15:00.000Z"]);
});

test("TC-174-05 a p95 of exactly 5000 ms is not under the SLO, and no flags gives null percentiles (not zero)", async () => {
  const noFlags = { ...summary, flagged: 0, flag_pct: null, flag_max: null, flag_avg: null, decision_pct: [10, 5000, 6000] };
  const w = await lib.measureWindow(fakeClient({ undecidedSequence: [0], summary: noFlags }), {
    label: "x",
    from: "2026-11-22T10:00:00.000Z",
    to: "2026-11-22T10:15:00.000Z",
  });
  assert.equal(w.decisionP95UnderSlo, false);
  assert.deepEqual(w.flagLagMs, { p50: null, p95: null, p99: null, max: null, mean: null });
  assert.equal(w.flagP95UnderSlo, null);
});

test("TC-174-06 measure waits for the worker to drain, then reports no backlog", async () => {
  let clock = 0;
  const waits = [];
  const client = fakeClient({ undecidedSequence: [30, 12, 0], summary });
  const report = await lib.measure(client, [{ label: "a", from: "2026-11-22T10:00:00.000Z", to: "2026-11-22T10:15:00.000Z" }], {
    settleSeconds: 120,
    pollMs: 5000,
    sleep: async (ms) => {
      waits.push(ms);
      clock += ms;
    },
    now: () => clock,
  });
  assert.deepEqual(waits, [5000, 5000]);
  assert.equal(report.undecidedAfterSettle, 0);
  assert.equal(report.backlog, false);
  assert.equal(report.settledAfterSeconds, 10);
});

test("TC-174-07 measure gives up after the settle time and reports the backlog instead of hiding it", async () => {
  let clock = 0;
  const client = fakeClient({ undecidedSequence: [500], summary: { ...summary, decided: 60 } });
  const report = await lib.measure(client, [{ label: "a", from: "2026-11-22T10:00:00.000Z", to: "2026-11-22T10:15:00.000Z" }], {
    settleSeconds: 20,
    pollMs: 5000,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
  });
  assert.equal(report.backlog, true);
  assert.equal(report.undecidedAfterSettle, 500);
  assert.equal(report.windows[0].undecided, 40);
});

test("TC-174-08 parseArgs: directory, --settle, repeated --window; refuses unknown flags and a missing directory", () => {
  const a = cli.parseArgs(["out", "--settle", "30", "--window", "a=2026-11-22T10:00:00Z,2026-11-22T10:15:00Z"]);
  assert.equal(a.dir, "out");
  assert.equal(a.settle, 30);
  assert.equal(a.windows.length, 1);
  assert.throws(() => cli.parseArgs([]), /thiếu thư mục/);
  assert.throws(() => cli.parseArgs(["out", "--bogus"]), /cờ không biết/);
  assert.throws(() => cli.parseArgs(["out", "--settle", "-1"]), /--settle/);
  assert.throws(() => cli.parseArgs(["out", "extra"]), /thừa đối số/);
});

test("TC-174-09 CLI exits 0 without touching the database when the run has no plateau (duplicate, rate-limit)", () => {
  const dir = mkdtempSync(join(tmpdir(), "flag-latency-"));
  writeFileSync(join(dir, "aggregate.json"), JSON.stringify({ window: { start: "2026-11-22T10:00:00Z" }, plateaus: {} }));
  const run = spawnSync(process.execPath, [CLI, dir], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /không có plateau/);
});

test("TC-174-10 CLI exits 2 with a clear message when there is neither aggregate.json nor --window", () => {
  const dir = mkdtempSync(join(tmpdir(), "flag-latency-"));
  const run = spawnSync(process.execPath, [CLI, dir], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /không có .*aggregate\.json/);
});
