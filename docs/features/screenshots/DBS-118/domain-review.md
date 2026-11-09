| # | Severity (blocking / should-fix / minor) | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| 1 | minor | §3.2 | Chữ ký helper `migrate` được ghi là `migrate(runner)`, nhưng trong mã nguồn thực tế hàm này nhận tham số `url: string`. | `backend/test/support/temp-database.ts#L78` (`export async function migrate(url: string, direction: 'up' \| 'undoLast' = 'up'): Promise<void>`) và toàn bộ test suites (`backend/test/db/transfer-concurrency.db-spec.ts#L95`, `backend/test/db/reconciliation-job.db-spec.ts#L36`). | Đổi mô tả tại §3.2 thành `createTempDatabase() & migrate(url: string)` (hoặc `migrate(db.url)`). |

Verdict: APPROVE

