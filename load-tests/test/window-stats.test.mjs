import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const stats = require("../window-stats.cjs");
const CLI = resolve(import.meta.dirname, "../window-stats.cjs");
const T0 = 1_800_000_000_000;
const s = (n) => T0 + n * 1000;

// One request per second per class from 0 to 899 s; `fn(second, name)` returns [status, duration_ms].
function rows(fn) {
  const out = [];
  for (let t = 0; t < 900; t++) {
    for (const name of [
      "POST /v1/transfers",
      "GET /v1/accounts/:id",
      "GET /v1/accounts/:id/transactions",
    ]) {
      const [status, duration] = fn(t, name);
      out.push({ epoch_ms: s(t), scenario: name.startsWith("POST") ? "write_120" : "read_120", name, status, duration_ms: duration });
    }
  }
  return out;
}
const healthy = (from = 0, to = 900) =>
  Array.from({ length: to - from }, (_, i) => ({ epoch_ms: s(from + i), code: 200, redis: "up" }));
const slowEvents = [
  { epoch_ms: s(300), action: "slow_start", mode: "slow", pause_ms: 100, period_ms: 200 },
  { epoch_ms: s(450), action: "slow_step", mode: "slow", pause_ms: 180, period_ms: 200 },
  { epoch_ms: s(600), action: "slow_end", mode: "slow" },
];
const downEvents = [
  { epoch_ms: s(300), action: "down", mode: "down" },
  { epoch_ms: s(600), action: "restore", mode: "down" },
];

test("TC-167-02 windows split the run at the fault events and percentiles are per window and per operation", () => {
  const r = rows((t, name) => {
    if (name.startsWith("POST")) return [201, t < 300 ? 100 : t < 450 ? 180 : t < 600 ? 250 : 120];
    return [200, t >= 300 && t < 600 ? 90 : 40];
  });
  const out = stats.analyze({ rows: r, events: slowEvents, health: healthy(), mode: "slow", exit: { runExit: 0, invariantExit: 0 } });
  const w = Object.fromEntries(out.windows.map((x) => [x.name, x]));
  assert.deepEqual(out.windows.map((x) => x.name), ["pre", "fault_light", "fault_heavy", "recovery", "after"]);
  assert.equal(w.pre.requests, 240 * 3); // +60 s .. 300 s, three operations per second
  assert.equal(w.fault_light.transfer.p95, 180);
  assert.equal(w.fault_heavy.transfer.p95, 250);
  assert.equal(w.recovery.requests, 60 * 3);
  assert.equal(w.after.transfer.p95, 120);
  assert.equal(w.fault_heavy.balance.p95, 90);
  assert.equal(w.pre.history.p95, 40);
  assert.equal(w.pre.read.p95, 40);
});

test("TC-167-02 4xx are not system errors, 5xx, status 0 and 429 are", () => {
  const r = rows((t, name) => {
    if (name.startsWith("POST") && t === 100) return [422, 50];
    if (name.startsWith("POST") && t === 320) return [503, 50];
    if (name.startsWith("POST") && t === 321) return [0, 2000];
    if (name.startsWith("POST") && t === 322) return [429, 50];
    return [name.startsWith("POST") ? 201 : 200, 50];
  });
  const out = stats.analyze({ rows: r, events: downEvents, health: healthy(), mode: "down", exit: { runExit: 0, invariantExit: 0 } });
  const w = Object.fromEntries(out.windows.map((x) => [x.name, x]));
  assert.equal(w.pre.systemErrors, 0);
  assert.equal(w.pre.clientErrors, 1);
  assert.equal(w.fault.systemErrors, 3);
});

test("TC-167-02 control run uses the nominal windows 300 to 600 s from the first request", () => {
  const out = stats.analyze({ rows: rows(() => [200, 50]), events: [], health: healthy(), mode: "none", exit: { runExit: 0, invariantExit: 0 } });
  assert.deepEqual(out.windows.map((x) => x.name), ["pre", "fault_nominal", "recovery", "after"]);
  assert.equal(out.windows[1].requests, 300 * 3);
});

test("TC-167-03 a window over the SLO is reported as an SLO violation and a BL", () => {
  const r = rows((t, name) => (name.startsWith("POST") ? [201, t >= 300 && t < 600 ? 320 : 100] : [200, 40]));
  const out = stats.analyze({ rows: r, events: downEvents, health: healthy(), mode: "down", exit: { runExit: 0, invariantExit: 0 } });
  assert.equal(out.verdict.classification, "vượt SLO");
  assert.ok(out.verdict.violations.some((v) => v.window === "fault" && v.metric === "transfer.p95"));
  assert.ok(out.verdict.openBl.length > 0);
});

test("TC-167-03 a slowdown inside the SLO and inside the allowance is acceptable", () => {
  const r = rows((t, name) => (name.startsWith("POST") ? [201, t >= 300 && t < 450 ? 160 : t >= 450 && t < 600 ? 190 : 100] : [200, 40]));
  const out = stats.analyze({ rows: r, events: slowEvents, health: healthy(), mode: "slow", exit: { runExit: 0, invariantExit: 0 } });
  assert.equal(out.verdict.classification, "đạt, xấu đi trong mức chấp nhận");
  assert.deepEqual(out.verdict.violations, []);
});

test("TC-167-03 a slowdown over the allowance (100 ms for slow) is flagged even if the SLO holds", () => {
  const r = rows((t, name) => (name.startsWith("POST") ? [201, t >= 450 && t < 600 ? 230 : 100] : [200, 40]));
  const out = stats.analyze({ rows: r, events: slowEvents, health: healthy(), mode: "slow", exit: { runExit: 0, invariantExit: 0 } });
  assert.equal(out.verdict.classification, "phải mở BL");
  assert.ok(out.verdict.degradation.some((d) => d.window === "fault_heavy" && d.delta === 130 && d.allowed === 100));
});

test("TC-167-03 /health/ready other than 200, a 5xx, a failed invariant or a late recovery each require a BL", () => {
  const base = rows(() => [200, 50]);
  const bad = healthy();
  bad[400] = { epoch_ms: s(400), code: 503, redis: "degraded" };
  let out = stats.analyze({ rows: base, events: downEvents, health: bad, mode: "down", exit: { runExit: 0, invariantExit: 0 } });
  assert.ok(out.verdict.openBl.some((x) => /health/.test(x)));

  out = stats.analyze({ rows: base, events: downEvents, health: healthy(), mode: "down", exit: { runExit: 0, invariantExit: 2 } });
  assert.equal(out.verdict.classification, "blocker: bất biến");

  // Redis is reported "up" again only 90 s after the restore
  const late = healthy().map((h) => (h.epoch_ms >= s(600) && h.epoch_ms < s(690) ? { ...h, redis: "degraded" } : h));
  out = stats.analyze({ rows: base, events: downEvents, health: late, mode: "down", exit: { runExit: 0, invariantExit: 0 } });
  assert.equal(out.recoverySeconds, 90);
  assert.ok(out.verdict.openBl.some((x) => /60 s/.test(x)));

  const five = rows((t, name) => (name.startsWith("POST") && t === 350 ? [500, 80] : [name.startsWith("POST") ? 201 : 200, 50]));
  out = stats.analyze({ rows: five, events: downEvents, health: healthy(), mode: "down", exit: { runExit: 0, invariantExit: 0 } });
  assert.ok(out.verdict.openBl.some((x) => /5xx/.test(x)));
});

test("TC-167-03 noise from the control run widens the allowance of the down run", () => {
  const control = stats.analyze({
    rows: rows((t, name) => (name.startsWith("POST") ? [201, 100 + (t % 100 < 50 ? 0 : 30)] : [200, 40])),
    events: [],
    health: healthy(),
    mode: "none",
    exit: { runExit: 0, invariantExit: 0 },
  });
  assert.equal(stats.noiseMs(control), 0); // the bucket pattern is identical in every window
  const wide = { windows: [{ requests: 900, transfer: { p95: 100 } }, { requests: 900, transfer: { p95: 150 } }, { requests: 10, transfer: { p95: 999 } }] };
  assert.equal(stats.noiseMs(wide), 50); // windows under 500 requests do not count
});

test("TC-167-04 CLI fails (exit 2, no verdict) when the fault run has no fault-events or health file", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ws-"));
  writeFileSync(join(dir, "requests.csv.gz"), gzipSync("epoch_ms,scenario,name,status,duration_ms\n" + `${T0},write_120,POST /v1/transfers,201,100\n`));
  writeFileSync(join(dir, "exit.json"), JSON.stringify({ runExit: 0, invariantExit: 0 }));
  const run = (args) =>
    new Promise((res) => {
      const p = spawn(process.execPath, [CLI, dir, ...args], { stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("close", (code) => res({ code, out }));
    });
  const missing = await run(["--mode", "down"]);
  assert.equal(missing.code, 2);
  assert.doesNotMatch(missing.out, /đạt/);
  assert.ok(!existsSync(join(dir, "windows.json")));
  // the control run needs neither file
  const control = await run(["--mode", "none"]);
  assert.equal(control.code, 0);
  assert.ok(existsSync(join(dir, "windows.json")));
  assert.equal(JSON.parse(readFileSync(join(dir, "windows.json"), "utf8")).mode, "none");
});
