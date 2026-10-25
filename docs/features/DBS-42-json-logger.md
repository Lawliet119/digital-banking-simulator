# DBS-42 · Logger JSON bằng nestjs-pino với trường chuẩn

> **Status:** Plan approved (G3 của lần rà soát và sửa đã duyệt 2026-10-25; đang ở Phase 4) · **Vai:** Dev · **Review:** Dev khác, chưa xác nhận người review · **Nhánh:** `feat/DBS-42-json-logger` · **PR:** #16 (đã mở, tác giả minhduc47) · **Cập nhật:** 2026-10-25

## 1. Bối cảnh

### Nguồn task và DoD

- **Nguồn chính:** đã đọc và chạy `node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs DBS-42`; lấy được task từ sheet ngày 2026-10-24. Mô tả người dùng khớp dữ liệu lấy được; không cần dùng nguồn dự phòng.
- **Task trên board:** loại Task; Tuần 1; vai Dev; ưu tiên High; Status **In Progress**; Deliverable/Demo **P4**. Vai Dev khớp loại việc nền tảng backend. Agent không đổi board; người dùng giữ task ở In Progress trong quá trình thực hiện.
- **Expect (nguyên văn):** Mọi dòng log là một object JSON máy đọc được.
- **Thực trạng (nguyên văn):** Log hiện là text của NestJS Logger; package.json chưa có thư viện logger JSON. correlation-id.middleware.ts đã sinh correlationId cho mỗi request nhưng log chưa mang theo.
- **DoD (nguyên văn, đánh số để truy vết):**
  1. Logger JSON mỗi dòng có level, time (ISO UTC), message, role (api|worker), correlationId
  2. Redact Authorization, token, mật khẩu; không log body có số tài khoản đầy đủ
  3. Log level theo env (log-levels.ts hiện có); test cấu hình
  4. backend/README ghi quy ước log (trường chuẩn, điều không được log)
  5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc của DBS-42:** sheet ghi `— (làm được ngay)`. Không có dependency cần stub.
- **Task liên quan:** đã chạy fetch-task cho **DBS-43**: Dev, High, In Progress, phụ thuộc DBS-42. Expect của DBS-43 là lấy correlationId ở mọi tầng mà không phải truyền tay; DoD gồm provider/hàm ALS chung, context worker/consumer từ message và test request song song không lẫn ID. Không coi DBS-43 đã triển khai hoặc đã phối hợp chỉ vì board ghi In Progress.
- **Quy trình:** [skill](../../.claude/skills/dbs-delivering-task/SKILL.md), [team](../../.claude/skills/dbs-delivering-task/references/team.md), [task-kinds](../../.claude/skills/dbs-delivering-task/references/task-kinds.md), [module-notes](../../.claude/skills/dbs-delivering-task/references/module-notes.md), [testing](../../.claude/skills/dbs-delivering-task/references/testing.md), [manual-testing](../../.claude/skills/dbs-delivering-task/references/manual-testing.md), [docs-style](../../.claude/skills/dbs-delivering-task/references/docs-style.md) và [CONTRIBUTING](../../CONTRIBUTING.md). Không tìm thấy AGENTS.md trong repo hoặc các thư mục cha đã kiểm tra. `docs/plan/TEAM_ROLES_PLAYBOOK.md` của phiên làm việc trước không còn trên main hiện tại; dùng quy ước Dev trong team reference và CONTRIBUTING hiện có.

### Repo, tài liệu và thực trạng đã kiểm tra

- **Git:** bắt đầu trên main, working tree sạch; đã `git fetch origin`, main và origin/main cùng `3b81c55`, số commit lệch `0 0`. Đã tạo nhánh task từ main này. Chưa commit, push hay gọi gh/GitHub API; chưa kiểm danh sách PR đang mở.
- **Tài liệu:** [docs/README](../README.md), [docs/02](../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) NFR-OBS-01, NFR-SEC-04; [docs/03](../03_HIGH_LEVEL_ARCHITECTURE.md) §7 (lỗi), §12 (bảo mật), §14 (log/quan sát), §19 (công cụ); [observability concept](../components/observability/01-concept-brief.md); [threat-model T15](../security/threat-model.md); [ADR-01](../adr/0001-modular-monolith-worker.md) và [ADR-13](../adr/0013-one-app-app-role.md). Log vận hành không thay thế audit log trong transaction.
- **Task trước:** [DBS-22](DBS-22-common-money-type-dto-validator.md) đặt bootstrap JSON bigint ở mọi role; [DBS-39](DBS-39-testcontainers-postgres.md) có harness DB; [DBS-35](DBS-35-ci-github-actions.md) quy định sáu check CI. Không thay đổi các hành vi đó trong DBS-42.
- **Code hiện có:** [main.ts](../../backend/src/main.ts) dùng `logLevels(...)` cho Nest Logger và ba chỗ `console.log`; [AppModule](../../backend/src/app.module.ts) chưa có logger JSON; [app.setup.ts](../../backend/src/app.setup.ts) gắn correlation middleware; [middleware](../../backend/src/common/middleware/correlation-id.middleware.ts) sinh UUID mới bằng randomUUID, không lấy X-Correlation-Id từ client. X-Request-Id của client được kiểm UUID và echo riêng.
- [log-levels.ts](../../backend/src/common/utils/log-levels.ts) có thứ tự `fatal > error > warn > log > debug > verbose`, mặc định/fallback `log`, đã có ba test. [app.config.ts](../../backend/src/config/app.config.ts) có logLevel; [schema](../../backend/src/config/validation.schema.ts) chấp nhận sáu mức đó; [env example](../../backend/env/.env.example) đặt LOG_LEVEL=debug cho local. Đề xuất giữ biến và các giá trị hiện có, không thêm env var.
- [ProblemDetailsFilter](../../backend/src/common/filters/problem-details.filter.ts) và [TransactionService](../../backend/src/database/transaction.service.ts) dùng Nest Logger; filter hiện nối raw request.url và error message/stack vào chuỗi. Đã gọi filter thật bằng driver với fixture HTTP host và token/password giả: giá trị giả xuất hiện trong log warn. Đây là tái hiện ở cấp filter, không phải request lỗi đi qua ứng dụng thật; [output đã che giá trị giả](screenshots/DBS-42/security-before.txt). Vì vậy chỉ cấu hình redact theo key sẽ chưa đủ cho các chuỗi log hiện có; đưa việc làm sạch các điểm log này vào phạm vi thiết kế.
- **Đã chạy ứng dụng nguồn thật:** hai tiến trình riêng APP_ROLE=api và worker bằng ts-node; env lấy từ tệp example, API dùng port 33042; API live/ready đều 200 với PostgreSQL thật. Hai request gửi cùng client ID nhận hai server correlationId khác nhau, khác client ID. API có 16 dòng startup, worker có 9 dòng, **0 dòng JSON object** ở mỗi role. [Output trước thay đổi](screenshots/DBS-42/runtime-before.txt); đây là quan sát Phase 1, chưa phải manual-test.txt trên commit cuối. Hai tiến trình thử đã dừng; Compose vẫn chạy.
- **Export/callers đã grep để chuẩn bị thiết kế:** logLevels gọi ở main.ts và log-levels.spec.ts; correlationIdMiddleware đăng ký trong app.setup.ts, kiểm ở correlation-id.middleware.spec.ts; configureHttpApp gọi từ main.ts, health.e2e-spec.ts, error-handling.e2e-spec.ts, money.e2e-spec.ts và test/support/money-driver.ts. Logger hiện có ở filter và TransactionService; error-handling.e2e-spec.ts kiểm lời gọi Logger. Nếu đổi exported symbol khác ở G2/G3 sẽ grep bổ sung.

### Baseline

Node 24.19.0, npm 11.17.0. Ban đầu chưa có node_modules, env local hoặc Docker daemon. Đã npm ci theo lockfile, khởi động Docker Desktop; lần pull image đầu lỗi mạng EOF, lần thử lại thành công. Không thêm dependency hoặc sửa manifest/lockfile. Compose dùng giá trị local mặc định; các lần chạy app và test DB lấy env từ tệp example trong tiến trình, không tạo env file hoặc dùng credential thật.

| Lệnh | Kết quả thực tế trước thay đổi |
|---|---|
| docker compose up -d | Đạt sau lần thử lại; PostgreSQL 17, Valkey, ElasticMQ đã chạy |
| npm run lint:check | Exit 0 |
| npm run typecheck | Exit 0 |
| npm test | 25 suite / 367 test đạt; 0 bỏ qua |
| npm run test:e2e | 4 suite / 25 test đạt; 0 bỏ qua; suite hiện có dùng DB mock, không gọi đây là bằng chứng DB thật |
| npm run test:db | 5 suite / 91 test đạt; 0 bỏ qua; PostgreSQL 17 Compose thật qua DATABASE_URL, không phải đường tự tạo container của helper |
| npm run build | Exit 0 |
| node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs | Trước khi thêm feature doc: 87 file, 0 link hỏng |

[Output baseline](screenshots/DBS-42/baseline-phase1.txt). Đây là baseline local của mã nguồn main, không phải kết quả CI hoặc kết quả implementation DBS-42.

### Phạm vi đề xuất ở G1

- Tích hợp nestjs-pino cho log runtime của Nest và bootstrap ở API/worker; chuẩn hóa năm trường DoD, timestamp UTC, mức log và bảo vệ dữ liệu nhạy cảm. Log HTTP dùng chính correlationId middleware server đã sinh; bảo toàn kiểm soát client ID.
- Quy ước không log request/response body; kiểm soát headers, URL/query, lỗi/stack và structured metadata ở các đường log hiện có, không chỉ thêm danh sách key redact. Thiết kế và test chính xác ở G2.
- Tận dụng log-levels.ts và LOG_LEVEL hiện có; thêm test JSON đầu ra, trường/timestamp, role, mức log và che dữ liệu; chạy API/worker thật để đọc JSON, lưu transcript và ảnh thật ở Phase 4–5. Không miễn đường test tay thành công.
- Cập nhật backend/README, phần log hệ thống/threat model nếu fact thay đổi, feature doc/index/backlog theo skill. DoD #5 là quy trình: ghi rõ review/CI/merge còn thiếu, không tự merge hoặc sửa board.

**Backlog đã đối chiếu:** [BACKLOG](../BACKLOG.md) hiện không có dòng triển khai JSON logger/redaction phải đóng trong DBS-42. BL-007 (config tiền), BL-008 (lint tiền), BL-009 (worker serialize payload bigint thật), BL-010 (consumer unknown event) liên quan code nền tảng/worker nhưng ngoài phạm vi này. BL-012/013/014/016 liên quan ruleset, workflow và bằng chứng CI của task trước, không giải quyết bằng việc chạy test local của DBS-42. BL-015 là test DB lệch giờ đã ghi nhận ở DBS-21; baseline lần này đạt, chưa đủ để đóng dòng đó. Các dòng schema/ledger/outbox còn lại không cùng DoD, giữ nguyên. Không xóa backlog chỉ vì baseline xanh.

**Ngoài phạm vi:**

- DBS-43: provider/hàm AsyncLocalStorage chung của dự án, truyền context qua các tầng nghiệp vụ, consumer/worker lấy correlationId từ message, chứng minh hai request song song không lẫn context ở service con. nestjs-pino có thể dùng context nội bộ thư viện; DBS-42 không triển khai provider ALS của DBS-43 và không giả lập consumer chưa có.
- Không thay schema, transaction, nghiệp vụ tiền, ErrorCode, event contract hay quyết định ADR; không đổi APP_ROLE hoặc LOG_LEVEL thành tập giá trị khác. Không triển khai dashboard/metric, CloudWatch, audit hay pipeline mới.
- Không sửa log console của driver test/CLI thành log vận hành. Quy tắc JSON áp dụng output log của ứng dụng, không phải thông báo npm, compiler/watch hoặc Docker.

### Câu hỏi / quyết định cần duyệt ở G1

1. **Dependency mới:** đề xuất thêm runtime dependencies `nestjs-pino` (tích hợp Nest), `pino` (ghi JSON/timestamp/redaction) và `pino-http` (request logger/serializer). Chỉ trong backend/package.json và lockfile; chọn phiên bản tương thích Nest 11/Node 24 ở G2, chưa cài trước khi phạm vi/thiết kế/kế hoạch được duyệt. Không thêm pino-pretty hoặc dịch vụ ngoài. Có đồng ý phạm vi dependency này không?
2. **Log ngoài request/message:** đề xuất vẫn luôn có trường `correlationId`, giá trị `null` khi chưa có context, như log khởi động; không tạo UUID giả làm ID của một request. Log HTTP phải có UUID server thật. DBS-43 bổ sung context xuyên worker/message và service con. Có đồng ý ý nghĩa `null` cho log ngoài context không?
3. **APP_ROLE=both:** ADR-13 cho phép both nhưng DoD chỉ cho role api|worker. Đề xuất role log theo nguồn: HTTP=api, tác vụ nền=worker; bootstrap/generic của tiến trình both mặc định api (có thể thêm appRole=both để giữ thông tin tiến trình). Không đổi ý nghĩa APP_ROLE. Có đồng ý ranh giới này để thiết kế ở G2 không?
4. **Tích hợp DBS-43 đang In Progress:** đề xuất DBS-42 sở hữu cấu hình/logger output và HTTP binding; DBS-43 dùng interface logger được công bố ở G2/G3 để gắn context nghiệp vụ/message. Chưa xác nhận người làm, interface hay PR xung đột với đồng đội; remote branches fetch được chưa có nhánh DBS-43. Nếu đang có thay đổi cùng bootstrap/middleware, cần người dùng cung cấp interface hoặc diff để đối chiếu. Không tự gửi tin nhắn hay coi đã thống nhất. Có đồng ý tách phạm vi như vậy không?

**Quyết định của người dùng:** Người dùng phụ trách cả DBS-40–43 và trực tiếp yêu cầu tiến thẳng tới code, không thực hiện review G1–G4. Áp dụng chỉ dẫn trực tiếp này thay cho các điểm chờ duyệt trong skill; vẫn thực hiện thiết kế, domain review, test và ghi bằng chứng. Không coi đây là Dev review của PR hoặc xác nhận CI/merge. Chấp nhận các lựa chọn kỹ thuật đề xuất ở trên trong phạm vi DBS-42; không mở rộng sang triển khai DBS-43.

### Rà soát lần 2 (2026-10-25): phạm vi sửa đã duyệt ở G1

PR #16 do minhduc47 mở từ nhánh này; `442e99b` là bản được rà soát. Tech lead yêu cầu review và **sửa trực tiếp trên nhánh bằng commit mới**, không ghi đè lịch sử, không `--force`, và cho phép push (chỉ sau G4). Các mục ở trên mô tả đúng bản gốc; những chỗ đã lỗi thời («PR: chưa có», «chưa có nhánh DBS-43», BL-019/020/021 trùng số với DBS-26/27 trên `main`) được sửa ở §8/§9. Các gate G1 đến G4 của bản gốc đã bị bỏ theo chỉ dẫn lúc đó; lần rà soát này chạy đủ gate.

**Baseline trên `442e99b`** (2026-10-25, Node 24.19.0): lint, typecheck, build exit 0; unit 26 suite / 385 test; e2e 6 / 36; `test:db` 5 / 91 (Docker Desktop bật lại); 0 bỏ qua. Khớp §8 gốc.

**Phát hiện đã tái hiện bằng cách chạy code của `442e99b`** (probe logger với stream thu dòng thô, và chạy `main.ts` thật):

| # | Mức | Phát hiện | DoD |
|---|---|---|---|
| 1 | blocking | `uncaughtException` in stack dạng text ra stderr, kèm chuỗi `postgres://user:…@…` giả; không phải JSON và lộ bí mật | 1, 2 |
| 2 | should-fix | Cấu hình sai (`PORT=not-a-number`) chỉ ra `Diagnostic event` và `errorType`, không nêu khoá sai | 1 |
| 3 | blocking | `accountNo`, `cardNo`, `pan`, `apiKey`, `api_key`, `headers`, `rawHeaders` ra nguyên văn; README §8 khẳng định số tài khoản/thẻ được che | 2 |
| 4 | should-fix | Caller gửi `role`, `correlationId`, `level`, `time`, `appRole` thì dòng thô có khoá lặp; `level:99` và `correlationId` giả thắng khi parser lấy khoá cuối | 1 |
| 5 | should-fix | Getter ném lỗi hoặc Proxy bị thu hồi làm lời gọi `logger.info` ném lỗi vào caller | 1 |
| 6 | minor | `message` là object lộ nguyên (kèm khoá `message` thứ hai); `logger.info(42)` cho `message: 42` | 1, 2 |
| 7 | minor | Allowlist SQLSTATE hẹp, bỏ lớp 22, 25… | — |
| 8 | quy trình | Bỏ G1 đến G4; reviewer là `gpt-6-astra`, không phải Opus 5.5 effort medium như yêu cầu của người dùng; chưa có Dev review | — |
| 9 | tài liệu | Doc lỗi thời như trên; BL trùng số với `main` | — |
| 10 | tích hợp | PR `CONFLICTING` với `main`; chỉ `docs/BACKLOG.md` xung đột | — |

**Quyết định của người dùng ở G1 (tech lead, 2026-10-25):** duyệt sửa #1 đến #7 và #9, #10 bằng commit mới cộng một merge commit từ `origin/main`; chấp nhận file ngoài danh sách của bản gốc (`common/logging/process-logging.bootstrap.ts`, `config/validation.schema.ts` và spec, `config/index.ts`, `test/support/crash-preload.ts`); không thêm dependency, không đổi env var; domain review chạy lại bằng Opus 5.5 effort medium (#8). Đã cho phép push thường lên nhánh PR #16, sau G4. Ngoài phạm vi: 413 cho body quá lớn, context worker/message (DBS-43).

## 2. Hành vi

- Mọi dòng log runtime là JSON: `level` là số theo Pino (trace=10, debug=20, info=30, warn=40, error=50, fatal=60); `time` là ISO UTC có `Z`; `message` là chuỗi; `role` thuộc `api|worker`; `correlationId` là UUID của request hoặc `null` ngoài context. Có thêm `appRole` để phân biệt tiến trình `both`.
- Giữ nguyên LOG_LEVEL hiện có: verbose→trace, log→info, các mức khác cùng tên; mức đang chọn và các mức nghiêm trọng hơn được ghi. Dùng `logLevels()` hiện có làm nguồn ánh xạ/fallback. Không thêm hoặc đổi env var.
- HTTP dùng UUID do correlation middleware sinh, không lấy X-Correlation-Id của client. Request log chỉ có method; response chỉ có statusCode; không log URL/path/query, headers, cookies, request/response body hoặc địa chỉ mạng.
- Redaction theo key cho token, mật khẩu, Authorization, cookie và số tài khoản; Error serializer chỉ giữ loại lỗi và mã kỹ thuật được kiểm định, không giữ message/stack/cause/query/parameters. Chuỗi log nghiệp vụ phải là thông điệp cố định, không nội suy dữ liệu người dùng hoặc exception message.
- **Che khoá (sửa #3):** khoá được chuẩn hóa trước (bỏ `_` và `-`, chữ thường). Các khoá hiện có giữ so khớp chuỗi con. Thêm chuỗi con `credential`, `apikey`, `privatekey`, `pwd`, `jwt`, `passphrase`, `connectionstring`, `databaseurl`, `securitycode`. Các khoá ngắn dễ trùng chuỗi con dùng hai kiểu chặt hơn: **nguyên khoá** cho `pan`, `cardpan`, `pannumber`, `otpcode`, `otpvalue`, `totp`, `totpcode`, `mfacode`, `smscode`, `verificationcode`, `pincode`, `cardpin`, `cvc2`, `sid`, `sessionid`, `pass`, `dsn`, `signature`, `auth`; và **hậu tố** cho `accountno`, `accountnum`, `cardno`, `cardnum`, `pin`, `otp`, `cvc` (bắt `toAccountNo`, `beneficiaryAccountNo`, `newPin`, `transactionPin`, `smsOtp`). Nhờ vậy `footprint`, `panel`, `span`, `snapshotpolicy`, `notpaid`, `cardNotPresent`, `accountNotFound` không bị che. `headers` và `rawheaders` thuộc nhóm bỏ hoàn toàn (`[Redacted]`). **Mọi giá trị chuỗi ở mọi field** được quét bằng bộ che bí mật: URI có credential (`postgres://…`, `https://…`), `Bearer …`, `Basic <base64>`, `password=…` (kể cả dạng JSON `"password":"…"`) và JWT thô. Mẫu JWT neo bằng `\b` và lượng từ có cận dưới (`\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+`) để không chạy bậc hai; chuỗi dài hơn 4096 ký tự bị thay bằng `[Omitted]` **trước** khi quét. `message` còn được che thêm chuỗi ≥ 8 chữ số; heuristic số không chạy trên field khác (UUID có đoạn toàn chữ số không bị che nhầm). v1 định danh tài khoản bằng UUID nên `fromAccountId` chứa UUID và không bị che. README §8 liệt kê tên khoá được che và các giới hạn: tên khoá không có trong danh sách vẫn lọt, giá trị bí mật dạng khác (ví dụ chuỗi base64 trần) không bị quét.
- **Envelope duy nhất (sửa #4):** các khoá `level`, `time`, `message`, `msg`, `appRole`, `role`, `correlationId` trong object do **caller** truyền bị bỏ ở hook `logMethod`, trước khi pino trộn mixin. Hook dựng **object mới** (sao chép nông, đọc từng khoá qua lớp bảo vệ) và không bao giờ sửa `args[0]`, vì object đó có thể là object nghiệp vụ của caller. Caller không đặt được `role` hay `correlationId` bằng object log, kể cả giá trị UUID hợp lệ; hai khoá này chỉ đến từ mixin và binding. `appRole` nằm ở `base` của root. `http-logging.ts` gọi `requestId(req, res)` **trước** `runInContext` và bind đúng giá trị đó (UUID hợp lệ, nếu không thì `null`), cùng `role: 'api'`, để log của handler, filter, completion và header response cùng một ID kể cả khi request logger được gắn mà thiếu correlation middleware. Mixin không thêm `role`/`correlationId` nếu logger đã bind, nên với **logger gốc, request logger HTTP và object của caller**, mỗi khoá xuất hiện đúng một lần.
- **Binding của child logger là ranh giới với DBS-43 (không sửa trong DBS-42):** `formatters.bindings` của pino chỉ chạy trên `base` và bị đặt lại ở mỗi `child()`, nên binding do `logger.child(...)`, `PinoLogger.assign()` hay `runInContext` của code khác tạo **không** được che hay khử trùng khoá; gán lại `correlationId` trên logger đã có sẽ cho hai khoá trong dòng thô. Trong DBS-42 chỉ có binding do server tạo (`role`, `correlationId` UUID hoặc `null`, và `req` qua serializer) nên không có rò rỉ. DBS-43 phải bind mỗi context đúng một lần và không đưa dữ liệu nhạy cảm vào binding (hoặc dùng một hàm bind chung có sanitize). DBS-43 cũng phải bảo đảm consumer không log dữ liệu cá nhân (`customers.full_name`; docs/03 yêu cầu không ghi PII vào log); `fullname` không nằm trong tập khoá che vì DBS-42 không log dữ liệu khách hàng. Ghi vào README §8 và BACKLOG.
- **Log hỏng không bao giờ đổi kết quả của caller (sửa #5):** bốn lớp. (1) Trong `logging.options`, mọi truy cập thuộc tính, `instanceof` và xử lý giá trị lồng nhau nằm trong lớp bảo vệ theo từng phần tử: phần tử hỏng thành `[Omitted]`, field khỏe cùng cấp và envelope vẫn được ghi. (2) Toàn bộ thân hook `logMethod` bọc try/catch; nếu lỗi, gọi `method.call(this, 'Log call failed')` **trong một try/catch riêng và nuốt lỗi**, vì chính lần ghi có thể hỏng (stream ném lỗi) và log completion của pino-http chạy trong listener `finish`, nơi một lỗi sẽ thành `uncaughtException`. (3) `safeErrorMetadata` là hàm toàn phần (try/catch, lỗi truy cập trả `{ errorType: 'NonError' }`), nên các nơi gọi nó ngoài logger (filter, `TransactionService`, `main.ts`) không thể ném. (4) Lớp `SafeLogger` mới (`common/logging/safe-logger.ts`, `implements LoggerService`) bọc `Logger` của nestjs-pino: mỗi phương thức nằm trong try/catch; khi lỗi, ghi dòng cố định `Log call failed` bằng **cùng phương thức mức** đã gọi, thẳng vào logger bên trong (không đi qua `Logger` của Nest nên không lặp vô hạn), trong một try/catch riêng, rồi nuốt lỗi kể cả khi lời gọi dự phòng cũng ném; mức bị tắt thì dòng này cũng không ra. `main.ts` đưa `SafeLogger` cho NestFactory; `Logger` tĩnh của Nest (filter, `TransactionService`) ủy quyền cho nó nên một lời gọi log hỏng, ví dụ getter ném lỗi ở cấp cao nhất hoặc Proxy bị thu hồi, không thể làm `onRetry` bỏ retry hay biến 503 thành 500. **Giới hạn:** code gọi thẳng `PinoLogger`, `@InjectPinoLogger` hay `req.log` (đường mà adapter của DBS-43 sẽ dùng) chỉ được lớp (1) và (2); nestjs-pino đọc object của caller trước hook, nên getter ném lỗi ở cấp cao nhất vẫn có thể ném tới caller ở các đường đó (hand-off DBS-43). Log completion của pino-http chỉ chứa `req`/`res` đã chuẩn hóa và `customProps` do server tạo.
- **`message` luôn là chuỗi (sửa #6):** đối số đầu là số/boolean/bigint được đổi thành chuỗi; đối số không có chỗ điền trong chuỗi định dạng bị bỏ (không nối thêm); khoá `message`/`msg` kiểu object trong metadata bị bỏ.
- **Mã kỹ thuật (sửa #7):** `safeErrorMetadata` tìm mã theo đúng thứ tự duyệt của `pg-error.util.ts` (`error`, `driverError`, `cause`), tối đa vài tầng và có bảo vệ vòng. Với `driverError.code` của lỗi driver PostgreSQL giữ mọi SQLSTATE đúng dạng `^[0-9A-Z]{5}$` (5 ký tự, không mang dữ liệu). `code` trần trên lỗi không phải `QueryFailedError` chỉ được giữ nếu thuộc allowlist theo lớp SQLSTATE (`08`, `23`, `25`, `28`, `3D`, `40`, `42`, `53`, `55`, `57`, `58`; thêm `25` để `25P03` của 503, `28` và `3D` để lỗi kết nối thường gặp lúc khởi động như `28P01` hay `3D000` có mã) hoặc mã mạng `ECONNRESET|ECONNREFUSED|ETIMEDOUT|EPIPE|ENOTFOUND|EAI_AGAIN`; mã khác bị bỏ.
- **Lỗi cấu hình khi khởi động (sửa #2):** `validateEnv` ném `ConfigValidationError` (kế thừa Error, giữ nguyên message gộp nên mọi caller hiện có không đổi hành vi) kèm `invalidKeys`: tên khoá lấy từ Joi `detail.path[0]`, chỉ nhận khoá có trong schema; lỗi mức object như quy tắc giới hạn chuyển tiền (path rỗng) dùng nhãn cố định `<cross-field>`. `APP_ROLE` sai phát sinh ở `getAppRole()` trước khi nạp AppModule và được log là `invalidKeys: ['APP_ROLE']`. `main.ts` chỉ log `{ invalidKeys }`, không log giá trị hay message của lỗi.
- **Lỗi lọt ra cấp tiến trình (sửa #1):** `uncaughtException` và `unhandledRejection` ra đúng một dòng JSON `level:60` (`fatal`) với `safeErrorMetadata`, không message, không stack, rồi tiến trình thoát với mã 1. Thoát có chủ ý vì handler thay hành vi crash mặc định, còn `setInterval` của worker hay listener của API giữ tiến trình sống. Ghi bằng instance pino riêng ghi **đồng bộ** vào stdout trong handler. Giới hạn còn lại phải ghi vào README và BACKLOG: `process.emitWarning` (ví dụ cảnh báo `sslmode` của `pg-connection-string`) vẫn ra stderr dạng text; lỗi ném đồng bộ khi nạp chính `env.bootstrap` xảy ra trước handler nên vẫn là stderr dạng text; dòng log runtime đang ghi dở (stdout của root bất đồng bộ) có thể bị cắt khi crash và dòng trước crash có thể xuất hiện sau `fatal` (dùng `time` để sắp xếp).
- Filter lỗi bỏ `correlationId` khỏi object log: giá trị đã đến từ binding của request logger, và sanitizer cũng bỏ khoá này của caller, nên khoá thừa không bao giờ ra dòng JSON. TC-42-13 đỏ trên `442e99b` (probe cho thấy `correlationId` xuất hiện hai lần) và xanh sau khi bỏ khoá envelope của caller.
- Filter lỗi giữ nguyên HTTP contract, nhưng log thông điệp cố định và metadata an toàn thay cho URL, message/stack thô. TransactionService giữ hành vi retry, chỉ log số lần retry và mã lỗi đã kiểm định.
- Worker-only có role=worker; tiến trình both có role mặc định api. HTTP luôn role=api. DBS-43 sẽ bổ sung context cho tác vụ worker trong both; DBS-42 không giả lập worker/consumer chưa có.
- Không đổi schema, errorCode API, transaction, audit, event contract. Không log SQL hay dữ liệu thật để test redaction.

## 3. Kiến trúc

- `common/logging/logging.options.ts`: `createLoggingOptions(settings, stream?)` tạo cấu hình Pino HTTP; `safeErrorMetadata(error)` lọc lỗi; serializer và structured redaction không phụ thuộc module nghiệp vụ.
- `common/logging/logging.module.ts`: LoggerModule của nestjs-pino được cấu hình từ appConfig và export qua module hạ tầng. AppModule import module này cho mọi APP_ROLE.
- `main.ts`: tạo logger JSON an toàn trước khi nạp động AppModule trong try/catch; đưa logger trực tiếp cho NestFactory với abortOnError=false, không buffer hoặc tự flush qua ConsoleLogger. Log bootstrap và lỗi khởi động bằng cùng logger; lỗi có exit code khác 0. Không còn console.log runtime.
- `configureHttpApp()` nhận request logger tùy chọn làm đối số thứ ba, cài ngay sau correlation middleware, trước CORS và body parser. `createHttpLogging()` dùng API công khai PinoLogger.runInContext cho HTTP binding và pino-http để ghi completion; LoggerModule đặt forRoutes=[] tránh đăng ký trùng. HTTP context dùng nội bộ thư viện, không tạo provider ALS chung của DBS-43. Test cả preflight và JSON hỏng để chứng minh đường trả lời sớm cũng có đúng một completion record.
- Root logger ngoài request có correlationId=null; request child logger có UUID. Không tạo provider ALS chung. Điểm tích hợp DBS-43 là child/bindings của PinoLogger và cấu hình HTTP; sẽ quyết định provider context ở task đó.
- Dependencies tương thích registry tại lúc kiểm tra: nestjs-pino 5.3.1 yêu cầu Nest ^11.0.8 và pino ^10 / pino-http ^11; repo dùng Nest 11.2.7. Chọn pino 10.4.0 và pino-http 11.0.0. Không pino-pretty, transport bên ngoài hay cloud credential.
- Đối chiếu API tích hợp và request logging với tài liệu chính thức [nestjs-pino](https://github.com/iamolegga/nestjs-pino) và [pino-http](https://github.com/pinojs/pino-http), sau đó kiểm kiểu/source đúng bản đã cài và chạy test đầu ra thực tế.
- Gọi `logLevels()` hiện có tại main.ts và log-levels.spec.ts; thêm caller ở logging options, giữ API cũ. Filter đang gọi từ configureHttpApp; TransactionService từ DatabaseModule; kiểm tra HTTP error-handling test để thay kỳ vọng đang đòi log mật khẩu thô.
- **Phần thêm của lần rà soát lần 2:** (a) `common/logging/process-logging.bootstrap.ts` mới, được import **thứ hai** trong `main.ts`, ngay sau `env.bootstrap` và trước `bigint-json.bootstrap` (giữ thứ tự TC-22-25: env, rồi bigint, rồi nạp động AppModule; đã kiểm `main-wiring.spec.ts` chỉ ràng buộc ba mốc này). Module tạo logger bootstrap duy nhất (stdout bất đồng bộ, là mặc định của Pino) để `bootstrap()` dùng chung, vì root pino-http của nestjs-pino là biến global của thư viện và lần tạo đầu tiên thắng; đăng ký handler dùng một instance pino thuần riêng ghi đồng bộ. Ghi đồng bộ cho cả log runtime bị loại vì SonicBoom có thể chặn event loop khi stdout đầy (NFR-PERF-01). Module bọc `getAppRole()` trong try/catch với role dự phòng `api`. (b) `config/validation.schema.ts` và `config/index.ts`: `ConfigValidationError` và `invalidKeys`, không đổi schema hay env var. (c) `logging.options.ts`: bỏ khoá envelope của caller ở `logMethod` (object mới, thân hook bọc try/catch), tập khoá bị che và quét bí mật trên mọi giá trị chuỗi, lớp bảo vệ theo phần tử, `safeErrorMetadata` toàn phần và nới SQLSTATE; `http-logging.ts` chỉ bind `correlationId` khi là UUID. (d) `common/logging/safe-logger.ts` mới; `main.ts` dùng lại logger bootstrap bọc trong `SafeLogger` và log `invalidKeys`. (e) `problem-details.filter.ts` bỏ `correlationId` khỏi object log.
- **Ghi chú đã kiểm:** cấu hình `pinoHttp` trong `LoggingModule` không có hiệu lực trên đường chạy nào, vì `main.ts` tạo `PinoLogger` trước và root global của thư viện là cái đầu tiên thắng. Giữ lại như mặc định an toàn; e2e phải dựng app giống `main.ts`, không dựa vào cấu hình này. `main.ts` đọc `process.env.LOG_LEVEL` thô trước khi có ConfigModule (ngoại lệ có lý do của CONTRIBUTING §5b, giới hạn ở bootstrap; giá trị sai rơi về mức `log` và Joi vẫn từ chối ngay sau đó).
- Không có thay đổi dữ liệu hay transaction boundary. API→middleware ID→request logger→filter/service Nest Logger→JSON stdout; worker→Nest context logger→JSON stdout.

## 4. Test cases tự động

| Case | Layer | Kiểm chứng | DoD |
|---|---|---|---|
| TC-42-01 | Unit, ghi Pino thật vào stream | Mỗi dòng parse được JSON, đủ trường, ISO UTC; APP_ROLE api→role api, worker→worker, both→api + appRole both; không có role=both | 1 |
| TC-42-02 | Unit | Sáu LOG_LEVEL lọc đúng các mức; fallback khớp logLevels | 3 |
| TC-42-03 | Unit | Structured metadata lồng nhau/array che token, Authorization, mật khẩu, body, số tài khoản/thẻ (`accountNo`, `cardNo`, `pan`) và các khoá `credential`/`apikey`/`api_key`/`privatekey`/`pwd`/`jwt`/`passphrase`/`connectionString`/`databaseUrl`, và khoá nguyên `pan`/`cardPan`/`card_pan`/`panNumber`/`otp`/`otpCode`/`otp_value`/`totpCode`/`mfaCode`/`smsCode`/`verificationCode`/`pin`/`pinCode`/`cardPin`/`cvc`/`cvc2`/`sid`/`sessionId`/`dsn`/`accountNo`/`accountNum`/`cardNo`/`cardNum`/`pass`/`signature`/`toAccountNo`/`smsOtp`/`newPin`/`cardSecurityCode`; URI có credential, `Bearer …`, `Basic …`, chuỗi JSON dạng `{"password":"…"}`, JWT thô trong **bất kỳ field chuỗi** nào (không chỉ `message`) bị che; `headers`/`rawHeaders` bị bỏ; message che JWT thô; giữ metadata an toàn, không che nhầm `footprint`/`panel`/`snapshotPolicy`/`notPaid`/`cardNotPresent`/`accountNotFound`/`span`; chuỗi `'eyJ'.repeat(20000)` xử lý dưới 50 ms (không ReDoS) và field dài hơn 4096 ký tự thành `[Omitted]` | 2 |
| TC-42-04 | Unit | Error/cause chứa SQL, URI credential, token không xuất hiện trong JSON; giữ mọi SQLSTATE 5 ký tự (gồm `22P02`, `25P02`) và mã mạng hợp lệ, bỏ mã lạ; `code` 5 ký tự trên lỗi không phải driver (ví dụ `{ code: 'AB12C' }`) bị bỏ, còn `28P01`, `3D000` và `25P03` trần được giữ; mã nằm ở `cause` hoặc `driverError` cũng được lấy (`{ cause: { code: '40P01' } }`); `safeErrorMetadata` không ném với getter hoặc Proxy bị thu hồi | 2 |
| TC-42-05 | HTTP e2e không DB | Response ID trùng log completion và Nest Logger trong handler; header client không chọn được ID; thêm: request logger gắn mà không có correlation middleware vẫn cho cùng ID ở log handler, completion và header response | 1 |
| TC-42-06 | HTTP e2e không DB | Hai request cùng client ID có hai server ID; HTTP method/status được log, URL/query/headers/body không xuất hiện | 1, 2 |
| TC-42-07 | HTTP e2e không DB | Lỗi 500/503 vẫn giữ HTTP contract; filter không log message/stack/query nhạy cảm | 2 |
| TC-42-08 | Unit TransactionService | Retry log không có exception text; timeout/retry behavior vẫn giữ; **thêm:** khi logger hỏng (ném lỗi) vẫn retry và trả kết quả như cũ, chạy qua `SafeLogger` và `Logger` của `@nestjs/common`, kể cả khi logger bên trong ném lỗi ở cả lời gọi dự phòng | 2 |
| TC-42-10 | HTTP e2e | Preflight OPTIONS và malformed/oversized JSON đều có đúng một completion log, đúng response correlationId, không log body | 1, 2 |
| TC-42-11 | Subprocess/runtime | API/worker cấu hình sai, role sai và kết nối DB thất bại: JSON-only, nonzero exit, không lộ synthetic secret hoặc stack; retry log qua sanitizer. **Thêm:** `invalidKeys` đúng bằng `["PORT","LOG_LEVEL"]` với fixture hai biến sai, đúng bằng `["<cross-field>"]` với fixture chỉ cặp giới hạn chuyển tiền sai (giá trị dễ nhận, ví dụ `TRANSFER_LIMIT_PER_TX=987654321098` và `TRANSFER_LIMIT_PER_DAY=123456789012`, để kiểm "không chứa giá trị" không đụng `time` hay `statusCode`), và fixture quy tắc pattern có giá trị nằm trong message của Joi (`TRANSFER_LIMIT_PER_TX=sensitive-limit-fixture`) với `invalidKeys` đúng bằng `["TRANSFER_LIMIT_PER_TX"]` và chuỗi `sensitive-limit-fixture` không xuất hiện ở stdout/stderr (để bắt việc log `error.message`), đúng bằng `["APP_ROLE"]` với role sai, và output không chứa giá trị fixture; `uncaughtException` và `unhandledRejection` ở **cả api và worker**, gây ra bằng preload chỉ dùng cho test (`-r ./test/support/crash-preload.ts`, hẹn `setImmediate` ném lỗi trong khi khởi động, sau khi handler đã đăng ký, không cần PostgreSQL nên chạy được ở job `e2e` của CI), ra đúng một dòng `level:60`, tiến trình thoát ≠ 0 trong thời hạn test (thứ tự dòng chỉ kiểm theo `time`, không theo vị trí dòng), không có chuỗi bí mật giả và không có stderr | 1, 2, 3 |
| TC-42-12 | Unit (thêm ở lần rà soát lần 2, viết ở Phase 4; các ca `{name,message}`, `{code,message}`, `err` là chuỗi URI và số ≥ 8 chữ số đã đạt trên `442e99b`, nên là khóa hồi quy, chỉ ca `Date`, `Buffer` và object dùng chung là đỏ trước khi sửa) | Object `{ name, message }` và `{ code, message }` bị rút còn `errorType`; khoá `error`/`err` là chuỗi chứa URI hoặc credential thành `{ errorType: 'NonError' }`; message có số ≥ 8 chữ số bị che, số ngắn giữ nguyên; `Date` ra ISO, `Buffer` bị bỏ, object dùng chung không vòng không thành `[Omitted]`, object vòng không làm treo logger | 2 |
| TC-42-13 | HTTP e2e không DB, dựng app tương đương `main.ts` | Dòng log của filter lỗi (500 và 503) chứa `correlationId` đúng một lần và đúng ID response (parse dòng thô, đếm khoá); đỏ trên `442e99b` trước khi sửa | 1 |
| TC-42-14 | Unit, và qua `Logger` của `@nestjs/common` với `SafeLogger` | Mỗi khoá envelope đúng một lần trong dòng thô trên logger gốc và request logger kể cả khi caller gửi trùng, kể cả giá trị UUID hợp lệ (caller không đặt được `correlationId` hay `role`); object của caller không bị sửa tại chỗ; đối số không có chỗ điền bị bỏ; số/boolean làm đối số đầu thành chuỗi; `message` kiểu object bị bỏ; getter/Proxy ném lỗi ở giá trị lồng nhau hoặc phần tử mảng không làm hỏng lời gọi, không mất envelope, giữ field khỏe; getter/Proxy ở **cấp cao nhất** qua `SafeLogger` không ném và ra dòng `Log call failed` có envelope, đúng mức đã gọi, và không ra dòng nếu mức đó bị tắt; thân `logMethod` hỏng ra `Log call failed` thay vì ném; stream ném lỗi đồng bộ (cả lần ghi dự phòng) không ném tới caller và không thành `uncaughtException` từ listener `finish`. **Ngoài phạm vi (DBS-43):** binding của child do code khác tạo không được che/khử trùng, có test ghi lại hành vi hiện tại | 1, 2 |
| TC-42-09 | Quy trình | Dev review, CI xanh và merge main phải có link thật | 5 |

Không áp dụng ownership, idempotency, role guard hay invariant tiền vì không thêm endpoint nghiệp vụ hoặc sửa xử lý tiền. Không dùng test logger để kết luận DB/audit/consumer đã hoạt động.

## 5. Test thủ công

Driver test tay được giữ tại `backend/test/support/logging-driver.ts`, chạy bằng Node/ts-node theo lệnh ghi ở §8; khởi động ứng dụng thật ở cổng tạm và dùng env ví dụ, không cloud credential. Dùng Git Bash để lưu transcript UTF-8 hoặc driver chủ động ghi UTF-8.

| Case | Hành động | Kết quả mong đợi |
|---|---|---|
| M-42-01 | Chạy API thật trên PostgreSQL Compose; gọi live/ready, gửi ID client giả | 200, ID server khác ID client; startup/completion JSON đủ trường, ID log trùng header |
| M-42-02 | Gọi URL không tồn tại kèm query/header/body dữ liệu giả | 404 có correlationId; không có dữ liệu giả trong stdout/stderr |
| M-42-03 | Chạy APP_ROLE=worker thật | Bootstrap JSON role=worker, correlationId=null, không mở HTTP |
| M-42-04 | Chạy APP_ROLE=both, sau đó API LOG_LEVEL=error | both giữ appRole; mức error không ghi startup info, health 200 hoặc route 404; lỗi error được kiểm riêng qua unit/e2e |
| M-42-05 | Chạy unit/e2e mới kiểm đầu ra thật và test retry lỗi | Metadata nhạy cảm không xuất hiện; mã lỗi/HTTP contract giữ nguyên |
| M-42-06 | **Đường lỗi và phục hồi (thêm ở lần rà soát lần 2):** chạy app thật `APP_ROLE=api` (a) với `LOG_LEVEL=INFO`, (b) với `PORT=not-a-number`, (b2) với `TRANSFER_LIMIT_PER_TX=sensitive-limit-fixture`, (c) với `DATABASE_URL` trỏ cổng không có PostgreSQL và mật khẩu giả, (d) worker có lỗi chưa bắt trong khi khởi động (preload chỉ dùng cho test, hẹn `setImmediate` sau khi handler đã đăng ký), (e) sau đó chạy lại bình thường | (a)(b)(b2)(c)(d) exit ≠ 0 và mọi dòng stdout/stderr là JSON; (a) nêu `LOG_LEVEL`, (b) nêu `PORT`, (b2) nêu `TRANSFER_LIMIT_PER_TX` và không có chuỗi `sensitive-limit-fixture`, không nêu giá trị; (c) không chứa mật khẩu giả hay stack; (d) đúng một dòng `fatal`, không có chuỗi bí mật giả, không stderr; (e) khởi động lại thành công, ready 200 |

Driver hiện chỉ có `run(role, level)` cho M-42-01…05; Phase 4 sẽ mở rộng để chạy M-42-06 (các ca a–e, preload, fixture cấu hình sai) và để đọc biến `DBS42_DATABASE_URL` (chỉ cho test tay, không phải biến của ứng dụng, không vào `.env.example` hay schema) để trỏ vào PostgreSQL khác; dòng đầu transcript ghi host đích, không ghi mật khẩu.

M-42-04 có phần harness HTTP riêng cho đường lỗi vì ứng dụng production chỉ có health endpoint; driver không thêm endpoint debug vào AppModule. Ghi rõ bằng chứng runtime AppModule và bằng chứng harness riêng.

## 6. Domain review (AI)

Reviewer độc lập **gpt-6-astra**: vòng thiết kế đầu có 1 blocking (bootstrap failure), 1 should-fix (request trả lời trước middleware logger), 1 minor (diễn đạt role both). Đã sửa thiết kế ở §3/§4, thêm TC-42-10/11 và review lại: **Verdict: APPROVE**. Nguyên văn: [vòng đầu](screenshots/DBS-42/domain-review.md), [vòng cuối](screenshots/DBS-42/domain-review-final.md).

Review implementation phát hiện 3 lỗi privacy (interpolation, toJSON, serialized Error) và 1 lỗi envelope cho serialized Error ở root. Mỗi lỗi đều được tái hiện bằng test đỏ trước khi sửa, sau đó xanh. Hook hiện lọc tham số trước format và chuỗi cuối sau format; sanitizer loại function/symbol và giảm Error/plain error về allowlist; root error được bọc trước mixin. [Nguyên văn review implementation](screenshots/DBS-42/implementation-review.md), kết luận cuối **Verdict: APPROVE**. AI review không thay Dev review PR.

### Domain review của thiết kế sửa lỗi (2026-10-25)

Reviewer độc lập **Opus 5.5, effort medium** (đúng yêu cầu của người dùng), subagent mới không đọc các review cũ. Vòng 1: 0 blocking, 4 should-fix, 5 minor, **Verdict: REVISE**. Nguyên văn: [domain-review-fixes.md](screenshots/DBS-42/domain-review-fixes.md). Cả 9 phát hiện đều có probe hoặc nguồn kiểm chứng và đều được sửa trong thiết kế:

| # | Mức | Xử lý |
|---|---|---|
| 1 | should-fix | **Đã sửa.** Guard chỉ trong `logging.options` không đủ vì nestjs-pino đọc object của caller trước hook, và `onRetry` của `TransactionService` chạy trước lần chờ retry (log ném lỗi có thể biến 503 thành 500). Thêm `safeErrorMetadata` toàn phần và `SafeLogger` (§2, §3 (d)); TC-42-08 thêm ca logger hỏng vẫn retry; TC-42-14 chạy qua `Logger` của Nest |
| 2 | should-fix | **Đã sửa.** `otp` so khớp nguyên khoá cùng `pan`, `cardpan`, `pannumber`, `otpcode`; `footprint`, `snapshotpolicy`, `notpaid` là ca âm của TC-42-03 |
| 3 | should-fix | **Đã sửa.** Một quy tắc duy nhất: caller không bao giờ đặt được `correlationId`/`role` bằng object log; chỉ mixin và binding. TC-42-13 đỏ trên `442e99b`, xanh sau khi bỏ khoá của caller |
| 4 | should-fix | **Đã sửa.** Bỏ khoá envelope ở `logMethod` (trước mixin) và ở `formatters.bindings` (trừ `role`, `correlationId` hợp lệ); TC-42-14 thêm ca binding |
| 5 | minor | **Đã sửa một phần.** Thêm `cardpan`, `pannumber`; `fromAccount` chứa UUID ở v1 nên không che; README liệt kê tên khoá được che và ghi giới hạn heuristic số chỉ trên `message` |
| 6 | minor | **Chấp nhận, không sửa.** `process.emitWarning` (như cảnh báo `sslmode` của `pg-connection-string`) vẫn ra stderr dạng text; thêm handler `warning` không tắt được in mặc định mà không dùng cờ `--no-warnings`. Ghi README và BACKLOG |
| 7 | minor | **Đã sửa.** Dải `^[0-9A-Z]{5}$` chỉ cho `driverError.code`; `code` trần giữ allowlist; TC-42-04 thêm ca âm `AB12C` |
| 8 | minor | **Đã sửa.** M-42-06(d) và TC-42-11 nói rõ lỗi xảy ra trong khi khởi động; thứ tự dòng kiểm theo `time`. Các giới hạn thứ tự/cắt dòng do reviewer kiểm bằng probe, không có test tự động |
| 9 | minor | **Đã sửa.** Fixture cross-field dùng giá trị dễ nhận (`987654321098`/`123456789012`) |

Phần reviewer xác nhận đúng: thứ tự import không phá TC-22-25, cấu hình `pinoHttp` của `LoggingModule` không có hiệu lực, `invalidKeys` chỉ lấy tên khoá từ Joi. 

### Vòng 2 (2026-10-25)

Reviewer Opus 5.5, effort medium, subagent mới. 1 blocking, 4 should-fix, 3 minor, **Verdict: REVISE**. Nguyên văn: [domain-review-fixes-round2.md](screenshots/DBS-42/domain-review-fixes-round2.md).

| # | Mức | Xử lý |
|---|---|---|
| 1 | blocking | **Đã sửa, là lỗi của tôi ở vòng 1.** `formatters.bindings` của pino chỉ chạy trên `base` (nên sẽ xoá `appRole` khỏi mọi dòng) và bị đặt lại ở mỗi `child()`, `assign()`, `runInContext`. Bỏ ý định dọn binding trong DBS-42; `appRole` ở `base`; binding của code khác là ranh giới DBS-43 (§2, README, BACKLOG). Khoá envelope của caller bỏ ở `logMethod` |
| 2 | should-fix | **Đã sửa.** Thêm các khoá bí mật còn lọt (`pin`, `cvc`, `sessionId`, `passphrase`, `connectionString`, `dsn`, …); URI/`Bearer`/JWT được quét ở mọi field chuỗi; `accountno`/`cardno` và họ khoá ngắn chỉ so khớp nguyên khoá, nên `cardNotPresent`, `accountNotFound` không bị che nhầm |
| 3 | should-fix | **Đã sửa.** Thân `logMethod` bọc try/catch; fallback của `SafeLogger` dùng cùng mức, ghi thẳng vào logger bên trong. Đường `PinoLogger`/`req.log` trực tiếp ghi là giới hạn, hand-off DBS-43 |
| 4 | should-fix | **Đã sửa.** Thêm fixture `TRANSFER_LIMIT_PER_TX=sensitive-limit-fixture` có giá trị nằm trong message Joi (TC-42-11, M-42-06 (b2)) để bắt việc log `error.message` |
| 5 | should-fix (DBS-43) | **Ghi nhận, không sửa trong DBS-42.** Gán lại `correlationId` trên logger đã bind cho hai khoá; DBS-43 bind một lần mỗi context. Claim của DBS-42 thu hẹp về logger gốc, request logger HTTP và object caller |
| 6 | minor | **Đã sửa.** TC-42-12 gắn nhãn khóa hồi quy; chỉ `Date`, `Buffer`, object dùng chung là đỏ trước khi sửa |
| 7 | minor | **Đã sửa.** Hook dựng object mới, không sửa `args[0]` |
| 8 | minor | **Đã sửa.** Allowlist `code` trần thêm lớp `28` và `3D` (`28P01`, `3D000`) |



### Vòng 3 (2026-10-25)

Reviewer Opus 5.5, effort medium, subagent mới. **0 blocking**, 4 should-fix, 4 minor, 1 hand-off, **Verdict: REVISE**. Nguyên văn: [domain-review-fixes-round3.md](screenshots/DBS-42/domain-review-fixes-round3.md). Reviewer xác nhận bằng probe: envelope đúng một lần ở logger gốc, request logger, completion GET/POST/500 và log của handler; `appRole` từ `base`; chi phí khoảng 4,4 µs mỗi lời gọi; fixture `sensitive-limit-fixture` dùng được làm canary; bản sửa vòng 2 chạy được trên pino 10.4.0.

| # | Mức | Xử lý |
|---|---|---|
| 1 | should-fix | **Đã sửa.** Lời gọi dự phòng `Log call failed` nằm trong try/catch riêng ở cả hook và `SafeLogger`; TC-42-08, TC-42-14 thêm ca stream ném lỗi |
| 2 | should-fix | **Đã sửa.** Doc tự mâu thuẫn (`totpCode`, `pass`): thêm `totpcode` vào tập nguyên khoá, TC-42-03 kiểm `pass` |
| 3 | should-fix | **Đã sửa.** Mẫu JWT neo bằng `\b` và cận dưới `{5,}`; chuỗi > 4096 ký tự thành `[Omitted]` trước khi quét; TC-42-03 thêm ca `'eyJ'.repeat(20000)` dưới 50 ms |
| 4 | should-fix | **Đã sửa phần doc, phần việc ở Phase 3.** §5 nêu rõ driver hiện chưa có M-42-06 và `DBS42_DATABASE_URL`, sẽ mở rộng ở Phase 4; §7 cập nhật cho G3 |
| 5 | minor | **Đã sửa một phần.** Hậu tố cho `accountno`/`accountnum`/`cardno`/`cardnum`/`pin`/`otp`/`cvc`, thêm `securitycode`, `signature`, `auth`; phần còn lại là giới hạn ghi ở README §8 |
| 6 | minor | **Đã sửa.** Quét thêm `"password":"…"` dạng JSON và `Basic <base64>` |
| 7 | minor | **Đã sửa.** `http-logging.ts` gọi `requestId(req, res)` trước `runInContext`; TC-42-05 thêm ca không có correlation middleware |
| 8 | minor | **Đã sửa.** `safeErrorMetadata` duyệt `error`/`driverError`/`cause` như `pg-error.util`; thêm lớp `25`; TC-42-04 thêm ca `cause` |
| 9 | hand-off | **Ghi nhận.** DBS-43: consumer không log PII (`customers.full_name`); ghi README §8 và BACKLOG |

**Vòng 4 không chạy.** Các sửa của vòng 3 là siết thêm điều kiện đã có (bọc try/catch, neo regex, thêm khoá và ca test), không đổi cơ chế; đã đề nghị người dùng quyết ở G2 có cần vòng 4 hay không.

## 7. Kế hoạch triển khai

### Kế hoạch sửa sau rà soát lần 2 (chờ G3)

Mỗi bước: viết test trước, chạy và xác nhận đỏ đúng lý do, rồi viết mã tối thiểu cho xanh, rồi commit (`type(module): imperative`, kèm dòng Co-Authored-By, không `--no-verify`). Chạy từ `backend/`. Commit chồng lên `442e99b`, không ghi đè lịch sử.

| Bước | File / scope | Test viết trước, lỗi đỏ dự kiến, lệnh chứng minh | Commit |
|---|---|---|---|
| 0 | Gộp `origin/main` vào nhánh bằng merge commit. `docs/BACKLOG.md` xung đột: giữ BL-019 đến BL-022 của DBS-26/27 trên `main`, đánh lại ba dòng của task này thành BL-023, BL-024, BL-025 và sửa mọi tham chiếu trong feature doc (§8, §9, checklist) | Không có test mới. Chạy lại baseline sau khi gộp: `npm run lint:check && npm run typecheck && npm test && npm run test:e2e && npm run test:db && npm run build`, ghi số đếm mới (main có thêm test của DBS-26/27); `check-doc-links` | `merge: origin/main into feat/DBS-42-json-logger` |
| 1 | `common/logging/logging.options.ts` + `logging.options.spec.ts`: `safeErrorMetadata` toàn phần, duyệt `error`/`driverError`/`cause`, dải SQLSTATE rộng cho `driverError.code`, thêm lớp `25`, `28`, `3D` cho `code` trần (TC-42-04) | Đỏ: với Proxy bị thu hồi hoặc getter ném lỗi, `safeErrorMetadata` ném; `28P01` trần và `{cause:{code:'40P01'}}` ra `NonError` không mã; `22P02` của driver bị bỏ. `npm test -- logging.options` | `fix(logging): make safeErrorMetadata total and keep SQLSTATE codes` |
| 2 | `logging.options.ts` + spec: tập khoá che (chuỗi con, nguyên khoá, hậu tố), `headers`/`rawheaders` bỏ, quét bí mật trên mọi giá trị chuỗi, mẫu JWT neo, cắt chuỗi > 4096 (TC-42-03) | Đỏ: `accountNo`, `cardNo`, `pan`, `apiKey`, `api_key`, `headers`, `rawHeaders`, `pin`, `cvc`, URI trong field thường ra nguyên văn; `'eyJ'.repeat(20000)` chậm. Ca âm `footprint`/`panel`/`span`/`cardNotPresent` phải giữ nguyên. `npm test -- logging.options` | `fix(logging): redact account, card and credential keys and scan every string` |
| 3 | `logging.options.ts` + spec: bỏ khoá envelope của caller ở `logMethod` (object mới), `message` luôn chuỗi, bỏ đối số thừa, lớp bảo vệ theo phần tử, thân hook bọc try/catch và lời gọi dự phòng bọc riêng (TC-42-12, TC-42-14) | Đỏ: khoá lặp `role`/`correlationId`/`level`/`time`/`appRole`, `message` object lộ, `logger.info(42)` ra số, getter/Proxy lồng nhau ném lỗi, `Date` ra `{}`, `Buffer` ra object số, object dùng chung thành `[Omitted]`. Ca khóa hồi quy (`{name,message}`, `{code,message}`, số ≥ 8 chữ số) xanh sẵn. `npm test -- logging.options` | `fix(logging): keep the log envelope unique and the logger from throwing` |
| 4 | `common/logging/safe-logger.ts` + `safe-logger.spec.ts` mới; `database/transaction.service.spec.ts` (TC-42-08, TC-42-14 qua `Logger` của Nest) | Đỏ: khi logger ném lỗi, `onRetry` ném và không retry (40P01 thành lỗi khác); chưa có `SafeLogger`. Ca stream ném lỗi cả lúc ghi dự phòng. `npm test -- "safe-logger|transaction.service"` | `feat(logging): add SafeLogger so a failing log call cannot change a result` |
| 5 | `http-logging.ts` (gọi `requestId` trước `runInContext`), `problem-details.filter.ts` (bỏ `correlationId` khỏi object log), `test/logging.e2e-spec.ts` dựng app giống `main.ts` (PinoLogger tạo bằng tuple `[options, stream]`, `SafeLogger`, `NestFactory`/`setLogger` trước compile, không `bufferLogs`) (TC-42-05 mở rộng, TC-42-13) | Đỏ: dòng log của filter 500 và 503 có `correlationId` hai lần; không có correlation middleware thì handler log `null` còn completion và header có UUID. `npm run test:e2e -- logging.e2e` | `fix(logging): log the request id once and bind it before the request context` |
| 6 | `config/validation.schema.ts` + `validation.schema.spec.ts`, `config/index.ts`: `ConfigValidationError` với `invalidKeys` (key Joi `path[0]`, `<cross-field>` cho lỗi mức object); không đổi schema, message gộp hay env var | Đỏ: `validateEnv` ném `Error` thường, không có `invalidKeys`. Fixture `PORT` + `LOG_LEVEL` ra `['PORT','LOG_LEVEL']`; cặp giới hạn chuyển tiền sai ra `['<cross-field>']`; `TRANSFER_LIMIT_PER_TX=sensitive-limit-fixture` ra `['TRANSFER_LIMIT_PER_TX']`. `npm test -- validation.schema` | `feat(config): report which keys failed validation without their values` |
| 7 | `common/logging/process-logging.bootstrap.ts` mới (import thứ hai trong `main.ts`), `main.ts` (dùng logger bootstrap bọc `SafeLogger`, log `invalidKeys`, `APP_ROLE` sai ra `['APP_ROLE']`), `test/support/crash-preload.ts`, `common/money/main-wiring.spec.ts`, `test/logging-bootstrap.e2e-spec.ts` (TC-42-11) | Đỏ: subprocess api và worker với lỗi chưa bắt và promise bị từ chối in stack text ra stderr (exit 1, không có dòng `level:60`, lộ chuỗi bí mật giả); lỗi cấu hình chỉ ra `Diagnostic event` không có `invalidKeys`. `main-wiring.spec.ts` vẫn pin đúng thứ tự env, bigint, nạp động AppModule. `npm run test:e2e -- logging-bootstrap` và `npm test -- main-wiring` | `fix(logging): log process-level crashes and invalid config keys as JSON` |
| 8 | Review implementation bằng Opus 5.5 effort medium (skill chưa có prompt riêng, dùng prompt tự viết cho diff `442e99b..HEAD`); sửa phát hiện bằng test đỏ trước; nguyên văn lưu `screenshots/DBS-42/implementation-review*.md` | Chạy lại các spec bị ảnh hưởng và baseline; lặp đến khi không còn blocking/should-fix | theo phát hiện |
| 9 | `test/support/logging-driver.ts`: thêm M-42-06 (các ca a–e) và `DBS42_DATABASE_URL`; chạy trên SHA cuối đổi code; `manual-test.txt`, `verification.txt`, 4 ảnh `01`…`04` làm lại từ output thật | M-42-01…06 chạy đủ, exit 0, dòng đầu `manual-test.txt` là SHA; ca không chạy được ghi «chưa chạy» kèm lý do. Baseline đủ: lint, typecheck, build, unit, e2e, `test:db`, `check-doc-links` | `test(logging): cover failure and recovery in the manual driver` |
| 10 | Tài liệu: `backend/README` §8, `docs/03` §7/§14/§19, `threat-model` T15, `docs/BACKLOG.md` (BL-023 413, BL-024 DBS-43: context worker, bindings, PII, `role` trong `both`, BL-025 PR/CI/Dev review/merge, BL-026 observability: lỗi nội bộ Nest/TypeORM chỉ còn `Diagnostic event`, `process.emitWarning`), feature doc §8/§9/checklist G4, `docs/features/README.md` | `check-doc-links.mjs` sạch; `git diff --stat 442e99b..HEAD` khớp kế hoạch này; bảng TC có độ sâu thật | `docs(logging): record the DBS-42 review fixes and handover` |

**Sweep (đã chạy):** DoD #1 nằm ở bước 3, 5, 7; DoD #2 ở bước 1, 2, 3; DoD #3 giữ nguyên TC-42-02 và không bị bước nào đổi; DoD #4 ở bước 10; DoD #5 là quy trình, BL-025. Phát hiện của rà soát: #1 bước 7, #2 bước 6 và 7, #3 bước 2, #4 bước 3, #5 bước 3 và 4, #6 bước 3, #7 bước 1, #8 đã xử lý ở G2, #9 bước 0 và 10, #10 bước 0. Giới hạn đã chấp nhận (binding của child logger, `PinoLogger`/`req.log` trực tiếp, `process.emitWarning`, tên khoá ngoài danh sách, PII ở consumer) có dòng trong bước 10. Không có file nào ngoài bảng này: nếu cần, dừng và hỏi (gate bổ sung).

**Rủi ro và cách lùi:** (a) thứ tự import của `process-logging.bootstrap` bị phá thì TC-22-25 đỏ ngay ở bước 7; (b) handler gọi `process.exit(1)`, nếu sai thì chỉ ảnh hưởng đường crash, lùi bằng revert commit bước 7; (c) `SafeLogger` và hook bọc try/catch có thể nuốt lỗi logger; giữ dòng `Log call failed` để không im lặng; (d) merge `main` kéo test DB mới, nếu baseline đỏ thì báo, không xây tiếp trên baseline đỏ. Lùi: revert từng commit của bước tương ứng, không đổi dữ liệu hay schema. Push thường (không `--force`) và chỉ sau G4.

### Kế hoạch gốc của bản đầu (đã thực hiện ở `32015c6`, giữ để đối chiếu)

| Bước | File / scope | Test viết trước và lệnh chứng minh |
|---|---|---|
| 1 | Thêm logging.options.spec.ts, logging.e2e-spec.ts; đổi test error-handling đòi log mật khẩu; thêm test retry an toàn | Chạy các spec này và giữ lỗi đỏ vì logger chưa có / filter còn log thô |
| 2 | package.json + lockfile; common/logging/logging.options.ts, logging.module.ts | npm install ba dependency đã nêu; unit options và HTTP e2e xanh |
| 3 | AppModule, main.ts; filter và TransactionService | Baseline unit/e2e/build, driver API/worker thật; không console.log runtime |
| 4 | test/support/logging-driver.ts, evidence UTF-8 | Chạy M-42-01…05, ghi output/số đếm thật; chụp từ kết quả thật nếu công cụ có sẵn |
| 5 | backend/README, docs/03 §7/14/19, threat-model T15, feature doc/index/BACKLOG | check-doc-links, diff scope, bảng TC và handoff đầy đủ |

Đã sweep các DoD và giới hạn: redaction key lẫn chuỗi log, HTTP ID, log level, both/worker, startup, process CI/review, DBS-43 ngoài scope đều có dòng thiết kế/test/plan. Nếu phát hiện thiếu quan trọng sẽ cập nhật plan và ghi quyết định theo ủy quyền tự triển khai của người dùng. Rollback: revert đúng commit task, không chạm dữ liệu DB hoặc thay đổi cũ ngoài task.

## 8. Kết quả

### Code và kiểm tra tự động

Commit cuối thay đổi code: **32015c609b1af8b06633fcb8fb44a949a7dd512b** (`feat(logging): add safe JSON application logging (DBS-42)`). Các commit sau chỉ hoàn tất docs/evidence.

| Kiểm tra | Kết quả đã chạy |
|---|---|
| npm run lint:check | Exit 0 |
| npm run typecheck | Exit 0 |
| npm run build | Exit 0 |
| npm test -- --runInBand | 26 suite / **385 test đạt**, 0 bỏ qua |
| npm run test:e2e -- --runInBand | 6 suite / **36 test đạt**, 0 bỏ qua |
| npm run test:db -- --runInBand | 5 suite / **91 test đạt**, 0 bỏ qua; Docker/PostgreSQL thật |

Red/green: spec logger đầu tiên lỗi vì thiếu dependency/module; test filter tái hiện raw credential trong stack; review regression tái hiện interpolation/toJSON/plain Error, rồi root envelope bị mất. Các lỗi đều được sửa và test xanh. Test bigint bootstrap của DBS-22 được cập nhật để nhận nạp AppModule động trong try/catch, vẫn kiểm bootstrap bigint chạy sau env và trước AppModule. Không xóa/skip test cũ để làm xanh.

| Case | Test hiện thực | Độ sâu |
|---|---|---|
| TC-42-01 | logging.options.spec.ts: required fields, worker/api/both mapping, child bindings, serialized root error envelope | Đạt |
| TC-42-02 | logging.options.spec.ts: 6 mức và invalid fallback | Đạt |
| TC-42-03 | logging.options.spec.ts: nested/array secrets, interpolation, serialization hooks | Đạt |
| TC-42-04 | logging.options.spec.ts: Error/cause, plain/nested/root error, allowlisted code | Đạt |
| TC-42-05/06 | logging.e2e-spec.ts: handler/completion IDs, client header không chọn ID, headers/query/body không có trong log | Đạt; HTTP thật trong harness không DB |
| TC-42-07 | logging.e2e-spec.ts + error-handling.e2e-spec.ts: 500/503 contract và không log dữ liệu lỗi thô | Đạt |
| TC-42-08 | transaction.service.spec.ts: retry 2 lần gọi, code 40P01, không có raw error text | Đạt; fake DB chỉ kiểm hành vi retry/log, không chứng minh khóa DB |
| TC-42-10 | logging.e2e-spec.ts: preflight, malformed JSON, oversized JSON đúng một completion record | Đạt; oversized giữ hành vi cũ 500, xem BL-019 |
| TC-42-11 | logging-bootstrap.e2e-spec.ts: subprocess API/worker cấu hình sai, role sai, DB không kết nối | Đạt; exit khác 0, JSON-only, không có synthetic secret |
| TC-42-09 | Dev review, CI, PR merge | **Chưa đạt**, xem BL-021 |

### Chạy runtime thực tế

Chạy từ backend:

```bash
node -r ts-node/register -r tsconfig-paths/register test/support/logging-driver.ts
```

[manual-test.txt](screenshots/DBS-42/manual-test.txt) là output UTF-8 thật sau commit code nêu trên, dòng đầu là SHA. Driver khởi động AppModule thật ở cổng tạm, lấy env ví dụ trong tiến trình, gọi HTTP thật và dừng đúng các process do nó tạo. PostgreSQL Compose được giữ nguyên; không dùng cloud credential. Driver kết thúc exit 0 với **80 assertion đạt**.

- **M-42-01:** API và both khởi động, `/health/ready` 200 trên PostgreSQL thật; UUID server khác client, xuất hiện trong JSON log; mọi dòng ứng dụng có trường chuẩn.
- **M-42-02:** request có synthetic header/query/body đến route không tồn tại trả 404; stdout ứng dụng không có fixture nhạy cảm, số tài khoản, URL hoặc body. Transcript chỉ hiển thị status/correlationId của problem response để không sao chép dữ liệu fixture từ detail.
- **M-42-03:** worker khởi động, không mở HTTP tại cổng được cấp, log role=worker và correlationId=null ngoài context.
- **M-42-04:** both có appRole=both và HTTP role=api. API LOG_LEVEL=error trả 200/404 đúng nhưng không phát info/warn. Hành vi error-level riêng được kiểm qua unit và subprocess/e2e.
- **M-42-05:** các test ở bảng TC thực sự chạy; không gọi harness lỗi là AppModule production có endpoint lỗi.

Ảnh dưới là ảnh chụp trình duyệt **hiển thị trích đoạn transcript đã chạy**, không phải ảnh terminal tương tác hoặc dữ liệu mô phỏng lại. Output đầy đủ và correlationId vẫn nằm ở manual-test.txt.

![API runtime transcript](screenshots/DBS-42/01-api-log-transcript.png)

![Worker runtime transcript](screenshots/DBS-42/02-worker-log-transcript.png)

### Giới hạn, quyết định và bàn giao

- Người dùng yêu cầu bỏ điểm chờ duyệt G1–G4 và tự triển khai; đã giữ thiết kế, independent AI review, TDD, test tự động và runtime. Đây không phải Dev review PR. Không tự push, mở PR, merge hay sửa board vì yêu cầu hiện tại là code local.
- **BL-019:** phát hiện filter hiện có trả 500 cho body vượt giới hạn, trong khi malformed JSON được Nest đổi thành 400. DBS-42 bảo toàn HTTP contract và chứng minh không lộ body trong log; việc chuẩn hóa 413 được tách riêng.
- **BL-020:** DBS-43 triển khai provider context chung, worker/message và role worker trong tiến trình both. HTTP logger dùng API công khai `PinoLogger.runInContext`; không import storage nội bộ thư viện. Gợi ý dùng cùng API làm adapter, nhưng thiết kế DBS-43 sẽ tự chốt.
- **BL-021:** cần PR, CI trên GitHub, review Dev khác và merge; chưa có URL/bằng chứng cho các bước này. Không kéo Done.
- `npm audit` báo 13 advisory trong dependency tree (7 moderate, 5 high, 1 critical); danh sách package advisory không có pino/nestjs-pino/pino-http. Không chạy audit fix làm đổi các dependency ngoài task.

## 9. Tài liệu đã cập nhật

- [backend/README](../../backend/README.md): quy ước JSON, trường log, mức log, dữ liệu không được ghi và giới hạn DBS-43.
- [docs/03](../03_HIGH_LEVEL_ARCHITECTURE.md) §7/14/19: logger hiện có, trường dữ liệu và safe error diagnostics.
- [threat model](../security/threat-model.md) T15: bằng chứng logger/HTTP/bootstrap, không tuyên bố phần Redis đã kiểm.
- [feature index](README.md), feature doc này và các evidence liên kết ở §1/§6/§8.
- [BACKLOG](../BACKLOG.md): thêm BL-019/020/021; không xóa backlog của task khác.
- Kiểm cuối: `check-doc-links.mjs` kiểm **91 file, 0 link hỏng**; `git diff --check` không lỗi khoảng trắng.

## Checklist G4

- [x] Test cases và bảng đối chiếu có độ sâu/giới hạn thật, TC quy trình còn thiếu ghi riêng.
- [x] Runtime chạy trên commit cuối đổi code; SHA ở đầu manual-test.txt; output đầy đủ.
- [x] Có ảnh chụp hiển thị output thật; transcript không có credential thật hoặc dữ liệu fixture nhạy cảm từ HTTP detail.
- [x] Diff khớp plan đã cập nhật; bootstrap/middleware, error sanitizer và wiring test được ghi trong §3/§7/§8 theo chỉ dẫn tự triển khai.
- [x] Baseline và test task đã chạy, có số đếm thật.
- [x] Docs có fact thay đổi đã cập nhật; trạng thái Implemented chỉ cho local, điểm chờ G4 được người dùng bỏ.
- [x] Bàn giao/DoD chưa đạt có BL-019/020/021; không xóa dòng chưa xử lý.
- [ ] Dev review, CI và merge main; chưa đủ điều kiện Done.
