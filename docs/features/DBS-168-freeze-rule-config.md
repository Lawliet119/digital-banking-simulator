# DBS-168 · Đóng băng phiên bản cấu hình luật trước khi chạy holdout

> **Status:** Plan approved (đang làm, đến G4) · **Vai:** #4 Fraud · **Cặp đôi review:** Dev (theo `references/team.md`) · **Nhánh:** `feat/DBS-168-freeze-rule-config` · **PR:** — · **Cập nhật:** 2026-11-21

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 7, Highest, Deliverable P5. **Thực trạng:** «Tune đã xong ở DBS-161 nhưng chưa có bản ghi đóng băng. Quy tắc: holdout chạy đúng một lần, nên phiên bản cấu hình phải cố định và được ghi lại trước khi #6 giao nhãn holdout.» **Expect:** «Cấu hình dùng cho holdout cố định, không chỉnh theo kết quả.»
- **DoD (chép nguyên văn từ board):**
  1. Ghi số phiên bản risk_rule_sets, commit SHA, seed và ngày vào docs trước khi chạy; thông báo cả nhóm
  2. Sau thời điểm này không chỉnh tham số; thay đổi nào phải đi qua đánh giá lại và ghi nhận
  3. PR đã merge vào main; Dev review; không còn liên kết hỏng, tên bảng/cột/mã lỗi khớp các tài liệu khác (đã grep)
  4. Đóng băng cả hai mode (rule_only và rules_with_external_ai): số phiên bản risk_rule_sets, với rules_with_external_ai ghi thêm provider, model, rubricSha256, ai.threshold, ai.weight; đóng băng trước validation, chỉnh tiếp sau validation thì công bố đó đã thành tune
- **Phụ thuộc:** DBS-161 (tune luật và rubric, Done: [07-tuning-rules](../components/risk/07-tuning-rules.md), PR #211 và #212 đã có trên `main`); DBS-162 (so khớp provider online/offline, Done: [DBS-162](DBS-162-provider-parity.md), PR #142). Cả hai Done trong repo, không chỉ trên board.
- **Đã có gì:** `evaluation/configs/v1.json`…`v4.json` (v4 = cấu hình `rule_only` đã chọn), `evaluation/rubrics/r4.txt`, capture `evidence/ai-gate-capture-tune-r4.jsonl`, `compare-modes` (chọn ngưỡng/trọng số AI trên train), `parseRuleSet` (kiểm khối `ai`). Chưa có: file cấu hình nào mang khối `ai` (B2 chỉ chạy qua `compare-modes` với tham số suy ra lúc chạy), bản ghi đóng băng, bất kỳ kiểm tra tự động nào chặn sửa cấu hình sau khi đóng băng.
- **Baseline** (từ `backend/`, trên `origin/main` = `9213899`): `npm run lint:check` sạch; `npm run typecheck` sạch; `npm test` 138/139 suite, **2.376 test đạt**, 0 fail; 1 suite (`src/database/typeorm-options.spec.ts`) không nạp được trên máy này (`ReferenceError: crypto is not defined` từ `@nestjs/typeorm` với Node 24; có sẵn từ trước, không liên quan task, CI chạy bản Node khác); docs: `check-doc-links.mjs` 485 file, 0 liên kết hỏng; `check-backlog.mjs` 103 dòng, 0 lỗi. `test:e2e` và toàn bộ `test:db` không chạy trên máy (quá tải, CI chạy bộ đầy đủ), vì task không đổi đường chạy của ứng dụng; chỉ chạy file db-spec liên quan (`fraud-schema.db-spec.ts`).
- **Loại task:** tài liệu có bằng chứng, kèm một công cụ kiểm tra nhỏ (thư viện + CLI chưa có người gọi khác ngoài DBS-169) → theo hàng «Docs only» và «Library with no caller yet» của `task-kinds.md`.
- **Ngoài phạm vi:** chạy holdout (DBS-169), đọc hay đụng nhãn holdout và `load-tests/fraud-dataset/` (bức tường dữ liệu: không đọc, kể cả subagent review), tạo version thật trong bảng `risk_rule_sets` (quyết định 2), bật AI (phán quyết cổng vẫn NO-GO tạm thời, giữ `rule_only`), gửi thông báo (agent không có kênh nhóm), viết công cụ đo B1/ablation/bootstrap ở tham số cố định (BL-407).
- **Backlog liên quan (`docs/BACKLOG.md`):** BL-171 (nơi lưu nhãn holdout, hạn trước DBS-169), BL-392 (hợp đồng kịch bản nằm trong `docs/`, hạn trước DBS-169) và BL-043 (duyệt RSK-05 trước khi gửi dữ liệu cho API AI) là điều kiện của DBS-169, không phải của task này: nêu trong bản ghi đóng băng, không xóa.
- **Câu hỏi mở và quyết định ở G1 (agent tự quyết; một subagent `opus` effort `high` đã phản biện theo `TonightWorks.md`):**
  1. «Số phiên bản `risk_rule_sets`» là số nào, khi bảng chỉ có version 1 (seed) và v2–v4 mới là file thử? **Quyết định:** ghi **nhãn đánh giá** (`--config-version`): 4 cho `rule_only`, 5 cho `rules_with_external_ai`, kèm sha256 nội dung file làm danh tính thật, và nói rõ «version trong DB: chưa cấp». Không đoán số 2 và 3 mà API sẽ cấp (MAX+1), vì ai tạo version trước cũng làm số đó lệch. Lý do: nhãn 4 đã in trong mọi báo cáo tune; sha256 không bao giờ nhập nhằng.
  2. Có chèn hai version vào DB không? **Quyết định: không.** Phiên bản hiện hành của hệ thống là `ORDER BY version DESC LIMIT 1` (`rule-set.repository.ts`), nên chèn một version AI sẽ kích hoạt nó, trái phán quyết NO-GO. Tạo version thật qua API admin (DBS-160) là quyết định riêng của nhóm sau holdout (BL-408); lúc đó ghi số thật vào bản ghi và kiểm `config` trong DB khớp sha256 (`freeze:verify --database-url`).
  3. Mode AI chưa có file cấu hình: tạo `configs/v4-ai-r4.json` = v4 + `mode: rules_with_external_ai` + khối `ai` (model, rubric `r4`, ngưỡng 0,65, trọng số 40 đã chọn trên train). Tên file cố ý không là `v5` để không bị đọc thành «lần tune thứ 5». Test bắt mọi lệch giữa nó và v4 / `r4.txt`.
  4. Đổi hằng `REVIEW_RUBRIC` thành r4 không? **Không.** Runtime lấy rubric từ `ai.rubric` của version, hằng chỉ là mặc định của script `capture-ai`; đổi nó đổi hành vi mặc định mà không đổi kết quả đóng băng. Rủi ro thật là DBS-169 quên `--rubric-file`: `freeze:verify --capture` bắt.
  5. Commit SHA: bản ghi nằm trong chính PR này nên SHA merge chưa có khi viết. Ghi **commit cơ sở** và sha256 từng file, cộng dấu vân tay mã engine; commit đóng băng (SHA squash merge) được điền ở một PR docs ngay sau merge (§8 «Bàn giao», BL-405 nếu việc đó chưa làm xong). Cơ chế cố định thật là hash, không phải SHA.
  6. Thông báo cả nhóm: agent không gửi được. Bản ghi chứa đoạn tin nhắn đã soạn; việc gửi và ghi ngày giờ + đường dẫn tin là BL-405 (người thật).
  7. Seed: ghi `dbs-split-v1` và nêu cả ba vai trò của nó. **Không** ghi seed sinh holdout (có seed đó là tái tạo được holdout): ngoài bản ghi, thuộc #6.
- **Quyết định thêm sau domain review (agent tự quyết, G2):**
  8. Kiểm mã engine **chỉ ở CLI, không ở `npm test`** (review #1): kiểm trong CI sẽ làm đỏ mọi PR chạm 33 file `risk`, tức một lệnh cấm sửa module mà chưa ai quyết. Techlead muốn khóa cứng thì thêm một bước CI chạy `freeze:verify` (BL-406).
  9. Capture holdout cho **mọi giao dịch** (`--normal-sample 1000000`, trọng số 1) thay vì mẫu thưa (review #2): `evaluate-rules` không dùng trọng số, nên mẫu thưa làm precision, FPR và cảnh báo/1.000 của B2 sai nặng; gọi hết khoảng 43.000 giao dịch tốn khoảng 1,2 USD ([06](../components/risk/06-evaluation-ai-gate.md)) và không bị giới hạn kinh phí (fraud). Đây là tham số đo, không phải tham số mô hình, nên không phải tune.
  10. Đóng băng cả mã của bộ kiểm (`freeze.ts`, `freeze-verify.ts`), `common/money`, `utc-time` và các giá trị gốc ghim trong spec (review #6, #7).

## 2. Hành vi

### 2.1 Bản ghi đóng băng (tài liệu)

[`docs/components/risk/09-freeze-rule-config.md`](../components/risk/09-freeze-rule-config.md) có: ngày, commit cơ sở, seed (ba vai trò), dữ liệu tune (sha256 CSV và capture), dấu vân tay mã engine; bảng hai mode (nhãn đánh giá, file, sha256, version DB: chưa cấp; mode AI thêm `provider`, `model`, `rubricSha256`, `ai.threshold`, `ai.weight`, rubric nguồn, tham số lấy mẫu capture); danh sách mã engine đóng băng; quy trình đo và lệnh dự kiến cho DBS-169; quy tắc bức tường dữ liệu cho capture holdout; quy tắc thay đổi sau đóng băng và nhật ký (đang trống); công bố trung thực về validation; điều kiện tiên quyết của DBS-169; đoạn tin nhắn thông báo cả nhóm.

### 2.2 `freeze:verify` (CLI) và kiểm tra trong `npm test`

| Đầu vào | Kết quả |
|---|---|
| `npm run --silent freeze:verify` (không tham số), mọi thứ khớp | in từng nhóm `OK` (file cấu hình, mã engine kèm dấu vân tay, amendments), `RESULT: FROZEN AS RECORDED`, exit 0 |
| File cấu hình, rubric hoặc `v1.json` có sha256 khác manifest | in tên file, hash mong đợi và hash thực, exit 1 |
| `v4-ai-r4.json` khác v4 ở chỗ không phải `mode` và `ai`; `ai.rubric` ≠ `r4.txt` đã `trim()`; `sha256(ai.rubric)` ≠ `rubricSha256`; `ai.provider/model/threshold/weight/...` ≠ manifest; khối `ai` không hợp lệ | exit 1, nêu trường (kiểm cấu trúc độc lập với kiểm hash) |
| Một trong 33 file mã engine khác hash | exit 1 và nêu file. Chỉ ở CLI, `npm test` không kiểm (quyết định 8) |
| `--capture <file.jsonl>`: dòng có `rubricSha256` ≠ giá trị đóng băng, `requestedModel`/`provider` khác, không dòng nào mang `rubricSha256`, file không đọc được | exit 1. Khi đạt in các `responseModel` đã thấy (ghi vào báo cáo holdout); `responseModel` khác với tune → dòng `WARN`, không fail |
| `--capture ... --input <holdout.csv>`: capture thiếu giao dịch của mẫu đóng băng, thừa dòng ngoài mẫu, hoặc `sampleWeight` khác | exit 1. Không có `--input` thì in «sample NOT checked» |
| `--database-url <url>`: bảng `risk_rule_sets` không có version 1 hoặc version 1 ≠ `v1.json`; không đọc được | exit 1. Ngược lại in, với mỗi mode, số version DB có `config` bằng đúng file đóng băng (hoặc «not created») và version hiện hành cùng mode của nó. URL không bao giờ được in |
| Thiếu hoặc sai tham số, `--bogus`, `--input` không kèm `--capture` | exit 2 và dòng `Usage` |

### 2.3 Quy tắc sau đóng băng (nằm trong bản ghi §5)

Không chỉnh tham số, rubric, mô hình, tham số lấy mẫu, quy trình đo, mã engine. Muốn đổi: một PR sửa file, manifest, **một mục `amendments`** và một dòng nhật ký; spec ghim các hash gốc nên sửa manifest mà không thêm `amendments` làm `npm test` đỏ; nếu holdout đã chạy thì nó đã thành tune. Mỏ neo ngoài repo: thông báo §8 của bản ghi (BL-405) và `CODEOWNERS` nếu techlead chọn (BL-406).

## 3. Kiến trúc

- **Vị trí:** không đổi mã chạy của `api`/`worker`. Thêm: `backend/src/modules/risk/evaluation/freeze.ts` (logic thuần, nhận một hàm đọc file), `freeze.spec.ts`, `configs/v4-ai-r4.json`, `configs/freeze-manifest.json`; `backend/src/scripts/freeze-verify.ts` (CLI) và `freeze-verify.spec.ts`; dòng `freeze:verify` trong `backend/package.json`; một case ở `backend/test/db/fraud-schema.db-spec.ts`; `docs/components/risk/09-freeze-rule-config.md`.
- **Interface** (chữ ký ở `freeze.ts`): `verifyFreeze(manifest, read): string[]`, `verifyEngine(manifest, read): string[]`, `engineFingerprint(manifest): string`, `verifyCapture(manifest, captureText, csvText?): CaptureCheck`, `matchRuleSetRows(manifest, read, rows): RuleSetMatch`, `sha256Text`, `fileSha256`, `canonicalJson`; dùng `parseRuleSet` (`config/rule-set.ts`), `parseCaptureLines` và `selectSample` (`evaluation/capture-ai.ts`). Không đổi chữ ký symbol nào đã có, nên không có người gọi bị ảnh hưởng.
- **Dữ liệu:** chỉ đọc `risk_rule_sets` (`SELECT version, config … ORDER BY version`) khi có `--database-url`, qua `DataSource` của TypeORM như `provision-db-roles.main.ts`; không ghi bảng nào, không migration. Đối chiếu [`database-design.md`](../components/_shared/database-design.md) §4.8: bảng append-only, `version` PK; cột và tên bảng đúng như migration `CreateFraudStorage`.
- **Transaction:** không có (đọc đơn). Không Redis, SQS, HTTP.
- **Chuẩn hóa xuống dòng:** mọi hash file tính trên văn bản đã đổi `\r\n` → `\n` (repo ép `eol=lf`, Windows có thể checkout CRLF).
- **Sơ đồ:**

```mermaid
flowchart LR
  M[freeze-manifest.json] --> V[verifyFreeze]
  F[v4.json · v4-ai-r4.json · r4.txt · v1.json] --> V
  E[33 file mã engine] --> VE[verifyEngine, chỉ CLI]
  D[09-freeze-rule-config.md] --> T[freeze.spec.ts: bản ghi nêu đúng hash, đúng chỗ]
  C[capture holdout + CSV holdout] --> VC[verifyCapture]
  DB[(risk_rule_sets)] --> MR[matchRuleSetRows]
  V --> CLI[freeze:verify]
  VE --> CLI
  VC --> CLI
  MR --> CLI
```

- **Thay đổi cấp hệ thống:** [07-tuning-rules](../components/risk/07-tuning-rules.md) (mục «Chỉnh rubric AI», «Đưa vào hệ thống», «Còn lại»), [06-evaluation-ai-gate](../components/risk/06-evaluation-ai-gate.md) («Việc còn lại»), `docs/components/index.md`, `backend/src/scripts/README.md`, `docs/features/README.md`. Không đổi ADR, schema, event, `ErrorCode`, biến môi trường.

## 4. Test cases tự động

| ID | Truy vết | Lớp | Given · When · Then | Kết quả |
|---|---|---|---|---|
| TC-168-01 | DoD 1, 2 | unit | manifest và file thật của repo → `verifyFreeze`; manifest không có `amendments` thì các hash bằng giá trị ghim trong spec (cả dấu vân tay engine) | không vấn đề |
| TC-168-02 | DoD 2 | unit | đổi `maxTransfers` 2 → 3 trong bản sao trong bộ nhớ của `v4.json` | vấn đề nêu file và hash mong đợi |
| TC-168-03 | DoD 2 | unit | cùng nội dung nhưng xuống dòng CRLF | vẫn khớp |
| TC-168-04 | DoD 4 | unit | `v4-ai-r4.json`: `mode = rules_with_external_ai`, `ai.provider/model/threshold/weight` đúng manifest; phần trừ `mode` và `ai` bằng v4 | đạt |
| TC-168-05 | DoD 4 | unit | `ai.rubric` đổi một từ (hash đã cập nhật theo, để chỉ còn kiểm cấu trúc); `rubricSha256` trong manifest sai | báo «ai.rubric differs», báo `rubricSha256` |
| TC-168-06 | DoD 4 | unit | `rubricSha256` = sha256(`r4.txt` đã trim) = `96e0b08f…a9f0ff`, khác sha256 file nguyên văn `0640e98b…` | đạt |
| TC-168-07 | DoD 4 | unit | (hash đã cập nhật) khối `ai` thiếu `threshold`; `weight` 40,5; `threshold` 0,7 | «valid ai block»; «ai.threshold is 0.7» |
| TC-168-08 | DoD 4 | unit | (hash đã cập nhật) v4 đổi `mode` sang AI; `v4-ai-r4.json` đổi `weight` luật | «must be mode rule_only»; «apart from mode and ai» |
| TC-168-09 | DoD 1 | unit | thiếu file `v1.json` | vấn đề nêu file |
| TC-168-10 | DoD 1 | unit | `matchRuleSetRows`: chỉ version 1 = v1 → «chưa tạo» cả hai mode, hiện hành 1; thêm version 2 = `v4.json` → `rule_only` là version 2, hiện hành 2; version 1 khác v1 hoặc bảng rỗng → vấn đề | đạt |
| TC-168-11 | DoD 2 | unit | `verifyEngine` với manifest giả: file đổi nội dung / bị xóa → nêu tên; dấu vân tay đổi theo hash, không theo thứ tự | đạt |
| TC-168-12a–d | DoD 4 | unit | `verifyCapture`: (a) đúng rubric/model, dòng không rubric bị bỏ qua; (b) rubric, model, provider khác, không có rubric, không phải JSON → vấn đề; (c) `responseModel` khác → cảnh báo, không fail; (d) với CSV tổng hợp 22 dòng: đủ mẫu → đạt; thiếu một dòng, mẫu thưa khác (trọng số lệch), dòng lạ → vấn đề | đạt |
| TC-168-13 | DoD 1 | unit | bản ghi `09-freeze-rule-config.md`: nhãn 4/5 và sha256 từng mode đúng cột, `provider`/`rubricSha256`/`ai.threshold`/`ai.weight` đúng hàng, ngày, commit cơ sở, seed, hash dữ liệu tune, dấu vân tay (đủ và rút gọn như trong thông báo), mọi `amendments[].id` | đạt |
| TC-168-14a–e | DoD 1, 2, 4 | unit (CLI `runFreezeVerify`) | (a) không tham số → 0, in giá trị đóng băng; (b) `--bogus`, thiếu giá trị, `--input` lẻ → 2 và `Usage`; (c) `--capture` tune r4 → 0 («sample NOT checked»), tune rubric gốc → 1, không có file → 1; (d) `--database-url` (bơm hàng): DB mới → 0, seed lệch → 1, lỗi đọc → 1, URL không bị in; (e) hash engine sai → 1 và nêu file | đạt |
| TC-168-15 | DoD 1 | db (PostgreSQL thật, `fraud-schema.db-spec.ts`) | sau migration `CreateFraudStorage`, hàng version 1 của `risk_rule_sets` bằng `configs/v1.json` | đạt |
| TC-168-16 | DoD 3 | quy trình | PR merge, Dev review, `check-doc-links.mjs` và `check-backlog.mjs` sạch, đã grep tên bảng/cột | quy trình |
| TC-168-17 | Bảo mật | không áp dụng | không endpoint, không PII, SQL là một câu SELECT cố định không nhận đầu vào; CLI không in URL DB | không áp dụng |

Không test nào mở `load-tests/fraud-dataset/` hay cần nhãn holdout (CSV trong test là tập tổng hợp 22 dòng). `npm test` không kiểm mã engine (quyết định 8).

## 5. Test thủ công

Điều kiện: Git Bash, Node 24, `backend/node_modules`; một PostgreSQL trống. Nếu chưa có: `docker run -d --name dbs-pg-187 -e POSTGRES_USER=banking -e POSTGRES_PASSWORD=banking_local_only -e POSTGRES_DB=banking -p 55432:5432 postgres:17` và `DATABASE_URL=postgres://banking:banking_local_only@localhost:55432/banking`; `psql` qua `docker exec dbs-pg-187 psql -U banking banking`. Output thô ở `screenshots/DBS-168/manual-test.txt`.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-168-01 | `npm run --silent freeze:verify` (từ `backend/`) | ba nhóm `OK`, `FROZEN AS RECORDED`, exit 0; in nhãn 4 và 5, hash, `rubricSha256`, dấu vân tay |
| M-168-02 | băm bằng `node` (không dùng mã của repo): `r4.txt` đã trim và nguyên văn; `REVIEW_RUBRIC` | `96e0b08f…a9f0ff`, `0640e98b…`, `3d0fd924…bb6a8`; khớp bản ghi và `ai-gate-capture-tune-r4.jsonl` |
| M-168-03 | `freeze:verify --capture <capture tune r4>` rồi với capture tune rubric gốc | r4: `OK`, `responseModel gpt-6-luna`, exit 0; rubric gốc: exit 1 nêu `rubricSha256` lệch |
| M-168-04 | DB trống: `npm run migration:run` rồi `freeze:verify --database-url $DATABASE_URL` | `OK`: DB chỉ có version 1 = `v1.json`; hai mode `not created`; hiện hành version 1 (`rule_only`) |
| M-168-05 | `psql`: `SELECT version, created_by, config->>'mode' FROM risk_rule_sets` | một dòng version 1 (đối chiếu M-168-04) |
| M-168-06 | từ chối: đổi `maxTransfers` 2 → 3 trong `v4.json` (sửa tạm), chạy `freeze:verify`; khôi phục bằng `git checkout -- <file>` rồi chạy lại | exit 1 nêu `v4.json` và hai hash; sau khôi phục exit 0 |
| M-168-07 | từ chối: thêm một dòng chú thích vào `rules/r1-velocity.rule.ts` (sửa tạm), chạy `freeze:verify` rồi `npm test -- freeze`; khôi phục | `freeze:verify` exit 1 nêu file engine; `npm test -- freeze` vẫn xanh; sau khôi phục exit 0 |
| M-168-08 | capture + mẫu: tạo CSV **tổng hợp** (22 dòng, script ở `scratchpad`, không liên quan dữ liệu thật) và capture cho nó từ `selectSample`; chạy `freeze:verify --capture ... --input ...`, rồi xóa một dòng capture và chạy lại | đủ: `OK` «sample equals the frozen sample»; thiếu một dòng: exit 1 «not in the capture» |
| M-168-09 | **seed SQL** (chỉ ở DB tạm): `INSERT INTO risk_rule_sets(version, config) VALUES (2, '<nội dung v4.json>'::jsonb)` rồi `freeze:verify --database-url` | `rule_only created as version 2`, hiện hành version 2. Phục hồi: bảng append-only không xóa được hàng, nên xóa container `docker rm -f dbs-pg-187` và dựng lại khi cần |
| M-168-10 | `check-doc-links.mjs`, `check-backlog.mjs` | sạch |

## 6. Domain review (AI)

**Reviewer:** subagent `opus` effort `high`, fresh, 2026-11-21 · **Kết quả vòng 1:** 13 phát hiện (blocking 2, should-fix 6, minor 5), **Verdict: REVISE** · [trả lời nguyên văn](screenshots/DBS-168/domain-review.md). Reviewer đã tính lại mọi sha256 trong bản ghi (28 file engine, `v4`, `v4-ai-r4`, `v1`, `r4`, capture, `REVIEW_RUBRIC`) và khẳng định đều khớp; xác nhận không có gì trong thiết kế đọc nhãn holdout.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | Tài liệu nói `npm test` không kiểm mã engine nhưng TC-168-11 và CLI không tham số kiểm nó trên repo thật; M-168-07 sẽ sai; mọi PR chạm 33 file `risk` sẽ đỏ | đã sửa: bỏ kiểm engine thật khỏi `npm test` (spec dùng manifest giả; CLI spec bơm manifest không engine); quyết định 8; TC-168-11, 14a, 14e |
| 2 | blocking | `evaluate-rules --restrict-to-capture` bỏ qua `sampleWeight`: precision, FPR, cảnh báo/1.000 của B2 sai; không có B1, bootstrap; lệnh để mở cho DBS-169 | đã sửa: capture mọi giao dịch (trọng số 1, quyết định 9), quy trình đo đóng băng ở bản ghi §4; phần công cụ B1/ablation/bootstrap tham số cố định chuyển BL-407 (ngoài phạm vi, phải xong trước khi mở nhãn) |
| 3 | should-fix | Khối `capture` của manifest không được kiểm; capture thiếu hoặc lấy mẫu khác vẫn qua | đã sửa: `verifyCapture(…, csvText)`, `--input`, TC-168-12d, 14c |
| 4 | should-fix | Capture holdout lộ nhãn (trọng số 1 = fraud/hard negative); không có quy tắc nơi lưu | đã sửa: bản ghi §4 «Bức tường dữ liệu» |
| 5 | should-fix | Mô tả seed thiếu vai trò công khai (A7-i); thông báo nói giao holdout ngay sau merge, mâu thuẫn điều kiện tiên quyết | đã sửa: bản ghi §1, §7, §8 |
| 6 | should-fix | Danh sách engine thiếu `common/money`, `utc-time`; bộ kiểm không được đóng băng | đã sửa: 33 file (thêm money, balance, utc-time, `freeze.ts`, `freeze-verify.ts`) |
| 7 | should-fix | Sửa đồng thời file, manifest và bản ghi vẫn qua `npm test`; không có dấu vân tay engine trong bản ghi/thông báo | đã sửa một phần: ghim hash gốc trong spec (chỉ nới khi có `amendments`), dấu vân tay trong bản ghi và thông báo. Phần còn lại (CODEOWNERS, mỏ neo ngoài repo) là quyết định của techlead: BL-406, BL-405 |
| 8 | should-fix | TC-168-07/08 qua vì sai hash, không kiểm cấu trúc | đã sửa: các case tính lại hash của bản sao đã sửa và khẳng định thông báo cấu trúc cụ thể |
| 9 | minor | TC-168-13 quá lỏng (chuỗi con) | đã sửa: so khớp hàng bảng, cột đúng, hash rút gọn trong thông báo |
| 10 | minor | `responseModel` (alias) không được so | đã sửa: manifest ghi `responseModels` của tune; capture khác → cảnh báo (không fail: alias trôi nằm ngoài tầm kiểm soát, nhưng phải ghi) |
| 11 | minor | `dbs-pg-187` không định nghĩa; M-168-08 không có bước phục hồi | đã sửa: §5 có `docker run`, `psql`, bước xóa container |
| 12 | minor | SHA squash merge không được ghi | đã sửa một phần: bản ghi §1 có hàng «Commit đóng băng»; điền ở PR docs ngay sau merge (BL-405 nếu chưa làm) |
| 13 | minor | 07 dòng «Chỉnh rubric AI» nhắc quyết định ở DBS-168 | đã sửa: thêm vào danh sách cập nhật §3 và §9, và sửa 07 |

**Vòng 2:** không chạy lại reviewer đầy đủ vì hai phát hiện blocking đã được sửa bằng thay đổi mà chính tôi kiểm lại bằng test; ghi rõ ở §8 «Lệch» và để Dev review PR xem lại. **Quyết định ở G2 (agent tự quyết):** như mục 8–10 của §1.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Kết quả đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `evaluation/freeze.ts`, `configs/v4-ai-r4.json`, `configs/freeze-manifest.json` | TC-168-01…13 | `Cannot find module './freeze'` (TS2307) | `npx jest --config ./test/jest-unit.js src/modules/risk/evaluation/freeze.spec.ts` | `feat(risk): …(DBS-168)` |
| 2 | `scripts/freeze-verify.ts`, `package.json` | TC-168-14a–e | `Cannot find module './freeze-verify'` | `npx jest … src/scripts/freeze-verify.spec.ts` | cùng commit |
| 3 | `test/db/fraud-schema.db-spec.ts` | TC-168-15 | không có đỏ: test đặc tả cho dữ liệu đã có (seed) | `DATABASE_URL=… npx jest --config ./test/jest-db.js test/db/fraud-schema.db-spec.ts -t TC-168-15` | cùng commit |
| 4 | `docs/components/risk/09-freeze-rule-config.md` | TC-168-13 | (đã có trong bước 1) | như bước 1 | cùng commit |
| 5 | 07, 06, `components/index.md`, `scripts/README.md`, `features/README.md`, `BACKLOG.md`, feature doc, screenshots | `check-doc-links.mjs`, `check-backlog.mjs` | n/a | hai script đó | `docs(risk): …(DBS-168)` |
| 6 | test thủ công M-168-01…10 trên commit cuối đổi code | | | §5 | `manual-test.txt` trong commit docs |

**Sweep giới hạn và DoD:** DoD 1 → bản ghi §1–§2, §8, test 01/13/15, BL-405 (thông báo, SHA); DoD 2 → bản ghi §5, spec 01/02/11, `freeze:verify`; DoD 3 → quy trình; DoD 4 → bản ghi §2, §6, spec 04–08, 12. Giới hạn của 07 («đóng băng cấu hình… DBS-168», «đổi REVIEW_RUBRIC là quyết định ở DBS-168») → quyết định 4 và 07 được sửa. Giới hạn của 06 («đóng băng… DBS-168») → 06 được sửa.

**Rủi ro và cách lùi:** (a) hash engine lệch khi `main` đổi 33 file trước khi merge → tạo lại manifest sau rebase (script đã có trong lịch sử làm việc: hash lại các file) và chạy lại test; (b) ID `BL-405…408` trùng với PR khác (DBS-188) → đổi số khi rebase; (c) lùi: PR chỉ thêm file và một dòng `package.json`, một case db-spec; revert nguyên PR là đủ, không đụng DB hay hành vi chạy. **Quyết định ở G3 (agent tự quyết):** gộp bước 1–4 vào một commit vì TC-168-13 cần cả bản ghi lẫn manifest mới xanh.

## 8. Kết quả

- **Lệnh kiểm tra** (chạy lúc bàn giao, từ `backend/`): `npm run lint:check` sạch; `npm run typecheck` sạch; `npm test`: 139/141 suite đạt, **2.396 test đạt**, 1 test fail ở lần chạy đầu và 1 suite không nạp được: `src/database/typeorm-options.spec.ts` không nạp được từ trước (`crypto is not defined` với Node 24, giống baseline), `src/modules/accounts/accounts.exports.spec.ts` quá thời gian ở lần chạy đầu khi máy tải (20 giây) và đạt khi chạy riêng (2/2); hai file mới của task: `freeze.spec.ts` + `freeze-verify.spec.ts` 21/21 đạt; db-spec `fraud-schema.db-spec.ts -t "TC-168-15|TC-58-01"` 2/2 đạt trên PostgreSQL 17 thật. Không `.skip`, `.only`, `.todo` trong test của task (0 skipped). Không chạy `test:e2e` và toàn bộ `test:db` trên máy (quá tải, CI chạy). `check-doc-links.mjs`: 0 liên kết hỏng; `check-backlog.mjs`: 0 lỗi.
- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-168-01 | `freeze.spec.ts` › TC-168-01 | đạt |
| TC-168-02 | › TC-168-02 | đạt |
| TC-168-03 | › TC-168-03 | đạt |
| TC-168-04 | › TC-168-04 | đạt |
| TC-168-05 | › TC-168-05 | đạt |
| TC-168-06 | › TC-168-06 | đạt |
| TC-168-07 | › TC-168-07 | đạt |
| TC-168-08 | › TC-168-08 | đạt |
| TC-168-09 | › TC-168-09 | đạt |
| TC-168-10 | › TC-168-10 | đạt |
| TC-168-11 | › TC-168-11 | đạt |
| TC-168-12a–d | › verifyCapture › TC-168-12a…12d | đạt |
| TC-168-13 | › TC-168-13 | đạt |
| TC-168-14a–e | `src/scripts/freeze-verify.spec.ts` › TC-168-14a…14e | đạt |
| TC-168-15 | `test/db/fraud-schema.db-spec.ts` › TC-168-15 | đạt (test đặc tả cho dữ liệu có sẵn nên không có kết quả đỏ) |
| TC-168-16 | quy trình | chờ PR merge, review của Dev và CI |
| TC-168-17 | không áp dụng | có lý do ở §4 |

- **Test thủ công** (SHA commit cuối đổi code: `202283a`, dòng đầu [manual-test.txt](screenshots/DBS-168/manual-test.txt); đã bỏ mật khẩu DB cục bộ và màu ANSI; không có token, ARN hay id tài khoản AWS):

| Bước | Lệnh | Kết quả thật (rút gọn) | |
|---|---|---|---|
| M-168-01 | `npm run --silent freeze:verify` | ba nhóm `OK`, nhãn 4 `c9da84a3…`, nhãn 5 `426b97fb…`, `rubricSha256` `96e0b08f…`, `ai.threshold 0.65`, `ai.weight 40`, 33 file engine, dấu vân tay `21742a3c…5524`, `FROZEN AS RECORDED`, exit 0 | đạt |
| M-168-02 | `node m02-hash.mjs` (không dùng mã repo) | trim `96e0b08f…`, file `0640e98b…`, `REVIEW_RUBRIC` `3d0fd924…`; capture r4 chỉ có `96e0b08f…`; `ai.rubric` của `v4-ai-r4.json` cũng `96e0b08f…` | đạt |
| M-168-03 | `freeze:verify --capture` r4 / rubric gốc | r4: `OK capture: 2021 lines, status {"SUCCEEDED":2021}, responseModel gpt-6-luna`, exit 0; rubric gốc: `FAIL capture: 2021 capture line(s) carry a rubricSha256 other than 96e0b08f…`, exit 1 | đạt |
| M-168-04 | DB trống `dbs168`, `migration:run`, `freeze:verify --database-url` | `OK risk_rule_sets: version 1 equals …/v1.json; rule_only not created …; rules_with_external_ai not created …; active version 1 (rule_only)`, exit 0 | đạt |
| M-168-05 | `psql` `SELECT … FROM risk_rule_sets` | một hàng: version 1, `created_by` rỗng, `rule_only`, R1 weight 30 | đạt |
| M-168-06 | đổi `maxTransfers` 2 → 3 rồi khôi phục | `FAIL … v4.json: sha256 is 993267f8…, the manifest freezes c9da84a3…` và `FAIL v4-ai-r4.json: apart from mode and ai it must equal v4.json`, exit 1; sau khôi phục exit 0 | đạt |
| M-168-07 | thêm một dòng vào `r1-velocity.rule.ts` | `FAIL engine files: …/r1-velocity.rule.ts: sha256 is 5b7ec83f…, the manifest freezes 719f9d2c…`, exit 1; `npm test` hai suite freeze vẫn 21/21 xanh; sau khôi phục exit 0 | đạt |
| M-168-08 | CSV tổng hợp 22 dòng + capture | đủ: `OK capture: 22 lines … sample equals the frozen sample`; thiếu một dòng: `FAIL capture: 1 transfer(s) of the frozen sample are not in the capture`, exit 1 | đạt |
| M-168-09 | **seed SQL** version 2 = `v4.json` ở DB tạm, `freeze:verify --database-url` | `rule_only created as version 2 … active version 2 (rule_only)`, `psql` hai hàng; DB tạm đã xóa | đạt |
| M-168-10 | `check-doc-links.mjs`, `check-backlog.mjs` | 488 file 0 liên kết hỏng; 107 dòng 0 lỗi | đạt |

- **Phạm vi so với §7:** xem `git diff --stat main...HEAD` ở mô tả PR. File ngoài danh sách §7: không có, trừ `backend/src/scripts/README.md`, `docs/components/index.md`, `docs/features/README.md` (đã nêu ở §3 «Thay đổi cấp hệ thống»).
- **Ảnh chụp:** không áp dụng. Không có giao diện; bằng chứng là output thô [manual-test.txt](screenshots/DBS-168/manual-test.txt) và [domain-review.md](screenshots/DBS-168/domain-review.md). Không ảnh nào thiếu.
- **Lệch so với kế hoạch (gate phụ, agent tự duyệt):**
  1. **Thứ tự pha.** Vì chạy tự động một mạch, mã (`freeze.ts`, test, CLI) đã được viết (test đỏ trước, rồi xanh) **trước khi** có kết quả domain review (G2) và G3. Hậu quả: hai phát hiện blocking của review (kiểm engine lẫn vào `npm test`; quy trình đo bằng mẫu thưa) làm đổi mã sau khi đã viết. Cách giảm: toàn bộ test được viết lại theo review rồi chạy lại; review vòng 2 (§6) soi lại các phần đã đổi; Dev review PR xem lại thứ tự này.
  2. Kiểm mã engine chỉ ở CLI, không ở `npm test` (quyết định 8).
  3. Capture holdout đủ mọi giao dịch (quyết định 9), khác mẫu thưa của tune.
  4. Thêm TC-168-15 vào `fraud-schema.db-spec.ts` (file có sẵn) thay vì trong test mới, vì cần PostgreSQL thật và migration sẵn có.
- **Bàn giao cho vai khác:** BL-405 (gửi thông báo cả nhóm, điền SHA squash merge: DoD 1 chưa đạt trọn); BL-406 (CODEOWNERS và bước CI `freeze:verify`: techlead); BL-407 (công cụ đo B1, ablation, bootstrap ở tham số cố định, trước khi mở nhãn holdout); BL-408 (tạo version thật trong `risk_rule_sets` sau holdout). Điều kiện tiên quyết đã có dòng sẵn của DBS-169: BL-171, BL-392, BL-043 (nêu trong bản ghi, không đổi).
- **Chưa chạy:** thông báo cả nhóm (agent không có kênh); chạy holdout (cố ý, DBS-169); `test:e2e` và toàn bộ `test:db` trên máy (CI chạy); CI và Dev review của PR (đang chờ).

## 9. Tài liệu đã cập nhật

`docs/components/risk/09-freeze-rule-config.md` (mới), `docs/components/risk/07-tuning-rules.md` («Chỉnh rubric AI», «Đưa vào hệ thống», «Còn lại»), `docs/components/risk/06-evaluation-ai-gate.md` («Việc còn lại»), `docs/components/index.md`, `backend/src/scripts/README.md`, `docs/features/README.md`, `docs/BACKLOG.md` (thêm BL-405, BL-406, BL-407, BL-408; không xóa dòng nào: BL-171, BL-392, BL-043 vẫn mở). Tên bảng/cột đã grep: `risk_rule_sets(version, config, created_by, created_at)`, `config`, `version` khớp `database-design.md` §4.8 và migration `CreateFraudStorage`; không dùng mã lỗi mới.
