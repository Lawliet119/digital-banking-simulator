import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { gzipSync } from "node:zlib";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const require = createRequire(import.meta.url);
const { percentile, aggregateLines } = require("../aggregate-raw.cjs");

const T0 = Date.parse("2026-11-21T10:00:00.000Z");
const point = (metric, value, tags = {}, offsetMs = 0) =>
  JSON.stringify({
    type: "Point",
    metric,
    data: { time: new Date(T0 + offsetMs).toISOString(), value, tags },
  });
const http = (value, scenario, name, status, offsetMs) =>
  point(
    "http_req_duration",
    value,
    { scenario, name, status: String(status), method: "POST", expected_response: String(status < 400) },
    offsetMs,
  );

// TC-166-04: phân vị tuyến tính như k6, ca biên rỗng/một phần tử, đúng thứ tự không phụ thuộc đầu vào.
test("percentile: linear interpolation, bounds and unsorted input", () => {
  assert.equal(percentile([], 95), null);
  assert.equal(percentile([7], 99), 7);
  assert.equal(percentile([10, 20, 30, 40], 50), 25);
  assert.equal(percentile([40, 10, 30, 20], 0), 10);
  assert.equal(percentile([40, 10, 30, 20], 100), 40);
  const hundred = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.ok(Math.abs(percentile(hundred, 95) - 95.05) < 1e-9);
});

// TC-166-05: gộp theo scenario và tên request, đếm lỗi hệ thống theo status (5xx và 0), 422/429 là nghiệp vụ.
test("aggregateLines groups by scenario and name and counts system errors", async () => {
  const lines = [
    http(100, "write_12", "POST /v1/transfers", 201, 0),
    http(200, "write_12", "POST /v1/transfers", 201, 1000),
    http(300, "write_12", "POST /v1/transfers", 500, 61000),
    http(50, "read_12", "GET /v1/accounts/:id", 200, 500),
    http(60, "read_12", "GET /v1/accounts/:id", 429, 700),
    http(70, "read_12", "GET /v1/accounts/:id", 422, 800),
    point("system_errors", 0, {}, 0),
    point("system_errors", 1, {}, 61000),
    point("transfer_latency", 100, { plateau: "12" }, 0),
    "",
    "not json",
  ];
  const agg = await aggregateLines(lines);
  const w = agg.byScenario.write_12["POST /v1/transfers"];
  assert.equal(w.count, 3);
  assert.equal(w.systemErrors, 1);
  assert.deepEqual(w.status, { 201: 2, 500: 1 });
  assert.equal(w.p50, 200);
  assert.equal(w.max, 300);
  const r = agg.byScenario.read_12["GET /v1/accounts/:id"];
  assert.equal(r.systemErrors, 1); // 429 ngoài bài rate-limit là lỗi hạ tầng (review #2); 422 là nghiệp vụ
  assert.deepEqual(r.status, { 200: 1, 422: 1, 429: 1 });
  assert.equal(agg.skippedLines, 1);
  assert.equal(agg.systemErrors.total, 2);
  assert.equal(agg.systemErrors.errors, 1);
  assert.equal(agg.systemErrors.rate, 0.5);
  assert.equal(agg.metrics.transfer_latency["plateau=12"].count, 1);
  // hai phút khác nhau cho write_12: phút 0 có 2 điểm, phút 1 có 1 điểm lỗi
  const minutes = agg.perMinute.filter((m) => m.scenario === "write_12");
  assert.deepEqual(
    minutes.map((m) => [m.minute, m.count, m.systemErrors]),
    [
      [0, 2, 0],
      [1, 1, 1],
    ],
  );
});

// TC-166-06: status 0 (timeout, kết nối đứt) là lỗi hệ thống, không được coi là nghiệp vụ.
test("status 0 counts as a system error", async () => {
  const agg = await aggregateLines([http(2000, "hot", "POST /v1/transfers", 0, 0)]);
  assert.equal(agg.byScenario.hot["POST /v1/transfers"].systemErrors, 1);
});

// TC-166-07: CLI đọc raw.json hoặc raw.json.gz và ghi aggregate.json, per-minute.json cạnh đầu vào.
test("CLI writes aggregate files from plain and gzipped raw", () => {
  for (const gz of [false, true]) {
    const dir = mkdtempSync(join(tmpdir(), "agg-"));
    const body = [http(10, "w", "POST /v1/transfers", 201, 0), http(30, "w", "POST /v1/transfers", 201, 10)].join("\n") + "\n";
    writeFileSync(join(dir, gz ? "raw.json.gz" : "raw.json"), gz ? gzipSync(body) : body);
    const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "aggregate-raw.cjs"), dir], {
      encoding: "utf8",
    });
    assert.equal(r.status, 0, r.stderr);
    const agg = JSON.parse(readFileSync(join(dir, "aggregate.json"), "utf8"));
    assert.equal(agg.byScenario.w["POST /v1/transfers"].count, 2);
    const minutes = JSON.parse(readFileSync(join(dir, "per-minute.json"), "utf8"));
    assert.equal(minutes.length, 1);
  }
});

test("CLI fails loudly without raw input", () => {
  const dir = mkdtempSync(join(tmpdir(), "agg-"));
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "aggregate-raw.cjs"), dir], {
    encoding: "utf8",
  });
  assert.notEqual(r.status, 0);
});


// TC-166-07b: số liệu thô từng request (CSV nén) đủ để tính lại phân vị cho cửa sổ bất kỳ.
test("CLI also writes one CSV row per request that recomputes the same percentiles", async () => {
  const { gunzipSync } = await import("node:zlib");
  const dir = mkdtempSync(join(tmpdir(), "agg-"));
  const durations = [10, 20, 30, 40, 50];
  const body =
    durations.map((d, i) => http(d, "w", "POST /v1/transfers", i === 4 ? 500 : 201, i * 1000)).join("\n") + "\n" +
    point("system_errors", 0, {}, 0) + "\n";
  writeFileSync(join(dir, "raw.json"), body);
  const r = spawnSync(process.execPath, [join(import.meta.dirname, "..", "aggregate-raw.cjs"), dir], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const rows = gunzipSync(readFileSync(join(dir, "requests.csv.gz"))).toString().trim().split("\n");
  assert.equal(rows[0], "epoch_ms,scenario,name,status,duration_ms");
  assert.equal(rows.length, 1 + durations.length);
  const csvDurations = rows.slice(1).map((l) => Number(l.split(",")[4]));
  assert.deepEqual(csvDurations, durations);
  assert.equal(rows[1].split(",")[0], String(T0));
  assert.equal(rows[5].split(",")[3], "500");
  const agg = JSON.parse(readFileSync(join(dir, "aggregate.json"), "utf8"));
  assert.equal(agg.byScenario.w["POST /v1/transfers"].p95, percentile(csvDurations, 95));
});

// TC-166-20..22 (domain review #1, #2, #12): phán quyết DoD 3 theo từng plateau trên đúng cửa sổ của nó.
const plateauLines = (scenarioPrefix, n, errorsAt = []) =>
  Array.from({ length: n }, (_, i) =>
    http(20, `${scenarioPrefix}_120`, "POST /v1/transfers", errorsAt.includes(i) ? 0 : 201, i * 450),
  );

test("TC-166-20 plateau verdict: error rate below 0.1% over the whole plateau window passes", async () => {
  const agg = await aggregateLines([...plateauLines("write", 2000, [1999]), ...plateauLines("read", 2000)]);
  const p = agg.plateaus["120"];
  assert.equal(p.requests, 4000);
  assert.equal(p.systemErrors, 1);
  assert.equal(p.errorRate, 1 / 4000);
  assert.equal(p.meetsErrorBudget, true);
  // một lỗi ở phút cuối thiếu dữ liệu không lật phán quyết (negative control cho cách tính theo ô phút)
  assert.ok(p.perMinute.at(-1).systemErrors === 1 && p.meetsErrorBudget);
});

test("TC-166-21 plateau verdict: 0.1% or more fails, and a plateau never mixes with another", async () => {
  const bad = await aggregateLines(plateauLines("write", 1000, [10]));
  assert.equal(bad.plateaus["120"].errorRate, 0.001);
  assert.equal(bad.plateaus["120"].meetsErrorBudget, false);
  const mixed = await aggregateLines([
    ...plateauLines("write", 1000),
    http(20, "write_60", "POST /v1/transfers", 500, 0),
  ]);
  assert.equal(mixed.plateaus["120"].meetsErrorBudget, true);
  assert.equal(mixed.plateaus["60"].meetsErrorBudget, false);
  assert.ok(mixed.plateaus["120"].achievedRps > 0);
});

test("TC-166-22 a 429 is a system error outside the rate-limit scenario (WAF or ALB), valid inside it", async () => {
  const lines = [
    http(10, "write_120", "POST /v1/transfers", 429, 0),
    http(10, "boundary", "POST /v1/transfers", 429, 0),
  ];
  const agg = await aggregateLines(lines);
  assert.equal(agg.byScenario.write_120["POST /v1/transfers"].systemErrors, 1);
  assert.equal(agg.byScenario.boundary["POST /v1/transfers"].systemErrors, 0);
  assert.equal(agg.unexpected429, 1);
});

// TC-166-23 (review lượt 2 #1): đạt DoD 3 cần cả ngân sách lỗi lẫn tải thật sự được phát đủ (không dropped iteration).
test("TC-166-23 dropped iterations fail DoD 3 even when the error rate is clean", async () => {
  const clean = await aggregateLines(plateauLines("write", 1000));
  assert.equal(clean.plateaus["120"].droppedIterations, 0);
  assert.equal(clean.plateaus["120"].meetsDoD3, true);
  const dropped = await aggregateLines([
    ...plateauLines("write", 1000),
    point("dropped_iterations", 1, { scenario: "write_120" }, 5000),
    point("dropped_iterations", 1, { scenario: "read_120" }, 6000),
    point("dropped_iterations", 1, { scenario: "write_60" }, 6000),
  ]);
  assert.equal(dropped.plateaus["120"].meetsErrorBudget, true);
  assert.equal(dropped.plateaus["120"].droppedIterations, 2);
  assert.equal(dropped.plateaus["120"].meetsDoD3, false);
});
