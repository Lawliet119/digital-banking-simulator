# FRAUD-API-02 · Bộ đánh giá AI độc lập cho fraud

> **Status:** Plan approved — G3 đã duyệt, đang triển khai · **Vai:** #4 Fraud · **Nhánh:** `feat/FRAUD-API-02-standalone-risk` · **PR:** chưa tạo

## 1. Bối cảnh

Người yêu cầu làm **phần AI**, không nhận làm lại rules, database, audit, queue hoặc giao diện thuộc Dev. Mã `FRAUD-API-02` là mã nội bộ, không phải mã task trên sheet. Các bản phạm vi trước về bộ xử lý fraud đầy đủ đã bị rút lại; không dùng phê duyệt cũ cho phạm vi này.

Nguồn thiết kế: [ADR-14](../adr/0014-fraud-rules-external-ai.md), [FRAUD-API-01](FRAUD-API-01-external-ai-decision.md) và [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions). ADR-14 còn Proposed; việc code adapter độc lập không tự đổi trạng thái ADR hoặc chứng minh nhóm đã duyệt triển khai production.

### Phạm vi đề xuất

Một thư viện TypeScript và công cụ CLI thực sự chạy độc lập: nhận JSON feature đã tính sẵn → lọc và kiểm dữ liệu theo allowlist → gọi OpenAI Decisions `POST /v1/decisions` với predicate `needs_operator_review` → kiểm response → trả JSON gồm trạng thái và probability/provenance nếu có. Không train model. Người dùng gọi kết quả này là tín hiệu cần review, không phải kết luận chắc chắn có gian lận.

### DoD đề xuất

1. Dev có contract đầu vào feature và đầu ra kết quả có kiểu dữ liệu rõ ràng; chỉ feature allowlist ở ADR-14, không gửi ID, tên, email, free text, nhãn, scenario hoặc lịch sử thô. Không log secret, Authorization, payload hoặc response thô.
2. Gọi OpenAI thật bằng endpoint và định dạng request hiện hành; chỉ nhận answer đúng tên/type và probability hữu hạn trong `[0,1]`; thiếu/trùng/sai định dạng, refusal, timeout, lỗi kết nối và HTTP có trạng thái lỗi rõ. Không retry hoặc tự đổi nhà cung cấp trong một lần xử lý.
3. CLI chạy với JSON tổng hợp và credential cấp qua môi trường; có timeout hữu hạn, output máy đọc được. Không mặc định gọi provider khi chưa chủ động cấu hình; không dùng key đã lộ trong chat. Không lưu credential hoặc thêm `.gitignore`.
4. Có test hành vi cho allowlist, validate, thành công và lỗi/timeout; có manual run với provider thật trên dữ liệu tổng hợp nếu có credential hợp lệ. Thiếu credential thì báo chưa chạy, không lấy mock làm bằng chứng API thật.
5. Bàn giao contract cho Dev tích hợp, không tự nhận rules, quyết định tạo cờ, scoring tổng, persistence, audit, queue, auth hay UI đã làm. Việc gửi dữ liệu giao dịch thực và bật production còn phụ thuộc quyền dữ liệu, Ops và quyết định nhóm.
6. Review độc lập, baseline và manual test đúng quy trình; commit và tạo PR sau các gate, không tự merge hoặc sửa board.

### Hiện trạng và dependency

- Nhánh local được tạo từ `origin/main` tại `ab53152`; `backend/src/modules/risk/` lúc kiểm tra chỉ có README, chưa có adapter AI.
- Guide provider đã đọc trực tiếp: `gpt-6-luna`, predicate, JSON input; chưa có request API thành công trong task.
- `OPENAI_API_KEY` chưa có trong process environment khi kiểm tra. Key từng xuất hiện trong chat đã lộ, cần thu hồi và dùng key mới qua kênh an toàn; không yêu cầu dán vào chat.
- Handoff của Dev: thống nhất tên/type feature và cách sử dụng status; adapter không phụ thuộc AuditService để chạy độc lập. Chưa có bằng chứng Dev đã chấp thuận contract cuối.
- Trước thay đổi phạm vi: `lint:check`, `typecheck` thành công; 30 unit suites/495 tests, 8 e2e suites/57 tests, 8 DB suites/154 tests đạt trên môi trường cô lập. Lần chạy e2e đầu lỗi kết nối vì cổng local đã dùng; ghi nhận riêng, không sửa test để che lỗi.
- BL-040/042–044/050 vẫn liên quan quyết định nhóm, bàn giao contract, provider và đánh giá; không tự nhận đã đóng. Không đọc generator hoặc holdout trong `load-tests/fraud-dataset/`.

### Ngoài phạm vi

Không triển khai hoặc thay thế R1–R6, feature extraction, đánh giá score tổng, migration, bảng fraud, audit, queue, API/UI operator, auth hoặc ledger. Không tuyên bố đã có tích hợp fraud end-to-end, benchmark chất lượng hoặc đã giải quyết các task ONNX trên sheet. Không thay event contract hoặc schema DB của người khác.

### Quyết định G1

Người dùng trả lời “duyệt” ngay sau G1 AI-only: chỉ adapter OpenAI, input/output feature, kiểm thử và CLI; Dev sở hữu rules, scoring, feature extraction, DB, audit, queue và UI. Không đổi trạng thái ADR-14 hay tuyên bố Dev đã xác nhận contract. Không miễn test live, không dùng key đã lộ.

## 2. Hành vi

### 2.1 Input feature — dữ liệu tổng hợp dùng khi thử nghiệm

Caller cấp một object JSON; adapter không đọc event, DB hay history. Contract đề xuất, cần Dev nhận xác nhận:

```json
{"amount":"20000000","fromBalanceBefore":"22000000","accountAgeHours":3,"sameOwner":false,"txCount10m":2,"txCount1h":3,"historyCount30d":6,"medianAmount30d":"5000000.5","minutesSinceReverse":null,"newRecipients1h":2,"distinctRecipients24h":3}
```

Tiền canonical biểu diễn string; `amount` nguyên dương và `fromBalanceBefore` nguyên có dấu theo `@common/money`. Median nullable khi không có lịch sử, là chuỗi decimal chính xác tối đa một chữ số `.5`, không dùng JS float. Count là số nguyên an toàn không âm, tuổi/minutes là số hữu hạn không âm, reverse nullable, `sameOwner` boolean. Thiếu/sai type, NaN, âm, chuỗi tiền sai hoặc extra fields → từ chối trước network, không echo giá trị. Null median và số lịch sử được kiểm tra nhất quán; chốt semantics với Dev ở handoff.

### 2.2 Kết quả và lỗi

| Điều kiện | Kết quả adapter | Mạng |
|---|---|---|
| Feature hoặc config sai | `CONFIG_INVALID`, probability null | Không gọi |
| Chưa cấu hình key hoặc chưa bật | `DISABLED`, probability null | Không gọi |
| Một predicate `needs_operator_review`, p hữu hạn `[0,1]` | `SUCCEEDED`, probability=p; requested model, response model/request id nullable | Một request |
| Answer refusal đúng tên | `REFUSED`, probability null | Một request |
| JSON sai, thiếu/trùng answer, type sai hoặc p ngoài miền | `INVALID_RESPONSE`, probability null | Một request |
| Abort/timeout, lỗi mạng, HTTP 401/402/429/5xx | `UNAVAILABLE`, probability null | Tối đa một request |
| Budget không cho phép | `BUDGET_EXHAUSTED`, probability null | Không gọi |
| Quá admission hoặc không có slot | `UNAVAILABLE`, probability null | Không gọi |

Không tự gọi fallback provider, không retry, không quyết định cờ hay tính tổng. Caller quyết định baseline và phải kiểm status; `probability` không là độ chính xác hoặc gian lận chắc chắn. Model có thể đổi; chỉ ghi response model nếu provider trả. Không lưu raw response. CLI không bật network nếu không được gọi có chủ đích; input không tự ý gửi data thật khi chưa có quyền.

### 2.3 Ví dụ response

```json
{"status":"SUCCEEDED","probability":0.82,"provider":"openai","requestedModel":"gpt-6-luna","responseModel":null,"requestId":null,"rubricSha256":"<sha256-rubric>","inputSha256":"<sha256-allowlist>"}
```

Hash là sha256 hex từ UTF-8 rubric cố định và JSON canonical của allowlist; không hash raw input có field bị cấm. Đây là ví dụ hình dạng, không phải response live hoặc giá trị thực.

**Rubric v1** (nội dung literal, không bao gồm dấu backtick, hash đúng UTF-8):

`Given only the supplied numeric transaction features, is this completed transfer sufficiently unusual to warrant an operator review? Consider legitimate patterns, including transfers between accounts of the same owner. Do not infer missing facts, claim fraud, or decide whether to block a transfer.`

**Kiểu trả về:** mọi status có `probability: number | null`, `provider: 'openai' | null`, `requestedModel: string | null`, `responseModel: string | null`, `requestId: string | null`, `rubricSha256: string | null`, `inputSha256: string | null`, `usage: {inputTokens:number,cachedTokens:number,cacheWriteTokens:number} | null`. Chỉ `SUCCEEDED` có probability hữu hạn; các status khác null. `DISABLED` và `CONFIG_INVALID` không hứa provenance đầy đủ. Với AI mode hợp lệ, dù timeout/refusal/invalid/budget, giữ provider/requestedModel và hai hash; model thực tế/request ID/usage chỉ khi response/header cung cấp hợp lệ, không bịa. Usage chỉ nhận số nguyên an toàn không âm; không hợp lệ → null. Timeout không đồng nghĩa chi phí bằng 0.

Canonical JSON là `JSON.stringify` object mới theo thứ tự đúng §2.1; input cho phép số hữu hạn, không chứa nested object. Hash UTF-8 JSON đó, dùng cùng object trong `input_json`. Với `enabled=true` nhưng thiếu key, adapter trả `DISABLED`; **caller không được ghi DISABLED vào AI mode**: phải từ chối cấu hình hoặc ánh xạ theo contract được Dev chấp thuận trước tích hợp. Rule-only không gọi adapter.

## 3. Kiến trúc và contract

- `backend/src/modules/risk/ai/`: type feature/result, projection/validation, rubric version/hash và `OpenAiDecisionsAdapter`; CLI ở `backend/src/scripts/`. Không đăng ký HTTP controller/worker, không sửa module của Dev; contract export cho Dev thống nhất ở integration task.
- API dự kiến: `assess(features: unknown, options: DecisionOptions): Promise<AiAssessment>`, options có `enabled`, `apiKey`, `model`, `requestTimeoutMs`, `maxAdmissionDelayMs`, `selectedAtMonotonicMs` và `tryAcquire(): PermitResult`. `PermitResult` là `{kind:'granted',release:()=>void}` hoặc `{kind:'budget_exhausted'}` hoặc `{kind:'unavailable'}`; acquisition không chờ vô hạn. Budget denied → BUDGET_EXHAUSTED; unavailable hoặc hết admission → UNAVAILABLE. Adapter kiểm `performance.now()-selectedAtMonotonicMs` ngay trước gửi; release đúng một lần trong `finally`, kể cả lỗi/abort. Caller cung cấp slot/budget thực; CLI chỉ cấp một permit cho đúng một process/request, không nhận là quota toàn hệ thống. `apiKey` không vào exception/log/result.
- Dùng Node 24+ `fetch`, không thêm SDK dependency; production factory cố định `https://api.openai.com/v1/decisions`, không cho caller/CLI đặt endpoint, redirect bị từ chối. Nội bộ có transport factory nhận URL loopback cho test/manual fixture để chứng minh HTTP thực; không export factory đó như public integration API. Hủy sau deadline dương hữu hạn; không hứa abort dừng billing bên provider.
- Body `model`, `input` user `input_json` chỉ gồm object projection, `questions` duy nhất `{type:'predicate',name:'needs_operator_review',instructions:<rubric>}`. Có giới hạn byte response trước JSON parse; lọc lỗi trước log, không trả thông điệp provider.
- CLI đọc input từ stdin, không từ command-line argument; cấu hình secret qua `OPENAI_API_KEY` do CLI đọc, không echo. Đây là **env cho CLI**, không thêm env bắt buộc vào app config chung. Thiếu key: DISABLED, không network. `--live` là thao tác chủ động; chỉ dùng synthetic và số request có giới hạn.
- Cấu hình riêng CLI thử synthetic, không phải default production: model `gpt-6-luna`, `requestTimeoutMs=10000`, `maxAdmissionDelayMs=1000`, cap response `65536` bytes. CLI capture `performance.now()` ngay khi snapshot options trước admission. Adapter timeout bao trùm cả đọc stream body, không chỉ nhận headers; cap được áp khi đọc từng chunk, vượt cap hủy. Loopback fixture dùng `requestTimeoutMs=200` và `maxAdmissionDelayMs=1000`; M-AI-04 đo thời gian từ request đến kết quả `UNAVAILABLE` ≤ 2000ms, có allowance scheduler, kiểm một request và permit release. Ops phải duyệt riêng các giá trị production.
- Adapter không truy cập DB, không giữ transaction, không xác nhận dedup/budget shared. Caller integration chịu trách nhiệm chọn config, dedup, concurrency/budget, audit và policy rules; chưa tồn tại implementation để tuyên bố end-to-end.

## 4. Test cases tự động

| ID | DoD | Given → When → Then |
|---|---|---|
| TC-AI-01 | 1 | Feature hợp lệ, thêm ID/email/extra → bị từ chối trước network; request đúng chỉ chứa allowlist |
| TC-AI-02 | 1 | Tiền trên 2^53, median nửa đồng, null reverse, NaN/âm/sai canonical → giá trị hợp lệ giữ chính xác; input sai bị từ chối |
| TC-AI-03 | 2 | Local HTTP fixture trả predicate hợp lệ p=0/1 → SUCCEEDED; thiếu/trùng/sai name/type, NaN/out-of-range/refusal → trạng thái đúng |
| TC-AI-04 | 2 | 401/402/429/5xx, network và response quá lớn → trạng thái fail-safe, không retry, không lộ key/body |
| TC-AI-05 | 2–3 | Server chậm → deadline hủy, slot được nhả; hết admission/budget hoặc disabled → không có request |
| TC-AI-06 | 3–4 | CLI stdin synthetic, disabled và lỗi input → JSON status/exit code xác định, không log secret; không gọi OpenAI trong CI |
| TC-AI-07 | 4 | Live OpenAI với key mới và synthetic → SUCCEEDED, p hữu hạn và predicate đúng tên; thiếu key ghi chưa chạy, không coi HTTP fixture là live |
| TC-AI-08 | 5 | Contract type/provenance và caller handoff; kiểm không tạo rules/DB/queue/UI; xác nhận Dev là bước quy trình, không giả xác nhận |
| TC-AI-10 | 1–2 | Hash/provenance nhất quán cho input canonical, failure mode nullability đúng; usage an toàn giữ nếu provider trả, invalid usage → null |
| TC-AI-09 | 6 | Domain review, manual và PR/CI/Dev review: quy trình, không thay test runtime |

Test local dùng server loopback có thể kiểm body/status/deadline; server giả chỉ kiểm transport, không chứng minh chất lượng AI hoặc API thật.

## 5. Test thủ công

CLI `backend/src/scripts/fraud-ai-evaluate.ts`, fixture `backend/test/manual/fraud-ai-fixture.ts`. Chạy từ `backend/`; `SAMPLE` là JSON synthetic:

```bash
SAMPLE='{"amount":"20000000","fromBalanceBefore":"22000000","accountAgeHours":3,"sameOwner":false,"txCount10m":2,"txCount1h":3,"historyCount30d":6,"medianAmount30d":"5000000.5","minutesSinceReverse":null,"newRecipients1h":2,"distinctRecipients24h":3}'
printf '%s' "$SAMPLE" | npx ts-node -r tsconfig-paths/register src/scripts/fraud-ai-evaluate.ts
printf '%s' '{"amount":"01","id":"secret"}' | npx ts-node -r tsconfig-paths/register src/scripts/fraud-ai-evaluate.ts
printf '%s' "$SAMPLE" | npx ts-node -r tsconfig-paths/register src/scripts/fraud-ai-evaluate.ts --live
printf '%s' "$SAMPLE" | npx ts-node -r tsconfig-paths/register test/manual/fraud-ai-fixture.ts --timeout
```

| Bước | Kỳ vọng |
|---|---|
| M-AI-01 | Lệnh 1: DISABLED, exit 0, không gọi network |
| M-AI-02 | Lệnh 2: CONFIG_INVALID, exit 2, không echo input, không network |
| M-AI-03 | Lệnh 3, key mới được cấp sẵn qua `OPENAI_API_KEY`, một request: **SUCCEEDED**, p hữu hạn trong `[0,1]`, exit 0. Refusal/error không phải thành công; không chạy lại để che lỗi. Thiếu key: chưa chạy live |
| M-AI-04 | Lệnh 4: fixture loopback thật cố tình không trả, adapter UNAVAILABLE với deadline 200ms và kết thúc ≤2000ms, đúng một request, permit đã nhả, exit 0 |

`--live` gặp lỗi provider trả JSON status an toàn exit 1; giới hạn một request/process, không retry. Manual lưu output đã lọc, không key/header/body provider. Fixture chỉ kiểm transport, không phải bằng chứng live; kết quả thực tế ở §8.

## 6. Domain review

Vòng 1: reviewer `openai-codex/gpt-6.1-sol`, **3 blocking, 3 should-fix, 1 minor**, [nguyên văn](screenshots/FRAUD-API-02/domain-review-round-1.md), `REVISE`. Đã bổ sung transport loopback, admission/permit, lệnh manual, union/provenance, rubric và usage. Vòng 2: **0 blocking, 1 should-fix, 1 minor**, [nguyên văn](screenshots/FRAUD-API-02/domain-review-round-2.md), `REVISE`; đã bổ sung CLI config synthetic, response cap và timeout body. Vòng cuối: **0 blocking, 0 should-fix, 2 minor chỉ ghi giới hạn/phụ thuộc**, [nguyên văn](screenshots/FRAUD-API-02/domain-review.md), `Verdict: APPROVE`. Đây là review thiết kế, không phải test runtime, live provider, xác nhận contract Dev hoặc chấp thuận ADR.

**Quyết định G2:** người dùng trả lời “duyệt” sau thông điệp G2; thiết kế adapter AI-only ở §§2–5 được duyệt. Không hiểu đó là chấp thuận Dev contract, ADR-14 hay bằng chứng gọi API thật.

## 7. Kế hoạch triển khai

### 7.1 Các bước và phạm vi file

Quy tắc: viết test có ý nghĩa trước mỗi hành vi, chạy đỏ đúng lý do rồi code; không ghim source text/wiring hoặc mock echo. Không code production trước G3. Các commit dưới đây là commit **code/test**, không tạo PR chỉ chứa docs. `src/modules/risk/ai/` là phần AI thuộc task này, không thêm RiskModule/consumer/DB.

| Bước | File dự kiến | Test trước và đỏ dự kiến | Kiểm chứng | Commit |
|---|---|---|---|---|
| P1 Contract và projection | `backend/src/modules/risk/ai/ai-contract.ts`, `feature-projection.ts`, `feature-projection.spec.ts` | TC-AI-01/02/10: invalid/PII không network, bigint và median giữ nguyên, hash ổn định; đỏ vì module chưa tồn tại | `npm test -- --runInBand src/modules/risk/ai/feature-projection.spec.ts` | `feat(risk): validate AI feature projection` |
| P2 HTTP và kết quả | `backend/src/modules/risk/ai/openai-decisions.ts`, `openai-decisions.spec.ts`, `rubric.ts` | TC-AI-03/04/05/10: loopback thực trả p/refusal/error, timeout cả body, quota/admission/release, không leak; đỏ vì adapter chưa tồn tại | `npm test -- --runInBand src/modules/risk/ai/openai-decisions.spec.ts` | `feat(risk): assess features with OpenAI Decisions` |
| P3 CLI và manual fixture | `backend/src/scripts/fraud-ai-evaluate.ts`, `backend/test/manual/fraud-ai-fixture.ts`, `backend/test/fraud-ai-cli.e2e-spec.ts` | TC-AI-06: subprocess stdin, exit/status disabled/input sai; đỏ vì CLI chưa tồn tại. M-AI-01–04 chạy sau code; fixture loopback không là provider live | `npm run test:e2e -- --runInBand test/fraud-ai-cli.e2e-spec.ts` và lệnh §5 | `feat(risk): add standalone AI evaluation CLI` |
| P4 Bàn giao và xác minh | `backend/src/modules/risk/README.md`, `backend/src/scripts/README.md`, `docs/features/FRAUD-API-02-standalone-risk.md`, `docs/features/README.md`, `docs/BACKLOG.md`, `docs/features/screenshots/FRAUD-API-02/` | TC-AI-07/08/09: live thật chỉ khi có key; handoff/PR/CI theo quy trình, không nhận mock là live hoặc Dev đã xác nhận | Baseline lint/typecheck/unit/e2e/db; link checker trên snapshot sạch; manual §5; reviewer code độc lập | `docs(risk): document AI adapter handoff` |

Đường dẫn tests, cách gọi runner chính xác được xác nhận khi viết test; không rút gọn case. Các thay đổi env/dependency: CLI đọc `OPENAI_API_KEY` khi chạy, **không** thêm env bắt buộc vào app/Joi; Node fetch có sẵn, không thêm dependency hoặc sửa lockfile. Nếu phát sinh cần sửa env/dependency/scope, dừng gate phụ thay vì làm ngầm.

### 7.2 Sweep DoD và giới hạn

| Mục | Kế hoạch và bằng chứng |
|---|---|
| DoD 1: input/output, PII | P1 + P2; test feature bị cấm không đi network, lỗi không echo; không gửi dữ liệu thật nếu chưa được phép |
| DoD 2: provider và failure | P2; HTTP loopback thật kiểm request/response/refusal/streaming/timeout/release, không gọi fake là OpenAI thật |
| DoD 3: CLI | P3; no `--live` không network, `--live` tối đa một request; key qua môi trường không vào command/log |
| DoD 4: test/live | P1–P4; M-AI-03 cần key mới và quota, thiếu thì **chưa chạy**; không coi CI xanh là live API thành công |
| DoD 5: handoff | P4 cập nhật contract và BL-042/043/044/050 theo tình trạng thật; không xóa backlog hoặc nhận Dev đã xác nhận |
| DoD 6: review/PR | P4 review độc lập và kiểm chứng; G4 trước PR ready, không tự merge hoặc sửa board |
| ADR-14 / scope | Giữ Proposed, không tự đổi ADR-08; không code rules/feature extraction/scoring/database/audit/queue/UI hoặc sửa event contract |
| Failure boundaries | `DISABLED`/`CONFIG_INVALID` không lộ provenance thiếu; caller không được ghi DISABLED vào AI mode; HTTP timeout không chứng minh không bị tính phí |
| Resource limits | Timeout gồm stream body, cap 65536, admission monotonic, permit release `finally`, redirect từ chối; test thực qua loopback |
| Dữ liệu | Chỉ synthetic cho live; không đọc generator/holdout, không seed số dư/ledger, không đưa secrets/private files vào repo |

### 7.3 Rollback và phụ thuộc

Không migration, không thay producer hay tiền. Rollback code bằng revert commit/PR theo quy trình; không sửa DB hoặc cloud. Runtime hiện chưa gọi adapter nên không nhận hệ thống đã dùng AI. Dev owner cần xác nhận feature/status trước integration; Ops duyệt quota, dữ liệu/retention và cấu hình production. Nếu credential mới không tồn tại, manual live success không chạy và phải nêu tại G4; không thay bằng fixture. Không tự ghi key trong repo, output thô hoặc PR.

### 7.4 Review kế hoạch

Sweep nội bộ: cả 6 DoD, 10 TC và 4 manual case đều có bước hoặc được ghi là quy trình/điều kiện live tại §§7.1–7.2; các thay đổi dùng chung, Redis/DB/audit/queue/UI, production và data holdout đều ngoài phạm vi. Đã rà các failure boundary, file dự kiến, rollback, key mới và handoff. Rủi ro còn lại: Dev chưa xác nhận contract, chưa có live key/quota; test loopback không chứng minh OpenAI thành công. Không có plan review độc lập được thực hiện; domain review G2 đã APPROVE.

**Quyết định G3:** người dùng trả lời “duỵeet” ngay sau thông điệp G3; duyệt kế hoạch P1–P4. Quyền tạo PR đã được yêu cầu, G4 vẫn cần duyệt bàn giao trước PR ready. Không coi việc duyệt là bằng chứng live hoặc cho phép dùng key lộ.

## 8. Kết quả và bàn giao

Đã viết adapter TypeScript, validation/projection và CLI AI-only; chưa nối RiskModule/consumer hoặc Dev. OpenAI live đã thành công trên input synthetic như ghi ở §8. Không sửa rules, schema, audit, queue hoặc UI. Test trước implementation: projection đỏ do thiếu module, HTTP đỏ do thiếu adapter, CLI đỏ do thiếu entrypoint; sau implementation các suite mục tiêu đều xanh.

### 8.1 Kiểm chứng và review

| Kiểm chứng | Quan sát |
|---|---|
| Full suite | `lint:check`, `typecheck`, `build` exit 0; unit 32 suites/609 tests; e2e 9 suites/64 tests; DB 8 suites/154 tests; 0 skip ghi nhận trong output |
| Tài liệu | Link checker trên snapshot sạch gồm tài liệu task: 135 file, 0 link lỗi |
| Projection | 15 test pass, bao gồm tiền trên 2^53, median nửa đồng, sai canonical và field thừa |
| HTTP adapter | 99 test pass: predicate/refusal, status/error, timeout headers/body, cap byte, no retry, permit release, admission và provenance |
| CLI | 7 test pass với subprocess thật, stdin và network bị cấm: disabled, invalid và không lộ input/key |
| Smoke CLI | Input synthetic, không `--live` → `DISABLED`, probability null; không cần key |
| Smoke timeout | HTTP loopback flush headers rồi treo: `UNAVAILABLE`, khoảng 209ms, một request, một permit/release |
| Review code correctness | Reviewer phát hiện deadline vượt 2^31−1 làm Node đặt 1ms; test tái hiện đỏ, thêm validate trước permit/network, suite HTTP xanh; review lại không có phát hiện cụ thể |
| Review security | Reviewer phát hiện key có whitespace có thể lọt redaction do Fetch chuẩn hóa; test tái hiện đỏ, từ chối key có whitespace, suite HTTP xanh. Trước đó cũng có test đỏ/sửa metadata phản chiếu key; review lại không có phát hiện cụ thể |
| OpenAI live | Ban đầu CLI trả `UNAVAILABLE`, request chẩn đoán nhận HTTP 429 `insufficient_quota` / `credit_balance_exhausted`. Sau khi quota được xử lý, CLI nhận `SUCCEEDED`, p=0,76, model `gpt-6-luna`, exit 0 trên input synthetic; lặp lại thành công trên commit code `c5473a9`. Không suy ra chất lượng phát hiện gian lận |

### 8.2 Đối chiếu và bàn giao

| Case | Trạng thái |
|---|---|
| TC-AI-01/02/03/04/05/06/10 | Đạt trong test adapter/CLI cục bộ; test HTTP dùng server loopback, không phải OpenAI |
| TC-AI-07 / M-AI-03 | Đạt: OpenAI thật trả `SUCCEEDED`, p=0,76 trong [0,1], exit 0; raw output trong manual-test.txt. BL-043 vẫn mở cho quyết định quota/budget vận hành |
| TC-AI-08 | Contract có trong code/docs; Dev chưa xác nhận, còn BL-042/050/053; chưa tích hợp |
| TC-AI-09 | Review AI đã thực hiện; Dev review và CI remote còn chờ |
| M-AI-01 | Đạt: CLI synthetic mặc định DISABLED |
| M-AI-02 | Đạt khi chạy lệnh stdin input sai: `CONFIG_INVALID`, exit 2, không echo input |
| M-AI-04 | Đạt: loopback timeout, 207,8ms, 1 request, 1 permit/release, exit 0 |

Manual M-AI-01–04 chạy trên commit code `c5473a9`: [raw output](screenshots/FRAUD-API-02/manual-test.txt), [ảnh terminal hiển thị output đã ghi](screenshots/FRAUD-API-02/01-manual-terminal.png). Đã loại key khỏi evidence. Không có bằng chứng đánh giá recall, latency production, chi phí production, ADR Accepted hoặc fraud end-to-end.

## 9. Tài liệu đã cập nhật

- `backend/src/modules/risk/README.md`: ranh giới adapter AI độc lập, không nhận đã tích hợp.
- `backend/src/scripts/README.md`: CLI, opt-in live và xử lý credential.
- `docs/features/README.md`: index task AI-only.
- Feature doc này, ba review thiết kế, raw output và ảnh manual; thêm BL-053 cho việc tích hợp, các BL-042/043/044/050 vẫn mở.
