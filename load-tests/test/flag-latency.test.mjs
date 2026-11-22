import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const lib = require("../lib/flag-latency.cjs");
const cli = require("../flag-latency.cjs");
const CLI = resolve(import.meta.dirname, "../flag-latency.cjs");

// DBS-174 TC-174-01..: windows from aggregate.json, explicit windows, measure loop with a fake pg client.

// Real layout of `baseline`: k6 starts plateau i at i * (900 + 10) s, so plateaus are 10 s apart, not back to back.
const T0 = Date.parse("2026-11-22T10:00:00.000Z");
const at = (s) => new Date(T0 + s * 1000).toISOString();
const aggregate = {
  window: { start: at(0), end: at(1820 + 899) },
  plateaus: {
    120: { windowSeconds: 899, startedAt: at(1820), endedAt: at(1820 + 899) },
    12: { windowSeconds: 899, startedAt: at(0.5), endedAt: at(899.5) },
    60: { windowSeconds: 899, startedAt: at(910.2), endedAt: at(1809.2) },
  },
};

test("TC-174-01 plateauWindows takes the real start/end of each plateau, in rate order, and keeps the 10 s gaps out", () => {
  const w = lib.plateauWindows(aggregate);
  assert.deepEqual(w.map((x) => x.label), ["12rps", "60rps", "120rps"]);
  assert.equal(w[0].from, at(0.5));
  assert.equal(w[2].to, new Date(T0 + (1820 + 899) * 1000 + 1).toISOString()); // half-open: last request + 1 ms
  // The 10 s between plateau 12 and plateau 60 belong to no window.
  assert.ok(Date.parse(w[1].from) - Date.parse(w[0].to) >= 10_000);
  assert.ok(Date.parse(w[2].from) - Date.parse(w[1].to) >= 10_000);
});

test("TC-174-02 an old aggregate.json without startedAt/endedAt is chained from window.start with the 10 s gap, not back to back", () => {
  const old = {
    window: { start: at(0), end: at(2720) },
    plateaus: { 120: { windowSeconds: 900 }, 12: { windowSeconds: 900 }, 60: { windowSeconds: 900 } },
  };
  const w = lib.plateauWindows(old);
  assert.deepEqual(w.map((x) => x.label), ["12rps", "60rps", "120rps"]);
  assert.equal(w[0].from, at(0));
  assert.equal(w[1].from, at(910));
  assert.equal(w[2].from, at(1820));
  assert.deepEqual(lib.plateauWindows({ window: { start: at(0) }, plateaus: {} }), []);
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

// Fake pg client: answers by the SQL text, counting undecided calls to simulate the worker catching up.
function fakeClient({ undecidedSequence = [0], summary, minutes = [], modes = [], sources = [], deposits = 0 }) {
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
      if (sql.includes("type = 'DEPOSIT'")) return { rows: [{ deposits }] };
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
const W = { label: "120rps", from: "2026-11-22T10:00:00.000Z", to: "2026-11-22T10:15:00.000Z" };

test("TC-174-04 measureWindow maps rows to p50/p95/p99, SLO verdict, modes, per-minute, deposits and anonymised source rows", async () => {
  const client = fakeClient({
    summary,
    deposits: 3,
    modes: [{ mode: "rule_only", ai_status: "DISABLED", n: 100 }],
    minutes: [{ minute: 0, transfers: 50, decided: 50, flagged: 20, decision_p95: 400, decision_max: 800, flag_p95: 410 }],
    sources: [
      { account: "0b7e2d5e-0000-4000-8000-000000000002", rows: 30 },
      { account: "0b7e2d5e-0000-4000-8000-000000000001", rows: 9000 },
    ],
  });
  const w = await lib.measureWindow(client, W);
  assert.deepEqual(w.decisionLagMs, { p50: 120.12, p95: 480.56, p99: 900, max: 1500, mean: 200.1 });
  assert.equal(w.flagLagMs.p95, 500);
  assert.equal(w.decisionP95UnderSlo, true);
  assert.equal(w.flagP95UnderSlo, true);
  assert.equal(w.undecided, 0);
  assert.equal(w.flagged, 40);
  assert.equal(w.deposits, 3);
  assert.deepEqual(w.modes, [{ mode: "rule_only", aiStatus: "DISABLED", decisions: 100 }]);
  assert.equal(w.perMinute[0].flagP95Ms, 410);
  // Labels follow the sorted account id, so ...0001 is nguon-1 even though it has more rows.
  assert.deepEqual(w.sourceAccountRows30d, [
    { source: "nguon-1", rows30d: 9000 },
    { source: "nguon-2", rows30d: 30 },
  ]);
  assert.ok(!JSON.stringify(w).includes("0b7e2d5e"), "account ids must not reach the report");
  for (const call of client.seen) assert.deepEqual(call.params, [W.from, W.to]);
});

test("TC-174-05 a p95 of exactly 5000 ms is not under the SLO, and no flags gives null percentiles (not zero)", async () => {
  const noFlags = { ...summary, flagged: 0, flag_pct: null, flag_max: null, flag_avg: null, decision_pct: [10, 5000, 6000] };
  const w = await lib.measureWindow(fakeClient({ summary: noFlags }), W);
  assert.equal(w.decisionP95UnderSlo, false);
  assert.deepEqual(w.flagLagMs, { p50: null, p95: null, p99: null, max: null, mean: null });
  assert.equal(w.flagP95UnderSlo, null);
});

test("TC-174-06 measure waits for the worker to drain, then reports no backlog", async () => {
  let clock = 0;
  const waits = [];
  const client = fakeClient({ undecidedSequence: [30, 12, 0], summary });
  const report = await lib.measure(client, [W], {
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

test("TC-174-07 measure gives up after the settle time, reports the backlog and refuses to call the p95 conclusive", async () => {
  let clock = 0;
  const client = fakeClient({ undecidedSequence: [500], summary: { ...summary, decided: 60 } });
  const report = await lib.measure(client, [W], {
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
  // 60 of 100 decided: the percentile covers only the decided part, so no verdict (null), never "true".
  assert.equal(report.windows[0].decisionP95UnderSlo, null);
  assert.equal(report.windows[0].flagP95UnderSlo, null);
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

test("TC-174-09 windowsOf: plateaus then the whole run; a run without plateaus (hot-account) is measured as one run window", () => {
  const w = cli.windowsOf(aggregate);
  assert.deepEqual(w.map((x) => x.label), ["12rps", "60rps", "120rps", "run"]);
  assert.equal(w[3].from, at(0));
  assert.equal(w[3].to, new Date(T0 + (1820 + 899) * 1000 + 1).toISOString());
  const hot = { window: { start: at(0), end: at(900) }, plateaus: {} };
  assert.deepEqual(cli.windowsOf(hot).map((x) => x.label), ["run"]);
  assert.deepEqual(cli.windowsOf({ plateaus: {} }), []);
});

test("TC-174-10 CLI writes skipped and exits 0, without touching the database, when aggregate.json has no time window", () => {
  const dir = mkdtempSync(join(tmpdir(), "flag-latency-"));
  writeFileSync(join(dir, "aggregate.json"), JSON.stringify({ plateaus: {} }));
  const run = spawnSync(process.execPath, [CLI, dir], { encoding: "utf8", env: { ...process.env, DATABASE_URL: "" } });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /bỏ qua/);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "flag-latency.json"), "utf8")), { skipped: "no-window" });
});

test("TC-174-11 CLI exits 2 with a clear message when there is neither aggregate.json nor --window", () => {
  const dir = mkdtempSync(join(tmpdir(), "flag-latency-"));
  const run = spawnSync(process.execPath, [CLI, dir], { encoding: "utf8" });
  assert.equal(run.status, 2);
  assert.match(run.stderr, /không có .*aggregate\.json/);
});

test("TC-174-12 source labels stay the same across windows of one run: the same account is nguon-N in every window", async () => {
  const a = "00000000-0000-4000-8000-00000000000a";
  const b = "00000000-0000-4000-8000-00000000000b";
  const rowsByCall = [
    [{ account: b, rows: 5000 }], // window 1 only sees b
    [{ account: a, rows: 100 }, { account: b, rows: 9000 }], // window 2 sees both
  ];
  let call = 0;
  const client = fakeClient({ summary });
  const base = client.query.bind(client);
  client.query = async (sql, params) => (sql.includes("GROUP BY 1 ORDER BY 2 DESC") ? { rows: rowsByCall[call++] } : base(sql, params));
  const report = await lib.measure(client, [W, { ...W, label: "later" }], { settleSeconds: 0 });
  assert.deepEqual(report.windows[0].sourceAccountRows30d, [{ source: "nguon-2", rows30d: 5000 }]);
  assert.deepEqual(report.windows[1].sourceAccountRows30d, [
    { source: "nguon-1", rows30d: 100 },
    { source: "nguon-2", rows30d: 9000 },
  ]);
});

test("TC-174-13 undecided is the worst window, not the sum: the run window contains the plateaus and must not double count", async () => {
  const client = fakeClient({ undecidedSequence: [7], summary });
  const report = await lib.measure(client, [W, { ...W, label: "run" }], { settleSeconds: 0 });
  assert.equal(report.undecidedAfterSettle, 7);
});
