## Thay đổi gì

Dashboard `dbs-dev-overview` đủ chỉ số theo DoD của DBS-178 (21 → 33 widget) và công cụ chụp ảnh dashboard lặp lại được; đã `terraform apply` thật và chụp ở 120 RPS hai lượt (Redis bật và tắt, cùng phiên DBS-167).

- **Dashboard** (`infra/terraform/envs/dev/session/dashboard.tf`): thêm widget trạng thái alarm (`type = "alarm"`, 20 ARN dựng từ chuỗi để dashboard vẫn không tham chiếu tài nguyên session và `-target` vẫn đúng), probe `/health/ready`, request/giây với đường 120, độ sâu hàng đợi chính, consumer retry/dead_letter, quyết định risk theo `AiStatus`, tiêu đề năm nhóm và ghi chú «Cách đọc». Không đổi tên dashboard, tên widget cũ hay bộ dimension.
- **Công cụ chụp** (`infra/scripts/dashboard-snapshot.mjs`): đọc dashboard rồi vẽ từng widget metric bằng `get-metric-widget-image` trong khung thời gian tuyệt đối; chỉ đọc; `singleValue` vẽ thành đường; `text` và `alarm` bỏ qua; ARN và ID tài khoản được che; thoát 0/1/2. Test Node với `aws` giả, thêm vào bước `node --test` của job `unit`.
- **Ảnh 120 RPS:** 50 PNG ở `docs/components/observability/screenshots/120rps-redis-on/` và `120rps-redis-off/`, nhận xét ở feature doc §8 và brief observability.

Task: DBS-178
Feature doc: docs/features/DBS-178-dashboard-complete.md

## Loại thay đổi

- [ ] Tính năng mới
- [ ] Sửa lỗi
- [x] Hạ tầng / CI
- [x] Tài liệu / ADR
- [x] Test

## Liên quan tới

docs/03 §14 (SLO, dashboard), NFR-SCAL-01 (120 RPS), BL-262, BL-404, BL-409 (thêm alarm `dlq-oldest-age` khi apply base).

## Đối chiếu test case

| DoD / AC | Test | Khớp? |
|---|---|---|
| DoD 1: dashboard có p95, error rate, độ sâu queue/DLQ, `redis_fallback_total`, trạng thái health, chỉ số cảnh báo fraud | `dashboard.tftest.hcl`: `dashboard_shape`, `dashboard_alarm_status_widget`, `dashboard_alarm_arns_follow_account`, `dashboard_health_probe_widget`, `dashboard_queue_depth_widget`, `dashboard_rps_and_slo_widgets`, `dashboard_risk_decisions_and_consumer_widgets`, `dashboard_covers_dod`, `dashboard_layout_and_notes` (TC-178-01..08); `dashboard_labels_are_safe` và các run cũ (TC-178-09, 10): `terraform test` 111 passed, 0 failed | khớp |
| DoD 1 (chống trôi tên alarm) | `dashboard-snapshot.test.mjs` › `alarmContract` trên `alarms.tf` thật và 5 ca đột biến (TC-178-20) | khớp |
| DoD 2: ảnh lúc chạy tải 120 RPS lưu `docs/components/observability` | công cụ: TC-178-11..17, 14b, 21, 22 (23 test Node, 23 pass); ảnh: M-178-07, M-178-08 (50 PNG, 0 lỗi) | khớp ở dạng PNG dựng bằng API; **ảnh console AWS chưa có** (BL-262, BL-404, M-178-09) |
| DoD 3: PR merge, CI xanh, Dev review, bảng này | TC-178-18 | **chưa làm** (quy trình): xem Techlead waiver |

## Kiểm tra

- [x] Chạy được ở local: `terraform test` và `node --test` không cần Docker hay AWS
- [x] Có test; không đụng logic tiền
- [ ] CI xanh (chờ chạy khi mở PR)
- [x] Không có secret trong code, log, commit (quét `grep -rEal "[0-9]{12}|amazonaws\.com|arn:aws|elb\."` trên ảnh và `manual-test.txt`: không tệp text nào khớp; 1 PNG khớp giả do chuỗi byte nén `888888888888`)
- [x] Feature doc đủ mục 1–9 (4 gate tự duyệt), test thủ công chạy (bước chưa chạy ở dưới), ảnh ở `docs/features/screenshots/DBS-178/` và `docs/components/observability/screenshots/`
- [x] Đã cập nhật tài liệu: brief observability, `infra/terraform/README.md`, docs/03 §14, `docs/features/README.md`, `docs/BACKLOG.md` (câu chữ BL-262 và BL-404)

Hủy stack (người điều phối, `teardown.txt`): stack hủy xong 2026-11-22 08:37:37 +07 (`destroy` session 66 tài nguyên 08:29:28 đến 08:36:44, loadgen 21 tài nguyên đến 08:37:29); `verify-clean.sh` thoát 0 («sạch (13 loại)»: NAT, ALB, RDS, snapshot, ElastiCache, ECS, EIP, ENI, WAF, endpoint, backup, EBS); client Cognito chỉ còn `dbs-app` giống hệt trước; NACL riêng đã xóa; state tạm đã xóa; `plan` của `base` sau khi hủy giống trước (không drift) — nguồn: `teardown.txt` của người điều phối.

Lệnh đã chạy lúc bàn giao (mã cuối đổi code `dc44e19b`): `terraform init -backend=false && fmt -check -recursive && validate && test` → 111 passed, 0 failed (baseline trước task: 103); `node --test load-tests/test/dashboard-snapshot.test.mjs` → 23 pass, 0 fail, 0 skipped; `check-doc-links.mjs` → 504 tệp, 0 hỏng; `check-backlog.mjs` → 105 dòng, 0 lỗi.

## Ghi chú cho người review

**Bước chưa chạy (cần nêu theo quy trình):**
- **M-178-09:** ảnh console AWS của widget `alarm`, hai ô `singleValue` cờ/1.000 giao dịch và bố cục: phiên tự động không có màn hình hay Chrome. BL-262 và BL-404 giữ, câu chữ đã cập nhật.
- **M-178-06 (một phần):** `put-dashboard` lên tên tạm rồi `delete-dashboards`, và cách widget `alarm` xử lý alarm không tồn tại: stack đã hủy (không có ca nào, 20/20 alarm tồn tại lúc apply). Phần đã đạt: `apply` thật thành công 0 lỗi, `get-dashboard` trả 33 widget.
- Bốn lệnh backend không chạy (không đổi `backend/`); `runner.test.mjs` của `load-tests` đỏ trên máy này vì worktree không có `backend/node_modules` (CI có `npm ci`).

**Quyết định agent tự chốt (không có human gate):**
1. Trạng thái health = hai widget bổ sung nhau: widget alarm (20 ARN dựng từ chuỗi) và probe `/health/ready`; ghi rõ ở «Cách đọc» rằng Redis chết **không** làm probe lỗi (`/health/ready` trả 200 với `redis: degraded`) mà chỉ thấy ở `redis_fallback_total`, và số fallback của api gồm cả lượt `ping` của chính probe.
2. Widget alarm **không** gồm hai alarm `dlq-oldest-age` vì chưa apply ở base (BL-409); chống trôi bằng test `terraform test` (liệt kê alarm session) và test Node `alarmContract` (đọc `alarms.tf` của `session` và `base`).
3. Chỉ số fraud: giữ các widget cũ, thêm quyết định risk theo `AiStatus`; không thêm widget cho `risk_ai_call_duration_ms` (không có SLO).
4. Công cụ chụp: `singleValue` vẽ thành `timeSeries` (API không vẽ được ô số); `period` lớn hơn khung chụp bị hạ (cả trong `SEARCH(…, N)`) kèm hậu tố tiêu đề; tệp MetricWidget thuần ASCII (lỗi cp1252 của AWS CLI trên Windows với tiêu đề có dấu, phát hiện khi thử thật, có test tái hiện).
5. Dừng domain review ở hai vòng (opus, effort high, 0 blocking, mọi should-fix/minor đã sửa trong doc): [domain-review.md](domain-review.md).
6. Sửa một dòng docs/03 §14 và câu chữ BL-262, BL-404 (ngoài danh sách tài liệu ở thiết kế): ghi ở feature doc §8 «Lệch so với kế hoạch» số 4, 5.

**Chỗ cần xem kỹ:**
- `dbs-dev-redis-fallback` trong `alarm-history.txt` của DBS-167 chuyển OK → ALARM lúc 06:59:53 +07 (= 23:59:53 UTC ngày 21), **trước** lượt đối chứng (00:04:52 UTC) và trước lúc tiêm sự cố (00:44:00 UTC), và không có dòng ALARM → OK sau đó. Lần kêu này không phải do lượt Redis tắt đã chụp; nguyên nhân chưa xác định. Không dùng làm bằng chứng «alarm kêu đúng lúc Redis tắt».
- Số trên ảnh là phía máy chủ theo bucket 5 phút (phân vị CloudWatch ước lượng quanh biên bucket); số k6 phía máy khách ở báo cáo tải DBS-167: khác nguồn đo, không so trực tiếp. Lượt Redis tắt: p99 chuyển tiền chạm đường 1 s (≈ 1.020 ms ở điểm 00:40, phần lớn trước sự cố).
- `redis_fallback_total` lượt Redis bật không tuyệt đối 0 (≈ 0): `/health/ready` ping Redis và có vài `TIMEOUT` lẻ.
- Điểm cuối của widget «Lưu lượng» giảm (≈ 75 ở bucket cuối): chưa giải thích được, không ảnh hưởng kết luận.
- Cách test thủ công: M-178-01..05 chạy lại được từ `docs/features/screenshots/DBS-178/manual-test.txt` (lệnh ở đó); chụp lại: `node infra/scripts/dashboard-snapshot.mjs --profile dbs --start <ISO Z> --end <ISO Z> --out <thư mục>`.

Techlead waiver: không qua human gate G1..G4 và Dev review (thay bằng domain review AI), feature doc tự duyệt, merge không qua người duyệt; không push `main` và không sửa board.

🤖 Generated with [Claude Code](https://claude.com/claude-code)
