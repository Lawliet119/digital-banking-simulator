# DBS-128 · Đặc trưng fraud offline

> **Trạng thái:** Đã triển khai và kiểm tra cục bộ. Đã merge vào `main` trong [PR #129](https://github.com/Lawliet119/digital-banking-simulator/pull/129) (2026-11-10, CI 6 job xanh); chưa có review GitHub của người khác tác giả. **Vai:** #4 Fraud. **Cập nhật:** 2026-11-10; trạng thái PR kiểm 2026-11-14.

## 1. Phạm vi

**Expect từ board:** “Chạy được các luật trên tập dữ liệu lớn nhanh và lặp lại được.”

`OfflineFeatureProvider` dùng cùng interface `FeatureProvider` với online, xử lý các giao dịch `TRANSFER` đã hoàn tất được cấp trong bộ nhớ. Không đọc nhãn, holdout, gọi mạng hay huấn luyện model. Caller phải cấp đủ lịch sử cần cho cửa sổ 30 ngày; không tự bịa lịch sử thiếu.

**DoD:** cùng cửa sổ và định nghĩa người nhận mới; test R1/R2/R4/R5 tính tay; xử lý 100.000 giao dịch trong vài phút; xuất `FeatureInput` 11 trường; PR được review và merge. PR #129 đã merge nhưng chưa có review của Dev khác; phần review còn mở.

## 2. Hành vi và kiến trúc

`new OfflineFeatureProvider(facts, perTxLimit)` nhận snapshot các fact bất biến. ID trùng với cùng dữ liệu được gộp; ID mâu thuẫn hoặc event không khớp fact bị từ chối. Cửa sổ theo `occurredAt`, cùng quy ước mili giây của SQL. Số tiền, tổng và trung vị dùng bigint; `extractAiInput` áp dụng mapper allowlist chung.

Index theo tài khoản/cặp, cửa sổ trượt và Fenwick tree cho phép khởi tạo O(n log n), bộ nhớ O(n), tra cứu O(log n). Không có transaction hay thay đổi schema.

**Quyết định tự duyệt:** dùng fact đã hoàn tất, không tự tải CSV hay chạm bộ generator/holdout; gọi chung mapper để tránh hai quy ước 11 trường. Kết quả chỉ tương đương online trên cùng tập fact đã commit, không chứng minh snapshot xuyên nhiều SELECT.

## 3. Kiểm thử và bằng chứng

| Nội dung | Kết quả |
|---|---|
| Unit: biên R1/R2/R4/R5, bigint, trùng ID, trước epoch, hợp đồng risk | 2 suite / 8 test đạt |
| PostgreSQL: 80 fact tổng hợp, đảo thứ tự, cùng mili giây và ranh giới thời gian | 1 suite / 1 test đạt |
| Chạy tay: 100.000 giao dịch tổng hợp, xuất 11 trường | Tạo index 713 ms; trích xuất 1.096 ms; heap 262.415.472 byte, một lần trên máy hiện tại |

Lệnh từ `backend/`: `npm test -- --runInBand --runTestsByPath src/modules/risk/features/offline-feature-provider.spec.ts src/modules/risk/risk.contract.spec.ts`, `npm run test:db -- --runInBand --runTestsByPath test/db/offline-features.db-spec.ts`, `npx ts-node -r tsconfig-paths/register test/manual/offline-features.manual.ts`. Typecheck và lint có mục tiêu cũng đạt. [Output thủ công](screenshots/DBS-128/manual-test.txt).

**Giới hạn:** dữ liệu smoke không có nhãn, không phải tập tune/holdout độc lập và không chứng minh precision/recall, chất lượng AI hay tải production. Tập tune được nhóm dataset quản lý; thư mục `backend/data/fraud/` hiện chưa được bàn giao. CI đã xanh và PR #129 đã merge; review độc lập còn chờ.
