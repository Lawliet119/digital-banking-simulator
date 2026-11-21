#!/usr/bin/env node
// DBS-178: chụp ảnh lặp lại được cho một dashboard CloudWatch (mặc định `dbs-dev-overview`), một PNG cho mỗi widget `metric`,
// trong một khung thời gian TUYỆT ĐỐI do người dùng truyền (ví dụ plateau 120 RPS của một lượt chạy tải).
//
//   node infra/scripts/dashboard-snapshot.mjs --start 2026-11-22T10:00:00Z --end 2026-11-22T10:15:00Z \
//        --out docs/components/observability/screenshots/120rps-redis-on [--profile dbs] [--dashboard dbs-dev-overview]
//        [--region ap-southeast-1] [--width 1200] [--height 450] [--aws-bin aws] [--aws-arg <đối số thêm, lặp lại được>]
//
// Cách làm: `aws cloudwatch get-dashboard` rồi, với mỗi widget `metric`, `aws cloudwatch get-metric-widget-image` với MetricWidget =
// `properties` của widget cộng `start`/`end` tuyệt đối, `width`, `height`. Chỉ ĐỌC: cần đúng hai quyền `cloudwatch:GetDashboard` và
// `cloudwatch:GetMetricWidgetImage` (≈ 0,02 USD cho 1.000 metric vẽ). Chụp sau khi plateau kết thúc ≈ 5 phút (EMF và SQS nhập số chậm).
//
// Giới hạn (cố ý, ghi ở README của infra/terraform và brief observability):
// - Widget `singleValue` bị vẽ thành `timeSeries`: API chỉ vẽ timeSeries, bar và pie. `setPeriodToTimeRange` bị bỏ, `period` đặt
//   300 (hoặc nhỏ hơn nếu khung ngắn), tiêu đề trong ảnh thêm « (đồ thị trong khung chụp)». Ô số thật chỉ xem trên console (BL-404).
// - `period` lớn hơn khung chụp bị hạ xuống `floor(khung / 60) * 60` (tối thiểu 60), cả ở thuộc tính `period` lẫn ở đối số chu kỳ của
//   `SEARCH('…', 'Sum', N)`, để các chuỗi chia cho nhau cùng cỡ bucket; tiêu đề thêm « (period X → Y giây theo khung chụp)».
// - Widget `text` và `alarm` không vẽ được bằng API: in `SKIP`; ảnh của chúng chụp từ console (BL-262).
// - Ảnh trả về là base64 trong JSON; một dòng cảnh báo trên stderr (ví dụ `invalid input`) không làm thất bại khi byte đầu của ảnh đúng chữ
//   ký PNG (89 50 4E 47). Ảnh CloudWatch vẽ chữ báo lỗi hoặc «không có dữ liệu» vẫn là PNG hợp lệ: mở ảnh xem.
// - Mọi chữ in ra (kể cả stderr của `aws`) được che ARN (`<arn>`) và ID tài khoản 12 chữ số (`<acct>`).
//
// `aws` được gọi bằng execFile, không qua shell; thân MetricWidget đi qua tệp tạm `file://` (tránh giới hạn độ dài và dấu nháy của
// Windows). Trên Windows execFile chỉ chạy được `.exe`: để thay `aws` bằng script, dùng `--aws-bin <node> --aws-arg <script.mjs>`.
//
// Thoát: 0 mọi widget metric đã vẽ; 1 có widget lỗi hoặc không đọc được dashboard; 2 dùng sai.
import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export class UsageError extends Error {}

const DEFAULTS = { dashboard: "dbs-dev-overview", region: "ap-southeast-1", width: 1200, height: 450, awsBin: "aws" };
const MIN_WINDOW_SECONDS = 60;
const SINGLE_VALUE_PERIOD = 300;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const VALUE_OPTIONS = new Set(["--dashboard", "--region", "--profile", "--start", "--end", "--out", "--width", "--height", "--aws-bin", "--aws-arg"]);

export const USAGE = `Dùng: node infra/scripts/dashboard-snapshot.mjs --start <ISO có múi giờ> --end <ISO có múi giờ> --out <thư mục>
        [--dashboard ${DEFAULTS.dashboard}] [--region ${DEFAULTS.region}] [--profile <tên>] [--width ${DEFAULTS.width}] [--height ${DEFAULTS.height}]
        [--aws-bin aws] [--aws-arg <đối số thêm>]...`;

/** Phân tích đối số. Ném UsageError với thông báo tiếng Việt khi sai. */
export function parseArgs(argv) {
  const raw = { awsArgs: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) throw new UsageError(`tham số lạ: ${arg}`);
    if (!VALUE_OPTIONS.has(arg)) throw new UsageError(`không hỗ trợ ${arg}`);
    const value = argv[i + 1];
    if (value === undefined || (value.startsWith("--") && arg !== "--aws-arg")) throw new UsageError(`${arg} cần một giá trị`);
    i += 1;
    if (arg === "--aws-arg") raw.awsArgs.push(value);
    else raw[arg.slice(2)] = value;
  }
  for (const key of ["start", "end", "out"]) if (!raw[key]) throw new UsageError(`thiếu --${key}`);

  const instant = (flag, text) => {
    if (!ISO_WITH_ZONE.test(text)) {
      throw new UsageError(
        /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?$/.test(text)
          ? `${flag} thiếu múi giờ (thêm Z hoặc +07:00): ${text}`
          : `${flag} phải là thời điểm ISO 8601 có múi giờ: ${text}`,
      );
    }
    const ms = Date.parse(text);
    if (Number.isNaN(ms)) throw new UsageError(`${flag} không phải thời điểm hợp lệ: ${text}`);
    return ms;
  };
  const startMs = instant("--start", raw.start);
  const endMs = instant("--end", raw.end);
  if (startMs >= endMs) throw new UsageError("--start phải trước --end");
  if ((endMs - startMs) / 1000 < MIN_WINDOW_SECONDS) throw new UsageError(`khung chụp phải dài ít nhất ${MIN_WINDOW_SECONDS} giây`);

  const size = (flag, text, fallback) => {
    if (text === undefined) return fallback;
    if (!/^\d+$/.test(text) || Number(text) < 100 || Number(text) > 5000) throw new UsageError(`${flag} phải là số nguyên từ 100 đến 5000`);
    return Number(text);
  };
  return {
    dashboard: raw.dashboard ?? DEFAULTS.dashboard,
    region: raw.region ?? DEFAULTS.region,
    profile: raw.profile,
    start: new Date(startMs).toISOString(),
    end: new Date(endMs).toISOString(),
    out: raw.out,
    width: size("--width", raw.width, DEFAULTS.width),
    height: size("--height", raw.height, DEFAULTS.height),
    awsBin: raw["aws-bin"] ?? DEFAULTS.awsBin,
    awsArgs: raw.awsArgs,
  };
}

/** Phần tên tệp từ tiêu đề: bỏ dấu tiếng Việt, chữ thường, chữ số và `-`, tối đa 60 ký tự. */
export function slugify(title) {
  const slug = String(title ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "d")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "widget";
}

/** Che ARN và ID tài khoản (12 chữ số) trong mọi chữ in ra. */
export function redact(text) {
  return String(text)
    .replace(/arn:aws[a-z-]*:[^\s'",;)]*/g, "<arn>")
    .replace(/(?<!\d)\d{12}(?!\d)/g, "<acct>");
}

/** `period` dùng trong khung: không vượt khung, là bội của 60, tối thiểu 60. */
export function periodFor(period, windowSeconds) {
  return Math.min(period, Math.max(60, Math.floor(windowSeconds / 60) * 60));
}

const SEARCH_PERIOD = /(SEARCH\('[^']*',\s*'[^']*',\s*)(\d+)(\s*\))/g;

/**
 * Thuộc tính MetricWidget để vẽ ảnh: `properties` của widget cộng khung tuyệt đối và cỡ ảnh. Không đổi widget gốc.
 * Trả về `{ properties, title }`: `title` là tiêu đề gốc (để đặt tên tệp), `properties.title` có thể thêm hậu tố.
 */
export function widgetImageProperties(widget, { start, end, width, height, windowSeconds }) {
  const original = widget.properties ?? {};
  const properties = structuredClone(original);
  const suffixes = [];
  delete properties.setPeriodToTimeRange;
  properties.start = start;
  properties.end = end;
  properties.width = width;
  properties.height = height;

  if (properties.view === "singleValue") {
    properties.view = "timeSeries";
    properties.period = periodFor(SINGLE_VALUE_PERIOD, windowSeconds);
    suffixes.push("đồ thị trong khung chụp");
  } else if (typeof properties.period === "number") {
    const lowered = periodFor(properties.period, windowSeconds);
    if (lowered !== properties.period) suffixes.push(`period ${properties.period} → ${lowered} giây theo khung chụp`);
    properties.period = lowered;
  }

  let searchLowered = false;
  if (Array.isArray(properties.metrics)) {
    properties.metrics = properties.metrics.map((row) => {
      const first = Array.isArray(row) ? row[0] : undefined;
      if (!first || typeof first !== "object" || typeof first.expression !== "string") return row;
      const expression = first.expression.replace(SEARCH_PERIOD, (all, head, n, tail) => {
        const lowered = periodFor(Number(n), windowSeconds);
        if (lowered !== Number(n)) searchLowered = true;
        return `${head}${lowered}${tail}`;
      });
      return [{ ...first, expression }, ...row.slice(1)];
    });
  }
  if (searchLowered && !suffixes.some((s) => s.startsWith("period"))) {
    suffixes.push("period của SEARCH giảm theo khung chụp");
  }
  if (suffixes.length > 0) properties.title = `${original.title ?? ""} (${suffixes.join("; ")})`.trim();
  return { properties, title: original.title };
}

function reasonOf(error) {
  const stderr = typeof error?.stderr === "string" ? error.stderr.trim() : "";
  const text = stderr || (error instanceof Error ? error.message : String(error));
  return redact(text.split(/\r?\n/).filter(Boolean).slice(0, 2).join(" | ")).slice(0, 300);
}

async function defaultRun(file, args) {
  const { stdout, stderr } = await execFileAsync(file, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  return { stdout, stderr };
}

const commonArgs = (opts) => [...opts.awsArgs, "cloudwatch"];
const trailingArgs = (opts, region) => ["--region", region, ...(opts.profile ? ["--profile", opts.profile] : []), "--output", "json", "--no-cli-pager"];

/** Đọc dashboard và vẽ từng widget metric. Trả về `{ rendered, skipped, failed, fatal }`. */
export async function snapshotDashboard({ run = defaultRun, opts, log = console.log }) {
  const say = (line) => log(redact(line));
  const windowSeconds = (Date.parse(opts.end) - Date.parse(opts.start)) / 1000;

  let body;
  try {
    const { stdout } = await run(opts.awsBin, [
      ...commonArgs(opts),
      "get-dashboard",
      "--dashboard-name",
      opts.dashboard,
      ...trailingArgs(opts, opts.region),
    ]);
    body = JSON.parse(JSON.parse(stdout).DashboardBody);
  } catch (error) {
    say(`LỖI không đọc được dashboard ${opts.dashboard}: ${reasonOf(error)}`);
    return { rendered: 0, skipped: 0, failed: 0, fatal: true };
  }
  if (!Array.isArray(body?.widgets) || body.widgets.length === 0) {
    say(`LỖI dashboard ${opts.dashboard} không có widget nào`);
    return { rendered: 0, skipped: 0, failed: 0, fatal: true };
  }

  mkdirSync(opts.out, { recursive: true });
  const widgets = body.widgets
    .map((widget, index) => ({ widget, index }))
    .sort((a, b) => (a.widget.y ?? 0) - (b.widget.y ?? 0) || (a.widget.x ?? 0) - (b.widget.x ?? 0) || a.index - b.index)
    .map(({ widget }) => widget);

  const work = mkdtempSync(join(tmpdir(), "dbs-snapshot-"));
  const counts = { rendered: 0, skipped: 0, failed: 0, fatal: false };
  let number = 0;
  try {
    for (const widget of widgets) {
      if (widget.type !== "metric") {
        counts.skipped += 1;
        say(`SKIP ${widget.type}  ${widget.properties?.title ?? String(widget.properties?.markdown ?? "").split("\n")[0]}`);
        continue;
      }
      number += 1;
      const { properties, title } = widgetImageProperties(widget, { ...opts, windowSeconds });
      const file = `${String(number).padStart(2, "0")}-${slugify(title)}.png`;
      const widgetFile = join(work, `widget-${number}.json`);
      try {
        writeFileSync(widgetFile, JSON.stringify(properties));
        const { stdout, stderr } = await run(opts.awsBin, [
          ...commonArgs(opts),
          "get-metric-widget-image",
          "--metric-widget",
          `file://${widgetFile.replace(/\\/g, "/")}`,
          ...trailingArgs(opts, widget.properties?.region ?? opts.region),
        ]);
        const encoded = JSON.parse(stdout).MetricWidgetImage;
        const png = typeof encoded === "string" ? Buffer.from(encoded, "base64") : Buffer.alloc(0);
        if (png.length < PNG_SIGNATURE.length || !png.subarray(0, 4).equals(PNG_SIGNATURE)) {
          throw new Error("câu trả lời không phải ảnh PNG (thiếu chữ ký 89504E47)");
        }
        writeFileSync(join(opts.out, file), png);
        counts.rendered += 1;
        say(`OK   ${file}  ${title ?? ""}`);
        if (stderr && stderr.trim()) say(`     cảnh báo: ${stderr.trim().split(/\r?\n/)[0]}`);
      } catch (error) {
        counts.failed += 1;
        say(`FAIL ${title ?? file}: ${reasonOf(error)}`);
      }
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
  say(`${counts.rendered} ảnh, ${counts.skipped} bỏ qua, ${counts.failed} lỗi`);
  return counts;
}

/** Điểm vào: trả về mã thoát. `run`, `log`, `err` được tiêm để test. */
export async function main(argv, { run = defaultRun, log = console.log, err = console.error } = {}) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (error) {
    if (!(error instanceof UsageError)) throw error;
    err(`LỖI ${error.message}`);
    err(USAGE);
    return 2;
  }
  const result = await snapshotDashboard({ run, opts, log });
  return result.fatal || result.failed > 0 ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error) => {
      console.error(redact(`LỖI ${error?.stack ?? error}`));
      process.exit(1);
    },
  );
}
