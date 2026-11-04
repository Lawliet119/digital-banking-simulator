# DBS-143 · Báo cáo chi phí tuần đầu từ Cost Explorer theo dịch vụ và tag

> **Status:** Implemented · **Vai:** #5 Platform & Ops · **Cặp đôi review:** Dev · **Nhánh:** `chore/DBS-143-cost-report` · **PR:** [#55](https://github.com/Lawliet119/digital-banking-simulator/pull/55) · **Cập nhật:** 2026-11-04

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 5, Deliverable P4, Ưu tiên Medium, board "To Do". **Expect:** Chi phí minh bạch và so được với credit.
- **DoD** (nguyên văn, đánh số):
  1. Báo cáo theo dịch vụ (RDS, ElastiCache, ECS, ALB, SQS, CloudWatch, data transfer) và theo tag env, số giờ dựng
  2. So với ngân sách còn lại (credit khoảng 200 USD) và dự báo; đề xuất cắt giảm nếu cần
  3. Gửi nhóm vào thứ Hai; quy trình lặp lại ghi ở infra/terraform/README
- **Phụ thuộc:** DBS-4 (Done: budget và Cost Explorer bật; tag gắn trên tài nguyên), DBS-66 (Done, đã merge `main`).
- **Thực trạng** (đọc thật bằng `AWS_PROFILE=dbs-admin aws ce …`, 2026-11-04):
  - Credit trừ hết mọi khoản: nhóm theo `SERVICE` mà không lọc `RECORD_TYPE` thì mọi dịch vụ ra 0 USD. Phải lọc bỏ `Credit` và `Refund` mới thấy chi phí gộp.
  - `RECORD_TYPE` theo tháng (Usage / Credit, USD): 08/2026 0,0544 / −0,0544; 09/2026 0,0001 / −0,0001; 10/2026 0,4977 / −0,4977; 01–03/11 0,1536 / −0,1536. Credit trừ đủ từng tháng; **credit đã dùng từ 01/08 là 0,7058 USD**.
  - Chi phí gộp 01/10–03/11: **0,6514 USD**. Lớn nhất: KMS 0,285, Secrets Manager 0,180, ALB 0,101 (4 giờ), ElastiCache 0,038 (2 giờ node), RDS 0,021 (0,73 giờ instance + gp3).
  - Phiên dựng có phát sinh vào ngày 25/10 và 29/10 (theo `USAGE_TYPE` theo ngày).
  - **Tag `project`, `env`, `owner` đang `Inactive` trong Cost allocation tags**, nên Cost Explorer chưa nhóm được theo tag env. Việc bật tag (và backfill) là thay đổi cài đặt billing của tài khoản.
  - Budget "My Monthly Cost Budget" 150 USD: ngưỡng ACTUAL > 50, ACTUAL > 100, FORECASTED > 100; chưa có ACTUAL > 150 (BL-033, người dùng tự sửa trên console).
  - Cost Explorer không trả số dư credit còn lại; số đó chỉ có trên console Billing → Credits.
  - Dimension `SERVICE` 01/10–03/11 có cả `AWS Data Transfer` và `AWS Glue`. Tài khoản đứng riêng (`AWSOrganizationsNotInUseException`), nên tự bật được cost allocation tag.
  - **State thật của `base` lệch với `main`** (`terraform plan` chỉ đọc, phát hiện ở Phase 2): plan từ `main` cho kết quả 2 add (`aws_iam_role.github_deploy`, `aws_iam_role_policy.deploy`), 11 destroy (4 queue SQS, 4 queue policy, 2 redrive allow policy, `aws_iam_policy.worker_sqs`). Các queue này được apply từ nhánh DBS-73 (PR #40, chưa merge). Vì thế ai `apply base` đầy đủ từ `main` sẽ xóa queue SQS của DBS-73.
- **Đã có gì:**
  - [ADR-11](../adr/0011-aws-managed-session-based.md) phụ lục ước tính chi phí (dev ≈ 0,14 USD/giờ khi bật, phần giữ lại 3–5 USD/tháng, dự toán 10 tuần 80–100 USD); mục "Cách kiểm chứng" nêu DBS-143.
  - [`infra/terraform/README.md`](../../infra/terraform/README.md): giá từng thành phần khi bật (RDS, Valkey, migration task); chưa có quy trình báo cáo chi phí.
  - Mẫu script: [`infra/scripts/seed-cognito.sh`](../../infra/scripts/seed-cognito.sh) với test Python thư viện chuẩn và `aws` giả.
  - Backlog cùng chủ đề, task này xử lý được: **BL-031** (DBS-33, chi phí ≈ 0 sau destroy), **BL-102** (DBS-66, đối chiếu giá RDS), **BL-118** (DBS-75, đối chiếu giá Valkey và secret). BL-033 (ngưỡng budget 150) không xử lý được bằng code: để nguyên.
- **Baseline** (`main` 7f3b700): stack `base` `fmt` sạch, `validate` đạt, `terraform test` 34/34; `python3 infra/scripts/tests/test_seed_cognito.py` 12/12. Không đổi backend nên không chạy baseline backend.
- **Loại task:** Operations run (báo cáo chi phí) cộng một script nhỏ và một thay đổi Terraform nhỏ (bật tag chi phí).
- **Ngoài phạm vi:** báo cáo chi phí thật và dự báo cuối kỳ (DBS-179, tuần 7); so sánh Single-AZ và Multi-AZ (DBS-182); kiểm tài nguyên sót sau `destroy` (quy trình Down ở runbook, không phải báo cáo); sửa ngưỡng budget (BL-033).
- **Câu hỏi mở** (kèm đề xuất):
  1. **Bật tag chi phí:** đề xuất khai báo `aws_ce_cost_allocation_tag` cho `project`, `env`, `owner` ở stack `base` (IaC, giữ lại, miễn phí), `apply` **chỉ bằng `-target=aws_ce_cost_allocation_tag.this`** (state `base` lệch, xem Thực trạng) khi có đồng ý của người dùng trong hội thoại; sau đó yêu cầu backfill một lần (`aws ce start-cost-allocation-tag-backfill`, từ 01/10) để báo cáo tuần đầu đã nhóm được theo env. Cách khác: người dùng bật trên console. Tag mới bật cần tới 24 giờ mới hiện trong Cost Explorer.
  2. **Credit còn lại:** Cost Explorer không trả số dư. Đề xuất script nhận `--credit-total` (mặc định 200) và tính "credit đã dùng" từ dòng `RECORD_TYPE=Credit`; người dùng đối chiếu với console Billing → Credits khi gửi báo cáo, sửa tham số nếu số thật khác.
  3. **Dạng giao nộp:** script `infra/scripts/cost-report.py` (Python thư viện chuẩn, gọi `aws ce` qua CLI, không thêm phụ thuộc), in báo cáo Markdown; báo cáo lưu ở `docs/components/platform-infra/cost-reports/<ngày>.md`. Test `infra/scripts/tests/test_cost_report.py` với `aws` giả.
  4. **Dự báo:** `aws ce get-cost-forecast` (lọc bỏ credit) tới hết tháng; cộng thêm dự báo tới 13/12 theo kế hoạch còn lại của ADR-11 (load test tuần 7, Multi-AZ tuần 8). Khi Cost Explorer báo thiếu dữ liệu để dự báo thì ghi rõ "không có", không đoán.
  5. **"Gửi nhóm vào thứ Hai":** agent không gửi tin nhắn thay người dùng. Script in thêm một đoạn tóm tắt ngắn để người dùng dán vào kênh nhóm; quy trình mỗi thứ Hai ghi ở `infra/terraform/README.md`.

**Quyết định ở G1** (gate tự duyệt theo `CLAUDE_local.md`, 2026-11-04): câu 2, 3, 4, 5 chọn đúng đề xuất (câu 2 và 4 được làm rõ ở §2 theo domain review #2, #3, #4). Câu 1 chọn khai báo Terraform ở `base`, apply **chỉ bằng `-target`** cho 3 tag vì state lệch (domain review #1); `apply` và backfill là thay đổi trên tài khoản AWS thật nên ngoài quyền tự duyệt, hỏi người dùng riêng ngay trước khi chạy. Nếu chưa được đồng ý, báo cáo đầu tiên ghi phần "theo tag env" là chưa có và nêu lý do.

## 2. Hành vi

### 2.1 Script `infra/scripts/cost-report.py`

```
AWS_PROFILE=dbs-admin python3 infra/scripts/cost-report.py \
  [--start 2026-10-01] [--end <hôm nay UTC>] [--credit-total 200] [--credit-since 2026-08-01] [--project-end 2026-12-14]
```

Mọi ngày theo UTC (Cost Explorer tính theo UTC); `--end` và `--project-end` không tính (exclusive), nên mặc định `--project-end 2026-12-14` là hết ngày 13/12. "7 ngày cuối" là [`--end` − 7, `--end`).

| Điều kiện | Kết quả |
|---|---|
| Tham số hợp lệ, có credential | In báo cáo Markdown ra stdout, thoát 0 |
| Ngày sai định dạng, `--end` ≤ `--start`, `--end` > hôm nay UTC + 1, `--credit-total` < 0, `--credit-since` > `--start`, `--project-end` < `--end` | stderr ghi tên tham số sai, thoát 2, không gọi AWS |
| Một lệnh `aws` bất kỳ lỗi (không có credential, `AccessDenied`, `ValidationException`), kể cả lệnh cuối | stderr ghi lệnh `aws ce …` hỏng và thông báo của CLI, thoát 1, **stdout rỗng** (báo cáo chỉ in khi đã có đủ dữ liệu) |
| `get-cost-forecast` trả `DataUnavailableException` | mục dự báo AWS ghi "không có (Cost Explorer chưa đủ dữ liệu)", thoát 0 |
| `--end` < hôm nay UTC | không gọi forecast; ghi "dự báo AWS bỏ qua (khoảng trong quá khứ)" |
| Kết quả có `NextPageToken` | gọi tiếp tới hết trang, gộp nhóm theo `TimePeriod` (không nối trùng ngày) |

**Các lệnh gọi** (chỉ đọc; 0,01 USD mỗi lệnh Cost Explorer, kể cả mỗi trang):

| # | Lệnh | Dùng cho |
|---|---|---|
| 1 | `ce get-cost-and-usage` DAILY [`--start`, `--end`), `UnblendedCost` + `UsageQuantity`, nhóm `SERVICE` và `USAGE_TYPE`, lọc `Not RECORD_TYPE ∈ {Credit, Refund}` | bảng dịch vụ (lũy kế, 7 ngày cuối), giờ dựng, đơn giá, cảnh báo |
| 2 | `ce list-cost-allocation-tags --tag-keys project env owner` | tag đã bật chưa |
| 3 | (chỉ khi `env` Active) như #1 nhưng MONTHLY, nhóm `TAG` `env`; và `ce list-cost-allocation-tag-backfill-history` | bảng theo env, độ đủ dữ liệu tag |
| 4 | `ce get-cost-and-usage` MONTHLY [`--credit-since`, `--end`), nhóm `RECORD_TYPE`, không lọc | credit đã dùng |
| 5 | (khi `--end` ≥ hôm nay UTC) `ce get-cost-forecast` [`--end`, ngày 1 tháng sau của `--end`), `--metric UNBLENDED_COST`, `--granularity MONTHLY`, filter `RECORD_TYPE = Usage` | dự báo AWS tới hết tháng |

Một lần chạy: 4–6 lệnh, ≈ 0,04–0,06 USD. Test thủ công §5 chạy khoảng 6 lần cộng vài lệnh đối chiếu: ≈ 0,5 USD, trừ vào credit.

### 2.2 Nội dung báo cáo

1. **Theo dịch vụ** (chi phí gộp, trước credit): luôn có đủ 7 dòng của DoD 1 theo thứ tự RDS, ElastiCache, ECS, ALB, SQS, CloudWatch, Data transfer (0,0000 nếu không phát sinh), sau đó các dịch vụ khác giảm dần, rồi dòng tổng. Hai cột: lũy kế và 7 ngày cuối.
   - Ánh xạ `SERVICE`: RDS = `Amazon Relational Database Service`, ElastiCache = `Amazon ElastiCache`, ECS = `Amazon Elastic Container Service`, ALB = `Amazon Elastic Load Balancing`, SQS = `Amazon Simple Queue Service`, CloudWatch = `AmazonCloudWatch`, Data transfer = `AWS Data Transfer`. Mỗi dịch vụ chỉ nằm ở một dòng, nên tổng không bị cộng hai lần.
   - Dòng phụ "trong đó data transfer tính ở dịch vụ khác": tổng các `USAGE_TYPE` khớp `DataTransfer|-(In|Out)-Bytes` thuộc dịch vụ khác `AWS Data Transfer`. Dòng này đã nằm trong dịch vụ gốc, không cộng vào tổng.
2. **Số giờ dựng và đơn giá** (theo từng loại usage, không theo dịch vụ):

   Mỗi `USAGE_TYPE` một dòng riêng (theo lớp instance và chế độ AZ), đơn giá = chi phí của chính dòng đó ÷ quantity; chỉ so với ước tính khi đúng lớp (README: `InstanceUsage:db.t4g.micro` 0,025, `NodeUsage:cache.t4g.micro` 0,016).

   | Nhóm | `USAGE_TYPE` khớp | Đơn vị |
   |---|---|---|
   | RDS instance | `InstanceUsage:db.*`, `Multi-AZUsage:db.*` | USD/giờ |
   | RDS storage | `RDS:GP3-Storage`, `RDS:*Storage*` | in riêng, GB-tháng |
   | ElastiCache node | `NodeUsage:cache.*` | USD/giờ |
   | ALB | `LoadBalancerUsage` | USD/giờ (so ≈ 0,03) |
   | Fargate | `Fargate-vCPU-Hours`, `Fargate-GB-Hours` | vCPU-giờ, GB-giờ |
   | Secrets Manager | `AWSSecretsManager-Secret` | USD/secret-tháng (so 0,40) |

   **Ngày có phiên** = ngày có ít nhất một trong RDS instance, ElastiCache node, ALB, Fargate vCPU > 0.
3. **Theo tag env:** `env` Active → bảng `dev`, `prod`, `(không tag)` (Cost Explorer trả `env$dev`, `env$`). Thêm dòng **"dữ liệu tag chưa đủ (chờ backfill hoặc 24 giờ)"** khi `(không tag)` chiếm ≥ 90 % tổng, hoặc lần backfill mới nhất chưa `SUCCEEDED`. Chưa Active → dòng "Tag `env` chưa bật trong Cost allocation tags, xem infra/terraform/README mục Báo cáo chi phí tuần".
4. **Credit và dự báo:**
   - Credit đã dùng = |tổng `Credit`| trong [`--credit-since`, `--end`); còn lại = `--credit-total` − đã dùng; ghi "ước tính, đối chiếu console Billing → Credits".
   - **Dự báo AWS** (A): kết quả #5, tức [`--end`, hết tháng).
   - **Dự báo tới cuối dự án** (B): chi trung bình/ngày của 7 ngày cuối × số ngày trong [`--end`, `--project-end`). A và B là hai con số riêng, không cộng nhau.
   - **CẢNH BÁO** khi B > credit còn lại.
5. **Cảnh báo tự động:**
   - Có `USAGE_TYPE` chứa `NatGateway` hoặc `VpcEndpoint` → CẢNH BÁO ADR-10.
   - Ngày cuối của khoảng có chi phí RDS instance, ElastiCache node, ALB, Fargate hoặc dịch vụ có tên chứa `WAF` → nhắc "tài nguyên phiên có thể chưa xóa, chạy quy trình Down".
   - Ngày cuối luôn ghi "có thể chưa đủ (Cost Explorer trễ tới 24 giờ)".
6. **Đề xuất cắt giảm:** script in khung mục, có sẵn các gợi ý tự động (dịch vụ giữ lại lớn nhất, cảnh báo ở mục 5). Người chạy bổ sung bằng tay trước khi gửi.
7. **Đoạn tóm tắt** ≤ 5 dòng để dán vào kênh nhóm: tổng 7 ngày, lũy kế, credit còn lại, dự báo B, cảnh báo nếu có.

Tiền là USD dạng chuỗi từ AWS, cộng bằng `decimal.Decimal`, in 4 chữ số thập phân. Đây không phải tiền VND của sổ cái nên CONTRIBUTING §5 không áp dụng; vẫn không dùng float. Báo cáo không in account id hay ARN.

### 2.3 Terraform: bật tag chi phí

`envs/dev/base/cost_tags.tf`: `aws_ce_cost_allocation_tag` cho `project`, `env`, `owner`, `status = "Active"`. Miễn phí, nằm ở `base` (giữ lại); `destroy base` hoặc xóa resource sẽ đặt tag về Inactive.

Vì state thật của `base` lệch với `main` (§1), lần apply của task này **chỉ nhắm 3 tag**:

```
terraform plan -out=tags.tfplan -var account_id=<account-id> -target='aws_ce_cost_allocation_tag.this'
terraform apply tags.tfplan
```

Plan mong đợi: 3 to add, 0 to change, 0 to destroy. Phần lệch (11 destroy SQS, 2 add deploy role) giữ nguyên và bàn giao (§8). Backfill một lần sau khi bật: `aws ce start-cost-allocation-tag-backfill --backfill-from 2026-10-01T00:00:00Z` (không phải tài nguyên Terraform). Cả hai chạy trên tài khoản thật, chỉ khi người dùng đồng ý trong hội thoại.

### 2.4 Quy trình thứ Hai (DoD 3)

Ghi ở `infra/terraform/README.md` mục "Báo cáo chi phí tuần":
1. Chạy thứ Hai sau 19:00 giờ Việt Nam (12:00 UTC), `--end` = ngày thứ Hai.
2. Lưu `docs/components/platform-infra/cost-reports/<YYYY-MM-DD>.md`.
3. Đối chiếu credit với console Billing → Credits; sửa `--credit-total` nếu khác.
4. Viết mục "Đề xuất cắt giảm".
5. Dán đoạn tóm tắt vào kênh nhóm. Agent không gửi tin nhắn.

## 3. Kiến trúc

- **Vị trí:** mới: `infra/scripts/cost-report.py`, `infra/scripts/tests/test_cost_report.py`, `infra/scripts/tests/fake_aws_ce.py`, `infra/terraform/envs/dev/base/cost_tags.tf`, `infra/terraform/envs/dev/base/tests/cost_tags.tftest.hcl`, `docs/components/platform-infra/cost-reports/2026-11-04.md`. Sửa: `infra/terraform/README.md`, `docs/BACKLOG.md`, `docs/features/README.md`, `docs/features/DBS-33-terraform-vpc-ecr.md`, `DBS-66-terraform-rds.md`, `DBS-75-terraform-valkey.md` (ghi kết quả đối chiếu BL-031/102/118). Không chạm `backend/`, không chạy trong ECS.
- **Interface:** chỉ AWS CLI v2 (`aws ce …`, `--output json`), gọi qua `subprocess.run([...])` không qua shell, credential theo `AWS_PROFILE` của người chạy. Không thêm phụ thuộc Python (không boto3). Không đổi symbol nào đã có.
- **Dữ liệu:** không chạm database. Script không ghi file; người chạy chuyển hướng stdout ra file báo cáo.
- **IAM của người chạy:** `ce:GetCostAndUsage`, `ce:GetCostForecast`, `ce:ListCostAllocationTags`, `ce:ListCostAllocationTagBackfillHistory`; khi apply và backfill: `ce:UpdateCostAllocationTagsStatus`, `ce:StartCostAllocationTagBackfill`. Group `dbs-admin` có đủ. Không thêm quyền cho role deploy của GitHub. Role chỉ đọc chi phí cho người khác chạy script: chưa cần, ngoài phạm vi.
- **Sơ đồ:** một thành phần (script → Cost Explorer), không cần.
- **Thay đổi cấp hệ thống:** không đổi ADR.

## 4. Test cases tự động

| ID | Truy vết | Lớp | Given · When · Then |
|---|---|---|---|
| TC-143-01 | DoD 1 | unit (aws giả) | Dữ liệu chỉ có RDS, KMS, `AWS Data Transfer` · chạy · đủ 7 dòng DoD theo thứ tự (SQS, CloudWatch… = 0,0000), Data transfer lấy từ service `AWS Data Transfer`, KMS ở phần khác, tổng đúng từng chữ số (0,1 + 0,2 = 0,3000) |
| TC-143-02 | DoD 1 | unit | · chạy · lệnh #1 mang filter `Not RECORD_TYPE ∈ {Credit, Refund}` và nhóm `SERVICE`+`USAGE_TYPE`; lệnh #4 không có filter |
| TC-143-03 | DoD 1 | unit | `InstanceUsage:db.t4g.micro` 0,734 giờ / 0,0183 USD, `Multi-AZUsage:db.t4g.small` 1 giờ / 0,0700, `NodeUsage:cache.t4g.micro` 2 giờ / 0,0384, `LoadBalancerUsage` 4 giờ ở 25/10 và 29/10, ngày 27/10 chỉ có Valkey · chạy · mỗi lớp một dòng: `InstanceUsage:db.t4g.micro` 0,0249 USD/giờ (không gồm storage), `Multi-AZUsage:db.t4g.small` 0,0700 riêng, "3 ngày có phiên" |
| TC-143-04 | DoD 1 | unit | `APS1-DataTransfer-Out-Bytes` ở EC2-Other và `APS1-USE1-AWS-Out-Bytes` ở S3 · chạy · dòng phụ = tổng hai khoản, tổng chung không đổi |
| TC-143-05 | DoD 1 | unit | `env` Inactive · không gọi lệnh #3, in "chưa bật". Active, `env$dev` 0,60 + `env$` 0,05 · in `dev`, `(không tag)`, không có dòng "chưa đủ". Active, `env$` 0,95 / tổng 1,00 hoặc backfill `PROCESSING` · có dòng "dữ liệu tag chưa đủ" |
| TC-143-06 | DoD 2 | unit | Credit −0,7058 từ `--credit-since 2026-08-01`, `--start 2026-10-26` · đã dùng 0,7058 (không chỉ phần từ `--start`), còn 199,2942. 7 ngày cuối 70 USD, 40 ngày còn lại · B = 400,0000 > còn lại · CẢNH BÁO; A in riêng, không cộng vào B |
| TC-143-07 | DoD 2 | unit | forecast `DataUnavailableException` · "không có", thoát 0. `--end` trong quá khứ · không gọi forecast, ghi "bỏ qua". `--end` = hôm nay · forecast mang `--metric UNBLENDED_COST`, filter `RECORD_TYPE = Usage`, [`--end`, ngày 1 tháng sau) |
| TC-143-08 | DoD 2 | unit | có `APS1-NatGateway-Hours` hoặc `APS1-VpcEndpoint-Hours` · CẢNH BÁO ADR-10. Ngày cuối có Fargate vCPU hoặc dịch vụ `AWS WAF` · nhắc Down. Ngày cuối luôn có ghi chú "có thể chưa đủ" |
| TC-143-09 | độ tin cậy | unit | trang 1 có `NextPageToken`, trang 2 cùng ngày 29/10 thêm nhóm khác · gọi trang 2, ngày 29/10 có đủ nhóm của cả hai trang, không trùng ngày |
| TC-143-10 | độ tin cậy | unit | `--end` ≤ `--start`, `--end 2026-13-01`, `--end` = hôm nay + 2, `--credit-total -1`, `--project-end` < `--end`, `--credit-since` > `--start` · thoát 2, không gọi `aws` |
| TC-143-11 | độ tin cậy | unit | lệnh #1 lỗi (thoát 254) · thoát 1, stdout rỗng. Lệnh forecast lỗi `AccessDeniedException` (lệnh cuối) · thoát 1, stdout rỗng |
| TC-143-12 | DoD 1 | unit | không truyền `--end` · `--end` = hôm nay UTC; 7 ngày cuối = [hôm nay − 7, hôm nay) (ngày cũ hơn không vào cột 7 ngày) |
| TC-143-13 | DoD 1 | terraform test (mock_provider) | stack `base` · plan · đúng 3 `aws_ce_cost_allocation_tag` `project`, `env`, `owner`, cả ba `Active` |
| TC-143-14 | DoD 2, 3 | quy trình | báo cáo đầu nằm trong PR và có mục "Đề xuất cắt giảm" đã viết; README có mục quy trình thứ Hai; gửi nhóm do người dùng làm |

## 5. Test thủ công (operations run)

Điều kiện: `AWS_PROFILE=dbs-admin`, region `ap-southeast-1`, bash; output thô vào `screenshots/DBS-143/manual-test.txt`, xóa account id và ARN trước khi commit.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-143-01 | `aws sts get-caller-identity`; `aws configure get region` | đúng tài khoản nhóm, user trong `dbs-admin`, `ap-southeast-1` |
| M-143-02 | `python3 infra/scripts/cost-report.py --start 2026-10-01 --end 2026-11-04` | đủ 7 mục; tổng gộp 0,6514 (± 0,001 nếu billing cập nhật thêm); credit đã dùng 0,7058; ngày có phiên gồm 25/10 và 29/10; thoát 0 |
| M-143-03 | Đối chiếu tay: `aws ce get-cost-and-usage` MONTHLY nhóm `SERVICE` cùng khoảng, lọc bỏ credit | dòng RDS, ElastiCache, ALB khớp báo cáo tới 4 chữ số |
| M-143-04 | `--start 2026-11-04 --end 2026-10-01`; `--credit-total -5` | thoát 2, ghi tên tham số, không gọi AWS |
| M-143-05 | `AWS_PROFILE=dbs-none AWS_CONFIG_FILE=/dev/null AWS_SHARED_CREDENTIALS_FILE=/dev/null` chạy lại | thoát 1, stderr nêu lệnh `aws ce …` hỏng, stdout rỗng |
| M-143-06 | Trong `envs/dev/base`: `terraform init -backend-config=backend.hcl`; `terraform plan -out=tags.tfplan -var account_id=<account-id> -target='aws_ce_cost_allocation_tag.this'` | 3 to add, 0 change, 0 destroy |
| M-143-07 | (cần đồng ý) `terraform apply tags.tfplan`; `aws ce list-cost-allocation-tags --tag-keys project env owner` | 3 tag `Active` |
| M-143-08 | (cần đồng ý) `aws ce start-cost-allocation-tag-backfill --backfill-from 2026-10-01T00:00:00Z`; `aws ce list-cost-allocation-tag-backfill-history` | yêu cầu `PROCESSING` hoặc `SUCCEEDED` |
| M-143-09 | Chạy lại báo cáo sau khi bật tag | mục 3 có bảng env; nếu backfill chưa xong thì có dòng "dữ liệu tag chưa đủ" (đó là kết quả đúng của bước này); bảng đủ dữ liệu ghi vào báo cáo thứ Hai 09/11 |
| M-143-10 | Đối chiếu BL-031, BL-102, BL-118 bằng mục 2 | đơn giá RDS instance, Valkey node trong ± 20 % ước tính, hoặc README sửa theo số thật; ngày 26–28/10 và 30/10–03/11 không có RDS, ElastiCache, ALB, Fargate |

## 6. Domain review (AI)

**Reviewer:** subagent general-purpose, model Opus (claude-opus-5-5), 2026-11-04, hai vòng · **Kết quả:** vòng 1: 17 phát hiện (blocking 0, should-fix 12, minor 5), verdict REVISE; vòng 2 trên bản sửa: cả 17 đã xử lý, 3 phát hiện mới (minor), verdict **APPROVE** · [trả lời nguyên văn](screenshots/DBS-143/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | `plan base` sẽ kéo theo thay đổi khác ngoài 3 tag | đã sửa §1, §2.3, §5: `plan` chỉ đọc cho thấy lệch thật (2 add role deploy, 11 destroy SQS của DBS-73); apply chỉ `-target` 3 tag; phần lệch bàn giao ở §8 |
| 2 | should-fix | credit chỉ tính từ `--start` | đã sửa §2.1, §2.2: `--credit-since` (mặc định 2026-08-01), TC-143-06 |
| 3 | should-fix | forecast: metric, ngày bắt đầu, filter | đã sửa §2.1: `UNBLENDED_COST`, `RECORD_TYPE = Usage`, bỏ qua khi `--end` trong quá khứ; TC-143-07 |
| 4 | should-fix | dự báo A/B không rõ, mốc cuối | đã sửa §2.2 mục 4: A và B tách riêng, CẢNH BÁO theo B, mốc exclusive |
| 5 | should-fix | thiếu Multi-AZ, ngày có phiên chỉ theo ALB | đã sửa §2.2 mục 2, TC-143-03 |
| 6 | should-fix | đơn giá lẫn storage; secret | đã sửa §2.2 mục 2: theo usage type, storage riêng, dòng Secrets Manager |
| 7 | should-fix | thiếu VpcEndpoint, Fargate, WAF | đã sửa §2.2 mục 5, TC-143-08 |
| 8 | should-fix | có service `AWS Data Transfer` | đã kiểm bằng `get-dimension-values`; sửa §2.2 mục 1, TC-143-01, 04 |
| 9 | should-fix | bảng tag trước khi backfill xong | đã sửa §2.2 mục 3, TC-143-05 |
| 10 | should-fix | §1 mâu thuẫn số credit | đã sửa §1 (số theo `RECORD_TYPE` từng tháng), M-143-02 |
| 11 | should-fix | M-143-05 không chắc lỗi | đã sửa M-143-05 |
| 12 | should-fix | thiếu TC cho đường lỗi | đã thêm TC-143-10, 11, 12; sửa TC-143-09 |
| 13 | minor | lệnh terraform thiếu tham số | đã sửa M-143-06 |
| 14 | minor | thiếu quyền IAM | đã sửa §3 |
| 15 | minor | phí API, tài khoản Organization | đã kiểm: tài khoản đứng riêng; ghi phí test ≈ 0,5 USD ở §2.1 |
| 16 | minor | Cost Explorer trễ ngày thứ Hai | đã sửa §2.4, §2.2 mục 5 |
| 17 | minor | DoD 2 "đề xuất cắt giảm" chưa kiểm; BL-031 cần ghi vào DBS-33 | đã sửa TC-143-14, §3 |
| N1 | minor | đơn giá RDS gộp hai lớp instance | đã sửa §2.2 mục 2, TC-143-03: mỗi usage type một dòng |
| N2 | minor | `--end` tương lai; điều kiện forecast thừa | đã sửa §2.1, TC-143-07, 10 |
| N3 | minor | §1 câu 1 còn ghi `apply base` | đã sửa §1 câu 1 |

**Quyết định ở G2** (gate tự duyệt theo `CLAUDE_local.md`, 2026-11-04): duyệt thiết kế §2–§5 sau hai vòng review. Không có câu hỏi thuộc nhóm phải hỏi người dùng (không đổi ADR, schema, event, `ErrorCode`, biến môi trường dùng chung, quy tắc tiền). `apply` và backfill thật vẫn hỏi riêng ở Phase 4.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Kết quả đỏ (1 dòng, điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `infra/terraform/envs/dev/base/cost_tags.tf`, `tests/cost_tags.tftest.hcl` | TC-143-13 | | `terraform test -filter=tests/cost_tags.tftest.hcl` | `feat(infra): activate cost allocation tags in base` |
| 2 | `infra/scripts/tests/fake_aws_ce.py`, `test_cost_report.py`, `infra/scripts/cost-report.py` (tham số, gọi `aws`, phân trang, lỗi) | TC-143-02, 09, 10, 11, 12 | | `python3 infra/scripts/tests/test_cost_report.py` | `feat(infra): cost report script skeleton with paging and errors` |
| 3 | như bước 2 (bảng dịch vụ, data transfer, giờ dựng, đơn giá) | TC-143-01, 03, 04 | | như trên | `feat(infra): cost report by service and session hours` |
| 4 | như bước 2 (tag env, credit, dự báo, cảnh báo, đề xuất, tóm tắt) | TC-143-05, 06, 07, 08 | | như trên | `feat(infra): cost report tags, credit, forecast and warnings` |
| 5 | `infra/terraform/README.md` (mục "Báo cáo chi phí tuần": lệnh, tag `-target`, backfill, đơn giá thật) | TC-143-14 (quy trình) | — | `check-doc-links.mjs` | `docs(infra): weekly cost report procedure` |
| 6 | Test thủ công M-143-01…10; `docs/components/platform-infra/cost-reports/2026-11-04.md`; `screenshots/DBS-143/manual-test.txt` | — | — | §5 | `docs(infra): first weekly cost report` |
| 7 | `docs/BACKLOG.md` (xóa BL-031, BL-102, BL-118 khi đối chiếu đạt; thêm BL cho phần chưa đạt và cho state `base` lệch), DBS-33/66/75 feature doc (kết quả đối chiếu), `docs/features/README.md`, §8–§9 | — | — | `check-doc-links.mjs` | `docs(features): DBS-143 implemented` |

**Rủi ro và cách lùi:**
- Tag mới bật cần tới 24 giờ, backfill có thể mất vài giờ. Nếu tới lúc bàn giao chưa có dữ liệu, M-143-09 ghi kết quả "dữ liệu tag chưa đủ", và báo cáo thứ Hai 09/11 sẽ có bảng env đầy đủ (dòng BL).
- Người dùng không đồng ý apply: giữ `cost_tags.tf` trong PR nhưng chưa apply, ghi BL; mục 3 của báo cáo ghi "chưa bật".
- `-target` là ngoại lệ: chỉ dùng cho 3 resource mới, không đụng phần lệch; ghi rõ trong README để lần apply đầy đủ sau chờ DBS-73 merge.
- Lùi: xóa `cost_tags.tf` đặt tag về Inactive, không mất dữ liệu chi phí; script không đổi tài nguyên nào.

**Quét giới hạn và DoD:** DoD 1 → bước 1–4, 6; DoD 2 → bước 4, 6; DoD 3 → bước 5 (quy trình), gửi nhóm do người dùng làm. BL-031, BL-102, BL-118 → bước 7. BL-033 ngoài phạm vi (§1). Không còn mục nào không có dòng.

**Quyết định ở G3** (gate tự duyệt theo `CLAUDE_local.md`, 2026-11-04): duyệt kế hoạch 7 bước. Không mở Draft PR trước G4.

## 8. Kết quả

- **Lệnh kiểm tra** (lúc bàn giao, commit `a6c34e3`): stack `base` `terraform fmt -check` sạch, `validate` đạt, `terraform test` **35/35** (34 cũ + `cost_tags`); `python3 infra/scripts/tests/test_cost_report.py` **18/18 OK**, 0 skip; `test_seed_cognito.py` 12/12 (không đổi); `check-doc-links.mjs` 0 link hỏng. Không đổi `backend/` nên không chạy baseline backend.
- **Kiểm đột biến** (tự làm, không giữ trong repo): bỏ filter credit → TC-143-02 đỏ; tính credit từ `--start` → TC-143-06 đỏ; tính data transfer cả service `AWS Data Transfer` → ban đầu **không** test nào đỏ, đã thêm assert vào TC-143-01, sau đó đỏ.
- **Đối chiếu test case:**

| ID | Test (`infra/scripts/tests/test_cost_report.py`, `base/tests/cost_tags.tftest.hcl`) | Đạt? |
|---|---|---|
| TC-143-01 | `test_service_table_has_dod_rows_in_order` | đạt |
| TC-143-02 | `test_usage_query_excludes_credits` | đạt (thêm kiểm chỉ một cờ `--group-by`, lỗi tìm thấy ở M-143-02) |
| TC-143-03 | `test_session_hours_and_unit_prices` | đạt |
| TC-143-04 | `test_transfer_inside_other_services_not_double_counted` | đạt |
| TC-143-05 | `test_env_tag_inactive`, `test_env_tag_active_complete`, `test_env_tag_active_incomplete` | đạt (aws giả; chưa có dữ liệu tag thật, xem M-143-09) |
| TC-143-06 | `test_credit_from_credit_since_and_projection_warning` | đạt |
| TC-143-07 | `test_forecast_unavailable`, `test_forecast_skipped_for_past_end`, `test_forecast_request_shape` | đạt |
| TC-143-08 | `test_forbidden_usage_and_last_day_reminder` | đạt |
| TC-143-09 | `test_pagination_merges_by_day`, `test_group_without_service_key` | đạt |
| TC-143-10 | `test_bad_arguments` | đạt |
| TC-143-11 | `test_aws_failure_leaves_stdout_empty` | đạt |
| TC-143-12 | `test_default_end_and_seven_day_window` | đạt |
| TC-143-13 | `cost_tags.tftest.hcl` › `cost_allocation_tags_active` | đạt (mock_provider) |
| TC-143-14 | quy trình: [báo cáo đầu](../components/platform-infra/cost-reports/2026-11-04.md) có "Đề xuất cắt giảm"; README mục "Báo cáo chi phí tuần"; `test_summary_block_present` | đạt; gửi nhóm do người dùng làm |

- **Test thủ công** (output thô: [manual-test.txt](screenshots/DBS-143/manual-test.txt), SHA `a6c34e3`, 2026-11-04). Ba lần chạy đầu tìm thấy ba lỗi, mỗi lỗi đưa về 4a:
  - lần 1 (`0bc4dfb`): `ValueError` vì Cost Explorer trả một số nhóm chỉ có khóa `USAGE_TYPE`. Sửa ở `76e7143` + test `test_group_without_service_key`.
  - lần 2 (`76e7143`): mọi dòng rơi vào "(không rõ dịch vụ)". Nguyên nhân: AWS CLI chỉ giữ cờ `--group-by` cuối, nên lệnh chỉ nhóm theo `USAGE_TYPE`; `aws` giả cũ chấp nhận cách gọi sai. Sửa ở `d4f6acb`: hai nhóm sau một cờ, `aws` giả làm giống CLI thật, TC-143-02 kiểm một cờ.
  - lần 3 (`d4f6acb`): M-143-01…06 đạt. Người dùng đồng ý apply và backfill (2026-11-04); M-143-07, 08 chạy, rồi phát hiện `aws ce describe-cost-allocation-tag-backfill-history` không có trong CLI (lệnh đúng là `list-cost-allocation-tag-backfill-history`), nên báo cáo sẽ lỗi ngay khi tag `env` Active. Sửa ở `a6c34e3`: `aws` giả dùng tên lệnh thật nên hai test đỏ trước khi sửa script.
  - Lần 4 chạy lại toàn bộ §5 trên `a6c34e3` (M-143-07, 08 không lặp lại vì đã đổi tài khoản thật; output gốc giữ ở cuối file):

| Bước | Lệnh | Phản hồi thật (rút gọn) | Kết quả |
|---|---|---|---|
| M-143-01 | `aws sts get-caller-identity`; region | user nhóm `dbs-admin`, `ap-southeast-1` | đạt |
| M-143-02 | `cost-report.py --start 2026-10-01 --end 2026-11-04` | thoát 0; tổng 0,6513; RDS 0,0211, ElastiCache 0,0384, ECS 0,0029, ALB 0,1008, SQS/CloudWatch/Data transfer 0; credit đã dùng 0,7058, còn 199,2942; dự báo AWS 1,4135; dự báo tới 13/12 2,7472; 2 ngày có phiên (25/10, 29/10) | đạt (tổng 0,6513, kỳ vọng 0,6514 ± 0,001) |
| M-143-03 | `get-cost-and-usage` MONTHLY nhóm `SERVICE`, lọc credit | RDS 0.0211, ElastiCache 0.0384, ELB 0.1008, tổng 0.6513 | đạt (khớp 4 chữ số) |
| M-143-04 | `--start 2026-11-04 --end 2026-10-01`; `--credit-total -5` | `error: --end phải sau --start` thoát 2; `--credit-total không được âm` thoát 2 | đạt |
| M-143-05 | profile `dbs-none`, config `/dev/null` | thoát 1, stdout 0 byte, stderr `Lỗi khi gọi aws ce get-cost-and-usage: … profile (dbs-none) could not be found` | đạt |
| M-143-06 | `terraform plan -target='aws_ce_cost_allocation_tag.this'` | trước apply (chạy lại ngay trước M-143-07): `Plan: 3 to add, 0 to change, 0 to destroy`; lần 4, sau apply: `No changes` | đạt |
| M-143-07 | `terraform apply tags.tfplan`; `list-cost-allocation-tags` | `Apply complete! Resources: 3 added, 0 changed, 0 destroyed`; `env Active`, `project Active`, `owner Active` | đạt (người dùng đồng ý trong hội thoại 2026-11-04) |
| M-143-08 | `start-cost-allocation-tag-backfill --backfill-from 2026-10-01T00:00:00Z`; `list-cost-allocation-tag-backfill-history` | `BackfillStatus: PROCESSING`, `RequestedAt 2026-11-04T06:04:17Z` | đạt |
| M-143-09 | báo cáo sau khi bật tag (cùng lần chạy M-143-02 lần 4) | mục 3 có bảng env: `(không tag) 0,6513`; dòng "dữ liệu tag chưa đủ … backfill gần nhất: PROCESSING" | đạt (đúng kết quả mong đợi khi backfill chưa xong); bảng `dev` thật: BL-139 |
| M-143-10 | đối chiếu BL-031, 102, 118 | 26–28/10 và 30/10–03/11 chỉ có Secrets Manager, KMS, S3 (0,034–0,060 USD/ngày); RDS `db.t4g.micro` 0,0250/giờ (khớp); Valkey `cache.t4g.micro` 0,0192/giờ (+20 %, README sửa theo số thật); secret 0,4000/secret-tháng (khớp) | đạt |

- **Phạm vi so với §7:** `git diff --stat main...HEAD` gồm `cost_tags.tf`, `cost_tags.tftest.hcl`, `cost-report.py`, `test_cost_report.py`, `fake_aws_ce.py`, `infra/terraform/README.md`, báo cáo `cost-reports/2026-11-04.md`, `BACKLOG.md`, feature doc DBS-33/66/75/143, `docs/features/README.md`, `screenshots/DBS-143/` (domain-review, manual-test): khớp §3 và §7.
- **Ảnh chụp:** không có. Task không có giao diện (script và Terraform); bằng chứng là output terminal ở `manual-test.txt` và báo cáo Markdown. Cần người duyệt chấp nhận ở G4.
- **Lệch so với kế hoạch:**
  1. Bước 2–4 của §7 gộp thành một commit `0bc4dfb` (cùng file, cùng phạm vi; test viết trước, chạy đỏ 17/17 rồi xanh). Thêm ba commit sửa lỗi `76e7143`, `d4f6acb`, `a6c34e3` do test thủ công tìm thấy. Không thêm file hay phạm vi.
  2. Thêm hai hành vi nhỏ ngoài §2, phát sinh từ dữ liệu thật: nhóm không có khóa `SERVICE` vào dòng "(không rõ dịch vụ)"; dịch vụ ngoài DoD có tổng 0 thì ẩn (Cost Explorer trả nhiều dòng 0 USD như `AWS Glue`). Gate tự duyệt theo `CLAUDE_local.md` (không thuộc nhóm phải hỏi).
  3. Giá Valkey trong README đổi từ ≈ 0,016 sang 0,0192 USD/giờ theo số thật (điều kiện đóng BL-118). ADR-11, ADR-12 giữ nguyên vì ghi rõ là ước tính.
- **Bàn giao cho vai khác:**
  - **BL-138** (#5, cùng leader merge DBS-73): state `base` lệch với `main`; `plan` đầy đủ sẽ xóa 11 tài nguyên SQS.
  - **BL-139** (#5): xác nhận bảng chi phí theo `env` có số thật (`dev` chiếm phần lớn, không còn dòng "dữ liệu tag chưa đủ") ở báo cáo thứ Hai 09/11, sau khi backfill `SUCCEEDED`.
  - BL-033 (ngưỡng budget ACTUAL > 150) vẫn mở: trên tài khoản hiện chỉ có ngưỡng ACTUAL > 50, ACTUAL > 100, FORECASTED > 100.

## 9. Tài liệu đã cập nhật

- `infra/terraform/README.md`: mục mới "Báo cáo chi phí tuần (DBS-143)" (lệnh thứ Hai, tag, backfill, cảnh báo state lệch); giá Valkey thật 0,0192 USD/giờ.
- `docs/components/platform-infra/cost-reports/2026-11-04.md`: báo cáo chi phí đầu tiên.
- `docs/BACKLOG.md`: **xóa BL-031, BL-102, BL-118** (đã đối chiếu, xem M-143-10); **thêm BL-138, BL-139**.
- `docs/features/DBS-33-terraform-vpc-ecr.md`, `DBS-66-terraform-rds.md`, `DBS-75-terraform-valkey.md`: dòng kết quả đối chiếu Cost Explorer ở §8.
- `docs/features/README.md`: hàng DBS-143.

**Quyết định ở G4** (gate tự duyệt theo `CLAUDE_local.md`, 2026-11-04): chấp nhận không có ảnh chụp (task không có giao diện, bằng chứng là `manual-test.txt` và báo cáo Markdown), ba chỗ lệch ở §8 và bàn giao BL-138, BL-139. Apply 3 tag và backfill đã được người dùng đồng ý trong hội thoại.
