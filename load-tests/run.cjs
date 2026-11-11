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
      for (const c of fixture.customers) {
        const claims = JSON.parse(
          Buffer.from(c.token.split(".")[1], "base64url").toString(),
        );
        if (
          claims.sub !== c.sub ||
          !Number.isFinite(claims.exp) ||
          claims.exp < Date.now() / 1000 + durationSeconds(kind, smoke) + 60
        )
          throw new Error("Token expires before run ends");
      }
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
        tsArgs(join(backend, "test/support/invariants.ts")),
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
      console.log(`invariantExit=${r.status ?? 2}; results=${results}`);
      return r.status ?? 2;
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
module.exports = { runChecked, main };
