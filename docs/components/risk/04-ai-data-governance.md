# Quy định Quản trị Dữ liệu AI và Phê duyệt Egress (RSK-05)

> **Status:** Approved (2026-11-10) · **Vai:** #4 Fraud, Techlead & Chủ sở hữu dữ liệu · **Cập nhật:** 2026-11-10 · **Liên quan:** [ADR-14](../../adr/0014-fraud-rules-external-ai.md), [Threat Model T25](../../security/threat-model.md), [FRAUD_DETECTION_GUIDE](FRAUD_DETECTION_GUIDE.md)

---

## 1. Quyết định phê duyệt quyền gửi dữ liệu (Egress Approval)

Căn cứ theo quyết định kiến trúc [ADR-14](../../adr/0014-fraud-rules-external-ai.md), nhóm phát hiện gian lận sử dụng dịch vụ pretrained **OpenAI Decisions API** làm tín hiệu bổ sung cho 6 luật nghiệp vụ giải thích được (`R1–R6`).

Văn bản này thiết lập ranh giới quản trị dữ liệu bắt buộc giữa hệ thống Digital Banking Simulator và dịch vụ AI bên ngoài:

1. **Chỉ gửi danh sách trắng 11 trường đặc trưng số học (`FeatureInput`):**
   Mọi dữ liệu giao dịch đi ra ngoài ranh giới AWS Fargate phải đi qua hàm phóng chiếu `toAiFeatureInput` (`backend/src/modules/risk/ai/feature-projection.ts`). Tuyệt đối không gửi bất kỳ trường thông tin nào ngoài danh sách 11 trường này.

2. **Cấm tuyệt đối thông tin định danh (PII) và mốc thời gian tuyệt đối:**
   - **Cấm:** `transferId`, `eventId`, `fromAccountId`, `toAccountId`, `fromUserId`, `toUserId`, họ tên, số điện thoại, email, địa chỉ, số CMND/CCCD/hộ chiếu, số thẻ, địa chỉ IP.
   - **Cấm mốc thời gian tuyệt đối:** Không gửi `occurredAt`, `createdAt`, `fromAccountCreatedAt`. Mọi yếu tố thời gian bắt buộc phải chuyển đổi thành đại lượng tương đối (`accountAgeHours`, `minutesSinceReverse`).

3. **Nguyên tắc môi trường và dữ liệu thực:**
   - **Môi trường Dev, Test, CI:** Tuyệt đối chỉ sử dụng dữ liệu tổng hợp (`synthetic dataset` từ `generate-fraud.mjs` hoặc mock/loopback adapter).
   - **Môi trường Production (dữ liệu giao dịch thật):** Chỉ được phép kích hoạt biến môi trường `RISK_AI_EGRESS_APPROVED=true` sau khi văn bản phê duyệt này có hiệu lực và tài khoản dịch vụ OpenAI đạt điều kiện ZDR. Nếu thiếu phê duyệt, worker tự động giữ mode `rule_only` và ghi trạng thái `UNAVAILABLE`, không chặn luồng tiền.

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
   - OpenAI cam kết theo chính sách API Data Privacy: Dữ liệu gửi qua API thương mại (`/v1/*`) mặc định **không được sử dụng để huấn luyện (train/fine-tune)** các mô hình của OpenAI.
   - Endpoint sử dụng: `POST https://api.openai.com/v1/decisions` với model `gpt-6-luna`.

2. **Chính sách lưu giữ dữ liệu (Retention Policy):**
   - Mặc định của OpenAI API: Lưu giữ dữ liệu request tối đa 30 ngày phục vụ rà soát lạm dụng (abuse monitoring), sau đó bị xóa vĩnh viễn.
   - **Zero Data Retention (ZDR):** Chỉ được áp dụng đối với các tổ chức đủ điều kiện và được OpenAI xác nhận bằng văn bản phê duyệt (ZDR approval). Khi ZDR có hiệu lực, OpenAI không lưu giữ request/response payload trên đĩa sau khi hoàn tất xử lý.
   - **Quy định của dự án:** Trước khi có xác nhận ZDR chính thức từ OpenAI, hệ thống coi thời gian lưu giữ tối đa là 30 ngày; vì 11 trường đã được loại bỏ PII hoàn toàn nên rủi ro lộ lọt thông tin cá nhân khách hàng được triệt tiêu.

3. **Quản lý khóa bí mật (Secrets Management):**
   - Khóa API `OPENAI_API_KEY` được lưu trữ tập trung tại **AWS Secrets Manager**, mã hóa bằng AWS KMS.
   - Tuyệt đối cấm commit khóa API vào git, file cấu hình, container image hoặc in ra console/log.
   - Bộ lọc logger (`backend/src/common/logging/`) và `PinoLogger` được cấu hình redact tự động các header `Authorization`, `cookie` và các trường nhạy cảm.

---

## 4. Kiểm soát Vận hành & Giới hạn Ngân sách (Durable AI Gate)

Để ngăn chặn lạm dụng chi phí và từ chối dịch vụ (DoS) ngoài ý muốn, `RSK-02` đã triển khai cổng hạn mức `ai_gate_acquire` ở tầng PostgreSQL:

- **Hạn mức ngày (`daily_limit`):** Giới hạn số lượng request tối đa trong 1 ngày theo giờ UTC. Vượt hạn mức lập tức trả về `budget_exhausted` và worker tự động fallback về 6 luật thuần (`rule_only`), không làm gián đoạn hệ thống.
- **Giới hạn đồng thời (`concurrent_limit`):** Giới hạn số lượng request API đang bay đồng thời.
- **Timeout nghiêm ngặt:** Timeout gọi API tối đa 2.000 ms; nếu dịch vụ bên ngoài chậm hoặc không phản hồi, worker tự ngắt kết nối và giữ điểm luật baseline, bảo đảm thời gian xử lý sự kiện trong ngưỡng cam kết SLO.
