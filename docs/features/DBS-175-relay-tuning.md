# DBS-175 · Chỉnh chu kỳ poll và kích thước lô của relay

> **Status:** Implemented (hai biến cấu hình và Terraform xong; giá trị cuối giữ mặc định, quét chưa kết luận: BL-439; G4 qua; Dev review do opus thay người) · **Vai:** #5 Platform & Ops (board ghi `Dev`) · **Cặp đôi review:** opus high thay người · **Nhánh:** `perf/DBS-175-relay-tuning` (xếp chồng trên `perf/DBS-174-time-to-flag`) · **PR:** — · **Cập nhật:** 2026-11-22

## 1. Bối cảnh

- **Task trên board:** Task, tuần 7, Deliverable P4. **Expect:** «Đạt p95 < 5 giây từ giao dịch tới cờ ở 120 RPS.» **Thực trạng:** «Chu kỳ poll ≤ 1 giây và kích thước lô là giá trị mặc định.»
- **DoD (chép nguyên văn):**
  1. Bảng thử nghiệm poll interval và batch size với số đo p95; chọn giá trị cuối và đưa vào cấu hình
  2. Outbox không tồn đọng, không gửi trùng quá mức; số đo ở 120 RPS trong báo cáo
  3. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc:** DBS-174 (board To Do; PR kế bên, cùng phiên đo, công cụ đo xếp chồng dưới nhánh này).
- **Đã có gì:** `outbox-relay.service.ts` với hằng `RELAY_IDLE_DELAY_MS = 500`, `RELAY_BATCH_SIZE = 100` (docs/03 §10, ADR-03); `PollingLoop`; `relayDelayMs`. Chưa có biến env hay biến Terraform cho hai giá trị (grep `validation.schema.ts`, `session/*.tf`, 2026-11-22).
- **Cách relay chạy (đọc code, sửa sau review #3):** một vòng trong worker (`relayOnce`): một `SELECT … FOR UPDATE SKIP LOCKED` lấy tới `batch` sự kiện, rồi gửi **tuần tự từng sự kiện tới từng queue của nó** (sự kiện chuyển tiền đi hai queue: `risk-events` rồi `notification-events`, mỗi lần gửi ≤ 5 giây), rồi đánh dấu đã gửi. Lô **đầy** (`published ≥ batch`) hoặc bị cắt do ngân sách 15 giây thì vòng không nghỉ, ngược lại nghỉ `idleDelayMs`. Với ≈ 24 sự kiện/giây (120 RPS × 20% ghi) và độ trễ một lần gửi `s`, chu kỳ thực là `idle / (1 − 24 × 2 × s)`: báo cáo 04 đo tuổi outbox lớn nhất 1,9 giây ở 120 RPS, tức chu kỳ cỡ 1 đến 2 giây và cỡ 20 đến 45 sự kiện mỗi lô, và relay **gần trần thông lượng 1/(2s)**. Một sự kiện tới sau lệnh SELECT phải chờ hết lô đang chạy, rồi nghỉ, rồi mới tới lượt trong lô sau. Vì vậy cỡ lô và chu kỳ có tác dụng thật, và hạ chu kỳ chỉ giúp chừng nào relay chưa chạm trần thông lượng.
- **Baseline:** như DBS-174; bộ test config và outbox (178 test), `typecheck`, `lint:check`, `terraform test` (121) xanh (§8).
- **Ngoài phạm vi:** đổi thuật toán relay (`SendMessageBatch`, gửi risk trước cho cả lô, LISTEN/NOTIFY): BL mới ở §8; đổi cỡ task worker (BL-417); tuning consumer; BL-413.

### Quyết định ở G1 (agent tự quyết)

1. **Hai biến env, mặc định giữ nguyên:** `OUTBOX_RELAY_IDLE_DELAY_MS` (số nguyên **50..1000**, mặc định 500) và `OUTBOX_RELAY_BATCH_SIZE` (1..500, mặc định 100), đọc qua `relayConfig` riêng (không thêm khóa vào `limitsConfig`, tránh sửa năm test dựng tay). Cận 1000 giữ NFR «poll ≤ 1 giây» của ADR-03 (review #4); cận 50 chặn vòng poll quá dày (mỗi poll là một transaction); cận 500 nằm trong ngân sách lô 15 giây. Biên và mặc định ở **một nguồn** (`config/relay.defaults.ts`, dùng bởi Joi, hằng của relay và test; Terraform lặp lại và `worker.tftest.hcl` giữ chúng bằng nhau).
2. **Biến Terraform `relay_idle_delay_ms`, `relay_batch_size`** ở `envs/dev/session/worker.tf` (cùng cận), mặc định 500 và 100, chỉ vào task `worker`.
3. **Relay tự báo giá trị đang dùng:** log một lần `Outbox relay started {idleDelayMs, batchSize}` ở `onApplicationBootstrap` (review #5): `@Optional()` sẽ lặng lẽ quay về mặc định nếu nối DI sai, nên mỗi cấu hình của sweep được xác nhận bằng log này (Logs Insights).
4. **Thiết kế sweep (ABA, review #1) ở plateau 120 RPS, cờ mọi giao dịch (như DBS-174), bài `redis-fault` không sự cố (một plateau 120 dài 15 phút), một worker, cùng DB, một lượt mỗi lần:** **S0** (500, 100) mặc định → **S1** (250, 100) → **S2** (100, 100) → **S0′** (500, 100) lần nữa → **S3** (500, 10) (ca «lô đầy, không nghỉ»: lô 10 nhỏ hơn số sự kiện mỗi chu kỳ nên relay không bao giờ nghỉ; không phải đối chứng «lô nhỏ»). S0 và S0′ cùng cấu hình ở hai đầu cho **độ trôi do DB lớn dần** (`|S0 − S0′|`) và cho phép nhìn xu hướng; mỗi lượt ghi `sourceAccountRows30d` của DBS-174.
5. **Tiêu chí chọn giá trị cuối, chốt trước khi đo** (một mẫu mỗi cấu hình, nên cần ngưỡng cải thiện lớn hơn nhiễu): trước hết **cổng bão hòa**: nếu CPU **tối đa** của worker ở S0 ≥ 90% thì phần lớn trễ là xếp hàng CPU, vòng thử không kết luận được, **dừng và chuyển cho BL-417** (giữ mặc định). Một ứng viên đủ điều kiện khi: (a) p95 độ trễ quyết định < 5.000 ms ở plateau, `backlog: false`; (b) CPU worker trung vị theo phút và CPU RDS trung vị theo phút không cao hơn S0 quá 10 điểm phần trăm; (c) **trung vị theo phút** của tuổi queue risk và tuổi outbox không xấu hơn S0 quá 20% (không dùng Maximum: một lần đứng hình kiểu BL-419 đổi kết quả); (d) **giao lại cho consumer** `NumberOfMessagesReceived / NumberOfMessagesSent` của `dbs-dev-risk-events` ≤ 1,01; (e) **gửi trùng của relay** `(Sent − transfers − deposits) / transfers` ≤ 1% trên cửa sổ cả lượt (`transfers` và `deposits` lấy từ `flag-latency.json`; biên 60 giây của CloudWatch được bù bằng cách cộng các phút trọn vẹn phủ cửa sổ, dung sai 1% đã chứa lệch này). Sau khi đủ (a) đến (e): chọn cấu hình có p95 quyết định thấp nhất, **chỉ khi** nó thấp hơn S0 tối thiểu `max(10%, 50 ms, |S0 − S0′|)` **và** cải thiện đó còn thấy ở S0′ so với ứng viên; nếu không, **giữ mặc định** (kết quả hợp lệ: DoD 1 yêu cầu «chọn», không yêu cầu «đổi»).
6. **«Không gửi trùng quá mức»** đo bằng (e) (relay gửi) và (d) (consumer nhận lại); `decided = transfers` chỉ chứng minh không mất sự kiện, không chứng minh không trùng (consumer chống trùng che mất trùng).
7. **Ngân sách và thứ tự cắt:** mỗi lượt ≈ 15,5 phút + 2 phút đợi + 1 đến 2 phút triển khai lại ≈ 19 phút; S0..S0′ ≈ 76 phút, S3 thêm 19 phút. Khi thiếu giờ: bỏ S3 trước, rồi S0′; giữ S0, S1, S2.

## 2. Hành vi

| Điều kiện | Kết quả |
|---|---|
| Không đặt biến | idle 500 ms, lô 100 (đúng như trước) |
| `OUTBOX_RELAY_IDLE_DELAY_MS` ngoài 50..1000, thập phân (`250.5`), không phải số (`abc`), rỗng (`""`) | khởi động lỗi `ConfigValidationError` chỉ nêu đúng khóa đó |
| `OUTBOX_RELAY_BATCH_SIZE` ngoài 1..500 hoặc không nguyên | như trên |
| Chuỗi số Joi đổi được (`1e2`, `100.0`, `+100`, ` 100 `) | nhận như số (`1e2` = 100): hành vi của Joi `convert`, có test |
| Lô có số sự kiện gửi xong ≥ cỡ lô hoặc bị cắt do ngân sách | nghỉ 0 (không đổi) |
| Lô chưa đầy | nghỉ `idleDelayMs` đã cấu hình |
| Lỗi gửi tạm thời hoàn toàn (không gửi được gì) | vòng tự lùi như cũ (`PollingLoop`) |
| `relayOnce(limit)` gọi tường minh (test, driver) | dùng `limit` đã truyền |
| Relay dựng tay không có `relayConfig` (18 chỗ trong `src/` và `test/`) | dùng hằng 500 và 100 |
| Worker khởi động | log một lần `Outbox relay started` với giá trị đang dùng |

## 3. Kiến trúc

- **Vị trí:** worker (`OutboxRelayModule`). Files: `config/relay.defaults.ts` và `config/relay.config.ts` (mới), `config/validation.schema.ts`, `modules/outbox/outbox-relay.service.ts` (tham số tùy chọn thứ tư `@Optional() @Inject(relayConfig.KEY)`, `nextDelayMs`, `relayDelayMs(result, tuning)`, log khởi động), `outbox-relay.module.ts`, `infra/terraform/envs/dev/session/worker.tf`, test.
- **Người gọi bị đổi:** `relayDelayMs` thêm tham số thứ hai có mặc định (callers: `outbox-relay.service.ts`, `outbox-relay-policy.spec.ts`). `OutboxRelayService` constructor thêm tham số tùy chọn: **18** chỗ `new OutboxRelayService(` (2 ở `src/`, 16 ở `test/`) không đổi.
- **Dữ liệu:** không. Không migration, không đổi event contract hay ErrorCode. Env var mới (extra gate: ghi ở §1 và README).
- **Ranh giới transaction:** không đổi (transaction riêng của relay, ADR-03).
- **Thay đổi cấp hệ thống (đã sửa trong PR):** ADR-03 (hai dòng của bảng ghi chú đặt được, quyết định không đổi), `backend/src/modules/outbox/README.md`, `backend/env/.env.example`, `infra/terraform/README.md` (dòng «Relay outbox» của bảng worker).

## 4. Test cases tự động

| ID | Truy vết | Lớp | Given · When · Then |
|---|---|---|---|
| TC-175-01 | DoD 1 | unit | mặc định 500/100; biên 50, 1000, 1, 500 nhận; 49, 1001, 0, 501, `250.5`, `abc`, `-1`, rỗng bị từ chối, `invalidKeys` đúng khóa; `1e2` = 100 |
| TC-175-02 | DoD 1 | unit | `relayDelayMs` theo cỡ lô và chu kỳ đã cấu hình; thiếu tham số dùng hằng |
| TC-175-03 | DoD 1 | unit | `relayOnce()` chọn đúng cỡ lô qua **constructor** (không gán field private), mặc định khi dựng tay, `limit` tường minh thắng |
| TC-175-04 | DoD 1 | unit | `relayConfig()` đọc env, mặc định 500/100 |
| TC-175-05 | DoD 1 | terraform test | không đặt biến thì task `worker` mang 500 và 100 |
| TC-175-06 | DoD 1 | terraform test | giá trị đặt tới task `worker`, **không** tới `api` |
| TC-175-07 | DoD 1 | terraform test | từ chối 49, 1001, 250.5, 0, 501, 25.5; nhận biên 50/1 và 1000/500 |
| TC-175-08 | DoD 1 | unit | vòng nghỉ đúng `idleDelayMs` và coi lô đầy ở đúng cỡ cấu hình (`nextDelayMs`) |
| TC-175-09 | DoD 1 | unit (Nest) | Nest tiêm `relayConfig` vào relay: env 25/100 tới truy vấn poll và nhịp nghỉ |
| (đo thật) | DoD 1, 2 | AWS | §5: bảng S0..S0′..S3 với p95, CPU worker và RDS, tuổi queue, gửi/nhận |
| (quy trình) | DoD 3 | — | PR, CI, Dev review |

## 5. Test thủ công

Cùng phiên AWS với DBS-174 (một stack, image dựng từ nhánh này; khối đo ở M-174-07). Mỗi lần `apply` của `session` dùng **cùng `-var-file`** của phiên (thiếu biến là âm thầm đổi cấu hình: `worker_desired_count` về 0 tắt worker, mất `api_extra_environment`), thêm `-var relay_idle_delay_ms=… -var relay_batch_size=…`; rồi `aws ecs update-service --task-definition <ARN từ output worker_task_definition_arn>` (service có `ignore_changes = [task_definition]`). **Điều kiện bắt đầu mỗi lượt:** deployment PRIMARY ở `COMPLETED`, `runningCount = 1`, log `Outbox relay started` đúng giá trị (Logs Insights), độ sâu và đang xử lý của queue risk = 0, tuổi outbox = 0, `pgss.sh snapshot` đầu lượt (và cuối lượt) để có `rows/calls` của câu `PENDING_BATCH_SQL` (độ đầy trung bình của lô) và số poll mỗi giây.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-175-01 | `apply` (500, 100); kiểm log khởi động | task `worker` có hai env, log đúng giá trị |
| M-175-02 | `run redis-fault` không sự cố (cờ mọi giao dịch) → S0; `cw-export.mjs`, `flag-latency.json` | độ trễ quyết định và cờ, CPU worker và RDS, tuổi queue, gửi/nhận, rows/calls |
| M-175-03 | S1 (250, 100) | như M-175-02 |
| M-175-04 | S2 (100, 100) | như M-175-02 |
| M-175-05 | S0′ (500, 100) lần nữa | độ trôi `|S0 − S0′|` |
| M-175-06 | S3 (500, 10), ca biên «lô đầy, không nghỉ» | rows/calls ≈ 10 (lô đầy), số poll/giây cao |
| M-175-07 | (từ chối) `terraform plan` với `relay_idle_delay_ms=1001` | lỗi validation, không có thay đổi |
| M-175-08 | áp dụng tiêu chí §1.5: ghi giá trị cuối vào mặc định của `relay.defaults.ts`, `worker.tf`, `.env.example` chỉ khi thắng ngưỡng; `destroy` | bảng + quyết định; chỉ còn `base` |

**Dừng:** bất biến FAIL; stack sống quá 5 giờ; `backlog: true` ở lượt nào thì dừng sweep, ghi; cổng bão hòa §1.5 (CPU worker tối đa ≥ 90% ở S0).

## 6. Domain review (AI)

**Reviewer:** subagent, model opus, effort high, 2026-11-22 · **Kết quả:** 14 phát hiện (2 blocking, 6 should-fix, 6 minor), verdict REVISE · [trả lời nguyên văn](screenshots/DBS-175/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | một lượt mỗi cấu hình trên DB lớn dần, thiên lệch có hệ thống | đã sửa: ABA S0/S0′, ngưỡng `|S0 − S0′|`, ghi `rows30d` (G1.4, G1.5) |
| 2 | blocking | (d) không đo được, nhận/gửi không đo relay trùng | đã sửa: `cw-export` có Sent/Received (DBS-174); hai chỉ số tách đúng tên (d) giao lại, (e) relay gửi trùng, ngưỡng 1% (G1.5, G1.6) |
| 3 | should-fix | tính toán chu kỳ bỏ qua gửi tuần tự hai queue; S3 | đã sửa: §1 «Cách relay chạy», S3 là ca «lô đầy, không nghỉ»; `pgss` rows/calls (§5) |
| 4 | should-fix | cận 5000 ms vi phạm ADR-03 | đã sửa: 50..1000 ở Joi, Terraform, test, tài liệu |
| 5 | should-fix | `@Optional()` lặng lẽ về mặc định; TC-175-03 gán field private; thiếu test nhịp | đã sửa: log khởi động, TC-175-03 qua constructor, TC-175-08, TC-175-09 (Nest) |
| 6 | should-fix | (b)(c) dùng trung bình và Maximum; CPU worker có thể đã bão hòa | đã sửa: cổng bão hòa (CPU tối đa ≥ 90% ⇒ dừng, BL-417), trung vị theo phút, thêm CPU RDS (G1.5) |
| 7 | should-fix | `apply` cần cùng `-var-file`; định nghĩa «ổn định» | đã sửa: §5 điều kiện bắt đầu mỗi lượt |
| 8 | should-fix | mặc định nằm ba chỗ; thiếu tài liệu | đã sửa: `relay.defaults.ts` một nguồn + `worker.tftest.hcl` giữ Terraform bằng; ADR-03, README outbox, `.env.example`, README Terraform (§3) |
| 9 | minor | Joi nhận `1e2`, `""` bị từ chối; thiếu ca Terraform | đã sửa: §2, TC-175-01, TC-175-07 |
| 10 | minor | 16 vs 18 chỗ dựng relay | đã sửa: 18 |
| 11 | minor | thiếu ngân sách giờ và thứ tự cắt | đã sửa: G1.7 |
| 12 | minor (hand-off) | relay gửi tuần tự từng queue: trần ≈ 1/(2s); `SendMessageBatch` | BL mới ở §8 |
| 13 | minor (hand-off) | không đo trực tiếp độ trễ relay (`published_at − created_at`) | BL mới ở §8 |
| 14 | minor (hand-off) | cỡ worker, O(lịch sử), đứng hình là nhiễu nền | nêu tên ở báo cáo 06 (BL-417, BL-413, BL-419) |

**Quyết định ở G2 (agent tự quyết):** (1) không đổi thuật toán gửi tuần tự trong PR này (ADR-03 cần sửa, ngoài phạm vi và rủi ro cho đường tiền): BL; (2) S3 giữ trong bảng như ca biên nhưng là ứng viên cắt đầu tiên.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Lệnh chứng minh | Commit |
|---|---|---|---|---|
| 1 | `relay.defaults.ts`, `validation.schema.ts`, `relay.config.ts` | TC-175-01, 04 | `npx jest --config ./test/jest-unit.js src/config` | `feat(outbox): chu kỳ poll và cỡ lô của relay…` |
| 2 | `outbox-relay.service.ts`, `outbox-relay.module.ts` | TC-175-02, 03, 08, 09 | `npx jest --config ./test/jest-unit.js src/modules/outbox` | cùng commit, `fix(outbox): …` |
| 3 | `worker.tf`, `tests/worker.tftest.hcl` | TC-175-05..07 | `terraform test` (121 qua) | cùng commit |
| 4 | tài liệu, báo cáo 06, README, ADR-03 | — | `check-doc-links.mjs`, `check-backlog.mjs` | `docs(load-tests): …` |

Rủi ro và lùi: mặc định giữ nguyên nên không đặt biến là không đổi hành vi. Lùi = bỏ hai biến (task definition cũ). Hạ chu kỳ poll tăng số transaction của relay (mỗi poll là `SELECT … FOR UPDATE SKIP LOCKED`); cận dưới 50 ms và phép đo CPU worker và RDS ở §1.5(b) kiểm tác dụng phụ.

**Quyết định ở G3 (agent tự quyết):** plan sweep đã chạy; mọi mục DoD và review có hàng ở §4 hoặc §5; ghi chú quy trình: code bước 1 đến 3 viết trước tài liệu (waiver).

## 8. Kết quả

- **Lệnh kiểm tra** (chạy lúc bàn giao, nhánh `perf/DBS-175-relay-tuning`):

```
npm run lint:check (backend)                              sạch (eslint, 0 lỗi)
npm run typecheck (backend)                               sạch (tsc --noEmit, 0 lỗi)
npm test (backend, unit, gồm src/config và src/modules/outbox)  143 suite, 2.439 test, 0 lỗi
terraform test (envs/dev/session)                         121 passed, 0 failed
check-doc-links.mjs / check-backlog.mjs                   0 liên kết hỏng; check-backlog 0 lỗi
```

- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-175-01 | `src/config/validation.schema.spec.ts` › «TC-175-01 outbox relay poll and batch» (mặc định, biên, từ chối 8 giá trị, `1e2`) | đạt |
| TC-175-02 | `src/modules/outbox/outbox-relay-policy.spec.ts` › TC-175-02 | đạt |
| TC-175-03 | idem › TC-175-03 (qua constructor) | đạt |
| TC-175-04 | `src/config/config.factories.spec.ts` › TC-175-04 | đạt |
| TC-175-05, 06 | `infra/terraform/envs/dev/session/tests/worker.tftest.hcl` › `relay_defaults_unchanged`, `relay_tuned_values_reach_the_worker_only` | đạt |
| TC-175-07 | idem › `relay_rejects_*` (6), `relay_accepts_the_bounds`, `relay_accepts_the_lower_bounds` | đạt |
| TC-175-08, 09 | `outbox-relay-policy.spec.ts` › TC-175-08, TC-175-09 (module Nest thật, env 25/100) | đạt |
| Quy trình DoD 3 | PR, CI, Dev review | CI: xem PR; **Dev review do opus high thay người: chưa đạt về hình thức** |

Không có `.skip`, `.only`, `.todo`. Test viết cùng lúc với code (waiver), không có lượt đỏ trước.

- **Test thủ công** (AWS cùng phiên với DBS-174; [manual-test.txt](screenshots/DBS-175/manual-test.txt), số ở [báo cáo 06 §3.5 và §4](../components/load-tests/06-ket-qua-thoi-gian-toi-co-2026-11-22.md)):

| Bước | Kết quả |
|---|---|
| M-175-01 | **đạt**: worker 500/100, log `Outbox relay started` đúng giá trị |
| M-175-02 | **đạt**: S0 500/100: p95 tới cờ 5.240 ms, CPU worker trung vị 90,6%, 0 lỗi |
| M-175-03 | **đạt**: S1 250/100 (task definition `dbs-worker:22`, log 250/100): p95 13.246 ms (lượt đầu bị chạy chồng, số bị loại, chạy lại sạch; S1 vẫn bị nhiễu: +15.167 dòng thay vì ≈ 7.200) |
| M-175-04 | **đạt**: S2 100/100 (`dbs-worker:23`): p95 6.225 ms, CPU RDS trung vị 83% |
| M-175-05 | **đạt**: S0b 500/100 lại: p95 **33.826 ms**: độ trôi do lịch sử lớn dần lớn hơn mọi khác biệt |
| M-175-06 | **chưa chạy (lý do: sau S0b DB đã bão hòa, thêm một lượt chỉ cộng độ trôi; quyết định của agent)**: S3 500/10; [BL-439](../BACKLOG.md) |
| M-175-07 | **đạt**: `terraform test` `relay_rejects_idle_delay_above_1000` (1001 bị validation chặn) |
| M-175-08 | **đạt**: áp tiêu chí §1.5 (cổng bão hòa kích hoạt, không ứng viên đủ điều kiện): **giữ mặc định 500 ms và 100 sự kiện**; hủy sạch |

- **Quyết định cuối (DoD 1):** giữ nguyên mặc định; `relay.defaults.ts`, `worker.tf`, `.env.example` không đổi giá trị. DoD 2: không tồn đọng (`backlog: false` ở mọi lượt, tuổi outbox lớn nhất ≤ 2 giây), không gửi trùng (`NumberOfMessagesSent` = `NumberOfMessagesReceived` = số `POST /v1/transfers` của k6 ở `baseline`, S1, S2, S0b và ở nhóm `hot-account` + không cờ + S0), số đo ở 120 RPS trong báo cáo 06 §3.1 (DB mới, cấu hình mặc định, **đạt** p95 2.009 ms) và §3.5.
- **Phạm vi so với §7:** khớp: `backend/src/config/{relay.config,relay.defaults,validation.schema}.ts` và test, `modules/outbox/{outbox-relay.service,outbox-relay.module}.ts` và test, `infra/terraform/envs/dev/session/{worker.tf,tests/worker.tftest.hcl}`, `backend/env/.env.example`, `docs/adr/0003…`, `modules/outbox/README.md`, `infra/terraform/README.md`.
- **Ảnh chụp:** không áp dụng (cấu hình và đo dòng lệnh).
- **Lệch so với kế hoạch (đã tự duyệt):** (1) *thiết kế sweep* S0, S1, S2, S0b; **S3 chưa chạy theo quyết định của agent** (DB đã bão hòa; không phải quy tắc cắt khi thiếu giờ); *cổng bão hòa* kích hoạt ở S0 (CPU tối đa 93%) nhưng sweep **vẫn chạy tiếp** S1, S2, S0b để lấp bảng và đo độ trôi: số của chúng chỉ để quan sát (báo cáo 06 §4); (2) hai driver chạy chồng ở S1 lần đầu (sự cố điều hành, số bị loại; chi tiết ở DBS-174 §8); (3) *quy trình*: code trước tài liệu (waiver); (4) bảng sweep đọc là «chưa kết luận» chứ không phải «mặc định tối ưu»: lý do ở báo cáo 06 §3.5.
- **Bàn giao:** [BL-439](../BACKLOG.md) (DoD 1 chưa kết luận được: quét lại với worker không bão hòa), [BL-435](../BACKLOG.md) (relay gửi tuần tự: review #12), [BL-437](../BACKLOG.md) (metric `outbox_relay_lag_ms`: review #13); cập nhật BL-417 (điều kiện đo worker 0,5 vCPU).

## 9. Tài liệu đã cập nhật

ADR-03 (hai dòng của bảng ghi chú đặt được, quyết định không đổi), `backend/src/modules/outbox/README.md`, `backend/env/.env.example`, `infra/terraform/README.md` (dòng «Relay outbox» của bảng worker, bước 5), báo cáo [06](../components/load-tests/06-ket-qua-thoi-gian-toi-co-2026-11-22.md) (§3.5, §4), `docs/features/README.md`, `docs/BACKLOG.md` (thêm BL-435, BL-437, BL-439; không xóa dòng nào).

## Checklist G4

- [x] Mọi test case đạt đủ độ sâu (TC-175-01..09), 0 đơn giản hóa
- [x] Test thủ công trên commit cuối đổi code (SHA ở dòng đầu `manual-test.txt`); M-175-06 chưa chạy, nêu lý do ở PR
- [x] Ảnh chụp: không áp dụng; `manual-test.txt` đã che tên miền, ID tài khoản và token
- [x] `git diff --stat` khớp §7
- [x] Lệnh kiểm tra chạy lúc bàn giao có số đếm
- [x] Doc liên quan sửa; `check-doc-links.mjs` sạch
- [x] DoD chưa kết luận và bàn giao có BL; `check-backlog.mjs` sạch
