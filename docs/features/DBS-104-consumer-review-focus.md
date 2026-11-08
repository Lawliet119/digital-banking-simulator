# DBS-104 · Review Focus 4 (consumer): cùng eventId nhiều lần, message hỏng, thứ tự đảo

> **Status:** Implemented (G1–G4 agent tự duyệt) · **Vai:** Dev · **Nhánh:** `test/DBS-104-consumer-review-focus` · **PR:** — · **Cập nhật:** 2026-11-09

## 1. Bối cảnh

- **Task:** Task, Tuần 4, High, Demo 3. **Expect:** Consumer đúng trong mọi cách message có thể sai.
- **DoD:**
  1. Gửi cùng eventId 3 lần → đúng 1 dòng `notification_log`.
  2. Message sai schema → vào DLQ sau 1 lần nhận (không retry 5 lần), consumer tiếp tục xử lý message sau.
  3. Hai message đảo thứ tự không làm lỗi; kết quả không phụ thuộc thứ tự nhận.
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ.
- **Phụ thuộc:** DBS-101 (`ConsumerBase`, đã merge #101) và DBS-102 (`NotificationConsumer`, PR #102 đã merge trước khi PR này mở).
- **Đã có:** TC-101-01..09 chứng minh khung trên consumer thử và TC-102-* chứng minh nội dung thông báo; chưa có test xuyên suốt qua queue thật cho **chính** `NotificationConsumer` với ba kiểu message sai này.
- **Ngoài phạm vi:** consumer risk (DBS-111/112); đổi code consumer (task chỉ thêm test, nếu test lộ lỗi thì sửa ở task này).
- **Quyết định ở G1 (agent tự quyết):** (1) viết thành test dịch vụ trên ElasticMQ + PostgreSQL thật vì ba kiểu sai là hành vi của hàng đợi; (2) "kết quả không phụ thuộc thứ tự" kiểm bằng cách chạy hai thứ tự trên hai hàng đợi mới và so sánh toàn bộ `notification_log`.

## 2. Hành vi được chứng minh

| Tình huống | Kết quả |
|---|---|
| Cùng event gửi 3 lần | Cả 3 message được xóa, 1 dòng `processed_events`; `AccountStatusChanged` → 1 dòng log; `TransferCompleted` hai chủ → mỗi người đúng 1 dòng |
| Xen kẽ body không phải JSON, thiếu trường, `newStatus` lạ, `amount` kiểu số với event hợp lệ | 4 message hỏng vào DLQ nguyên văn ngay lần nhận đầu, nguồn rỗng; 2 event hợp lệ sau chúng vẫn được xử lý |
| Hai thứ tự (khóa/mở khóa, lệnh cũ/mới) | Tất cả `acknowledged`; `notification_log` hai lần chạy giống hệt |

## 3. Kiến trúc

Chỉ thêm test và bước CI: `test/services/notification-consumer-review.services-spec.ts`, `test/manual/notification-consumer-review.manual.ts`, một bước trong `.github/workflows/ci.yml`. Không đổi code chạy thật, schema, env.

## 4. Test cases tự động

| ID | DoD | Lớp | Given · When · Then |
|---|---|---|---|
| TC-104-01 | 1 | services (ElasticMQ + PG) | 3 lần cùng eventId (khóa tài khoản và chuyển tiền) → đúng số dòng, 1 `processed_events`, nguồn rỗng |
| TC-104-02 | 2 | services | 4 message hỏng xen 2 hợp lệ → 4 dead-lettered ở lần nhận đầu, nội dung DLQ khớp, 2 hợp lệ xử lý |
| TC-104-03 | 3 | services | Hai thứ tự đảo → không lỗi, bảng giống hệt |
| Quy trình | 4 | — | CI, Dev review, merge |

**Kiểm chứng test có răng:** tạm bỏ dòng `if (claimed.length === 0) return false` ở `ConsumerBase`, TC-104-01 đỏ (3 dòng thay vì 1); đã khôi phục.

## 5. Test thủ công

`backend/test/manual/notification-consumer-review.manual.ts` (ElasticMQ của compose + PostgreSQL tạm).

| Bước | Việc làm | Mong đợi |
|---|---|---|
| M-104-01 | Gửi một event khóa tài khoản 3 lần | 3 `acknowledged`, 1 dòng log |
| M-104-02 | Gửi 2 message hỏng xen 2 event hợp lệ | 2 `dead-lettered`, DLQ giữ đúng 2 body, 2 event được xử lý |
| M-104-03 | Gửi 4 event theo thứ tự xuôi rồi ngược | Cùng 6 dòng log |

## 6. Domain review

Agent tự phản biện (Techlead waiver: không dùng subagent). Điểm kiểm: test phải đỏ khi bỏ dedup (đã chứng minh bằng mutation); "đảo thứ tự" của event có `occurredAt` khác nhau không đổi kết quả vì consumer thông báo không dùng giờ; không có test nào sửa assertion để xanh.

## 7. Kế hoạch triển khai

| Bước | File | Test trước | Lệnh chứng minh | Commit |
|---|---|---|---|---|
| 1 | `notification-consumer-review.services-spec.ts`, CI | TC-104-01..03 | `npm run test:services -- --runInBand --runTestsByPath test/services/notification-consumer-review.services-spec.ts` | `test(notification): review focus 4 …` |
| 2 | manual, docs | M-104-01..03 | script manual | `docs(notification): DBS-104 handover` |

Test này xanh ngay vì hành vi đã có từ DBS-101/102; chứng minh test có răng bằng mutation thay cho bước đỏ. Lùi: bỏ file test và bước CI.

## 8. Kết quả

- **Lệnh kiểm tra:** ghi dưới đây khi bàn giao.
- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-104-01 | `notification-consumer-review.services-spec.ts` (2 test) | đạt |
| TC-104-02 | `notification-consumer-review.services-spec.ts` | đạt |
| TC-104-03 | `notification-consumer-review.services-spec.ts` | đạt |

- **Test thủ công:** output ở [manual-test.txt](screenshots/DBS-104/manual-test.txt).
- **Ảnh chụp:** không có PNG; bằng chứng là output text (Techlead waiver).
- **Lệch so với kế hoạch:** không có.
- **Bàn giao:** không có.

## 9. Tài liệu đã cập nhật

`docs/features/README.md`.
