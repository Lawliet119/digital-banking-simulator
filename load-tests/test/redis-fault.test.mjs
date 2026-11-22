import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const fault = require("../redis-fault.cjs");

// Virtual clock: `sleep` advances `now`, so a 300 s step runs instantly and deterministically.
function harness(failAfterCalls = Infinity) {
  let t = 1_800_000_000_000;
  const calls = [];
  const events = [];
  const client = {
    async call(...args) {
      calls.push([t, ...args]);
      if (calls.length > failAfterCalls) throw new Error("connection lost");
      return args[0] === "DBSIZE" ? 42 : "OK";
    },
    async quit() {
      calls.push([t, "QUIT"]);
    },
  };
  return {
    calls,
    events,
    deps: {
      client,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      log: (e) => events.push(e),
    },
  };
}

test("TC-167-05 a pause of 500 ms or more, or not shorter than the period, is refused before any command is sent", async () => {
  for (const [pause, period] of [[501, 1000], [100, 100], [200, 100], [0, 200]]) {
    const h = harness();
    await assert.rejects(fault.pulse({ ...h.deps, seconds: 10, pauseMs: pause, periodMs: period }), /pause/);
    assert.equal(h.calls.length, 0, `no command for pause=${pause} period=${period}`);
  }
});

test("TC-167-05 a pulse sends CLIENT PAUSE ALL once per period and always ends with CLIENT UNPAUSE", async () => {
  const h = harness();
  await fault.pulse({ ...h.deps, seconds: 2, pauseMs: 100, periodMs: 200 });
  const pauses = h.calls.filter((c) => c[1] === "CLIENT" && c[2] === "PAUSE");
  assert.equal(pauses.length, 10);
  assert.deepEqual(pauses[0].slice(1), ["CLIENT", "PAUSE", "100", "ALL"]);
  assert.deepEqual(h.calls.at(-1).slice(1), ["QUIT"]);
  assert.deepEqual(h.calls.at(-2).slice(1), ["CLIENT", "UNPAUSE"]);
});

test("TC-167-05 CLIENT UNPAUSE still runs when a pulse fails midway", async () => {
  const h = harness(3);
  await assert.rejects(fault.pulse({ ...h.deps, seconds: 2, pauseMs: 100, periodMs: 200 }), /connection lost/);
  // the failing call is the 4th; the cleanup UNPAUSE is attempted (and fails too) but the error surfaced is the first one
  assert.ok(h.calls.some((c) => c[2] === "UNPAUSE"));
});

test("TC-167-05 stepped slow-down logs slow_start, slow_step and slow_end with the two pause sizes", async () => {
  const h = harness();
  await fault.slowStepped({ ...h.deps, lightSeconds: 4, heavySeconds: 2, lightPauseMs: 100, heavyPauseMs: 180, periodMs: 200 });
  assert.deepEqual(h.events.map((e) => e.action), ["slow_start", "slow_step", "slow_end"]);
  assert.equal(h.events[0].pause_ms, 100);
  assert.equal(h.events[1].pause_ms, 180);
  assert.equal(h.events[1].epoch_ms - h.events[0].epoch_ms, 4000);
  assert.equal(h.events[2].epoch_ms - h.events[1].epoch_ms, 2000);
  const sizes = h.calls.filter((c) => c[2] === "PAUSE").map((c) => c[3]);
  assert.equal(sizes.filter((x) => x === "100").length, 20);
  assert.equal(sizes.filter((x) => x === "180").length, 10);
});

test("TC-167-05 flush reports DBSIZE before and after FLUSHALL SYNC", async () => {
  const h = harness();
  const out = await fault.flush(h.deps);
  assert.deepEqual(h.calls.map((c) => c.slice(1).join(" ")), ["DBSIZE", "FLUSHALL SYNC", "DBSIZE", "QUIT"]);
  assert.deepEqual(out, { before: 42, after: 42 });
  assert.equal(h.events[0].action, "flush");
});

test("TC-167-05 the client is built from env and the token never appears in a log event", async () => {
  let opts;
  const created = fault.connect({ REDIS_HOST: "redis.example", REDIS_AUTH_TOKEN: "s3cr3t-token-value" }, (o) => {
    opts = o;
    return { fake: true };
  });
  assert.deepEqual(created, { fake: true });
  assert.equal(opts.host, "redis.example");
  assert.equal(opts.password, "s3cr3t-token-value");
  assert.equal(opts.tls.servername, "redis.example");
  assert.equal(opts.maxRetriesPerRequest, 0);
  assert.equal(opts.enableOfflineQueue, true, "the tool waits for the connection instead of failing the first command");
  assert.throws(() => fault.connect({ REDIS_HOST: "x" }, () => ({})), /REDIS_AUTH_TOKEN/);
  const h = harness();
  await fault.flush(h.deps);
  assert.doesNotMatch(JSON.stringify(h.events), /s3cr3t/);
});

test("TC-167-05 probe is ok only when a fresh PING answers PONG; an error or a hang is ok=false", async () => {
  const closed = [];
  const mk = (call) => ({ call, disconnect: () => closed.push(1) });
  assert.deepEqual(await fault.probe({ client: mk(async () => "PONG") }), { ok: true });
  assert.deepEqual(await fault.probe({ client: mk(async () => { throw new Error("ECONNREFUSED"); }) }), { ok: false });
  assert.deepEqual(await fault.probe({ client: mk(() => new Promise(() => {})), timeoutMs: 20 }), { ok: false });
  assert.equal(closed.length, 3, "the probe connection is always closed");
});
