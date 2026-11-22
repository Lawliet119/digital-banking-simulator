#!/usr/bin/env node
// DBS-186 (phần cloud): drill thu hồi phiên khi Redis mất dữ liệu (flush) hoặc chết (down), chạy từ máy vận hành
// vào ALB thật của stack `session` (Cognito, ElastiCache TLS, ECS, RDS). Thiết kế, hợp đồng hook và cách chạy:
// docs/features/DBS-186-redis-revocation-drill.md §1.1, §2.1, §3.1, §5.1.
//
// Dùng (đủ tham số: xem USAGE bên dưới và tài liệu; lệnh hook có biến môi trường DRILL_* tương ứng):
//   node infra/scripts/drill-revocation-cloud.mjs --base-url https://<alb> --insecure --confirm-idle --out <thư-mục> \
//     --operator-token-cmd '<in một dòng JWT>' \
//     --cognito-client-id <dbs-app> --user-a-email <a> --user-b-email <b>   (mật khẩu: DRILL_USER_A_PASSWORD, DRILL_USER_B_PASSWORD) \
//     --flush-cmd '…' --down-cmd '…' --up-cmd '…' --sql-marker-cmd '…' --invariants-cmd '…'
//
// Driver KHÔNG biết cơ chế flush/down và không nối RDS/Redis: mọi thứ cần quyền đó là hook (lệnh shell). Thứ tự đúng
// của mỗi kiểu: lock -> fault -> request kế tiếp của A (không có request nào của A xen giữa fault và phép kiểm).
// Driver không tin mã thoát của hook là bằng chứng fault đã xảy ra: down phải làm `/health/ready` báo `redis: degraded`,
// flush phải in `DRILL_REVOKED_KEYS_BEFORE>=1` và `DRILL_REVOKED_KEYS_AFTER=0`; thiếu thì thoát 3, không bao giờ PASS.
// Token (JWT), Authorization, mật khẩu, token Redis không bao giờ được in hoặc ghi: mọi đầu ra qua `redact` và chỉ các
// trường đã chọn (mã trạng thái, errorCode, correlationId) được ghi, không ghi thân phản hồi, lệnh hook hay đầu ra hook.
//
// Thoát: 0 PASS; 1 một khẳng định sai (ví dụ 200 sau fault); 2 dùng sai tham số; 3 lỗi môi trường, hook hoặc không kết
// luận được; 4 bất biến FAIL. Dừng ở bước lỗi đầu tiên; luôn chạy --up-cmd nếu đã gọi down mà chưa xác nhận phục hồi
// (kể cả khi nhận SIGINT/SIGTERM). Không phụ thuộc ngoài: chỉ node:http/https/child_process.
import { spawn } from "node:child_process";
import http from "node:http";
import https from "node:https";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { randomUUID } from "node:crypto";

export const EXIT = { PASS: 0, FAIL: 1, USAGE: 2, ENV: 3, INVARIANTS: 4 };

class UsageError extends Error {}
class EnvError extends Error {}
class HookError extends Error {}
class AssertionFail extends Error {}
class InvariantFail extends Error {}

// ---------------------------------------------------------------------------------------------------------------
// Bộ che. Một cửa duy nhất cho mọi thứ ghi ra stdout, drill.log, report.json và thông điệp lỗi.
const KNOWN_SECRETS = new Set();
export function registerSecret(value) {
  if (typeof value === "string" && value.length >= 4) KNOWN_SECRETS.add(value);
}
const RULES = [
  [/eyJ[A-Za-z0-9_-]{3,}\.[A-Za-z0-9_-]{3,}(?:\.[A-Za-z0-9_-]*)?/g, "[JWT]"],
  [/\b(?:Bearer|Basic)\s+[^\s"',;]+/gi, "[REDACTED]"],
  [/\b(authorization)\s*[:=]\s*[^\r\n"']*/gi, "$1: [REDACTED]"],
  [/\b([A-Za-z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|AUTH)[A-Za-z0-9_]*)\s*[=:]\s*[^\s"',;&]+/gi, "$1=[REDACTED]"],
  [/(?<![\w-])(--?(?:password|passwd|pass|secret|token|auth|a))\s+[^\s"']+/gi, "$1 [REDACTED]"],
  [/\b([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]*:[^\s/@]*@/gi, "$1[REDACTED]@"],
  [/\barn:aws[a-z-]*:[^\s"',;]*/gi, "[ARN]"],
  [/(?<![\w-])\d{12}(?![\w-])/g, "[ACCOUNT]"],
  [/[A-Za-z0-9.-]+\.amazonaws\.com(?:\.cn)?/gi, "[AWS-HOST]"],
];
export function redact(text, extraSecrets = []) {
  let out = String(text);
  for (const s of [...KNOWN_SECRETS, ...extraSecrets]) if (typeof s === "string" && s.length >= 4) out = out.split(s).join("[REDACTED]");
  for (const [re, to] of RULES) out = out.replace(re, to);
  return out;
}

// ---------------------------------------------------------------------------------------------------------------
// Tham số
const VALUE_OPTS = {
  "base-url": "DRILL_BASE_URL",
  out: null,
  "operator-token-cmd": "DRILL_OPERATOR_TOKEN_CMD",
  "token-a-cmd": "DRILL_TOKEN_A_CMD",
  "token-b-cmd": "DRILL_TOKEN_B_CMD",
  "cognito-client-id": "DRILL_COGNITO_CLIENT_ID",
  "cognito-region": null,
  "cognito-endpoint": null,
  "user-a-email": "DRILL_USER_A_EMAIL",
  "user-b-email": "DRILL_USER_B_EMAIL",
  "flush-cmd": "DRILL_FLUSH_CMD",
  "down-cmd": "DRILL_DOWN_CMD",
  "up-cmd": "DRILL_UP_CMD",
  "sql-marker-cmd": "DRILL_SQL_MARKER_CMD",
  "invariants-cmd": "DRILL_INVARIANTS_CMD",
  scenarios: null,
  "same-second-attempts": null,
  "same-second-down-attempts": null,
  "same-second-modes": null,
  "settle-ms": null,
  "recovery-timeout-s": null,
  "fault-timeout-s": null,
  "hook-timeout-s": null,
  "token-margin-s": null,
  "poll-ms": null,
  "hook-env": null,
  "run-id": null,
  "image-sha": null,
  shell: null,
};
const FLAG_OPTS = ["confirm-idle", "insecure", "help"];

const USAGE = `Dùng: node infra/scripts/drill-revocation-cloud.mjs --base-url <url> --out <dir> --confirm-idle
  --operator-token-cmd <cmd> (--cognito-client-id <id> --user-a-email <e> --user-b-email <e> | --token-a-cmd <cmd> --token-b-cmd <cmd>)
  --sql-marker-cmd <cmd> --invariants-cmd <cmd> [--flush-cmd <cmd>] [--down-cmd <cmd> --up-cmd <cmd>]
  [--scenarios flush,down|none] [--same-second-attempts 4] [--same-second-down-attempts 2] [--same-second-modes hit,flush[,down]]
  [--insecure (chỉ cho API)] [--shell <đường-dẫn>] [--hook-env NAME,NAME] [--settle-ms 2500] [--recovery-timeout-s 300]
  [--fault-timeout-s 120] [--hook-timeout-s 600] [--token-margin-s 60] [--cognito-region ap-southeast-1] [--run-id <id>] [--image-sha <sha>]
Mật khẩu khách: biến môi trường DRILL_USER_A_PASSWORD, DRILL_USER_B_PASSWORD. Chi tiết: docs/features/DBS-186-redis-revocation-drill.md §3.1.`;

function num(raw, name, { min = 0, integer = false } = {}) {
  const n = Number(raw);
  if (raw === "" || !Number.isFinite(n) || n < min || (integer && !Number.isInteger(n))) throw new UsageError(`--${name} phải là số ${integer ? "nguyên " : ""}>= ${min}`);
  return n;
}

export function parseConfig(argv, env = process.env) {
  const given = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) throw new UsageError(`Tham số lạ: ${a}`);
    let [key, inline] = a.slice(2).split(/=(.*)/s, 2);
    if (FLAG_OPTS.includes(key)) {
      given[key] = true;
      continue;
    }
    if (!(key in VALUE_OPTS)) throw new UsageError(`Tham số lạ: --${key}`);
    if (inline === undefined) {
      inline = argv[++i];
      if (inline === undefined) throw new UsageError(`--${key} thiếu giá trị`);
    }
    given[key] = inline;
  }
  if (given.help) throw new UsageError("help");
  const get = (k) => {
    if (given[k] !== undefined) return given[k];
    const e = VALUE_OPTS[k];
    return e && env[e] ? env[e] : undefined;
  };
  const cfg = {
    baseUrl: get("base-url"),
    out: get("out"),
    insecure: Boolean(given.insecure),
    confirmIdle: Boolean(given["confirm-idle"]),
    operatorTokenCmd: get("operator-token-cmd"),
    tokenCmd: { a: get("token-a-cmd"), b: get("token-b-cmd") },
    clientId: get("cognito-client-id"),
    region: get("cognito-region") ?? "ap-southeast-1",
    email: { a: get("user-a-email"), b: get("user-b-email") },
    password: { a: env.DRILL_USER_A_PASSWORD, b: env.DRILL_USER_B_PASSWORD },
    cmd: {
      flush: get("flush-cmd"),
      down: get("down-cmd"),
      up: get("up-cmd"),
      marker: get("sql-marker-cmd"),
      invariants: get("invariants-cmd"),
    },
    shell: get("shell") ?? true,
    hookEnv: (get("hook-env") ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    runId: get("run-id") ?? `${Date.now().toString(36)}-${randomUUID().slice(0, 4)}`,
    imageSha: get("image-sha") ?? null,
  };
  if (typeof cfg.shell === "string" && !existsSync(cfg.shell)) throw new UsageError("--shell: đường dẫn không tồn tại (trên Windows dùng đường dẫn Windows, ví dụ $(cygpath -w \"$(command -v bash)\"))");
  cfg.cognitoEndpoint = get("cognito-endpoint") ?? `https://cognito-idp.${cfg.region}.amazonaws.com/`;
  const scenarios = (get("scenarios") ?? "flush,down").trim();
  cfg.scenarios = scenarios === "none" || scenarios === "" ? [] : scenarios.split(",").map((s) => s.trim());
  for (const s of cfg.scenarios) if (!["flush", "down"].includes(s)) throw new UsageError(`--scenarios: "${s}" không hợp lệ (flush, down, none)`);
  cfg.sameSecondAttempts = num(get("same-second-attempts") ?? "4", "same-second-attempts", { integer: true });
  cfg.sameSecondDownAttempts = num(get("same-second-down-attempts") ?? "2", "same-second-down-attempts", { integer: true });
  cfg.sameSecondModes = (get("same-second-modes") ?? "hit,flush").split(",").map((s) => s.trim()).filter(Boolean);
  for (const m of cfg.sameSecondModes) if (!["hit", "flush", "down"].includes(m)) throw new UsageError(`--same-second-modes: "${m}" không hợp lệ (hit, flush, down)`);
  cfg.settleMs = num(get("settle-ms") ?? "2500", "settle-ms");
  cfg.recoveryTimeoutMs = num(get("recovery-timeout-s") ?? "300", "recovery-timeout-s") * 1000;
  cfg.faultTimeoutMs = num(get("fault-timeout-s") ?? "120", "fault-timeout-s") * 1000;
  cfg.hookTimeoutMs = num(get("hook-timeout-s") ?? "600", "hook-timeout-s", { min: 0.1 }) * 1000;
  cfg.tokenMarginMs = num(get("token-margin-s") ?? "60", "token-margin-s") * 1000;
  cfg.pollMs = num(get("poll-ms") ?? "1000", "poll-ms", { min: 1 });

  // ---- kiểm tra ----
  if (!cfg.baseUrl || !/^https?:\/\/[^/\s]+/i.test(cfg.baseUrl)) throw new UsageError("--base-url phải là http(s)://…");
  cfg.baseUrl = cfg.baseUrl.replace(/\/+$/, "");
  if (!cfg.out) throw new UsageError("Thiếu --out");
  if (!cfg.confirmIdle) throw new UsageError("Thiếu --confirm-idle: drill không chạy khi đang có tải k6; người điều phối phải xác nhận rõ");
  const need = (v, what) => {
    if (!v) throw new UsageError(`Thiếu ${what}`);
  };
  need(cfg.operatorTokenCmd, "--operator-token-cmd");
  need(cfg.cmd.marker, "--sql-marker-cmd");
  need(cfg.cmd.invariants, "--invariants-cmd");
  for (const who of ["a", "b"]) {
    if (cfg.tokenCmd[who]) continue;
    if (!cfg.clientId || !cfg.email[who] || !cfg.password[who]) throw new UsageError(`Khách ${who.toUpperCase()}: cần --token-${who}-cmd, hoặc --cognito-client-id, --user-${who}-email và DRILL_USER_${who.toUpperCase()}_PASSWORD`);
  }
  const boundary = (mode) => cfg.sameSecondModes.includes(mode) && (mode === "down" ? cfg.sameSecondDownAttempts : cfg.sameSecondAttempts) > 0;
  const wantsFlush = cfg.scenarios.includes("flush") || boundary("flush");
  const wantsDown = cfg.scenarios.includes("down") || boundary("down");
  if (wantsFlush) need(cfg.cmd.flush, "--flush-cmd (kiểu flush)");
  if (wantsDown) {
    need(cfg.cmd.down, "--down-cmd (kiểu down)");
    need(cfg.cmd.up, "--up-cmd (bắt buộc đi cùng down)");
  }
  cfg.boundaryModes = cfg.sameSecondModes.filter(boundary);
  if (!cfg.scenarios.length && !cfg.boundaryModes.length) throw new UsageError("Không có gì để chạy (--scenarios none và không có lần thử BL-222)");
  return cfg;
}

// ---------------------------------------------------------------------------------------------------------------
// HTTP: node:http/https để --insecure chỉ áp cho API (ALB tự ký), không áp cho Cognito.
export function request(urlStr, { method = "GET", headers = {}, body, insecure = false, timeoutMs = 20000 } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const lib = u.protocol === "https:" ? https : http;
    const payload = body === undefined ? undefined : Buffer.from(typeof body === "string" ? body : JSON.stringify(body));
    const t0 = performance.now();
    const req = lib.request(
      u,
      {
        method,
        agent: false,
        // WAF `AWSManagedRulesCommonRuleSet` (NoUserAgent_HEADER) chặn 403 request không có User-Agent: node:https không tự thêm
        // (lỗi thấy ở lần chạy cloud đầu tiên, preflight /health/ready trả 403).
        headers: { "user-agent": "dbs-drill-revocation/1", ...(payload ? { "content-type": "application/json", "content-length": payload.length } : {}), ...headers },
        ...(u.protocol === "https:" ? { rejectUnauthorized: !insecure } : {}),
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode, headers: res.headers, text: Buffer.concat(chunks).toString("utf8"), ms: Math.round(performance.now() - t0) }));
        res.on("error", reject);
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---------------------------------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const JWT_FULL = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const idOf = (p) => p.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ":id");
// Biến môi trường hook được thừa hưởng (danh sách cho phép). Mật khẩu của khách drill và mọi biến khác KHÔNG chuyển;
// cần thêm thì dùng --hook-env NAME,NAME. AWS_* đi qua vì hook của người điều phối cần thông tin đăng nhập AWS.
const HOOK_ENV_ALLOW =
  /^(PATH|Path|PATHEXT|SystemRoot|SYSTEMROOT|SystemDrive|ComSpec|COMSPEC|HOME|HOMEDRIVE|HOMEPATH|USERPROFILE|APPDATA|LOCALAPPDATA|TEMP|TMP|TMPDIR|LANG|LC_[A-Z]+|TERM|SHELL|MSYSTEM|MSYS2_PATH_TYPE|NODE_PATH|NODE_EXTRA_CA_CERTS|AWS_[A-Z_]+|DOCKER_[A-Z_]+|HTTPS?_PROXY|https?_proxy|NO_PROXY|no_proxy|SSL_CERT_[A-Z]+|REQUESTS_CA_BUNDLE|ProgramFiles|ProgramFiles\(x86\)|ProgramData|windir|OS|USERNAME|USER|LOGNAME|PWD|TZ)$/;

export function decodeClaims(token) {
  try {
    return JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
  } catch {
    return {};
  }
}

// Mốc `users.sessions_revoked_at` từ một dòng do hook in: `NULL`, epoch giây, hoặc timestamptz dạng text (nên ép UTC).
export function parseMarker(line) {
  const raw = String(line).trim();
  if (raw === "" || /^null$/i.test(raw)) return { raw: "NULL", epochMs: null, floorSec: null };
  let ms;
  if (/^\d+(\.\d+)?$/.test(raw)) ms = Number(raw) * 1000;
  else if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}(:?\d{2})?)?$/.test(raw)) {
    let iso = raw.replace(" ", "T");
    iso = iso.replace(/([+-]\d{2})$/, "$1:00").replace(/([+-]\d{2})(\d{2})$/, "$1:$2");
    if (!/(Z|[+-]\d{2}:\d{2})$/.test(iso)) iso += "Z";
    iso = iso.replace(/(\.\d{3})\d+/, "$1");
    ms = Date.parse(iso);
  } else throw new HookError("--sql-marker-cmd in ra dòng không đúng định dạng (NULL, epoch giây, hoặc timestamptz::text)");
  if (!Number.isFinite(ms)) throw new HookError("--sql-marker-cmd in ra mốc không đọc được");
  return { raw, epochMs: ms, floorSec: Math.floor(ms / 1000) };
}

// Bằng chứng của --flush-cmd: hai dòng KEY=số do hook in (số khóa `revoked_at:*` trước và sau khi flush).
export function parseFlushEvidence(stdout) {
  const pick = (key) => {
    const m = new RegExp(`^${key}=(\\d+)\\s*$`, "m").exec(stdout);
    return m ? Number(m[1]) : null;
  };
  return { before: pick("DRILL_REVOKED_KEYS_BEFORE"), after: pick("DRILL_REVOKED_KEYS_AFTER") };
}

// ---------------------------------------------------------------------------------------------------------------
class Drill {
  constructor(cfg) {
    this.cfg = cfg;
    this.started = Date.now();
    this.aborting = false;
    this.currentKill = null;
    this.report = {
      schema: 1,
      runId: cfg.runId,
      imageSha: cfg.imageSha,
      startedAt: new Date(this.started).toISOString(),
      finishedAt: null,
      verdict: "RUNNING",
      exitCode: null,
      failedStep: null,
      failure: null,
      scenarios: {},
      prepare: {},
      bl222: { status: "SKIPPED" },
      invariants: [],
      hooks: [],
      steps: [],
      cleanup: { up: "NOT_NEEDED", redisUp: null },
      notes: [],
    };
    this.state = { target: null, companion: null, targetLocked: false, downIssued: false, upConfirmed: false, oldTokenA: null, markers: {} };
    mkdirSync(cfg.out, { recursive: true });
    this.logFile = path.join(cfg.out, "drill.log");
    this.reportFile = path.join(cfg.out, "report.json");
    writeFileSync(this.logFile, "");
  }

  log(msg) {
    const line = redact(`${new Date().toISOString()} ${msg}`);
    process.stdout.write(`${line}\n`);
    appendFileSync(this.logFile, `${line}\n`);
  }
  save() {
    // Mọi byte ghi ra đều qua bộ che; nếu bộ che làm hỏng JSON thì báo lỗi to thay vì ghi tệp sai.
    const text = redact(JSON.stringify(this.report, null, 2));
    JSON.parse(text);
    writeFileSync(this.reportFile, `${text}\n`);
  }

  checkAbort() {
    if (this.aborting) throw new EnvError("drill đang bị ngắt");
  }
  async step(id, title, fn) {
    this.checkAbort();
    const t0 = Date.now();
    this.log(`... ${id}: ${title}`);
    try {
      const details = await fn();
      this.report.steps.push({ id, title, status: "PASS", durationMs: Date.now() - t0 });
      this.log(`PASS ${id}${details ? ` ${details}` : ""} (${Date.now() - t0} ms)`);
      this.save();
    } catch (e) {
      this.report.steps.push({ id, title, status: "FAIL", durationMs: Date.now() - t0 });
      if (!this.report.failedStep) this.report.failedStep = id;
      this.report.failure = String(e && e.message);
      this.log(`FAIL ${id}: ${e && e.message}`);
      throw e;
    }
  }

  // ---- HTTP vào API ----
  async api(method, p, { token, body } = {}) {
    this.checkAbort();
    let claims = null;
    if (token) {
      claims = decodeClaims(token);
      if (typeof claims.exp === "number" && claims.exp * 1000 - Date.now() < this.cfg.tokenMarginMs)
        throw new EnvError(`Token còn dưới ${Math.round(this.cfg.tokenMarginMs / 1000)} s hạn: không gửi ${method} ${idOf(p)}, drill không kết luận được (hook quá chậm so với hạn 15 phút của access token)`);
    }
    let res;
    try {
      res = await request(`${this.cfg.baseUrl}${p}`, { method, headers: token ? { authorization: `Bearer ${token}` } : {}, body, insecure: this.cfg.insecure });
    } catch (e) {
      throw new EnvError(`Không gọi được API ${method} ${idOf(p)}: ${e && e.message}`);
    }
    let json = null;
    try {
      json = JSON.parse(res.text);
    } catch {
      /* không phải JSON */
    }
    const out = {
      status: res.status,
      errorCode: json && typeof json.errorCode === "string" ? json.errorCode : null,
      correlationId: res.headers["x-correlation-id"] ?? null,
      bodyCorrelationId: json && typeof json.correlationId === "string" ? json.correlationId : null,
      json,
      ms: res.ms,
    };
    if (res.status === 429) throw new EnvError(`API trả 429 (Retry-After ${res.headers["retry-after"] ?? "?"}) ở ${method} ${idOf(p)}: giới hạn tốc độ, drill không kết luận được`);
    if (out.errorCode === "TOKEN_EXPIRED") {
      if (claims && typeof claims.exp === "number" && claims.exp * 1000 > Date.now())
        throw new AssertionFail(`API báo TOKEN_EXPIRED ở ${method} ${idOf(p)} dù exp của token còn hạn (lệch đồng hồ hoặc lỗi guard)`);
      throw new EnvError(`API trả 401 TOKEN_EXPIRED ở ${method} ${idOf(p)}: token hết hạn giữa chừng, drill không kết luận được`);
    }
    return out;
  }
  brief(r) {
    return { status: r.status, errorCode: r.errorCode, correlationId: r.bodyCorrelationId ?? r.correlationId, latencyMs: r.ms };
  }
  expect(r, status, what) {
    if (r.status !== status) {
      const hint = r.errorCode === "SESSION_REVOKED" ? " (token mới bị coi là đã thu hồi: iat không sau mốc, tăng --settle-ms?)" : "";
      throw new AssertionFail(`${what}: mong đợi ${status}, nhận ${r.status}${r.errorCode ? ` ${r.errorCode}` : ""}${hint}`);
    }
  }
  assertRevoked(r, what) {
    const bad = [];
    if (r.status !== 401) bad.push(`status ${r.status} thay vì 401`);
    if (r.errorCode !== "SESSION_REVOKED") bad.push(`errorCode ${r.errorCode ?? "(không có)"} thay vì SESSION_REVOKED`);
    if (!r.bodyCorrelationId) bad.push("thiếu correlationId trong thân");
    else if (r.bodyCorrelationId !== r.correlationId) bad.push("correlationId trong thân khác header x-correlation-id");
    if (bad.length) throw new AssertionFail(`${what}: ${bad.join("; ")}`);
  }

  // ---- token ----
  async token(role) {
    this.checkAbort();
    if (role === "operator") return this.fromCmd("operator-token", this.cfg.operatorTokenCmd);
    if (this.cfg.tokenCmd[role]) return this.fromCmd(`token-${role}`, this.cfg.tokenCmd[role]);
    let res;
    try {
      res = await request(this.cfg.cognitoEndpoint, {
        method: "POST",
        headers: { "content-type": "application/x-amz-json-1.1", "x-amz-target": "AWSCognitoIdentityProviderService.InitiateAuth" },
        body: { AuthFlow: "USER_PASSWORD_AUTH", ClientId: this.cfg.clientId, AuthParameters: { USERNAME: this.cfg.email[role], PASSWORD: this.cfg.password[role] } },
        timeoutMs: 15000, // không có insecure: Cognito luôn được kiểm chứng chỉ
      });
    } catch (e) {
      throw new EnvError(`Không gọi được Cognito: ${e && e.message}`);
    }
    let t = null;
    try {
      t = JSON.parse(res.text)?.AuthenticationResult?.AccessToken;
    } catch {
      /* bỏ qua */
    }
    if (res.status !== 200 || typeof t !== "string" || !JWT_FULL.test(t)) throw new EnvError(`Cognito không trả access token cho khách ${role.toUpperCase()} (HTTP ${res.status}; thử thách hoặc sai mật khẩu)`);
    return this.accept(t);
  }
  accept(t) {
    registerSecret(t);
    const c = decodeClaims(t);
    if (!Number.isInteger(c.iat)) throw new EnvError("Access token không có iat nguyên");
    return { token: t, iat: c.iat, exp: c.exp };
  }
  async fromCmd(name, cmd) {
    const r = await this.hook(name, cmd, "token");
    const t = r.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    if (!JWT_FULL.test(t)) throw new HookError(`Hook ${name} không in ra đúng một dòng JWT`);
    return this.accept(t);
  }

  // ---- hook ----
  hookEnv(phase) {
    const env = {};
    for (const [k, v] of Object.entries(process.env)) if (HOOK_ENV_ALLOW.test(k) || this.cfg.hookEnv.includes(k)) env[k] = v;
    return Object.assign(env, {
      DRILL_RUN_ID: this.cfg.runId,
      DRILL_PHASE: phase,
      DRILL_ACCOUNT_ID: this.state.target ?? "",
      DRILL_COMPANION_ACCOUNT_ID: this.state.companion ?? "",
    });
  }
  // Chạy lệnh shell bằng spawn bất đồng bộ (không spawnSync: sẽ chặn vòng lặp sự kiện). Quá hạn thì giết cả cây tiến trình.
  hook(name, cmd, phase, { allowFail = false, force = false } = {}) {
    if (this.aborting && !force) return Promise.reject(new EnvError("drill đang bị ngắt: không chạy hook mới"));
    const t0 = Date.now();
    const rec = { name, phase, exitCode: null, durationMs: 0, timedOut: false };
    this.report.hooks.push(rec);
    return new Promise((resolve, reject) => {
      const CAP = 64 * 1024;
      let stdout = "";
      let stderr = "";
      let done = false;
      const child = spawn(cmd, { shell: this.cfg.shell, env: this.hookEnv(phase), stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
      const kill = () => {
        try {
          if (process.platform === "win32") spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
          else process.kill(-child.pid, "SIGKILL");
        } catch {
          /* đã thoát */
        }
      };
      const finish = (code, timedOut, spawnError) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        if (this.currentKill === kill) this.currentKill = null;
        rec.exitCode = code;
        rec.timedOut = timedOut;
        rec.durationMs = Date.now() - t0;
        this.log(`hook ${name} (${phase}): ${timedOut ? "quá hạn" : spawnError ? "không chạy được" : `thoát ${code}`}, ${rec.durationMs} ms`);
        if (!allowFail && (timedOut || code !== 0 || spawnError)) {
          const tail = redact(stderr).trim().replace(/\s+/g, " ").slice(-300); // che trước, cắt sau: không để lại mảnh bí mật
          reject(new HookError(`Hook ${name} ${timedOut ? `quá hạn ${Math.round(this.cfg.hookTimeoutMs / 1000)} s` : spawnError ? "không chạy được" : `thoát ${code}`}${tail ? `; stderr: ${tail}` : ""}`));
        } else resolve({ code, stdout, stderr, timedOut });
      };
      const timer = setTimeout(() => {
        kill();
        child.stdout.destroy();
        child.stderr.destroy();
        finish(null, true, false);
      }, this.cfg.hookTimeoutMs);
      this.currentKill = kill;
      child.stdout.on("data", (d) => {
        if (stdout.length < CAP) stdout += d;
      });
      child.stderr.on("data", (d) => {
        if (stderr.length < CAP) stderr += d;
      });
      child.on("error", () => finish(null, false, true));
      child.on("close", (code) => finish(code, false, false));
    });
  }
  async marker(phase) {
    if (this.state.target && !UUID.test(this.state.target)) throw new AssertionFail("id tài khoản đích không phải UUID: không truyền cho hook");
    const r = await this.hook("sql-marker", this.cfg.cmd.marker, phase);
    const line = r.stdout.trim().split(/\r?\n/).filter(Boolean).pop() ?? "";
    return parseMarker(line);
  }
  async invariants(after) {
    const rec = { after, exit: null, status: "ERROR" };
    this.report.invariants.push(rec);
    const r = await this.hook("invariants", this.cfg.cmd.invariants, after, { allowFail: true });
    rec.exit = r.code;
    if (r.code === 0) {
      rec.status = "PASS";
      return;
    }
    if (r.code === 1 && !r.timedOut) {
      rec.status = "FAIL";
      throw new InvariantFail(`Bất biến DBS-69 FAIL sau ${after}: dừng ngay`);
    }
    throw new HookError(`Hook invariants: ${r.timedOut ? "quá hạn" : `lỗi checker (thoát ${r.code})`}`);
  }

  // `/health/ready` trả 200 kể cả khi Redis chết (chỉ PostgreSQL chặn readiness): Redis nằm ở trường `redis` của thân.
  async readiness() {
    try {
      const r = await request(`${this.cfg.baseUrl}/health/ready`, { insecure: this.cfg.insecure, timeoutMs: 5000 });
      let redis = null;
      try {
        redis = JSON.parse(r.text).redis ?? null;
      } catch {
        /* không phải JSON */
      }
      return { ok: r.status === 200, redis };
    } catch {
      return { ok: false, redis: null };
    }
  }
  async waitRedis(want, timeoutMs, what, consecutive = 1) {
    const t0 = Date.now();
    let streak = 0;
    for (;;) {
      if (this.aborting && !this.cleaning) throw new EnvError("drill đang bị ngắt");
      const r = await this.readiness();
      streak = r.ok && r.redis === want ? streak + 1 : 0;
      if (streak >= consecutive) return Date.now() - t0;
      if (Date.now() - t0 > timeoutMs) throw new EnvError(`${what}: /health/ready không báo redis=${want} sau ${Math.round(timeoutMs / 1000)} s (hook không có hiệu lực hoặc Redis chưa phục hồi)`);
      await sleep(this.cfg.pollMs);
    }
  }
  async flushHook(phase, { needBefore }) {
    const r = await this.hook("flush", this.cfg.cmd.flush, phase);
    const ev = parseFlushEvidence(r.stdout);
    if (ev.after === null || (needBefore && ev.before === null)) throw new EnvError("--flush-cmd phải in DRILL_REVOKED_KEYS_BEFORE=<n> và DRILL_REVOKED_KEYS_AFTER=<n> (số khóa revoked_at:* trước và sau flush)");
    if (needBefore && ev.before < 1) throw new EnvError("Trước flush Redis không có khóa revoked_at:* nào: flush không có gì để chứng minh");
    if (ev.after !== 0) throw new EnvError(`Sau flush còn ${ev.after} khóa revoked_at:*: flush không có hiệu lực`);
    return ev;
  }
  async faultDown(phase) {
    this.state.downIssued = true;
    this.state.upConfirmed = false;
    const before = await this.readiness();
    if (!before.ok || before.redis !== "up") throw new EnvError("Trước down Redis không ở trạng thái up theo /health/ready");
    await this.hook("down", this.cfg.cmd.down, phase);
    return this.waitRedis("degraded", this.cfg.faultTimeoutMs, "sau down"); // bằng chứng độc lập là fault có hiệu lực
  }
  // Request quyết định của kiểu down chỉ có giá trị nếu ngay trước đó Redis vẫn degraded (down tự lành thì không phải SQL fallback).
  async requireDegraded(what) {
    const r = await this.readiness();
    if (!r.ok || r.redis !== "degraded") throw new EnvError(`${what}: ngay trước request quyết định /health/ready không báo redis degraded (Redis đã tự lành hoặc health lỗi): đây không còn là đường SQL fallback`);
    return r.redis;
  }
  async recoverUp(phase) {
    const t0 = Date.now();
    await this.hook("up", this.cfg.cmd.up, phase);
    const upHookMs = Date.now() - t0;
    await this.waitRedis("up", this.cfg.recoveryTimeoutMs, "sau up", 2);
    this.state.upConfirmed = true;
    return { upHookMs, recoveryMs: Date.now() - t0 };
  }
  async lockTarget(opToken, what) {
    const r = await this.api("POST", `/v1/operator/accounts/${this.state.target}/lock`, { token: opToken, body: { reason: "CONFIRMED_FRAUD" } });
    this.expect(r, 200, what);
    if (r.json?.status !== "LOCKED") throw new AssertionFail(`${what}: tài khoản không ở trạng thái LOCKED`);
    this.state.targetLocked = true;
    return r;
  }
  async unlock(id, opToken, what) {
    const r = await this.api("POST", `/v1/operator/accounts/${id}/unlock`, { token: opToken, body: { reason: "OPERATOR_UNLOCK" } });
    this.expect(r, 200, what);
    return r;
  }

  // ---------------------------------------------------------------------------------------------------------------
  async prepare() {
    const rep = this.report.prepare;
    await this.step("preflight", "GET /health/ready (PostgreSQL ready, Redis up)", async () => {
      let r;
      try {
        r = await request(`${this.cfg.baseUrl}/health/ready`, { insecure: this.cfg.insecure, timeoutMs: 10000 });
      } catch (e) {
        throw new EnvError(`Không gọi được ALB: ${e && e.message}`);
      }
      if (r.status !== 200) throw new EnvError(`/health/ready trả ${r.status}`);
      const redis = (await this.readiness()).redis;
      if (redis !== "up") throw new EnvError(`Trước drill Redis phải up theo /health/ready (nhận ${redis ?? "không có trường redis"})`);
      rep.redisHealth = { before: redis };
      return "200, redis up";
    });
    await this.step("prepare", "khách A và B: hồ sơ, tài khoản, mở khóa nếu còn LOCKED", async () => {
      const tokens = { a: await this.token("a"), b: await this.token("b") };
      const accounts = {};
      let opened = 0;
      let unlocked = 0;
      let opToken = null;
      const listOf = async (who, label) => {
        const list = await this.api("GET", "/v1/accounts", { token: tokens[who].token });
        this.expect(list, 200, `GET /v1/accounts (${label})`);
        const items = Array.isArray(list.json) ? list.json : (list.json?.items ?? []);
        return items.slice().sort((x, y) => String(x.createdAt ?? "").localeCompare(String(y.createdAt ?? "")) || String(x.id).localeCompare(String(y.id)));
      };
      for (const who of ["a", "b"]) {
        const label = who.toUpperCase();
        const profile = { fullName: `Drill ${label} ${this.cfg.runId}` }; // tên tổng hợp, không log
        let me = await this.api("POST", "/v1/customers/me", { token: tokens[who].token, body: profile });
        if (me.errorCode === "SESSION_REVOKED") {
          // token mới nhưng iat không sau mốc của lần chạy trước: đợi rồi lấy token mới một lần
          await sleep(this.cfg.settleMs);
          tokens[who] = await this.token(who);
          me = await this.api("POST", "/v1/customers/me", { token: tokens[who].token, body: profile });
        }
        this.expect(me, 200, `POST /v1/customers/me (${label})`);
        const want = who === "a" ? 2 : 1;
        let items = await listOf(who, label);
        while (items.length < want && items.length < 3) {
          const open = await this.api("POST", "/v1/accounts", { token: tokens[who].token, body: { type: "CHECKING" } });
          this.expect(open, 201, `POST /v1/accounts (${label})`);
          opened++;
          items = await listOf(who, label); // đọc lại, không bao giờ gửi lại POST
        }
        for (const a of items.filter((x) => x.status === "LOCKED")) {
          opToken ??= (await this.token("operator")).token;
          await this.unlock(a.id, opToken, `mở khóa tài khoản còn LOCKED của ${label}`);
          unlocked++;
        }
        accounts[who] = items;
      }
      if (accounts.a.length < 2) throw new AssertionFail("Khách A không có đủ hai tài khoản");
      this.state.target = accounts.a[0].id;
      this.state.companion = accounts.a[1].id;
      if (!UUID.test(this.state.target) || !UUID.test(this.state.companion)) throw new AssertionFail("id tài khoản không phải UUID");
      rep.openedAccounts = opened;
      rep.unlockedAccounts = unlocked;
      rep.accountsA = accounts.a.length;
      rep.accountsB = accounts.b.length;
      if (unlocked > 0) await sleep(this.cfg.settleMs);
      rep.markerInitial = (await this.marker("prepare")).raw;
      return `A ${accounts.a.length} tài khoản, B ${accounts.b.length}, mở mới ${opened}, mở khóa ${unlocked}`;
    });
  }

  async scenarioFlush() {
    const rep = (this.report.scenarios.flush = {});
    const S = this.state;
    const m0 = await this.marker("flush"); // đọc trước khi lấy token: token A cần còn hạn lâu nhất có thể
    rep.markerBeforeLock = m0.raw;
    const tokA = await this.token("a");
    S.oldTokenA = tokA.token;
    await this.step("flush.a-before", "A GET /v1/accounts", async () => {
      const r = await this.api("GET", "/v1/accounts", { token: tokA.token });
      this.expect(r, 200, "A trước khi khóa");
      rep.aBefore = this.brief(r);
      return `${r.status}`;
    });
    await this.step("flush.b-before", "B GET /v1/accounts", async () => {
      const r = await this.api("GET", "/v1/accounts", { token: (await this.token("b")).token });
      this.expect(r, 200, "B trước khi khóa");
      return `${r.status}`;
    });
    const op = await this.token("operator");
    await this.step("flush.lock", "operator khóa tài khoản đích của A", async () => {
      const r = await this.lockTarget(op.token, "khóa tài khoản đích");
      return `${r.status} LOCKED`;
    });
    const m1 = await this.marker("flush");
    await this.step("flush.marker-after-lock", "mốc SQL đổi sau khóa", async () => {
      if (m1.raw === "NULL") throw new AssertionFail("sessions_revoked_at vẫn NULL sau khi khóa");
      if (m1.raw === m0.raw) throw new AssertionFail("sessions_revoked_at không đổi sau khi khóa");
      rep.markerAfterLock = m1.raw;
      S.markers.flush = m1.raw;
      return `mốc ${m1.raw}`;
    });
    await this.step("flush.fault", "--flush-cmd (Redis còn sống, mất khóa)", async () => {
      rep.revokedKeys = await this.flushHook("flush", { needBefore: true });
      return `khóa revoked_at:* ${rep.revokedKeys.before} -> ${rep.revokedKeys.after}`;
    });
    // Không có request nào của A giữa fault và phép kiểm này.
    await this.step("flush.next-request", "A: request kế tiếp phải 401 SESSION_REVOKED", async () => {
      const r = await this.api("GET", "/v1/accounts", { token: tokA.token });
      rep.nextRequest = this.brief(r);
      this.assertRevoked(r, "request kế tiếp của A sau flush");
      return `${r.status} ${r.errorCode} ${r.ms} ms`;
    });
    await this.step("flush.marker-after-fault", "mốc SQL còn nguyên sau flush", async () => {
      const m2 = await this.marker("flush");
      rep.markerAfterFault = m2.raw;
      rep.markerUnchanged = m2.raw === m1.raw;
      if (!rep.markerUnchanged) throw new AssertionFail("sessions_revoked_at đổi sau flush");
      return "nguyên văn";
    });
    await this.step("flush.bystander", "B (không bị thu hồi) vẫn 200", async () => {
      const r = await this.api("GET", "/v1/accounts", { token: (await this.token("b")).token });
      rep.bystander = this.brief(r);
      this.expect(r, 200, "B sau flush");
      return "200";
    });
    await this.step("flush.invariants", "bất biến DBS-69", () => this.invariants("flush"));
  }

  async scenarioDown() {
    const rep = (this.report.scenarios.down = {});
    const S = this.state;
    let unlocked = false;
    if (S.targetLocked) {
      const op = await this.token("operator");
      await this.step("down.unlock", "operator mở khóa tài khoản đích (mở khóa không xóa mốc)", async () => {
        await this.unlock(S.target, op.token, "mở khóa tài khoản đích");
        S.targetLocked = false;
        unlocked = true;
        return "200";
      });
    }
    if (unlocked) await sleep(this.cfg.settleMs); // iat của token mới phải sau mốc của lần khóa trước
    const d0 = await this.marker("down"); // đọc trước khi lấy token A mới
    if (unlocked && S.oldTokenA) {
      await this.step("down.old-token-after-unlock", "token A cũ vẫn 401 SESSION_REVOKED sau mở khóa", async () => {
        const r = await this.api("GET", "/v1/accounts", { token: S.oldTokenA });
        rep.oldTokenAfterUnlock = this.brief(r);
        this.assertRevoked(r, "token A cũ sau mở khóa");
        return `${r.status} ${r.errorCode}`;
      });
    }
    await this.step("down.marker-after-unlock", "mốc SQL không đổi khi mở khóa", async () => {
      rep.markerBeforeLock = d0.raw;
      if (S.markers.flush !== undefined && d0.raw !== S.markers.flush) throw new AssertionFail("sessions_revoked_at đổi sau khi mở khóa");
      return d0.raw;
    });
    const tokA = await this.token("a");
    await this.step("down.fresh-token-before-lock", "token A mới: GET /v1/accounts 200", async () => {
      const r = await this.api("GET", "/v1/accounts", { token: tokA.token });
      rep.freshTokenBeforeLock = this.brief(r);
      if (d0.floorSec !== null) rep.freshTokenIatMinusFloor = tokA.iat - d0.floorSec; // >= 1: token Cognito sau mốc cũ được chấp nhận
      this.expect(r, 200, "token A mới sau mở khóa");
      return "200";
    });
    await this.step("down.lock", "operator khóa lần hai", async () => {
      const r = await this.lockTarget((await this.token("operator")).token, "khóa lần hai");
      return `${r.status} LOCKED`;
    });
    const d1 = await this.marker("down");
    await this.step("down.marker-after-lock", "mốc SQL mới sau khóa lần hai", async () => {
      if (d1.raw === "NULL" || d1.raw === d0.raw) throw new AssertionFail("sessions_revoked_at không đổi sau lần khóa thứ hai");
      rep.markerAfterLock = d1.raw;
      return d1.raw;
    });
    const tokB = await this.token("b");
    await this.step("down.fault", "--down-cmd rồi /health/ready phải báo redis degraded", async () => {
      rep.redisDegradedAfterMs = await this.faultDown("down");
      return `redis degraded sau ${rep.redisDegradedAfterMs} ms`;
    });
    // Không có request nào của A giữa fault và phép kiểm này.
    await this.step("down.next-request", "A: request kế tiếp phải 401 SESSION_REVOKED (SQL fallback)", async () => {
      await this.requireDegraded("down.next-request");
      const r = await this.api("GET", "/v1/accounts", { token: tokA.token });
      rep.nextRequest = this.brief(r);
      this.assertRevoked(r, "request kế tiếp của A khi Redis chết");
      return `${r.status} ${r.errorCode} ${r.ms} ms`;
    });
    await this.step("down.bystander", "B vẫn 200 khi Redis chết (API còn sống)", async () => {
      const r = await this.api("GET", "/v1/accounts", { token: tokB.token });
      rep.bystander = this.brief(r);
      this.expect(r, 200, "B khi Redis chết");
      return "200";
    });
    await this.step("down.marker-after-fault", "mốc SQL còn nguyên khi Redis chết", async () => {
      const d2 = await this.marker("down");
      rep.markerAfterFault = d2.raw;
      if (d2.raw !== d1.raw) throw new AssertionFail("sessions_revoked_at đổi khi Redis chết");
      return "nguyên văn";
    });
    await this.step("down.recover", "--up-cmd rồi /health/ready báo redis up (hai lần liên tiếp)", async () => {
      Object.assign(rep, await this.recoverUp("down"));
      return `${rep.recoveryMs} ms`;
    });
    await this.step("down.after-up", "A vẫn 401 SESSION_REVOKED, B 200, mốc nguyên", async () => {
      const r = await this.api("GET", "/v1/accounts", { token: tokA.token });
      rep.afterUp = this.brief(r);
      this.assertRevoked(r, "A sau khi Redis lên lại");
      const b = await this.api("GET", "/v1/accounts", { token: (await this.token("b")).token });
      this.expect(b, 200, "B sau khi Redis lên lại");
      const d3 = await this.marker("down");
      rep.markerUnchanged = d3.raw === d1.raw;
      if (!rep.markerUnchanged) throw new AssertionFail("sessions_revoked_at đổi sau khi Redis lên lại");
      return "401, 200, mốc nguyên";
    });
    await this.step("down.invariants", "bất biến DBS-69", () => this.invariants("down"));
  }

  // BL-222. Cognito không cho điều khiển iat: đăng nhập rồi khóa NGAY, để một phần các lần thử rơi cùng giây với mốc.
  // Ngay sau khóa, chờ tới ranh giới giây kế tiếp rồi đăng nhập lần nữa (token "+1"): lấy TRƯỚC khi đọc mốc (lần đọc mốc
  // qua task ECS mất ≈ 60 giây), nên iat - floor(mốc) có thể đúng bằng 1, đúng biên iat = R+1 của docs/03 §6.2.
  // Phán quyết tính SAU, từ iat và mốc SQL, cho từng token: iat <= floor(mốc) => 401, iat > floor(mốc) => 200 trên tài
  // khoản đồng hành ACTIVE. Đường đi (cache hit, miss, SQL fallback) là suy ra từ trạng thái Redis, không quan sát trực tiếp;
  // riêng chế độ down kiểm /health/ready báo redis degraded ngay trước mỗi request quyết định.
  async scenarioBoundary() {
    const S = this.state;
    const out = (this.report.bl222 = { status: "RUNNING", path: "suy ra từ hook, không quan sát trực tiếp" });
    let anyViolation = false;
    for (const mode of this.cfg.boundaryModes) {
      const N = mode === "down" ? this.cfg.sameSecondDownAttempts : this.cfg.sameSecondAttempts;
      const res = (out[mode] = { status: "RUNNING", attempts: 0, sameSecond: 0, plusOne: 0, laterSecond: 0, earlierSecond: 0, violations: 0, samples: [] });
      for (let i = 1; i <= N; i++) {
        await this.step(`bl222.${mode}.${i}`, `lần thử ${i}/${N}: đăng nhập rồi khóa ngay; token +1; request sau fault`, async () => {
          if (S.targetLocked) {
            await this.unlock(S.target, (await this.token("operator")).token, "mở khóa tài khoản đích trước lần thử");
            S.targetLocked = false;
          }
          const op = await this.token("operator"); // lấy TRƯỚC khi đăng nhập khách: lệnh này mất vài giây
          const tLogin = Date.now();
          const tok = await this.token("a");
          await this.lockTarget(op.token, "khóa tài khoản đích (BL-222)");
          const loginToLockMs = Date.now() - tLogin;
          await sleep(1000 - (Date.now() % 1000) + 120); // tới ranh giới giây kế tiếp
          const tokPlus = await this.token("a");
          if (mode === "flush") await this.flushHook(`boundary-${mode}`, { needBefore: true });
          if (mode === "down") await this.faultDown(`boundary-${mode}`);
          if (mode === "down") await this.requireDegraded("BL-222 down");
          const r = await this.api("GET", `/v1/accounts/${S.companion}`, { token: tok.token });
          if (mode === "flush") await this.flushHook(`boundary-${mode}-probe`, { needBefore: false }); // ép miss lần nữa: đường SQL
          if (mode === "down") await this.requireDegraded("BL-222 down (token +1)");
          const rPlus = await this.api("GET", `/v1/accounts/${S.companion}`, { token: tokPlus.token });
          const recovery = mode === "down" ? await this.recoverUp(`boundary-${mode}`) : null;
          const m = await this.marker(`boundary-${mode}`);
          if (m.floorSec === null) throw new AssertionFail("sessions_revoked_at NULL sau khi khóa");
          res.attempts++;
          const samples = [];
          for (const [kind, t, resp] of [["login", tok, r], ["plus", tokPlus, rPlus]]) {
            const diff = t.iat - m.floorSec;
            const relation = diff === 0 ? "same" : diff > 0 ? "later" : "earlier";
            res[relation === "same" ? "sameSecond" : relation === "later" ? "laterSecond" : "earlierSecond"]++;
            if (diff === 1) res.plusOne++;
            const expected = diff <= 0 ? 401 : 200;
            let ok = resp.status === expected;
            if (ok && expected === 401) ok = resp.errorCode === "SESSION_REVOKED" && Boolean(resp.bodyCorrelationId);
            if (ok && expected === 200) ok = resp.json?.id === S.companion && resp.json?.status === "ACTIVE";
            const sample = { i, kind, relation, iatMinusFloor: diff, loginToLockMs, status: resp.status, errorCode: resp.errorCode, ok };
            samples.push(sample);
            res.samples.push(sample);
            if (!ok) {
              res.violations++;
              anyViolation = true;
              res.status = "VIOLATION";
              throw new AssertionFail(`quy tắc iat <= floor(mốc) sai (${kind}): iat - floor(mốc) = ${diff}, mong đợi ${expected}, nhận ${resp.status}${resp.errorCode ? ` ${resp.errorCode}` : ""}`);
            }
          }
          if (recovery) Object.assign(samples[0], recovery);
          return `đăng nhập: ${samples[0].iatMinusFloor} -> ${r.status}; +1: ${samples[1].iatMinusFloor} -> ${rPlus.status} (đăng nhập đến khóa ${loginToLockMs} ms)`;
        });
      }
      res.status = res.sameSecond > 0 && res.plusOne > 0 ? "CAUGHT" : res.sameSecond > 0 ? "SAME_SECOND_ONLY" : res.plusOne > 0 ? "PLUS_ONE_ONLY" : "NOT_CAUGHT";
      this.log(
        res.status === "CAUGHT"
          ? `BL-222 ${mode}: bắt được ${res.sameSecond} mẫu cùng giây và ${res.plusOne} mẫu đúng +1 giây trong ${res.attempts} lần thử, quy tắc đúng`
          : `BL-222 ${mode}: ${res.status} (cùng giây ${res.sameSecond}, đúng +1 ${res.plusOne}, ${res.attempts} lần thử; Cognito không cho điều khiển iat): không bắt được đủ ca cùng giây và +1; giữ BL-222`,
      );
    }
    out.status = anyViolation ? "VIOLATION" : this.cfg.boundaryModes.every((m) => out[m].status === "CAUGHT") ? "CAUGHT" : "NOT_CAUGHT";
    await this.step("bl222.invariants", "bất biến DBS-69", () => this.invariants("boundary"));
  }

  async cleanup() {
    const S = this.state;
    if (!S.downIssued || S.upConfirmed) return;
    this.cleaning = true;
    this.log("dọn: đã gọi down mà chưa xác nhận phục hồi, chạy --up-cmd");
    try {
      await this.hook("up", this.cfg.cmd.up, "cleanup", { force: true });
      this.report.cleanup.up = "OK";
      try {
        await this.waitRedis("up", this.cfg.recoveryTimeoutMs, "sau up (dọn)", 2);
        await sleep(Math.min(this.cfg.settleMs, 5000)); // một hook down sống sót (container docker) có thể muộn: kiểm lại sau một lúc
        this.report.cleanup.redisUp = (await this.readiness()).redis === "up";
        if (!this.report.cleanup.redisUp) this.log("CẢNH BÁO: Redis lại không up sau khi dọn: kiểm tra hook down còn sống (container) và chạy lại --up-cmd");
      } catch (e) {
        this.report.cleanup.redisUp = false;
        this.log(`CẢNH BÁO: ${e && e.message}`);
      }
    } catch (e) {
      this.report.cleanup.up = "FAIL";
      this.report.cleanup.redisUp = false;
      this.log(`CẢNH BÁO: --up-cmd lỗi trong lúc dọn, khôi phục Redis bằng tay: ${e && e.message}`);
    }
  }

  finalize(verdict, code) {
    this.report.verdict = verdict;
    this.report.exitCode = code;
    this.report.finishedAt = new Date().toISOString();
    this.save();
    this.log(`VERDICT: ${verdict} (exit ${code})${this.report.failedStep ? `, bước lỗi: ${this.report.failedStep}` : ""}; báo cáo: ${this.reportFile}`);
  }

  // SIGINT/SIGTERM: giết hook đang chạy (cả cây), chạy --up-cmd nếu cần, ghi báo cáo.
  async abort(signal) {
    if (this.aborting) return;
    this.aborting = true;
    this.log(`Nhận ${signal}: dừng drill và dọn dẹp`);
    this.currentKill?.();
    this.report.failure = `bị ngắt bởi ${signal}`;
    if (!this.report.failedStep) this.report.failedStep = "(bị ngắt)";
    await this.cleanup();
    this.finalize("ERROR", EXIT.ENV);
  }

  async run() {
    let verdict = "PASS";
    let code = EXIT.PASS;
    try {
      await this.prepare();
      if (this.cfg.scenarios.includes("flush")) await this.scenarioFlush();
      if (this.cfg.scenarios.includes("down")) await this.scenarioDown();
      if (this.cfg.boundaryModes.length) await this.scenarioBoundary();
    } catch (e) {
      if (this.aborting) return EXIT.ENV;
      if (e instanceof InvariantFail) [verdict, code] = ["INVARIANTS_FAIL", EXIT.INVARIANTS];
      else if (e instanceof AssertionFail) [verdict, code] = ["FAIL", EXIT.FAIL];
      else [verdict, code] = ["ERROR", EXIT.ENV];
      if (!this.report.failure) this.report.failure = String(e && e.message);
      if (!this.report.failedStep) this.report.failedStep = "(ngoài bước)";
    }
    if (this.aborting) return EXIT.ENV;
    await this.cleanup();
    this.finalize(verdict, code);
    return code;
  }
}

export async function main(argv, env = process.env) {
  let cfg;
  try {
    cfg = parseConfig(argv, env);
  } catch (e) {
    if (e instanceof UsageError) {
      if (e.message !== "help") process.stderr.write(`${redact(e.message)}\n`);
      process.stderr.write(`${USAGE}\n`);
      return e.message === "help" ? 0 : EXIT.USAGE;
    }
    throw e;
  }
  for (const who of ["a", "b"]) registerSecret(cfg.password[who]);
  for (const [k, v] of Object.entries(env)) if (/PASSWORD|SECRET|TOKEN|AUTH/i.test(k) && typeof v === "string" && v.length >= 8 && !k.startsWith("DRILL_")) registerSecret(v);
  const drill = new Drill(cfg);
  for (const sig of ["SIGINT", "SIGTERM"])
    process.on(sig, () => {
      if (drill.aborting) return drill.log(`Nhận lại ${sig} khi đang dọn: bỏ qua, đợi --up-cmd xong`);
      drill.abort(sig).then(() => process.exit(EXIT.ENV));
    });
  return drill.run();
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (e) => {
      process.stderr.write(`${redact(String((e && e.stack) || e))}\n`);
      process.exitCode = EXIT.ENV;
    },
  );
}
