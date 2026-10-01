# So sánh phương án triển khai: VPS tự quản vs Cloud managed services

> **Trạng thái:** đề xuất, chờ cả nhóm quyết (dự kiến thành ADR-11 "Nền tảng triển khai").
> **Phạm vi:** chỉ so sánh nơi chạy hệ thống. Thiết kế ứng dụng (modular monolith, ledger trong một transaction, outbox, idempotency) giữ nguyên ở cả hai phương án.
> Giá lấy từ trang giá và bài tổng hợp công khai (nguồn ở cuối file), chủ yếu là giá region US East/EU. Region Singapore thường đắt hơn; cần tính lại trước khi đưa vào báo cáo. Các con số đánh dấu *(GĐ)* là ước lượng của nhóm.

## 1. Bối cảnh

Có ý kiến đề xuất thuê VPS rồi tự cài đặt để tiết kiệm chi phí, thay cho phương án AWS trong `03_HIGH_LEVEL_ARCHITECTURE.md`. Câu hỏi cần trả lời:

1. Tổng chi phí thật (tiền + thời gian của 6 người trong 10 tuần) của mỗi phương án là bao nhiêu?
2. Mỗi phương án có đạt được NFR đã cam kết ở P1 không?
3. Phương án nào giúp trả lời tốt 12 câu Architecture Defense và các deliverable P3/P4?

## 2. Hai phương án

| | **A. VPS tự quản** | **B. Cloud managed services** |
|---|---|---|
| Mô hình (theo bài giảng P1) | IaaS: thuê máy ảo, tự lo OS, runtime, database, backup, bảo mật, giám sát | Managed services: thuê trực tiếp capability (database, queue, identity, monitoring) |
| Ví dụ nhà cung cấp | Hetzner, DigitalOcean Droplet, BizFly, VNG, 123Host... | AWS (thiết kế hiện tại); Azure hoặc GCP là phương án thay thế tương đương |
| Nhóm tự làm | Gần như mọi thứ dưới tầng ứng dụng | Business logic + cấu hình hạ tầng bằng Terraform |

## 3. Kiến trúc khi chạy trên VPS

Toàn bộ hệ thống nằm trên 1 VPS (hoặc 2 nếu muốn dự phòng), chạy bằng `docker compose`.

| Thành phần trong thiết kế | Phương án B (AWS) | Thay thế trên VPS | Ghi chú |
|---|---|---|---|
| Load balancer + TLS | ALB | Caddy hoặc Nginx + Let's Encrypt | Caddy tự lấy và gia hạn chứng chỉ |
| WAF | AWS WAF | Không có, hoặc CrowdSec/fail2ban | Yếu hơn đáng kể |
| Chạy container | ECS Fargate | Docker Compose | Không có rolling update sẵn; phải tự viết script |
| PostgreSQL | RDS (backup, PITR, Multi-AZ) | Postgres trong container hoặc cài trực tiếp | Phải tự làm backup, PITR, restore |
| Backup / PITR | Có sẵn | WAL-G hoặc pgBackRest đẩy WAL lên object storage, `archive_timeout = 300` để đạt RPO ≤ 5 phút | Phải tự diễn tập restore để chứng minh RTO |
| Queue + DLQ | SQS + DLQ | Bỏ broker: worker đọc thẳng bảng outbox (`SKIP LOCKED`), đếm số lần thử, quá ngưỡng thì chuyển sang bảng `dead_letters`. Hoặc tự chạy RabbitMQ | Bỏ broker làm hệ thống đơn giản hơn, nhưng DLQ và alarm phải tự viết |
| Redis (rate limit, denylist, bộ đếm fraud) | ElastiCache Valkey | Container Valkey trong cùng `docker compose` | Dễ dựng; không có replica nên mất dữ liệu khi restart (chấp nhận được vì Redis không giữ dữ liệu gốc) |
| Identity | Cognito | Tự cấp JWT (băm mật khẩu bằng argon2/bcrypt) hoặc tự chạy Keycloak | Tự cấp JWT là thêm một bề mặt tấn công do nhóm tự viết |
| Secret / mã hóa | Secrets Manager, KMS | File `.env` quyền hạn chặt, hoặc `sops`; mã hóa ổ đĩa tùy nhà cung cấp | Khó chứng minh "encryption at rest" bằng cấu hình chuẩn |
| Logs / metrics | CloudWatch | Prometheus + Grafana + Loki | Stack giám sát ăn RAM ngay trên máy đang chạy DB |
| Image registry | ECR | GitHub Container Registry | Miễn phí cho mức dùng của nhóm |
| IaC | Terraform (AWS provider) | Terraform provider của nhà cung cấp VPS (Hetzner, DO, BizFly, VNG đều có) + Ansible/cloud-init | Phải viết thêm phần cấu hình trong máy |
| CI/CD | GitHub Actions → ECR → ECS | GitHub Actions → GHCR → SSH vào VPS chạy `docker compose pull && up` | Rollback = chạy lại image tag cũ |

## 4. Chi phí tiền

### 4.1 Phương án A — VPS

| Khoản | Giá tham khảo |
|---|---|
| Hetzner CX22 (2 vCPU, 4 GB) — EU | €4,49/tháng (từ 1/4/2026); Singapore đắt hơn |
| DigitalOcean Basic 4 GB (2 vCPU) | $24/tháng |
| BizFly 4 GB, 2 vCPU, 40 GB SSD | 240.000 VND/tháng |
| 123Host 4 GB, 2 CPU, 40 GB SSD | $22,11/tháng |
| Object storage cho backup WAL | Vài đô/tháng *(GĐ)* |
| Tên miền | Tùy (có thể dùng subdomain miễn phí) |
| **Tổng, 1 VPS** | **~$5–30/tháng → ~$15–75 cho 10 tuần** |
| **Tổng, 2 VPS (có dự phòng)** | Khoảng gấp đôi |

### 4.2 Phương án B — AWS (cấu hình dev tối thiểu, không NAT Gateway)

| Khoản | $/tháng nếu chạy 24/7 (US East, ước lượng) |
|---|---|
| RDS db.t4g.micro Single-AZ + 20 GB | ~14 |
| ALB | ~18 |
| 2 task Fargate 0,25 vCPU / 0,5 GB | ~10–18 |
| IPv4 public (~$0,005/giờ mỗi IP) | ~11 |
| WAF | ~8–10 |
| KMS, Secrets Manager, CloudWatch, ECR | ~5 |
| ElastiCache Valkey (Serverless tối thiểu ~$6, hoặc node `cache.t4g.micro` ~$9) | ~6–10 |
| **Tổng** | **~$70–85/tháng** |

| Kịch bản 10 tuần | Chi phí |
|---|---|
| Chạy 24/7 | ~$160–195 (chưa tính chênh lệch region Singapore) — sát hoặc vượt credit $200 |
| Chỉ dựng khi làm việc/demo (~50 giờ/tuần), `terraform destroy` phần còn lại, WAF chỉ bật tuần 6–8 | ~$45–75 |

**Credit:** tài khoản AWS mới nhận $100 khi đăng ký và thêm tối đa $100 khi hoàn thành 5 hoạt động (mỗi hoạt động $20). Credit hết hạn sau 6 tháng hoặc khi dùng hết. Nếu nhóm không có thẻ thanh toán quốc tế, Azure for Students cho $100 không cần thẻ và miễn phí Postgres B1ms 750 giờ/tháng.

### 4.3 Kết luận về tiền

- **Không có credit:** VPS rẻ hơn rõ rệt (~$15–75 so với ~$45–195).
- **Có credit AWS $200 hoặc Azure for Students:** tiền túi thực trả của phương án B **gần như bằng 0** nếu dựng/xóa theo giờ làm việc. Khi đó lợi thế về tiền của VPS gần như biến mất, và thứ còn lại để so là thời gian và NFR.

## 5. Chi phí thời gian

Đây là khoản thường bị bỏ quên. Bài giảng P1 (slide 45–46) đặt câu hỏi: *"What is the business value of building this ourselves?"*

| Việc | VPS | Cloud |
|---|---|---|
| Hardening máy (SSH key, firewall, cập nhật bảo mật tự động, user không phải root) | Phải làm | Không cần |
| TLS | Caddy làm gần như tự động | ALB + ACM |
| Postgres backup + PITR + diễn tập restore | Tự dựng WAL-G/pgBackRest, tự viết script restore | Có sẵn, chỉ diễn tập |
| Queue + DLQ + alarm | Tự viết (bảng `dead_letters` + cảnh báo) hoặc vận hành RabbitMQ | Cấu hình SQS |
| Đăng nhập, cấp và xác thực token | Tự viết hoặc vận hành Keycloak | Cấu hình Cognito |
| Giám sát | Dựng và giữ Prometheus/Grafana/Loki | CloudWatch có sẵn, chỉ làm dashboard |
| Học công cụ | Linux, Docker, Ansible | Terraform AWS, IAM (đường cong học khá dốc) |
| **Ước lượng thêm cho nhóm** *(GĐ)* | **~10–15 ngày-người** cho phần vận hành | **~5–8 ngày-người** cho Terraform/IAM |

Phần lớn thời gian thêm của phương án A dồn vào #5 (Platform) và một phần #6. Nó lấy bớt thời gian khỏi phần mà đề bài chấm nặng nhất: đúng-sai khi chạy đồng thời, idempotency, failure handling.

## 6. Ảnh hưởng tới NFR đã cam kết ở P1

| NFR | VPS | Cloud (AWS) |
|---|---|---|
| Correctness (0 mất/nhân đôi tiền) | Như nhau — nằm ở thiết kế DB, không phụ thuộc nơi chạy | Như nhau |
| Latency p95 < 300 ms | Đạt; thậm chí nhanh hơn vì app và DB cùng máy | Đạt |
| Throughput 120 RPS | Đạt với 2–4 vCPU | Đạt |
| Availability 99,9% | **Không đạt được một cách đáng tin**: 1 máy là điểm lỗi duy nhất. Phải hạ mục tiêu (ví dụ 99,5% hoặc "best effort") | Đạt ở cấu hình production (RDS Multi-AZ, ≥ 2 task trên 2 AZ) |
| RPO ≤ 5 phút | Đạt nếu tự dựng WAL archiving ra ngoài máy | PITR có sẵn |
| RTO ≤ 30 phút | Đạt nếu có script restore và đã diễn tập | Restore/failover có sẵn |
| Encryption at rest | Phụ thuộc nhà cung cấp; khó chứng minh | KMS, bật bằng một dòng cấu hình |
| Least privilege | Hạn chế (một máy, một user chạy mọi thứ) | IAM role riêng cho từng task, DB role riêng |
| Cost ≤ $150–200/tháng | Đạt dễ dàng | Đạt nếu dựng/xóa theo giờ |

## 7. Ảnh hưởng tới deliverable và câu hỏi bảo vệ

| Câu Defense / deliverable | VPS | Cloud |
|---|---|---|
| **4.** Vì sao chọn kiến trúc này? | Phải giải thích vì sao tự vận hành thay vì dùng managed service — đi ngược thông điệp "build vs buy" của bài giảng | Khớp với bài giảng |
| **7.** Dependency hỏng thì sao? | DB hoặc máy hỏng là cả hệ thống dừng; demo failover gần như không làm được | Demo được RDS failover, kill task, DLQ |
| **8.** Deploy và rollback thế nào? | SSH + `docker compose`; có downtime ngắn khi restart nếu không tự làm blue-green | ECS rolling update có health check, rollback về task definition cũ |
| **9.** Bảo vệ dữ liệu và truy cập? | Tự hardening, tự quản secret — nhiều câu hỏi khó hơn | KMS, IAM, security group, WAF |
| **10.** Làm sao biết hệ thống khỏe? | Tự dựng Prometheus/Grafana — làm được | CloudWatch + alarm |
| **11.** Tốn bao nhiêu tiền? | Trả lời rất tốt | Trả lời tốt nếu có hóa đơn thật và kịch bản dựng/xóa |
| **P3** (IaC, CI/CD, container, rollback) | Làm được nhưng phần IaC mỏng hơn | Đầy đủ |
| **P4** (reliability, failure scenario) | Yếu ở phần HA/failover | Đầy đủ |

## 8. Tóm tắt ưu nhược

**VPS tự quản**
- ✅ Rẻ nhất khi không có credit; chi phí dễ đoán, không sợ hóa đơn bất ngờ
- ✅ Học Linux và vận hành thật
- ✅ Không cần thẻ quốc tế nếu dùng nhà cung cấp trong nước
- ❌ Tốn thêm nhiều thời gian vận hành
- ❌ Không đạt 99,9%; demo failover yếu
- ❌ Bảo mật và mã hóa phải tự làm, khó chứng minh
- ❌ Lệch trọng tâm môn học (cloud như application platform, managed services)

**Cloud managed services**
- ✅ Đạt đủ NFR đã cam kết; demo được HA, failover, rollback
- ✅ Khớp với nội dung bài giảng và tài liệu nhóm đã viết
- ✅ Tiền túi gần 0 nếu dùng credit và dựng/xóa theo giờ
- ❌ Đường cong học Terraform/IAM
- ❌ Rủi ro hóa đơn nếu quên xóa tài nguyên hoặc lỡ tạo NAT Gateway
- ❌ Cần thẻ quốc tế (AWS, GCP) hoặc email trường (Azure for Students)

## 9. Phương án kết hợp

| Phương án | Mô tả | Đánh giá |
|---|---|---|
| **H1. Local + Cloud** | Dev hằng ngày bằng `docker compose` trên máy cá nhân; cloud chỉ dùng cho deploy thật, demo, load test | **Khuyến nghị.** Rẻ, dev nhanh, vẫn có đủ tính năng cloud khi cần chấm |
| H2. VPS làm staging + Cloud khi demo | VPS chạy liên tục, cloud chỉ bật ở tuần demo | Không khuyến nghị: phải duy trì hai bộ hạ tầng và hai quy trình deploy |
| H3. VPS + database managed | VPS chạy app, DB dùng dịch vụ managed (ví dụ DigitalOcean Managed Postgres từ $15/tháng) | Giảm gánh backup, nhưng vẫn thiếu queue, identity và HA cho tầng app |

## 10. Khuyến nghị

**Chọn phương án B (Cloud) theo mô hình H1**, với điều kiện nhóm lấy được một trong hai:
- Tài khoản AWS có credit (cần thẻ quốc tế), hoặc
- Azure for Students (chỉ cần email trường).

Lý do: khi có credit, tiền túi của hai phương án gần như bằng nhau. Phương án B giữ được toàn bộ NFR đã cam kết, trả lời tốt hơn các câu 4, 7, 8, 9 và làm đầy đủ P3/P4, trong khi tiết kiệm được khoảng 1–2 tuần-người vận hành.

**Chỉ chọn phương án A khi** nhóm không thể có tài khoản cloud nào. Khi đó phải:
1. Quyết định trước tuần 2 để #5 kịp chuyển hướng.
2. Sửa NFR ở P1: hạ availability, ghi rõ cách đạt RPO/RTO bằng WAL archiving.
3. Viết ADR giải thích lựa chọn IaaS và các đánh đổi ở mục 6–7.
4. Sửa thiết kế: worker đọc outbox trực tiếp + bảng `dead_letters`, tự cấp JWT hoặc Keycloak.
5. Chuẩn bị câu trả lời cho câu 7 và 8 dựa trên giới hạn của một máy.

## 11. Cần nhóm xác nhận

- [ ] Có ai có thẻ thanh toán quốc tế để mở tài khoản AWS không?
- [ ] Có ai đăng ký được Azure for Students bằng email trường không?
- [ ] Nhóm chọn phương án nào, và ai là người chịu trách nhiệm tài khoản/chi phí (mặc định #5)?

## Nguồn

- [AWS Free Tier: $200 credits và free plan 6 tháng](https://aws.amazon.com/about-aws/whats-new/2025/07/aws-free-tier-credits-month-free-plan/)
- [Giá RDS db.t4g.micro](https://www.bytebase.com/dbcost/rds/instance/db.t4g.micro/)
- [AWS Fargate pricing](https://aws.amazon.com/fargate/pricing/)
- [Giá AWS ALB](https://cloudchipr.com/blog/aws-load-balancer-pricing)
- [Azure for Students](https://learn.microsoft.com/en-us/azure/education-hub/about-azure-for-students)
- [Azure Postgres Flexible Server trên free account](https://learn.microsoft.com/en-ie/azure/postgresql/flexible-server/how-to-deploy-on-azure-free-account)
- [Giá Hetzner từ 1/4/2026](https://agentdeals.dev/hetzner-pricing-2026)
- [Giá DigitalOcean Droplet](https://www.digitalocean.com/pricing/droplets)
- [DigitalOcean Managed PostgreSQL pricing](https://docs.digitalocean.com/products/databases/postgresql/details/pricing/)
- [Bảng giá BizFly Cloud Server](https://bizflycloud.vn/en/cloud-server/bang-gia)
- [123Host Cloud VPS](https://123host.vn/en/virtual-private-server.html)
- [VNG Cloud Terraform provider](https://github.com/vngcloud/terraform-provider-vngcloud)
- [BizFly Cloud Terraform](https://bizflycloud.vn/docs/api_cli/terraform/configure/)
