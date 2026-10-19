# AI Domain Review: DBS-39 Testcontainers Postgres 17

| # | Severity | Section of the doc | Finding | Evidence | Suggested fix |
|---|---|---|---|---|---|
| 1 | should-fix | §2.1 & §3.1 | Trong Jest, `globalSetup` chạy trong process riêng biệt so với test worker processes. Việc chỉ gán `process.env.DATABASE_URL` trong `globalSetup` sẽ không tự động propagate sang worker processes nếu không ghi ra file tạm hoặc cấu hình biến môi trường toàn cục cho worker. | Jest docs on `globalSetup` / `globalTeardown` execution context | Cần lưu `DATABASE_URL` vào biến môi trường toàn cục của Jest thông qua file config tạm thời hoặc setupFiles để các worker processes luôn đọc được `DATABASE_URL`. |
| 2 | should-fix | §2.1 | Cần đảm bảo flag khởi động container ép timezone UTC rõ ràng cả ở cấp Postgres server parameter (`-c timezone=UTC`) chứ không chỉ biến môi trường `TZ=UTC`. | `docs/03_HIGH_LEVEL_ARCHITECTURE.md` §Database Standards: UTC timezone strictly required | Bổ sung command/parameter `-c timezone=UTC` khi khởi động PostgreSqlContainer. |
| 3 | minor | §4 | Test case TC-39-02 cần nêu rõ tên constraint trong bảng `accounts` là `chk_accounts_customer_balance_non_negative` tương ứng với migration DBS-20. | `src/database/migrations/1710000000000-InitialMigration.ts` | Ghi rõ tên constraint để assert chính xác trong test. |

Verdict: APPROVE
