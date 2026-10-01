# Kế hoạch 10 tuần — Digital Banking Simulator

> Nhóm 6 người · 10 tuần + 1 tuần chuẩn bị · Tuần 1 bắt đầu **05/10/2026**, kết thúc **13/12/2026**.
> Ngày tháng là giả định; có deadline chính thức thì dịch theo, thứ tự công việc giữ nguyên.

## 1. Cuối kỳ phải có

- **1 luồng chạy thật trên cloud:** đăng ký → mở tài khoản → nạp tiền → chuyển tiền → xem lịch sử → phát hiện gian lận → nhân viên xử lý → kiểm toán tra cứu.
- **5 demo bắt buộc:** chuyển tiền đồng thời · chống request trùng · sự cố và phục hồi · bảo mật và audit · load test.
- **5 bản nộp P1–P5** đúng hạn và **trả lời được 12 câu bảo vệ**.

**Stack:** NestJS (TypeScript) · PostgreSQL · Redis · AWS · Terraform · GitHub Actions.
**Tài liệu thiết kế:** [01 Business](../01_BUSINESS_ANALYSIS.md) → [02 Requirements & Domain](../02_REQUIREMENTS_AND_DOMAIN_MODEL.md) → [03 Architecture](../03_HIGH_LEVEL_ARCHITECTURE.md).

## 2. Phân vai

| # | Vai trò | Làm gì | Dẫn dắt | Câu bảo vệ | Cặp đôi |
|---|---|---|---|---|---|
| 1 | **Ledger** (kiêm Tech lead) | Database, chuyển tiền, nạp tiền, chống trùng, đối soát; duyệt ADR | P2 | 4, 5 | #4 |
| 2 | **Accounts** (kiêm PM) | Đăng nhập, phân quyền, tài khoản, lịch sử, khóa tài khoản; lịch họp, nộp bài | P1 | 1, 3, 9 | #3 |
| 3 | **Async & Audit** | Hàng đợi, worker, thông báo, nhật ký kiểm toán | — | 7 | #2 |
| 4 | **Fraud** (phần AI) | Hạn mức, 6 luật gian lận, review cảnh báo, báo cáo đánh giá | P5 | 12 | #1 |
| 5 | **Platform** | Cloud, CI/CD, Terraform, bảo mật hạ tầng, chi phí | P3 | 8, 9, 11 | #6 |
| 6 | **Quality** | Test tự động, load test, dashboard, giả lập sự cố, **bộ dữ liệu gian lận** | P4 | 2, 6, 10 | #5 |

- **Cặp đôi** review code của nhau và làm backup khi người kia bận.
- **Người dẫn dắt** ghép bài và nộp; ai làm phần nào tự viết phần đó.
- **#6 làm dữ liệu gian lận, #4 viết luật** — tách người để kết quả đánh giá không bị "tự chấm bài mình".

## 3. Lịch tuần

| Tuần | Ngày | Mục tiêu | Việc chính | ✅ Xong khi |
|---|---|---|---|---|
| **0** | 01–04/10 | Chuẩn bị | Nhận vai; chốt cloud hay VPS; tạo repo, board; mở tài khoản cloud + bật cảnh báo chi phí; hỏi deadline thật | Ai cũng biết vai, có repo |
| **1** | 05–11/10 | **P1** + khung chạy | Cả nhóm hoàn thiện P1 từ tài liệu 01–02 · #5 CI/CD + `/health` lên cloud · #1 thiết kế DB · #6 khung test | Nộp P1; deploy tự động chạy |
| **2** | 12–18/10 | **P2** + API nền | Cả nhóm viết P2 + 3 ADR · #2 đăng nhập, mở tài khoản · #1 chuyển tiền bản đầu, nạp tiền · #3 audit log · #5 DB trên cloud | Nộp P2; mở TK → nạp tiền → xem số dư chạy trên cloud |
| **3** | 19–25/10 | **Lõi đúng-sai** ⚠️ | #1 + #4 chuyển tiền đúng khi đồng thời, chống trùng, hạn mức · #2 phân quyền, lịch sử, rate limit · #3 outbox + hàng đợi · #5 dựng Redis · #6 test đồng thời | Test đồng thời + chống trùng xanh trong CI |
| **4** | 26/10–01/11 | Bất đồng bộ + nhân viên | #3 worker, thông báo, DLQ, API audit · #4 6 luật gian lận · #2 khóa tài khoản + thu hồi phiên · #1 đối soát · #6 test tắt/bật worker | Chuyển tiền xong thì cảnh báo tự xuất hiện |
| **5** | 02–08/11 | **Demo giữa kỳ** | #4 màn review cảnh báo · #6 bộ dữ liệu gian lận · Cả nhóm demo toàn luồng, lập danh sách việc cần sửa | Có video demo giữa kỳ |
| **6** | 09–15/11 | **P3** bảo mật & DevOps | #5 hạ tầng gần production, rollback · #2 + #5 threat model · #6 test bảo mật · Còn lại sửa nợ kỹ thuật | Nộp P3; demo rollback |
| **7** | 16–22/11 | Load test & giám sát | #6 load test 1×/5×/10× + tìm điểm gãy · #2 + #6 dashboard, cảnh báo · #4 đánh giá luật · #1 + #3 sửa lỗi dưới tải · #5 đo chi phí | Có báo cáo load test số liệu thật |
| **8** | 23–29/11 | **P4** vận hành | #6 tổng hợp P4 · #5 demo failover DB · Giả lập sự cố: tắt app, mất DB, tắt Redis | Nộp P4; 5 demo chạy lại được bất cứ lúc nào |
| **9** | 30/11–06/12 | **P5** + tổng duyệt | #4 viết P5 · #6 chạy lại toàn bộ test · Cả nhóm tổng duyệt bảo vệ | Nộp P5; không ai "bí" câu nào |
| **10** | 07–13/12 | Dự phòng + nộp | Hoàn thiện tài liệu, slide · 2–3 ngày dự phòng, **không thêm việc mới** · #5 xóa tài nguyên cloud thừa | Nộp bài |

⚠️ **Tuần 3 là tuần quan trọng nhất.** Chuyển tiền chưa đúng thì mọi thứ phía sau đều trễ.

## 4. Quy tắc làm việc

- **Họp:** 2 lần/tuần, 15 phút. Đầu tuần chốt việc, giữa tuần gỡ vướng.
- **Demo cuối tuần:** 15 phút, quay màn hình, kể cả khi chưa xong.
- **Code:** mọi thay đổi qua Pull Request, cặp đôi duyệt; không push thẳng vào `main`.
- **"Xong"** nghĩa là: đã merge, có test, chạy được trên cloud.
- **ADR:** viết ngay khi chốt quyết định, đừng để cuối kỳ.
- **Chi phí:** code và test trên máy cá nhân; chỉ dựng cloud khi deploy, demo, load test; tắt ngoài giờ.
- **Bận đột xuất:** báo sớm trong nhóm, cặp đôi nhận tạm. Đừng im lặng.

## 5. Rủi ro chính

| Rủi ro | Cách xử lý |
|---|---|
| Chuyển tiền vẫn lỗi ở tuần 3 | Ưu tiên tuyệt đối; #4 đã cặp sẵn với #1, cần thì kéo thêm #2 |
| Chi phí cloud vượt | Tắt môi trường ngoài giờ; #5 báo chi phí hằng tuần |
| #1, #2 quá tải vì kiêm vai | #3 hỗ trợ P2; mỗi người tự viết phần tài liệu của mình |
| Deadline thật khác giả định | Cập nhật file này ngay khi có lịch |

## 6. Việc cần làm ngay

- [ ] Mỗi người nhận 1 vai ở mục 2
- [ ] Chốt nền tảng (cloud hay VPS) và người giữ tài khoản
- [ ] Tạo repo `digital-banking-simulator`, board công việc, thư mục tài liệu chung
- [ ] Bật cảnh báo chi phí cloud
- [ ] Hỏi giảng viên deadline P1–P5
