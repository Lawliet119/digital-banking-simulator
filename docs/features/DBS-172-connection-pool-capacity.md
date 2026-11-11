# DBS-172 · Tính pool kết nối × số task không vượt max_connections

> **Status:** Kiểm chứng cục bộ; chờ CI và Dev review (chưa đóng: số task worker còn là giả định vì DBS-121 chưa xong, `max_connections` của lớp production chưa đo) · **Vai:** Dev · **Nhánh:** `docs/DBS-172-connection-pool-capacity` · **PR:** [#140](https://github.com/Lawliet119/digital-banking-simulator/pull/140) · **Cập nhật:** 2026-11-11

> **Ghi chú về lịch sử (2026-11-11):** bản đầu của PR này (tác giả khác) ghi `max_connections = 112` cho `db.t4g.micro` và một cấu hình production «8 API + 4 worker, `db.t4g.medium`» không có trong tài liệu nào; số đo thật (DBS-66) là 79 và production theo docs/03 là `db.t4g.small`. Một review độc lập (subagent) đã chỉ ra điều đó cùng việc test tự định nghĩa công thức rồi tự kiểm. Bản này viết lại trên docs/03 §13.2 thay vì thêm công thức thứ ba. Domain review đầu là self-review (không đạt chuẩn skill) và gate G1 đến G3 không được ghi lúc làm; không dựng lại dấu vết đó.

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 7, High, Demo 5. **Expect:** «Không bao giờ cạn kết nối dưới tải.» **Thực trạng:** «Kích thước pool chưa được tính theo số task api + worker và max_connections của RDS.»
- **DoD (chép nguyên văn từ board):**
  1. Công thức pool × (số task api + worker) + dư an toàn ≤ max_connections của lớp RDS đang dùng; ghi trong 02-architecture
  2. Giá trị pool cấu hình theo env; kiểm khi scale task lên
  3. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
  - Ghi chú của board ngày 11/10: không còn file 02-architecture theo component; công thức ghi vào docs/03 hoặc `docs/components/_shared` (làm ở docs/03 §13.2 và `database-design.md` §6.4).
- **Phụ thuộc:** DBS-66 Done (số đo `max_connections`). **DBS-121 (worker trên ECS) còn To Do trên board**: số task worker là giả định (docs/03 §13.1: 1 task ở dev, 1 đến 2 ở production). Phạm vi vì thế được giảm: công thức, số đo thật cho micro, các hạng mục còn thiếu của công thức, và test giữ chúng; không khẳng định số liệu cho lớp chưa đo.
- **Đã có gì:** docs/03 §13.2 (`số task × 10 + 5 ≤ max_connections`, dev tối đa 6 task), `variables.tf` (`desired_count` ≤ 6), DBS-66 (đo 79 và 74 dùng được), `DATABASE_POOL_MAX` 1 đến 50 mặc định 10.
- **Ngoài phạm vi:** đo `SHOW max_connections` trên `db.t4g.small` và production; đặt `deployment_maximum_percent`; số task worker thật (DBS-121); đổi giá trị mặc định của pool.
- **Quyết định (agent tự quyết, 2026-11-11):** một công thức chuẩn ở docs/03 §13.2, `database-design.md` §6.4 chỉ liệt kê các hạng mục thiếu và số đo; test đọc giá trị thật từ code và Terraform.

## 2. Hành vi

Công thức chuẩn (docs/03 §13.2): `số task × DATABASE_POOL_MAX + 5 ≤ max_connections dùng được`. Với micro: dùng được 79 − 3 (superuser) − 2 (reserved) = 74; `6 × 10 + 5 = 65 ≤ 74`. Hạng mục chưa có trong công thức cũ và nay được ghi: kết nối ngoài pool của cổng AI (`số task worker × RISK_AI_CONCURRENCY`), hệ số 2 lúc rolling deploy (ECS mặc định 200%, không đặt `deployment_maximum_percent`), và việc `DBInstanceClassMemory` nhỏ hơn RAM danh định (nên không suy `max_connections` từ RAM danh định).

**Hệ quả được test ghim:** ở `desired_count` tối đa (6) một lần deploy có thể tạm chạy 12 task, `2 × 6 × 10 + 5 = 125 > 74`: không vừa micro. Đây là rủi ro thật chưa được xử lý (BL-234).

## 3. Kiến trúc

- `backend/src/config/connection-pool.spec.ts` (đọc `validation.schema.ts` và `infra/terraform/envs/dev/session/variables.tf`), `docs/components/_shared/database-design.md` §6.4, `docs/03` §13.2. Không đổi mã chạy, không đổi env, không đổi schema.

## 4. Test cases tự động

| ID | Truy vết | Lớp | Given · When · Then |
|---|---|---|---|
| TC-172-01 | DoD 1, 2 | unit | pool mặc định (đọc từ schema) × `desired_count` tối đa (đọc từ Terraform) + 5 ≤ 74 |
| TC-172-02 | DoD 2 (kiểm khi scale) | unit | gấp đôi task lúc rolling deploy vượt 74: ghim sự thật, đổi một trong hai số là thấy |
| TC-172-03 | DoD 1 | unit | thông báo lỗi của biến Terraform trỏ về docs/03 §13.2 |
| TC-172-04 | DoD 1 | unit | chỗ còn lại sau các pool ≥ 0 cho kết nối ngoài pool của cổng AI |
| TC-172-05 | DoD 3 | quy trình | PR merge, CI xanh, Dev review |

## 5. Test thủ công

Task chỉ có tài liệu và một unit test, không có hành vi chạy được để thao tác tay. Bước duy nhất: `cd backend && npm test -- connection-pool` trên commit cuối, kết quả ở `screenshots/DBS-172/manual-test.txt` (SHA ở dòng đầu). **Chưa chạy:** đo `SHOW max_connections` trên `db.t4g.small` hoặc production (cần AWS, ngoài phạm vi; BL-234).

## 6. Domain review (AI)

Review độc lập bằng subagent (opus, 2026-11-11), nguyên văn không lưu; các phát hiện và xử lý: số `112` sai so với số đo 79/74 (đã sửa); cấu hình production «8 API + 4 worker, medium» không có nguồn (đã xóa); test tự kiểm công thức của chính nó (đã viết lại đọc cấu hình thật); công thức bỏ sót kết nối ngoài pool của `AiGate`, rolling deploy ×2 và phần reserved (đã thêm); trùng và mâu thuẫn với docs/03 §13.2 (đã gộp về một công thức); câu «không bao giờ cạn pool» quá mức (đã viết lại); DoD không chép nguyên văn (đã sửa §1); thiếu §9 (đã thêm). Verdict của reviewer là HOLD_OR_CLOSE cho bản gốc; bản này chưa qua một lượt review thứ hai.

## 7. Kế hoạch triển khai

Một commit sửa tài liệu và test (`docs(database): …`), một commit bằng chứng thủ công. Test đọc cấu hình thật nên đổi `DATABASE_POOL_MAX` mặc định hoặc `desired_count` sẽ làm test đỏ, đúng ý. Lùi: revert commit; không đổi mã chạy.

## 8. Kết quả

- `npm test -- connection-pool`: 4 test đạt (TC-172-01..04). `lint:check` và `typecheck` sạch. TC-172-05 (quy trình) chờ CI và review.
- Số `112`, `225`, `450` của bản đầu đã bị xóa vì không có nguồn. Số liệu duy nhất được khẳng định: micro 79 (đo, DBS-66) và 74 dùng được.
- **Bàn giao:** BL-234 (rolling deploy ở `desired_count` tối đa không vừa micro; đo `max_connections` của lớp production; cập nhật khi DBS-121 xong).

## 9. Tài liệu đã cập nhật

`docs/components/_shared/database-design.md` §6.4 (viết lại), `docs/03` §13.2 (thêm các hạng mục), `docs/features/README.md`, `docs/BACKLOG.md` (BL-234).
