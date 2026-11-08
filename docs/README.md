# docs — Bản đồ tài liệu

> **Status:** Active · **Owner:** cả nhóm · **Verified against code:** n/a · **Cập nhật:** 2026-10-12

## Đọc gì trước

| Bạn là… | Đọc theo thứ tự |
|---|---|
| Người mới vào nhóm | [README gốc](../README.md) → [BRD](BRD.md) → [03](03_HIGH_LEVEL_ARCHITECTURE.md) §1–5 |
| Sắp làm một task | Skill [`dbs-delivering-task`](../.claude/skills/dbs-delivering-task/SKILL.md) (bắt buộc) → [`BACKLOG.md`](BACKLOG.md) (việc còn tồn) → [`features/`](features/README.md) (task trước của cùng module) → [`components/index.md`](components/index.md) → các mục docs/03 liên quan |
| Sắp viết một bản nộp | [`deliverables/README.md`](deliverables/README.md) |
| Chuẩn bị bảo vệ | [03](03_HIGH_LEVEL_ARCHITECTURE.md) §16–18, [ADR](adr/README.md), [FRAUD guide](components/risk/FRAUD_DETECTION_GUIDE.md) |

## Cấu trúc

```
docs/
├── BRD.md                                 Nghiệp vụ, yêu cầu, mô hình miền (3 phần)     (cấp hệ thống)
├── 03_HIGH_LEVEL_ARCHITECTURE.md          Kiến trúc tổng thể và chi tiết từng module    (cấp hệ thống)
├── BACKLOG.md                             Việc còn tồn mà các task đã chuyển cho người/task khác
├── adr/                                   14 quyết định kiến trúc đã chốt (ADR-01…14), kèm lý do
├── security/                              Threat model STRIDE (P3)
├── features/                              Một file cho mỗi task implement + screenshots/ (ảnh tính năng)
├── components/                            Concept brief từng component + thiết kế dùng chung
│   ├── index.md   _shared/ (api-design, database-design, event-contract, glossary)
│   └── ledger/  accounts/  identity/  risk/  audit/  outbox/  notification/  health/
│       platform-infra/  ci-cd/  observability/  fraud-dataset/  load-tests/
└── deliverables/                          Năm bản nộp P1–P5 (bản ghép trỏ về nguồn)
```

## Một sự thật, một chỗ

| Loại thông tin | Nơi duy nhất |
|---|---|
| Mục tiêu, quy tắc nghiệp vụ (BR), NFR, tiêu chí chấp nhận | `BRD` |
| Kiến trúc hệ thống và chi tiết từng module: luồng, API, mã lỗi, Redis, bảo mật, triển khai | `03` (riêng `risk`: thêm `components/risk/02-architecture.md`) |
| Đặc tả chi tiết REST API: headers, DTO request/response, phân trang cursor, mã lỗi `problem+json` | `components/_shared/api-design.md` |
| Schema DB toàn hệ thống: bảng, ràng buộc, index, quyền, migration | `components/_shared/database-design.md` |
| Hình dạng sự kiện | `components/_shared/event-contract.md` |
| Lý do một quyết định | `adr/` |
| Mối đe dọa và biện pháp | `security/threat-model.md` |
| Thiết kế, test case và kết quả của **một task** | `features/DBS-<n>-<slug>.md` |
| Việc còn tồn sau các task (DoD chưa đạt vì thiếu hạ tầng, việc bàn giao cho module khác) | `BACKLOG.md` |
| Kế hoạch thực thi | Board của nhóm (đọc bằng `fetch-task.mjs`); roadmap cũ đã xóa ngày 2026-11-07 |

Nơi khác chỉ **link**, không chép lại.

## Quy tắc

1. Mỗi file có dòng **Status** ở đầu (`Draft | Accepted | Implemented`, owner, đã đối chiếu code chưa).
2. Đổi thiết kế → cập nhật tài liệu **trong cùng PR** (có mục kiểm trong PR template).
3. Mỗi task implement có **một** file `features/DBS-<n>-<slug>.md` (kiến trúc, hành vi, test case, kết quả, ảnh chụp) theo skill `dbs-delivering-task`. Không tạo thêm file docs theo component. Thay đổi cấp hệ thống vẫn sửa docs/03 hoặc `_shared/`; quyết định mới đi vào ADR.
4. Tài liệu hết hiệu lực thì xóa; lịch sử đã có trong git.
