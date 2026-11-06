# DBS-96 · Notification log migration

## 1. Phạm vi

Dev, Tuần 3, Medium, In Progress; DBS-20 Done theo board. Tạo storage cho notification, không tạo consumer hay API. Người dùng yêu cầu quy trình như các task trước, đã cho phép triển khai thẳng và commit/push/Draft PR. Không sửa sheet; người dùng chuyển In Progress.

## 2. Hành vi

Theo database-design §4.9: bigint GENERATED ALWAYS AS IDENTITY PK; event_id uuid NOT NULL; kind text NOT NULL chỉ transfer_completed/account_status_changed; user_id nullable FK users; message text NOT NULL; created_at timestamptz DEFAULT now() NOT NULL. Index event_id không UNIQUE: một event có thể có nhiều người nhận. Không thêm dedup hoặc retention job.

BR-13: nội dung không được nêu lý do gian lận. Ghi COMMENT trên message và hướng dẫn cho writer tương lai; schema không thể nhận diện ngữ nghĩa văn bản, không giả vờ enforce bằng blacklist SQL.

Constraint names: notification_log_pkey, notification_log_user_id_fkey (ON DELETE RESTRICT), notification_log_kind_check. Rejection assertions: 23514 + kind_check; 23503 + user_id_fkey (including referenced-user deletion); 23502 + column; 428C9 for explicit identity.

## 3. Kiến trúc

Một migration TypeORM sau append-only migration, tạo notification_log và index notification_log_event_id_idx trong transaction. Down xóa bảng notification_log; thao tác có tính phá hủy dữ liệu, chỉ dùng DB tạm trong test và không revert DB dùng chung. Không đổi table khác, dependency, env, event contract hay runtime.

## 4. Test cases

| Case | Bằng chứng mong đợi |
|---|---|
| TC-96-01 | Catalog có đúng cột/type/nullability/identity/default, PK và FK; index event_id không unique; COMMENT BR-13 |
| TC-96-02 | Insert hai kind, NULL user và user hợp lệ; id tự tăng; cùng event_id được lặp; timestamp hợp lệ |
| TC-96-03 | Kind lạ/NULL, event_id NULL, message NULL, user thiếu, id tự gán bị DB từ chối |
| TC-96-04 | Migration run→revert→run trên DB tạm; users và lịch sử migrations trước đó giữ nguyên |
| Quy trình | CI xanh, Dev khác review, merge; bảng đối chiếu trong PR |

## 5. Manual

Docker Compose PostgreSQL 17, tạo DB tạm riêng. CLI migration:run, psql \d notification_log và query comment/index; insert thông báo chung cho hai kind; thử kind lạ và message NULL trong transaction rollback; CLI migration:revert, xác nhận bảng biến mất và users còn; migration:run, xác nhận bảng có lại; xóa DB tạm. Lưu output thật, không ghi password/URL kết nối.

Executable manual: from backend, run node scripts/manual-dbs96.cjs. Script creates an isolated DB, targets CLI via process-local DATABASE_URL, asserts successful writes and rejected kind/NULL message, revert preserves users, rerun restores table, finally drops DB. Expected exit 0 and PASS for every step. Source: backend/scripts/manual-dbs96.cjs.

## 6. Domain review

Review vòng 1: REVISE (2 should-fix, 1 minor). Đã chốt constraint names notification_log_pkey/user_id_fkey/kind_check và ON DELETE RESTRICT; test SQLSTATE 23514 + kind_check, 23503 + user_id_fkey, 23502 + column, 428C9 identity; test xóa user được tham chiếu. Board snapshot mới In Progress.

Manual thực thi: tạo database tên dbs_manual_96_<hex> qua Compose psql; đặt DATABASE_URL chỉ trong process CLI trỏ đúng DB đó; npm run migration:run; psql -d <DB> -c '\d notification_log'; insert message chung và kind hợp lệ; DO block bắt check_violation/not_null_violation và in SQLSTATE, fail nếu insert được; npm run migration:revert; SELECT to_regclass('notification_log'),to_regclass('users'); npm run migration:run; DROP DATABASE <DB> WITH (FORCE). Script phải dùng tên DB sinh nội bộ, cleanup trong finally, không in URL/password. Không revert DB banking.

## 7. Kế hoạch

1. Viết notification-schema.db-spec.ts trước, chạy đỏ do chưa có migration.
2. Thêm migration CreateNotificationLog1792886400000, chạy test xanh.
3. Chạy baseline, DB tests, manual CLI/psql trên DB tạm; lưu transcript.
4. Cập nhật database-design, notification README, feature index, backlog; kiểm link, commit/push/Draft PR.

Kiểm hồi quy phát hiện suite DBS-27 gọi migrate toàn bộ và giả định migration cuối là append-only. Giới hạn ba lần migrate lên đúng prefix AddAppendOnlyTriggers1792627200002 để thêm migration tương lai không phá fixture. Không thay assertions hoặc migration cũ.

## 8. Kết quả

Migration code: `292d47e`, test regression fix `563850b`. Test-first: 3 test đỏ vì bảng chưa tồn tại (42P01/catalog rỗng); sau triển khai 4/4 test trên PostgreSQL 17 Testcontainers xanh, không skip. `lint:check`, `typecheck`, `build` đạt; unit local 769/770, một test Identity cooldown đỏ (BL-112 có sẵn); E2E 135/135 đạt. Full DB local trước sửa fixture: 327/329, hai lỗi TC-27-10/11. Sau sửa prefix, chạy lại hai suite DBS-27 + DBS-96: 29/29 đạt. [CI đầu 41430197926](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/41430197926): 5/6 jobs đạt, gồm unit; DB đỏ ở TC-27-10/11. Kết quả CI toàn bộ trên head mới xem [PR #50 checks](https://github.com/Lawliet119/digital-banking-simulator/pull/50/checks).

Manual chạy lại trên commit cuối `563850b`: mọi bước trong script đạt, kể cả ghi hai loại thông báo với user NULL, SQLSTATE 23514/23502, revert giữ users và run lại khôi phục bảng. Database tạm đã xóa. [Transcript](screenshots/DBS-96/manual-test.txt), [ảnh trích từ output thật](screenshots/DBS-96/01-manual-output.png), [review độc lập](screenshots/DBS-96/domain-review.md).

| DoD | Case | Kết quả |
|---|---|---|
| Schema, nullable user, kind | TC-96-01/02/03 | Đạt trên DB thật, gồm ON DELETE RESTRICT |
| BR-13 | COMMENT + tài liệu + TC-96-01 | Đạt phần storage; writer kiểm nội dung ở BL-138 |
| Index event_id | TC-96-01, catalog manual | Đạt, không unique |
| Revert | TC-96-04, CLI manual run→revert→run | Đạt trên DB tạm |
| CI, Dev review, merge | [Draft PR #50](https://github.com/Lawliet119/digital-banking-simulator/pull/50) | CI theo checks hiện hành; chờ review/merge, BL-137 |

BL-010 xử lý UNKNOWN_EVENT_TYPE thuộc consumer tương lai, ngoài storage migration. BL-138 bàn giao test BR-13 cho writer. BL-137 theo dõi Dev review/merge. Người dùng đã yêu cầu tiếp tục quy trình cũ, không dừng duyệt G1–G4; đã thực hiện thiết kế/review/test/manual và chỉ tạo Draft PR. Transcript không có secret; không đổi env/dependency/ADR. Lỗi dependency baseline do node_modules cũ đã giải quyết bằng npm ci, không sửa lockfile.

## 9. Tài liệu

Nguồn: [database-design §4.9](../components/_shared/database-design.md), [notification README](../../backend/src/modules/notification/README.md), [BACKLOG](../BACKLOG.md).

Đã cập nhật docs/03, database-design, notification README, feature index và backlog. Script manual được giữ ở backend/scripts/manual-dbs96.cjs để reviewer chạy lại.
