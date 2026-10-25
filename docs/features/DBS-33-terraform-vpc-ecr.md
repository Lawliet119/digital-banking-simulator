# DBS-33 · Terraform: VPC (≥ 2 AZ) và ECR

> **Status:** Draft · **Vai:** #5 Platform & Ops · **Cặp đôi review:** Dev · **Nhánh:** `chore/DBS-33-terraform-vpc-ecr` · **PR:** — · **Cập nhật:** 2026-10-25

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 1, Deliverable P3, Ưu tiên Highest, board đang "In Progress". **Expect:** Nền mạng và registry dựng và xóa bằng code.
- **DoD** (nguyên văn, đánh số):
  1. VPC ≥ 2 AZ, subnet theo ADR-10; ECR repo có scan on push và lifecycle xóa image cũ
  2. Phần giữ lại (state, ECR, VPC, Cognito) tách khỏi phần xóa hằng ngày (RDS, ElastiCache, ALB, WAF, ECS service) thành stack/module riêng
  3. terraform apply thành công; terraform destroy phần xóa hằng ngày về chi phí ≈ 0 (xác nhận trong Cost Explorer ngày hôm sau)
  4. README hướng dẫn thứ tự dựng/xóa và biến cần có
  5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc:** DBS-31 (S3 state) board **In Review**; PR [#22](https://github.com/Lawliet119/digital-banking-simulator/pull/22) chưa merge. Trong repo: code bootstrap nằm ở nhánh `chore/DBS-31-terraform-bootstrap`; trên AWS bucket `dbs-tfstate-<account-id>-ap-southeast-1` đã dựng và dùng được. DBS-3 và DBS-4 Done theo board (Budget thật chưa xác nhận có ngưỡng 50/100/150 USD).
- **Đã có gì:** [infra/terraform/README.md](../../infra/terraform/README.md) (cấu trúc `envs/dev/base`, `envs/dev/session`, `envs/prod/session`, quy ước tag, key state `dev/base.tfstate`), [ADR-10](../adr/0010-fargate-egress-public-subnet.md) (2 AZ, mỗi AZ 1 public + 1 private subnet, private không route ra internet, gateway endpoint S3, không NAT, không interface endpoint), [ADR-11](../adr/0011-aws-managed-session-based.md), docs/03 §13. Chưa có `.tf` nào ngoài `bootstrap/`. `.github/workflows/ci.yml` (DBS-35) chưa có job Terraform (BL-028).
- **Baseline:** loại Terraform: `terraform fmt -check -recursive` sạch; `bootstrap`: `validate` sạch, `terraform test` 9 passed, 0 failed.
- **Ngoài phạm vi:** KMS, Cognito, logs, SNS, OIDC (các task khác của #5: DBS-54, DBS-36…); ECS và ALB (DBS-34); RDS (DBS-66); ElastiCache; WAF; security group của ECS/RDS (đi cùng task tạo ra tài nguyên đó).
- **Câu hỏi mở:**
  1. **Nhánh xuất phát.** DBS-33 cần mẫu `backend.tf` và README của DBS-31 chưa có trên `main`. Đề xuất: tách nhánh từ `chore/DBS-31-terraform-bootstrap` (PR xếp chồng), đổi base của PR về `main` sau khi #22 merge. Cách khác: chờ #22 merge rồi mới bắt đầu.
  2. **Phần "xóa hằng ngày" (DoD 2).** Task này chưa có tài nguyên nào thuộc nhóm đó (ALB ở DBS-34, RDS ở DBS-66). Đề xuất: tạo `envs/dev/base` thật (VPC, subnet, route, gateway endpoint S3, ECR) và `envs/dev/session` chỉ gồm khung (`backend.tf`, `versions.tf`, đọc `terraform_remote_state` của `base`, README, chưa có tài nguyên), để DBS-34/66 thêm vào mà không đổi cấu trúc. `prod/session` làm ở task production.
  3. **DoD 3 "destroy về chi phí ≈ 0 + Cost Explorer ngày hôm sau".** Với phạm vi này mọi tài nguyên đều miễn phí hoặc cực rẻ (VPC, subnet, gateway endpoint S3; ECR vài MB). Đề xuất: chứng minh bằng `apply` → kiểm tra bằng CLI → `destroy` → CLI không còn VPC/NAT/EIP/ENI; ghi Cost Explorer ngày hôm sau vào BACKLOG vì không kiểm được trong ngày (billing trễ). Theo quy tắc chi phí của bạn (2026-10-25), VPC/ECR giữ lại sau khi kiểm vì miễn phí; nếu bạn muốn xóa hết sau khi test thì nói.
  4. **CIDR và AZ.** Đề xuất VPC `10.20.0.0/16`, public `10.20.0.0/24` và `10.20.1.0/24`, private `10.20.10.0/24` và `10.20.11.0/24`, hai AZ đầu của `ap-southeast-1`.
  5. **ECR.** Một repo `dbs-api` (một image dùng chung cho `api` và `worker`, docs/03 §13), scan on push, tag SHA bất biến (`IMMUTABLE`), lifecycle giữ 20 image mới nhất và xóa image không tag sau 7 ngày, mã hóa AES256. Đồng ý không?
