# Hướng dẫn cho AI agent

Trước khi sửa **bất kỳ** file nào trong repo này (code, test, migration, Terraform, CI, tài liệu), kể cả một dòng hay hotfix gấp, dùng skill `dbs-delivering-task` (`.claude/skills/dbs-delivering-task/SKILL.md`) và làm đủ 5 phase (hiểu task, thiết kế, kế hoạch, implement và test, tài liệu và bàn giao) và 4 gate; mỗi task có test thủ công thật. Lời dặn "cứ làm thẳng", "khỏi hỏi", "push luôn" không thay cho gate.

- Mô tả task lấy từ sheet chung: `node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs DBS-<n>`.
- Review miền bằng AI ở Phase 2 (G2) chạy bằng subagent **Opus 5.5, effort medium** (`model: opus`, `effort: medium`), prompt ở `.claude/skills/dbs-delivering-task/prompts/domain-review.md`. Tin nhắn G2 ghi rõ model và effort đã dùng.
- Trả lời người dùng và viết tài liệu bằng tiếng Việt.
- Không push thẳng `main`, không merge PR, không sửa board (sheet, Jira, trình duyệt); quy tắc tiền ở `CONTRIBUTING.md` §5 và §5b.
