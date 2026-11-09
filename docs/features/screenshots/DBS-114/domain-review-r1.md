| # | Severity | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| 1 | should-fix | §4, TC-114-02/03/09 | Chưa có ca kiểm chứng retry chỉ publish kết quả của attempt đã commit. Ca rollback hiện tại dùng lỗi audit, không kiểm đường `40P01`/`40001` chạy lại callback. | §2 cam kết retry chỉ publish outcome đã commit; `backend/src/database/transaction.helper.ts`, `withTransaction`, thực sự chạy lại callback khi gặp lỗi retryable; CONTRIBUTING §5 cấm lặp tác dụng phụ ngoài transaction. | Bổ sung ca PostgreSQL thật: attempt đầu đã cập nhật mốc rồi gặp lỗi retryable và rollback, attempt sau commit; quan sát không SET từ attempt đầu, chỉ SET mốc trả về của attempt cuối, bên ngoài `activeTransactionContext`. |

Verdict: REVISE
