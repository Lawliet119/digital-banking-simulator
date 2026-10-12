# Backlog: việc còn tồn sau các task

> **Status:** Active · **Owner:** cả nhóm · **Verified against code:** n/a · **Cập nhật:** 2026-10-12

Nơi gom những việc một task **cố ý không làm** và đã chuyển cho người hoặc task khác: một DoD chưa đạt được vì thiếu hạ tầng, một phát hiện review thuộc module khác, một giới hạn đã chấp nhận và cần quay lại sửa. Mỗi dòng trỏ về feature doc đã sinh ra nó. Việc của chính task đang làm không ghi ở đây.

Quy tắc:
- Thêm dòng ở Phase 5 của skill [`dbs-delivering-task`](../.claude/skills/dbs-delivering-task/SKILL.md), cùng PR với task sinh ra nó. ID tăng dần, không dùng lại.
- Task nào xử lý xong một dòng thì **xóa dòng đó** trong PR của mình và ghi ID ở mục "Tài liệu đã cập nhật" của feature doc. Không gạch ngang; lịch sử nằm trong git.
- Trước khi bắt đầu một task, xem bảng này: có dòng nào cùng module hay cùng DoD thì xử lý luôn, hoặc nêu ở G1.
- Muốn đưa lên board thì báo người quản lý board; agent không sửa board.

| ID | Việc còn thiếu | Nguồn | Vai đề xuất | Đóng khi |
|---|---|---|---|---|
| BL-001 | Repo chưa có CI (`.github/workflows/`). Pipeline cần chạy `lint:check`, `typecheck`, `test`, `test:e2e` và `test:db` (service Postgres 17, `timezone=UTC`, `DATABASE_URL` trỏ vào service). Vì thiếu CI nên DoD "CI xanh" của DBS-20 chưa kiểm được | [DBS-20](features/DBS-20-migration-users-customers-accounts.md) §1 câu hỏi 7, §2 bàn giao | #5 Platform & Ops | Workflow chạy đủ năm lệnh, xanh trên `main` |
| BL-002 | Event contract khai `TransferCompleted.fromUserId` kiểu `uuid` không null. Với `type = DEPOSIT`, nguồn là tài khoản SYSTEM `funding` không có chủ (`accounts_owner_matches_type`), nên trường này không có giá trị hợp lệ. Đề xuất `fromUserId: uuid \| null` (null khi `DEPOSIT`), `sameOwner = false` | [DBS-20](features/DBS-20-migration-users-customers-accounts.md) §2 bàn giao, §5 review #5; [event-contract](components/_shared/event-contract.md) | Dev làm event contract / outbox | Contract và producer nạp tiền thống nhất |
| BL-003 | Sync guard chưa cấm chuyển tiền vào hoặc ra tài khoản SYSTEM. Id `funding` cố định nên dễ đoán. Đề xuất: lệnh `TRANSFER` có nguồn hoặc đích là `type = 'SYSTEM'` bị từ chối `ACCOUNT_NOT_ACTIVE`, giống tài khoản không tồn tại | [DBS-20](features/DBS-20-migration-users-customers-accounts.md) §2 bàn giao, §5 review #9; [ADR-09](adr/0009-funding-system-account.md) | Dev làm task chuyển tiền | Có test e2e cho cả hai chiều |
