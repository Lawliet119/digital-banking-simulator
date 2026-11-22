// usage: node cw-export.mjs <startISO> <endISO> <outFile> <albDim> <tgDim>
// Exports per-minute CloudWatch series for a load window and prints a compact summary per series.
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [, , start, end, out, alb, tg] = process.argv;
const dim = (n, v) => ({ Name: n, Value: v });
const q = (id, ns, metric, dims, stat, label) => ({
  Id: id,
  Label: label,
  MetricStat: { Metric: { Namespace: ns, MetricName: metric, Dimensions: dims }, Period: 60, Stat: stat },
});
const queries = [
  q("rds_cpu_avg", "AWS/RDS", "CPUUtilization", [dim("DBInstanceIdentifier", "dbs-dev")], "Average", "RDS CPU % (avg)"),
  q("rds_cpu_max", "AWS/RDS", "CPUUtilization", [dim("DBInstanceIdentifier", "dbs-dev")], "Maximum", "RDS CPU % (max)"),
  q("rds_surplus", "AWS/RDS", "CPUSurplusCreditBalance", [dim("DBInstanceIdentifier", "dbs-dev")], "Maximum", "RDS CPU surplus credit balance (max, unlimited mode)"),
  q("rds_conn", "AWS/RDS", "DatabaseConnections", [dim("DBInstanceIdentifier", "dbs-dev")], "Maximum", "RDS connections (max)"),
  q("rds_credit", "AWS/RDS", "CPUCreditBalance", [dim("DBInstanceIdentifier", "dbs-dev")], "Minimum", "RDS CPU credit balance (min)"),
  q("api_cpu_avg", "AWS/ECS", "CPUUtilization", [dim("ClusterName", "dbs-dev"), dim("ServiceName", "api")], "Average", "api service CPU % (avg of tasks)"),
  q("api_cpu_max", "AWS/ECS", "CPUUtilization", [dim("ClusterName", "dbs-dev"), dim("ServiceName", "api")], "Maximum", "api service CPU % (max)"),
  q("api_mem_max", "AWS/ECS", "MemoryUtilization", [dim("ClusterName", "dbs-dev"), dim("ServiceName", "api")], "Maximum", "api service memory % (max)"),
  q("worker_cpu_avg", "AWS/ECS", "CPUUtilization", [dim("ClusterName", "dbs-dev"), dim("ServiceName", "worker")], "Average", "worker CPU % (avg)"),
  // DBS-174: đỉnh CPU và bộ nhớ worker, độ sâu và tuổi queue risk (backlog của đường bất đồng bộ), DLQ.
  q("worker_cpu_max", "AWS/ECS", "CPUUtilization", [dim("ClusterName", "dbs-dev"), dim("ServiceName", "worker")], "Maximum", "worker CPU % (max)"),
  q("worker_mem_max", "AWS/ECS", "MemoryUtilization", [dim("ClusterName", "dbs-dev"), dim("ServiceName", "worker")], "Maximum", "worker memory % (max)"),
  q("risk_q_depth", "AWS/SQS", "ApproximateNumberOfMessagesVisible", [dim("QueueName", "dbs-dev-risk-events")], "Maximum", "risk-events queue visible messages (max)"),
  q("risk_q_age", "AWS/SQS", "ApproximateAgeOfOldestMessage", [dim("QueueName", "dbs-dev-risk-events")], "Maximum", "risk-events oldest message age (s, max)"),
  q("risk_dlq_depth", "AWS/SQS", "ApproximateNumberOfMessagesVisible", [dim("QueueName", "dbs-dev-risk-events-dlq")], "Maximum", "risk-events DLQ visible messages (max)"),
  q("alb_req", "AWS/ApplicationELB", "RequestCount", [dim("LoadBalancer", alb)], "Sum", "ALB requests per minute"),
  q("alb_elb5xx", "AWS/ApplicationELB", "HTTPCode_ELB_5XX_Count", [dim("LoadBalancer", alb)], "Sum", "ALB-generated 5xx"),
  q("alb_tgt5xx", "AWS/ApplicationELB", "HTTPCode_Target_5XX_Count", [dim("LoadBalancer", alb), dim("TargetGroup", tg)], "Sum", "target 5xx"),
  q("alb_rt_p95", "AWS/ApplicationELB", "TargetResponseTime", [dim("LoadBalancer", alb), dim("TargetGroup", tg)], "p95", "ALB TargetResponseTime p95 (s)"),
  q("alb_rt_p99", "AWS/ApplicationELB", "TargetResponseTime", [dim("LoadBalancer", alb), dim("TargetGroup", tg)], "p99", "ALB TargetResponseTime p99 (s)"),
  q("waf_rl", "AWS/WAFV2", "BlockedRequests", [dim("WebACL", "dbs-dev-waf"), dim("Rule", "dbs-dev-waf-rate-limit"), dim("Region", "ap-southeast-1")], "Sum", "WAF rate-limit blocked"),
  q("waf_all", "AWS/WAFV2", "BlockedRequests", [dim("WebACL", "dbs-dev-waf"), dim("Rule", "ALL"), dim("Region", "ap-southeast-1")], "Sum", "WAF blocked (all rules)"),
  q("app_transfer_p95", "DBS/Backend", "http_request_duration_ms", [dim("Route", "/v1/transfers"), dim("Method", "POST")], "p95", "server POST /v1/transfers p95 (ms)"),
  q("app_transfer_p99", "DBS/Backend", "http_request_duration_ms", [dim("Route", "/v1/transfers"), dim("Method", "POST")], "p99", "server POST /v1/transfers p99 (ms)"),
  q("app_balance_p95", "DBS/Backend", "http_request_duration_ms", [dim("Route", "/v1/accounts/:id"), dim("Method", "GET")], "p95", "server GET /v1/accounts/:id p95 (ms)"),
  q("app_5xx", "DBS/Backend", "http_5xx_total", [dim("Route", "/v1/transfers"), dim("Method", "POST")], "Sum", "server 5xx POST /v1/transfers"),
  q("flag_p95", "DBS/Backend", "risk_transfer_to_flag_ms", [dim("Role", "worker")], "p95", "risk_transfer_to_flag_ms p95"),
  q("outbox_age", "DBS/Backend", "outbox_oldest_unpublished_age_seconds", [], "Maximum", "outbox oldest unpublished age (s, max)"),
];
const input = {
  MetricDataQueries: queries.map((x, i) => ({ ...x, ReturnData: true })),
  StartTime: start,
  EndTime: end,
};
const file = join(tmpdir(), `cw-${Date.now()}.json`);
const result = {};
// get-metric-data allows 500 queries; one call. Pagination is handled by the CLI.
writeFileSync(file, JSON.stringify(input));
const raw = JSON.parse(
  execFileSync("aws", ["cloudwatch", "get-metric-data", "--cli-input-json", `file://${file}`, "--output", "json"], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    env: { ...process.env, MSYS_NO_PATHCONV: "1" },
  }),
);
for (const r of raw.MetricDataResults) {
  const pts = r.Timestamps.map((t, i) => [t, r.Values[i]]).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  result[r.Id] = { label: r.Label, points: pts };
}
writeFileSync(out, JSON.stringify({ start, end, period: 60, series: result }));
const f = (n) => (n === undefined ? "n/a" : Number(n.toFixed(3)));
for (const [id, s] of Object.entries(result)) {
  const v = s.points.map((p) => p[1]);
  if (!v.length) {
    console.log(`${id.padEnd(18)} no data`);
    continue;
  }
  const sum = v.reduce((a, b) => a + b, 0);
  console.log(`${id.padEnd(18)} n=${String(v.length).padStart(3)} min=${f(Math.min(...v))} avg=${f(sum / v.length)} max=${f(Math.max(...v))} sum=${f(sum)}  ${s.label}`);
}
