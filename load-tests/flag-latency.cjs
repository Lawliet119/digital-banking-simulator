"use strict";
// DBS-174: `node load-tests/flag-latency.cjs <thư mục kết quả> [--settle <giây>] [--window label=fromISO,toISO]...`
// Đọc `aggregate.json` của lượt (cửa sổ từng plateau) hoặc nhận cửa sổ tường minh, tính p50/p95/p99 độ trễ giao dịch → quyết định
// và → cờ theo plateau và theo phút, rồi ghi `flag-latency.json` cạnh kết quả. Cần DATABASE_URL (và DATABASE_SSL, DATABASE_SSL_CA_PATH
// như postflight.cjs). Thoát 0 khi đo xong và không tồn đọng, 1 khi còn giao dịch chưa có quyết định sau hạn đợi, 2 khi không đo được.
const { existsSync, readFileSync, writeFileSync } = require("node:fs");
const { join } = require("node:path");
const { measure, parseWindow, plateauWindows } = require("./lib/flag-latency.cjs");

function parseArgs(argv) {
  const args = { dir: undefined, settle: 120, windows: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--settle") args.settle = Number(argv[++i]);
    else if (a === "--window") args.windows.push(parseWindow(String(argv[++i])));
    else if (a.startsWith("--")) throw new Error(`cờ không biết: ${a}`);
    else if (args.dir === undefined) args.dir = a;
    else throw new Error(`thừa đối số: ${a}`);
  }
  if (!args.dir) throw new Error("thiếu thư mục kết quả");
  if (!Number.isFinite(args.settle) || args.settle < 0) throw new Error("--settle phải là số giây ≥ 0");
  return args;
}

async function connect() {
  const { Client } = require("../backend/node_modules/pg");
  const ssl = process.env.DATABASE_SSL === "true";
  if (["staging", "production"].includes(process.env.NODE_ENV) && !ssl) throw new Error("TLS required");
  const client = new Client({
    connectionString: process.env.DATABASE_URL,
    connectionTimeoutMillis: 5000,
    query_timeout: 60000,
    ssl: ssl
      ? { rejectUnauthorized: true, ...(process.env.DATABASE_SSL_CA_PATH ? { ca: readFileSync(process.env.DATABASE_SSL_CA_PATH, "utf8") } : {}) }
      : undefined,
  });
  await client.connect();
  return client;
}

function format(report) {
  const lines = [`flag-latency: SLO p95 < ${report.sloMs} ms, đợi ${report.settledAfterSeconds}s, còn ${report.undecidedAfterSettle} giao dịch chưa có quyết định`];
  for (const w of report.windows) {
    const d = w.decisionLagMs;
    const f = w.flagLagMs;
    lines.push(
      `  ${w.label}: ${w.transfers} chuyển, ${w.decided} quyết định, ${w.flagged} cờ | quyết định p50/p95/p99/max ${d.p50}/${d.p95}/${d.p99}/${d.max} ms | cờ p50/p95/p99/max ${f.p50}/${f.p95}/${f.p99}/${f.max} ms`,
    );
  }
  return lines.join("\n");
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let windows = args.windows;
  if (windows.length === 0) {
    const file = join(args.dir, "aggregate.json");
    if (!existsSync(file)) throw new Error(`không có ${file} và không có --window`);
    windows = plateauWindows(JSON.parse(readFileSync(file, "utf8")));
    if (windows.length === 0) {
      console.log("flag-latency: lượt này không có plateau (không phải bài arrival-rate), bỏ qua");
      return 0;
    }
  }
  const client = await connect();
  try {
    const report = await measure(client, windows, { settleSeconds: args.settle });
    writeFileSync(join(args.dir, "flag-latency.json"), `${JSON.stringify(report, null, 2)}\n`);
    console.log(format(report));
    return report.backlog ? 1 : 0;
  } finally {
    await client.end();
  }
}

if (require.main === module) {
  main().then(
    code => process.exit(code),
    error => {
      console.error(`flag-latency: ${error.message}`);
      process.exit(2);
    },
  );
}

module.exports = { parseArgs, format };
