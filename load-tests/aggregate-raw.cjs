#!/usr/bin/env node
/**
 * DBS-166: rút gọn `raw.json` (k6 JSON Lines, hàng trăm MB tới hơn 1 GB cho baseline) thành số liệu thô đủ nhỏ để
 * lưu trong repo: `aggregate.json` (theo scenario và tên request) và `per-minute.json` (theo phút). Chỉ đọc, không
 * ghi đè raw; thêm `requests.csv.gz` (mỗi request một dòng: epoch_ms,scenario,name,status,duration_ms). Dùng: node load-tests/aggregate-raw.cjs <thư mục kết quả có raw.json hoặc raw.json.gz>
 *
 * Lỗi hệ thống: status ngoài 200, 201, 422, 429 (kể cả 0: timeout, đứt kết nối), và 429 ngoài bài rate-limit (`record()` của
 * lib/client.js coi 429 là hợp lệ mọi nơi; ở cloud, giới hạn app đã nâng nên 429 là của WAF hoặc ALB, DBS-166 review #2).
 * Phân vị nội suy tuyến tính trên mảng đã sắp xếp (chỉ số p/100 × (n − 1)), cùng cách k6 tính p(95).
 */
const { createReadStream, createWriteStream, existsSync, writeFileSync } = require("node:fs");
const { once } = require("node:events");
const { createInterface } = require("node:readline");
const { createGunzip, createGzip } = require("node:zlib");
const { join, resolve } = require("node:path");

const VALID_STATUS = new Set([200, 201, 422, 429]);
// The rate-limit scenario (k6 scenario name "boundary") expects 429 from the application limiter. Everywhere else the
// application limits are raised, so a 429 comes from the WAF or the ALB path and counts as an error (DBS-166 review #2).
const RATE_LIMIT_SCENARIO = "boundary";
const PLATEAU = /^(?:read|write)_([0-9]+)$/;
const ERROR_BUDGET = 0.001;
function isSystemError(status, scenario) {
  if (status === 429 && scenario !== RATE_LIMIT_SCENARIO) return true;
  return !VALID_STATUS.has(status);
}
const LATENCY_METRICS = new Set(["transfer_latency", "read_latency"]);
const round = (n) => (n === null ? null : Math.round(n * 1000) / 1000);

function percentile(values, p) {
  if (!values.length) return null;
  const a = [...values].sort((x, y) => x - y);
  const idx = (p / 100) * (a.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return a[lo] + (a[hi] - a[lo]) * (idx - lo);
}

function summarize(values) {
  const sorted = [...values].sort((x, y) => x - y);
  const at = (p) => {
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
  };
  return {
    p50: round(at(50)),
    p90: round(at(90)),
    p95: round(at(95)),
    p99: round(at(99)),
    max: round(sorted[sorted.length - 1]),
  };
}

// Per plateau (read_N + write_N together) over the plateau's own window. The verdict is on the whole window; the
// per-minute rows start at the plateau's first request (60 s buckets) and are supporting evidence only.
function summarizePlateaus(plateaus, dropped) {
  const out = {};
  for (const [n, p] of plateaus) {
    const buckets = new Map();
    for (const [t, e] of p.points) {
      const m = Math.floor((t - p.first) / 60000);
      const b = buckets.get(m) || { minute: m, requests: 0, systemErrors: 0 };
      b.requests += 1;
      b.systemErrors += e;
      buckets.set(m, b);
    }
    const seconds = Math.max(1, (p.last - p.first) / 1000);
    out[n] = {
      requests: p.requests,
      systemErrors: p.systemErrors,
      errorRate: p.systemErrors / p.requests,
      meetsErrorBudget: p.systemErrors / p.requests < ERROR_BUDGET,
      droppedIterations: (dropped.get(`read_${n}`) || 0) + (dropped.get(`write_${n}`) || 0),
      meetsDoD3:
        p.systemErrors / p.requests < ERROR_BUDGET &&
        (dropped.get(`read_${n}`) || 0) + (dropped.get(`write_${n}`) || 0) === 0,
      windowSeconds: round(seconds),
      achievedRps: round(p.requests / seconds),
      perMinute: [...buckets.values()].sort((a, b) => a.minute - b.minute),
    };
  }
  return out;
}

async function aggregateLines(lines, onRequest = null) {
  const groups = new Map(); // "scenario\u0000name" -> {values, status, systemErrors, first, last}
  const minutes = new Map(); // "scenario\u0000name\u0000minute" -> {values, systemErrors}
  const metrics = new Map(); // metric -> label -> values
  const sys = { total: 0, errors: 0 };
  let skippedLines = 0;
  let minMinute = Infinity;
  let unexpected429 = 0;
  const dropped = new Map(); // scenario -> dropped iterations (k6 could not start the planned load)
  const plateaus = new Map(); // N -> {requests, systemErrors, first, last, minutes: Map}
  let first = Infinity;
  let last = -Infinity;

  for await (const line of lines) {
    if (!line) continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch {
      skippedLines += 1;
      continue;
    }
    if (row.type !== "Point" || !row.data) continue;
    const { metric, data } = row;
    const t = Date.parse(data.time);
    if (!Number.isFinite(t) || !Number.isFinite(data.value)) continue;
    first = Math.min(first, t);
    last = Math.max(last, t);
    if (metric === "http_req_duration") {
      const tags = data.tags || {};
      const scenario = tags.scenario || "unknown";
      const name = tags.name || "unknown";
      const status = Number(tags.status ?? 0);
      const isError = isSystemError(status, scenario);
      if (status === 429 && isError) unexpected429 += 1;
      const plateau = PLATEAU.exec(scenario);
      if (plateau) {
        let p = plateaus.get(plateau[1]);
        if (!p) {
          p = { requests: 0, systemErrors: 0, first: Infinity, last: -Infinity, minutes: new Map() };
          plateaus.set(plateau[1], p);
        }
        p.requests += 1;
        if (isError) p.systemErrors += 1;
        p.first = Math.min(p.first, t);
        p.last = Math.max(p.last, t);
        p.points = p.points || [];
        p.points.push([t, isError ? 1 : 0]);
      }
      const key = `${scenario}\u0000${name}`;
      let g = groups.get(key);
      if (!g) {
        g = { scenario, name, values: [], status: {}, systemErrors: 0 };
        groups.set(key, g);
      }
      if (onRequest) await onRequest({ t, scenario, name, status, value: data.value });
      g.values.push(data.value);
      g.status[status] = (g.status[status] || 0) + 1;
      if (isError) g.systemErrors += 1;
      const minute = Math.floor(t / 60000);
      minMinute = Math.min(minMinute, minute);
      const mk = `${key}\u0000${minute}`;
      let m = minutes.get(mk);
      if (!m) {
        m = { scenario, name, minute, values: [], systemErrors: 0 };
        minutes.set(mk, m);
      }
      m.values.push(data.value);
      if (isError) m.systemErrors += 1;
    } else if (metric === "dropped_iterations") {
      const scenario = (data.tags || {}).scenario || "unknown";
      dropped.set(scenario, (dropped.get(scenario) || 0) + data.value);
    } else if (metric === "system_errors") {
      sys.total += 1;
      if (data.value) sys.errors += 1;
    } else if (LATENCY_METRICS.has(metric)) {
      const tags = Object.entries(data.tags || {})
        .filter(([k]) => k !== "scenario")
        .sort(([a], [b]) => (a < b ? -1 : 1))
        .map(([k, v]) => `${k}=${v}`)
        .join(",");
      const byLabel = metrics.get(metric) || new Map();
      const values = byLabel.get(tags) || [];
      values.push(data.value);
      byLabel.set(tags, values);
      metrics.set(metric, byLabel);
    }
  }

  const byScenario = {};
  for (const g of groups.values()) {
    const seconds = Math.max(1, (last - first) / 1000);
    (byScenario[g.scenario] ||= {})[g.name] = {
      count: g.values.length,
      systemErrors: g.systemErrors,
      status: Object.fromEntries(
        Object.entries(g.status).sort(([a], [b]) => Number(a) - Number(b)),
      ),
      ...summarize(g.values),
      avgRequestsPerSecondOverWholeRun: round(g.values.length / seconds),
    };
  }
  const perMinute = [...minutes.values()]
    .map((m) => ({
      minute: m.minute - minMinute,
      scenario: m.scenario,
      name: m.name,
      count: m.values.length,
      systemErrors: m.systemErrors,
      ...summarize(m.values),
    }))
    .sort(
      (a, b) =>
        a.minute - b.minute ||
        (a.scenario < b.scenario ? -1 : a.scenario > b.scenario ? 1 : 0) ||
        (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
    );
  const metricSummary = {};
  for (const [metric, byLabel] of metrics) {
    metricSummary[metric] = {};
    for (const [label, values] of byLabel)
      metricSummary[metric][label] = { count: values.length, ...summarize(values) };
  }
  return {
    window: Number.isFinite(first)
      ? { start: new Date(first).toISOString(), end: new Date(last).toISOString() }
      : null,
    skippedLines,
    unexpected429,
    plateaus: summarizePlateaus(plateaus, dropped),
    systemErrors: {
      ...sys,
      rate: sys.total ? sys.errors / sys.total : null,
    },
    metrics: metricSummary,
    byScenario,
    perMinute,
  };
}

async function* readLines(file) {
  const input = createReadStream(file);
  const stream = file.endsWith(".gz") ? input.pipe(createGunzip()) : input;
  yield* createInterface({ input: stream, crlfDelay: Infinity });
}

async function main(argv = process.argv.slice(2)) {
  if (argv.length !== 1) throw new Error("Usage: node load-tests/aggregate-raw.cjs <results-dir>");
  const dir = resolve(argv[0]);
  const file = ["raw.json", "raw.json.gz"].map((n) => join(dir, n)).find(existsSync);
  if (!file) throw new Error(`No raw.json or raw.json.gz in ${dir}`);
  // Số liệu thô từng request, nén: epoch_ms,scenario,name,status,duration_ms (tên request không chứa dấu phẩy).
  const gz = createGzip();
  const csv = createWriteStream(join(dir, "requests.csv.gz"));
  gz.pipe(csv);
  gz.write("epoch_ms,scenario,name,status,duration_ms\n");
  const onRequest = async (r) => {
    if (!gz.write(`${r.t},${r.scenario},${r.name},${r.status},${r.value}\n`))
      await once(gz, "drain");
  };
  const agg = await aggregateLines(readLines(file), onRequest);
  gz.end();
  await once(csv, "close");
  if (!agg.window) throw new Error("raw input contains no data points");
  const { perMinute, ...rest } = agg;
  writeFileSync(join(dir, "aggregate.json"), `${JSON.stringify(rest, null, 2)}\n`);
  writeFileSync(join(dir, "per-minute.json"), `${JSON.stringify(perMinute)}\n`);
  console.log(
    JSON.stringify({ aggregate: join(dir, "aggregate.json"), points: Object.values(rest.byScenario).flatMap(Object.values).reduce((n, g) => n + g.count, 0) }),
  );
}

if (require.main === module)
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
module.exports = { percentile, aggregateLines, summarize };
