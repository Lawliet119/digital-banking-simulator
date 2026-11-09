# AI Domain Review — Round 2 (2026-11-08)

**Reviewer:** Subagent `research` độc lập (`conversationId: 718f1e05-249f-4a65-ac52-174a7d24e5a3`, model `inherit`).

## Bảng phát hiện nguyên văn

| # | Severity (blocking / should-fix / minor) | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| 1 | should-fix | §3.1, §4, §7 | Khi thêm Migration bước 7 (`1793664000000-CreateDbRolesAndGrants.ts`), test suite hiện hữu `reconciliation-migration-revert.db-spec.ts` sẽ bị gãy 4 test case (`TC-116-18`, `TC-116-20`, `TC-116-21`, `TC-116-25`) khi chạy `npm run test:db` (vi phạm DoD #5: CI xanh). Test suite này trong `beforeEach` gọi `await migrate(db.url)` và assert cứng `expect(initialHistory.at(-1)?.name).toBe(TARGET)`, đồng thời gọi `cli('migration:revert')` với giả định `CreateReconciliationRuns` luôn là migration ở đỉnh. Khi Migration 7 là migration mới nhất, lệnh revert sẽ gỡ Migration 7 thay vì `reconciliation_runs`. File này chưa được đưa vào danh sách chỉnh sửa ở §3.1 để áp dụng cơ chế hoàn tác các migration kế nhiệm (`revertSuccessors`). | `backend/test/db/reconciliation-migration-revert.db-spec.ts` dòng 7, 76, 87, 92–98, 133, 228–229; `docs/features/DBS-119-db-roles-grant-matrix.md` §1 (DoD #5), §3.1 dòng 146–153; mẫu cô lập chuẩn tại `backend/test/db/outbox-schema.db-spec.ts` dòng 98–106 và `backend/test/db/append-only.db-spec.ts` dòng 166–175 | Bổ sung `backend/test/db/reconciliation-migration-revert.db-spec.ts` vào danh sách file sửa đổi ở §3.1 và kế hoạch §7: cập nhật test harness này gỡ các migration kế nhiệm (`revertSuccessors`) hoặc ghim target migration bằng `migrateThrough(db.url, TARGET)` tương tự `outbox-schema.db-spec.ts`, bảo đảm toàn bộ suite `npm run test:db` tiếp tục PASS khi có Migration 7. |
| 2 | minor | §3.2 (Guard kiểm tra username `dbs_migrator`) | Hàm `assertNotMigratorUser` kiểm tra trực tiếp `parsed.username.toLowerCase() === 'dbs_migrator'` mà không giải mã URL percent-encoding. Nếu connection URL được mã hóa ký tự (ví dụ `postgres://dbs%5Fmigrator:...`), guard sẽ bị bỏ lọt dù username thực tế là `dbs_migrator`. Codebase hiện tại nhất quán dùng `decodeURIComponent(new URL(...).username)` khi trích xuất username từ connection URL. | `docs/features/DBS-119-db-roles-grant-matrix.md` §3.2 dòng 170; `backend/test/support/outbox-migration-driver.ts` dòng 154 | Cập nhật điều kiện so sánh trong `assertNotMigratorUser` thành: `decodeURIComponent(parsed.username).toLowerCase() === 'dbs_migrator'`. |

Verdict: REVISE

