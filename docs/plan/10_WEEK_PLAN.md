# Kế hoạch 10 tuần — Digital Banking Simulator

> Nhóm 6 người · Lộ trình triển khai gồm 10 tuần thực hiện và 1 tuần khởi động ban đầu. Tiến độ chi tiết bám sát các mốc tuần và thông báo chính thức của giảng viên.

## 1. Cuối kỳ phải có

- **1 luồng chạy thật trên cloud:** đăng ký → mở tài khoản → nạp tiền → chuyển tiền → xem lịch sử → phát hiện gian lận → nhân viên xử lý → kiểm toán tra cứu.
- **5 demo bắt buộc:** chuyển tiền đồng thời · chống request trùng · sự cố và phục hồi · bảo mật và audit · load test.
- **5 bản nộp P1–P5** đúng hạn và **trả lời được 12 câu bảo vệ**.

**Stack:** NestJS (TypeScript) · PostgreSQL · Redis · AWS · Terraform · GitHub Actions.
**Tài liệu thiết kế:** [01 Business](../01_BUSINESS_ANALYSIS.md) → [02 Requirements & Domain](../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) → [03 Architecture](../03_HIGH_LEVEL_ARCHITECTURE.md).

## 2. Phân vai

| Vai trên board | Số người | Làm gì | Câu bảo vệ |
|---|---|---|---|
| **Dev** | 4 | Mọi task `Dev`: chuyển tiền, nạp tiền, chống trùng, sync guard, đối soát, schema; đăng nhập, phân quyền, tài khoản, rate limit; outbox, hàng đợi, thông báo, audit; client Redis/SQS, health, log, harness test, seed, bộ dữ liệu gian lận, script k6, test đồng thời và bảo mật | người làm task liên quan chuẩn bị |
| **#4 Fraud** | 1 | 6 luật gian lận, review cảnh báo, cấu hình luật, báo cáo đánh giá | 12 |
| **#5 Platform & Ops** | 1 | Cloud, CI/CD deploy, Terraform, bảo mật hạ tầng, chi phí; **vận hành**: dashboard, alarm, chạy load test và diễn tập sự cố | 8, 9, 11 |

- **Cách làm kiểu kéo:** dev nào thấy task `Dev` chưa ai nhận (phụ thuộc đã Done) thì nhận, ghi «[Nhận: tên]» ở cột Thực trạng và làm theo thứ tự board. Không có chủ module, không có cặp cố định, không cần chia đều khối lượng, không ai chờ ai: task bị chặn thì lấy task khác. Tiêu chí là kết quả đầu ra.
- Mọi task đi cùng một quy trình: lên kế hoạch, implement, test, test thủ công, tài liệu và ảnh chụp (skill `dbs-delivering-task`, 4 gate). #4 và #5 dùng cùng phase và gate cho việc của mình.
- **Trách nhiệm tổng hợp báo cáo:** mỗi mốc P1–P5 có một người chủ biên (nhóm chọn khi tới mốc; P3 do #5, P5 do #4) chịu trách nhiệm biên tập và nộp; ai làm task nào thì soạn phần kỹ thuật của task đó.
- **Đảm bảo tính khách quan trong đánh giá gian lận:** Dev làm bộ dữ liệu kiểm chuẩn và #4 (người cài luật) là hai người khác nhau, #4 không đọc code generator, để tránh data leakage và thiên kiến đánh giá.

## 3. Lịch tuần

| Tuần | Mục tiêu | Việc chính | Tiêu chí hoàn thành (DoD) |
|---|---|---|---|
| **Tuần 0** | Khởi tạo dự án | Phân công vai trò; thống nhất hạ tầng cloud/VPS; khởi tạo repository, project board; thiết lập tài khoản cloud và cảnh báo chi phí; xác nhận lịch nộp chính thức | Hoàn tất phân công, sẵn sàng môi trường và repository |
| **Tuần 1** | **P1** & Nền tảng thực thi | Hoàn thiện báo cáo P1 từ tài liệu phân tích nghiệp vụ · #5 thiết lập CI/CD deploy, build Docker image và triển khai `/health/ready` lên cloud · Dev thiết kế lược đồ CSDL · Dev xây dựng khung kiểm thử (Testcontainers, CI test, logger) | Nộp P1; quy trình build và deploy tự động vận hành |
| **Tuần 2** | **P2** & Dịch vụ nền tảng | Soạn thảo P2 và 3 tài liệu ADR đầu tiên · Dev hiện thực xác thực, mở tài khoản · Dev luồng nạp tiền và chuyển tiền sơ khởi · Dev ghi nhật ký kiểm toán (audit log) · #5 triển khai CSDL lên cloud | Nộp P2; luồng mở tài khoản → nạp tiền → tra cứu số dư vận hành trên cloud |
| **Tuần 3** | **Tính nhất quán & Đồng thời** ⚠️ | Dev giải quyết tranh chấp giao dịch đồng thời, chống trùng lặp (idempotency), kiểm soát hạn mức (sync guard) · Dev phân quyền truy cập, tra cứu lịch sử, giới hạn tần suất (rate limit) · Dev triển khai outbox và hàng đợi sự kiện · #4 viết các luật gian lận dạng hàm thuần · #5 thiết lập ElastiCache và SQS trên cloud · Dev client Redis/SQS và kiểm thử tải đồng thời | Kiểm thử đồng thời và chống trùng lặp đạt 100% pass trên CI |
| **Tuần 4** | Xử lý bất đồng bộ & Vận hành | Dev worker xử lý sự kiện, dịch vụ thông báo, hàng đợi DLQ, API tra cứu kiểm toán · #4 hiện thực 6 luật phát hiện gian lận · Dev khóa tài khoản và thu hồi phiên tức thì · Dev cơ chế đối soát sổ cái tự động · Dev kiểm thử khả năng phục hồi khi dừng/bật worker | Giao dịch hoàn tất tự động kích hoạt tiến trình phân tích rủi ro |
| **Tuần 5** | **Báo cáo giữa kỳ** | #4 giao diện/API rà soát cảnh báo gian lận · Dev hoàn thiện bộ dữ liệu đánh giá rủi ro · Thực nghiệm luồng nghiệp vụ toàn trình (end-to-end), lập danh mục tối ưu hóa | Hoàn thành video báo cáo tiến độ và demo giữa kỳ |
| **Tuần 6** | **P3** An toàn & DevOps | #5 cấu hình môi trường staging/production, quy trình rollback · Dev + #5 mô hình hóa mối đe dọa (STRIDE threat model) · Dev kiểm thử an toàn thông tin · Xử lý các tồn đọng kỹ thuật | Nộp P3; thực hiện thành công kịch bản rollback |
| **Tuần 7** | Đo kiểm tải & Giám sát | Dev viết script k6 và #5 chạy theo các kịch bản 1×/5×/10× để xác định điểm nghẽn hệ thống · #5 thiết lập dashboard giám sát SLI/SLO và alarm (metric do Dev phát) · #4 đánh giá độ chính xác mô hình luật · Dev tối ưu hóa hiệu năng dưới tải cao · #5 đo lường chi phí vận hành | Báo cáo kiểm thử tải với số liệu thực nghiệm trên môi trường cloud |
| **Tuần 8** | **P4** Kỹ nghệ vận hành | Dev tổng hợp hồ sơ P4 · #5 diễn tập kịch bản chuyển vùng dự phòng CSDL (DB failover) · Diễn tập xử lý sự cố hạ tầng: gián đoạn dịch vụ, mất kết nối CSDL, sự cố cache | Nộp P4; sẵn sàng kịch bản thực nghiệm cho 5 demo bắt buộc |
| **Tuần 9** | **P5** & Tổng duyệt | #4 tổng hợp báo cáo P5 · Dev chạy hồi quy toàn bộ test suite · Tổng duyệt toàn diện kịch bản bảo vệ đồ án | Nộp P5; thành viên nắm vững nội dung và sẵn sàng bảo vệ 12 câu hỏi |
| **Tuần 10** | Dự phòng & Hoàn tất | Chuẩn bị tài liệu thuyết trình, hoàn thiện slide báo cáo · Dự phòng tiến độ (đóng băng tính năng) · #5 thu hồi và đóng các tài nguyên cloud không cần thiết | Hoàn tất nộp hồ sơ đồ án môn học |

## 4. Quy tắc làm việc

- **Họp định kỳ:** 2 buổi/tuần (15 phút/buổi). Đầu tuần thống nhất kế hoạch chi tiết, giữa tuần tháo gỡ các điểm nghẽn kỹ thuật (unblock).
- **Kiểm soát tiến độ:** Đánh giá tiến độ vào cuối tuần (15 phút), ghi hình lại kết quả thực nghiệm làm bằng chứng.
- **Quy trình mã nguồn:** Toàn bộ thay đổi phải thông qua Pull Request và được một Dev khác review trước khi merge (quy ước nhóm; ruleset của `main` bắt buộc PR nhưng không ép số approval); áp dụng cơ chế bảo vệ nhánh `main`.
- **Tiêu chuẩn hoàn thành (Definition of Done):** Mã nguồn được merge qua PR, vượt qua toàn bộ các bài kiểm thử tự động (unit/integration test) và triển khai thành công trên môi trường cloud.
- **Ghi nhận quyết định kiến trúc:** Lập tài liệu ADR (Architecture Decision Record) ngay khi thống nhất các quyết định kỹ thuật quan trọng.
- **Quản lý chi phí:** Phát triển và kiểm thử cục bộ (local); chỉ khởi tạo hạ tầng cloud khi deploy, demo hoặc đo kiểm tải; tắt tài nguyên ngoài khung giờ làm việc.
- **Kế hoạch dự phòng:** Khi có phát sinh công việc ngoài dự kiến, chủ động thông báo cho nhóm và chuyển task cho Dev đang rảnh (task chưa xong thì ghi lại hiện trạng ở cột Thực trạng để người nhận tiếp).

## 5. Quản trị rủi ro

| Rủi ro | Giải pháp giảm thiểu |
|---|---|
| Chậm tiến độ module chuyển tiền tại Tuần 3 | Ưu tiên tối đa nguồn lực: Dev nào rảnh nhận task chuyển tiền trước, #4 hỗ trợ kỹ thuật |
| Chi phí hạ tầng cloud vượt ngân sách dự kiến | Áp dụng chính sách tắt tài nguyên tự động ngoài giờ; #5 theo dõi và báo cáo chi phí định kỳ |
| Khối lượng công việc dồn ứ ở giai đoạn đầu | Phân bổ chéo công việc viết tài liệu; Dev nào rảnh hỗ trợ tổng hợp báo cáo P2 |
| Lịch nộp chính thức có thay đổi so với dự kiến | Chủ động cập nhật và điều chỉnh các mốc thời gian theo thông báo chính thức của giảng viên |

## 6. Kế hoạch khởi động

- [ ] Phân công chính thức 6 vai trò theo bảng phân nhiệm
- [x] Thống nhất lựa chọn hạ tầng: AWS, `ap-southeast-1`, dựng/xóa theo phiên ([ADR-11](../adr/0011-aws-managed-session-based.md))
- [x] Khởi tạo repository `digital-banking-simulator`, project board và cấu trúc tài liệu dùng chung
- [ ] Thiết lập hạn mức và cảnh báo chi phí (AWS Budget Alerts)
- [ ] Xác nhận với giảng viên thời hạn chính thức cho các mốc P1–P5
