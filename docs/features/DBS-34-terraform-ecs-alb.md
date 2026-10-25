# DBS-34 · Terraform: ECS Fargate cluster, service api và ALB (môi trường dev)

> **Status:** Draft (đang làm, đến G2) · **Vai:** #5 Platform & Ops · **Cặp đôi review:** Dev · **Nhánh:** `chore/DBS-34-ecs-alb` (xếp chồng trên `chore/DBS-36-ci-ecr-oidc`) · **PR:** — · **Cập nhật:** 2026-10-26

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 1, Deliverable P3, Ưu tiên High, board đang "In Progress". **Expect:** Có chỗ để image chạy trên cloud và ALB kiểm /health/ready.
- **DoD** (nguyên văn, đánh số):
  1. Cluster, task definition (APP_ROLE=api), service và ALB (health check /health/ready) bằng Terraform, thuộc nhóm «xóa hằng ngày»
  2. TRUST_PROXY_HOPS=1 trong cấu hình task (ALB); không secret trong biến môi trường viết thẳng
  3. Log task đẩy về CloudWatch Logs; task execution role tách khỏi task role
  4. apply rồi destroy trong một lệnh, không còn tài nguyên tính tiền
  5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Thực trạng trên board (cập nhật 11/10):** health check `/health/ready` mỗi 15 s, timeout 5 s, healthy 2, unhealthy 3; `healthCheckGracePeriodSeconds 60`; task api 0,5 vCPU / 1 GB (docs/03 §13.1, §13.3).
- **Phụ thuộc:** DBS-33 (VPC, ECR): board In Review; mã ở [PR #23](https://github.com/Lawliet119/digital-banking-simulator/pull/23), `base` đã dựng thật trên AWS. Nhánh này xếp chồng: `main` ← #22 (DBS-31) ← #23 (DBS-33) ← #24 (DBS-36) ← nhánh này.
- **Đã có gì:**
  - `envs/dev/base`: VPC 10.20.0.0/16, 2 public + 2 private subnet, S3 gateway endpoint, ECR `dbs-api` (+ OIDC từ DBS-36).
  - `envs/dev/session`: khung rỗng (chỉ `terraform_remote_state` của `base`, chưa có provider).
  - Ứng dụng: `backend/Dockerfile` (port 3000, user `node`, không HEALTHCHECK); `GET /health/ready` kiểm PostgreSQL (timeout 1,5 s), `GET /health/live` không kiểm gì; `TRUST_PROXY_HOPS` bắt buộc 1–5 khi `NODE_ENV` là `staging`/`production`.
  - ADR-10 (task ở public subnet, SG chỉ nhận từ ALB, không NAT), ADR-11 (dựng/xóa theo phiên), ADR-13 (một image, `APP_ROLE`).
  - Image trên ECR: **chưa có** (ECR rỗng; `image.yml` chỉ chạy sau merge).
- **Baseline:** `terraform test`: bootstrap 9/9, `base` 13/13, `session` 1/1; `fmt` và `validate` sạch (chạy lúc bàn giao DBS-36).
- **Ngoài phạm vi:**
  - Service `worker`, WAF, HTTPS và tên miền (DBS-38 chưa; HTTPS chưa có domain/cert: xem câu 3).
  - Security group và subnet group của RDS/Redis (DBS-66, BL-031), DB secrets và TLS (DBS-67), Cognito (DBS-54).
  - Chạy task thật: cần image trên ECR (sau merge DBS-36 và biến `AWS_ROLE_ARN`), DB (DBS-66) và secrets (DBS-67). Task chưa thể `healthy` khi chưa có các thứ này.
  - Deploy tự động và rollback (DBS-38).
- **Câu hỏi mở** (kèm đề xuất):
  1. **Vị trí.** Security group `alb` và `api` đặt trong `envs/dev/base` (BL-031: SG ở `base`; miễn phí; các stack sau tham chiếu được); cluster, task definition, service, ALB, target group, listener, log group, IAM role đặt trong `envs/dev/session` (nhóm xóa hằng ngày). Đề xuất: đúng như vậy.
  2. **Task chưa chạy được thật.** Task cần DB, Redis, Cognito, SQS mà các task khác mới tạo. Đề xuất: task definition chỉ có biến môi trường không bí mật (`NODE_ENV`, `APP_ROLE=api`, `TRUST_PROXY_HOPS=1`, `PORT`, `AWS_REGION`, `LOG_LEVEL`); `secrets` và các biến còn lại do DBS-66/67/54 thêm. `desired_count` là biến (mặc định 1, theo 0,5 vCPU/1 GB một task); test thủ công ở task này dùng `desired_count = 0`, và ghi "chưa chạy" cho việc task healthy thật (BACKLOG, đóng ở DBS-38/67).
  3. **HTTP, chưa HTTPS.** Chưa có tên miền và chứng chỉ ACM. Đề xuất: listener HTTP :80 cho dev (demo nội bộ, không dữ liệu thật), ghi rủi ro rõ và mở dòng BACKLOG cho HTTPS + WAF (DBS-38/tuần 6–8). **Đây là quyết định bảo mật**: bạn có thể chọn hoãn task này cho tới khi có domain.
  4. **`NODE_ENV` của task.** Đề xuất: biến `node_env` mặc định `staging` (dev trên AWS chạy `staging` theo `platform.md`, bắt buộc TLS DB/Redis và `TRUST_PROXY_HOPS`).
  5. **Log group** `/dbs/dev/api`, giữ 7 ngày, nằm trong `session` (bị xóa cùng phiên; không tốn tiền khi để lại).
  6. **`apply`** lên AWS thật (ALB tính ≈ 0,0225 USD/giờ, cộng LCU): cần bạn đồng ý, và tôi `destroy` ngay sau khi kiểm.
  7. **Provider trong `session`:** thêm provider `aws` (cùng `allowed_account_ids`, `default_tags`) và đổi test `session` sang `mock_provider` (BL-031/§1 DBS-33 đã nêu).

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

(Điền ở Phase 4–5.)
