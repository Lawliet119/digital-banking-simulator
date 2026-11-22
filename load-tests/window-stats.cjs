#!/usr/bin/env node
/**
 * DBS-167: thống kê theo cửa sổ quanh sự cố Redis của một lượt `redis-fault`.
 *
 *   node load-tests/window-stats.cjs <thư mục kết quả> --mode slow|down|none [--noise <ms>]
 *
 * Đọc `requests.csv.gz` (epoch_ms,scenario,name,status,duration_ms; do aggregate-raw.cjs ghi), `fault-events.jsonl` và
 * `health.jsonl` (do infra/scripts/redis-fault.sh ghi cạnh kết quả), tùy chọn `exit.json` (runExit, invariantExit) và
 * `aggregate.json` (dropped_iterations). Ghi `windows.json` và in phán quyết. Thoát 2 và KHÔNG in phán quyết nếu lượt có sự
 * cố (slow, down) thiếu `fault-events.jsonl` hoặc `health.jsonl`: thiếu mốc thời gian thì mọi con số theo cửa sổ vô nghĩa.
 *
 * Cửa sổ (từ T0 = request đầu tiên, tức lúc k6 bắt đầu):
 *   pre        T0+60 s .. lúc tiêm (bỏ 60 s khởi động)
 *   fault_*    slow: fault_light (xung nhẹ) rồi fault_heavy (xung nặng); down: fault; none: fault_nominal = T0+300 s .. T0+600 s
 *   recovery   60 s đầu sau khi khôi phục
 *   after      phần còn lại
 * Tiêu chí (chốt ở feature doc DBS-167 G1.8, không nới sau khi có số): SLO docs/03 §14 ở MỌI cửa sổ; «chấp nhận được» khi
 * p95 chênh so với `pre` ≤ 150 ms cho chuyển tiền và ≤ 100 ms cho đọc (slow: 3 và 2 lần gọi Redis nối tiếp × timeout 50 ms) hoặc
 * ≤ max(20 ms, 2N) (down), N là dao động tự nhiên giữa các cửa sổ của lượt đối chứng (`--noise`). Lỗi hệ thống = mọi status ngoài
 * 200, 201, 422 (5xx, 0, 429: giới hạn của app đã nâng; như aggregate-raw.cjs và BL-415). Hồi phục = thời gian từ lúc khôi phục
 * tới mẫu `/health/ready` KHÔNG-`up` cuối cùng (mẫu đi qua ALB nên mỗi giây chỉ trúng một trong hai task: lần `up` đầu tiên không
 * chứng minh cả hai đã hồi phục). `dropped_iterations` và `invariantExit` là tiêu chí của CẢ LƯỢT, không theo cửa sổ.
 */
const { createReadStream, existsSync, readFileSync, writeFileSync } = require("node:fs");
const { createInterface } = require("node:readline");
const { createGunzip } = require("node:zlib");
const { join } = require("node:path");

const WARMUP_MS = 60_000;
const NOMINAL_FAULT_START_MS = 300_000;
const NOMINAL_FAULT_END_MS = 600_000;
const RECOVERY_MS = 60_000;
// Số lần gọi Redis nối tiếp trên đường đi, mỗi lần bị cắt ở 50 ms (redis.client.ts): chuyển tiền 3 lần (rate limit IP, đọc
// `revoked_at` của JwtAuthGuard, rate limit khách), đọc 2 lần (IP, `revoked_at`). Review DBS-167 #2.
const SLOW_ALLOWANCE_MS = { transfer: 150, read: 100 };
const DOWN_FLOOR_MS = 20;
const REDIS_UP_LIMIT_S = 60;
const LIMITS = {
  "transfer.p95": 300,
  "transfer.p99": 1000,
  "balance.p95": 150,
  "history.p95": 150,
};
const ERROR_BUDGET = 0.001;
const MIN_NOISE_REQUESTS = 500;
const round = (n) => (n === null ? null : Math.round(n * 1000) / 1000);

function percentile(sorted, p) {
  if (!sorted.length) return null;
  const idx = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  return round(sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo));
}

function classify(name) {
  if (name === "POST /v1/transfers") return "transfer";
  if (name === "GET /v1/accounts/:id") return "balance";
  if (name === "GET /v1/accounts/:id/transactions") return "history";
  return null;
}

// Chỉ 200, 201, 422 là hợp lệ (lib/config.js `validStatuses`, BL-415): 5xx, status 0, 429 và mọi 4xx khác là lỗi hệ thống.
const VALID_STATUS = new Set([200, 201, 422]);
function isSystemError(status) {
  return !VALID_STATUS.has(status);
}

function dist(values) {
  const a = [...values].sort((x, y) => x - y);
  return { count: a.length, p50: percentile(a, 50), p95: percentile(a, 95), p99: percentile(a, 99), max: a.length ? round(a[a.length - 1]) : null };
}

function summarize(name, from, to, rows) {
  const by = { transfer: [], balance: [], history: [], read: [] };
  let requests = 0;
  let systemErrors = 0;
  let clientErrors = 0;
  for (const r of rows) {
    if (r.epoch_ms < from || r.epoch_ms >= to) continue;
    requests += 1;
    if (isSystemError(r.status)) systemErrors += 1;
    else if (r.status === 422) clientErrors += 1;
    const kind = classify(r.name);
    if (!kind) continue;
    by[kind].push(r.duration_ms);
    if (kind !== "transfer") by.read.push(r.duration_ms);
  }
  return {
    name,
    from,
    to,
    seconds: round((to - from) / 1000),
    requests,
    systemErrors,
    clientErrors,
    errorRate: requests ? round(systemErrors / requests) : 0,
    transfer: dist(by.transfer),
    balance: dist(by.balance),
    history: dist(by.history),
    read: dist(by.read),
  };
}

function buildWindows(t0, last, mode, events) {
  const find = (action) => events.find((e) => e.action === action)?.epoch_ms;
  let inject;
  let end;
  const faults = [];
  if (mode === "none") {
    inject = t0 + NOMINAL_FAULT_START_MS;
    end = t0 + NOMINAL_FAULT_END_MS;
    faults.push(["fault_nominal", inject, end]);
  } else if (mode === "slow") {
    inject = find("slow_start");
    const step = find("slow_step");
    end = find("slow_end");
    if (![inject, step, end].every(Number.isFinite)) throw new Error("fault-events.jsonl thiếu slow_start, slow_step hoặc slow_end");
    faults.push(["fault_light", inject, step], ["fault_heavy", step, end]);
  } else if (mode === "down") {
    inject = find("down");
    end = find("restore");
    if (![inject, end].every(Number.isFinite)) throw new Error("fault-events.jsonl thiếu down hoặc restore");
    faults.push(["fault", inject, end]);
  } else {
    throw new Error(`mode không hợp lệ: ${mode}`);
  }
  return {
    inject,
    end,
    list: [
      ["pre", t0 + WARMUP_MS, inject],
      ...faults,
      ["recovery", end, end + RECOVERY_MS],
      ["after", end + RECOVERY_MS, last + 1],
    ],
  };
}

// Dao động tự nhiên N (ms): chênh lớn nhất của p95 chuyển tiền giữa các cửa sổ của lượt đối chứng (chỉ cửa sổ đủ lớn).
function noiseMs(control) {
  const p = control.windows.filter((w) => w.requests >= MIN_NOISE_REQUESTS && w.transfer && w.transfer.p95 !== null).map((w) => w.transfer.p95);
  return p.length < 2 ? 0 : round(Math.max(...p) - Math.min(...p));
}

// Giây từ lúc khôi phục tới mẫu cuối cùng không-`up` (0 nếu sau khôi phục chưa từng thấy không-`up`); null nếu mẫu cuối của lượt vẫn không-`up`.
function recoverySeconds(health, end) {
  const after = health.filter((h) => h.epoch_ms >= end).sort((a, b) => a.epoch_ms - b.epoch_ms);
  if (!after.length) return null;
  if (after[after.length - 1].redis !== "up") return null;
  const lastBad = [...after].reverse().find((h) => h.redis !== "up");
  return lastBad ? round((lastBad.epoch_ms - end) / 1000 + 1) : 0;
}

function judge({ windows, mode, health, exit, noise, recovery, dropped }) {
  const violations = [];
  const degradation = [];
  const openBl = [];
  const get = (w, path) => path.split(".").reduce((o, k) => (o ? o[k] : undefined), w);
  for (const w of windows) {
    if (w.requests < 1) continue;
    for (const [metric, limit] of Object.entries(LIMITS)) {
      const value = get(w, metric);
      if (value !== null && value !== undefined && value >= limit) violations.push({ window: w.name, metric, value, limit });
    }
    if (w.errorRate >= ERROR_BUDGET) violations.push({ window: w.name, metric: "errorRate", value: w.errorRate, limit: ERROR_BUDGET });
    if (w.systemErrors > 0) openBl.push(`có lỗi hệ thống (5xx, status 0 hoặc 429) ở cửa sổ ${w.name}: ${w.systemErrors}`);
  }
  if (violations.length) openBl.push(`vượt SLO: ${violations.map((v) => `${v.window} ${v.metric}=${v.value}`).join("; ")}`);
  const pre = windows.find((w) => w.name === "pre");
  if (mode !== "none" && pre?.transfer?.p95 != null) {
    const allowedFor = (op) => (mode === "slow" ? SLOW_ALLOWANCE_MS[op] : Math.max(DOWN_FLOOR_MS, 2 * noise));
    for (const w of windows) {
      if (!w.name.startsWith("fault")) continue;
      for (const op of ["transfer", "read"]) {
        if (w[op].p95 === null || pre[op].p95 === null) continue;
        const delta = round(w[op].p95 - pre[op].p95);
        const allowed = allowedFor(op);
        degradation.push({ window: w.name, op, delta, allowed });
        if (delta > allowed) openBl.push(`${op} p95 ở ${w.name} chậm hơn cửa sổ trước ${delta} ms (cho phép ${allowed} ms)`);
      }
    }
    const rec = windows.find((w) => w.name === "recovery");
    for (const op of ["transfer", "read"]) {
      const slack = 2 * noise + (mode === "slow" ? SLOW_ALLOWANCE_MS[op] : DOWN_FLOOR_MS);
      if (rec && rec[op].p95 !== null && pre[op].p95 !== null && rec[op].p95 - pre[op].p95 > slack)
        openBl.push(`p95 ${op} chưa về mức trước trong cửa sổ recovery (+${round(rec[op].p95 - pre[op].p95)} ms)`);
    }
  }
  const nonOk = health.filter((h) => h.code !== 200);
  if (nonOk.length) openBl.push(`/health/ready khác 200: ${nonOk.length} lần (đầu tiên ${nonOk[0].code})`);
  if (mode !== "none" && (recovery === null || recovery > REDIS_UP_LIMIT_S))
    openBl.push(`api chỉ báo redis "up" ổn định ${recovery === null ? "không bao giờ" : `${recovery} s`} sau khôi phục (mẫu không-up cuối cùng), quá ${REDIS_UP_LIMIT_S} s`);
  if (dropped > 0) openBl.push(`dropped_iterations = ${dropped}: tải 120 RPS không được phát đủ`);
  let classification;
  if (exit && exit.invariantExit !== 0) classification = "blocker: bất biến";
  else if (violations.length) classification = "vượt SLO";
  else if (openBl.length) classification = "phải mở BL";
  else if (degradation.some((d) => d.delta > 0)) classification = "đạt, xấu đi trong mức chấp nhận";
  else classification = "đạt";
  return { classification, violations, degradation, openBl };
}

function analyze({ rows, events = [], health = [], mode, exit = null, noise = 0, dropped = 0 }) {
  if (!rows.length) throw new Error("không có request nào");
  let t0 = Infinity;
  let last = -Infinity;
  for (const r of rows) {
    if (r.epoch_ms < t0) t0 = r.epoch_ms;
    if (r.epoch_ms > last) last = r.epoch_ms;
  }
  const { inject, end, list } = buildWindows(t0, last, mode, events);
  const windows = list.map(([name, from, to]) => summarize(name, from, to, rows));
  const recovery = mode === "none" ? null : recoverySeconds(health, end);
  const verdict = judge({ windows, mode, health, exit, noise, recovery, dropped });
  return {
    mode,
    t0,
    inject,
    end,
    noiseMs: noise,
    windows,
    health: { samples: health.length, nonOk: health.filter((h) => h.code !== 200).length },
    recoverySeconds: recovery,
    exit,
    droppedIterations: dropped,
    verdict,
  };
}

async function readRows(file) {
  const rows = [];
  const lines = createInterface({ input: createReadStream(file).pipe(createGunzip()), crlfDelay: Infinity });
  let header = true;
  for await (const line of lines) {
    if (header) {
      header = false;
      continue;
    }
    if (!line) continue;
    const [epoch, scenario, name, status, duration] = line.split(",");
    rows.push({ epoch_ms: Number(epoch), scenario, name, status: Number(status), duration_ms: Number(duration) });
  }
  return rows;
}

const readJsonl = (file) =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

async function main(argv) {
  const dir = argv[0];
  const flag = (n) => (argv.indexOf(n) >= 0 ? argv[argv.indexOf(n) + 1] : undefined);
  const mode = flag("--mode");
  if (!dir || !["slow", "down", "none"].includes(mode)) {
    console.error("Dùng: node load-tests/window-stats.cjs <thư mục kết quả> --mode slow|down|none [--noise <ms>]");
    return 2;
  }
  const csv = join(dir, "requests.csv.gz");
  const eventsFile = join(dir, "fault-events.jsonl");
  const healthFile = join(dir, "health.jsonl");
  const need = mode === "none" ? [csv] : [csv, eventsFile, healthFile];
  const missing = need.filter((f) => !existsSync(f));
  if (missing.length) {
    console.error(`thiếu file: ${missing.join(", ")}; không có phán quyết`);
    return 2;
  }
  const readJson = (f) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : null);
  const exit = readJson(join(dir, "exit.json"));
  const agg = readJson(join(dir, "aggregate.json"));
  const dropped = agg?.plateaus?.["120"]?.droppedIterations ?? 0;
  try {
    const out = analyze({
      rows: await readRows(csv),
      events: existsSync(eventsFile) ? readJsonl(eventsFile) : [],
      health: existsSync(healthFile) ? readJsonl(healthFile) : [],
      mode,
      exit,
      noise: Number(flag("--noise") || 0),
      dropped,
    });
    writeFileSync(join(dir, "windows.json"), JSON.stringify(out, null, 2) + "\n");
    for (const w of out.windows)
      console.log(`${w.name.padEnd(14)} n=${String(w.requests).padStart(6)} lỗi=${w.systemErrors} chuyển p95=${w.transfer.p95} p99=${w.transfer.p99} đọc p95=${w.read.p95}`);
    console.log(`redis "up" lại sau ${out.recoverySeconds} s; health không-200: ${out.health.nonOk}/${out.health.samples}`);
    console.log(`phán quyết: ${out.verdict.classification}`);
    for (const b of out.verdict.openBl) console.log(`  BL: ${b}`);
    return 0;
  } catch (e) {
    console.error(`lỗi: ${e.message}; không có phán quyết`);
    return 2;
  }
}

module.exports = { analyze, noiseMs, classify, percentile, buildWindows };

if (require.main === module) main(process.argv.slice(2)).then((c) => process.exit(c));
