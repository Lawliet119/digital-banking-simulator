# Kịch bản quay video demo giữa kỳ (15–20 phút, có tiếng giải thích)

> **Status:** Active (chuẩn bị xong, **chưa quay**: cần người thật; [DBS-140](../features/DBS-140-midterm-demo-video-prep.md), BL-390) · **Owner:** Dev · **Nguồn lệnh:** [demo-midterm-end-to-end.md](demo-midterm-end-to-end.md) · **Nơi ghi kết quả quay:** [midterm-demo-video.md](../deliverables/midterm-demo-video.md) · **Cập nhật:** 2026-11-15

Tài liệu này chỉ thêm **phần quay**: trình tự, lời dẫn, thời lượng, điều không được để lộ trên màn hình. Lệnh của từng bước **không chép lại**; đọc ở [demo giữa kỳ](demo-midterm-end-to-end.md) để một nguồn duy nhất. Hai người là tốt nhất (một người nói, một người gõ), một người cũng được.

## 1. Quyết định chuẩn bị (agent tự quyết, đổi được)

| # | Quyết định | Lý do |
|---|---|---|
| 1 | Quay trên **local** (docker compose + một process `APP_ROLE=both`), không quay trên cloud | Kịch bản local chạy ổn định và lặp lại được; cloud tốn ≈ 0,14 USD/giờ, dựng 9 phút và hủy 8 phút, và phải chạy lệnh có mật khẩu trong container Linux. Muốn quay cloud thì làm theo [nhánh cloud](demo-midterm-end-to-end.md#nhánh-cloud) và [demo-checklist](../runbooks/demo-checklist.md), rồi ghi rõ ở phần metadata |
| 2 | Một lần quay liền, không dựng phim | Cổng ra tuần 5 chỉ cần «video demo toàn luồng»; cắt ghép làm mất giá trị bằng chứng. Sai một lệnh thì dừng ở ranh giới bước, reset (bước 0) và quay lại từ đầu |
| 3 | Lời dẫn tiếng Việt, mỗi bước nói **vì sao** trước khi gõ lệnh | DoD đòi «có tiếng giải thích»; giám khảo cần hiểu quy tắc nghiệp vụ, không chỉ thấy mã HTTP |
| 4 | Tên không dấu trong thân JSON gửi bằng `curl -d` (Git Bash trên Windows làm hỏng dấu) | Xem [Quy tắc khi quay](demo-midterm-end-to-end.md#quy-tắc-khi-quay) |
| 5 | Token lấy lại **trong khung hình, không dừng ghi**, ở đầu đoạn I (mốc 13:00): ba lệnh `tok` gán vào biến, không in ra | Token dev sống 15 phút (900 giây, sai lệch đồng hồ cho phép 5 giây); lấy ở mốc 2:30 thì hết hạn đúng vào đoạn J nếu quay chậm hơn kế hoạch. Lệnh chỉ chứa tên vai nên không lộ gì; chạy trong cùng terminal đã định nghĩa `tok` và `RUN` |

## 2. Trình tự và thời lượng (tổng 17,5 phút đã **gồm cả thời gian gõ lệnh**; chấp nhận 15–20)

| Mốc | Đoạn | Phút | Lệnh ở | Điều cần nói (ý chính) |
|---|---|---|---|---|
| 0:00 | A. Mở màn | 1,5 | không gõ lệnh; chiếu sơ đồ container [docs/03 §4](../03_HIGH_LEVEL_ARCHITECTURE.md#4-c4--mức-2-container) | Mục tiêu demo: một luồng tiền từ đăng ký tới truy vết. Kiến trúc: một NestJS monolith theo module, PostgreSQL là sổ cái (bút toán kép), outbox rồi hàng đợi cho phần chấm điểm gian lận, ba vai (khách, nhân viên, kiểm toán viên). Nói rõ đây là hệ thống mô phỏng, và **bản quay là local**: ElasticMQ thay SQS, khóa dev thay Cognito, một process chạy cả api và worker |
| 1:30 | B. Chuẩn bị đã có | 1 | [Bước 0](demo-midterm-end-to-end.md#bước-0--reset-dữ-liệu-và-seed) | Đã reset và seed hai lần (số dư không đổi, vì seed idempotent), `check:invariants` PASS: tổng sổ cái bằng 0 |
| 2:30 | C. Đăng ký, mở tài khoản | 2 | [Bước 1](demo-midterm-end-to-end.md#bước-1--đăng-ký), [Bước 2](demo-midterm-end-to-end.md#bước-2--mở-tài-khoản) | Lấy bốn token ngay đầu đoạn này (lệnh `export` ở [Bước 1–9](demo-midterm-end-to-end.md#bước-19--luồng-chính)); **không đọc token ra**. Hai khách mới (An, Bình) onboard qua API; mỗi người một tài khoản CHECKING, số dư 0 |
| 4:30 | D. Nạp tiền | 1 | [Bước 3](demo-midterm-end-to-end.md#bước-3--nạp-tiền) | Chỉ nhân viên nạp tiền (quầy); mỗi lệnh có `Idempotency-Key`, gửi lại không nạp hai lần. 21.000.000 vào tài khoản An |
| 5:30 | E. Chuyển tiền | 2,5 | [Bước 4](demo-midterm-end-to-end.md#bước-4--chuyển-tiền-ghi-c-và-t) | Chuyển 20.000.000 từ An sang Bình, 201 COMPLETED. **Dừng ở `C`**: «đây là mã truy vết của giao dịch, từ API tới worker đều mang mã này». Bút toán kép, số dư An còn 1.000.000. Luồng đầy đủ: [docs/03 §6.3](../03_HIGH_LEVEL_ARCHITECTURE.md#63-chuyển-tiền-uc-5--khách-hàng-đi-qua-từng-thành-phần) |
| 8:00 | F. Cờ xuất hiện | 2 | [Bước 5](demo-midterm-end-to-end.md#bước-5--cờ-gian-lận-xuất-hiện) | Worker chấm điểm không đồng bộ (không làm chậm giao dịch). Điểm 65, mức MEDIUM, do hai luật: tài khoản mở dưới 24 giờ chuyển trên 10 triệu (R3, 35 điểm) và chuyển ≥ 90% số dư giữa hai tài khoản **khác chủ** (R6, 30 điểm) |
| 10:00 | G. Khách không thấy cờ | 1,5 | [Bước 6](demo-midterm-end-to-end.md#bước-6--khách-không-thấy-cờ) | Quy tắc AC-10.2, BR-13: khách không thể biết mình bị gắn cờ; hai phản hồi không có `score`, `riskLevel`, `reviewStatus` |
| 11:30 | H. Nhân viên review một lần | 1,5 | [Bước 7](demo-midterm-end-to-end.md#bước-7--nhân-viên-review-chỉ-một-lần) | Mở chi tiết thấy luật nào kích hoạt; xác nhận gian lận; lần hai bị 409 `FLAG_ALREADY_REVIEWED`, không đổi gì. Luồng đầy đủ: [docs/03 §6.5](../03_HIGH_LEVEL_ARCHITECTURE.md#65-review-cờ-gian-lận-uc-10--nhân-viên-đi-qua-từng-thành-phần) |
| 13:00 | I. Kiểm toán viên tra `C` | 2 | [Bước 8](demo-midterm-end-to-end.md#bước-8--kiểm-toán-viên-tra-correlationid-bấm-giờ) | **Đầu đoạn này, ngay trong khung hình và không dừng ghi: nói «token sống 15 phút nên lấy lại» rồi lấy lại ba token `OP`, `AUD`, `AN`** trong **cùng terminal** bằng đúng lệnh `tok` ở [Bước 1–9](demo-midterm-end-to-end.md#bước-19--luồng-chính) với cùng `--sub "demo-an-$RUN"` (không reset, không đổi `RUN`); token gán vào biến, không in (≈ 0,3 phút, nằm trong phần đệm). Bấm giờ (NFR-AUD-02: dưới 5 phút; thực tế vài trăm mili giây). Một mã cho ra cả chuỗi: giao dịch, thông báo, gắn cờ, xem cờ, review; dòng của worker vẫn mang cùng mã. Luồng đầy đủ: [docs/03 §6.6](../03_HIGH_LEVEL_ARCHITECTURE.md#66-tra-cứu-nhật-ký-kiểm-toán-uc-8--kiểm-toán-viên-đi-qua-từng-thành-phần) |
| 15:00 | J. Ca từ chối | 1,5 | [Bước 9](demo-midterm-end-to-end.md#bước-9--ca-từ-chối) | Khách gọi API nhân viên: 403; kiểm toán viên review: 403; cả hai để lại dòng `access.denied` (từ chối cũng có nhật ký) |
| 16:30 | K. Kết | 1 | không gõ lệnh | Nói giới hạn thật ([Giới hạn hiện tại](demo-midterm-end-to-end.md#giới-hạn-hiện-tại)): điểm 65 đúng với rule set seed, chưa bật AI; chưa chạy tải; phần còn lại của lộ trình tuần 6–10 |

Mốc kết thúc dự kiến 17:30. Tổng trong bảng: 1,5 + 1 + 2 + 1 + 2,5 + 2 + 1,5 + 1,5 + 2 + 1,5 + 1 = **17,5 phút**, đã gồm thời gian gõ lệnh; còn 2,5 phút đệm tới mốc 20 phút. Nếu bản chạy thử vượt 20 phút thì cắt theo thứ tự: bỏ chiếu sơ đồ ở A (−0,5), nói tóm một câu ở K (−0,5), bỏ đọc lại `C` ở E (−0,5); **không bỏ bước 1–9**. Nếu bản chạy thử dưới 15 phút thì thêm vào A (sơ đồ thứ hai) hoặc đọc kỹ hơn các luật R3, R6 ở F.

## 3. Trước khi bấm quay

Làm theo [Checklist trước khi quay](demo-midterm-end-to-end.md#checklist-trước-khi-quay), thêm các dòng riêng của việc quay:

- [ ] Chạy thử **cả bước 0–9 một lần** trước giờ quay, trên đúng commit sẽ quay (ghi SHA ở [midterm-demo-video.md](../deliverables/midterm-demo-video.md)), **có đọc lời dẫn thành tiếng và bấm giờ cả đoạn**: thời lượng thật quyết định có phải cắt (xem cuối §2). Mọi vấn đề thành dòng `docs/BACKLOG.md` hoặc issue.
- [ ] Reset lại ngay trước khi quay (bước 0), kể cả ElasticMQ và Valkey, để danh sách cờ ở bước 5 chỉ có một cờ.
- [ ] Hai terminal: một cho process server (`npm run start:dev`, log dài) **đặt ngoài vùng ghi hình**, một terminal duy nhất trong vùng ghi hình. Cỡ chữ ≥ 16 pt, nền tối; đóng thông báo hệ thống và tab trình duyệt có thông tin riêng.
- [ ] Không có token, mật khẩu, access key hay id tài khoản AWS trên màn hình: gán token vào biến (`X=$(…)`), không `echo "$X"`, không `set -x`, không `curl -v`, không mở file `.env`. Lịch sử shell không chứa token (bật `HISTCONTROL=ignorespace` hoặc mở phiên mới).
- [ ] Thử micro 30 giây: nghe lại, tiếng rõ, không ồn, không có thông báo hệ thống chen vào.
- [ ] Đồng hồ bấm giờ (điện thoại hoặc `time`) cho bước 8; lời dẫn đã đọc qua một lần, đủ ý chính ở bảng trên.
- [ ] Token còn hạn (sống 15 phút): lấy ngay đầu đoạn C và lấy lại trong khung hình ở đầu đoạn I (mốc 13:00); không lấy sẵn từ buổi trước.

## 4. Sau khi quay

1. Xem lại **toàn bộ** video một lần ở tốc độ thường: không lộ bí mật; mọi lệnh có kết quả mong đợi; tiếng nghe rõ; độ dài 15–20 phút.
2. Tải lên nơi nhóm chọn (Drive, YouTube chưa liệt kê...), quyền xem cho giảng viên và nhóm. **Không** đưa file video vào git (`*.mp4`, `*.mov`, `*.mkv`, `*.webm` đều bị `.gitignore` chặn).
3. Điền [midterm-demo-video.md](../deliverables/midterm-demo-video.md): link, ngày, SHA, người nói, người gõ, thời lượng, môi trường (local hoặc cloud), kết quả từng dòng checklist.
4. Cập nhật các dòng [BACKLOG](../BACKLOG.md) mà lần quay này đáp ứng, ghi SHA đã quay và thời gian bước 8 thật: **BL-351** (người nhóm chạy lại kịch bản trên đúng commit sẽ quay; nếu quay trên local thì phần «trên cloud» còn mở, ghi rõ), **BL-228** (người thật bấm giờ tra `C`, dưới 5 phút thì xóa dòng).
5. Cloud (nếu quay trên cloud): `terraform destroy` rồi `bash infra/scripts/verify-clean.sh` thoát 0 ngay sau khi quay.
6. Xóa dòng BL-390 khỏi BACKLOG và báo cổng ra tuần 5 «video demo toàn luồng» đạt cho techlead (agent không sửa board).

## 5. Nếu có sự cố khi quay

| Sự cố | Làm gì |
|---|---|
| Lệnh trả mã khác mong đợi | Dừng, nói «chúng ta dừng lại để xem», chạy lại từ bước 0 (reset) rồi quay lại từ đầu; không sửa tay số dư |
| `401` với `TOKEN_EXPIRED` | Token quá 15 phút: lấy lại bằng đúng lệnh `tok` cũ trong cùng terminal (cùng `RUN`, cùng `--sub`), **không reset**, **không dừng ghi**; nói rõ «token hết hạn nên lấy lại», rồi gõ lại lệnh vừa lỗi |
| Cờ không xuất hiện sau 5 giây | Worker chưa chạy: kiểm `APP_ROLE=both` và ElasticMQ (`docker compose ps`); chờ thêm vài giây rồi lặp lệnh bước 5 |
| Mất `C` (cửa sổ bị xóa) | Không cần quay lại: tra `action=transfer` ở `/v1/audit/entries` bằng token kiểm toán viên để lấy lại `correlationId` của giao dịch (xem [Quy tắc khi quay](demo-midterm-end-to-end.md#quy-tắc-khi-quay)) |
| `429` do giới hạn tốc độ | Bật process với `RATE_LIMIT_*` đã nới ([Chuẩn bị chung](demo-midterm-end-to-end.md#chuẩn-bị-chung-local)) |
| Cổng 5432 hoặc 6379 bị chiếm | Dùng `compose.override-ports.yml` ở phần Chuẩn bị chung |
| Lộ token hoặc bí mật lên màn hình | Hủy bản quay, xóa file, **thu hồi token đó** (đổi khóa dev hoặc đợi hết hạn 15 phút nếu là token dev; thu hồi người dùng Cognito nếu là cloud), quay lại |
