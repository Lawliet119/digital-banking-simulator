#!/usr/bin/env node
// DBS-178: `aws` giả cho test của dashboard-snapshot.mjs. Chạy bằng `node` (execFile không qua shell không chạy được tệp .mjs trực tiếp):
//   dashboard-snapshot.mjs --aws-bin <đường dẫn node> --aws-arg <tệp này> ...
// Hỗ trợ đúng hai lệnh mà công cụ chụp gọi:
//   cloudwatch get-dashboard            -> {"DashboardName": ..., "DashboardBody": "<json>"}; thân lấy từ FAKE_DASHBOARD_BODY_FILE
//                                          hoặc một dashboard nhỏ dựng sẵn (text, alarm, ba metric trong đó một singleValue)
//   cloudwatch get-metric-widget-image  -> {"MetricWidgetImage": "<base64 của PNG 1x1>"}; kiểm --metric-widget file://... là JSON có
//                                          start và end tuyệt đối
// FAKE_AWS_LOG: tệp để ghi mỗi lệnh gọi một dòng JSON (argv). FAKE_AWS_FAIL=1: thoát 254 với thông báo AccessDenied có ARN và ID giả.
import { appendFileSync, readFileSync } from "node:fs";

const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

const args = process.argv.slice(2);
if (process.env.FAKE_AWS_LOG) appendFileSync(process.env.FAKE_AWS_LOG, `${JSON.stringify(args)}\n`);

if (process.env.FAKE_AWS_FAIL === "1") {
  process.stderr.write(
    "An error occurred (AccessDenied) when calling the GetDashboard operation: User: arn:aws:iam::123456789012:user/nguoi-dung is not authorized to perform: cloudwatch:GetDashboard on resource: arn:aws:cloudwatch::123456789012:dashboard/dbs-dev-overview\n",
  );
  process.exit(254);
}

const metric = (title, extra = {}) => ({
  type: "metric",
  x: 0,
  y: 0,
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

const DEFAULT_BODY = {
  start: "-PT3H",
  periodOverride: "inherit",
  widgets: [
    { type: "text", x: 0, y: 0, width: 24, height: 2, properties: { markdown: "## Tiêu đề" } },
    {
      type: "alarm",
      x: 0,
      y: 2,
      width: 12,
      height: 6,
      properties: { title: "Trạng thái alarm", alarms: ["arn:aws:cloudwatch:ap-southeast-1:123456789012:alarm:dbs-dev-x"] },
    },
    { ...metric("Lưu lượng: request mỗi giây"), y: 8 },
    { ...metric("Độ trễ (ms)"), x: 8, y: 8 },
    {
      ...metric("Cờ / 1.000 giao dịch, 1 giờ gần nhất", { view: "singleValue", setPeriodToTimeRange: true, start: "-PT1H", end: "P0D" }),
      x: 16,
      y: 8,
    },
  ],
};

const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

const [service, command] = args.filter((a) => !a.startsWith("--") && !a.endsWith(".mjs")).slice(0, 2);
if (service !== "cloudwatch") {
  process.stderr.write(`fake-aws: không hỗ trợ ${service}\n`);
  process.exit(252);
}

if (command === "get-dashboard") {
  const file = process.env.FAKE_DASHBOARD_BODY_FILE;
  const body = file ? readFileSync(file, "utf8") : JSON.stringify(DEFAULT_BODY);
  process.stdout.write(`${JSON.stringify({ DashboardName: flag("--dashboard-name"), DashboardBody: body })}\n`);
} else if (command === "get-metric-widget-image") {
  const ref = flag("--metric-widget") ?? "";
  if (!ref.startsWith("file://")) {
    process.stderr.write("fake-aws: --metric-widget phải là file://\n");
    process.exit(251);
  }
  const widget = JSON.parse(readFileSync(ref.slice("file://".length), "utf8"));
  if (typeof widget.start !== "string" || typeof widget.end !== "string" || /^-?P/.test(widget.start)) {
    process.stderr.write("fake-aws: start/end phải tuyệt đối\n");
    process.exit(250);
  }
  process.stdout.write(`${JSON.stringify({ MetricWidgetImage: PNG_1X1 })}\n`);
} else {
  process.stderr.write(`fake-aws: không hỗ trợ ${command}\n`);
  process.exit(253);
}
