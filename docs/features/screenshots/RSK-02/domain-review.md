### Finding

**title:** Require READ COMMITTED before checking gate history  
**priority:** 2  
**confidence:** 0.98  
**file_path:** `/home/dylan/Code/dbs-fraud-runtime-v2/backend/src/database/migrations/1795000001000-CreateAiGate.ts`  
**line_start:** 60  
**line_end:** 67  
**body:** Trong transaction `REPEATABLE READ`, đọc `ai_gate_permits` khi còn rỗng; từ connection khác acquire một permit và commit; sau đó gọi `down()` trong transaction đầu. Khóa bảng không làm mới snapshot, nên cả hai `EXISTS` vẫn trả false và migration xóa lịch sử quota cùng permit đã commit. Điều này phá bảo vệ chống reset quota. Cần từ chối isolation khác READ COMMITTED trước khi khóa, theo mẫu migration audit/outbox hiện có, và thêm regression test cho trình tự này.

**overall_correctness:** incorrect  
**explanation:** Hoàn tất review tĩnh adapter, gate/migration, env, RiskAiService, consumer và tests; phát hiện một lỗi rollback có thể xóa reservation đã commit. Không sửa file, chạy test/lint/build/formatter hoặc gọi hệ thống bên ngoài.  
**confidence:** 0.95

---

Không còn finding trong phạm vi re-review.

- `CreateAiGate.down()` kiểm tra READ COMMITTED trước khóa; truy vấn lịch sử sau khóa dùng snapshot mới, khép lỗi đã báo.
- Regression test mô tả đúng stale-snapshot và kiểm tra permit còn nguyên sau rollback bị từ chối.
- `search_path = pg_catalog, pg_temp` phù hợp: bảng và `%ROWTYPE` đều qualified `public`, builtin được phân giải từ `pg_catalog`.

Chỉ đọc diff; không sửa file hoặc chạy kiểm tra.
