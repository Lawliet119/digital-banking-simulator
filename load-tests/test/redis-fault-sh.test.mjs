import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, delimiter } from "node:path";

// TC-167-06: redis-fault.sh with a fake `aws` on PATH (bash). TEST_BASH lets a Windows machine point at Git Bash.
const BASH = process.env.TEST_BASH || "bash";
const SCRIPT = resolve(import.meta.dirname, "../../infra/scripts/redis-fault.sh");
const toBashPath = (p) => (process.platform === "win32" ? p.replace(/\\/g, "/") : p);

const FAKE_AWS = `#!/usr/bin/env bash
state="$FAKE_STATE"
echo "$*" >> "$state/calls.log"
mkdir -p "$state/rules"
case "$1 $2" in
  "ec2 describe-network-acls") ls "$state/rules" | wc -l ;;
  "ec2 create-network-acl-entry") echo "$*" > "$state/rules/$(echo "$*" | sed 's/.*--rule-number \\([0-9]*\\).*/\\1/')" ;;
  "ec2 delete-network-acl-entry")
    if [ -n "\${FAKE_DENY:-}" ]; then echo "An error occurred (UnauthorizedOperation) when calling the DeleteNetworkAclEntry operation" >&2; exit 254; fi
    n="$(echo "$*" | sed 's/.*--rule-number \\([0-9]*\\).*/\\1/')"
    if [ -f "$state/rules/$n" ]; then rm "$state/rules/$n"; else echo "An error occurred (InvalidNetworkAclEntry.NotFound) when calling the DeleteNetworkAclEntry operation" >&2; exit 254; fi ;;
  "secretsmanager get-secret-value") echo "tok-from-secret" ;;
  *) echo "fake aws: lệnh lạ $*" >&2; exit 99 ;;
esac
`;

const FAKE_CURL = `#!/usr/bin/env bash
# fake curl: prints the body, then the HTTP code on its own line (as -w does)
if [ -n "\${FAKE_CURL_FAIL:-}" ]; then exit 7; fi
printf '{"status":"ok","redis":"%s"}\n200' "\${FAKE_CURL_REDIS:-up}"
`;

const FAKE_NODE_TOOL = `
const { writeFileSync } = require("node:fs");
if (process.argv[2] === "probe") {
  console.log(JSON.stringify({ ok: process.env.FAKE_PROBE_OK === "1" }));
  process.exit(0);
}
writeFileSync(process.env.FAKE_STATE + "/node-argv.json", JSON.stringify(process.argv.slice(2)));
writeFileSync(process.env.FAKE_STATE + "/node-token.txt", process.env.REDIS_AUTH_TOKEN || "");
writeFileSync(process.env.FAKE_STATE + "/node-host.txt", process.env.REDIS_HOST || "");
`;

function setup(extraEnv = "") {
  const dir = mkdtempSync(join(tmpdir(), "rf-"));
  const state = join(dir, "state");
  const bin = join(dir, "bin");
  const home = join(dir, "home");
  const src = join(dir, "src");
  for (const d of [state, bin, home, join(src, "load-tests")]) mkdirSync(d, { recursive: true });
  writeFileSync(join(bin, "aws"), FAKE_AWS);
  chmodSync(join(bin, "aws"), 0o755);
  writeFileSync(join(bin, "curl"), FAKE_CURL);
  chmodSync(join(bin, "curl"), 0o755);
  writeFileSync(join(src, "load-tests", "redis-fault.cjs"), FAKE_NODE_TOOL);
  writeFileSync(
    join(home, "run.env"),
    [
      "REDIS_HOST=redis.example",
      "REDIS_FAULT_NACL_ID=acl-0fault",
      "REDIS_FAULT_DENY_CIDRS=10.0.0.0/24,10.0.1.0/24",
      "REDIS_AUTH_SECRET_ID=dbs/dev/redis-auth",
      "BASE_URL=https://alb.example",
      extraEnv,
    ].join("\n") + "\n",
  );
  const env = {
    ...process.env,
    PATH: [toBashPath(bin), process.env.PATH].join(delimiter),
    FAKE_STATE: toBashPath(state),
    LOADGEN_HOME: toBashPath(home),
    REDIS_FAULT_SRC: toBashPath(src),
    FAULT_DIR: toBashPath(join(dir, "fault")),
    PROBE_RETRIES: "2",
    PROBE_SLEEP: "0",
    HEALTH_SLEEP: "0",
    WAIT_MAX: "5",
    CURL_BIN: toBashPath(join(bin, "curl")), // Git Bash on Windows resolves its own curl before PATH entries
  };
  const run = (...args) => runWith({}, ...args);
  const runWith = (extra, ...args) =>
    new Promise((res) => {
      const p = spawn(BASH, [toBashPath(SCRIPT), ...args], { env: { ...env, ...extra }, stdio: ["ignore", "pipe", "pipe"] });
      let out = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (out += d));
      p.on("close", (code) => res({ code, out }));
    });
  return { dir, state, run, runWith, env, fault: join(dir, "fault") };
}

test("TC-167-06 down adds deny rules 50 and 51 for tcp 6379 from each public CIDR and logs the event", async () => {
  const t = setup();
  const r = await t.run("down");
  assert.equal(r.code, 0, r.out);
  const calls = readFileSync(join(t.state, "calls.log"), "utf8").split("\n").filter((l) => l.includes("create-network-acl-entry"));
  assert.equal(calls.length, 2);
  assert.match(calls[0], /--network-acl-id acl-0fault --ingress --rule-number 50 --protocol 6 --port-range From=6379,To=6379 --cidr-block 10\.0\.0\.0\/24 --rule-action deny/);
  assert.match(calls[1], /--rule-number 51 .* --cidr-block 10\.0\.1\.0\/24 --rule-action deny/);
  const ev = JSON.parse(readFileSync(join(t.fault, "fault-events.jsonl"), "utf8").trim());
  assert.equal(ev.action, "down");
  assert.ok(Number.isInteger(ev.epoch_ms));
});

test("TC-167-06 status refuses (exit 1) while rule 50 or 51 exists and passes after restore; restore can run twice", async () => {
  const t = setup();
  assert.equal((await t.run("status")).code, 0);
  await t.run("down");
  const blocked = await t.run("status");
  assert.equal(blocked.code, 1);
  assert.match(blocked.out, /restore/);
  assert.equal((await t.run("restore")).code, 0);
  assert.equal((await t.run("restore")).code, 0, "second restore must tolerate NotFound");
  assert.equal((await t.run("status")).code, 0);
  assert.deepEqual(readdirSync(join(t.state, "rules")), []);
  const events = readFileSync(join(t.fault, "fault-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).action);
  assert.deepEqual(events, ["down", "restore", "restore"]);
});

test("TC-167-06 a real error from delete-network-acl-entry (not NotFound) fails restore", async () => {
  const t = setup();
  await t.run("down");
  const denied = await new Promise((res) => {
    const p = spawn(BASH, [toBashPath(SCRIPT), "restore"], { env: { ...t.env, FAKE_DENY: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    p.stderr.on("data", (d) => (out += d));
    p.on("close", (code) => res({ code, out }));
  });
  assert.notEqual(denied.code, 0);
  assert.match(denied.out, /UnauthorizedOperation/);
});

test("TC-167-06 missing configuration exits 2 before any aws call", async () => {
  const t = setup();
  writeFileSync(join(t.dir, "home", "run.env"), "BASE_URL=https://alb.example\n");
  const r = await t.run("down");
  assert.equal(r.code, 2);
  assert.ok(!existsSync(join(t.state, "calls.log")));
});

test("TC-167-06 flush and slow pass the token only through the environment of the tool, never argv", async () => {
  const t = setup();
  assert.equal((await t.run("flush")).code, 0);
  assert.equal(readFileSync(join(t.state, "node-token.txt"), "utf8"), "tok-from-secret");
  const argv = readFileSync(join(t.state, "node-argv.json"), "utf8");
  assert.doesNotMatch(argv, /tok-from-secret/);
  assert.equal(readFileSync(join(t.state, "node-host.txt"), "utf8"), "redis.example", "REDIS_HOST from run.env must reach the Node tool (it is a child process)");
  assert.deepEqual(JSON.parse(argv).slice(0, 1), ["flush"]);
  assert.equal((await t.run("slow", "10", "100", "200")).code, 0);
  assert.deepEqual(JSON.parse(readFileSync(join(t.state, "node-argv.json"), "utf8")).slice(0, 4), ["slow", "10", "100", "200"]);
});

test("TC-167-06 down removes its own rules and fails when a fresh connection still reaches Redis (the rule has no effect)", async () => {
  const t = setup();
  const r = await t.runWith({ FAKE_PROBE_OK: "1" }, "down");
  assert.equal(r.code, 1, r.out);
  assert.match(r.out, /không có hiệu lực/);
  assert.deepEqual(readdirSync(join(t.state, "rules")), [], "rules 50 and 51 are rolled back");
  const events = readFileSync(join(t.fault, "fault-events.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l).action);
  assert.deepEqual(events, ["restore"], "no `down` event is logged for a rule that did not block");
});

test("TC-167-06 wait-healthy needs N consecutive 200/up samples and gives up when Redis stays degraded", async () => {
  const t = setup();
  const okRun = await t.run("wait-healthy", "3");
  assert.equal(okRun.code, 0, okRun.out);
  const bad = await t.runWith({ FAKE_CURL_REDIS: "degraded" }, "wait-healthy", "3");
  assert.equal(bad.code, 1);
  assert.match(bad.out, /200 degraded/);
  assert.equal((await t.runWith({ FAKE_CURL_FAIL: "1" }, "wait-healthy", "3")).code, 1);
});
