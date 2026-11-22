// DBS-178: công cụ chụp ảnh dashboard (infra/scripts/dashboard-snapshot.mjs) và hợp đồng tên alarm của dashboard.tf.
// `aws` luôn là giả: hàm `run` được tiêm, hoặc `fake-aws-cloudwatch.mjs` chạy qua execFile thật. Không gọi AWS.
import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  UsageError,
  parseArgs,
  periodFor,
  redact,
  slugify,
  snapshotDashboard,
  widgetImageProperties,
  main,
} from "../../infra/scripts/dashboard-snapshot.mjs";

// CI chạy test từ backend/: mọi đường dẫn dựng từ vị trí của tệp này, không từ thư mục làm việc.
const REPO = fileURLToPath(new URL("../../", import.meta.url));
const FAKE_AWS = fileURLToPath(new URL("./fixtures/fake-aws-cloudwatch.mjs", import.meta.url));
const SNAPSHOT = join(REPO, "infra/scripts/dashboard-snapshot.mjs");
const SESSION = join(REPO, "infra/terraform/envs/dev/session");

const START = "2026-11-22T10:00:00Z";
const END = "2026-11-22T10:15:00Z";
const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);
const PNG_B64 = PNG.toString("base64");

const tmp = () => mkdtempSync(join(tmpdir(), "dbs178-"));
const baseArgs = (out) => ["--start", START, "--end", END, "--out", out];

const metricWidget = (title, extra = {}, y = 0, x = 0) => ({
  type: "metric",
  x,
  y,
  width: 8,
  height: 6,
  properties: {
    title,
    region: "ap-southeast-1",
    view: "timeSeries",
    period: 60,
    metrics: [["DBS/Backend", "http_requests_total", { stat: "Sum" }]],
    ...extra,
  },
});

const DASHBOARD = {
  start: "-PT3H",
  periodOverride: "inherit",
  widgets: [
    { type: "text", x: 0, y: 0, width: 24, height: 2, properties: { markdown: "## Tiêu đề" } },
    { type: "alarm", x: 0, y: 2, width: 12, height: 6, properties: { title: "Trạng thái alarm", alarms: ["arn:aws:cloudwatch:ap-southeast-1:123456789012:alarm:dbs-dev-x"] } },
    metricWidget("Lưu lượng: request mỗi giây", {}, 8, 0),
    metricWidget("Độ trễ toàn dịch vụ (ms)", { period: 300 }, 8, 8),
    metricWidget("Cờ / 1.000 giao dịch, 1 giờ gần nhất", { view: "singleValue", setPeriodToTimeRange: true, start: "-PT1H", end: "P0D" }, 8, 16),
  ],
};

// `aws` giả ở mức hàm: ghi lại mọi lời gọi, đọc tệp MetricWidget trước khi công cụ xóa nó.
function fakeRun({ dashboard = DASHBOARD, imageFor } = {}) {
  const calls = [];
  const run = async (file, args) => {
    const call = { file, args: [...args] };
    calls.push(call);
    const at = (flag) => args[args.indexOf(flag) + 1];
    if (args.includes("get-dashboard")) {
      const body = typeof dashboard === "string" ? dashboard : JSON.stringify(dashboard);
      return { stdout: JSON.stringify({ DashboardName: at("--dashboard-name"), DashboardBody: body }), stderr: "" };
    }
    const ref = at("--metric-widget");
    call.widgetRaw = readFileSync(ref.slice("file://".length));
    call.widget = JSON.parse(call.widgetRaw.toString("utf8"));
    call.widgetPath = ref.slice("file://".length);
    return imageFor ? imageFor(call) : { stdout: JSON.stringify({ MetricWidgetImage: PNG_B64 }), stderr: "" };
  };
  return { run, calls };
}

const collect = () => {
  const lines = [];
  return { lines, log: (line) => lines.push(line) };
};

// TC-178-11
test("parseArgs applies the defaults and accepts an absolute window", () => {
  const opts = parseArgs(baseArgs("anh"));
  assert.equal(opts.dashboard, "dbs-dev-overview");
  assert.equal(opts.region, "ap-southeast-1");
  assert.equal(opts.width, 1200);
  assert.equal(opts.height, 450);
  assert.equal(opts.start, "2026-11-22T10:00:00.000Z");
  assert.equal(opts.end, "2026-11-22T10:15:00.000Z");
  assert.equal(opts.out, "anh");
  assert.deepEqual(opts.awsArgs, []);
  assert.equal(opts.awsBin, "aws");
  assert.equal(opts.profile, undefined);
});

test("parseArgs takes every option, including repeated --aws-arg and an offset time zone", () => {
  const opts = parseArgs([
    "--dashboard", "dbs-dev-infra", "--region", "ap-southeast-2", "--profile", "dbs",
    "--start", "2026-11-22T17:00:00+07:00", "--end", "2026-11-22T17:15:00+07:00", "--out", "x",
    "--width", "900", "--height", "300", "--aws-bin", "node", "--aws-arg", "a.mjs", "--aws-arg", "b",
  ]);
  assert.equal(opts.dashboard, "dbs-dev-infra");
  assert.equal(opts.profile, "dbs");
  assert.equal(opts.start, "2026-11-22T10:00:00.000Z");
  assert.equal(opts.width, 900);
  assert.deepEqual(opts.awsArgs, ["a.mjs", "b"]);
  assert.equal(opts.awsBin, "node");
});

test("parseArgs rejects a missing, naive, reversed or too short window and unknown options", () => {
  const bad = [
    [["--end", END, "--out", "x"], /--start/],
    [["--start", START, "--out", "x"], /--end/],
    [["--start", START, "--end", END], /--out/],
    [["--start", "2026-11-22T10:00:00", "--end", END, "--out", "x"], /múi giờ/],
    [["--start", "hôm qua", "--end", END, "--out", "x"], /ISO/],
    [["--start", END, "--end", START, "--out", "x"], /trước/],
    [["--start", START, "--end", START, "--out", "x"], /trước/],
    [["--start", START, "--end", "2026-11-22T10:00:30Z", "--out", "x"], /60 giây/],
    [[...baseArgs("x"), "--khong-co", "1"], /không hỗ trợ/],
    [[...baseArgs("x"), "--width"], /--width/],
    [[...baseArgs("x"), "--width", "-5"], /--width/],
    [["--start", START, "--end", END, "--out", "x", "tham-so-le"], /tham số lạ/],
  ];
  for (const [argv, pattern] of bad) {
    assert.throws(() => parseArgs(argv), (e) => e instanceof UsageError && pattern.test(e.message), argv.join(" "));
  }
});

// TC-178-12
test("slugify strips Vietnamese diacritics and symbols into a short file-name part", () => {
  assert.equal(slugify("Chuyển tiền POST /v1/transfers: p95 và p99 (ms)"), "chuyen-tien-post-v1-transfers-p95-va-p99-ms");
  assert.equal(slugify("Đọc: p95 (ms)"), "doc-p95-ms");
  assert.equal(slugify("  --Cờ / 1.000 giao dịch--  "), "co-1-000-giao-dich");
  assert.equal(slugify("a".repeat(90)).length, 60);
  assert.equal(slugify("!!!"), "widget");
  assert.ok(!slugify("x  y___z").includes("--"));
});

test("every real widget title of dashboard.tf gives a valid, unique-numbered file name", () => {
  const tf = readFileSync(join(SESSION, "dashboard.tf"), "utf8");
  const titles = [...tf.matchAll(/^\s+title\s+= "([^"]+)"/gm)].map((m) => m[1]);
  assert.ok(titles.length >= 25, `đọc được ${titles.length} tiêu đề`);
  for (const title of titles) {
    const name = `01-${slugify(title)}.png`;
    assert.match(name, /^\d{2}-[a-z0-9]+(-[a-z0-9]+)*\.png$/, title);
    assert.ok(!/[^\x20-\x7e]/.test(name));
  }
});

// TC-178-13
test("periodFor never exceeds the window, stays a multiple of 60 and at least 60", () => {
  assert.equal(periodFor(3600, 900), 900);
  assert.equal(periodFor(900, 900), 900);
  assert.equal(periodFor(300, 900), 300);
  assert.equal(periodFor(60, 900), 60);
  assert.equal(periodFor(300, 270), 240);
  assert.equal(periodFor(300, 90), 60);
  assert.equal(periodFor(3600, 60), 60);
  assert.equal(periodFor(3600, 86400), 3600);
});

const window15 = { start: "2026-11-22T10:00:00.000Z", end: "2026-11-22T10:15:00.000Z", width: 1200, height: 450, windowSeconds: 900 };

test("widgetImageProperties turns a singleValue into a timeSeries over the absolute window", () => {
  const widget = metricWidget("Cờ / 1.000 giao dịch, 1 giờ gần nhất", {
    view: "singleValue", setPeriodToTimeRange: true, start: "-PT1H", end: "P0D",
    annotations: { horizontal: [{ label: "SLO", value: 20 }] }, yAxis: { left: { min: 0 } },
  });
  const copy = JSON.stringify(widget);
  const { properties, title } = widgetImageProperties(widget, window15);
  assert.equal(properties.view, "timeSeries");
  assert.equal(properties.setPeriodToTimeRange, undefined);
  assert.equal(properties.start, window15.start);
  assert.equal(properties.end, window15.end);
  assert.equal(properties.period, 300);
  assert.equal(properties.width, 1200);
  assert.equal(properties.height, 450);
  assert.match(properties.title, /^Cờ \/ 1\.000 giao dịch, 1 giờ gần nhất \(đồ thị trong khung chụp\)$/);
  assert.equal(title, "Cờ / 1.000 giao dịch, 1 giờ gần nhất");
  assert.deepEqual(properties.metrics, widget.properties.metrics);
  assert.deepEqual(properties.annotations, widget.properties.annotations);
  assert.deepEqual(properties.yAxis, widget.properties.yAxis);
  assert.equal(JSON.stringify(widget), copy, "widget gốc không bị đổi");
});

test("widgetImageProperties lowers an over-long period and says so in the title", () => {
  const { properties } = widgetImageProperties(metricWidget("Xu hướng", { period: 3600 }), window15);
  assert.equal(properties.period, 900);
  assert.match(properties.title, /\(period 3600 → 900 giây theo khung chụp\)$/);

  const keep = widgetImageProperties(metricWidget("Ngắn", { period: 60 }), window15).properties;
  assert.equal(keep.period, 60);
  assert.equal(keep.title, "Ngắn");

  const short = widgetImageProperties(metricWidget("Khung 270 s", { period: 300 }), { ...window15, windowSeconds: 270 }).properties;
  assert.equal(short.period, 240);
});

test("widgetImageProperties rewrites SEARCH periods so the trend widget has no 3600 left in a 15-minute window", () => {
  const search = (mode) => ({
    expression: `SUM(SEARCH('{"DBS/Backend",Role,RiskLevel,Mode,AiAdded} MetricName="risk_flag_total" Mode="${mode}"', 'Sum', 3600))`,
    id: mode,
    visible: false,
  });
  const trend = metricWidget("Cờ / 1.000 giao dịch: xu hướng và theo mode (period 3600)", {
    period: 3600,
    metrics: [
      ["DBS/Backend", "risk_flag_total", "Role", "worker", { id: "f", stat: "Sum", visible: false }],
      [search("rule_only")],
      [search("rules_with_external_ai")],
      [{ expression: "IF(d > 0, 1000 * FILL(f, 0) / d, 0)", label: "Tổng", id: "r" }],
    ],
  });
  const { properties } = widgetImageProperties(trend, window15);
  const text = JSON.stringify(properties);
  assert.ok(!text.includes("3600,") && !/'Sum', 3600/.test(text) && properties.period === 900);
  assert.match(properties.metrics[1][0].expression, /'Sum', 900\)\)$/);
  assert.match(properties.metrics[2][0].expression, /'Sum', 900\)\)$/);
  assert.match(properties.title, /\(period 3600 → 900 giây theo khung chụp\)$/);
  assert.equal(properties.metrics[3][0].expression, "IF(d > 0, 1000 * FILL(f, 0) / d, 0)");
  // một SEARCH 300 s trong khung 15 phút không đổi
  const keep = widgetImageProperties(
    metricWidget("Giữ", { metrics: [[{ expression: "SEARCH('{\"DBS/Backend\",Role} MetricName=\"x\"', 'Sum', 300)", id: "s" }]] }),
    window15,
  );
  assert.match(keep.properties.metrics[0][0].expression, /'Sum', 300\)$/);
});

// TC-178-14b: AWS CLI v2 đọc `file://` bằng bảng mã của máy (cp1252 trên Windows) và từ chối tiêu đề tiếng Việt viết UTF-8
// («Unable to load paramfile … text contents could not be decoded», gặp khi thử thật ở M-178-03): tệp MetricWidget phải thuần ASCII.
test("the MetricWidget temp file is pure ASCII (non-ASCII characters are written as unicode escapes) and still parses to the same title", async () => {
  const out = tmp();
  try {
    const { run, calls } = fakeRun();
    await snapshotDashboard({ run, opts: parseArgs(baseArgs(out)), log: () => {} });
    const images = calls.filter((c) => c.widgetRaw);
    assert.equal(images.length, 3);
    for (const c of images) {
      assert.ok(c.widgetRaw.every((byte) => byte < 0x80), "tệp MetricWidget có byte ngoài ASCII");
    }
    assert.ok(images.some((c) => c.widget.title === "Lưu lượng: request mỗi giây"), "tiêu đề tiếng Việt vẫn nguyên sau khi phân tích JSON");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// TC-178-14
test("snapshotDashboard renders every metric widget, skips text and alarm, and removes its temp files", async () => {
  const out = tmp();
  try {
    const { run, calls } = fakeRun();
    const { lines, log } = collect();
    const opts = parseArgs([...baseArgs(out), "--profile", "dbs"]);
    const result = await snapshotDashboard({ run, opts, log });
    assert.deepEqual({ rendered: result.rendered, skipped: result.skipped, failed: result.failed }, { rendered: 3, skipped: 2, failed: 0 });
    assert.equal(calls.filter((c) => c.args.includes("get-dashboard")).length, 1);
    assert.equal(calls.filter((c) => c.args.includes("get-metric-widget-image")).length, 3);
    assert.deepEqual(readdirSync(out).sort(), [
      "01-luu-luong-request-moi-giay.png",
      "02-do-tre-toan-dich-vu-ms.png",
      "03-co-1-000-giao-dich-1-gio-gan-nhat.png",
    ]);
    for (const name of readdirSync(out)) assert.deepEqual(readFileSync(join(out, name)), PNG);
    assert.ok(lines.some((l) => /^SKIP\s+text/.test(l)));
    assert.ok(lines.some((l) => /^SKIP\s+alarm/.test(l)));
    assert.ok(lines.some((l) => /3 ảnh, 2 bỏ qua, 0 lỗi/.test(l)));
    // MetricWidget mang start/end tuyệt đối, đúng region của widget, qua tệp tạm đã bị xóa
    for (const c of calls.filter((x) => x.widget)) {
      assert.equal(c.widget.start, "2026-11-22T10:00:00.000Z");
      assert.equal(c.widget.end, "2026-11-22T10:15:00.000Z");
      assert.equal(c.widget.region, "ap-southeast-1");
      assert.equal(existsSync(c.widgetPath), false, "tệp tạm phải bị xóa");
    }
    const single = calls.find((c) => c.widget?.title?.startsWith("Cờ / 1.000"));
    assert.equal(single.widget.view, "timeSeries");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("snapshotDashboard numbers images in reading order (y, then x) whatever the order in the body", async () => {
  const out = tmp();
  try {
    const dashboard = {
      widgets: [
        metricWidget("Thứ ba", {}, 6, 0),
        metricWidget("Thứ hai", {}, 0, 8),
        metricWidget("Thứ nhất", {}, 0, 0),
      ],
    };
    const { run } = fakeRun({ dashboard });
    await snapshotDashboard({ run, opts: parseArgs(baseArgs(out)), log: () => {} });
    assert.deepEqual(readdirSync(out).sort(), ["01-thu-nhat.png", "02-thu-hai.png", "03-thu-ba.png"]);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// TC-178-15, TC-178-16
test("a failing widget and a non-PNG answer are FAIL lines, the other widgets are still written", async () => {
  const out = tmp();
  try {
    let n = 0;
    const { run } = fakeRun({
      imageFor: () => {
        n += 1;
        if (n === 1) throw Object.assign(new Error("Command failed"), { stderr: "An error occurred (Throttling): Rate exceeded" });
        if (n === 2) return { stdout: JSON.stringify({ MetricWidgetImage: Buffer.from("khong phai png").toString("base64") }), stderr: "" };
        return { stdout: JSON.stringify({ MetricWidgetImage: PNG_B64 }), stderr: "" };
      },
    });
    const { lines, log } = collect();
    const result = await snapshotDashboard({ run, opts: parseArgs(baseArgs(out)), log });
    assert.equal(result.failed, 2);
    assert.equal(result.rendered, 1);
    assert.deepEqual(readdirSync(out), ["03-co-1-000-giao-dich-1-gio-gan-nhat.png"]);
    assert.ok(lines.some((l) => /^FAIL .*Lưu lượng.*Throttling/.test(l)));
    assert.ok(lines.some((l) => /^FAIL .*Độ trễ.*PNG/.test(l)));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("a warning on stderr with a valid PNG is a success and is printed; the same words with a non-PNG fail", async () => {
  const out = tmp();
  try {
    const { run } = fakeRun({
      imageFor: (call) =>
        call.widget.title.startsWith("Lưu lượng")
          ? { stdout: JSON.stringify({ MetricWidgetImage: PNG_B64 }), stderr: "Warning: invalid input in metric widget\n" }
          : { stdout: JSON.stringify({ MetricWidgetImage: Buffer.from("invalid input").toString("base64") }), stderr: "invalid input\n" },
    });
    const { lines, log } = collect();
    const result = await snapshotDashboard({ run, opts: parseArgs(baseArgs(out)), log });
    assert.equal(result.rendered, 1);
    assert.equal(result.failed, 2);
    assert.ok(lines.some((l) => /^OK .*01-luu-luong/.test(l)));
    assert.ok(lines.some((l) => /cảnh báo: .*invalid input/.test(l)));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// TC-178-17
test("main exits 1 and writes nothing when get-dashboard fails, answers badly or has no widget", async () => {
  for (const scenario of ["loi", "khong-phai-json", "khong-widget", "body-khong-phai-json"]) {
    const out = join(tmp(), "ra");
    try {
      const run = async () => {
        if (scenario === "loi") throw Object.assign(new Error("Command failed"), { stderr: "ResourceNotFound" });
        if (scenario === "khong-phai-json") return { stdout: "<html>", stderr: "" };
        if (scenario === "khong-widget") return { stdout: JSON.stringify({ DashboardBody: JSON.stringify({ widgets: [] }) }), stderr: "" };
        return { stdout: JSON.stringify({ DashboardBody: "{cut" }), stderr: "" };
      };
      const { lines, log } = collect();
      const code = await main(baseArgs(out), { run, log, err: log });
      assert.equal(code, 1, scenario);
      assert.equal(existsSync(out), false, `${scenario}: không tạo thư mục ảnh`);
      assert.ok(lines.length > 0);
    } finally {
      rmSync(join(out, ".."), { recursive: true, force: true });
    }
  }
});

test("main exits 2 on bad arguments without calling aws", async () => {
  let called = 0;
  const { lines, log } = collect();
  const code = await main(["--start", END, "--end", START, "--out", "x"], { run: async () => { called += 1; return { stdout: "", stderr: "" }; }, log, err: log });
  assert.equal(code, 2);
  assert.equal(called, 0);
  assert.ok(lines.some((l) => /trước/.test(l)));
});

test("aws is called without a shell: the MetricWidget JSON stays out of argv and the global options are present", async () => {
  const out = tmp();
  try {
    const { run, calls } = fakeRun();
    const opts = parseArgs([...baseArgs(out), "--profile", "dbs", "--region", "ap-southeast-1", "--aws-bin", "node", "--aws-arg", "fake.mjs"]);
    await snapshotDashboard({ run, opts, log: () => {} });
    for (const c of calls) {
      assert.equal(c.file, "node");
      assert.equal(c.args[0], "fake.mjs");
      for (const flag of ["--output", "--no-cli-pager", "--region"]) assert.ok(c.args.includes(flag), `${flag} thiếu`);
      assert.equal(c.args[c.args.indexOf("--output") + 1], "json");
      assert.equal(c.args[c.args.indexOf("--profile") + 1], "dbs");
      assert.ok(!c.args.some((a) => a.includes("{") || a.includes("timeSeries")), "thân JSON không nằm trong argv");
    }
    const image = calls.find((c) => c.args.includes("get-metric-widget-image"));
    assert.match(image.args[image.args.indexOf("--metric-widget") + 1], /^file:\/\/.+/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("each widget is rendered in its own region, whatever --region says", async () => {
  const out = tmp();
  try {
    const dashboard = { widgets: [metricWidget("Ở Singapore", { region: "ap-southeast-1" })] };
    const { run, calls } = fakeRun({ dashboard });
    await snapshotDashboard({ run, opts: parseArgs([...baseArgs(out), "--region", "us-east-1"]), log: () => {} });
    const dash = calls.find((c) => c.args.includes("get-dashboard"));
    const image = calls.find((c) => c.args.includes("get-metric-widget-image"));
    assert.equal(dash.args[dash.args.indexOf("--region") + 1], "us-east-1");
    assert.equal(image.args[image.args.indexOf("--region") + 1], "ap-southeast-1");
    assert.equal(image.widget.region, "ap-southeast-1");
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// TC-178-21
test("ARNs and 12-digit account ids never reach the output, including AWS CLI errors and warnings", async () => {
  assert.equal(
    redact("User: arn:aws:iam::123456789012:user/nguoi-dung on arn:aws:cloudwatch::123456789012:dashboard/x, acct 210987654321."),
    "User: <arn> on <arn>, acct <acct>.",
  );
  assert.equal(redact("12345678901 và 1234567890123 giữ nguyên"), "12345678901 và 1234567890123 giữ nguyên");

  const out = tmp();
  try {
    const { run } = fakeRun({
      imageFor: (call) => {
        if (call.widget.title.startsWith("Lưu lượng")) {
          throw Object.assign(new Error("Command failed"), {
            stderr: "AccessDenied: User: arn:aws:iam::123456789012:user/nguoi-dung is not authorized on arn:aws:cloudwatch::123456789012:dashboard/dbs-dev-overview",
          });
        }
        return { stdout: JSON.stringify({ MetricWidgetImage: PNG_B64 }), stderr: "Warning for account 123456789012 arn:aws:iam::123456789012:root\n" };
      },
    });
    const { lines, log } = collect();
    const result = await snapshotDashboard({ run, opts: parseArgs(baseArgs(out)), log });
    assert.equal(result.failed, 1);
    const printed = lines.join("\n");
    assert.ok(!/123456789012|arn:aws/.test(printed), printed);
    assert.ok(/<arn>/.test(printed) && /<acct>/.test(printed));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// TC-178-22: đường execFile thật, không qua `run` giả. Bản `node` trên PATH có thể khác bản chạy test: dùng process.execPath.
function runCli(extraEnv, args) {
  try {
    const stdout = execFileSync(process.execPath, [SNAPSHOT, ...args], {
      env: { ...process.env, ...extraEnv },
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, stdout, stderr: "" };
  } catch (error) {
    return { code: error.status, stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
  }
}

test("the real CLI writes PNGs through execFile with the fake aws and exits 0", () => {
  const out = tmp();
  const log = join(out, "calls.jsonl");
  try {
    const images = join(out, "anh");
    const result = runCli({ FAKE_AWS_LOG: log }, [...baseArgs(images), "--aws-bin", process.execPath, "--aws-arg", FAKE_AWS, "--profile", "dbs"]);
    assert.equal(result.code, 0, result.stdout + result.stderr);
    assert.deepEqual(readdirSync(images).sort(), [
      "01-luu-luong-request-moi-giay.png",
      "02-do-tre-ms.png",
      "03-co-1-000-giao-dich-1-gio-gan-nhat.png",
    ]);
    assert.deepEqual(readFileSync(join(images, "01-luu-luong-request-moi-giay.png")), PNG);
    assert.match(result.stdout, /3 ảnh, 2 bỏ qua, 0 lỗi/);
    const calls = readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(calls.length, 4);
    assert.ok(calls.every((a) => a.includes("--profile") && a.includes("--no-cli-pager")));
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test("the real CLI exits 2 on bad arguments and 1 on an AWS error with the ARN redacted", () => {
  const out = tmp();
  try {
    const bad = runCli({}, ["--start", END, "--end", START, "--out", join(out, "x")]);
    assert.equal(bad.code, 2);
    assert.equal(existsSync(join(out, "x")), false);

    const denied = runCli({ FAKE_AWS_FAIL: "1" }, [...baseArgs(join(out, "y")), "--aws-bin", process.execPath, "--aws-arg", FAKE_AWS]);
    assert.equal(denied.code, 1);
    const printed = denied.stdout + denied.stderr;
    assert.ok(!/123456789012|arn:aws/.test(printed), printed);
    assert.ok(/AccessDenied/.test(printed));
    assert.equal(existsSync(join(out, "y")), false);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

// TC-178-20: hợp đồng giữa alarms.tf, base/alarms.tf và danh sách tên của dashboard.tf. Hàm thuần nhận NỘI DUNG tệp.
export function alarmContract({ sessionAlarms, baseAlarms, dashboard }) {
  const problems = [];
  const names = [...sessionAlarms.matchAll(/alarm_name\s*=\s*"([^"]+)"/g), ...baseAlarms.matchAll(/alarm_name\s*=\s*"([^"]+)"/g)].map((m) => m[1]);
  const block = dashboard.match(/dash_alarm_names\s*=\s*concat\(\s*\[([^\]]*)\]/);
  const listed = block ? [...block[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]) : [];
  if (!block) problems.push("dashboard.tf không có local dash_alarm_names");
  const literals = new Set();
  for (const name of names) {
    if (!name.includes("${")) {
      literals.add(name);
      if (!listed.includes(name)) problems.push(`alarm ${name} chưa có trong dash_alarm_names`);
      continue;
    }
    const pattern = name.replace(/\$\{[^}]*\}/g, "*");
    if (pattern === "dbs-dev-*-dlq-oldest-age") continue; // ngoại lệ tường minh: chưa apply ở base (BL-409)
    if (pattern === "*-age") {
      if (!/\[for \w+ in local\.queue_names : "\$\{\w+\}-age"\]/.test(dashboard)) problems.push("thiếu biểu thức queue_names -age");
    } else if (pattern === "dbs-dev-*-dlq-not-empty") {
      if (!/"dbs-dev-\$\{\w+\}-dlq-not-empty"/.test(dashboard)) problems.push("thiếu biểu thức -dlq-not-empty");
    } else {
      problems.push(`mẫu alarm_name lạ: ${name}`);
    }
  }
  for (const item of listed) if (!literals.has(item)) problems.push(`dash_alarm_names có ${item} nhưng không alarm nào mang tên đó`);
  return problems;
}

const read = (path) => readFileSync(join(REPO, path), "utf8");

test("the real alarms.tf, base/alarms.tf and dashboard.tf agree on the alarm names", () => {
  const problems = alarmContract({
    sessionAlarms: read("infra/terraform/envs/dev/session/alarms.tf"),
    baseAlarms: read("infra/terraform/envs/dev/base/alarms.tf"),
    dashboard: read("infra/terraform/envs/dev/session/dashboard.tf"),
  });
  assert.deepEqual(problems, []);
});

test("the alarm contract goes red when an alarm is added, renamed or templated differently", () => {
  const files = {
    sessionAlarms: read("infra/terraform/envs/dev/session/alarms.tf"),
    baseAlarms: read("infra/terraform/envs/dev/base/alarms.tf"),
    dashboard: read("infra/terraform/envs/dev/session/dashboard.tf"),
  };
  const added = alarmContract({ ...files, sessionAlarms: `${files.sessionAlarms}\n  alarm_name = "dbs-dev-moi"\n` });
  assert.deepEqual(added, ["alarm dbs-dev-moi chưa có trong dash_alarm_names"]);

  const template = alarmContract({ ...files, baseAlarms: `${files.baseAlarms}\n  alarm_name = "dbs-dev-\${each.key}-lạ"\n` });
  assert.equal(template.length, 1);
  assert.match(template[0], /mẫu alarm_name lạ/);

  const dropped = alarmContract({ ...files, dashboard: files.dashboard.replace('      "dbs-dev-outbox-age",\n', "") });
  assert.deepEqual(dropped, ["alarm dbs-dev-outbox-age chưa có trong dash_alarm_names"]);

  const typo = alarmContract({ ...files, dashboard: files.dashboard.replace('"dbs-dev-outbox-age",', '"dbs-dev-outbox-age",\n      "dbs-dev-khong-co",') });
  assert.deepEqual(typo, ["dash_alarm_names có dbs-dev-khong-co nhưng không alarm nào mang tên đó"]);

  const noQueue = alarmContract({ ...files, dashboard: files.dashboard.replace(/"\$\{n\}-age"/, '"${n}-tuoi"') });
  assert.deepEqual(noQueue, ["thiếu biểu thức queue_names -age"]);
});
