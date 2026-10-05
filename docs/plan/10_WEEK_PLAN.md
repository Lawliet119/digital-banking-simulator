# Kế hoạch 10 tuần — Digital Banking Simulator

> Nhóm 6 người · Lộ trình triển khai gồm 10 tuần thực hiện và 1 tuần khởi động ban đầu. Tiến độ chi tiết bám sát các mốc tuần và thông báo chính thức của giảng viên.

## 1. Cuối kỳ phải có

- **1 luồng chạy thật trên cloud:** đăng ký → mở tài khoản → nạp tiền → chuyển tiền → xem lịch sử → phát hiện gian lận → nhân viên xử lý → kiểm toán tra cứu.
- **5 demo bắt buộc:** chuyển tiền đồng thời · chống request trùng · sự cố và phục hồi · bảo mật và audit · load test.
- **5 bản nộp P1–P5** đúng hạn và **trả lời được 12 câu bảo vệ**.

**Stack:** NestJS (TypeScript) · PostgreSQL · Redis · AWS · Terraform · GitHub Actions.
**Tài liệu thiết kế:** [01 Business](../01_BUSINESS_ANALYSIS.md) → [02 Requirements & Domain](../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) → [03 Architecture](../03_HIGH_LEVEL_ARCHITECTURE.md).

## 2. Phân vai

| # | Vai trò | Làm gì | Dẫn dắt | Câu bảo vệ | Cặp đôi |
|---|---|---|---|---|---|
| 1 | **Ledger** | Database, chuyển tiền, nạp tiền, chống trùng, đối soát; duyệt ADR | P2 | 4, 5 | #4 |
| 2 | **Accounts** | Đăng nhập, phân quyền, tài khoản, lịch sử, khóa tài khoản; lịch họp, nộp bài | P1 | 1, 3, 9 | #3 |
| 3 | **Async & Audit** | Hàng đợi, worker, thông báo, nhật ký kiểm toán | — | 7 | #2 |
| 4 | **Fraud** | Hạn mức, 6 luật gian lận, review cảnh báo, báo cáo đánh giá | P5 | 12 | #1 |
| 5 | **Platform** | Cloud, CI/CD, Terraform, bảo mật hạ tầng, chi phí | P3 | 8, 9, 11 | #6 |
| 6 | **Quality** | Test tự động, load test, dashboard, giả lập sự cố, **bộ dữ liệu gian lận** | P4 | 2, 6, 10 | #5 |

- **Cơ chế bắt cặp (Pair Review & Backup):** Các cặp vai trò thực hiện đánh giá chéo mã nguồn (code review) và đảm nhiệm vai trò dự phòng kỹ thuật khi thành viên trong cặp vắng mặt.
- **Trách nhiệm tổng hợp báo cáo:** Thành viên dẫn dắt từng cột mốc chịu trách nhiệm tổ chức, biên tập và nộp báo cáo; mỗi thành viên trực tiếp soạn thảo nội dung kỹ thuật thuộc phạm vi mình phụ trách.
- **Đảm bảo tính khách quan trong đánh giá gian lận:** Phân định độc lập giữa vai trò xây dựng tập dữ liệu kiểm chuẩn (#6) và vai trò phát hiện/cài đặt luật (#4) nhằm đảm bảo tính khách quan của thực nghiệm (tránh rủi ro data leakage và thiên kiến đánh giá).

## 3. Lịch tuần

| Tuần | Mục tiêu | Việc chính | Tiêu chí hoàn thành (DoD) |
|---|---|---|---|
| **Tuần 0** | Khởi tạo dự án | Phân công vai trò; thống nhất hạ tầng cloud/VPS; khởi tạo repository, project board; thiết lập tài khoản cloud và cảnh báo chi phí; xác nhận lịch nộp chính thức | Hoàn tất phân công, sẵn sàng môi trường và repository |
| **Tuần 1** | **P1** & Nền tảng thực thi | Hoàn thiện báo cáo P1 từ tài liệu phân tích nghiệp vụ · #5 thiết lập CI/CD, build Docker image và triển khai `/health/ready` lên cloud · #1 thiết kế lược đồ CSDL · #6 xây dựng khung kiểm thử | Nộp P1; quy trình build và deploy tự động vận hành |
| **Tuần 2** | **P2** & Dịch vụ nền tảng | Soạn thảo P2 và 3 tài liệu ADR đầu tiên · #2 hiện thực xác thực, mở tài khoản · #1 luồng nạp tiền và chuyển tiền sơ khởi · #3 ghi nhật ký kiểm toán (audit log) · #5 triển khai CSDL lên cloud | Nộp P2; luồng mở tài khoản → nạp tiền → tra cứu số dư vận hành trên cloud |
| **Tuần 3** | **Tính nhất quán & Đồng thời** ⚠️ | #1 + #4 giải quyết tranh chấp giao dịch đồng thời, chống trùng lặp (idempotency), kiểm soát hạn mức · #2 phân quyền truy cập, tra cứu lịch sử, giới hạn tần suất (rate limit) · #3 triển khai outbox và hàng đợi sự kiện · #5 thiết lập bộ nhớ đệm Redis · #6 kiểm thử tải đồng thời | Kiểm thử đồng thời và chống trùng lặp đạt 100% pass trên CI |
| **Tuần 4** | Xử lý bất đồng bộ & Vận hành | #3 worker xử lý sự kiện, dịch vụ thông báo, hàng đợi DLQ, API tra cứu kiểm toán · #4 hiện thực 6 luật phát hiện gian lận · #2 khóa tài khoản và thu hồi phiên tức thì · #1 cơ chế đối soát sổ cái tự động · #6 kiểm thử khả năng phục hồi khi dừng/bật worker | Giao dịch hoàn tất tự động kích hoạt tiến trình phân tích rủi ro |
| **Tuần 5** | **Báo cáo giữa kỳ** | #4 giao diện/API rà soát cảnh báo gian lận · #6 hoàn thiện bộ dữ liệu đánh giá rủi ro · Thực nghiệm luồng nghiệp vụ toàn trình (end-to-end), lập danh mục tối ưu hóa | Hoàn thành video báo cáo tiến độ và demo giữa kỳ |
| **Tuần 6** | **P3** An toàn & DevOps | #5 cấu hình môi trường staging/production, quy trình rollback · #2 + #5 mô hình hóa mối đe dọa (STRIDE threat model) · #6 kiểm thử an toàn thông tin · Xử lý các tồn đọng kỹ thuật | Nộp P3; thực hiện thành công kịch bản rollback |
| **Tuần 7** | Đo kiểm tải & Giám sát | #6 kiểm thử tải theo các kịch bản 1×/5×/10× và xác định điểm nghẽn hệ thống · #2 + #6 thiết lập dashboard giám sát SLI/SLO và cảnh báo · #4 đánh giá độ chính xác mô hình luật · #1 + #3 tối ưu hóa hiệu năng dưới tải cao · #5 đo lường chi phí vận hành | Báo cáo kiểm thử tải với số liệu thực nghiệm trên môi trường cloud |
| **Tuần 8** | **P4** Kỹ nghệ vận hành | #6 tổng hợp hồ sơ P4 · #5 diễn tập kịch bản chuyển vùng dự phòng CSDL (DB failover) · Diễn tập xử lý sự cố hạ tầng: gián đoạn dịch vụ, mất kết nối CSDL, sự cố cache | Nộp P4; sẵn sàng kịch bản thực nghiệm cho 5 demo bắt buộc |
| **Tuần 9** | **P5** & Tổng duyệt | #4 tổng hợp báo cáo P5 · #6 chạy hồi quy toàn bộ test suite · Tổng duyệt toàn diện kịch bản bảo vệ đồ án | Nộp P5; thành viên nắm vững nội dung và sẵn sàng bảo vệ 12 câu hỏi |
| **Tuần 10** | Dự phòng & Hoàn tất | Chuẩn bị tài liệu thuyết trình, hoàn thiện slide báo cáo · Dự phòng tiến độ (đóng băng tính năng) · #5 thu hồi và đóng các tài nguyên cloud không cần thiết | Hoàn tất nộp hồ sơ đồ án môn học |

## 4. Quy tắc làm việc

- **Họp định kỳ:** 2 buổi/tuần (15 phút/buổi). Đầu tuần thống nhất kế hoạch chi tiết, giữa tuần tháo gỡ các điểm nghẽn kỹ thuật (unblock).
- **Kiểm soát tiến độ:** Đánh giá tiến độ vào cuối tuần (15 phút), ghi hình lại kết quả thực nghiệm làm bằng chứng.
- **Quy trình mã nguồn:** Toàn bộ thay đổi phải thông qua Pull Request, có tối thiểu 1 phê duyệt từ thành viên trong cặp phụ trách; áp dụng cơ chế bảo vệ nhánh `main`.
- **Tiêu chuẩn hoàn thành (Definition of Done):** Mã nguồn được merge qua PR, vượt qua toàn bộ các bài kiểm thử tự động (unit/integration test) và triển khai thành công trên môi trường cloud.
- **Ghi nhận quyết định kiến trúc:** Lập tài liệu ADR (Architecture Decision Record) ngay khi thống nhất các quyết định kỹ thuật quan trọng.
- **Quản lý chi phí:** Phát triển và kiểm thử cục bộ (local); chỉ khởi tạo hạ tầng cloud khi deploy, demo hoặc đo kiểm tải; tắt tài nguyên ngoài khung giờ làm việc.
- **Kế hoạch dự phòng:** Khi có phát sinh công việc ngoài dự kiến, chủ động thông báo cho nhóm và chuyển giao công việc tạm thời cho thành viên trong cặp phụ trách.

## 5. Quản trị rủi ro

| Rủi ro | Giải pháp giảm thiểu |
|---|---|
| Chậm tiến độ module chuyển tiền tại Tuần 3 | Ưu tiên tối đa nguồn lực; thành viên #4 và #2 phối hợp hỗ trợ kỹ thuật cùng #1 |
| Chi phí hạ tầng cloud vượt ngân sách dự kiến | Áp dụng chính sách tắt tài nguyên tự động ngoài giờ; #5 theo dõi và báo cáo chi phí định kỳ |
| Khối lượng công việc dồn ứ ở giai đoạn đầu | Phân bổ chéo công việc viết tài liệu; thành viên #3 hỗ trợ tổng hợp báo cáo P2 |
| Lịch nộp chính thức có thay đổi so với dự kiến | Chủ động cập nhật và điều chỉnh các mốc thời gian theo thông báo chính thức của giảng viên |

## 6. Kế hoạch khởi động

- [ ] Phân công chính thức 6 vai trò theo bảng phân nhiệm
- [ ] Thống nhất lựa chọn hạ tầng (AWS/VPS) và tài khoản quản trị
- [ ] Khởi tạo repository `digital-banking-simulator`, project board và cấu trúc tài liệu dùng chung
- [ ] Thiết lập hạn mức và cảnh báo chi phí (AWS Budget Alerts)
- [ ] Xác nhận với giảng viên thời hạn chính thức cho các mốc P1–P5
