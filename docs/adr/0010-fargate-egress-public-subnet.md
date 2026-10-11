# ADR-10: Đường ra mạng của Fargate: task ở public subnet có IP công khai, không dùng NAT Gateway

| | |
|---|---|
| Trạng thái | **Accepted** |
| Ngày | 2026-10-11 |
| Người viết | #5 (Platform) |
| Người duyệt | #6 (cặp đôi); cả nhóm |
| Liên quan | Driver D-8 · NFR-COST-01, NFR-SEC-06 · [`docs/03` §12, §13](../03_HIGH_LEVEL_ARCHITECTURE.md) · [ADR-11](0011-aws-managed-session-based.md) |

## Bối cảnh

Task Fargate cần gọi ra ngoài VPC: kéo image từ ECR, đẩy log lên CloudWatch Logs, đọc Secrets Manager, gửi và nhận SQS, tải JWKS của Cognito (endpoint công khai). RDS và ElastiCache nằm trong VPC, không cần ra internet.

Có ba cách cho task trong VPC ra ngoài. Cách nào cũng an toàn được, nhưng chi phí chênh nhau gấp nhiều lần so với ngân sách credit khoảng 200 USD (ADR-11).

## Các phương án

Giá tham khảo region `ap-southeast-1`, tính cho 2 AZ, chạy 24/7. Kiểm lại bằng AWS Pricing Calculator trước khi đưa vào báo cáo.

| Tiêu chí | A. Private subnet + NAT Gateway | B. Private subnet + VPC interface endpoint | **C. Public subnet, task có IP công khai, security group chỉ nhận từ ALB** |
|---|---|---|---|
| Chi phí cố định | ~0,059 USD/giờ mỗi NAT ≈ 43 USD/tháng mỗi AZ, cộng phí xử lý dữ liệu theo GB | ~0,013 USD/giờ mỗi endpoint mỗi AZ; cần ít nhất 5 endpoint (ECR api, ECR dkr, Logs, Secrets Manager, SQS) ≈ 95 USD/tháng cho 2 AZ. JWKS Cognito vẫn cần đường ra internet | **0,005 USD/giờ mỗi IPv4 ≈ 3,6 USD/tháng mỗi task** |
| Inbound từ internet tới task | Không | Không | **Không: security group chỉ cho phép từ security group của ALB** |
| Độ phức tạp Terraform | Trung bình | Cao (nhiều endpoint, DNS riêng) | **Thấp** |
| Dựng/xóa theo phiên | NAT tạo/xóa được nhưng dễ quên | Như A | **Không có tài nguyên đắt để quên** |

## Quyết định

Chọn **C**:

- VPC 2 AZ. Mỗi AZ có một **public subnet** (ALB và task ECS) và một **private subnet** (RDS, ElastiCache). Private subnet **không có route ra internet**.
- Task ECS chạy ở public subnet với `assignPublicIp = ENABLED`. Security group của task **chỉ** nhận cổng 3000 từ security group của ALB. Task `worker` không nhận inbound nào.
- Security group của RDS và ElastiCache chỉ nhận từ security group của task.
- Thêm **gateway endpoint cho S3** (miễn phí) để lớp image ECR đi trong mạng AWS.
- **Không tạo NAT Gateway và không tạo interface endpoint.** Terraform có kiểm tra trong review: PR nào thêm `aws_nat_gateway` phải kèm ADR mới.

## Lý do

- An toàn tương đương A và B ở điểm quan trọng nhất: không ai từ internet nối thẳng tới task, vì security group chặn. Đường ra internet của task là thứ nó vẫn cần (JWKS Cognito).
- Rẻ hơn A khoảng 10 lần và B khoảng 25 lần ở quy mô 2–4 task. Với dựng/xóa theo phiên, khoản này gần như bằng 0.
- Ít tài nguyên hơn thì dựng lại nhanh hơn, phục vụ mục tiêu dựng môi trường từ trống trong 30 phút (DBS-139).

## Đánh đổi và hệ quả

- Task có IP công khai. Nếu ai đó mở nhầm security group thì task lộ ra internet. Giảm bằng: security group viết bằng Terraform và được review, không mở cổng nào ngoài 3000 từ ALB, và test thử nối thẳng tới IP công khai của task phải thất bại.
- Câu hỏi bảo vệ "vì sao app không ở private subnet" cần trả lời bằng bảng chi phí ở trên và lập luận security group.
- Sơ đồ docs/03 §13 vẽ ECS ở public subnet, RDS và Redis ở private subnet.
- **Xem lại khi:** chạy production thật lâu dài, hoặc yêu cầu tuân thủ cấm workload có IP công khai. Khi đó chuyển sang A với một NAT dùng chung.

## Cách kiểm chứng

- `terraform plan` không có `aws_nat_gateway` hay `aws_vpc_endpoint` kiểu Interface (DBS-33).
- Thử `curl` thẳng tới IP công khai của task từ internet → timeout. Qua ALB → 200 (DBS-34).
- Cost Explorer theo dịch vụ không có dòng NAT Gateway (DBS-143, DBS-179).
