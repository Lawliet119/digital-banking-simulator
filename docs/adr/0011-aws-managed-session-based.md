# ADR-11: Chạy trên AWS bằng dịch vụ managed, dựng và xóa theo phiên làm việc

| | |
|---|---|
| Trạng thái | **Accepted** |
| Ngày | 2026-10-11 |
| Người viết | #5 (Platform) |
| Người duyệt | #6 (cặp đôi); cả nhóm |
| Liên quan | Driver D-7, D-8 · NFR-AVL-01, NFR-REC-01, 02, NFR-SEC-03, NFR-COST-01 · [`docs/03` §13](../03_HIGH_LEVEL_ARCHITECTURE.md) · [ADR-06](0006-cognito-ecs-fargate.md), [ADR-10](0010-fargate-egress-public-subnet.md), [ADR-12](0012-redis-valkey-node.md) |

## Bối cảnh

Có ý kiến thuê VPS rồi tự cài để tiết kiệm. Câu hỏi là phương án nào rẻ hơn khi tính cả tiền lẫn thời gian của 6 người trong 10 tuần, và phương án nào giữ được các NFR đã cam kết ở P1: availability 99,9% ở cấu hình production, RPO ≤ 5 phút, RTO ≤ 30 phút, mã hóa khi lưu, quyền tối thiểu.

Nhóm có tài khoản AWS với credit khoảng 200 USD. Ngân sách trần là 150–200 USD/tháng (NFR-COST-01).

## Các phương án

| Tiêu chí | A. VPS tự quản (Hetzner, DigitalOcean, BizFly…) | **B. AWS managed services** | C. Kết hợp: VPS chạy thường xuyên, cloud khi demo |
|---|---|---|---|
| Tiền túi trong 10 tuần | ~15–75 USD | **~0 USD nếu nằm trong credit** (ước tính ở phụ lục: ~80–100 USD credit) | Cộng cả hai |
| Thời gian vận hành thêm cho nhóm *(ước lượng)* | ~10–15 ngày-người: hardening, backup WAL, restore, giám sát, queue, đăng nhập | **~5–8 ngày-người: Terraform, IAM** | Hai bộ hạ tầng, hai quy trình deploy |
| Availability 99,9% | Không đáng tin: một máy là điểm lỗi duy nhất | **Đạt ở cấu hình production (RDS Multi-AZ, ≥ 2 task trên 2 AZ)** | Như A ngoài lúc demo |
| RPO ≤ 5 phút, RTO ≤ 30 phút | Tự dựng WAL archiving và tự diễn tập | **PITR, snapshot, failover có sẵn** | — |
| Mã hóa khi lưu, quyền tối thiểu | Khó chứng minh | **KMS, IAM role riêng từng task, DB role riêng** | — |
| Trả lời câu bảo vệ 4, 7, 8, 9 và làm P3/P4 | Yếu ở HA, failover, IAM | **Đầy đủ** | Phức tạp |
| Khớp trọng tâm môn học (cloud là application platform) | Lệch | **Khớp** | Một phần |

## Quyết định

Chọn **B theo mô hình "local + cloud"**:

- **Phát triển hằng ngày ở local**: `docker compose` (PostgreSQL 17, Valkey, ElasticMQ) với `APP_ROLE=both`. Không cần cloud để viết code hay chạy test.
- **Cloud chỉ dùng khi deploy thật, demo, load test và diễn tập sự cố.** Hạ tầng chia hai phần:

  | Phần giữ lại (gần như miễn phí) | Phần dựng và xóa theo phiên |
  |---|---|
  | S3 state, ECR, VPC + subnet + security group, Cognito user pool, Secrets Manager, KMS key, Budget | RDS, ElastiCache, ALB, ECS service (api, worker), WAF (chỉ tuần 6–8), dashboard và alarm |

- **Region `ap-southeast-1` (Singapore)**: gần Việt Nam nhất nên demo tương tác nhanh; giá cao hơn US East khoảng 20–30% nhưng vẫn nằm trong credit nhờ dựng/xóa theo phiên.
- **Tài khoản và chi phí do #5 giữ.** Mỗi thành viên có IAM user riêng có MFA, không ai dùng root.
- **AWS Budgets** cảnh báo ở 50, 100 và 150 USD, gửi email cho ít nhất 2 người (#5 và #6).
- **Tag bắt buộc** trên mọi tài nguyên: `project=dbs`, `env=dev|prod`, `owner=<vai>`. Tag dùng để đọc chi phí theo môi trường trong Cost Explorer.
- **Quy tắc phiên:** ai `terraform apply` phần dựng/xóa thì chịu trách nhiệm `terraform destroy` khi xong, và báo trong kênh chat lúc bật và lúc tắt. Cuối mỗi ngày #5 kiểm Cost Explorer; còn tài nguyên tính tiền thì xóa.

## Lý do

- Có credit thì tiền túi của B gần như bằng 0, nên lợi thế duy nhất của VPS biến mất. Thứ còn lại để so là thời gian và NFR, và B thắng ở cả hai.
- Thời gian tiết kiệm (khoảng 1–2 tuần-người) dồn vào đúng phần đề bài chấm nặng nhất: đúng sai khi đồng thời, idempotency, xử lý sự cố.
- Dựng/xóa theo phiên giữ chi phí khoảng một nửa credit, còn dư cho load test và diễn tập HA.

## Đánh đổi và hệ quả

- Rủi ro hóa đơn nếu quên xóa tài nguyên hoặc lỡ tạo NAT Gateway. Giảm bằng Budget ba mức, tag, kiểm Cost Explorer hằng ngày và ADR-10.
- Môi trường cloud không chạy 24/7, nên mục tiêu 99,9% chỉ đo trong các đợt bật cấu hình production. Báo cáo nói rõ điều này.
- Mỗi lần dựng mất thời gian (RDS và ElastiCache khoảng 10–15 phút). Mục tiêu dựng từ trống ≤ 30 phút (DBS-139).
- Phụ thuộc AWS. Thiết kế ứng dụng (modular monolith, outbox, idempotency) không đổi nếu chuyển cloud; chỉ Terraform phải viết lại.
- **Xem lại khi:** hết credit trước tuần 10, hoặc chi phí thật vượt 150 USD.

## Cách kiểm chứng

- Báo cáo chi phí tuần từ Cost Explorer theo dịch vụ và tag (DBS-143, DBS-179); tổng 10 tuần nằm trong credit.
- Dựng môi trường dev từ trống ≤ 30 phút, xóa xong chi phí ≈ 0 vào ngày hôm sau (DBS-33, DBS-139).
- Diễn tập RDS failover đo RTO (DBS-181); rollback ≤ 10 phút (DBS-156).

## Phụ lục: ước tính chi phí

Giá tham khảo `ap-southeast-1`, làm tròn. Kiểm lại bằng AWS Pricing Calculator; số thật lấy từ Cost Explorer.

**Cấu hình dev, theo giờ khi đang bật**

| Thành phần | Cấu hình | USD/giờ |
|---|---|---|
| RDS PostgreSQL 17 | `db.t4g.micro`, Single-AZ, 20 GB gp3 | ~0,025 |
| ALB | 1 ALB, tải nhẹ | ~0,03 |
| ECS Fargate `api` | 1 task, 0,5 vCPU / 1 GB | ~0,031 |
| ECS Fargate `worker` | 1 task, 0,25 vCPU / 0,5 GB | ~0,016 |
| IPv4 công khai | 2 task + 2 IP của ALB | ~0,02 |
| ElastiCache Valkey | `cache.t4g.micro`, 1 node (ADR-12) | ~0,016 |
| **Tổng** | | **~0,14** |

**Phần giữ lại, theo tháng:** Secrets Manager (~3 secret × 0,40), KMS (1 key × 1), ECR và S3 state (vài GB), CloudWatch Logs: khoảng 3–5 USD/tháng.

**Dự toán 10 tuần**

| Khoản | Giả định | USD |
|---|---|---|
| Dev theo phiên | ~40–50 giờ/tuần × 10 tuần × 0,14 | ~55–70 |
| Phần giữ lại | ~2,5 tháng × 4 | ~10 |
| WAF | Tuần 6–8 (5 USD/web ACL/tháng + 1 USD/rule/tháng + phí request) | ~6 |
| Cấu hình production (HA, load test) | ~20 giờ: RDS `db.t4g.small` Multi-AZ, `api` 2 task, Valkey có replica, máy chạy k6 cùng region | ~8–12 |
| **Tổng** | | **~80–100**, trong credit 200 |

Chạy 24/7 cả 10 tuần sẽ tốn khoảng 230–250 USD, vượt credit. Đây là lý do của quy tắc dựng/xóa theo phiên.
