# Hướng dẫn giao tập holdout và chạy DBS-169

> **Status:** Draft · **Vai:** người giao holdout (techlead hoặc #6), #4 Fraud (người chạy) · **Cập nhật:** 2026-11-24 · Cấu hình đã đóng băng: [09](09-freeze-rule-config.md) · Công cụ: `holdout-report` (BL-407) và `split.mjs --seed-file` (BL-171, phần mã)

Tài liệu này là quy trình để lần chạy holdout (DBS-169) **khách quan được và kiểm lại được**. Nó không đổi cấu hình, rubric hay công thức chấm điểm: mọi tham số vẫn là tham số đã đóng băng ở [09](09-freeze-rule-config.md).

## 1. Vì sao không dùng ACL, và cách thay thế

BL-171 gốc đòi một nơi lưu nhãn holdout có quyền riêng. Repo này không có ACL kiểm được, và bộ sinh dữ liệu dùng seed công khai `dbs-split-v1` thì ai cũng sinh lại được holdout của nó, kể cả nhãn. Nên ta không cố giấu một tập đã có sẵn, mà làm cho **tập holdout chưa tồn tại tại thời điểm đóng băng**:

1. Cấu hình và mã engine đã đóng băng và đã công bố (hash ở [09 §8](09-freeze-rule-config.md#8-thông-báo-cả-nhóm)) **trước** khi seed bí mật được tạo.
2. Người giao tạo seed ngẫu nhiên, **công bố sha256 của seed** (cam kết), rồi sinh holdout từ seed đó và công bố sha256 của `holdout.csv`.
3. Sau khi chạy xong, seed được **công bố**: ai cũng sinh lại được `holdout.csv`, khớp hash đã cam kết, và kiểm lại mọi số trong báo cáo.

Thứ tự thời gian (hash đóng băng, rồi hash seed, rồi hash holdout) trên kênh chung chứng minh cấu hình không được chỉnh theo một tập dữ liệu chưa tồn tại. Đây là cam kết theo quy trình, không phải rào kỹ thuật: người giữ seed vẫn thấy được dữ liệu của mình, nên người giao và người chạy nên là hai người khi có thể.

## 2. Việc phải có trước khi giao

| # | Việc | Ai | Trạng thái |
|---|---|---|---|
| 1 | Gửi thông báo đóng băng vào kênh nhóm, ghi giờ và đường dẫn tin vào bảng [09 §8](09-freeze-rule-config.md#8-thông-báo-cả-nhóm) (BL-405). Hash trong tin là mỏ neo ngoài repo | techlead | **Cần người làm**: agent không có kênh nhóm |
| 2 | Công cụ `holdout-report` và `split.mjs --seed-file` đã merge vào `main` (amendment BL-407, §5 của 09) | Dev | PR của BL-407 |
| 3 | Quyết định BL-392 (§3) | techlead | Đã ghi ở §3 |
| 4 | Khóa OpenAI nằm trong file `.env.openai` ngoài git (`backend/env/.env.openai`, đã bị `.gitignore` chặn) | techlead | Có |

## 3. Quyết định BL-392 (hợp đồng kịch bản nằm trong `docs/`)

Hợp đồng kịch bản chi tiết ([DBS-126 §2.3](../../features/DBS-126-fraud-scenarios.md)) nằm trong `docs/`, nơi #4 đọc được, nên #4 biết cách bộ sinh dữ liệu tạo từng kịch bản. **Quyết định (techlead duyệt bằng lời trong phiên làm việc 2026-11-24): chấp nhận, không chuyển phần đó vào thư mục kín.** Hệ quả cho P5, phải nêu trong báo cáo cuối: cấu hình v4 được chỉnh bởi người đã đọc mô tả kịch bản, nên recall trên dữ liệu tổng hợp có thể cao hơn recall trên gian lận thật; holdout đo khả năng tổng quát trên một mẫu mới của **cùng bộ sinh dữ liệu**, không phải trên gian lận thật.

## 4. Người giao: sinh holdout từ seed bí mật

Chạy ở một thư mục **ngoài mọi checkout git** (ví dụ `F:\dbs-holdout\`). `split.mjs` từ chối seed và `--private-dir` nằm trong checkout. Lệnh dưới là PowerShell, chạy từ gốc repo:

```powershell
# 1. Seed ngẫu nhiên, ghi KHÔNG có dấu xuống dòng; không gõ seed vào dòng lệnh
$bytes = New-Object byte[] 24
[System.Security.Cryptography.RandomNumberGenerator]::Create().GetBytes($bytes)
New-Item -ItemType Directory -Force F:\dbs-holdout | Out-Null
[IO.File]::WriteAllText('F:\dbs-holdout\seed.txt', [Convert]::ToBase64String($bytes))

# 2. Cam kết: công bố hash này (cùng giờ gửi) TRƯỚC khi sinh holdout
(Get-FileHash F:\dbs-holdout\seed.txt -Algorithm SHA256).Hash.ToLower()

# 3. Sinh holdout. tune.csv của seed mới chỉ để lệnh chạy được, xóa ngay: không dùng để chỉnh gì
node load-tests/fraud-dataset/split.mjs --seed-file F:\dbs-holdout\seed.txt --tune-dir F:\dbs-holdout\throwaway-tune --private-dir F:\dbs-holdout\sealed
Remove-Item -Recurse -Force F:\dbs-holdout\throwaway-tune

# 4. Công bố hash của holdout (cùng giờ gửi)
(Get-FileHash F:\dbs-holdout\sealed\holdout.csv -Algorithm SHA256).Hash.ToLower()
```

Công bố trên kênh chung: hash seed, hash `holdout.csv` (kèm số khách và số giao dịch trong `sealed\manifest.json`) và giờ gửi từng tin. **Không** gửi seed, `holdout.csv` hay `simulation.json`. `simulation.json` chứa danh tính khách của holdout: giữ nó cùng chỗ với seed, không cho vào repo.

Giao `holdout.csv` cho người chạy ngoài repo (ổ đĩa riêng hoặc thư mục `sealed`). Ghi ngày giờ giao để điền vào DoD 1 của DBS-169.

## 5. Người chạy (DBS-169): đúng một lần

Từ `backend/`, Node 24. Mỗi lệnh dùng đường dẫn thật của `holdout.csv`. Lệnh `capture-ai` nạp khóa bằng `node --env-file` (không bao giờ đưa khóa vào đối số hay log); `npm` không truyền được `--env-file` qua `NODE_OPTIONS`, nên gọi `ts-node` trực tiếp.

```bash
# 0. Kiểm đóng băng: cấu hình, rubric, 37 file engine (gồm hai file của holdout-report)
npm run --silent freeze:verify

# 1. Ước lượng chi phí, không gọi API (số trong DoD: khoảng 43.000 giao dịch)
node node_modules/ts-node/dist/bin.js -r tsconfig-paths/register src/scripts/capture-ai.ts \
  --input <holdout.csv> --output <holdout-capture.jsonl> --seed dbs-split-v1 \
  --max-calls 100000 --model gpt-6-luna --normal-sample 1000000 --timeout-ms 20000 \
  --rubric-file src/modules/risk/evaluation/rubrics/r4.txt --dry-run

# 2. Một capture dùng chung cho B1 và B2 (khóa chỉ nằm trong môi trường của lệnh này)
node --env-file=<đường dẫn tới .env.openai> node_modules/ts-node/dist/bin.js -r tsconfig-paths/register src/scripts/capture-ai.ts \
  --input <holdout.csv> --output <holdout-capture.jsonl> --seed dbs-split-v1 \
  --max-calls 100000 --model gpt-6-luna --normal-sample 1000000 --timeout-ms 20000 \
  --rubric-file src/modules/risk/evaluation/rubrics/r4.txt

# 3. Capture đúng rubric, model, mẫu, trọng số; ghi responseModel vào báo cáo
npm run --silent freeze:verify -- --capture <holdout-capture.jsonl> --input <holdout.csv>

# 4. Đo ở tham số cố định: B0, B1, B2, ablation, đường PR, bootstrap. Từ chối nếu file --output đã có
npm run --silent holdout-report -- --input <holdout.csv> --capture <holdout-capture.jsonl> --output <holdout-report.json>

# 5. Đối chiếu với công cụ cũ (cùng số cho B0 và B2; không có B1, ablation, bootstrap)
npm run --silent evaluate-rules -- --input <holdout.csv> --config src/modules/risk/evaluation/configs/v4.json --config-version 4 --output <report-rule-only.json>
npm run --silent evaluate-rules -- --input <holdout.csv> --config src/modules/risk/evaluation/configs/v4-ai-r4.json --config-version 5 --ai-capture <holdout-capture.jsonl> --output <report-ai.json>
```

Quy tắc khi chạy:

- **Không chạy lại để cải thiện.** `holdout-report` từ chối ghi đè báo cáo cũ; đừng xóa báo cáo để chạy lại. Lỗi công cụ **trước khi có số** (ví dụ không đọc được file) thì sửa lỗi đó và ghi lại; một lỗi làm đổi điểm thì dừng và hỏi techlead.
- **Capture thất bại không được gọi lại sau lần thử tự động.** Giao dịch `UNAVAILABLE` giữ điểm luật như production và được đếm trong báo cáo. Tỉ lệ thất bại trên 1% làm `holdout-report` in cảnh báo; ghi nó vào báo cáo, không dùng làm cớ chạy lại.
- **Không chọn phiên bản mặc định theo kết quả holdout.** Lý do chọn `rule_only` đã nằm ở [07](07-tuning-rules.md) (tập tune) và ở báo cáo tải [DBS-174](../load-tests/07-ket-qua-b2-thoi-gian-toi-co-2026-11-22.md); holdout chỉ xác nhận hoặc phản bác.
- **Số đẹp bất thường thì kiểm rò rỉ nhãn trước khi dùng** (DoD 3). `holdout-report` tự cảnh báo khi một kịch bản ngoài tầm luật (`STRUCTURING`, `SLOW_DRIP`, `FAN_IN`) bị bắt trên 20%, hoặc recall trong tầm trên 95%. Cảnh báo là lý do dừng và xem lại, không là kết luận.
- **Nhãn không vào repo.** `holdout.csv`, capture (mẫu thưa lộ nhãn), `holdout-report.json` và hai báo cáo `evaluate-rules` mang nhãn của holdout nên ở ngoài repo cho tới khi seed được công bố (§6).

## 6. Sau khi chạy

1. Ghi vào feature doc của DBS-169: người chạy, giờ, lệnh, hash `holdout.csv` và capture, `responseModel` thật, số, cảnh báo, chi phí.
2. Công bố **seed** (nội dung `seed.txt`) và nhắc người đọc kiểm `sha256(seed)` khớp cam kết ở §4. Từ lúc này holdout là tập **đã dùng**: không dùng để chỉnh tiếp. Nếu cấu hình bị chỉnh sau lần chạy này, holdout đã thành tập tune và cần holdout mới ([09 §5](09-freeze-rule-config.md#5-quy-tắc-sau-đóng-băng-và-nhật-ký-thay-đổi), mục 3).
3. Điền cột «Holdout đã chạy chưa» ở bảng [09 §5](09-freeze-rule-config.md#5-quy-tắc-sau-đóng-băng-và-nhật-ký-thay-đổi).
4. Báo cáo P5 nêu: giới hạn BL-392 (§3), tập tune đã bị xem validation lúc chỉnh ([09 §6](09-freeze-rule-config.md#6-công-bố-về-validation-trung-thực-về-thứ-tự)), dữ liệu tổng hợp, và p95 đo ở tải (DBS-174) là phép đo riêng, không nằm trong `holdout-report`.

## 7. Chạy thử công cụ trên tập tune

`holdout-report --allow-tune` chạy được trên đúng file tune của manifest (sha256 `c387b436…6b01`) và đóng dấu `kind: "tune-dry-run"`; file khác bị từ chối. Tune tái sinh được từ seed công khai (hash khớp), không cần giao:

```bash
node ../load-tests/fraud-dataset/split.mjs --seed dbs-split-v1 --tune-dir <thư-mục-mới>   # từ backend/; không --private-dir: holdout không được ghi ra
npm run --silent holdout-report -- --allow-tune --input <thư-mục-mới>/tune.csv --capture ../docs/components/risk/evidence/ai-gate-capture-tune-r4.jsonl --output <tune-dry-run.json>
```

Capture của tune là mẫu thưa có trọng số (2.021 dòng), nên số cảnh báo/1.000 là ước lượng; số recall của B0 khớp đúng `evaluate-rules` trên cả file tune (491/1.009 fraud, trong tầm 491/631).

## 8. Kết quả chạy thử trên tune (2026-11-24, không phải kết quả holdout)

Cấu hình đóng băng, capture tune đã commit, tune tái sinh từ seed công khai. Số trên **cả file tune**, không phải trên 30% validation như [07](07-tuning-rules.md), nên không so từng số với 07:

| | B0 (`rule_only` v4) | B1 (chỉ AI, ngưỡng 0,65) | B2 (`rules_with_external_ai`) |
|---|---:|---:|---:|
| Recall tổng | 48,66% | 43,51% | 52,82% |
| Recall trong tầm | 77,81% | 69,57% | 84,47% |
| Precision | 61,64% | 28,25% | 27,34% |
| Cảnh báo/1.000 (ước lượng, mẫu thưa) | 7,84 [4,60; 11,93] | 15,30 | 19,20 [12,53; 27,27] |

- Mức tăng recall B2 − B0 trên cả tune: **4,16 điểm**, khoảng 95% [2,97; 5,45], trong tầm 6,66 điểm [4,73; 8,95]. Mục tiêu 5 điểm nằm ngoài khoảng, nên mục cổng này **không đạt** trên tune.
- Ablation (recall đổi khi bỏ một luật, B0 / B2): R1 −22,10 / −9,12 điểm; R3 −12,59 / 0; R6 −12,78 / 0; R4 −0,20 / 0; R2 và R5 0 / 0. Trên tune, bỏ R3 hoặc R6 không đổi recall của B2 vì `ai.weight` 40 bằng ngưỡng MEDIUM nên một câu trả lời AI ≥ 0,65 đủ tạo cờ một mình; và R2 (đang chiếm 85% chi phí DB, [BL-413](../../BACKLOG.md)) không đóng góp recall nào ở cả B0 lẫn B2. Precision và cảnh báo/1.000 của bảng là ước lượng có trọng số từ capture thưa (B0 thật trên cả file: precision 74,51%, 6,49 cờ/1.000).
- VELOCITY_BURST: B1 (chỉ AI) bắt 6,35% trong khi luật bắt 66,67%; AI không thấy tần suất khi nhìn từng giao dịch riêng.
- Ba kịch bản ngoài tầm vẫn 0% ở cả ba chế độ.
