# DBS-182 · Bảng chi phí dev (Single-AZ) so với production (Multi-AZ)

> **Status:** Implemented · **Vai:** #5 Platform & Ops · **Cặp đôi review:** Dev · **Nhánh:** `docs/DBS-182-ha-cost` · **PR:** — · **Cập nhật:** 2026-11-22

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 8, Deliverable P4, Ưu tiên Medium, board "To Do". **Expect:** Trả lời được câu hỏi HA có đáng tiền không. **Thực trạng (board):** chưa có so sánh chi phí hai cấu hình bằng số thật.
- **DoD** (nguyên văn):
  1. Bảng so sánh chi phí theo giờ và theo tháng, kèm lợi ích (RTO, RPO) từ DBS-181
  2. Đưa vào P4 (capacity & cost)
  3. PR đã merge vào main; Dev review; không còn liên kết hỏng, tên bảng/cột/mã lỗi khớp các tài liệu khác (đã grep)
- **Phụ thuộc:** DBS-181 (Done: [feature doc](DBS-181-rds-failover-drill.md), khoảng 503 trên probe 14,7 s và 12,7 s, failover chưa xác nhận); DBS-179 (board «To Do», **trong repo xong, `main` #235 `0f40b496`**: đơn giá thật và `02-capacity-cost.md`).
- **Đã có gì:** `02-capacity-cost.md` §4–§5 (chi phí theo giờ và 24/7 của hai cấu hình), [DBS-180](DBS-180-rds-multi-az.md) (chênh Multi-AZ theo giờ), [DBS-185](DBS-185-ac-5-10-kill-task-cloud.md) và BL-382 (137 s khi task `api` dừng), [docs/03](../03_HIGH_LEVEL_ARCHITECTURE.md) §13.1, §14, D-7.
- **Ngoài phạm vi:** đo thêm RTO hay RPO trên AWS (BL-386, BL-388 giữ), ghép P4 (DBS-189), đổi Terraform.
- **BL đã nêu:** BL-386 (failover RDS dưới lệnh chuyển tiền), BL-388 (PITR), BL-220 (failover Valkey), BL-382 (task `api`): giữ nguyên, được trích làm giới hạn.
- **Quyết định ở G1** (agent tự quyết): (1) bảng đặt thành §8 của `02-capacity-cost.md` (một nguồn cho P4, không tạo file thứ hai); (2) tách chi phí HA theo từng yếu tố (RDS, Valkey, task `api` thứ hai) vì chỉ cấu hình đủ cả ba mới có 99,9 %; (3) không có số đo thì ghi «chưa đo» kèm BL, không bịa; RPO Multi-AZ «không mất giao dịch đã commit» ghi là thuộc tính dịch vụ theo tài liệu AWS, chưa kiểm ở dự án.

## 2. Hành vi

Đầu ra: [`02-capacity-cost.md` §8](../components/platform-infra/02-capacity-cost.md): 8.1 hai cấu hình, 8.2 chi phí và lợi ích từng yếu tố HA (theo giờ và theo tháng 24/7), 8.3 RTO và RPO kèm quy đổi ra ngân sách lỗi, 8.4 kết luận. Quy tắc: số tiền suy từ đơn giá đã trả (DBS-179 §3), số RTO chỉ từ DBS-181 và DBS-185; ô không có số đo ghi «chưa đo» và nêu BL; không kết luận hoàn vốn vì không có tần suất sự cố.

## 3. Kiến trúc

Không đổi code, Terraform hay ADR. File mới: `docs/features/DBS-182-ha-cost-table.md`, `docs/features/screenshots/DBS-182/{calc.py,manual-test.txt,domain-review.md}`. File sửa: `docs/components/platform-infra/02-capacity-cost.md` (§1 hàng mới, §7, §8), `docs/features/README.md`.

## 4. Test cases (tái tính và đối chiếu nguồn)

| ID | Truy vết | Lớp | Given · When · Then |
|---|---|---|---|
| TC-182-01 | DoD 1 | tái tính | `calc.py` · chạy · HA 0,1098/giờ và 80,14/tháng; tổng chênh 0,1358 và 99,12 = 0,2752 − 0,1394 (kiểm nội bộ) |
| TC-182-02 | DoD 1 | đối chiếu | đơn giá RDS 0,0510 và 0,1020, Valkey 0,0192 ở §8 · so với báo cáo chi phí 2026-11-22 mục 2 · khớp |
| TC-182-03 | DoD 1 | đối chiếu | khoảng 503 14,7 s và 12,7 s, lớp `db.t4g.micro` ở §8.2–§8.3 · so với `screenshots/DBS-181/manual-test.txt` · khớp; **và** §8 nói rõ AZ không đổi (`ap-southeast-1a` trước và sau) nên failover chưa xác nhận, không gọi là RTO đo từ lúc kích hoạt |
| TC-182-04 | DoD 1 | đối chiếu | cấu hình production (Multi-AZ cố định, retention 7, `desired_count` 0 hoặc 2–4, Valkey 2 node) và dev (retention 1) · so với Terraform · khớp |
| TC-182-05 | DoD 1 | đối chiếu | SLO 99,9 %, 30 ngày, ngân sách lỗi ≈ 43 phút, D-7 RTO 30 phút, RPO 5 phút · so với docs/03 · khớp; quy đổi 12,7 s → 0,49 %, 30 phút → 69,44 % |
| TC-182-06 | DoD 1 | đối chiếu | mỗi ô «chưa đo» có BL tương ứng tồn tại trong `docs/BACKLOG.md` (BL-220, 382, 386, 388) |
| TC-182-07 | DoD 2 | quy trình | §8 nằm trong `02-capacity-cost.md` (mục capacity & cost của P4), có hàng ở §1 và được `docs/components/index.md` trỏ tới |
| TC-182-09 | DoD 3 | đối chiếu | tên biến `db_multi_az`, `redis_replicas`, `desired_count`, `db_instance_class` và BL-216/220/382/386/388 ở §8 tồn tại |
| TC-182-08 | DoD 3 | quy trình + grep | `check-doc-links.mjs` sạch; `check-backlog.mjs` sạch; **Dev review chưa đạt về hình thức** |

## 5. Test thủ công (không gọi AWS)

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-182-01 | grep đơn giá trong `manual-test.txt` của DBS-179 và báo cáo 2026-11-22 | RDS small 0,0510, Multi-AZ 0,1020; Valkey 0,0192 |
| M-182-02 | grep `screenshots/DBS-181/manual-test.txt` | `db.t4g.micro`, 14.7s, 12.7s, tự phục hồi |
| M-182-03 | grep `envs/{dev,prod}/session/*.tf` | dev retention 1; prod `multi_az = true`, retention 7, `desired_count` 0 hoặc 2–4, `num_cache_clusters = 2` |
| M-182-04 | grep docs/03 và `BACKLOG.md` | D-7, §14 ≈ 43 phút, BL-382/386/388/220 tồn tại |
| M-182-05 | `PYTHONUTF8=1 python docs/features/screenshots/DBS-182/calc.py` | khớp §8 |
| M-182-06 | grep tên biến Terraform dùng ở §8; `check-doc-links.mjs`, `check-backlog.mjs` | đủ bốn biến trong `envs/dev/session/variables.tf`; 0 lỗi |

## 6. Domain review (AI)

**Reviewer:** subagent general-purpose, model opus, effort high, 2026-11-22 · **Vòng 1:** 10 phát hiện (blocking 1, should-fix 4, minor 5), verdict REVISE · [trả lời nguyên văn](screenshots/DBS-182/domain-review.md) · **Vòng 2 (diff review cuối, opus high):** 9 phát hiện (should-fix 2, minor 7), verdict REVISE, đã sửa hết: còn chỗ gọi «RTO đo» ở dependency, `calc.py` và manual-test; thêm lý do mất dữ liệu (RPO) vào §8.4; giá HA có lý do SLO là 66,12 USD; «≤ 137 s»; 0,71–0,72 USD/ngày; BL-386 ở §1 và §7; thêm tiêu chí «AZ sau ≠ AZ trước» vào BL-386

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | «RTO đo» nhưng raw DBS-181 có AZ không đổi (`1a` trước và sau), không sự kiện RDS, probe không dấu thời gian | đã sửa: §8 gọi là «khoảng 503 trên health probe», ghi failover chưa xác nhận (BL-386) ở §1, §7, §8.2–§8.4; TC-182-03 và M-182-02 kiểm AZ |
| 2 | should-fix | RTO Single-AZ «30 phút» là trần chưa kiểm | đã sửa: §8.3 nêu hai đường khôi phục và độ nhạy 10 phút 23,15 %, 60 phút 138,89 % |
| 3 | should-fix | Valkey replica không có lợi ích SLO đo được | đã sửa: §8.2 và §8.4 nói chỉ RDS Multi-AZ và task `api` thứ hai có lý do SLO; replica chưa có bằng chứng (BL-216, BL-220) |
| 4 | should-fix | phiên diễn tập tính theo `small`, thiếu `redis_replicas` | đã sửa: bảng riêng micro (0,25 và 0,42 USD) và cỡ production (0,33 và 0,55), nêu ba biến |
| 5 | should-fix | giả định quy đổi giây ra ngân sách; production «chỉ theo đợt»; thiếu 123,41 | đã sửa: §8.3 nêu giả định; §8.4 nói câu trả lời cho production giả định có ngân sách riêng và thêm 123,41 USD không HA |
| 6 | minor | 137 s đo với `deregistration_delay` 0; có số rollout 2 task ở BL-382 | đã sửa: §8.2 ghi cả hai |
| 7 | minor | chưa nêu phí bị bỏ | đã sửa: dòng «Chưa gồm phí theo tải» |
| 8 | minor | mẫu số tỉ lệ, «41,9 %», «cộng 0,41» | đã sửa: 78,8 % của 101,75; «dùng hết credit sau 2,4 tháng»; ghi rõ tổng |
| 9 | minor | retention không phải RPO | đã sửa: tách RPO (khoảng tải log, tài liệu AWS) khỏi retention (cửa sổ khôi phục) |
| 10 | minor | thiếu bước tên nhất quán, M-182-06, tiền tố tên file, domain-review.md | đã sửa: TC-182-09, M-182-06, `grep -H`, file domain-review |

**Quyết định ở G2** (agent tự quyết): duyệt §2–§5 sau vòng 1 và các sửa trên; kết luận HA được phát biểu theo mức bằng chứng (đo, thiết kế, thuộc tính dịch vụ).

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Lệnh chứng minh | Commit |
|---|---|---|---|---|
| 1 | `calc.py` | TC-182-01 | M-182-05 | gộp |
| 2 | `02-capacity-cost.md` §1, §7, §8 | TC-182-02…07 | M-182-01…04 | `docs(infra): bảng chi phí dev Single-AZ so với production Multi-AZ (DBS-182)` |
| 3 | feature doc, `manual-test.txt`, `features/README.md` | TC-182-08 | `check-doc-links.mjs`, `check-backlog.mjs` | gộp |

Rủi ro: số RTO chỉ trên `micro` và health probe; ghi rõ ở §8.4. Lùi: xóa §8 và hàng §1. Quét DoD: DoD 1 → bước 1–2; DoD 2 → bước 2 (vị trí); DoD 3 → bước 3. Không BL nào bị đóng.

## 8. Kết quả

- **Lệnh kiểm tra** (2026-11-22, trên `origin/main` `0f40b496` (đã gồm DBS-179, #235)): `check-doc-links.mjs` 0 link hỏng; `check-backlog.mjs` 0 lỗi (không đổi `BACKLOG.md`); `calc.py` khớp mọi số §8. Không đổi code nên không chạy baseline backend.
- **Đối chiếu test case** (output thô: [manual-test.txt](screenshots/DBS-182/manual-test.txt)):

| ID | Cách kiểm | Đạt? |
|---|---|---|
| TC-182-01 | M-182-05: HA 0,1098 và 80,14; tổng chênh 0,1358 = 0,2752 − 0,1394 | đạt |
| TC-182-02 | M-182-01: RDS small 0,0510, Multi-AZ 0,1020, Valkey 0,0192 khớp báo cáo 2026-11-22 | đạt |
| TC-182-03 | M-182-02: 14,7 s, 12,7 s, `db.t4g.micro`; AZ không đổi và §8 nói rõ | đạt |
| TC-182-04 | M-182-03: prod `multi_az = true`, retention 7, `desired_count` 0 hoặc 2–4, `num_cache_clusters = 2`; dev retention 1 | đạt |
| TC-182-05 | M-182-04, M-182-05: D-7, ngân sách lỗi ≈ 43 phút, quy đổi 0,49 %, 69,44 % | đạt |
| TC-182-06 | M-182-04: BL-220, 216, 382, 386, 388 tồn tại | đạt |
| TC-182-07 | §8 trong `02-capacity-cost.md`, hàng §1 | đạt |
| TC-182-08 | link và backlog sạch; **Dev review chưa đạt về hình thức** | đạt phần script; review: chưa làm (opus thay, `Techlead waiver`) |
| TC-182-09 | M-182-06: bốn biến có trong `envs/dev/session/variables.tf` | đạt |

- **DoD:** 1 (bảng theo giờ và tháng kèm RTO/RPO từ DBS-181): đạt, với RTO ghi là khoảng 503 của probe, failover chưa xác nhận; 2 (vào P4 capacity & cost): đạt, §8 của `02-capacity-cost.md`, DBS-189 sẽ ghép; 3: link và tên đạt, **Dev review chưa đạt về hình thức**.
- **Test thủ công:** M-182-01…06 đã chạy, không có bước «chưa chạy»; không gọi AWS.
- **Phạm vi so với §7:** `02-capacity-cost.md`, feature doc, `screenshots/DBS-182/{calc.py,manual-test.txt,domain-review.md}`, `features/README.md`: khớp §3.
- **Ảnh chụp:** không áp dụng.
- **Lệch so với kế hoạch:** thêm TC-182-09 và M-182-06 sau review; các bước gộp một commit. Quyết định agent tự duyệt.
- **Bàn giao:** không thêm BL. BL đã có và được trích: BL-386 (xác nhận failover, probe có dấu thời gian, chuyển tiền trong lúc failover), BL-388 (PITR, RTO Single-AZ), BL-216 và BL-220 (failover Valkey), BL-382 (task `api`).

## 9. Tài liệu đã cập nhật

- `docs/components/platform-infra/02-capacity-cost.md`: §1 hàng «HA có đáng tiền?», §7 bullet, §8 mới; `docs/features/README.md`: hàng DBS-182. Không thêm hay đóng BL.

**Quyết định ở G4** (agent tự quyết): chấp nhận không có ảnh chụp, Dev review ghi chưa đạt, kết luận HA theo mức bằng chứng; RTO không gọi là «đo» vì failover chưa xác nhận.
