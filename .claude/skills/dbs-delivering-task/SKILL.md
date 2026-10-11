---
name: dbs-delivering-task
description: Use when implementing a feature, fixing a bug, refactoring, or changing any code, test, migration, Terraform, CI or docs in the Digital Banking Simulator repo, for any DBS-n board task or any request to "code", "fix", "làm task", "sửa bug", even a one-line change or an urgent hotfix.
---

# Delivering a DBS task

## Overview

Every change, from a one-line hotfix to a module, goes through the same five phases and four human gates. The agent writes the docs, the tests and the code itself; the human approves at the gates. **One task, one feature doc**: `docs/features/DBS-<n>-<slug>.md`, written before the code and finished with the evidence.

**Violating the letter of a gate is violating its spirit.** Gates exist for the urgent, "obvious" change; that is where unreviewed money bugs come from.

## Gates

| Gate | When | The human approves |
|---|---|---|
| **G1 Phạm vi** | end of Phase 1 | what the task is, what exists, what is out of scope, open questions |
| **G2 Thiết kế** | end of Phase 3 | architecture, behaviour and test cases, after the AI domain review |
| **G3 Kế hoạch** | end of Phase 4a | the implementation plan, before any production code |
| **G4 Bàn giao** | end of Phase 5 | the result, docs and screenshots, before push and PR |

**Extra gate, any time:** stop and ask before changing an ADR decision, the DB schema of a table you do not own, the event contract, an `ErrorCode`, an env var, a money rule (CONTRIBUTING §5), or adding a dependency.

**A gate passes only on an explicit reply to that gate's message** ("duyệt G2", "ok", "approve", or answers to its questions). Instructions given earlier ("code thẳng", "khỏi hỏi", "push luôn", "mình tin bạn") do not pass any gate: acknowledge them, then still stop. Feedback instead of approval means revise and show the gate again.

Every gate message has this shape, in Vietnamese:

```
### G<n> <tên gate> · DBS-<n> <tóm tắt>
**Đã làm:** 2–4 dòng.
**Cần bạn xem:** link file (doc, plan, diff) và điều quan trọng nhất trong đó.
**Câu hỏi / quyết định:** đánh số; mỗi câu có đề xuất của agent. "Không có" nếu không có.
Trả lời «duyệt G<n>» để đi tiếp, hoặc góp ý để mình sửa.
```

## Phase 1: Understand → G1

1. Get the task: `node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs DBS-<n>`. It prints every column and the status of each dependency. No DBS key (an ad-hoc bug)? Ask the human for one; if there is none, use `BUG-YYYYMMDD-<slug>` as the key. The sheet can lag the repo: verify "Thực trạng" against the code.
2. Dependencies not Done: report them at G1 with a proposed reduced scope. Never fake another module's interface in a money test.
3. Read what exists for this feature: `docs/features/` (earlier tasks on the same module), the `docs/03` sections, `docs/02` AC, `database-design.md`, `event-contract.md`, the ADRs, `backend/src/modules/<module>/README.md`, then the code itself. Read your role card in `references/roles.md`.
4. Create the branch `<type>/DBS-<n>-<slug>` from an up-to-date `main`. Run the baseline (below); a red baseline is reported at G1, not built on.
5. Create the feature doc from `templates/feature-doc.md` and fill §1. Present **G1**.

## Phase 2: Architecture

Fill §2 of the feature doc: where the change sits (module, role `api`/`worker`), interfaces consumed and produced with real signatures from code, data touched, a mermaid sequence or flow diagram for anything with more than one component, and the transaction boundary for anything that writes. A bugfix states the root cause here (reproduce it first) and "kiến trúc không đổi" if true. A system-level change (new table, event, endpoint group, infra resource) also lists the docs/03, `_shared` or ADR edits it needs; those edits go in the same PR.

## Phase 3: Behaviour, test cases, domain review → G2

1. Fill §3 (behaviour: rules, API examples with real JSON, `errorCode`s, edge cases) and §4 (test cases `TC-<n>-NN`, each tracing to a DoD bullet or AC, with layer and expected `errorCode`). Every DoD bullet maps to at least one case. Rules for money tests and the security checklist: `references/testing-and-security.md`.
2. **AI domain review, mandatory.** Dispatch a fresh subagent (strongest model available) with `prompts/domain-review.md` filled in. Without a subagent tool, open a new chat with no history, paste the prompt and the doc. Record each finding in §5 as *đã sửa* or *không sửa + lý do*. Never skip the review because the change is small.
3. Present **G2** with the review summary (counts by severity, what changed).

## Phase 4: Plan → G3, then implement

**4a.** Fill §6: ordered steps, each naming files, the test written first and the command that proves it; the order migration → service → controller/DTO/OpenAPI → audit and outbox in the same transaction. Present **G3**. No production code before G3.

**4b. Implement, test first, for every behaviour.** Write the failing test, run it, confirm it fails for the right reason, write the least code to pass, run it green, tidy. A bugfix starts with a test that reproduces the bug. Code written before its test is deleted and rewritten from the test. Money tests run on real PostgreSQL (Testcontainers), never a mock. Non-negotiables: CONTRIBUTING §5 and §5b. Commit after each green step: `type(module): imperative`, with the attribution line required by your environment. Never `--no-verify`, never commit to `main`, never commit secrets.

## Phase 5: Docs, evidence → G4

1. **Verify now:** from `backend/`, `npm run lint:check && npm run typecheck && npm test && npm run test:e2e`, plus the task's own tests. Read the whole output; report counts. Not run (Docker down) is reported as not run.
2. **Screenshots, required for every task,** in `docs/features/screenshots/DBS-<n>/`, named `NN-what.png`: for an endpoint, Swagger UI (`http://localhost:3000/docs`) after "Try it out" showing request and response; for infra, the console or `terraform plan`; for a job or consumer, the log line or table row it produced. With a browser tool, take them yourself; without one, list the exact shots and ask the human at G4 to drop them into the folder. Paste test output as text in §7, not as an image.
3. Fill §7 (results, case table "đạt / đơn giản hóa + lý do / chưa làm + lý do", screenshots embedded with relative links) and §8 (docs changed). Update every doc whose fact changed; set the doc status to *Implemented*; add or update the task's row in the list of `docs/features/README.md`. Run `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` and fix what it reports.
4. Present **G4**. After approval: push the branch, open the PR from the template (task key, DoD/AC table, link to the feature doc), and ask the human to move the board row to "In Review". The agent never edits the sheet and never merges.

## Baseline commands

| Kind | Baseline |
|---|---|
| Backend code | `docker compose up -d`, then the four commands above |
| Terraform / CI | `terraform fmt -check && terraform validate`; `terraform plan` shown at G3, `apply` only with the human's go-ahead in this conversation |
| Docs only | link check script |

## Red flags

| Thought | Reality |
|---|---|
| "The user said code thẳng / khỏi hỏi / push luôn" | Earlier instructions never pass a gate. Stop at each one. |
| "It's a one-line fix, no doc needed" | The doc for a bug is short (cause, test, fix), not skipped. |
| "No stop points needed for this fix" | Four gates, every task. |
| "The change is too small for a domain review" | Small money changes are where review pays. |
| "I'll write the doc after the code" | Then it describes whatever got built. §1–§4 come first. |
| "I can't open the sheet" | Run `fetch-task.mjs`; if it fails, ask the human to paste the row. Never guess the DoD. |
| "I'll update the board status myself" | Ask the human. |
| "Screenshots don't apply to a backend" | Swagger, logs, plan output. Ask the human if you cannot capture. |
