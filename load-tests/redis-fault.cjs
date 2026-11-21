#!/usr/bin/env node
/**
 * DBS-167, DBS-186: làm Redis (ElastiCache Valkey) chậm hoặc mất khóa TỪ MÁY TẢI, bằng đúng các lệnh node-based cho phép.
 *
 *   REDIS_HOST=… REDIS_AUTH_TOKEN=… node load-tests/redis-fault.cjs slow <giây> <P ms> <chu kỳ ms> [--events file]
 *   REDIS_HOST=… REDIS_AUTH_TOKEN=… node load-tests/redis-fault.cjs slow-stepped <giây nhẹ> <giây nặng> <P nhẹ> <P nặng> <chu kỳ> [--events file]
 *   REDIS_HOST=… REDIS_AUTH_TOKEN=… node load-tests/redis-fault.cjs flush [--events file]
 *
 * «Chậm» = xung `CLIENT PAUSE <P> ALL` mỗi chu kỳ: mọi client (api, worker) chờ tối đa P ms; lệnh tự hết hạn nên nếu tiến trình
 * này chết, Redis chạy lại sau tối đa P ms. P ≤ 500 ms và P < chu kỳ (chặn cứng, nếu không từ chối trước khi gửi lệnh nào). Luôn
 * gửi `CLIENT UNPAUSE` khi thoát, kể cả khi lỗi. «Flush» = `FLUSHALL SYNC` (một shard, cluster mode tắt). Token chỉ ở biến
 * môi trường: không vào argv, log hay file. Sự kiện (JSON một dòng: epoch_ms, action, ...) ghi ra stdout và, nếu có
 * `--events`, nối vào file đó để window-stats.cjs tính cửa sổ.
 */
const { appendFileSync } = require("node:fs");
const { join } = require("node:path");

const MAX_PAUSE_MS = 500;

function validatePulse(pauseMs, periodMs) {
  if (!Number.isInteger(pauseMs) || !Number.isInteger(periodMs) || pauseMs < 1 || pauseMs > MAX_PAUSE_MS || pauseMs >= periodMs)
    throw new Error(`pause không hợp lệ: P=${pauseMs} ms phải nguyên, 1..${MAX_PAUSE_MS} và nhỏ hơn chu kỳ (${periodMs} ms)`);
}

async function pulse({ client, seconds, pauseMs, periodMs, now, sleep, close = true, unpause = true }) {
  validatePulse(pauseMs, periodMs);
  const end = now() + seconds * 1000;
  try {
    while (now() < end) {
      const t0 = now();
      await client.call("CLIENT", "PAUSE", String(pauseMs), "ALL");
      await sleep(Math.max(0, periodMs - (now() - t0)));
    }
  } finally {
    if (unpause) {
      try {
        await client.call("CLIENT", "UNPAUSE");
      } catch {
        // the pause expires by itself within P ms; the original error is the one that matters
      }
    }
    if (close) {
      try {
        await client.quit();
      } catch {
        // already closed
      }
    }
  }
}

async function slowStepped({ client, now, sleep, log, lightSeconds, heavySeconds, lightPauseMs, heavyPauseMs, periodMs }) {
  validatePulse(lightPauseMs, periodMs);
  validatePulse(heavyPauseMs, periodMs);
  log({ epoch_ms: now(), action: "slow_start", mode: "slow", pause_ms: lightPauseMs, period_ms: periodMs });
  await pulse({ client, now, sleep, seconds: lightSeconds, pauseMs: lightPauseMs, periodMs, close: false, unpause: false });
  log({ epoch_ms: now(), action: "slow_step", mode: "slow", pause_ms: heavyPauseMs, period_ms: periodMs });
  await pulse({ client, now, sleep, seconds: heavySeconds, pauseMs: heavyPauseMs, periodMs });
  log({ epoch_ms: now(), action: "slow_end", mode: "slow" });
}

async function flush({ client, now, log }) {
  try {
    const before = await client.call("DBSIZE");
    await client.call("FLUSHALL", "SYNC");
    const after = await client.call("DBSIZE");
    log({ epoch_ms: now(), action: "flush", mode: "flush", before, after });
    return { before, after };
  } finally {
    try {
      await client.quit();
    } catch {
      // already closed
    }
  }
}

function connect(env = process.env, factory = null) {
  const host = env.REDIS_HOST;
  const password = env.REDIS_AUTH_TOKEN;
  if (!host) throw new Error("thiếu REDIS_HOST");
  if (!password) throw new Error("thiếu REDIS_AUTH_TOKEN (chỉ qua biến môi trường)");
  const options = {
    host,
    port: Number(env.REDIS_PORT || 6379),
    password,
    tls: { servername: host },
    maxRetriesPerRequest: 0,
    enableOfflineQueue: false,
    connectTimeout: 3000,
  };
  if (factory) return factory(options);
  const Redis = require(require.resolve("ioredis", { paths: [join(__dirname, "..", "backend")] }));
  return new Redis(options);
}

async function main(argv, env = process.env) {
  const [cmd, ...rest] = argv;
  const flagAt = rest.indexOf("--events");
  const eventsFile = flagAt >= 0 ? rest[flagAt + 1] : null;
  const args = flagAt >= 0 ? rest.slice(0, flagAt) : rest;
  const num = (i) => Number(args[i]);
  const log = (e) => {
    const line = JSON.stringify(e);
    console.log(line);
    if (eventsFile) appendFileSync(eventsFile, line + "\n");
  };
  const clock = { now: () => Date.now(), sleep: (ms) => new Promise((r) => setTimeout(r, ms)), log };
  if (cmd === "slow") {
    validatePulse(num(1), num(2));
    const client = connect(env);
    log({ epoch_ms: Date.now(), action: "slow_start", mode: "slow", pause_ms: num(1), period_ms: num(2) });
    await pulse({ client, ...clock, seconds: num(0), pauseMs: num(1), periodMs: num(2) });
    log({ epoch_ms: Date.now(), action: "slow_end", mode: "slow" });
  } else if (cmd === "slow-stepped") {
    validatePulse(num(2), num(4));
    validatePulse(num(3), num(4));
    await slowStepped({ client: connect(env), ...clock, lightSeconds: num(0), heavySeconds: num(1), lightPauseMs: num(2), heavyPauseMs: num(3), periodMs: num(4) });
  } else if (cmd === "flush") {
    await flush({ client: connect(env), ...clock });
  } else {
    console.error("Dùng: redis-fault.cjs slow|slow-stepped|flush … [--events file] (REDIS_HOST, REDIS_AUTH_TOKEN trong môi trường)");
    return 2;
  }
  return 0;
}

module.exports = { pulse, slowStepped, flush, connect, validatePulse, MAX_PAUSE_MS };

if (require.main === module)
  main(process.argv.slice(2)).then(
    (c) => process.exit(c),
    (e) => {
      console.error(`lỗi: ${e.message}`);
      process.exit(2);
    },
  );
