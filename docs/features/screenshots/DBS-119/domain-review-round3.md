# AI Domain Review — Round 3 (2026-11-08)

**Reviewer:** Subagent `research` độc lập (`conversationId: d76624ff-e89d-4a02-8a9c-53e7d7f76b83`, model `inherit`).

## Bảng phát hiện nguyên văn

| # | Severity (blocking / should-fix / minor) | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| 1 | should-fix | §3.1 (dòng 153) | Khi thêm Migration bước 7 (`1793664000000-CreateDbRolesAndGrants.ts`), việc chỉ bổ sung `revertSuccessors()` trong `beforeEach` của `reconciliation-migration-revert.db-spec.ts` như §3.1 mô tả là chưa đủ để giữ test suite này PASS (vi phạm DoD #5: CI xanh):<br/>1. Tại `TC-116-18`: lệnh `cli('migration:run')` (dòng 89, 111) nạp Migration 7 đang pending làm assert `catalog()` (dòng 91) lệch history, và lệnh `cli('migration:revert')` (dòng 92) hoàn tác Migration 7 thay vì `reconciliation_runs`, dẫn đến assert `to_regclass` (dòng 93–97) và `history` (dòng 98) thất bại.<br/>2. Tại `TC-116-20`, `TC-116-21` (dòng 161) và `TC-116-25` (dòng 239): lệnh `await migrate(db.url)` chạy toàn bộ migration gồm cả Migration 7, khiến assert `expect(await history()).toEqual(initialHistory)` (dòng 163, 240) thất bại do `initialHistory` chỉ chứa migration đến `TARGET`. | `backend/test/db/reconciliation-migration-revert.db-spec.ts` dòng 89, 91–98, 111, 161–163, 239–240; `docs/features/DBS-119-db-roles-grant-matrix.md` §3.1 dòng 153; `backend/test/db/outbox-schema.db-spec.ts` dòng 389–395; `backend/test/db/append-only.db-spec.ts` dòng 441–444 | Cập nhật mô tả kỹ thuật tại §3.1 làm rõ phạm vi hoàn tác:<br/>(1) Trong `TC-116-18`: gọi `await revertSuccessors()` ngay sau mỗi lần thực thi `cli('migration:run')` (tương tự mẫu chuẩn `outbox-schema.db-spec.ts` dòng 389–395 và `append-only.db-spec.ts` dòng 441–444) để ghim target migration trước khi assert `catalog()` và revert.<br/>(2) Trong `TC-116-20`, `TC-116-21` (dòng 161) và `TC-116-25` (dòng 239): thay thế `await migrate(db.url)` bằng `await migrateThrough(db.url, TARGET)` (hoặc gọi `await revertSuccessors()` ngay sau `migrate`) để history không bị nạp dư Migration 7. |

Verdict: REVISE

