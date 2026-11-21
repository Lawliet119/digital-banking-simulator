// usage: node summarize.mjs <runDir>
import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
const read = (f) => JSON.parse(readFileSync(join(dir, f), "utf8"));
const exit = read("exit.json");
const agg = read("aggregate.json");
console.log(`### ${exit.scenario} · ${exit.startedAt} → ${exit.finishedAt} · runExit=${exit.runExit} invariantExit=${exit.invariantExit}`);
console.log("");
if (Object.keys(agg.plateaus).length) {
  console.log("| plateau (RPS) | yêu cầu | RPS đạt được | lỗi hệ thống | tỉ lệ lỗi | dropped | DoD 3 (<0,1% và 0 dropped) |");
  console.log("|---|---|---|---|---|---|---|");
  for (const [n, p] of Object.entries(agg.plateaus).sort((a, b) => a[0] - b[0]))
    console.log(`| ${n} | ${p.requests} | ${p.achievedRps} | ${p.systemErrors} | ${(p.errorRate * 100).toFixed(4)}% | ${p.droppedIterations} | ${p.meetsDoD3 ? "đạt" : "không đạt"} |`);
  console.log("");
}
console.log("| scenario | request | số lượng | status | p50 ms | p95 ms | p99 ms | max ms | lỗi hệ thống |");
console.log("|---|---|---|---|---|---|---|---|---|");
for (const [sc, names] of Object.entries(agg.byScenario))
  for (const [name, g] of Object.entries(names))
    console.log(`| ${sc} | ${name} | ${g.count} | ${Object.entries(g.status).map(([k, v]) => `${k}:${v}`).join(" ")} | ${g.p50} | ${g.p95} | ${g.p99} | ${g.max} | ${g.systemErrors} |`);
console.log("");
console.log(`unexpected429=${agg.unexpected429} window=${agg.window.start}..${agg.window.end} system_errors(k6 metric)=${agg.systemErrors.errors}/${agg.systemErrors.total}`);
const log = join(dir, "run.log");
if (existsSync(log)) {
  const t = readFileSync(log, "utf8");
  const a = t.indexOf("█ THRESHOLDS");
  const b = t.indexOf("█ TOTAL RESULTS");
  if (a >= 0 && b > a) console.log("\nk6 thresholds:\n" + t.slice(a, b).split("\n").filter((l) => l.trim()).join("\n"));
}
