# DBS-36 · CI: build image, đẩy ECR với tag SHA bằng OIDC

> **Status:** Draft (đang làm, đến G2) · **Vai:** #5 Platform & Ops · **Cặp đôi review:** Dev · **Nhánh:** `chore/DBS-36-ci-ecr-oidc` (xếp chồng trên `chore/DBS-33-terraform-vpc-ecr`) · **PR:** — · **Cập nhật:** 2026-10-25

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 1, Deliverable P3, Ưu tiên High, board đang "In Progress". **Expect:** Mỗi commit trên main có một image truy được về SHA.
- **DoD** (nguyên văn, đánh số):
  1. Role IAM cho GitHub OIDC chỉ tin repo Lawliet119/digital-banking-simulator và nhánh main (điều kiện sub trong trust policy)
  2. Push main: build image từ backend/Dockerfile, quét scan on push, đẩy ECR với tag = SHA (không dùng latest để deploy)
  3. Không có access key nào trong GitHub Secrets (kiểm bằng danh sách Secrets)
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc:**
  - DBS-35 (CI sáu job): Done trên board, `.github/workflows/ci.yml` có trong repo.
  - DBS-33 (VPC và ECR): board In Review; ECR `dbs-api` đã dựng thật trên AWS, mã ở [PR #23](https://github.com/Lawliet119/digital-banking-simulator/pull/23) chưa merge. Vì vậy nhánh này xếp chồng trên nhánh DBS-33 (mã Terraform của role cần `ecr_repository_arn` từ `envs/dev/base`).
- **Đã có gì:**
  - `backend/Dockerfile` (ba stage, chạy bằng user `node`) và `backend/.dockerignore`.
  - `.github/workflows/ci.yml`: sáu job `lint`, `typecheck`, `unit`, `e2e`, `db`, `build`; tên job là hợp đồng (DBS-37, BL-012/BL-013), workflow khác không được dùng lại các tên này; `permissions: contents: read` toàn cục.
  - AWS: chưa có IAM OIDC provider nào; ECR `dbs-api` IMMUTABLE, scan on push, lifecycle (DBS-33).
  - GitHub Secrets: 0 mục (đã đếm).
  - Máy này không có docker nên không build thử image cục bộ; runner GitHub có docker.
  - Handoff từ DBS-33 (BL-031): role OIDC chỉ được push vào `ecr_repository_arn`; bỏ qua push nếu tag SHA đã tồn tại (repo IMMUTABLE); không dùng `latest`.
- **Baseline:** Terraform `fmt` sạch; `terraform test` bootstrap 9/9, `envs/dev/base` 8/8, `envs/dev/session` 1/1 (chạy lúc kết thúc DBS-33). Task này không đổi mã backend nên không chạy bốn lệnh backend.
- **Ngoài phạm vi:**
  - Deploy lên ECS và gọi `/health/ready` là DBS-38; role deploy riêng sẽ thêm ở đó.
  - Required status check cho `main` và job Terraform trong CI là DBS-37 (BL-028).
  - Quét lỗ hổng image bằng công cụ ngoài (Trivy) và quét secret: ngoài DoD của task này.
  - Mọi thay đổi `backend/Dockerfile` (DBS-67 thêm bundle CA RDS).
- **Câu hỏi mở** (kèm đề xuất):
  1. **Vị trí Terraform của OIDC provider và role.** Đề xuất: `envs/dev/base` (giữ lại gần như miễn phí, nằm cạnh ECR). Provider là tài nguyên duy nhất toàn tài khoản; role `dbs-github-ecr-push`.
  2. **Điều kiện `sub`.** Đề xuất: đúng `repo:Lawliet119/digital-banking-simulator:ref:refs/heads/main` (so khớp `StringEquals`, không wildcard) và `aud = sts.amazonaws.com`. PR hay nhánh khác không assume được role.
  3. **Quyền của role.** Đề xuất: `ecr:GetAuthorizationToken` (Resource `*`, bắt buộc theo AWS) và nhóm push (`BatchCheckLayerAvailability`, `InitiateLayerUpload`, `UploadLayerPart`, `CompleteLayerUpload`, `PutImage`, `BatchGetImage` để kiểm tag đã có) giới hạn vào ARN `dbs-api`; không `ecr:*`, không xóa image.
  4. **Workflow mới.** Đề xuất: file riêng `.github/workflows/image.yml`, trigger `push` vào `main`, một job tên `image-push` (khác sáu tên hợp đồng), `permissions: id-token: write, contents: read`, action `aws-actions/configure-aws-credentials` và `amazon-ecr-login` ghim theo SHA như `ci.yml`. Tag duy nhất là `${{ github.sha }}`, không `latest`; nếu tag đã tồn tại thì bỏ qua push (đánh dấu thành công). Role ARN và region truyền qua biến `vars` của repo (không phải secret).
  5. **Có chờ CI xanh trước khi push không?** Đề xuất: không phụ thuộc vào workflow `CI` (tránh khóa chéo); `main` đã được bảo vệ bằng required checks ở DBS-37 nên chỉ commit đã qua PR mới tới main.
  6. **Cách chứng minh khi chưa merge.** Role chỉ tin nhánh `main` nên đường thành công chỉ chạy được sau khi PR merge. Đề xuất: trước merge chạy ca bị từ chối (workflow chạy từ nhánh PR bằng `workflow_dispatch` phải không assume được role) và các kiểm tra tĩnh/Terraform; đường thành công ghi "chưa chạy, chạy sau merge" và mở BL-NNN, đóng bằng lần push `main` đầu tiên (bạn hoặc Dev merge, tôi kiểm ECR sau đó).
  7. **`apply` trên AWS thật** (OIDC provider, role, policy: miễn phí): cần bạn đồng ý ở G3 như hai task trước.
  8. **Biến repo (`vars`)**: bạn cần tạo `AWS_ROLE_ARN` và `AWS_REGION` trong GitHub (Settings → Variables) sau khi tôi `apply`; tôi không tạo được vì quy tắc "không sửa GitHub trước G3" và tôi không giữ token quản trị repo.

**Quyết định ở G1:** (chờ duyệt)

## 2. Hành vi

(Điền ở Phase 2.)

## 3. Kiến trúc

(Điền ở Phase 2.)

## 4. Test cases tự động

(Điền ở Phase 2.)

## 5. Test thủ công

(Điền ở Phase 2.)

## 6. Domain review (AI)

(Chạy ở Phase 2.)

## 7. Kế hoạch triển khai

(Điền ở Phase 3.)

## 8. Kết quả

(Điền ở Phase 4–5.)

## 9. Tài liệu đã cập nhật

(Điền ở Phase 5.)
