/**
 * BL-415 manual evidence: the REAL k6 and the REAL lib/client.js against a local server that answers every request
 * with 429 (what a WAF or an ALB does under pressure). For each scenario name the run is given in LOAD_SCENARIO, the
 * rate `system_errors` of k6 must be 1 (every 429 is a system error) except in `rate-limit`, where 429 is the answer
 * of the application limiter under test and the rate must be 0.
 *
 *   node load-tests/test/status-429.manual.mjs        (k6 on PATH, or K6_BIN)
 *
 * No Docker, no database: a throw-away HTTP server on 127.0.0.1 and k6 only. Exit 0 when every scenario behaves.
 */
import { createServer } from "node:http";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { SCENARIOS } from "../lib/config.js";

const here = import.meta.dirname;
const k6 = process.env.K6_BIN || "k6";
const server = createServer((req, res) => {
  req.resume();
  res.writeHead(429, {
    "Content-Type": "application/problem+json",
    "Retry-After": "1",
  });
  res.end(JSON.stringify({ errorCode: "RATE_LIMITED" }));
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const baseUrl = `http://127.0.0.1:${server.address().port}`;
const dir = mkdtempSync(join(tmpdir(), "bl415-"));
const customer = (n) => ({
  sub: `khach-${n}`,
  accountId: `00000000-0000-4000-8000-00000000000${n}`,
  token: "aaa.bbb.ccc",
});
const fixturePath = join(dir, "fixture.json");
writeFileSync(
  fixturePath,
  JSON.stringify({ baseUrl, customers: [1, 2, 3].map(customer) }),
);

let failed = false;
console.log("scenario     system_errors  http_req_failed  expected  429s seen  result");
for (const scenario of SCENARIOS) {
  const summary = join(dir, `${scenario}.json`);
  // asynchronous on purpose: a blocking spawn would freeze this process and with it the server k6 talks to
  const status = await new Promise((done) => {
    const child = spawn(
      k6,
      [
        "run",
        "--quiet",
        "--summary-export",
        summary,
        resolve(here, "status-429.probe.js"),
      ],
      {
        env: {
          ...process.env,
          BASE_URL: baseUrl,
          LOAD_FIXTURE: fixturePath,
          LOAD_RUN_ID: "bl415",
          LOAD_SCENARIO: scenario,
        },
        stdio: "ignore",
      },
    );
    child.on("error", (error) => {
      console.error(`cannot run k6 (${k6}): ${error.message}. Put k6 on PATH or set K6_BIN.`);
      process.exit(2);
    });
    child.on("exit", done);
  });
  const metrics = JSON.parse(readFileSync(summary, "utf8")).metrics;
  const rate = metrics.system_errors.value;
  const got429 = metrics.checks.passes; // the probe's "answer is 429" check: 20 of 20
  const expected = scenario === "rate-limit" ? 0 : 1;
  // the same answer seen through the other path, k6's own expectedStatuses (http_req_failed)
  const failedRate = metrics.http_req_failed.value;
  const ok = rate === expected && failedRate === expected && got429 === 20;
  failed ||= !ok;
  console.log(
    `${scenario.padEnd(12)} ${String(rate).padEnd(14)} ${String(failedRate).padEnd(16)} ${String(expected).padEnd(9)} ${String(got429).padEnd(9)} ${ok ? "ok" : "WRONG"} (k6 exit ${status})`,
  );
}
server.close();
rmSync(dir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
