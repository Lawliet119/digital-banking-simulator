### Finding

**title:** [P2] Căn thứ tự phân trang với index hàng đợi fraud
**file_path:** `/home/dylan/Code/dbs-fraud-review-v2/backend/src/modules/risk/fraud-http.service.ts`
**line_start:** 28
**line_end:** 30
**priority:** 2
**confidence:** 0.95
**body:** Với danh sách mặc định không lọc level, `ORDER BY CASE risk_level…` không khớp index hiện có `fraud_flags_open_queue_idx(risk_level, created_at DESC)`. PostgreSQL phải đọc các cờ phù hợp rồi sort trước khi áp dụng LIMIT; cursor không tránh được công việc tăng theo toàn bộ backlog trên mỗi trang. Bảng hiện không có expression index tương ứng. Hãy dùng thứ tự `risk_level` trực tiếp, cập nhật cursor tương ứng và thêm composite index gồm status, level, thời gian, UUID; hoặc thêm index khớp chính xác biểu thức hiện tại. Đây là kết luận từ SQL/schema, chưa đo latency.

### Verdict

**overall_correctness:** incorrect
**explanation:** Có một lỗi hiệu năng phân trang nêu trên. Không tìm thấy lỗi mới có đủ chứng cứ về role isolation/PII, microsecond cursor, audit/review race, runtime grant hoặc feature boundaries/delivery order; đã kiểm tra cả migration grant mới chưa nằm trong tracked diff và các consuming paths. Không sửa file, chạy test/lint/build/formatter hay gọi hệ thống ngoài; thông lượng và độ trễ thực tế chưa được xác minh.
**confidence:** 0.88

---

**overall_correctness:** correct  
**explanation:** Không tìm thấy lỗi correctness còn lại trong bản sửa phân trang. SQL và cursor thống nhất thứ tự HIGH → MEDIUM, timestamp/UUID giảm dần; test bổ sung có đi qua ranh giới hai level. Finding trước về `ORDER BY CASE` được đóng; hiệu năng thực tế/index covering vẫn chưa được đo, không phải blocker correctness. Không sửa file hoặc chạy kiểm tra.  
**confidence:** 0.94
