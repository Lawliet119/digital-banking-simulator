# Quy định Quản trị Dữ liệu AI và Phê duyệt Egress (RSK-05)

> **Status:** Proposed, chờ techlead và chủ sở hữu dữ liệu duyệt (chưa có văn bản duyệt; tác giả của PR không có thẩm quyền tự duyệt) · **Vai soạn:** #4 Fraud · **Người duyệt:** techlead, chủ sở hữu dữ liệu (chưa duyệt) · **Cập nhật:** 2026-11-11 · **Liên quan:** [ADR-14](../../adr/0014-fraud-rules-external-ai.md), [Threat Model T25](../../security/threat-model.md), [FRAUD_DETECTION_GUIDE](FRAUD_DETECTION_GUIDE.md)

---

## 1. Đề xuất quyết định về quyền gửi dữ liệu (Egress Approval), chờ phê duyệt

Căn cứ theo quyết định kiến trúc [ADR-14](../../adr/0014-fraud-rules-external-ai.md), nhóm phát hiện gian lận sử dụng dịch vụ pretrained **OpenAI Decisions API** làm tín hiệu bổ sung cho 6 luật nghiệp vụ giải thích được (`R1–R6`).

Văn bản này thiết lập ranh giới quản trị dữ liệu bắt buộc giữa hệ thống Digital Banking Simulator và dịch vụ AI bên ngoài:

1. **Chỉ gửi danh sách trắng 11 trường đặc trưng số học (`FeatureInput`):**
   Mọi dữ liệu giao dịch đi ra ngoài ranh giới AWS Fargate phải đi qua hàm phóng chiếu `toAiFeatureInput` (`backend/src/modules/risk/ai/feature-projection.ts`). Tuyệt đối không gửi bất kỳ trường thông tin nào ngoài danh sách 11 trường này.

2. **Cấm tuyệt đối thông tin định danh (PII) và mốc thời gian tuyệt đối:**
   - **Cấm:** `transferId`, `eventId`, `fromAccountId`, `toAccountId`, `fromUserId`, `toUserId`, họ tên, số điện thoại, email, địa chỉ, số CMND/CCCD/hộ chiếu, số thẻ, địa chỉ IP.
   - **Cấm mốc thời gian tuyệt đối:** Không gửi `occurredAt`, `createdAt`, `fromAccountCreatedAt`. Mọi yếu tố thời gian bắt buộc phải chuyển đổi thành đại lượng tương đối (`accountAgeHours`, `minutesSinceReverse`).

3. **Nguyên tắc môi trường và dữ liệu thực:**
   - **Môi trường Dev, Test, CI:** Tuyệt đối chỉ sử dụng dữ liệu tổng hợp (dữ liệu tổng hợp hoặc adapter loopback).
   - **Môi trường Production (dữ liệu giao dịch thật):** Chỉ được phép kích hoạt biến môi trường `RISK_AI_EGRESS_APPROVED=true` sau khi văn bản phê duyệt này có hiệu lực và tài khoản dịch vụ OpenAI đạt điều kiện ZDR. Khi chưa bật (`RISK_AI_EGRESS_APPROVED=false`, mặc định) không có lời gọi AI nào và consumer chấm bằng luật thuần (`risk-ai.service.ts`). Chỉ khi đã bật mà cổng `ai-gate` hỏng hoặc cấu hình sai thì quyết định ghi `ai_status` `UNAVAILABLE` hoặc `CONFIG_INVALID`; không chặn luồng tiền.

---

## 2. Danh mục 11 trường `FeatureInput` được phép gửi (Allowlist)

| # | Tên trường | Kiểu dữ liệu | Ý nghĩa nghiệp vụ | Rủi ro PII |
|---|---|---|---|---|
| 1 | `amount` | `string` | Số tiền giao dịch (nguyên đồng, chuỗi canonical) | Không chứa thông tin định danh |
| 2 | `fromBalanceBefore` | `string` | Số dư tài khoản nguồn ngay trước giao dịch | Không chứa thông tin định danh |
| 3 | `accountAgeHours` | `number` | Tuổi tài khoản tính bằng giờ tại thời điểm giao dịch (tối đa 720h) | Đại lượng tương đối, không lộ ngày mở tài khoản |
| 4 | `sameOwner` | `boolean` | Hai tài khoản chuyển khoản có cùng chủ sở hữu hay không | Cờ boolean, không lộ ID người dùng |
| 5 | `txCount10m` | `number` | Số lệnh chuyển đi trong cửa sổ 10 phút trước đó | Đại lượng thống kê số nguyên |
| 6 | `txCount1h` | `number` | Số lệnh chuyển đi trong cửa sổ 1 giờ trước đó | Đại lượng thống kê số nguyên |
| 7 | `historyCount30d` | `number` | Số lệnh chuyển thành công trong 30 ngày qua | Đại lượng thống kê số nguyên |
| 8 | `medianAmount30d` | `string \| null` | Trung vị số tiền trong 30 ngày qua (null nếu < 5 lệnh) | Số tiền tính toán, không lộ lịch sử chi tiết |
| 9 | `minutesSinceReverse` | `number \| null` | Số phút kể từ lệnh chuyển ngược lại gần nhất (null nếu không có) | Đại lượng tương đối tính bằng phút |
| 10 | `newRecipients1h` | `number` | Số người nhận mới chưa từng chuyển trong 30 ngày qua | Số đếm thống kê |
| 11 | `distinctRecipients24h` | `number` | Số người nhận phân biệt trong 24 giờ qua | Số đếm thống kê |

---

## 3. Điều khoản Dịch vụ Nhà cung cấp & Chính sách Zero Data Retention (ZDR)

1. **Điều khoản dịch vụ và API Data Controls:**
   - **Chưa xác minh trong repo** (ADR-14 yêu cầu người có thẩm quyền xác nhận lại trên trang điều khoản chính thức; cần dẫn URL, ngày đọc và người xác nhận trước khi duyệt). Nội dung đề xuất: OpenAI cam kết theo chính sách API Data Privacy: Dữ liệu gửi qua API thương mại (`/v1/*`) mặc định **không được sử dụng để huấn luyện (train/fine-tune)** các mô hình của OpenAI.
   - Endpoint sử dụng: `POST https://api.openai.com/v1/decisions` với model `gpt-6-luna`.

2. **Chính sách lưu giữ dữ liệu (Retention Policy):**
   - (Chưa xác minh, như trên.) Mặc định của OpenAI API: lưu giữ dữ liệu request tối đa 30 ngày phục vụ rà soát lạm dụng (abuse monitoring), sau đó bị xóa.
   - **Zero Data Retention (ZDR):** Chỉ được áp dụng đối với các tổ chức đủ điều kiện và được OpenAI xác nhận bằng văn bản phê duyệt (ZDR approval). Khi ZDR có hiệu lực, OpenAI không lưu giữ request/response payload trên đĩa sau khi hoàn tất xử lý.
   - **Quyết định còn mở (chờ chủ sở hữu dữ liệu chọn một):** (a) với dữ liệu giao dịch thật bắt buộc có xác nhận ZDR như §1.3, hoặc (b) chủ sở hữu dữ liệu chấp nhận bằng văn bản mức lưu giữ tối đa 30 ngày vì 11 trường đã bỏ định danh (giảm rủi ro, không triệt tiêu: số tiền và số dư vẫn là dữ liệu tài chính). Tài liệu này không chọn thay họ; khi chưa chọn thì §1.3 áp dụng (không bật egress cho dữ liệu thật).

3. **Quản lý khóa bí mật (Secrets Management):**
   - **Yêu cầu cho Ops (BL-043):** khóa API `OPENAI_API_KEY` được lưu tại **AWS Secrets Manager**, mã hóa bằng AWS KMS. Hiện `infra/` chưa có secret OpenAI nào; mục này chưa được triển khai.
   - Tuyệt đối cấm commit khóa API vào git, file cấu hình, container image hoặc in ra console/log.
   - Logger pino của repo (`backend/src/common/logging/logging.options.ts`, kiểm bởi `logging.options.spec.ts` và `safe-logger.spec.ts`) được cấu hình redact tự động các header `Authorization`, `cookie` và các trường nhạy cảm.

---

## 4. Kiểm soát Vận hành & Giới hạn Ngân sách (Durable AI Gate)

Để ngăn chặn lạm dụng chi phí và từ chối dịch vụ (DoS) ngoài ý muốn, `RSK-02` đã triển khai cổng hạn mức `ai_gate_acquire` ở tầng PostgreSQL:

- **Hạn mức ngày (`daily_limit`):** Giới hạn số lượng request tối đa trong 1 ngày theo giờ UTC. Vượt hạn mức lập tức trả về `budget_exhausted` và worker tự động fallback về 6 luật thuần (`rule_only`), không làm gián đoạn hệ thống.
- **Giới hạn đồng thời (`concurrent_limit`):** Giới hạn số lượng request API đang bay đồng thời.
- **Timeout nghiêm ngặt:** Timeout gọi API hữu hạn, lấy từ `ai.requestTimeoutMs` của phiên bản rule set (`rule-set.ts`, không có mặc định cố định); nếu dịch vụ bên ngoài chậm hoặc không phản hồi, adapter ngắt kết nối và quyết định giữ điểm luật baseline.
