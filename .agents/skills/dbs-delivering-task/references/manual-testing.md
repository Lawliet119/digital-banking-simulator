# Manual testing

Used in Phase 2 (write the script, §5 of the feature doc) and Phase 4c (run it). The automated tests prove the cases you thought of; the manual test is you operating the real thing and looking at what it does. What the manual test is for each kind of task: `task-kinds.md`.

## Rules

- Run it against the real application, database and queue (docker compose), not a mock and not a unit test.
- Every step is **action → expected result**, written before the code exists (Phase 2), run after it works (Phase 4c).
- Cover at least: one success path, one rejection or boundary case, and (when the task has one) one failure or recovery case: kill the process mid-request, resend with the same key, stop Redis, restart the worker.
- **Keep the raw output** in `docs/features/screenshots/DBS-<n>/manual-test.txt` (not `.log`: `*.log` is gitignored), including `correlationId` and row ids. Run the commands in **Git Bash** (`… 2>&1 | tee -a manual-test.txt`): PowerShell 5.1 writes UTF-16, which git treats as binary. In §8 record each step's command, a trimmed response and the result. During PR review the pair re-runs one step or one `psql` query and compares.
- **Redact before you commit** the file: `Authorization` headers and tokens, passwords, AWS account ids and ARNs. Say in the G4 checklist that you did.
- A step you did not execute is **chưa chạy (lý do)**, never "đạt". At G4 the human accepts each such step by name.
- A failing step is a bug: go back to 4a, add the test that reproduces it, then fix.
- Do not weaken a guard or switch off TLS, ownership or auth to make a step pass.
- Use realistic data: Vietnamese names and amounts in đồng that a bank clerk would recognise, no `test123`, no random suffixes, no case ids.

## Environment

From the repo root: `cp .env.example .env`, then `docker compose up -d` (PostgreSQL 17, Valkey, ElasticMQ). From `backend/`: `cp env/.env.example env/.env.development`, then `npm run migration:run` and `npm run start:dev` (`APP_ROLE=both`). Split roles like AWS with `npm run start:dev:api` and `npm run start:dev:worker` in two terminals.

| Need | How |
|---|---|
| Swagger UI | `http://localhost:3000/docs` (not available in production) |
| Health | `http://localhost:3000/health/live`, `/health/ready` |
| Database | `docker compose exec postgres psql -U banking banking` (`\d <table>`, `SELECT`) |
| Queue UI | `http://localhost:9325` (ElasticMQ) |
| Slow or dead Redis | `docker compose pause valkey` (slow), `docker compose stop valkey` (down); `unpause` or `start` to recover |
| Token of a role | The dev-token helper from DBS-53 (`npm run auth:dev-token`, per ADR-06), once merged. Before that no endpoint behind the auth guard can be called by hand: see "When a manual step needs something not built yet" in `task-kinds.md` |
| Port 5432 already used by another PostgreSQL on this machine | Map the container to another port in a compose override kept outside the repo and point `DATABASE_URL` at it; note it in §1 |

## Screenshots

Take them from the manual test, in `docs/features/screenshots/DBS-<n>/`, `NN-what.png`, referenced from §8. Show one real result per picture: a Swagger response with status and body, a terminal with the command and its output, a `psql` result. Docs-only tasks have no manual test: say so and take none.
