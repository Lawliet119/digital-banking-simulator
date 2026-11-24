# Đóng băng cấu hình luật trước khi chạy holdout (DBS-168)

> **Status:** Frozen · **Vai:** #4 Fraud · **Đóng băng ngày:** 2026-11-21 · **Có hiệu lực:** từ lúc PR của DBS-168 được merge vào `main` · **Feature doc:** [DBS-168](../../features/DBS-168-freeze-rule-config.md)

Từ thời điểm này cấu hình luật dùng cho holdout **không được chỉnh**. Holdout chạy đúng một lần cho mỗi mode (DBS-169), và không chọn phiên bản mặc định theo kết quả holdout. Tài liệu này là bản ghi cho người đọc; máy kiểm bằng `configs/freeze-manifest.json` và `npm run --silent freeze:verify` (từ `backend/`). Hai nơi phải khớp nhau: test `freeze.spec.ts` đỏ nếu bản ghi này thiếu hoặc đặt sai chỗ một hash của manifest.

## 1. Bản ghi

| Mục | Giá trị |
|---|---|
| Ngày đóng băng | 2026-11-21 |
| Commit cơ sở | `9213899483fb155f3cc93b019461ed3484928cc5` (`origin/main` lúc đóng băng; đã có `v1`–`v4.json`, `r4.txt` và mã engine) |
| Commit đóng băng | `8fc4753abc6b24b250c60f758bda6834e054a133`: squash merge của PR #219 (DBS-168) vào `main` lúc 2026-11-20T19:50:50Z (2026-11-21 02:50 giờ Việt Nam). Mọi hash ở §2 và dấu vân tay ở §1 được kiểm lại trên đúng commit này bằng `freeze:verify` (`FROZEN AS RECORDED`) |
| Seed | `dbs-split-v1`, một chuỗi ba vai trò: (1) seed chia khách thành train/validation của tập tune; (2) seed lấy mẫu của `capture-ai`; (3) seed mặc định công khai của bộ sinh dữ liệu `split.mjs` (DBS-146 A7-i). Seed bí mật sinh tập holdout **không** nằm trong bản ghi này (thuộc #6; không ghi ở nơi #4 đọc được) |
| Dữ liệu đã dùng để chọn | tập tune seed `dbs-split-v1`, 101.551 giao dịch, sha256 CSV `c387b43605d8a9be05dd8288490130295c6d8928c66fb2c16d2f9cbae36f1b01`; capture AI của rubric r4 sha256 `24d8be17c96843689a3c24088d6831ef35ff09c42e14bd623318bf1485ca6276` ([07](07-tuning-rules.md)) |
| Dấu vân tay mã engine | Lúc đóng băng: `b62a0ab2a528e34301df4cd91ccaf5aec6d1b8efc8597be1d305008d760e5d0f` (sha256 trên tên và hash của 35 file ở §3). **Hiện hành (sau amendment BL-407, 37 file, §5):** `9c9b458e61dcc312c3fb28c167ea772b0a7ca47d5547df598a37b630ae4478b9`; `freeze:verify` in lại |
| Phán quyết cổng ADR-14 lúc đóng băng | NO-GO tạm thời, hệ thống giữ `rule_only` ([07](07-tuning-rules.md#chỉnh-rubric-ai-dbs-161-phần-ai)). Đóng băng không bật AI |

## 2. Hai mode đã đóng băng

«Số phiên bản `risk_rule_sets`» ở đây là **nhãn đánh giá** (`--config-version`), cùng cách đánh số của các lần tune `v1`–`v4` ([07](07-tuning-rules.md)). Bảng `risk_rule_sets` hiện **chỉ có version 1** (seed của migration `CreateFraudStorage`, bằng `v1.json`); hai cấu hình dưới đây **chưa được tạo thành version trong DB** vì phiên bản hiện hành của hệ thống là version lớn nhất, nên tạo chúng sẽ đổi hành vi chấm điểm đang chạy. Khi nhóm quyết định tạo (qua API cấu hình luật, DBS-160), số do DB cấp (`MAX(version)+1`) phải được ghi thêm vào bảng này và `freeze:verify --database-url` phải báo `config` trong DB bằng đúng file đã đóng băng. Danh tính thật của mỗi cấu hình là sha256 của file.

| | `rule_only` | `rules_with_external_ai` |
|---|---|---|
| Nhãn đánh giá (`--config-version`) | **4** | **5** |
| Version trong DB | chưa cấp (DB chỉ có version 1) | chưa cấp (DB chỉ có version 1) |
| File | `backend/src/modules/risk/evaluation/configs/v4.json` | `backend/src/modules/risk/evaluation/configs/v4-ai-r4.json` (= `v4.json` + `mode` + khối `ai`, không là lần tune thứ 5) |
| sha256 file | `c9da84a345f7da5f50f18059d85e14ee7ed5a5e688d3fc88faed98d39ba655c8` | `426b97fb6090b0b23c1ef261f4a677962b0d3c5290613a13208a214ab9819dd9` |
| Luật R1–R6, ngưỡng MEDIUM 40 / HIGH 70 | R1 weight 40 `maxTransfers` 2; R2 weight 5; R3 35; R4 20; R5 40; R6 30; mọi ngưỡng trong luật như `v1.json` ([07](07-tuning-rules.md#các-phiên-bản)) | giống hệt `v4.json` (test kiểm) |
| `provider` | không có khối `ai` | `openai` |
| `model` | | `gpt-6-luna` (tên yêu cầu; alias không phải snapshot bất biến. Capture của tune trả `responseModel` = `gpt-6-luna` ở cả 2.021 dòng; `freeze:verify --capture` cảnh báo nếu capture holdout khác, và `responseModel` thật phải ghi vào báo cáo holdout, DBS-169) |
| `rubricSha256` | | `96e0b08fadcbd7ec2fdadd71f59569e02b7273db453d657acd44ade7c5f9a0ff` |
| `ai.threshold` | | `0.65` |
| `ai.weight` | | `40` |
| Rubric nguồn | | `backend/src/modules/risk/evaluation/rubrics/r4.txt` (r4). sha256 **file** `0640e98b4359bfb5dba55c4ee1ab553c0a321e9298e94a79c7ee77a9c74680b5` |
| `ai.requestTimeoutMs`, `ai.maxAdmissionDelayMs` | | `20000` (mặc định `--timeout-ms` của `capture-ai`), `1000`. Hai số vận hành, chưa được Ops duyệt (ADR-14); không ảnh hưởng holdout vì holdout đọc capture offline. Chỉ giữ chỗ để cấu hình qua được `parseRuleSet`; phải duyệt lại trước khi tạo version thật, và đổi chúng là một thay đổi ghi vào nhật ký (§5) nhưng không cần chạy lại holdout |
| Tham số lấy mẫu capture | | `--seed dbs-split-v1 --normal-sample 1000000 --timeout-ms 20000`. `--normal-sample` lớn hơn số dòng NORMAL của holdout nghĩa là **gọi API cho mọi giao dịch**, mọi dòng có trọng số 1, nên các số đo của `evaluate-rules` (không có trọng số) là đúng cho cả file; chi phí khoảng 2,3 USD cho khoảng 43.000 giao dịch (capture r4 tốn trung bình 527 token đầu vào mỗi lần gọi, đo trên [capture của tune](evidence/ai-gate-capture-tune-r4.jsonl), giá giả định 0,10 USD/1M token ở [06](06-evaluation-ai-gate.md#chi-phí-và-độ-trễ); không phải hóa đơn) và khoảng một giờ ở concurrency 4. Tune dùng mẫu 1.000 dòng NORMAL vì chi phí; chọn lại mẫu sau khi thấy dữ liệu holdout là rò rỉ |
| Chọn trên | train (luật) · train (ngưỡng/trọng số AI) | |
| Version 1 trong DB (seed, không đóng băng thêm) | `backend/src/modules/risk/evaluation/configs/v1.json`, sha256 `876bdd9750a0067039dc5af59d318c7767f535e7dea8ed30ecbba886ec127aa8`; `freeze:verify --database-url` kiểm hàng version 1 bằng file này | |

**Hai hash của rubric khác nhau và cả hai đúng.** `r4.txt` có một dấu xuống dòng cuối; `capture-ai` `trim()` rubric trước khi gọi API và adapter ghi vào mỗi dòng capture `rubricSha256` = sha256 của chuỗi đã trim (`96e0b08f…a9f0ff`, có trong [`ai-gate-capture-tune-r4.jsonl`](evidence/ai-gate-capture-tune-r4.jsonl)). Số `0640e98b…` ở [07](07-tuning-rules.md) là hash của file. Capture của holdout phải mang `96e0b08f…a9f0ff`: capture chạy mà thiếu `--rubric-file` sẽ dùng `REVIEW_RUBRIC` (hash `3d0fd924…bb6a8`) và `freeze:verify --capture` từ chối nó.

**`REVIEW_RUBRIC` trong `ai/rubric.ts` không đổi.** Runtime lấy rubric từ `ai.rubric` của version; hằng chỉ là mặc định của script `capture-ai`. Đổi nó đổi mặc định mà không đổi cái được đóng băng.

**Điểm cần biết khi đọc `ai.weight = 40`:** bằng đúng ngưỡng MEDIUM 40, nên một câu trả lời AI ≥ 0,65 đủ tạo cờ một mình (B1 và B2 trùng nhau ở cổng, [06](06-evaluation-ai-gate.md)). Đây là kết quả chọn trên train, không chỉnh ở đây.

## 3. Mã engine cũng được đóng băng

JSON cấu hình đóng băng chưa đủ: sửa luật R1–R6, `ScoringService`, cách đọc tiền, provider offline, hàm đọc CSV hay `evaluate-rules` vẫn đổi kết quả holdout. `configs/freeze-manifest.json` ghi sha256 của 35 file quyết định kết quả: luật R1–R6 và `rule.ts`, `explanation-format.ts`; `scoring.service.ts`, `risk-level.ts`, `risk-rule-error.ts`, `risk-time.ts`; `config/rule-set.ts`, `rule-params.ts`; provider offline, `feature-provider.ts`, `export-features.ts`; `evaluation/` (`evaluate-rules`, `compare-modes`, `capture-ai`, `customer-split`); adapter và hợp đồng AI (`ai/ai-contract.ts`, `feature-projection.ts`, `openai-decisions.ts`, `rubric.ts`); ba script `evaluate-rules`, `compare-modes`, `capture-ai`; `common/money/money.ts`, `balance.ts`, `index.ts`, `common/events/utc-time.ts`, `index.ts` (hai barrel mà engine import qua alias); **và chính bộ kiểm** (`evaluation/freeze.ts`, `scripts/freeze-verify.ts`), để không ai làm lỏng nó mà vẫn đọc «FROZEN AS RECORDED». Amendment BL-407 (2026-11-24, trước holdout) thêm hai file của công cụ đo holdout: `evaluation/holdout-report.ts` và `scripts/holdout-report.ts` (tổng 37 file). Cố ý không đưa vào: `risk-scoring.metrics.ts` (chỉ đếm metric, không đổi điểm).

`freeze:verify` (không phải `npm test`) so từng file và nêu tên file lệch. Lý do tách: kiểm mã engine trong `npm test` sẽ làm đỏ mọi PR của người khác chạm 35 file này, nghĩa là một lệnh cấm sửa module `risk` mà chưa ai quyết định. Nếu techlead muốn khóa cứng trong CI, thêm bước chạy `freeze:verify` vào workflow là đủ. Còn lại `npm test` kiểm file cấu hình, rubric, `v1.json`, manifest và bản ghi này, kèm các giá trị ghim cố định trong spec (§5 mục 1).

## 4. Cách kiểm và đo trước khi chạy holdout

Từ `backend/`:

```bash
npm run --silent freeze:verify                       # file cấu hình, rubric, v1, mã engine, dấu vân tay
npm run --silent freeze:verify -- --capture <holdout-capture.jsonl> --input <holdout.csv>
                                                     # capture dùng đúng rubric/model, đúng mẫu đã đóng băng, đủ giao dịch, đúng trọng số; in responseModel
npm run --silent freeze:verify -- --database-url <url>  # risk_rule_sets: version 1 = v1.json; hai mode đã tạo thành version nào
```

**Quy trình đo đã đóng băng** (chọn sau khi thấy holdout là rò rỉ):

| Việc | Giá trị |
|---|---|
| Tập đo | toàn bộ file holdout, không `--part`, không `--restrict-to-capture` |
| `rule_only` | `evaluate-rules --config .../v4.json --config-version 4` |
| `rules_with_external_ai` | `capture-ai` cho mọi giao dịch với tham số ở §2, rồi `evaluate-rules --config .../v4-ai-r4.json --config-version 5 --ai-capture <capture>` |
| Số báo cáo | precision, recall, F1, cảnh báo/1.000 giao dịch, recall theo từng kịch bản (kể cả ba kịch bản ngoài tầm luật), recall trong tầm luật; B0 (cột `baseline`) và B2 trên cùng giao dịch |
| Dòng capture thất bại | `capture-ai` đã tự thử lại tối đa hai lần mỗi giao dịch. **Không chạy lại** sau đó, không xóa dòng để gọi lại: giao dịch `UNAVAILABLE` (hoặc trạng thái khác `SUCCEEDED`) giữ điểm luật như production và được đếm trong báo cáo (`freeze:verify --capture` in số theo trạng thái). Tỉ lệ thất bại cao bất thường là phát hiện cần ghi vào báo cáo, không là lý do chạy lại để «sạch» |
| Không dùng | `compare-modes` trên holdout (nó chọn lại ngưỡng và trọng số AI từ dữ liệu được đưa vào) |
| Công cụ đo ở tham số cố định (BL-407, đã có) | `npm run --silent holdout-report` (mã ở `evaluation/holdout-report.ts` và `scripts/holdout-report.ts`, đã vào manifest bằng amendment BL-407, [§5](#5-quy-tắc-sau-đóng-băng-và-nhật-ký-thay-đổi)). Tham số lấy từ hai file đã đóng băng, không chọn lại gì. Báo cáo B0, B1 (chỉ AI, ngưỡng đã đóng băng), B2 trên cả file; recall từng kịch bản kể cả ba kịch bản ngoài tầm; ablation từng luật R1–R6 cho B0 và B2; đường precision–recall và average precision; khoảng tin cậy bootstrap 95% theo khách cho mức tăng recall B2 − B0 và cho cảnh báo/1.000; `responseModel`, hash rubric, số trạng thái; cảnh báo rò rỉ. Từ chối chạy khi cấu hình hoặc engine lệch bản ghi, capture sai rubric/model/mẫu hoặc thiếu giao dịch, hoặc file báo cáo đã tồn tại. `--allow-tune` chỉ cho chạy thử trên đúng file tune của manifest và đóng dấu `tune-dry-run`. Hướng dẫn chạy: [10](10-holdout-runbook.md) |

**Lệnh dự kiến** (DBS-169 điền đường dẫn):

```bash
npm run --silent freeze:verify
npm run --silent evaluate-rules -- --input <holdout.csv> --config src/modules/risk/evaluation/configs/v4.json --config-version 4 --output <report-rule-only.json>
npm run --silent capture-ai -- --input <holdout.csv> --output <holdout-capture.jsonl> --seed dbs-split-v1 --max-calls 100000 --model gpt-6-luna --normal-sample 1000000 --timeout-ms 20000 --rubric-file src/modules/risk/evaluation/rubrics/r4.txt
npm run --silent freeze:verify -- --capture <holdout-capture.jsonl> --input <holdout.csv>
npm run --silent evaluate-rules -- --input <holdout.csv> --config src/modules/risk/evaluation/configs/v4-ai-r4.json --config-version 5 --ai-capture <holdout-capture.jsonl> --output <report-ai.json>
npm run --silent holdout-report -- --input <holdout.csv> --capture <holdout-capture.jsonl> --output <holdout-report.json>   # BL-407: B1, ablation, PR, bootstrap
```

Cách giao holdout (seed bí mật, cam kết hash) và từng bước chạy: [10](10-holdout-runbook.md). `capture-ai` nạp khóa bằng `node --env-file`, xem ở đó.

«Đúng một lần» chỉ giữ được bằng quy trình, vì `evaluate-rules` không biết file nào là holdout (nó chỉ từ chối file không có nhãn): chạy cả hai mode trong một phiên, lưu hai báo cáo JSON (có `csvSha256` của holdout) và ghi người chạy, lệnh, thời điểm vào feature doc của DBS-169. Chạy lại để «cải thiện» biến holdout thành tune.

**Bức tường dữ liệu.** File holdout CSV, **capture holdout** (mỗi dòng có `sampleWeight`, và với mẫu thưa nó lộ nhãn: trọng số 1 là fraud hoặc hard negative) và hai báo cáo đều mang nhãn. Chúng chỉ nằm ở nơi lưu có quyền riêng của BL-171, **không** vào `docs/components/risk/evidence/` hay repo (bản ghi của tune ở đó là tập tune, không là holdout). Chỉ người được BL-171 cấp quyền chạy `freeze:verify --capture ... --input <holdout.csv>`.

**Điều kiện tiên quyết của DBS-169**, không thuộc DBS-168 và còn mở trong [`docs/BACKLOG.md`](../../BACKLOG.md): BL-171 (nơi lưu nhãn holdout với quyền riêng và holdout sinh từ seed bí mật, DBS-146 A7-ii; phần mã `split.mjs --seed-file` đã có, phần giao holdout theo [10](10-holdout-runbook.md)), BL-392 (hợp đồng kịch bản nằm trong `docs/` nơi #4 đọc được; techlead ghi quyết định chấp nhận ở [10](10-holdout-runbook.md)), BL-043 (duyệt RSK-05 trước khi gửi dữ liệu cho API AI, chặn lần capture của mode AI), BL-407 (công cụ đo B1, ablation, bootstrap: đã xong, dòng đã xóa khỏi backlog).

## 5. Quy tắc sau đóng băng và nhật ký thay đổi

Không chỉnh: tham số luật, ngưỡng, trọng số, rubric, mô hình, `ai.threshold`, `ai.weight`, tham số lấy mẫu capture, quy trình đo ở §4 và mã engine ở §3. Muốn đổi:

1. Một PR sửa file **và** `freeze-manifest.json` **và** thêm một dòng vào bảng dưới (ngày, ai, đổi gì, lý do, trước hay sau khi holdout đã chạy) **và** một mục `amendments` trong manifest (`id`, `date` và `expected`: các hash mà kho phải có sau thay đổi này). `npm test` đỏ nếu chỉ sửa file cấu hình; đỏ nếu sửa cả manifest mà không thêm mục `amendments` (spec ghim các hash đóng băng ban đầu); sau một amendment, spec ghim theo `expected` của amendment **cuối**, nên mỗi thay đổi tiếp theo cũng cần một mục mới; đỏ nếu `id` không có trong bản này. Thông báo ở §8 giữ nguyên giá trị lúc đóng băng (nó là mỏ neo ngoài repo); hash hiện hành nằm ở §1 và §2.
2. Cấu hình mới phải được đánh giá lại trên tập tune (train để chọn, validation để kiểm) theo [07](07-tuning-rules.md), rồi đóng băng lại với nhãn đánh giá mới; hai nhãn 4 và 5 không được dùng lại cho nội dung khác.
3. Nếu holdout **đã chạy** và cấu hình bị chỉnh sau đó, tập holdout đã thành tập tune: kết quả holdout cũ không còn là kết quả khách quan, và cần holdout mới do #6 giao. Công bố điều đó trong báo cáo.
4. Đổi `ai.requestTimeoutMs` hoặc `ai.maxAdmissionDelayMs` (không ảnh hưởng điểm) vẫn ghi vào nhật ký, không cần chạy lại holdout.

Vì một PR sửa đồng thời file, manifest, spec và bản ghi vẫn vượt được kiểm tra tự động, **mỏ neo ngoài repo** là thông báo ở §8 (chứa các hash và dấu vân tay) và bước Dev review; việc đặt `CODEOWNERS` cho `configs/` và `freeze*` là quyết định của techlead (BL-406).

| Ngày | Ai | Thay đổi | Lý do | Holdout đã chạy chưa |
|---|---|---|---|---|
| 2026-11-24 | Dev (techlead waiver) | Amendment `BL-407`: thêm `evaluation/holdout-report.ts` và `scripts/holdout-report.ts` vào danh sách engine (35 → 37 file); dấu vân tay engine thành `9c9b458e…78b9`. Không đổi cấu hình, rubric, ngưỡng hay công thức chấm điểm | Công cụ đo holdout ở tham số cố định phải nằm trong bản đóng băng trước khi mở nhãn (BL-407) | Chưa chạy |

## 6. Công bố về validation (trung thực về thứ tự)

«Validation» ở DoD đọc được theo hai nghĩa; bản ghi công bố cả hai.

- **Validation là 30% khách của tập tune** ([07](07-tuning-rules.md)): nó đã được đọc **trước** lúc đóng băng này, cho cả `v1`–`v4` và r4 (07 ghi rõ: «validation đã được đọc cho r4, tiếp tục sửa theo nó là rò rỉ»). Luật được chọn trên train, nhưng mọi bước v2→v4 đều đã được xem trên validation, và r4 được giữ lại sau khi xem validation. Vì vậy các số validation trong 07 và 06 là **số của tập tune**, không là phép đo độc lập. Đóng băng này không xóa điều đó; nó chỉ cấm chỉnh tiếp từ đây.
- **Validation là lần chạy holdout (DBS-169):** cấu hình đóng băng trước lần chạy đó. Chỉnh tiếp sau khi đã thấy kết quả holdout thì phần chỉnh đó là tune và phải công bố là tune (§5, mục 3).
- Hệ quả cho báo cáo cuối: số holdout là số khách quan duy nhất; số validation của tune chỉ nêu như bối cảnh. Kết quả theo kịch bản gồm cả ba kịch bản ngoài tầm luật (`STRUCTURING`, `SLOW_DRIP`, `FAN_IN`, recall 0% ở mọi cấu hình đã thử) là giới hạn đã công bố, không phải lỗi sẽ sửa sau khi xem holdout.

## 7. Giới hạn đã chấp nhận

- Tập tune hiện tại có thể bị sinh lại với seed bí mật của #6 (DBS-146 A7-ii, BL-171). Nếu vậy cấu hình này vẫn là cấu hình đã đóng băng (không tune lại trên tập mới); bản ghi chỉ khẳng định nó được chọn trên tập có sha256 ở §1. Chừng nào holdout còn sinh được từ seed mặc định công khai (DBS-146 A7-i), bức tường dữ liệu chỉ là quy ước; DBS-169 chỉ chạy khi BL-171 đã đóng.
- `maxAdmissionDelayMs` và `requestTimeoutMs` chưa được Ops duyệt; AI không được bật ở production khi chưa có.
- Chưa có version nào trong `risk_rule_sets` cho hai mode; tạo là quyết định riêng của nhóm sau holdout.
- Bộ kiểm chỉ chặn sửa vô ý; không chống được một PR cố ý sửa đồng thời mọi nơi (§5).

## 8. Thông báo cả nhóm

Agent không có kênh nhóm. Người phụ trách (#4 hoặc techlead) gửi đoạn dưới vào kênh chung rồi ghi **ngày giờ và đường dẫn tin** vào bảng bên dưới; việc này là dòng backlog BL-405 (hạn trước DBS-169). Hash trong tin là mỏ neo ngoài repo: nếu ai sửa file và manifest cùng lúc, hash trong tin sẽ khác.

> **[DBS-168] Cấu hình luật đã đóng băng trước khi chạy holdout.** Từ 2026-11-21 (khi PR DBS-168 merge) KHÔNG chỉnh tham số, rubric, mô hình, tham số lấy mẫu capture hay mã engine của chấm điểm rủi ro. Hai mode: `rule_only` nhãn 4, file `configs/v4.json`, sha256 `c9da84a3…55c8`; `rules_with_external_ai` nhãn 5, file `configs/v4-ai-r4.json`, sha256 `426b97fb…9dd9`, provider `openai`, model `gpt-6-luna`, rubricSha256 `96e0b08f…a9f0ff`, `ai.threshold` 0,65, `ai.weight` 40. Dấu vân tay mã engine `b62a0ab2…5d0f` (35 file). Seed `dbs-split-v1`, commit cơ sở `9213899`. Muốn đổi phải đi qua đánh giá lại và ghi nhận (bản ghi `docs/components/risk/09-freeze-rule-config.md` §5); chỉnh sau khi đã thấy kết quả holdout thì holdout thành tập tune. #6: giao holdout cho nơi lưu có quyền riêng sau khi PR này merge **và** BL-171 đã đóng; holdout và capture của nó không vào repo. Kiểm: `npm run --silent freeze:verify` từ `backend/`.

| Đã gửi lúc | Kênh và đường dẫn tin | Người gửi |
|---|---|---|
| chưa gửi | | |
