# docs — Bản đồ tài liệu

> **Status:** Active · **Owner:** cả nhóm · **Verified against code:** n/a · **Cập nhật:** 2026-10-11

## Đọc gì trước

| Bạn là… | Đọc theo thứ tự |
|---|---|
| Người mới vào nhóm | [README gốc](../README.md) → [01](01_BUSINESS_ANALYSIS.md) → [03](03_HIGH_LEVEL_ARCHITECTURE.md) §1–5 |
| Sắp làm một task | Skill [`dbs-delivering-task`](../.claude/skills/dbs-delivering-task/SKILL.md) (bắt buộc) → [`features/`](features/README.md) (task trước của cùng module) → [`components/index.md`](components/index.md) → các mục docs/03 liên quan |
| Sắp viết một bản nộp | [`deliverables/README.md`](deliverables/README.md) |
| Chuẩn bị bảo vệ | [03](03_HIGH_LEVEL_ARCHITECTURE.md) §16–18, [ADR](adr/README.md), [FRAUD guide](components/risk/FRAUD_DETECTION_GUIDE.md) |

## Cấu trúc

```
docs/
├── 01_BUSINESS_ANALYSIS.md                Bài toán, mục tiêu, quy tắc nghiệp vụ        (cấp hệ thống)
├── 02_REQUIREMENTS_AND_DOMAIN_MODEL.md    Use case, FR, NFR, AC, domain model           (cấp hệ thống)
├── 03_HIGH_LEVEL_ARCHITECTURE.md          Kiến trúc tổng thể và chi tiết từng module    (cấp hệ thống)
├── adr/                                   13 quyết định kiến trúc (ADR-01…13) và lý do
├── security/                              Threat model STRIDE (P3)
├── superpowers/plans/                     Implementation plan (master roadmap, plan từng task)
├── features/                              Một file cho mỗi task implement + screenshots/ (ảnh tính năng)
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
| Thiết kế, test case và kết quả của **một task** | `features/DBS-<n>-<slug>.md` |
| Kế hoạch thực thi | `superpowers/plans/` (roadmap); việc từng tuần nằm trên board của nhóm |

Nơi khác chỉ **link**, không chép lại.

## Quy tắc

1. Mỗi file có dòng **Status** ở đầu (`Draft | Accepted | Implemented`, owner, đã đối chiếu code chưa).
2. Đổi thiết kế → cập nhật tài liệu **trong cùng PR** (có mục kiểm trong PR template).
3. Mỗi task implement có **một** file `features/DBS-<n>-<slug>.md` (kiến trúc, hành vi, test case, kết quả, ảnh chụp) theo skill `dbs-delivering-task`. Không tạo thêm file docs theo component. Thay đổi cấp hệ thống vẫn sửa docs/03 hoặc `_shared/`; quyết định mới đi vào ADR.
4. Tài liệu hết hiệu lực thì xóa; lịch sử đã có trong git.
