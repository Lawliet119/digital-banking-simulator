# platform-infra — Capacity và chi phí thật (P4)

> **Status:** Active · **Owner:** #5 · **Verified against code:** n/a (số lấy từ Cost Explorer và `aws budgets`, ngày 2026-11-22; cấu hình đối chiếu với `infra/terraform/envs/dev/session`, `envs/prod/session`, `modules/waf`) · **Cập nhật:** 2026-11-22 (DBS-179)

Mục «capacity & cost» của P4. **Ước lượng, chưa đối chiếu hóa đơn:** số ở đây là số Cost Explorer đã chốt tới hết 2026-11-21 UTC cộng mô hình đơn giá; phần phiên AWS-A ngày 22/11 UTC chưa có trong Cost Explorer (trễ khoảng 24 giờ), việc đối chiếu là [BL-426](../../BACKLOG.md). Nguồn gốc từng số: [báo cáo 2026-11-22](cost-reports/2026-11-22.md) (script [`cost-report.py`](../../../infra/scripts/cost-report.py) của DBS-143), output thô và công thức ở [manual-test.txt](../../features/screenshots/DBS-179/manual-test.txt) và [calc.py](../../features/screenshots/DBS-179/calc.py).

## 1. Tóm tắt

| Câu hỏi | Trả lời | Nguồn |
|---|---|---|
| Đã tiêu bao nhiêu? | **8,2642 USD** gộp từ 01/10 tới hết 21/11 (trước credit); credit đã dùng 8,7053 USD từ 01/08 (bằng đúng chi phí gộp từng tháng: 0,4411 + 0,0001 + 0,4977 + 7,7665), còn khoảng **191,2947 / 200 USD** | báo cáo mục 1, 4; manual-test M-179-07 |
| So với ngân sách tháng? | Tháng 11: ACTUAL **7,766 USD** (5,2 %), FORECASTED cả tháng 8,567 USD, trên Budget **150 USD** | `aws budgets describe-budgets` |
| Chạy 24/7? | dev **≈ 113,23 USD/tháng** (105,23 khi tắt WAF từ 26/11); production (Multi-AZ) **≈ 203,55 USD/tháng**, vượt Budget 150 USD và trần 200 USD của NFR-COST-01 | §5 |
| Một phiên làm việc? | dev 3 giờ **≈ 0,45 USD**; phiên đo tải 5 giờ **≈ 1,72 USD** cộng phí theo tải (≈ 0,26 USD mỗi giờ 120 RPS riêng phí request WAF) | §4 |
| Còn tới 13/12? | khoảng **6–7 USD** (6,15–7,30; ≤ 3,8 % credit còn lại); script dự báo 16,8232 USD, là cận trên | §6 |

## 2. Chi phí thật theo dịch vụ (từ 01/10 tới hết 21/11)

Top theo lũy kế (USD, trước credit; đầy đủ ở báo cáo mục 1): RDS 1,4266 · AWS WAF 1,0131 · ECS 0,9558 · ALB 0,9283 · KMS 0,8933 · ElastiCache 0,7488 · Secrets Manager 0,7072 · EC2 (máy tải) 0,5155 · VPC (IPv4 công khai) 0,4700 · Cost Explorer 0,3500 · SQS 0,1434. **Tổng 8,2642.** Ngày UTC 21/11 là 4,5917 USD (55,6 % tổng).

**Phiên và giờ dựng** (báo cáo mục 2; giờ ALB tính theo giờ đồng hồ có chạy, kể cả giờ chưa trọn): 7 ngày có phiên (25/10, 29/10, 12/11–15/11, 21/11); ALB 33 giờ, ElastiCache 39 node-giờ, RDS Multi-AZ `db.t4g.small` 8,689 giờ, Single-AZ `db.t4g.micro` 7,797 giờ và `db.t4g.small` 1,810 giờ, Fargate 14,452 vCPU-giờ.

| Ngày UTC | USD | Giờ ALB | Việc |
|---|---:|---:|---|
| 25/10 | 0,0801 | 2 | phiên dựng ghi ở [DBS-33](../../features/DBS-33-terraform-vpc-ecr.md) |
| 29/10 | 0,1658 | 2 | có RDS, Valkey, ALB; task chưa xác định |
| 12/11 | 0,1375 | 1 | [DBS-139](../../features/DBS-139-dev-env-rebuild-demo-checklist.md) (dựng lại dev) |
| 13/11 | 0,1565 | 1 | task chưa xác định |
| 14/11 | 1,1895 | 11 | Multi-AZ và failover ([DBS-180](../../features/DBS-180-rds-multi-az.md), [DBS-181](../../features/DBS-181-rds-failover-drill.md)) |
| 15/11 | 0,4508 | 4 | sự cố cloud ([DBS-184](../../features/DBS-184-cloud-incident-scenarios.md), [DBS-185](../../features/DBS-185-ac-5-10-kill-task-cloud.md)) |
| 21/11 | 4,5917 | 12 | bốn phiên: đo tải 12/60/120 RPS và tối ưu p95 ([DBS-166](../../features/DBS-166-load-report.md), [DBS-173](../../features/DBS-173-p95-120rps.md)), đo BL-418 (stack 16:24Z–18:13Z, đo 16:58Z–18:02Z, [báo cáo 04](../load-tests/04-ket-qua-bl-418-2026-11-22.md)) và giờ đầu (23:00Z–24:00Z) của phiên AWS-A ([DBS-167](../../features/DBS-167-redis-fault-load.md), dựng 06:30 giờ Việt Nam 22/11) |
| 16/11–20/11 | 0,0619 – 0,0627 | 0 | khoản giữ lại |

## 3. Đơn giá quan sát (USD, `ap-southeast-1`)

Mỗi đơn giá = chi phí ÷ quantity của chính usage type đó. RDS, Valkey, ALB, Fargate, Secrets Manager lấy từ báo cáo mục 2 (cả kỳ); IPv4, máy tải, WAF, KMS, SQS từ Cost Explorer ngày 21/11 nhóm `USAGE_TYPE` ([manual-test.txt](../../features/screenshots/DBS-179/manual-test.txt) M-179-04b). Khớp ước tính ADR-11 và README Terraform.

| Thành phần | Usage type | Đơn giá | Ghi chú |
|---|---|---:|---|
| RDS `db.t4g.micro` Single-AZ | `InstanceUsage:db.t4g.micro` | 0,0250/giờ | |
| RDS `db.t4g.small` Single-AZ | `InstanceUsage:db.t4g.small` | 0,0510/giờ | |
| RDS `db.t4g.small` Multi-AZ | `Multi-AZUsage:db.t4g.small` | 0,1020/giờ | gấp đôi Single-AZ |
| RDS storage gp3 | `RDS:GP3-Storage`, `Multi-AZ-GP3-Storage` | 0,138 và 0,276/GB-tháng | |
| Valkey `cache.t4g.micro` | `NodeUsage:cache.t4g.micro` | 0,0192/giờ/node | |
| ALB | `LoadBalancerUsage` | 0,0252/giờ | cộng LCU (0,0536 cho 6,701 LCU-giờ ngày 21/11) |
| Fargate | `Fargate-vCPU-Hours:perCPU`, `Fargate-GB-Hours` | 0,0506/vCPU-giờ, 0,0055/GB-giờ | |
| IPv4 công khai | `PublicIPv4:InUseAddress` | 0,005/giờ/địa chỉ | 0,2649 cho 52,971 địa chỉ-giờ; task ở public subnet (ADR-10) |
| Máy tải `t3.medium` | `BoxUsage:t3.medium` | 0,0528/giờ | 0,5155 cho 9,764 giờ; cộng IPv4 và EBS gp3 |
| WAF | `WebACLV2`, `RuleV2`, `RequestV2-Tier1` | 5/web ACL-tháng, 1/rule-tháng (3 rule), 0,60/triệu request | 0,0644 và 0,0386 cho 0,013 và 0,039 tháng; 0,8493 cho 1.415.483 request |
| Secrets Manager | `AWSSecretsManager-Secret` | 0,40/secret-tháng | |
| SQS | `Requests-Tier1` | 0,106/triệu request | 0,1434 cho 1.354.806 request ngày 21/11 |
| KMS | `KMS-Keys` | 1,0/key-tháng | 0,0264 cho 0,026 tháng |

## 4. Chi phí theo giờ và theo phiên

Cấu hình theo docs/03 §13.1; tính bằng đơn giá §3 (task `api` 0,5 vCPU/1 GB = 0,0308/giờ, `worker` 0,25 vCPU/0,5 GB = 0,0154/giờ; storage 20 GB; ALB có 2 địa chỉ IPv4).

| Thành phần (USD/giờ) | Dev (Single-AZ) | Production (Multi-AZ) |
|---|---:|---:|
| RDS instance | 0,0250 (`db.t4g.micro`) | 0,1020 (`db.t4g.small` Multi-AZ) |
| RDS storage 20 GB | 0,0038 | 0,0076 |
| Valkey | 0,0192 (1 node) | 0,0384 (primary + replica) |
| ALB | 0,0252 | 0,0252 |
| Fargate `api` | 0,0308 (1 task) | 0,0616 (2 task) |
| Fargate `worker` | 0,0154 (1 task) | 0,0154 (1 task) |
| IPv4 công khai | 0,0200 (4 địa chỉ) | 0,0250 (5 địa chỉ) |
| **Cộng** | **0,1394** | **0,2752** |

Máy tải k6 (`t3.medium` 0,0528 + IPv4 0,005) thêm **0,0578/giờ**, nên cấu hình đo (production + máy tải) = **0,3330 USD/giờ**. `modules/waf` có 3 rule (`rate-limit`, hai managed rule group), nên phần cố định của WAF là 5 + 3 = **8,00 USD/tháng = 0,0110 USD/giờ**; WAF chỉ có ở `envs/dev/session` (kể cả khi đo tải), `envs/prod/session` không có WAF.

**Một công thức cho mọi phiên:** chi phí = số giờ × (giá giờ của cấu hình + 0,0110 WAF cố định) + phí theo tải. **Phí theo tải** không theo giờ: WAF 0,60 USD/triệu request (120 RPS một giờ = 0,43 triệu request = **0,2592 USD**; 12 RPS = 0,0259), cộng SQS request, data transfer giữa AZ, CPU credit RDS `t4g`, LCU, ở ngày đo tải ngoài WAF request bằng 0,0390 USD mỗi giờ ALB.

| Loại phiên | 3 giờ | 4 giờ | 5 giờ |
|---|---:|---:|---:|
| Dev (làm việc, kiểm tay) | 0,45 | 0,60 | 0,75 |
| Cấu hình đo (`dev/session` cỡ production, có WAF) + máy tải, chưa kể phí theo tải | 1,03 | 1,38 | 1,72 |

Dev theo kế hoạch ADR-11 (40–50 giờ/tuần): **6,01–7,52 USD/tuần**.

**Kiểm mô hình bằng ngày UTC 21/11** (số thật 4,5917, trừ khoản giữ lại 0,0627 còn 4,5290):

| Phần | USD | Tỉ lệ |
|---|---:|---:|
| Theo tải: WAF request 0,8493 + SQS request 0,1434 + data transfer giữa AZ 0,1508 + CPU credit RDS 0,1202 + LCU 0,0536 | 1,3173 | 29 % |
| Theo giờ dựng (phần còn lại: RDS, Valkey, ALB, Fargate, máy tải, IPv4, EBS, WAF cố định, secret, KMS) | 3,2117 | 71 % |

Mô hình cho ngày này: 12 giờ ALB × 0,3439 (cấu hình đo cộng WAF cố định) = 4,13, cộng phí theo tải thật 1,32 = **5,44 USD, cao hơn số thật (4,53) khoảng 20 %.** Lý do: giờ ALB tính cả giờ chưa trọn của bốn phiên, trong khi RDS Multi-AZ chạy 8,689 giờ và máy tải 9,764 giờ; phần theo giờ thật là 0,2676 USD mỗi giờ ALB so với 0,3439 của mô hình. **Mô hình là cận trên cho phiên ngắn** (sai thiên về cao, không về thấp).

## 5. Chạy 24/7 (730 giờ/tháng)

| | Dev | Production |
|---|---:|---:|
| Tài nguyên theo giờ × 730 | 101,75 | 200,87 |
| WAF cố định (1 web ACL + 3 rule); production không có | 8,00 | 0,00 |
| Khoản giữ lại (KMS, Secrets Manager của `base`: 0,0619 × 30,4 ngày) | 1,88 | 1,88 |
| Secret của phiên: dev 4 (RDS master + 3 `db_role`), production 2 (RDS master + `redis_auth`), × 0,40 | 1,60 | 0,80 |
| **Cộng, USD/tháng** | **113,23** | **203,55** |
| So Budget 150 USD | 75 % | **136 %** |
| So trần 200 USD của NFR-COST-01 (150–200) | 57 % | **102 %** |
| Số tháng tiêu hết credit còn lại 191,29 USD | 1,7 | 0,9 |

Dev khi WAF tắt (từ 26/11, BL-291): 105,23 USD/tháng. Chưa gồm phí request WAF của dev (0,60/triệu: 12 RPS liên tục = 31,5 triệu request/tháng ≈ 18,9 USD), SQS, data transfer. Kiểm với ADR-11 («24/7 cả 10 tuần ≈ 230–250 USD»): 10 tuần = 70 ngày ≈ 261 USD theo dev có WAF, cùng bậc. Kết luận: dựng rồi xóa theo phiên là bắt buộc, không chạy 24/7 cấu hình nào; dev 24/7 chỉ vừa trong Budget, production không vừa cả Budget lẫn trần 200.

## 6. Dự báo tới 13/12/2026 (hạn P4)

Cost Explorer đã chốt tới hết 21/11 UTC lúc chạy (22/11, chưa tới 24 giờ sau), nên số ngày 21/11 **có thể còn tăng**; theo số đó, nó gồm phiên BL-418 và (có thể) giờ đầu của phiên AWS-A. Phần chưa có và phần sắp tới:

| Khoản | USD | Cách tính |
|---|---:|---|
| Giữ lại 22/11–13/12 (22 ngày) | 1,36 | 0,0619 × 22 |
| Phiên AWS-A, phần ngày UTC 22/11 (DBS-167, DBS-178, DBS-186; hủy 08:37 giờ Việt Nam = 01:37Z, **chưa có trong Cost Explorer**) | 0,99–1,63 | 2 giờ ALB × 0,3439 + phí WAF theo tải 0,3–0,6; cận trên tính 3 giờ ALB nếu giờ 23:00Z 21/11 chưa có trong số đã chốt; DBS-167 tự ghi ≈ 0,5 USD/giờ |
| Phiên 5 AWS-B (DBS-174, DBS-175), dựng một lần ≤ 5 giờ | 2,30 | 5 × 0,3439 + 0,39 (1,5 giờ ở 120 RPS) + 5 × 0,0390 (phí tải khác) |
| Dự phòng một phiên làm lại | 1,5–2,0 | |
| **Cộng** | **≈ 6–7** (6,15–7,30) | không gồm API OpenAI của B2 (chi phí khác, có trần ở DBS-174) |

So với 191,29 USD credit còn lại, kế hoạch dùng không quá 3,8 %. Script dự báo 16,8232 USD (trung bình 7 ngày cuối 0,7647 USD/ngày × 22 ngày) là cận trên vì 7 ngày cuối gồm cả ngày đo tải 21/11. Con số «dự báo AWS» 8,5669 USD của báo cáo mục 4 **là dự báo cả tháng 11** (gồm 7,766 USD đã phát sinh; khớp FORECASTED 8,567 của Budget; `get-cost-forecast` cho các khoảng bắt đầu 22/11 và 23/11 trả cùng số): phần còn lại 22–30/11 ≈ 0,80 USD. Nhãn «[22/11, hết tháng)» của script là chưa chính xác, ghi ở [BL-427](../../BACKLOG.md). Dự báo AWS cho [22/11, 14/12) là 11,354 USD (cả tháng 11 cộng 1–13/12); trừ 7,766 đã phát sinh còn khoảng 3,59 USD sau 21/11, thấp hơn kế hoạch 6–7 USD vì AWS ngoại suy từ xu hướng nền và không biết trước phiên AWS-B.

## 7. Giới hạn

- **Chưa đối chiếu hóa đơn.** Số chi phí là Cost Explorer (UnblendedCost, ngày UTC), không phải hóa đơn; số dư credit chỉ có ở console Billing → Credits ([BL-426](../../BACKLOG.md)). Cost Explorer đã điều chỉnh số tháng 8 (0,0544 lúc DBS-143 ngày 04/11, 0,4411 nay), nên số cũ trong báo cáo 11-04 và 11-14 không dùng lại.
- Ngày UTC 21/11 gộp bốn phiên và hai cấu hình RDS; chi phí «theo phiên» ở §4 là mô hình theo giờ, kiểm trên cả ngày chứ không trên từng phiên riêng, và cao hơn thật khoảng 20 %.
- Đơn giá lấy từ số đã trả; đổi giá AWS hay đổi loại instance thì cập nhật §3. Phí request WAF 0,60/triệu suy từ 0,8493 USD cho 1.415.483 request.
- Số secret của phiên (4 ở dev, 2 ở production) suy từ Terraform (`rds.tf`, `db_roles.tf`, `redis.tf`); chi phí Secrets Manager ngày 21/11 (0,106 secret-tháng, trừ 2 secret của `base`) cần ít nhất 3 secret của phiên, phù hợp. Chưa đếm trực tiếp trên Secrets Manager; sai số vài chục xu mỗi tháng.
- Ngưỡng: Budget AWS báo ở 150 USD; NFR-COST-01 của BRD là «≤ 150–200 USD/tháng».
- So sánh Single-AZ và Multi-AZ kèm RTO/RPO: DBS-182 (task riêng).
