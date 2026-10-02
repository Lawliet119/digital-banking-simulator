# Thuật ngữ

> **Status:** Draft · **Owner:** cả nhóm · **Verified against code:** n/a · **Cập nhật:** 2026-10-03

Thuật ngữ **nghiệp vụ** (sổ cái, bút toán kép, idempotency key, hạn mức, đối soát, cờ gian lận…) nằm ở [docs/01 §10](../../01_BUSINESS_ANALYSIS.md). File này chỉ bổ sung thuật ngữ **kiến trúc** dễ nhầm.

| Thuật ngữ | Nghĩa trong dự án |
|---|---|
| **Component** | Thành phần của kiến trúc, định nghĩa theo trách nhiệm và interface. Gồm cả module code lẫn thứ không phải code của nhóm (Postgres, Redis, SQS, Cognito) và hạ tầng. |
| **Module** | Đơn vị tổ chức code: một thư mục trong `backend/src/modules/` với `index.ts` là API công khai duy nhất; ranh giới do eslint ép. |
| **Container** | Đơn vị chạy/triển khai (C4 mức 2): API, Worker, PostgreSQL, Redis, SQS… |
| **`APP_ROLE`** | Biến chọn vai trò khi khởi động: `api`, `worker` hoặc `both` ([ADR-13](../../adr/0013-one-app-app-role.md)). |
| **Sync guard** | Lớp chặn cứng (trạng thái, hạn mức, số dư) chạy trong transaction chuyển tiền, sau `FOR UPDATE`. |
| **Outbox** | Bảng `outbox_events` ghi cùng transaction với nghiệp vụ để không mất sự kiện. |
| **DLQ** | Dead-letter queue: nơi giữ message lỗi quá số lần retry (5). |
| **Snapshot** | Giá trị chụp trong event tại thời điểm giao dịch (số dư trước, ngày tạo tài khoản). |
| **Tài khoản SYSTEM `funding`** | Tài khoản nội bộ của ngân hàng, nguồn của mọi lần nạp tiền; được phép âm. |
| **`correlationId`** | Mã do server sinh, đi xuyên API → outbox → consumer → audit. |
| **ADR** | Architecture Decision Record, xem [`docs/adr/`](../../adr/README.md). |
