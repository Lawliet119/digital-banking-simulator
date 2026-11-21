// DBS-186 (phần cloud): máy chủ giả và hook giả dùng chung cho drill-revocation-cloud.test.mjs.
// FakeBackend mô phỏng đúng luật guard của API (iat <= floor(mốc) => 401 SESSION_REVOKED, Redis có thể flush/down, SQL là
// nguồn sự thật, /health/ready báo redis up|degraded) và một cổng điều khiển /__ctl/* cho hook giả. Không phải test (CI
// không chạy tệp này); người điều phối có thể dùng nó để chạy thử driver khô trước khi cắm hook thật.
import http from "node:http";
import https from "node:https";
import { randomUUID } from "node:crypto";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64url");
const SIGNATURE = "c2lnbmF0dXJlLXNpZ25hdHVyZS1zaWduYXR1cmU";
const PW = { a: "PwA-Sup3r-Secret-Zz9!", b: "PwB-Sup3r-Secret-Zz9!" };
const SECRET_STRINGS = [PW.a, PW.b, "s3cr3tTokenValue", "123456789012", "amazonaws.com", "Sup3rSecretPassw0rd"];
const ENV_SECRET = "zzEnvSecretValue-12345";

function makeJwt({ sub, iat, group, exp }) {
  const payload = { sub, iat, exp: exp ?? iat + 900, "cognito:groups": [group], token_use: "access" };
  return `${b64({ alg: "none", typ: "JWT" })}.${b64(payload)}.${SIGNATURE}`;
}
const pgText = (ms) => new Date(ms).toISOString().replace("T", " ").replace("Z", "000+00");

class FakeBackend {
  constructor(cfg = {}, tls = null) {
    this.cfg = {
      frozenMs: null, // đồng hồ đóng băng (kiểm ca cùng giây)
      advanceAfterLockMs: 0, // chỉ khi đóng băng: sau mỗi lần khóa đồng hồ tiến thêm (thời gian trôi sau khóa)
      markerOffsetMs: 0, // lệch của mốc thu hồi so với đồng hồ khi khóa
      tokenTtlSec: 900,
      bug: null, // 'no-sql-fallback' | 'same-second-allows' | 'plus-one' (từ chối cả iat = R+1)
      errorMode: null, // 'wrong-code' | 'no-correlation' | 'mismatch' | 'token-expired'
      echoAuth: false,
      invariantsExit: 0,
      markerAfterFault: null, // 'drift' | 'lost'
      readyFailuresAfterUp: 0, // /health/ready 503 vài lần sau up
      degradedAfterUp: 0, // /health/ready 200 nhưng redis còn degraded vài lần sau up
      flushNoop: false, // hook flush không xóa gì
      downNoop: false, // hook down không làm Redis chết
      selfHealAfterReadyCalls: null, // Redis tự lành sau N lần /health/ready báo degraded
      rateLimitAfterFault: false, // sau fault, mọi request của A bị 429 (giới hạn tốc độ IP)
      cognitoChallenge: false,
      ...cfg,
    };
    this.tls = tls;
    this.users = new Map();
    this.accounts = new Map();
    this.seq = 0;
    this.logins = new Map([
      ["a@dbs.invalid", { pw: PW.a, sub: "sub-a", group: "customer" }],
      ["b@dbs.invalid", { pw: PW.b, sub: "sub-b", group: "customer" }],
    ]);
    this.redis = { up: true, keys: new Map() };
    this.log = [];
    this.requests = 0;
    this.issued = [];
    this.readyFailures = 0;
    this.degradedLeft = 0;
    this.faulted = false;
  }

  now() {
    return this.cfg.frozenMs ?? Date.now();
  }
  who(sub) {
    return { "sub-a": "A", "sub-b": "B", "sub-op": "OP" }[sub] ?? sub;
  }
  issue(sub, group) {
    const iat = Math.floor(this.now() / 1000);
    const t = makeJwt({ sub, iat, group, exp: iat + this.cfg.tokenTtlSec });
    this.issued.push(t);
    return t;
  }
  user(sub) {
    if (!this.users.has(sub)) this.users.set(sub, { marker: null, customer: false });
    return this.users.get(sub);
  }
  seedAccounts(sub, statuses) {
    this.user(sub).customer = true;
    return statuses.map((status) => {
      const id = randomUUID();
      this.accounts.set(id, { id, sub, type: "CHECKING", status, createdAt: new Date(1_700_000_000_000 + ++this.seq * 1000).toISOString() });
      return id;
    });
  }
  accountsOf(sub) {
    return [...this.accounts.values()].filter((a) => a.sub === sub);
  }
  setMarker(sub, ms) {
    this.user(sub).marker = ms;
    if (this.redis.up) this.redis.keys.set(sub, ms);
  }

  async listen() {
    const handler = (req, res) => {
      const chunks = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        try {
          this.handle(req, res, Buffer.concat(chunks).toString("utf8"));
        } catch (e) {
          res.writeHead(500, { "content-type": "text/plain" });
          res.end(String(e && e.stack));
        }
      });
    };
    this.server = this.tls ? https.createServer(this.tls, handler) : http.createServer(handler);
    await new Promise((r) => this.server.listen(0, "127.0.0.1", r));
    this.url = `${this.tls ? "https" : "http"}://127.0.0.1:${this.server.address().port}`;
    this.ctlUrl = this.url;
    if (this.tls) {
      // hook gọi cổng điều khiển bằng http thường (fetch của Node không bỏ qua chứng chỉ tự ký)
      this.ctlServer = http.createServer(handler);
      await new Promise((r) => this.ctlServer.listen(0, "127.0.0.1", r));
      this.ctlUrl = `http://127.0.0.1:${this.ctlServer.address().port}`;
    }
  }
  async close() {
    for (const srv of [this.server, this.ctlServer]) {
      if (!srv) continue;
      srv.closeAllConnections?.();
      await new Promise((r) => srv.close(r));
    }
  }

  send(res, status, body, headers = {}) {
    const isText = typeof body === "string";
    res.writeHead(status, { "content-type": isText ? "text/plain" : "application/json", ...headers });
    res.end(isText ? body : JSON.stringify(body));
  }
  problem(res, req, status, errorCode, extraHeaders = {}) {
    const cid = randomUUID();
    const body = { type: "about:blank", title: "Unauthorized", status, errorCode, detail: "rejected", correlationId: cid };
    const headers = { "x-correlation-id": cid, ...extraHeaders };
    if (this.cfg.errorMode === "wrong-code" && errorCode === "SESSION_REVOKED") body.errorCode = "UNAUTHENTICATED";
    if (this.cfg.errorMode === "no-correlation" && errorCode === "SESSION_REVOKED") delete body.correlationId;
    if (this.cfg.errorMode === "mismatch" && errorCode === "SESSION_REVOKED") body.correlationId = randomUUID();
    if (this.cfg.echoAuth) {
      body.detail = `echo ${req.headers.authorization ?? ""}`;
      headers["x-debug-auth"] = req.headers.authorization ?? "";
    }
    this.send(res, status, body, headers);
  }

  readyBody() {
    if (this.readyFailures > 0) {
      this.readyFailures--;
      return [503, { status: "error" }];
    }
    if (!this.redis.up && this.cfg.selfHealAfterReadyCalls !== null) {
      this.downReadyCalls = (this.downReadyCalls ?? 0) + 1;
      if (this.downReadyCalls > this.cfg.selfHealAfterReadyCalls) {
        this.redis.up = true;
        this.redis.keys.clear();
      }
    }
    let redis = this.redis.up ? "up" : "degraded";
    if (this.degradedLeft > 0) {
      this.degradedLeft--;
      redis = "degraded";
    }
    return [200, { status: "ok", redis }];
  }

  handle(req, res, raw) {
    const url = new URL(req.url, this.url);
    if (url.pathname.startsWith("/__ctl/")) return this.control(url, res);
    if (url.pathname === "/health/ready") {
      const [status, body] = this.readyBody();
      return this.send(res, status, body);
    }
    this.requests++;
    if (url.pathname === "/cognito") return this.cognito(res, raw);
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? "");
    if (!m) return this.problem(res, req, 401, "UNAUTHENTICATED");
    const parts = m[1].split(".");
    let claims;
    try {
      claims = JSON.parse(Buffer.from(parts[1], "base64url").toString());
    } catch {
      return this.problem(res, req, 401, "UNAUTHENTICATED");
    }
    const sub = claims.sub;
    const who = this.who(sub);
    if (this.cfg.rateLimitAfterFault && this.faulted && who === "A") {
      this.log.push({ kind: "req", who, method: req.method, path: url.pathname, status: 429 });
      return this.send(res, 429, { errorCode: "RATE_LIMITED" }, { "retry-after": "30" });
    }
    const finish = (status, body, errorCode) => {
      this.log.push({ kind: "req", who, method: req.method, path: url.pathname, status });
      if (errorCode) return this.problem(res, req, status, errorCode);
      return this.send(res, status, body, this.cfg.echoAuth ? { "x-debug-auth": req.headers.authorization } : {});
    };
    if (this.cfg.errorMode === "token-expired" && who === "A" && url.pathname === "/v1/accounts" && req.method === "GET")
      return finish(401, null, "TOKEN_EXPIRED");
    if (claims.exp * 1000 < this.now()) return finish(401, null, "TOKEN_EXPIRED");
    const u = this.user(sub);
    // Guard: Redis (nếu sống và có khóa) rồi SQL. Cờ `bug` mô phỏng lỗi của sản phẩm để làm negative control.
    const cached = this.redis.up && this.redis.keys.has(sub) ? this.redis.keys.get(sub) : null;
    const floorSec = (ms) => Math.floor(ms / 1000);
    const strict = this.cfg.bug === "same-second-allows";
    const plusOne = this.cfg.bug === "plus-one";
    const revoked = (ms) => (strict ? claims.iat < floorSec(ms) : plusOne ? claims.iat <= floorSec(ms) + 1 : claims.iat <= floorSec(ms));
    if (cached !== null && revoked(cached)) return finish(401, null, "SESSION_REVOKED");
    const cacheMiss = !(this.redis.up && this.redis.keys.has(sub));
    if (!(this.cfg.bug === "no-sql-fallback" && cacheMiss)) {
      if (u.marker !== null && revoked(u.marker)) {
        if (this.redis.up) this.redis.keys.set(sub, u.marker);
        return finish(401, null, "SESSION_REVOKED");
      }
    }
    return this.route(url, req, raw, claims, sub, u, finish);
  }

  route(url, req, raw, claims, sub, u, finish) {
    const groups = claims["cognito:groups"] ?? [];
    const body = raw ? JSON.parse(raw) : {};
    const p = url.pathname;
    let mm;
    if ((mm = /^\/v1\/operator\/accounts\/([^/]+)\/(lock|unlock)$/.exec(p)) && req.method === "POST") {
      if (!groups.includes("operator")) return finish(403, { errorCode: "FORBIDDEN" });
      const reasons = mm[2] === "lock" ? ["CONFIRMED_FRAUD", "OPERATOR_LOCK"] : ["OPERATOR_UNLOCK", "CUSTOMER_REQUEST"];
      if (!reasons.includes(body.reason)) return finish(400, { errorCode: "VALIDATION_FAILED" });
      const a = this.accounts.get(mm[1]);
      if (!a) return finish(404, { errorCode: "NOT_FOUND" });
      const target = mm[2] === "lock" ? "LOCKED" : "ACTIVE";
      if (mm[2] === "lock" && a.status === "ACTIVE") this.setMarker(a.sub, this.now() + this.cfg.markerOffsetMs);
      a.status = target;
      if (mm[2] === "lock" && this.cfg.frozenMs !== null) this.cfg.frozenMs += this.cfg.advanceAfterLockMs;
      return finish(200, { id: a.id, type: a.type, status: a.status, updatedAt: new Date(this.now()).toISOString() });
    }
    if (!groups.includes("customer")) return finish(403, { errorCode: "FORBIDDEN" });
    if (p === "/v1/customers/me" && req.method === "POST") {
      u.customer = true;
      return finish(200, { id: randomUUID(), fullName: body.fullName, createdAt: new Date().toISOString() });
    }
    if (p === "/v1/accounts" && req.method === "GET")
      return finish(200, this.accountsOf(sub).map((a) => ({ id: a.id, type: a.type, status: a.status, balance: "0", createdAt: a.createdAt })));
    if (p === "/v1/accounts" && req.method === "POST") {
      if (!u.customer) return finish(404, { errorCode: "NOT_FOUND" });
      if (this.accountsOf(sub).length >= 3) return finish(409, { errorCode: "ACCOUNT_LIMIT_REACHED" });
      const [id] = this.seedAccounts(sub, ["ACTIVE"]);
      return finish(201, { id, type: "CHECKING", status: "ACTIVE" });
    }
    if ((mm = /^\/v1\/accounts\/([^/]+)$/.exec(p)) && req.method === "GET") {
      const a = this.accounts.get(mm[1]);
      if (!a || a.sub !== sub) return finish(404, { errorCode: "NOT_FOUND" });
      return finish(200, { id: a.id, type: a.type, status: a.status, balance: "0" });
    }
    return finish(404, { errorCode: "NOT_FOUND" });
  }

  cognito(res, raw) {
    const p = JSON.parse(raw).AuthParameters ?? {};
    const user = this.logins.get(p.USERNAME);
    this.log.push({ kind: "cognito", who: user ? this.who(user.sub) : "?", status: user && user.pw === p.PASSWORD ? 200 : 400 });
    if (this.cfg.cognitoChallenge) return this.send(res, 200, { ChallengeName: "NEW_PASSWORD_REQUIRED", Session: "x" });
    if (!user || user.pw !== p.PASSWORD) return this.send(res, 400, { __type: "NotAuthorizedException" });
    return this.send(res, 200, { AuthenticationResult: { AccessToken: this.issue(user.sub, user.group), ExpiresIn: 900 } });
  }

  control(url, res) {
    const name = url.pathname.replace("/__ctl/", "");
    const q = Object.fromEntries(url.searchParams);
    this.log.push({ kind: "hook", name, phase: q.phase, account: q.account, run: q.run });
    if (name === "flush") {
      const before = this.redis.keys.size;
      if (!this.cfg.flushNoop) this.redis.keys.clear();
      this.faulted = true;
      return this.send(res, 200, { before, after: this.redis.keys.size });
    }
    if (name === "down") {
      if (!this.cfg.downNoop) {
        this.redis.up = false;
        this.redis.keys.clear();
      }
      this.faulted = true;
      return this.send(res, 200, "ok");
    }
    if (name === "up") {
      this.redis.up = true;
      this.redis.keys.clear();
      this.readyFailures = this.cfg.readyFailuresAfterUp;
      this.degradedLeft = this.cfg.degradedAfterUp;
      return this.send(res, 200, "ok");
    }
    if (name === "marker") {
      const a = this.accounts.get(q.account);
      const m = a ? this.user(a.sub).marker : null;
      if (m === null || m === undefined) return this.send(res, 200, "NULL");
      if (this.faulted && this.cfg.markerAfterFault === "lost") return this.send(res, 200, "NULL");
      if (this.faulted && this.cfg.markerAfterFault === "drift") return this.send(res, 200, pgText(m + 1));
      return this.send(res, 200, pgText(m));
    }
    if (name === "invariants") return this.send(res, 200, { exit: this.cfg.invariantsExit });
    if (name === "env") {
      this.log.push({ kind: "env", names: (q.names ?? "").split(","), leaked: (q.leaked ?? "").split(",").filter(Boolean), phase: q.phase });
      return this.send(res, 200, "ok");
    }
    if (name === "token") {
      const role = q.role;
      const t = role === "operator" ? this.issue("sub-op", "operator") : this.issue(role === "a" ? "sub-a" : "sub-b", "customer");
      return this.send(res, 200, t);
    }
    return this.send(res, 404, "unknown");
  }

  events(kind) {
    return this.log.filter((e) => e.kind === kind);
  }
}

const HOOK_SOURCE = `
const [action, arg] = process.argv.slice(2);
const ctl = process.env.FAKE_CTL;
const q = '?phase=' + encodeURIComponent(process.env.DRILL_PHASE || '') + '&account=' + encodeURIComponent(process.env.DRILL_ACCOUNT_ID || '') + '&run=' + encodeURIComponent(process.env.DRILL_RUN_ID || '');
const call = async (p, extra = '') => { const r = await fetch(ctl + '/__ctl/' + p + q + extra); return r.text(); };
const LEAK = ['eyJhbGciOiJub25lIn0.eyJzdWIiOiJsZWFrIn0.c2ln', 'Bearer eyJhbGciOiJub25lIn0.eyJzdWIiOiJsZWFrIn0.c2ln', 'password=Sup3rSecretPassw0rd',
  'rediss://default:s3cr3tTokenValue@master.x.cache.amazonaws.com:6379', 'arn:aws:iam::123456789012:role/dbs', 'account 123456789012', 'dbs-123.ap-southeast-1.elb.amazonaws.com'];
const flush = async () => { const j = JSON.parse(await call('flush')); console.log('DRILL_REVOKED_KEYS_BEFORE=' + j.before); console.log('DRILL_REVOKED_KEYS_AFTER=' + j.after); };
switch (action) {
  case 'flush': await flush(); break;
  case 'flush-noevidence': await call('flush'); console.log('FLUSHALL ok'); break;
  case 'down': case 'up': await call(action); console.log(action.toUpperCase() + ' ok'); break;
  case 'late-down': await new Promise((r) => setTimeout(r, Number(arg))); await call('down'); break;
  case 'marker': console.log((await call('marker')).trim()); break;
  case 'marker-garbage': console.log('not-a-timestamp'); break;
  case 'invariants': process.exit(JSON.parse(await call('invariants')).exit); break;
  case 'token': console.log((await call('token', '&role=' + arg)).trim()); break;
  case 'leak': { for (const l of LEAK) { console.log(l); console.error(l); } await flush(); process.exit(Number(arg || 0)); break; }
  case 'dump-env': {
    const leaked = Object.entries(process.env).filter(([k, v]) => k.startsWith('DRILL_USER_') || /PwA-|PwB-|zzEnvSecretValue/.test(v)).map(([k]) => k);
    await call('env', '&names=' + Object.keys(process.env).join(',') + '&leaked=' + leaked.join(','));
    break;
  }
  case 'sleep': await new Promise((r) => setTimeout(r, Number(arg))); break;
  case 'exit': process.exit(Number(arg)); break;
  default: console.error('unknown action', action); process.exit(99);
}
`;

export { FakeBackend, HOOK_SOURCE, PW, SECRET_STRINGS, ENV_SECRET, makeJwt };
