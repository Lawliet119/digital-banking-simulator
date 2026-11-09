| # | Severity | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| 1 | Đã xử lý | §4 TC-114-11; §5 M05 | Thiết kế đã bổ sung kiểm chứng retry sau khi revoke: attempt đầu rollback, attempt cuối commit, chỉ một SET ngoài transaction với mốc đã commit. Không còn phát hiện cần sửa trong phần xem lại. | `docs/features/DBS-114-session-revocation.md` §4–6; `transaction.helper.ts`: rollback và chạy lại callback; `pg-error.util.ts`: SQLSTATE `40001` thuộc nhóm retryable. | Thực hiện và lưu bằng chứng TC-114-11/M05 theo kế hoạch. |

Verdict: APPROVE
