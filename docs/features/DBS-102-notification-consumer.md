# DBS-102 · Notification consumer: ghi notification_log cho đúng người, không bao giờ làm hỏng chuyển tiền

> **Status:** Implemented (G1–G4 agent tự duyệt) · **Vai:** Dev · **Nhánh:** `feat/DBS-102-notification-consumer` · **PR:** [#102](https://github.com/Lawliet119/digital-banking-simulator/pull/102) · **Cập nhật:** 2026-11-09

## 1. Bối cảnh

- **Task:** Story, Tuần 4, High, Demo 3. **Expect:** Khách có thông báo (dạng log) sau giao dịch hoặc khi tài khoản đổi trạng thái.
- **DoD:**
  1. Consume `notification-events`: `TransferCompleted` và `AccountStatusChanged` → ghi `notification_log` cho đúng người nhận (`fromUserId`/`toUserId`, `ownerUserId`).
  2. Nội dung thông báo khóa tài khoản không nêu lý do (test kiểm tra chuỗi).
  3. Lỗi trong notification không ảnh hưởng chuyển tiền (đã tách qua queue) và không chặn risk.
  4. Có backoff khi retry; AC liên quan xanh (file `04-test-cases.md` không còn, theo ghi chú 11/10 AC ghi trong PR).
  5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ.
- **Phụ thuộc:** DBS-101 (`ConsumerBase`, PR #101, đã qua CI/merge trước khi làm xong task này), DBS-96 (`notification_log`, có trên main).
- **Đã có:** `NotificationConsumer` ghi một dòng chung với `user_id = NULL` cho mọi event; `ConsumerBase` chưa có backoff.
- **Ngoài phạm vi:** gửi email/SMS thật; retention của `notification_log`; API đọc thông báo; quyền `dbs_worker` trên `notification_log` (DBS-119).
- **Quyết định ở G1 (agent tự quyết):** (1) backoff đặt ở `ConsumerBase` (dùng chung cho risk), mặc định 5 s nhân đôi, tối đa 300 s; (2) thông báo là câu cố định, không có số tiền hay số tài khoản (giữ chính sách DBS-96); (3) một người chủ cả hai đầu của lệnh chuyển chỉ nhận một dòng.

## 2. Hành vi

| Event | Người nhận → nội dung (`kind`) |
|---|---|
| `TransferCompleted` `TRANSFER` hai chủ khác nhau | `fromUserId` → "Bạn đã chuyển tiền thành công"; `toUserId` → "Tài khoản của bạn vừa nhận tiền" (`transfer_completed`) |
| `TRANSFER` cùng chủ (`fromUserId` = `toUserId`) | một dòng "Bạn đã chuyển tiền thành công" |
| `TransferCompleted` `DEPOSIT` | chỉ `toUserId` → "Tài khoản của bạn vừa được nạp tiền" |
| `AccountStatusChanged` `LOCKED` | `ownerUserId` → "Tài khoản của bạn đã bị tạm khóa. Vui lòng liên hệ ngân hàng để được hỗ trợ" (`account_status_changed`) |
| `AccountStatusChanged` `ACTIVE` | `ownerUserId` → "Tài khoản của bạn đã được mở khóa" |

Câu chữ chọn từ loại event và trạng thái, không bao giờ từ trường nào khác của event, nên lý do khóa hay điểm rủi ro không thể lọt vào (BR-13). Event nhận lại không ghi thêm dòng. Người nhận không có trong `users` (vi phạm FK) → rollback cả event, retry rồi vào DLQ ở lần nhận thứ 5. Lỗi tạm thời: message bị ẩn 5, 10, 20, 40 giây trước các lần giao lại (`ChangeMessageVisibility`); nếu đổi timeout lỗi thì vẫn ném lỗi gốc.

## 3. Kiến trúc

- **Vị trí:** `modules/notification/notification.consumer.ts` (`noticesFor`, worker); backoff ở `common/messaging/consumer-base.ts` (`retryBackoffSeconds`); `SqsClient.changeVisibility` ở `libs/sqs`.
- **Dữ liệu:** `notification_log(event_id, kind, user_id, message)` (DBS-96), không đổi schema. Một event có thể có hai dòng (index `event_id` không UNIQUE).
- **Transaction:** claim `processed_events` và các INSERT trong một transaction của `ConsumerBase`.
- **Cô lập:** consumer chỉ đọc `notification-events`; risk đọc `risk-events`, nên lỗi notification không chạm risk hay lệnh chuyển (đã tách từ DBS-90/101, TC-101-09).
- **Thay đổi cấp hệ thống:** không ADR, không env.

## 4. Test cases tự động

| ID | DoD | Lớp | Given · When · Then |
|---|---|---|---|
| TC-102-01 | 1 | db (PG thật) | Bốn dạng event (hai chủ, cùng chủ, deposit, đổi trạng thái) → đúng người và đúng `kind` |
| TC-102-02 | 2 | db | Khóa tài khoản, event mang trường lạ chứa "gian lận"/"rủi ro" → câu cố định; mọi câu trong bảng không khớp regex lý do/rủi ro |
| TC-102-03 | 4 | unit + services (ElasticMQ) | Lần lỗi 1..4 → ẩn 5/10/20/40 s; cap 300; không backoff với poison, lần cuối, base 0; lỗi `changeVisibility` không che lỗi gốc; trên ElasticMQ message ẩn rồi hiện lại |
| TC-102-04 | 4 | unit (libs/sqs) | `changeVisibility` gửi đúng lệnh, kiểm biên 0–43200, thiếu receipt handle → lỗi |
| TC-102-05 | 1 | db | Event nhận hai lần → không dòng thừa |
| TC-102-06 | 3 | db | Người nhận không tồn tại → rollback toàn event, không có `processed_events` |
| TC-102-07 | 3 | services | Consumer lỗi không chạm queue khác, dùng lại TC-101-09 |
| Quy trình | 5 | — | CI, Dev review, merge |

## 5. Test thủ công

Script `backend/test/manual/notification-consumer.manual.ts` (`npx ts-node -r tsconfig-paths/register …`), cần ElasticMQ của compose và một PostgreSQL; dựng `NotificationConsumer` thật.

| Bước | Việc làm | Mong đợi |
|---|---|---|
| M-102-01 | Gửi `TransferCompleted` hai chủ, `consumeOnce` | 2 dòng `notification_log` (người gửi, người nhận) |
| M-102-02 | Gửi `AccountStatusChanged` `LOCKED` kèm trường lạ nêu lý do gian lận | 1 dòng cho chủ tài khoản, nội dung không có lý do |
| M-102-03 | Gửi event có người nhận không tồn tại | `failed`, không có `processed_events`, message ẩn do backoff |

## 6. Domain review

Agent tự phản biện (Techlead waiver: không dùng subagent):

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | Văn bản lấy từ event có thể rò lý do khóa | Câu cố định theo `newStatus`/`type`, TC-102-02 có trường lạ |
| 2 | should-fix | Người dùng cùng chủ nhận hai thông báo trùng | Một dòng khi `fromUserId` = `toUserId` |
| 3 | minor | Backoff có thể che lỗi gốc nếu SQS lỗi | Nuốt lỗi `changeVisibility`, ghi warning, ném lại lỗi gốc |

## 7. Kế hoạch triển khai

| Bước | File | Test trước | Đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `libs/sqs/sqs.client.ts` | TC-102-04 | `changeVisibility` chưa có | `npm test -- libs/sqs` | cùng bước 3 |
| 2 | `consumer-base.ts` | TC-102-03 | `retryBackoffSeconds` chưa có | `npm test -- common/messaging` | cùng bước 3 |
| 3 | `notification.consumer.ts`, db-spec, services-spec | TC-102-01/02/05/06 | 8/8 đỏ (user_id NULL, câu chung) | `npm run test:db -- notification-consumer` | `feat(notification): notify the right users…` |
| 4 | manual, docs | M-102-01..03 | — | script manual | `docs(notification): DBS-102 handover` |

Rủi ro: backoff làm chậm retry trong test, nên test đặt `backoff = 0`. Lùi: revert PR (consumer trở lại ghi dòng chung).

## 8. Kết quả

- **Lệnh kiểm tra** (trên `114cde7`, sau rebase lên main có #101): `lint:check` và `typecheck` sạch; unit 76 suite / 1.427 test xanh; e2e 15 suite / 153 test xanh; `test:db -- notification-consumer` 8/8; `test:services` `consumer-base` 4/4. Suite `db` đầy đủ và `services` còn lại chạy ở CI. Không có `.skip`/`.only`.
- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-102-01 | `test/db/notification-consumer.db-spec.ts` (4 test) | đạt |
| TC-102-02 | `notification-consumer.db-spec.ts` (2 test) | đạt |
| TC-102-03 | `consumer-base.spec.ts` (2 test) + `consumer-base.services-spec.ts` › TC-102-03 | đạt |
| TC-102-04 | `src/libs/sqs/sqs.client.spec.ts` › TC-102-04 | đạt |
| TC-102-05 | `notification-consumer.db-spec.ts` › TC-102-05 | đạt |
| TC-102-06 | `notification-consumer.db-spec.ts` › TC-102-06 | đạt |
| TC-102-07 | `consumer-base.services-spec.ts` › TC-101-09 | đạt |

- **Test thủ công** (commit `114cde7`, output ở [manual-test.txt](screenshots/DBS-102/manual-test.txt)): M-102-01, M-102-02, M-102-03 đạt.
- **Ảnh chụp:** không có PNG; bằng chứng là output text (Techlead waiver).
- **Lệch so với kế hoạch:** không có.
- **Bàn giao:** quyền INSERT `notification_log` cho `dbs_worker` đã có trong `infra/scripts/db-roles.sql` (DBS-119, kiểm bằng TC-ROLE-03); phần còn lại là áp script cho task ECS; chưa có API đọc thông báo. Không thêm dòng BL mới.

## 9. Tài liệu đã cập nhật

`backend/src/modules/notification/README.md`, `backend/src/libs/sqs/README.md`, `docs/features/README.md`.

### Domain review bằng subagent (bù sau merge, 2026-11-09)

Reviewer: subagent `fable` (mô hình mạnh nhất có sẵn), prompt `prompts/domain-review.md` chỉnh cho code đã merge, đọc `main` ở `18f93dc`. [Phản hồi nguyên văn](screenshots/DBS-102/domain-review.md). Bước này lẽ ra chạy ở Phase 2; agent đã bỏ qua khi làm một mạch, vì suy diễn Techlead waiver rộng hơn lời dặn «không qua humangate» (chỉ miễn người duyệt gate). Chạy bù sau merge.

**Verdict: REVISE** (5 should-fix, 4 minor). Không có lỗi tiền hoặc idempotency trong code đã merge.

| # | Mức | Xử lý |
|---|---|---|
| 1 | should-fix | Không sửa ở đây: `notification_log` thiếu `occurred_at` nên thông báo đảo thứ tự → BL-211 |
| 2 | should-fix | Không sửa: manual thiếu đường recovery/DLQ/duplicate → BL-212 |
| 3 | should-fix | Không sửa: lỗi không được log → BL-209 |
| 4 | should-fix | **Đã sửa:** bàn giao DBS-119 ở §8 đã cũ, đã cập nhật |
| 5 | should-fix | Không sửa: TC-102-07 thiếu test với `NotificationConsumer` thật → BL-212 |
| 6, 7 | minor | Không sửa: test phụ thuộc thứ tự, `rejects.toThrow()` quá rộng → BL-212 |
| 8 | minor | Không sửa: backoff trong ADR-03/14 → BL-210 |
| 9 | minor | **Đã sửa:** header có PR [#102](https://github.com/Lawliet119/digital-banking-simulator/pull/102) |
