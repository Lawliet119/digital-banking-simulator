# DBS-197 · Chuẩn bị câu bảo vệ 7 kèm bằng chứng

> **Status:** Implemented (sau G4) · **Vai:** Dev (tài liệu) · **Cặp đôi review:** Dev khác · **Nhánh:** `docs/DBS-197-defense-q7` · **PR:** [#203](https://github.com/Lawliet119/digital-banking-simulator/pull/203) · **Cập nhật:** 2026-11-15

## 1. Bối cảnh

- **Task trên board:** Task · Tuần 9 · Ưu tiên High · Deliverable: Bảo vệ · Status board `To Do`. **Thực trạng (board):** bằng chứng nằm trong video và log tuần 4, 8 (DLQ, outbox xử lý bù). **Expect:** trả lời câu 7 bằng bằng chứng.
- **DoD (nguyên văn):**
  1. Ghi chú câu 7 (HA và hồi phục) kèm video DLQ, video outbox gửi bù và bằng chứng failover RDS (liên kết)
  2. Luyện trả lời trước một người khác và ghi lại câu hỏi vặn đã gặp
- **Phụ thuộc (đối chiếu repo):** DBS-184 (merge 61f6a9c), DBS-181 (PR Ops #190, merge 1694d62), DBS-185 (24d4fc0): cả ba có trên `main`; board còn ghi DBS-184 To Do và DBS-181 In Review.
- **Đã có gì:** [bảng sự cố P4](../deliverables/P4-incident-table.md), [Demo 3](../demos/demo-3-failure-recovery.md), [runbook kịch bản sự cố](../runbooks/async-incident-scenarios.md), [runbook DLQ](../runbooks/dlq-redrive.md), [DBS-181](DBS-181-rds-failover-drill.md), [DBS-185](DBS-185-ac-5-10-kill-task-cloud.md), [DBS-184](DBS-184-cloud-incident-scenarios.md). **Chưa có:** văn bản câu 7 (grep `câu 7`, `câu bảo vệ` trong `docs/`: chỉ [ADR-11](../adr/0011-aws-managed-session-based.md) liệt kê «câu bảo vệ 4, 7, 8, 9» làm lý do chọn dịch vụ managed, và `team.md` của skill không gán chủ cho câu 7), video, người luyện cùng.
- **Baseline (docs-only):** `check-doc-links.mjs` → `436 files checked, 0 broken link(s)` (2026-11-15).
- **Ngoài phạm vi:** quay video, luyện với người khác (cần người thật), câu 4, 8, 9, mọi thay đổi code hoặc Terraform.
- **Quyết định ở G1 (agent tự quyết):**
  1. **Văn bản câu 7 không có trong repo** nên không bịa: ghi chú nêu rõ và trả lời chủ đề «HA và hồi phục» theo DoD.
  2. **DoD 1** làm bằng **link tới log thô** (DBS-184, DBS-185, DBS-181) thay cho video, vì video chưa có (BL-380, BL-383); ghi «video chưa» ở ghi chú.
  3. **DoD 2 chưa đạt** (cần người): ghi chú có bảng «câu hỏi vặn dự đoán, chưa gặp» để điền sau khi luyện; BL mới.
  4. **Nơi đặt:** `docs/deliverables/defense-q7-ha-recovery.md` (cạnh bản P4, link từ README deliverables).

## 2. Hành vi

Sản phẩm là một tài liệu ghi chú gồm: trả lời 30 giây; bảng sự cố (chết gì → phản ứng → phục hồi đo được → link); vì sao tiền không sai; giới hạn phải nói thẳng; câu hỏi vặn dự đoán. Mọi số liệu phải khớp tài liệu nguồn.

## 3. Kiến trúc

Chỉ tài liệu. Không đổi code, schema, Terraform. Cập nhật: `docs/deliverables/README.md` (link), `docs/features/README.md`, `docs/BACKLOG.md`.

## 4. Test cases

| ID | Truy vết | Kiểm bằng |
|---|---|---|
| TC-197-01 | DoD 1 | mọi link của ghi chú tới tài liệu và log tồn tại (`check-doc-links.mjs`) |
| TC-197-02 | DoD 1 | mọi số liệu trong bảng (131 s, 137 s, 12,7 s, 14,7 s, 9 phút 5 giây, 29 → 31 ms, 152 s, 190 s, 28 sự kiện…) khớp tài liệu nguồn (đối chiếu từng số, ghi ở §8) |
| TC-197-03 | DoD 1 | bằng chứng RDS failover, DLQ, outbox đều có link; video ghi «chưa» |
| TC-197-04 | DoD 2 | quy trình: **chưa đạt** (cần người); BL |
| TC-197-05 | tài liệu | domain review (một subagent): phát hiện về sai lệch số liệu hoặc khẳng định không có bằng chứng được sửa |

## 5. Test thủ công

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-197-01 | Mở từng link của bảng bằng trình đọc Markdown (hoặc `check-doc-links.mjs`) | không hỏng |
| M-197-02 | Đối chiếu từng con số với dòng nguồn (`grep`) | khớp |
| M-197-03 | Luyện trả lời trước một người khác | **chưa làm** (cần người) |

## 6. Domain review (AI)

**Reviewer:** subagent, model opus (effort medium, vai giảng viên khó tính), 2026-11-15 · **Kết quả:** 16 phát hiện (blocking 2, should-fix 7, minor 7), verdict **REVISE** · [trả lời nguyên văn](screenshots/DBS-197/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | bằng chứng failover RDS yếu hơn ghi chú (bản tóm tắt, AZ không đổi, chỉ probe health, không có sự kiện RDS) | đã sửa: «khoảng 503 trên health probe», nêu AZ không đổi, chưa kiểm dưới lệnh chuyển tiền; BL-386 |
| 2 | blocking | số DBS-185 đo trên cấu hình tạm, trigger, tiêu chí đổi sau lần chạy, 502 do ALB | đã sửa: mục «Giới hạn» và dòng bảng |
| 3 | should-fix | «đối soát và invariants sau mỗi sự cố» nói quá | đã sửa: liệt kê đúng chỗ đã kiểm |
| 4 | should-fix | «không có transaction dở được commit» khi failover là khẳng định chưa kiểm | đã sửa: nêu là thiết kế, chưa kiểm chứng |
| 5 | should-fix | «mỗi sự kiện chỉ áp một lần» chưa kiểm cho 28 sự kiện | đã sửa: «không bản trùng gửi đi; kiểm audit cho 1 lệnh», khử trùng ở local |
| 6 | should-fix | «25 s» của gửi lại tay sai (≈ 30 s) và lan ra DBS-184, P4, runbook | đã sửa số ở ghi chú, `DBS-184-cloud-incident-scenarios.md`, `P4-incident-table.md`, `async-incident-scenarios.md` (sai sót của DBS-184 do tôi đọc nhầm mốc) |
| 7 | should-fix | thiếu «chưa diễn tập PITR/snapshot» | đã sửa: thêm vào «Giới hạn»; BL-388 |
| 8 | should-fix | BL video RDS và BL luyện thiếu | đã thêm BL-386, BL-387; trích đúng BL-380, BL-383 |
| 9 | should-fix | «chạy thật trên AWS dev» gồm cả mục chỉ chạy local | đã sửa: liệt kê năm sự cố cloud, hai mục local |
| 10 | minor | p99 31 → 58 ms và consumer chạy ở task riêng | đã sửa |
| 11 | minor | «xả trong vài giây» chưa đo | đã sửa: «cờ sau 43 s kể từ lúc bật» |
| 12 | minor | điểm chết giữa commit và trả lời chưa thử | đã sửa |
| 13 | minor | trả lời về chi phí hai task lẫn lộn | đã sửa, trích G1 quyết định 6 của DBS-185 |
| 14 | minor | «cache tự dựng lại» không có ở DBS-100 | đã sửa: trích DBS-186, bộ đếm mất fail-open |
| 15 | minor | trích ADR-11 chưa đúng, `team.md` | đã sửa |
| 16 | minor | link hỏng `DBS-197/domain-review.md`, README chưa cập nhật | đã sửa |

**Quyết định ở G2 (agent tự quyết):** không chạy vòng review thứ hai: mọi sửa là **thu hẹp** khẳng định cho khớp bằng chứng, và tôi đã đối chiếu lại từng con số với tệp nguồn (§8); các tệp nguồn của DBS-184 được sửa số «25 s».

## 7. Kế hoạch

| Bước | File | Kiểm | Commit |
|---|---|---|---|
| 1 | `docs/deliverables/defense-q7-ha-recovery.md` | TC-197-01..03 | `docs(deliverables): ghi chú câu bảo vệ 7 (HA và hồi phục) kèm bằng chứng (DBS-197)` |
| 2 | `docs/deliverables/README.md`, `docs/features/README.md`, `docs/BACKLOG.md`, feature doc §8, §9 | `check-doc-links.mjs` | `docs: gắn ghi chú câu 7 vào deliverables, BACKLOG (DBS-197)` |

Rủi ro: ghi chú nói quá bằng chứng (dev Single-AZ, một task, mẫu nhỏ): mục «Giới hạn» và domain review chặn. Back-out: bỏ commit.

## 8. Kết quả

- **Lệnh kiểm tra:** `check-doc-links.mjs` → xem dòng G4. Đối chiếu số (TC-197-02), từng số với dòng nguồn: 131 s và 137 s ([P4](../deliverables/P4-incident-table.md), [Demo 3 E](../demos/demo-3-failure-recovery.md)); 12,7 s và 14,7 s ([DBS-181](DBS-181-rds-failover-drill.md) §3); 9 phút 5 giây, 29 s, 43 s, 4 phút 39 giây, 29 → 31 ms, p99 31 → 58 ms, 152 s, 190 s, 28 sự kiện, ≈ 30 s ([DBS-184 manual-test-cloud.txt](screenshots/DBS-184/manual-test-cloud.txt)); 2,4 s (cờ AC-9.1, cùng file). Một số sai đã tìm ra và sửa: «25 s» → «≈ 30 s».
- **Đối chiếu test case:**

| ID | Kiểm bằng | Đạt? |
|---|---|---|
| TC-197-01 | `check-doc-links.mjs` | đạt |
| TC-197-02 | đối chiếu số như trên | đạt (sau khi sửa «25 s») |
| TC-197-03 | bảng §2 của ghi chú có link RDS, DLQ, outbox, task api; video ghi «chưa» | đạt |
| TC-197-04 | luyện trả lời trước người khác | **chưa đạt** (cần người; BL-387) |
| TC-197-05 | domain review: 16 phát hiện, đã sửa hết | đạt |

- **Test thủ công:** M-197-01 (link): đạt; M-197-02 (đối chiếu số): đạt; M-197-03 (luyện): **chưa làm**, cần người thật.
- **Phạm vi so với §7:** ghi chú mới; feature doc; `domain-review.md`; `docs/deliverables/README.md`, `docs/features/README.md`, `docs/BACKLOG.md`; sửa số «25 s» trong ba tệp của DBS-184. Không có code, schema, Terraform.
- **Ảnh chụp:** không áp dụng (docs-only).
- **Lệch so với kế hoạch:** thêm sửa ba tệp DBS-184 (ngoài §7) để chữa số sai do review phát hiện; quyết định ghi ở §6.
- **Bàn giao:** **BL-386** (#5 Platform & Ops): chạy lại failover RDS có log có dấu thời gian, sự kiện RDS, lệnh chuyển tiền và video. **BL-387** (Dev, người thật): luyện câu 7 và ghi câu hỏi vặn đã gặp. **BL-388** (#5): diễn tập PITR/snapshot. **DoD 2 chưa đạt**; **DoD 1 một phần** (link log thô thay cho video).

## 9. Tài liệu đã cập nhật

- `docs/deliverables/defense-q7-ha-recovery.md` (mới), `docs/deliverables/README.md` (link), `docs/features/README.md`; sửa số «25 s» ở `docs/runbooks/async-incident-scenarios.md`, `docs/deliverables/P4-incident-table.md`, `docs/features/DBS-184-cloud-incident-scenarios.md`.
- `docs/BACKLOG.md`: thêm BL-386, BL-387, BL-388.

## Checklist G4

- [x] 4/5 test case đạt; TC-197-04 (luyện) chưa đạt vì cần người (BL-387); 0 đơn giản hóa
- [x] Test thủ công: M-197-01, 02 đạt; M-197-03 chưa làm (cần người), nêu trong PR
- [x] Ảnh chụp không áp dụng; không bí mật trong bằng chứng
- [x] `git diff --stat origin/main...HEAD` khớp §7 và lệch đã ghi
- [x] Baseline docs-only: `check-doc-links.mjs` sạch
- [x] Doc có fact bị đổi đã sửa; trạng thái Implemented
- [x] DoD chưa đạt có BL-386..388 trong `docs/BACKLOG.md`
