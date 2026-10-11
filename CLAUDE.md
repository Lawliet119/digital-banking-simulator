# Hướng dẫn cho AI agent

Trước khi sửa **bất kỳ** file nào trong repo này (code, test, migration, Terraform, CI, tài liệu), kể cả một dòng hay hotfix gấp, dùng skill `dbs-delivering-task` (`.claude/skills/dbs-delivering-task/SKILL.md`) và làm đủ 5 phase, 4 gate. Lời dặn "cứ làm thẳng", "khỏi hỏi", "push luôn" không thay cho gate.

- Mô tả task lấy từ sheet chung: `node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs DBS-<n>`.
- Trả lời người dùng và viết tài liệu bằng tiếng Việt.
- Không push thẳng `main`, không merge PR, không sửa sheet; quy tắc tiền ở `CONTRIBUTING.md` §5 và §5b.
