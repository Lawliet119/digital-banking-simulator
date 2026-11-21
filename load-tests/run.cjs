const { spawnSync } = require("node:child_process");
const {
  mkdirSync,
  readFileSync,
  existsSync,
  writeFileSync,
} = require("node:fs");
const { resolve, join } = require("node:path");
const { randomUUID } = require("node:crypto");
const backend = resolve(__dirname, "../backend");
const register = [
  join(backend, "node_modules/ts-node/register"),
  join(backend, "node_modules/tsconfig-paths/register"),
];
const tsArgs = (file) => [...register.flatMap((p) => ["-r", p]), file];
// The CLI itself (BL-128). The old test-support path only re-exports it, so running that file
// exits 0 without checking anything (found by DBS-166 on a real run).
const checkerFile = join(backend, "src/scripts/invariants/invariants.ts");

/**
 * Exit 0 only when the CLI exited 0 AND printed a PASS report. A silent exit 0 means the checker never
 * ran, which is "not checked" (2), never a pass. 1 (violations) and 2 (check error) pass through.
 */
function checkerExit({ status, stdout }) {
  if (status !== 0) return status ?? 2;
  for (const line of String(stdout || "").split(/\r?\n/)) {
    if (!line.startsWith("{")) continue;
    try {
      if (JSON.parse(line).status === "PASS") return 0;
    } catch {
      // not the report line
    }
  }
  return 2;
}

async function runChecked({ load, check }) {
  let code = 1;
  try {
    code = await load();
  } catch {
    code = 1;
  }
  try {
    const checked = await check();
    // Keep the load tool's own failure code; the checker code only replaces a clean 0.
    if (checked && code === 0) code = checked;
  } catch {
    code = 2;
  }
  return Number.isInteger(code) ? code : 1;
}
async function main(argv = process.argv.slice(2)) {
  const {
    SCENARIOS,
    validateFixture,
    assertTokensOutliveRun,
    durationSeconds,
    maxTransfers,
    requireBudget,
    cleanUrl,
  } = await import("./lib/config.js");
  const kind = argv[0],
    smoke = argv.includes("--smoke");
  if (!SCENARIOS.includes(kind) || argv.some((v, i) => i && v !== "--smoke"))
    throw new Error("Usage: node load-tests/run.cjs <scenario> [--smoke]");
  if (!process.env.DATABASE_URL || process.env.LOAD_DEDICATED !== "1")
    throw new Error(
      "DATABASE_URL and LOAD_DEDICATED=1 are required; use an isolated load database",
    );
  if (process.env.K6_HTTP_DEBUG)
    throw new Error("HTTP debug would expose tokens");
  const baseUrl = cleanUrl(process.env.BASE_URL);
  if (process.env.API_URL_2) cleanUrl(process.env.API_URL_2);
  const runId = randomUUID(),
    results = resolve(__dirname, "results", `${kind}-${runId}`);
  mkdirSync(results, { recursive: true });
  const env = {
    ...process.env,
    BASE_URL: baseUrl,
    LOAD_RUN_ID: runId,
    LOAD_SCENARIO: kind, // lib/client.js: 429 is valid only for "rate-limit" (BL-415)
    SMOKE: smoke ? "1" : "0",
    LOAD_FIXTURE: resolve(
      process.env.LOAD_FIXTURE || join(results, "fixture.json"),
    ),
  };
  const spawn = (cmd, args, opts = {}) => {
    const r = spawnSync(cmd, args, {
      cwd: backend,
      env,
      stdio: "inherit",
      windowsHide: true,
      ...opts,
    });
    return r.status ?? 1;
  };
  const { snapshot, verifyDuplicate } = require("./postflight.cjs");
  const code = await runChecked({
    load: async () => {
      if (!existsSync(env.LOAD_FIXTURE)) {
        if (spawn(process.execPath, tsArgs(join(__dirname, "prepare.cjs"))))
          return 1;
      }
      const fixture = validateFixture(
        JSON.parse(readFileSync(env.LOAD_FIXTURE, "utf8")),
        baseUrl,
      );
      assertTokensOutliveRun(fixture, durationSeconds(kind, smoke));
      const before = await snapshot(fixture);
      const total = maxTransfers(kind, smoke);
      const sources = ["hot-account", "duplicate", "rate-limit"].includes(kind)
        ? [fixture.customers[0]]
        : fixture.customers;
      for (const c of sources)
        requireBudget(
          before.accounts.find((a) => a.id === c.accountId),
          Math.ceil(total / sources.length),
        );
      console.log(
        JSON.stringify({
          scenario: kind,
          profile: smoke ? "smoke" : "full",
          runId,
          dedicated: true,
          cloudAcceptance: false,
        }),
      );
      const status = spawn(
        process.env.K6_BIN || "k6",
        [
          "run",
          "--out",
          `json=${join(results, "raw.json")}`,
          "--summary-export",
          join(results, "summary.json"),
          join(__dirname, `${kind}.js`),
        ],
        { cwd: __dirname, timeout: (durationSeconds(kind, smoke) + 60) * 1000 },
      );
      if (kind === "duplicate") {
        const summary = JSON.parse(
          readFileSync(join(results, "summary.json"), "utf8"),
        );
        await verifyDuplicate(
          before,
          fixture,
          runId,
          summary.metrics.duplicate_bursts?.count,
        );
      }
      return status;
    },
    check: () => {
      // Always check, including seed/preflight/load failure. Nothing silently becomes PASS.
      const r = spawnSync(
        process.execPath,
        tsArgs(checkerFile),
        {
          cwd: backend,
          env,
          encoding: "utf8",
          windowsHide: true,
          timeout: 60000,
        },
      );
      const output = (r.stdout || "") + (r.stderr || "");
      writeFileSync(join(results, "invariants.txt"), output);
      process.stdout.write(output);
      const exitCode = checkerExit(r);
      console.log(`invariantExit=${exitCode}; results=${results}`);
      return exitCode;
    },
  });
  if (code)
    console.error(
      "Load run FAILED; inspect k6 summary, fixture expiry/budget and invariant report",
    );
  return code;
}
if (require.main === module)
  main()
    .then((code) => {
      process.exitCode = code;
    })
    .catch((error) => {
      console.error(
        error.message.startsWith("Usage:")
          ? error.message
          : "Invalid load configuration; verify isolated DATABASE_URL, BASE_URL, fixture and auth",
      );
      process.exitCode = 2;
    });
module.exports = { runChecked, main, checkerExit, checkerFile };
