# docs — Bản đồ tài liệu

> **Status:** Active · **Owner:** cả nhóm · **Verified against code:** n/a · **Cập nhật:** 2026-10-11

## Đọc gì trước

| Bạn là… | Đọc theo thứ tự |
|---|---|
| Người mới vào nhóm | [README gốc](../README.md) → [01](01_BUSINESS_ANALYSIS.md) → [03](03_HIGH_LEVEL_ARCHITECTURE.md) §1–5 → [kế hoạch 10 tuần](plan/10_WEEK_PLAN.md) → [playbook theo vai](plan/TEAM_ROLES_PLAYBOOK.md) |
| Sắp làm một module | [`components/index.md`](components/index.md) → `components/<module>/01-concept-brief.md` → các mục docs/03 mà brief trỏ tới → [master roadmap](superpowers/plans/2026-10-02-master-roadmap.md) (task của module) |
| Sắp viết một bản nộp | [`deliverables/README.md`](deliverables/README.md) |
| Chuẩn bị bảo vệ | [03](03_HIGH_LEVEL_ARCHITECTURE.md) §16–18, [ADR](adr/README.md), [playbook](plan/TEAM_ROLES_PLAYBOOK.md) (bẫy hay gặp theo vai) |

## Cấu trúc

```
docs/
├── 01_BUSINESS_ANALYSIS.md                Bài toán, mục tiêu, quy tắc nghiệp vụ        (cấp hệ thống)
├── 02_REQUIREMENTS_AND_DOMAIN_MODEL.md    Use case, FR, NFR, AC, domain model           (cấp hệ thống)
├── 03_HIGH_LEVEL_ARCHITECTURE.md          Kiến trúc tổng thể và chi tiết từng module    (cấp hệ thống)
├── adr/                                   13 quyết định kiến trúc (ADR-01…13) và lý do
├── security/                              Threat model STRIDE (P3)
├── plan/                                  Kế hoạch 10 tuần + playbook theo vai
├── superpowers/plans/                     Implementation plan (master roadmap, plan từng task)
├── components/                            Concept brief từng component + thiết kế dùng chung
│   ├── index.md   _shared/ (database-design, event-contract, glossary)
│   └── ledger/  accounts/  identity/  risk/  audit/  outbox/  notification/  health/
│       platform-infra/  ci-cd/  observability/  fraud-dataset/  load-tests/
└── deliverables/                          Năm bản nộp P1–P5 (bản ghép trỏ về nguồn)
```

## Một sự thật, một chỗ

| Loại thông tin | Nơi duy nhất |
|---|---|
| Mục tiêu, quy tắc nghiệp vụ (BR), NFR, tiêu chí chấp nhận | `01`, `02` |
| Kiến trúc hệ thống và chi tiết từng module: luồng, API, mã lỗi, Redis, bảo mật, triển khai | `03` (riêng `risk`: thêm `components/risk/02-architecture.md`) |
| Schema DB toàn hệ thống: bảng, ràng buộc, index, quyền, migration | `components/_shared/database-design.md` |
| Hình dạng sự kiện | `components/_shared/event-contract.md` |
| Lý do một quyết định | `adr/` |
| Mối đe dọa và biện pháp | `security/threat-model.md` |
| Kế hoạch thực thi | `superpowers/plans/`; việc từng tuần nằm trên board của nhóm |

Nơi khác chỉ **link**, không chép lại.

## Quy tắc

1. Mỗi file có dòng **Status** ở đầu (`Draft | Accepted | Implemented`, owner, đã đối chiếu code chưa).
2. Đổi thiết kế → cập nhật tài liệu **trong cùng PR** (có mục kiểm trong PR template).
3. Không tạo file docs mới cho từng component. Thiết kế mới đi vào docs/03 hoặc `_shared/`; quyết định mới đi vào ADR.
4. Tài liệu hết hiệu lực thì xóa; lịch sử đã có trong git.
