// DBS-186 (phần cloud): test của infra/scripts/drill-revocation-cloud.mjs, TC-186-04..16.
// Máy chủ giả chạy CÙNG tiến trình với test và mô phỏng đúng luật guard (iat <= floor(mốc) => 401 SESSION_REVOKED,
// cache Redis có thể flush/down, SQL là nguồn sự thật, `/health/ready` báo `redis: up|degraded`). Driver và hook chạy
// bằng `spawn` bất đồng bộ: `spawnSync` sẽ chặn vòng lặp sự kiện và máy chủ giả không bao giờ trả lời (TonightWorks §7).
// Không có DB hay Redis thật: test chứng minh logic và an toàn của driver, KHÔNG chứng minh hành vi cloud.
//
// Chạy: node --test infra/scripts/tests/drill-revocation-cloud.test.mjs   (Node >= 24, không phụ thuộc ngoài; ca TLS cần openssl)
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { ENV_SECRET, FakeBackend, HOOK_SOURCE, PW, SECRET_STRINGS, makeJwt } from "./drill-fake-backend.mjs";

// Mật khẩu giả ghép lúc chạy để mã nguồn không chứa literal `password=<giá trị>` (gitleaks generic-api-key).
const FAKE_PW = ["Sup3rSecret", "Passw0rd"].join("");
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DRIVER = path.join(HERE, "..", "drill-revocation-cloud.mjs");
let tmp;
let hookPath;
let tlsFiles = null;
before(async () => {
  tmp = await mkdtemp(path.join(tmpdir(), "drill186-"));
  hookPath = path.join(tmp, "hook.mjs");
  await writeFile(hookPath, HOOK_SOURCE);
  // Chứng chỉ tự ký dựng lúc chạy (không commit khóa riêng); thiếu openssl thì các ca TLS tự bỏ qua có ghi lý do.
  try {
    const key = path.join(tmp, "key.pem");
    const cert = path.join(tmp, "cert.pem");
    await new Promise((resolve, reject) => {
      const p = spawn("openssl", ["req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert, "-subj", "/CN=127.0.0.1", "-days", "1", "-addext", "subjectAltName=IP:127.0.0.1"], { stdio: "ignore" });
      p.on("error", reject);
      p.on("close", (c) => (c === 0 ? resolve() : reject(new Error(`openssl ${c}`))));
    });
    tlsFiles = { key: await readFile(key), cert: await readFile(cert) };
  } catch {
    tlsFiles = null;
  }
});
after(async () => {
  await rm(tmp, { recursive: true, force: true });
});

const hook = (a) => `node "${hookPath}" ${a}`;

async function withFake(cfg, fn, tls = null) {
  const fake = new FakeBackend(cfg, tls);
  await fake.listen();
  try {
    return await fn(fake);
  } finally {
    await fake.close();
  }
}

function driverArgs(fake, out, extra = []) {
  return [
    "--base-url", fake.url,
    "--out", out,
    "--confirm-idle",
    "--cognito-endpoint", `${fake.url}/cognito`,
    "--cognito-client-id", "test-client",
    "--user-a-email", "a@dbs.invalid",
    "--user-b-email", "b@dbs.invalid",
    "--operator-token-cmd", hook("token operator"),
    "--flush-cmd", hook("flush"),
    "--down-cmd", hook("down"),
    "--up-cmd", hook("up"),
    "--sql-marker-cmd", hook("marker"),
    "--invariants-cmd", hook("invariants"),
    "--hook-env", "FAKE_CTL",
    "--settle-ms", "1100",
    "--poll-ms", "20",
    "--recovery-timeout-s", "20",
    "--fault-timeout-s", "20",
    "--hook-timeout-s", "20",
    "--same-second-attempts", "0",
    "--run-id", "t1",
    "--image-sha", "abc1234",
    ...extra,
  ];
}

function spawnDriver(args, env = {}) {
  return spawn(process.execPath, [DRIVER, ...args], {
    env: { ...process.env, DRILL_USER_A_PASSWORD: PW.a, DRILL_USER_B_PASSWORD: PW.b, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
}

async function runDriver(fake, extra = [], { replace = false, env = {}, timeoutMs = 90000 } = {}) {
  const out = await mkdtemp(path.join(tmp, "out-"));
  const args = replace ? ["--out", out, ...extra] : driverArgs(fake, out, extra);
  const started = Date.now();
  const child = spawnDriver(args, { FAKE_CTL: fake.ctlUrl, ...env });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (d) => (stdout += d));
  child.stderr.on("data", (d) => (stderr += d));
  const timer = setTimeout(() => child.kill(), timeoutMs);
  const code = await new Promise((resolve) => child.on("close", (c) => resolve(c)));
  clearTimeout(timer);
  let report = null;
  try {
    report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
  } catch {
    /* không có báo cáo (lỗi dùng sai) */
  }
  return { code, stdout, stderr, out, report, ms: Date.now() - started };
}

const why = (r) => `exit ${r.code}\n--- stdout\n${r.stdout}\n--- stderr\n${r.stderr}`;
const indexOfEvent = (log, pred, from = 0) => {
  for (let i = from; i < log.length; i++) if (pred(log[i])) return i;
  return -1;
};

describe("TC-186-04 ca đạt", () => {
  test("flush và down: thứ tự lock -> fault -> request kế tiếp, mốc SQL nguyên, B 200", async () => {
    await withFake({}, async (fake) => {
      const r = await runDriver(fake);
      assert.equal(r.code, 0, why(r));
      assert.equal(r.report.verdict, "PASS");
      assert.equal(r.report.exitCode, 0);
      assert.equal(r.report.imageSha, "abc1234");
      assert.equal(r.report.runId, "t1");
      const log = fake.log;

      // --- flush ---
      const flushAt = indexOfEvent(log, (e) => e.kind === "hook" && e.name === "flush");
      assert.ok(flushAt > 0, "hook flush phải chạy");
      assert.equal(log[flushAt].phase, "flush");
      const target = log[flushAt].account;
      assert.match(target, /^[0-9a-f-]{36}$/);
      const lock1 = indexOfEvent(log, (e) => e.kind === "req" && e.path === `/v1/operator/accounts/${target}/lock`);
      assert.ok(lock1 >= 0 && lock1 < flushAt, "lock trước flush");
      assert.deepEqual(
        log.slice(lock1 + 1, flushAt).filter((e) => e.kind === "req" && e.who === "A"),
        [],
        "không có request của A giữa lock và flush",
      );
      const next = log.slice(flushAt + 1).find((e) => e.kind === "req" || e.kind === "hook");
      assert.deepEqual([next.kind, next.who, next.path, next.status], ["req", "A", "/v1/accounts", 401], "request kế tiếp sau flush là của A và bị 401");
      assert.equal(r.report.scenarios.flush.nextRequest.errorCode, "SESSION_REVOKED");
      assert.equal(r.report.scenarios.flush.nextRequest.status, 401);
      assert.ok(r.report.scenarios.flush.nextRequest.correlationId);
      assert.deepEqual(r.report.scenarios.flush.revokedKeys, { before: 1, after: 0 });
      assert.equal(r.report.scenarios.flush.markerUnchanged, true);
      assert.equal(r.report.scenarios.flush.markerAfterLock, r.report.scenarios.flush.markerAfterFault);
      assert.notEqual(r.report.scenarios.flush.markerBeforeLock, r.report.scenarios.flush.markerAfterLock);
      assert.equal(r.report.scenarios.flush.bystander.status, 200);

      // --- down ---
      const downAt = indexOfEvent(log, (e) => e.kind === "hook" && e.name === "down");
      const upAt = indexOfEvent(log, (e) => e.kind === "hook" && e.name === "up");
      assert.ok(downAt > flushAt && upAt > downAt, "up chạy sau down");
      assert.equal(log[downAt].phase, "down");
      const lock2 = log.map((e, i) => [e, i]).filter(([e]) => e.kind === "req" && e.path.endsWith("/lock")).map(([, i]) => i).pop();
      assert.ok(lock2 < downAt);
      assert.deepEqual(log.slice(lock2 + 1, downAt).filter((e) => e.kind === "req" && e.who === "A"), []);
      const afterDown = log.slice(downAt + 1, upAt).filter((e) => e.kind === "req");
      assert.deepEqual(afterDown.slice(0, 2).map((e) => [e.who, e.path, e.status]), [["A", "/v1/accounts", 401], ["B", "/v1/accounts", 200]]);
      const afterUp = log.slice(upAt + 1).filter((e) => e.kind === "req" && e.who === "A" && e.path === "/v1/accounts");
      assert.equal(afterUp[0].status, 401, "sau up A vẫn bị từ chối");
      const down = r.report.scenarios.down;
      assert.equal(down.oldTokenAfterUnlock.status, 401);
      assert.equal(down.freshTokenBeforeLock.status, 200);
      assert.ok(down.freshTokenIatMinusFloor >= 1, "token mới có iat sau mốc cũ");
      assert.equal(down.nextRequest.errorCode, "SESSION_REVOKED");
      assert.equal(down.bystander.status, 200);
      assert.equal(down.afterUp.status, 401);
      assert.equal(down.markerUnchanged, true);
      assert.equal(typeof down.recoveryMs, "number");
      assert.equal(typeof down.redisDegradedAfterMs, "number");
      assert.deepEqual(r.report.invariants.map((x) => [x.after, x.status]), [["flush", "PASS"], ["down", "PASS"]]);
      assert.equal(r.report.bl222.status, "SKIPPED");
      assert.equal(r.report.cleanup.up, "NOT_NEEDED");
      assert.match(r.stdout, /VERDICT: PASS/);
    });
  });

  test("hook nhận DRILL_RUN_ID, DRILL_PHASE, DRILL_ACCOUNT_ID", async () => {
    await withFake({}, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush"]);
      assert.equal(r.code, 0, why(r));
      const e = fake.events("hook").find((x) => x.name === "flush");
      assert.equal(e.run, "t1");
      assert.equal(e.phase, "flush");
      assert.ok(e.account);
    });
  });

  test("dùng --token-a-cmd/--token-b-cmd thay cho đăng nhập trực tiếp", async () => {
    await withFake({}, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush", "--token-a-cmd", hook("token a"), "--token-b-cmd", hook("token b")], {
        env: { DRILL_USER_A_PASSWORD: "", DRILL_USER_B_PASSWORD: "" },
      });
      assert.equal(r.code, 0, why(r));
      assert.equal(fake.events("cognito").length, 0, "không gọi Cognito");
    });
  });
});

describe("TC-186-05 negative control", () => {
  test("SQL fallback hỏng: sau flush A vẫn 200 => exit 1 ở request kế tiếp", async () => {
    await withFake({ bug: "no-sql-fallback" }, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush"]);
      assert.equal(r.code, 1, why(r));
      assert.equal(r.report.verdict, "FAIL");
      assert.equal(r.report.failedStep, "flush.next-request");
      assert.equal(fake.events("hook").some((e) => e.name === "down"), false);
    });
  });

  test("SQL fallback hỏng khi down: exit 1 và up vẫn chạy, Redis lên lại", async () => {
    await withFake({ bug: "no-sql-fallback" }, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "down"]);
      assert.equal(r.code, 1, why(r));
      assert.equal(r.report.failedStep, "down.next-request");
      const hooks = fake.events("hook").map((e) => e.name);
      assert.ok(hooks.indexOf("up") > hooks.indexOf("down"), "up chạy sau down dù lỗi");
      assert.equal(fake.redis.up, true, "Redis được khôi phục");
      assert.equal(r.report.cleanup.up, "OK");
      assert.equal(r.report.cleanup.redisUp, true);
    });
  });
});

describe("TC-186-06 401 sai nguyên nhân", () => {
  for (const [mode, label] of [
    ["wrong-code", "errorCode không phải SESSION_REVOKED"],
    ["no-correlation", "thiếu correlationId trong thân"],
    ["mismatch", "correlationId thân khác header"],
  ]) {
    test(`${label} => exit 1`, async () => {
      await withFake({ errorMode: mode }, async (fake) => {
        const r = await runDriver(fake, ["--scenarios", "flush"]);
        assert.equal(r.code, 1, why(r));
        assert.equal(r.report.failedStep, "flush.next-request");
      });
    });
  }

  test("TOKEN_EXPIRED khi exp còn hạn: guard sai => exit 1", async () => {
    await withFake({ errorMode: "token-expired" }, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush"]);
      assert.equal(r.code, 1, why(r));
      assert.match(r.report.failure, /TOKEN_EXPIRED/);
    });
  });

  test("token sắp hết hạn (dưới biên 60 s): không gửi, không kết luận => exit 3", async () => {
    await withFake({ tokenTtlSec: 30 }, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush"]);
      assert.equal(r.code, 3, why(r));
      assert.equal(r.report.verdict, "ERROR");
      assert.match(r.report.failure, /hạn/);
      assert.equal(fake.events("req").length, 0, "không có request nào mang token sắp hết hạn");
    });
  });
});

describe("TC-186-07 che token và bí mật", () => {
  async function scan(fake, r) {
    const files = await readdir(r.out);
    assert.ok(files.includes("report.json") && files.includes("drill.log"));
    let all = `${r.stdout}\n${r.stderr}`;
    for (const f of files) all += `\n${await readFile(path.join(r.out, f), "utf8")}`;
    for (const t of fake.issued) assert.ok(!all.includes(t), "token đã cấp xuất hiện trong đầu ra");
    for (const t of fake.issued) assert.ok(!all.includes(t.split(".")[1]), "payload token xuất hiện trong đầu ra");
    for (const s of SECRET_STRINGS) assert.ok(!all.includes(s), `bí mật xuất hiện: ${s}`);
    assert.ok(!/eyJ[A-Za-z0-9_-]{5,}\./.test(all), "chuỗi giống JWT");
    assert.ok(!/Bearer/i.test(all), "Bearer còn trong đầu ra");
    return all;
  }

  test("ca đạt, máy chủ thù địch lặp lại Authorization, hook in bí mật", async () => {
    await withFake({ echoAuth: true }, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush", "--flush-cmd", hook("leak 0")]);
      assert.equal(r.code, 0, why(r));
      await scan(fake, r);
    });
  });

  test("ca lỗi: hook thoát 9 sau khi in bí mật ra stderr", async () => {
    await withFake({ echoAuth: true }, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush", "--flush-cmd", hook("leak 9")]);
      assert.equal(r.code, 3, why(r));
      const all = await scan(fake, r);
      assert.match(all, /\[JWT\]|\[REDACTED\]/, "đuôi stderr được che, không bị bỏ");
    });
  });

  test("ca lỗi 401 sai: thân có Authorization lặp lại, vẫn không lộ", async () => {
    await withFake({ echoAuth: true, bug: "no-sql-fallback" }, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush"]);
      assert.equal(r.code, 1);
      await scan(fake, r);
    });
  });

  test("hook không thấy mật khẩu khách hay biến bí mật lạ (danh sách cho phép), vẫn thấy DRILL_* và FAKE_CTL", async () => {
    await withFake({}, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush", "--flush-cmd", hook("dump-env")], {
        env: { SOME_UNRELATED_SECRET: ENV_SECRET, AWS_PROFILE: "dbs-test" },
      });
      // dump-env không in bằng chứng flush => exit 3, nhưng sự kiện env đã được ghi nhận
      assert.equal(r.code, 3, why(r));
      const e = fake.events("env")[0];
      assert.ok(e, "hook phải chạy");
      assert.deepEqual(e.leaked, [], `hook thấy bí mật: ${e.leaked}`);
      assert.ok(!e.names.includes("SOME_UNRELATED_SECRET"));
      assert.ok(!e.names.includes("DRILL_USER_A_PASSWORD") && !e.names.includes("DRILL_USER_B_PASSWORD"));
      for (const n of ["DRILL_RUN_ID", "DRILL_PHASE", "DRILL_ACCOUNT_ID", "FAKE_CTL", "AWS_PROFILE", "PATH"]) assert.ok(e.names.includes(n) || (n === "PATH" && e.names.includes("Path")), `thiếu ${n}`);
    });
  });
});

describe("TC-186-08 hook thất bại", () => {
  test("flush-cmd thoát 7 => exit 3, không có request A sau đó", async () => {
    await withFake({}, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush,down", "--flush-cmd", hook("exit 7")]);
      assert.equal(r.code, 3, why(r));
      assert.equal(r.report.failedStep, "flush.fault");
      assert.equal(r.report.hooks.find((h) => h.name === "flush").exitCode, 7);
      assert.equal(fake.events("hook").some((e) => e.name === "down"), false, "không chạy tiếp kiểu down");
    });
  });

  test("up-cmd thoát 5 sau down => exit 3, ghi cleanup.up FAIL", async () => {
    await withFake({}, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "down", "--up-cmd", hook("exit 5")]);
      assert.equal(r.code, 3, why(r));
      assert.equal(r.report.cleanup.up, "FAIL");
      assert.equal(r.report.cleanup.redisUp, false);
      assert.equal(fake.redis.up, false);
    });
  });

  test("hook quá hạn bị giết, không treo", async () => {
    await withFake({}, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush", "--flush-cmd", hook("sleep 30000"), "--hook-timeout-s", "1"]);
      assert.equal(r.code, 3, why(r));
      assert.ok(r.ms < 25000, `chạy ${r.ms} ms`);
      assert.equal(r.report.hooks.find((h) => h.name === "flush").timedOut, true);
    });
  });

  test("down-cmd quá hạn: cây tiến trình bị giết, up chạy, hook không 'down muộn' sau up", async () => {
    await withFake({}, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "down", "--down-cmd", hook("late-down 2500"), "--hook-timeout-s", "1"]);
      assert.equal(r.code, 3, why(r));
      assert.equal(r.report.hooks.find((h) => h.name === "down").timedOut, true);
      assert.equal(r.report.cleanup.up, "OK");
      await new Promise((resolve) => setTimeout(resolve, 3500)); // đủ để một hook sống sót gọi down muộn
      assert.equal(fake.events("hook").some((e) => e.name === "down"), false, "hook down còn sống sau khi bị giết");
      assert.equal(fake.redis.up, true);
    });
  });

  test("lệnh không tồn tại => exit 3", async () => {
    await withFake({}, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush", "--flush-cmd", "drill186-lenh-khong-ton-tai"]);
      assert.equal(r.code, 3, why(r));
    });
  });

  test("hook mốc SQL in rác => exit 3", async () => {
    await withFake({}, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush", "--sql-marker-cmd", hook("marker-garbage")]);
      assert.equal(r.code, 3, why(r));
    });
  });

  test("SIGINT khi --down-cmd đang chạy: giết hook, chạy up, ghi báo cáo, exit 3", { skip: process.platform === "win32" && "Windows không gửi được SIGINT có xử lý tới tiến trình con (CI Linux chạy ca này)" }, async () => {
    await withFake({}, async (fake) => {
      const out = await mkdtemp(path.join(tmp, "out-"));
      const child = spawnDriver(driverArgs(fake, out, ["--scenarios", "down", "--down-cmd", hook("sleep 60000"), "--hook-timeout-s", "120"]), { FAKE_CTL: fake.ctlUrl });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      for (let i = 0; i < 300 && !/hook down \(down\)|\.\.\. down\.fault/.test(stdout); i++) await new Promise((r) => setTimeout(r, 50));
      assert.match(stdout, /down\.fault/);
      await new Promise((r) => setTimeout(r, 300));
      child.kill("SIGINT");
      const code = await new Promise((resolve) => child.on("close", (c) => resolve(c)));
      assert.equal(code, 3, stdout);
      const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
      assert.equal(report.cleanup.up, "OK");
      assert.equal(fake.events("hook").some((e) => e.name === "up"), true);
    });
  });
});

describe("TC-186-08b --shell và SIGINT khi không có hook nào đang chạy", () => {
  test("--shell tường minh chạy được hook; đường dẫn không tồn tại => exit 2", async () => {
    await withFake({}, async (fake) => {
      const sh = process.platform === "win32" ? process.env.ComSpec : "/bin/sh";
      const ok = await runDriver(fake, ["--scenarios", "flush", "--shell", sh]);
      assert.equal(ok.code, 0, why(ok));
      const bad = await runDriver(fake, ["--scenarios", "flush", "--shell", "/usr/bin/drill186-khong-co-shell"]);
      assert.equal(bad.code, 2, why(bad));
      assert.equal(bad.report, null);
    });
  });

  test(
    "SIGINT lúc đang chờ health (không có hook chạy): không có hook down mới sau tín hiệu, up chạy, Redis lên",
    { skip: process.platform === "win32" && "Windows không gửi được SIGINT có xử lý tới tiến trình con (CI Linux chạy ca này)" },
    async () => {
      await withFake({ downNoop: true }, async (fake) => {
        const out = await mkdtemp(path.join(tmp, "out-"));
        const child = spawnDriver(driverArgs(fake, out, ["--scenarios", "down", "--fault-timeout-s", "60"]), { FAKE_CTL: fake.ctlUrl });
        let stdout = "";
        child.stdout.on("data", (d) => (stdout += d));
        for (let i = 0; i < 400 && !/hook down \(down\)/.test(stdout); i++) await new Promise((r) => setTimeout(r, 50));
        assert.match(stdout, /hook down \(down\)/);
        const downsBefore = fake.events("hook").filter((e) => e.name === "down").length;
        child.kill("SIGINT");
        const code = await new Promise((resolve) => child.on("close", (c) => resolve(c)));
        assert.equal(code, 3, stdout);
        const hooks = fake.events("hook").map((e) => e.name);
        assert.equal(hooks.filter((n) => n === "down").length, downsBefore, "không có hook down mới sau tín hiệu");
        assert.ok(hooks.lastIndexOf("up") > hooks.lastIndexOf("down"));
        const report = JSON.parse(await readFile(path.join(out, "report.json"), "utf8"));
        assert.equal(report.cleanup.up, "OK");
        assert.equal(fake.redis.up, true);
      });
    },
  );
});

describe("TC-186-09 bất biến", () => {
  test("checker thoát 1 sau flush => exit 4, dừng ngay (không chạy down)", async () => {
    await withFake({ invariantsExit: 1 }, async (fake) => {
      const r = await runDriver(fake);
      assert.equal(r.code, 4, why(r));
      assert.equal(r.report.verdict, "INVARIANTS_FAIL");
      assert.deepEqual(r.report.invariants.map((x) => [x.after, x.status]), [["flush", "FAIL"]]);
      assert.equal(fake.events("hook").some((e) => e.name === "down"), false);
    });
  });

  test("checker thoát 2 (lỗi checker, không phải vi phạm) => exit 3", async () => {
    await withFake({ invariantsExit: 2 }, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush"]);
      assert.equal(r.code, 3, why(r));
      assert.equal(r.report.invariants[0].status, "ERROR");
    });
  });

  test("bất biến FAIL sau down vẫn để Redis lên lại", async () => {
    await withFake({ invariantsExit: 1 }, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "down"]);
      assert.equal(r.code, 4, why(r));
      assert.equal(fake.redis.up, true);
    });
  });
});

describe("TC-186-10 mốc SQL", () => {
  for (const mode of ["drift", "lost"]) {
    test(`mốc ${mode === "drift" ? "đổi" : "mất"} sau fault => exit 1`, async () => {
      await withFake({ markerAfterFault: mode }, async (fake) => {
        const r = await runDriver(fake, ["--scenarios", "flush"]);
        assert.equal(r.code, 1, why(r));
        assert.match(r.report.failedStep, /marker/);
      });
    });
  }
});

describe("TC-186-11 BL-222 ca cùng giây và +1", () => {
  const NOW = 1_800_000_000_123;
  const args = ["--scenarios", "none", "--same-second-attempts", "2", "--same-second-modes", "hit,flush"];
  const frozen = (extra = {}) => ({ frozenMs: NOW, advanceAfterLockMs: 1000, ...extra });
  const companionReqs = (fake) => fake.log.filter((e) => e.kind === "req" && e.who === "A" && /^\/v1\/accounts\/[0-9a-f-]{36}$/.test(e.path));

  test("token cùng giây với mốc 401 và token +1 (iat = R+1) 200 ở hit, flush và down => CAUGHT", async () => {
    await withFake(frozen(), async (fake) => {
      const r = await runDriver(fake, [...args.slice(0, -1), "hit,flush,down", "--same-second-down-attempts", "1"]);
      assert.equal(r.code, 0, why(r));
      for (const [mode, n] of [["hit", 2], ["flush", 2], ["down", 1]]) {
        const b = r.report.bl222[mode];
        assert.equal(b.status, "CAUGHT", mode);
        assert.equal(b.attempts, n);
        assert.equal(b.sameSecond, n);
        assert.equal(b.plusOne, n, "iat - floor(mốc) đúng bằng 1");
        assert.equal(b.violations, 0);
        assert.deepEqual(b.samples.filter((x) => x.kind === "plus").map((x) => [x.iatMinusFloor, x.status]), Array(n).fill([1, 200]));
      }
      assert.equal(r.report.bl222.status, "CAUGHT");
      assert.deepEqual(companionReqs(fake).map((e) => e.status), [401, 200, 401, 200, 401, 200, 401, 200, 401, 200]);
      assert.ok(fake.events("hook").filter((e) => e.name === "flush").length >= 4, "chế độ flush flush lại trước token +1");
      assert.equal(r.report.invariants.at(-1).after, "boundary");
      assert.equal(typeof r.report.bl222.hit.samples[0].loginToLockMs, "number");
    });
  });

  test("token luôn cách mốc từ 2 giây: NOT_CAUGHT (không có mẫu cùng giây hay +1), 200 trên tài khoản đồng hành, exit 0", async () => {
    await withFake(frozen({ markerOffsetMs: -1500 }), async (fake) => {
      const r = await runDriver(fake, args);
      assert.equal(r.code, 0, why(r));
      assert.equal(r.report.bl222.hit.status, "NOT_CAUGHT");
      assert.equal(r.report.bl222.flush.status, "NOT_CAUGHT");
      assert.equal(r.report.bl222.hit.plusOne, 0);
      assert.match(r.stdout, /NOT_CAUGHT/);
      const c = companionReqs(fake);
      assert.ok(c.length >= 8 && c.every((e) => e.status === 200), "giây sau phải 200 trên tài khoản đồng hành");
    });
  });

  test("mốc ở giây sau token đăng nhập: 401, không tính là cùng giây của token đó; token +1 cùng giây với mốc", async () => {
    await withFake(frozen({ markerOffsetMs: 1500 }), async (fake) => {
      const r = await runDriver(fake, args);
      assert.equal(r.code, 0, why(r));
      assert.equal(r.report.bl222.hit.status, "SAME_SECOND_ONLY");
      assert.equal(r.report.bl222.hit.earlierSecond, 2);
      assert.equal(r.report.bl222.hit.sameSecond, 2);
      assert.equal(r.report.bl222.status, "NOT_CAUGHT", "chưa đủ để đóng BL-222");
    });
  });

  test("máy chủ cho qua token cùng giây (< thay vì <=) => VIOLATION, exit 1", async () => {
    await withFake(frozen({ bug: "same-second-allows" }), async (fake) => {
      const r = await runDriver(fake, args);
      assert.equal(r.code, 1, why(r));
      assert.equal(r.report.bl222.hit.status, "VIOLATION");
    });
  });

  test("máy chủ từ chối cả iat = R+1 (lệch một đơn vị, kiểu ceil) => VIOLATION ở token +1, exit 1", async () => {
    await withFake(frozen({ bug: "plus-one" }), async (fake) => {
      const r = await runDriver(fake, args);
      assert.equal(r.code, 1, why(r));
      assert.equal(r.report.bl222.hit.status, "VIOLATION");
      assert.match(r.report.failure, /plus/);
    });
  });

  test("down tự lành trước request quyết định => exit 3 (không phải đường SQL fallback)", async () => {
    await withFake({ selfHealAfterReadyCalls: 1 }, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "down"]);
      assert.equal(r.code, 3, why(r));
      assert.equal(r.report.failedStep, "down.next-request");
      assert.match(r.report.failure, /không còn là đường SQL fallback/);
      assert.equal(fake.events("req").filter((e) => e.who === "A" && e.status === 401).length, 0);
    });
  });
});

describe("TC-186-12 tham số và chạy lại", () => {
  async function usage(extraArgs, { drop = [] } = {}) {
    return withFake({}, async (fake) => {
      const a = driverArgs(fake, "unused", extraArgs);
      for (const flag of ["--out", ...drop]) {
        const i = a.indexOf(flag);
        a.splice(i, flag === "--confirm-idle" ? 1 : 2);
      }
      const r = await runDriver(fake, a, { replace: true });
      return { r, requests: fake.requests, hooks: fake.events("hook").length, cognito: fake.events("cognito").length };
    });
  }

  test("thiếu --confirm-idle => exit 2, không gọi mạng", async () => {
    const x = await usage([], { drop: ["--confirm-idle"] });
    assert.equal(x.r.code, 2, why(x.r));
    assert.deepEqual([x.requests, x.hooks, x.cognito], [0, 0, 0]);
  });

  test("thiếu hook bắt buộc (--sql-marker-cmd) => exit 2", async () => {
    const x = await usage([], { drop: ["--sql-marker-cmd"] });
    assert.equal(x.r.code, 2, why(x.r));
    assert.equal(x.requests, 0);
  });

  test("kiểu flush mà thiếu --flush-cmd => exit 2; chỉ down thì không cần flush", async () => {
    const x = await usage(["--scenarios", "flush"], { drop: ["--flush-cmd"] });
    assert.equal(x.r.code, 2, why(x.r));
    const y = await usage(["--scenarios", "down"], { drop: ["--flush-cmd"] });
    assert.equal(y.r.code, 0, why(y.r));
  });

  test("--base-url không phải http(s), số lần thử âm hoặc tham số lạ => exit 2", async () => {
    const x = await usage(["--base-url", "ftp://x"]);
    assert.equal(x.r.code, 2, why(x.r));
    const y = await usage(["--same-second-attempts", "-1"]);
    assert.equal(y.r.code, 2, why(y.r));
    const z = await usage(["--khong-biet", "1"]);
    assert.equal(z.r.code, 2, why(z.r));
  });

  test("thiếu mật khẩu khách mà không có --token-a-cmd => exit 2", async () => {
    await withFake({}, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush"], { env: { DRILL_USER_A_PASSWORD: "" } });
      assert.equal(r.code, 2, why(r));
      assert.equal(fake.requests, 0);
    });
  });

  test("chạy lại khi tài khoản đang LOCKED: tự mở khóa rồi PASS", async () => {
    await withFake({}, async (fake) => {
      const [t, c] = fake.seedAccounts("sub-a", ["LOCKED", "ACTIVE"]);
      fake.setMarker("sub-a", Date.now() - 20000);
      fake.seedAccounts("sub-b", ["ACTIVE"]);
      const r = await runDriver(fake, ["--scenarios", "flush"]);
      assert.equal(r.code, 0, why(r));
      assert.equal(r.report.prepare.unlockedAccounts, 1);
      assert.equal(r.report.prepare.openedAccounts, 0);
      assert.equal(fake.accounts.get(c).status, "ACTIVE");
      assert.equal(fake.accounts.get(t).status, "LOCKED", "đích bị khóa bởi chính drill");
    });
  });

  test("lần đầu: mở đủ hai tài khoản cho A và một cho B qua API", async () => {
    await withFake({}, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush"]);
      assert.equal(r.code, 0, why(r));
      assert.equal(fake.accountsOf("sub-a").length, 2);
      assert.equal(fake.accountsOf("sub-b").length, 1);
      assert.equal(r.report.prepare.openedAccounts, 3);
    });
  });
});

describe("TC-186-14 fault phải có hiệu lực thật (không tin mã thoát của hook)", () => {
  test("flush không xóa gì (DRILL_REVOKED_KEYS_AFTER > 0) => exit 3, không PASS", async () => {
    await withFake({ flushNoop: true }, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush"]);
      assert.equal(r.code, 3, why(r));
      assert.equal(r.report.failedStep, "flush.fault");
      assert.match(r.report.failure, /flush không có hiệu lực/);
    });
  });

  test("flush-cmd không in bằng chứng => exit 3", async () => {
    await withFake({}, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush", "--flush-cmd", hook("flush-noevidence")]);
      assert.equal(r.code, 3, why(r));
      assert.match(r.report.failure, /DRILL_REVOKED_KEYS/);
    });
  });

  test("down không làm Redis chết (health vẫn up) => exit 3 và vẫn chạy up", async () => {
    await withFake({ downNoop: true }, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "down", "--fault-timeout-s", "1"]);
      assert.equal(r.code, 3, why(r));
      assert.equal(r.report.failedStep, "down.fault");
      assert.match(r.report.failure, /redis=degraded/);
      assert.equal(r.report.cleanup.up, "OK");
      assert.equal(fake.events("req").filter((e) => e.who === "A" && e.status === 401).length, 0, "không có kết luận nào từ request của A");
    });
  });

  test("sau up Redis còn degraded vài lần (health 200): driver chờ, recoveryMs phản ánh việc chờ", async () => {
    await withFake({ degradedAfterUp: 4, readyFailuresAfterUp: 2 }, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "down"]);
      assert.equal(r.code, 0, why(r));
      assert.ok(r.report.scenarios.down.recoveryMs >= 5 * 20, `recoveryMs ${r.report.scenarios.down.recoveryMs}`);
    });
  });

  test("Redis không bao giờ báo up lại => exit 3 ở bước phục hồi, cleanup.redisUp false", async () => {
    await withFake({ degradedAfterUp: 1_000_000 }, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "down", "--recovery-timeout-s", "1"]);
      assert.equal(r.code, 3, why(r));
      assert.equal(r.report.failedStep, "down.recover");
    });
  });

  test("Redis không up trước khi bắt đầu => exit 3 ở preflight", async () => {
    await withFake({}, async (fake) => {
      fake.redis.up = false;
      const r = await runDriver(fake, ["--scenarios", "flush"]);
      assert.equal(r.code, 3, why(r));
      assert.equal(r.report.failedStep, "preflight");
    });
  });
});

describe("TC-186-15 giới hạn tốc độ", () => {
  test("429 ở request quyết định => exit 3 (không kết luận), không phải exit 1", async () => {
    await withFake({}, async (fake) => {
      fake.cfg.rateLimitAfterFault = true; // request kế tiếp của A sau flush bị 429
      const r = await runDriver(fake, ["--scenarios", "flush"]);
      assert.equal(r.report.failedStep, "flush.next-request");
      assert.equal(r.code, 3, why(r));
      assert.match(r.report.failure, /429/);
    });
  });
});

describe("TC-186-16 Cognito và TLS", () => {
  test("Cognito trả thử thách NEW_PASSWORD_REQUIRED => exit 3, không lộ mật khẩu", async () => {
    await withFake({ cognitoChallenge: true }, async (fake) => {
      const r = await runDriver(fake, ["--scenarios", "flush"]);
      assert.equal(r.code, 3, why(r));
      assert.ok(!`${r.stdout}${r.stderr}${JSON.stringify(r.report)}`.includes(PW.a));
    });
  });

  test("API https chứng chỉ tự ký: --insecure chạy được, thiếu --insecure thì exit 3", async (t) => {
    if (!tlsFiles) return t.skip("không có openssl để dựng chứng chỉ tự ký");
    await withFake({}, async (fake) => {
      const ok = await runDriver(fake, ["--scenarios", "flush", "--insecure", "--cognito-endpoint", "http://127.0.0.1:1/unused", "--token-a-cmd", hook("token a"), "--token-b-cmd", hook("token b")]);
      assert.equal(ok.code, 0, why(ok));
      const strict = await runDriver(fake, ["--scenarios", "flush", "--token-a-cmd", hook("token a"), "--token-b-cmd", hook("token b")]);
      assert.equal(strict.code, 3, why(strict));
    }, tlsFiles);
  });

  test("Cognito chứng chỉ tự ký bị từ chối kể cả khi có --insecure (insecure chỉ áp cho API)", async (t) => {
    if (!tlsFiles) return t.skip("không có openssl để dựng chứng chỉ tự ký");
    await withFake({}, async (cognitoFake) => {
      await withFake({}, async (api) => {
        const r = await runDriver(api, ["--scenarios", "flush", "--insecure", "--cognito-endpoint", `${cognitoFake.url}/cognito`], { env: { FAKE_CTL: api.url } });
        assert.equal(r.code, 3, why(r));
        assert.equal(cognitoFake.events("cognito").length, 0, "không có kết nối TLS nào tới Cognito giả được chấp nhận");
        assert.match(r.report.failure, /Cognito/);
      });
    }, tlsFiles);
  });
});

describe("bộ che (redact) và đọc mốc", () => {
  test("che JWT, Bearer, mật khẩu, URL có thông tin đăng nhập, ARN, id tài khoản, host AWS và bí mật đã biết", async () => {
    const { redact } = await import(pathToFileURL(DRIVER).href);
    const jwt = makeJwt({ sub: "x", iat: 1, group: "customer" });
    const samples = [
      jwt,
      `Authorization: Bearer ${jwt}`,
      `${"pass"}${"word"}=${FAKE_PW}`,
      `--${"pass"}${"word"} ${FAKE_PW}`,
      `REDISCLI_${"AUTH"}=${FAKE_PW} redis-cli`,
      "rediss://default:s3cr3tTokenValue@master.x.cache.amazonaws.com:6379",
      "arn:aws:iam::123456789012:role/dbs",
      "account 123456789012",
      "dbs-123.ap-southeast-1.elb.amazonaws.com",
      "token-bi-mat-da-biet-123",
    ];
    for (const s of samples) {
      const out = redact(s, ["token-bi-mat-da-biet-123"]);
      for (const bad of [jwt, FAKE_PW, "s3cr3tTokenValue", "123456789012", "amazonaws.com", "token-bi-mat-da-biet-123", "Bearer"])
        assert.ok(!out.includes(bad), `"${s}" -> "${out}" còn ${bad}`);
    }
    const keep = "SESSION_REVOKED 401 0f6c1d3e-0000-4000-8000-000000000001 2026-11-22T10:15:30.123Z 1795343730123 abc1234";
    assert.equal(redact(keep), keep, "UUID, thời gian ISO, epoch ms và SHA không bị che");
  });

  test("parseMarker: NULL, epoch giây, timestamptz::text với nhiều múi giờ, rác", async () => {
    const { parseMarker } = await import(pathToFileURL(DRIVER).href);
    assert.deepEqual(parseMarker("NULL"), { raw: "NULL", epochMs: null, floorSec: null });
    assert.equal(parseMarker("1795343730.987654").floorSec, 1795343730);
    assert.equal(parseMarker("2026-11-22 10:15:30.123456+00").floorSec, Date.parse("2026-11-22T10:15:30Z") / 1000);
    assert.equal(parseMarker("2026-11-22 17:15:30.999999+07").floorSec, Date.parse("2026-11-22T10:15:30Z") / 1000);
    assert.equal(parseMarker("2026-11-22T10:15:30.5Z").floorSec, Date.parse("2026-11-22T10:15:30Z") / 1000);
    assert.throws(() => parseMarker("hôm qua"), /định dạng/);
  });
});

describe("TC-186-17 User-Agent (WAF NoUserAgent_HEADER chặn 403 request không có User-Agent)", () => {
  test("mọi request của driver mang User-Agent, header của người gọi vẫn ghi đè được", async () => {
    const { request } = await import(pathToFileURL(DRIVER).href);
    const http = await import("node:http");
    const seen = [];
    const server = http.createServer((req, res) => {
      seen.push(req.headers["user-agent"]);
      res.end("{}");
    });
    await new Promise((r) => server.listen(0, "127.0.0.1", r));
    try {
      const url = `http://127.0.0.1:${server.address().port}/x`;
      await request(url);
      await request(url, { headers: { "user-agent": "custom/1" } });
    } finally {
      await new Promise((r) => server.close(r));
    }
    assert.match(seen[0], /^dbs-drill-revocation\/\d+$/);
    assert.equal(seen[1], "custom/1");
  });
});
