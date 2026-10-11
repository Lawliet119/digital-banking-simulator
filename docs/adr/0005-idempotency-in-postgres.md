# ADR-05: Idempotency trong PostgreSQL, theo từng user, bằng `INSERT … ON CONFLICT DO NOTHING`

| | |
|---|---|
| Trạng thái | **Accepted** |
| Ngày | 2026-10-11 |
| Người viết | #1 (Ledger) |
| Người duyệt | #4 (cặp đôi); cả nhóm |
| Liên quan | Driver D-2 · BR-07 · NFR-COR-01 · AC-5.3, 5.4, 5.5, 5.10 · [`docs/03` §6.1](../03_HIGH_LEVEL_ARCHITECTURE.md) · [database-design §4.5](../components/_shared/database-design.md) |

## Bối cảnh

Client gửi lại lệnh chuyển tiền khi timeout, mất mạng hoặc người dùng bấm hai lần. Hệ thống phải thực hiện lệnh **đúng một lần** và trả cùng một kết quả cho mọi lần gửi lại (BR-07), kể cả khi 10 bản sao đến **cùng lúc** (AC-5.4) và kể cả khi lệnh gốc bị ngắt giữa chừng (AC-5.10).

## Các phương án

| Tiêu chí | **A. Bảng `idempotency_keys` trong PostgreSQL, cùng transaction** | B. Key trong Redis (`SET NX`) | C. Không idempotency |
|---|---|---|---|
| Cùng transaction với giao dịch | **Có: key và giao dịch cùng commit hoặc cùng rollback** | Không: có khe giữa Redis và DB | — |
| Lệnh gốc rollback | **Key biến mất cùng rollback, gửi lại được xử lý như lệnh mới** | Key còn trong Redis trong khi giao dịch không tồn tại | — |
| 10 bản sao song song | **Câu `INSERT` sau chờ lệnh đầu commit, không lỗi `23505`** | Cần thêm cơ chế chờ hoặc trả 409 | Trừ tiền 10 lần |
| Redis mất dữ liệu | **Không ảnh hưởng** | Mất bảo vệ chống trùng | — |
| Chi phí | Thêm 1 INSERT và 1 UPDATE mỗi lệnh | Thêm 1 lệnh Redis | 0 |

## Quyết định

Chọn **A**:

- Bảng `idempotency_keys` có `PRIMARY KEY (user_id, idem_key)`. Key **theo từng user**, không toàn cục.
- Header `Idempotency-Key` bắt buộc cho `POST /v1/transfers` và `POST /v1/operator/deposits`. Thiếu header thì trả `400 IDEMPOTENCY_KEY_REQUIRED`. Key dài 1–128 ký tự; client nên dùng UUID v4.
- Bước đầu của transaction là `INSERT … ON CONFLICT DO NOTHING`. Nếu không chèn được, đọc `request_hash` và response đã lưu: hash khác thì trả `422 IDEMPOTENCY_KEY_REUSED`, hash giống thì trả lại đúng response cũ.
- `request_hash` là SHA-256 của method, path và body đã chuẩn hóa (sắp xếp khóa JSON), lưu dạng `char(64)`.
- Lưu response cho cả `COMPLETED` (201) và `REJECTED` (422), cùng transaction. Lỗi hệ thống thì rollback nên không lưu gì, và client gửi lại cùng key là an toàn.
- **Giữ key 7 ngày.** Job ở role `worker` xóa `created_at < now() − 7 ngày` theo lô (DBS-136). Gửi lại sau 7 ngày được coi là lệnh mới; điều này ghi rõ trong mô tả API.

## Lý do

- Chỉ khi key nằm cùng transaction với giao dịch thì "đúng một lần" mới không có khe hở. Đây là driver D-2.
- Ở READ COMMITTED, `ON CONFLICT DO NOTHING` chờ transaction đang giữ cùng key kết thúc. Lệnh đó commit thì câu lệnh sau thấy response đã lưu; lệnh đó rollback thì câu lệnh sau chèn được và chạy như lệnh mới. Không phát sinh lỗi unique, nên transaction của lệnh sau không bị hủy.
- Key theo user: nếu key duy nhất toàn cục, user A dùng trùng key của B sẽ nhận response của B, tức là lộ dữ liệu.
- 7 ngày dài hơn nhiều mọi cửa sổ retry hợp lý của client (vài phút), trong khi bảng vẫn nhỏ: khoảng 10.000 lệnh ghi/ngày × 7 ngày.

## Đánh đổi và hệ quả

- Mỗi lệnh thêm một INSERT và một UPDATE trên bảng nhỏ có khóa chính. Chi phí không đáng kể so với phần còn lại của transaction.
- Response lưu trong `jsonb` không được chứa dữ liệu nhạy cảm ngoài những gì chính user đó đã nhận.
- Client gửi cùng key sau 7 ngày sẽ tạo lệnh mới. Chấp nhận và ghi trong mô tả API.

## Cách kiểm chứng

- AC-5.3, 5.4, 5.5 trên Postgres thật, chạy song song thật bằng `Promise.all` (DBS-79, DBS-97).
- Review Focus 1: lệnh gốc rollback khi lệnh cùng key đang chờ → lệnh sau được xử lý như mới (DBS-81).
- AC-5.10 trên cloud: dừng task giữa transaction, gửi lại cùng key → đúng một giao dịch (DBS-185).
- Test bảo mật: dùng key của user khác không lộ response (DBS-159).
