# docs — Bản đồ tài liệu

> **Status:** Active · **Owner:** cả nhóm · **Verified against code:** n/a · **Cập nhật:** 2026-10-03

## Đọc gì trước

| Bạn là… | Đọc theo thứ tự |
|---|---|
| Người mới vào nhóm | [README gốc](../README.md) → [01](01_BUSINESS_ANALYSIS.md) → [03](03_HIGH_LEVEL_ARCHITECTURE.md) §1–5 → [kế hoạch 10 tuần](plan/10_WEEK_PLAN.md) → [playbook theo vai](plan/TEAM_ROLES_PLAYBOOK.md) |
| Sắp làm một module | [`components/index.md`](components/index.md) → `components/<module>/01`, `02` → [master roadmap](superpowers/plans/2026-10-02-master-roadmap.md) (task của module) |
| Sắp viết một bản nộp | [`deliverables/README.md`](deliverables/README.md) |
| Chuẩn bị bảo vệ | [03](03_HIGH_LEVEL_ARCHITECTURE.md) §16–18, [ADR](adr/README.md), `components/*/05-backlog.md`, `plan/TEAM_ROLES_PLAYBOOK.md` (câu bảo vệ theo vai) |

## Cấu trúc

```
docs/
├── 01_BUSINESS_ANALYSIS.md                Bài toán, mục tiêu, quy tắc nghiệp vụ        (cấp hệ thống)
├── 02_REQUIREMENTS_AND_DOMAIN_MODEL.md    Use case, FR, NFR, AC, domain model           (cấp hệ thống)
├── 03_HIGH_LEVEL_ARCHITECTURE.md          Kiến trúc tổng thể                            (cấp hệ thống)
├── DEPLOYMENT_OPTIONS_VPS_VS_CLOUD.md     Phân tích VPS vs cloud (đầu vào ADR-11)
├── adr/                                   Quyết định kiến trúc và lý do
├── plan/                                  Kế hoạch 10 tuần + playbook theo vai
├── superpowers/plans/                     Implementation plan (master roadmap, plan từng task)
├── components/                            Tài liệu từng component: 01 concept · 02 architecture · …
│   ├── index.md   _shared/   _templates/
│   └── ledger/  accounts/  identity/  risk/  audit/  outbox/  notification/  health/
│       platform-infra/  ci-cd/  observability/  fraud-dataset/  load-tests/
├── deliverables/                          Năm bản nộp P1–P5
└── notes/                                 Ghi chú lập luận, chưa chốt
```

## Một sự thật, một chỗ

| Loại thông tin | Nơi duy nhất |
|---|---|
| Mục tiêu, quy tắc nghiệp vụ (BR), NFR, tiêu chí chấp nhận | `01`, `02` |
| Kiến trúc cấp hệ thống: drivers, C4, Redis, bảo mật tổng, triển khai | `03` |
| Chi tiết **một** component: luồng, bảng, API, lỗi | `components/<tên>/02-architecture.md` |
| Hình dạng sự kiện | `components/_shared/event-contract.md` |
| Lý do một quyết định | `adr/` |
| Kế hoạch thực thi | `superpowers/plans/` |
| Lập luận chưa chốt | `notes/` |

Nơi khác chỉ **link**, không chép lại.

## Trạng thái hiện tại và lộ trình tách docs/03

`docs/03` đang chứa chi tiết của mọi module (khoảng 800 dòng). Khung `components/` mới có `01-concept-brief` và `02-architecture` (khung rỗng, trỏ về các mục của docs/03). **Chưa tách nội dung khỏi docs/03 trước khi nộp P2** để tránh sai sót sát hạn; sau khi nộp P2, chuyển phần chi tiết từng module về `components/<tên>/02-architecture.md` và để docs/03 còn phần tổng quan.

## Quy tắc

1. Mỗi file có dòng **Status** ở đầu (`Draft | Accepted | Implemented`, owner, đã đối chiếu code chưa).
2. Đổi thiết kế → cập nhật tài liệu **trong cùng PR** (có mục kiểm trong PR template).
3. Tài liệu hết hiệu lực thì chuyển vào `archive/` (tạo khi cần), không xóa.
