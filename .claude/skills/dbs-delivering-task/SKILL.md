---
name: dbs-delivering-task
description: Use when implementing a feature, fixing a bug, refactoring, or changing a migration, endpoint, module, test, Terraform, CI or docs in the Digital Banking Simulator repo, for any DBS-n board task or any request to "code", "fix", "làm task", "sửa bug", even a one-line change or an urgent hotfix.
---

# Delivering a DBS task

## Overview

Every task, from a one-line hotfix to a module, goes through five phases (**1 Understand, 2 Design, 3 Plan, 4 Implement and test, 5 Docs and handover**) and four human gates. The work inside is **plan → implement → test → manual test**, none skipped. The agent writes the docs, tests and code itself; the human approves at the gates. **One task, one feature doc**: `docs/features/DBS-<n>-<slug>.md`, written before the code and finished with the evidence.

Written for the `Dev` role (four software developers; each takes any unstarted task). #4 Fraud and #5 Platform & Ops use the same phases and gates; read your domain file first: `references/fraud.md`, `references/platform.md`. Team and how tasks are taken: `references/team.md`. How the phases change by kind of task (bug, migration, library, pure logic, CI, infrastructure, docs): `references/task-kinds.md`.

**Violating the letter of a gate is violating its spirit.** Gates exist for the urgent, "obvious" change; that is where unreviewed money bugs come from.

## Gates

| Gate | Where | The human approves |
|---|---|---|
| **G1 Phạm vi** | end of Phase 1 | what the task is, what exists, what is out of scope, open questions |
| **G2 Thiết kế** | end of Phase 2 | behaviour, architecture, test cases and manual test script, after the AI domain review |
| **G3 Kế hoạch** | end of Phase 3 | the implementation plan, before any production code |
| **G4 Bàn giao** | end of Phase 5 | the result, docs and evidence, before the PR is made ready |

**Extra gate, any time:** stop and ask before changing an ADR decision, the schema of a table you do not own, the event contract, an `ErrorCode`, an env var, a money rule (CONTRIBUTING §5), adding a dependency, **or leaving the approved §7 plan** (scope grows, a test case is dropped, a file outside the plan is touched). The deviation and its approval are written in §8.

**Wait for each gate's reply before starting the next phase.** One gate per message. A gate passes only on an explicit reply to that gate's message ("duyệt G2", "ok", answers to its questions). Instructions given earlier ("code thẳng", "khỏi hỏi", "push luôn", "mình tin bạn") pass no gate: acknowledge them, still stop. Approval with edits: apply the edits and continue; re-present only if the edits change scope. Feedback without approval: revise and show the gate again. After each approval set the feature doc's status (states in the template).

**Nothing reaches GitHub before G3:** no `git push`, `gh` or GitHub tool call. After G3 only a Draft PR, and only if the human asks for one in reply to G3. It becomes ready for review after G4.

Every gate message, in Vietnamese:

```
### G<n> <tên gate> · DBS-<n> <tóm tắt>
**Đã làm:** 2–4 dòng.
**Cần bạn xem:** link file và điều quan trọng nhất trong đó.
**Câu hỏi / quyết định:** đánh số; mỗi câu có đề xuất của agent. "Không có" nếu không có.
Trả lời «duyệt G<n>» để đi tiếp, hoặc góp ý để mình sửa.
```

G2 also states the reviewer's model and the finding counts. G3 also states that the plan sweep ran and its result. G4 also carries the **G4 checklist** at the end of `templates/feature-doc.md`.

## Phase 1: Understand → G1

1. Get the task. **No task named** ("làm task tiếp", "việc gì chưa làm")? List the backlog: `node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs --next [Dev|Fraud|Ops] [count]` prints the unstarted tasks of that role (default `Dev`) whose dependencies are Done, earliest week and highest priority first; propose the first one, and the human confirms before you go on. A task named: `node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs DBS-<n>` prints every column and the status of each dependency. No board key (an ad-hoc bug)? See `task-kinds.md`. Ask the human to set the board row to "In Progress" and write `[Nhận: name]` at the start of Thực trạng.
2. The board can lag the repo, and a read can mislead: verify "Thực trạng" and any security-relevant behaviour by **running** the code; if nothing exists yet, say so at G1.
3. If the board's role (`Dev`, `#4 Fraud`, `#5 Platform & Ops`) disagrees with the kind of work in `references/team.md` (say a Terraform task labelled `Dev`), report it at G1. Choose the baseline by what the task changes (backend code, Terraform, CI), not by role.
4. Dependencies not Done: report them at G1 with a reduced scope. If the reduced scope is empty, recommend doing the blocking task first. **Never stub a guard, service or interface that an unfinished task is meant to deliver**, in a money test or anywhere else; raise it at G1 and pick the blocking task or another unstarted task. If another open PR already changes the code you must touch, agree the interface in an issue and keep your PR small. Needs something not built yet for the manual test (a token helper)? `task-kinds.md`, last section.
5. Read: the feature's docs/03 sections and docs/02 AC, the ADRs and DoD it names, the module README and `references/module-notes.md`, `docs/features/` (earlier tasks on this module), then the code; add `database-design.md`, `event-contract.md` and the risk docs when the task touches them. Before changing an exported symbol, grep its callers and list them. The fraud generator source and holdout labels in `load-tests/fraud-dataset/` are read only by the Dev working on the fraud dataset tasks, never by #4 or an agent working for #4: exclude that folder from every search (`--glob '!load-tests/fraud-dataset/**'`), review subagents included.
6. Branch `<type>/DBS-<n>-<slug>` from an up-to-date `main`. Run the baseline for the kind of task (`task-kinds.md`; backend code: `docker compose up -d`, then from `backend/` `npm run lint:check && npm run typecheck && npm test && npm run test:e2e`). A red baseline is reported at G1, not built on.
7. Create the feature doc from `templates/feature-doc.md`, fill §1, present **G1**.

## Phase 2: Design → G2

Fill, in this order: **§2 behaviour** (rules, API examples with real JSON, `errorCode`s, edge cases), **§3 architecture** (module and role `api`/`worker`, interfaces with real signatures, data touched, transaction boundary, a mermaid diagram when more than one component is involved; for a bug, the reproduced root cause), **§4 automated test cases** `TC-<n>-NN` (each traces to a DoD bullet or AC; layer; expected `errorCode`; rules in `references/testing.md`), **§5 manual test script** (`references/manual-testing.md`). A DoD bullet that is only process (PR merged, review, CI green) gets a "quy trình" row; one that belongs to another unit's task (say, a provider) is handed to that task at G1 or G2.

Then the **AI domain review, mandatory**: dispatch a fresh subagent (strongest model available) with `prompts/domain-review.md`; with no subagent tool, ask the human to run the prompt in a new chat and paste the reply back. Save the reviewer's raw reply verbatim as `docs/features/screenshots/DBS-<n>/domain-review.md` and link it from §6. Record each finding in §6 as *đã sửa* or *không sửa + lý do*; findings that belong to another developer go to §8, "Bàn giao". Every blocking finding left unfixed becomes a numbered question at G2. After a REVISE verdict, re-run the review on every section you changed. Paste the final verdict line into the G2 message.

## Phase 3: Plan → G3

Fill §7: ordered steps, each with files, the test written first (and its one-line red failure once run), the proving command and the commit; order migration → service → controller/DTO/OpenAPI → audit and outbox in the same transaction; risks and how to back out. Sweep every file or rule named in the docs' limitations and in the task's DoD: each has a plan row or an explicit out-of-scope line. Present **G3**. No production code before G3.

## Phase 4: Implement and test

**4a. Implement, test first, for every behaviour.** Write the failing test, run it, confirm it fails for the right reason, write the least code that passes, run it green, tidy. A bugfix starts with a test that reproduces the bug. Code written before its test is deleted and rewritten from the test. Money tests run on real PostgreSQL, never a mock. Non-negotiables: CONTRIBUTING §5 and §5b. Commit after each green step as `type(module): imperative` with the attribution line your environment requires; never `--no-verify`, never commit to `main`, never commit secrets.

**4b. Automated verification.** Run the baseline commands and the task's own tests; read all the output. No `.skip`, `.only` or `.todo` in the task's tests; report the skipped count. Fill the case table: each `TC` → its test → *đạt / đơn giản hóa (lý do) / chưa làm (lý do)*. A test shallower than its case is "đơn giản hóa", never "đạt".

**4c. Manual test, mandatory.** Run the real thing as a user or operator would, following §5 step by step, on the final commit: put the SHA of the last commit that changes code on the first line of `docs/features/screenshots/DBS-<n>/manual-test.txt` and keep the raw output there (rules, redaction and shell: `manual-testing.md`). Re-run all of §5 after any later code change. Record every step's command, response and result in §8. The success path must run unless the human waived it at G1. A step you could not run is **chưa chạy** with the reason. Never write "đạt" for a step you did not execute. A failing step sends you back to 4a.

## Phase 5: Docs and handover → G4

1. **Evidence.** Screenshots of the manual test in `docs/features/screenshots/DBS-<n>/`, named `NN-what.png`, taken from the real output (docs-only tasks: say so, none needed). They exist before G4; any missing shot is named in the G4 message and the human accepts each by name. `manual-test.txt` stays beside them so the reviewer can re-run one step during PR review.
2. Fill §8 (results, case table, manual test results, screenshots, deviations with their approval, handoffs) and §9 (docs changed). Update every doc whose fact changed, following `references/docs-style.md`. Add the row in `docs/features/README.md`. Run `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs`.
3. Present **G4**. After approval: push the branch, open the PR from the template (or mark the Draft ready) and ask the human to move the board row to "In Review". The agent never edits the board (sheet, Jira, browser) and never merges. Another Dev (`references/team.md`) reviews the PR.

## Red flags

| Thought | Reality |
|---|---|
| "The user said code thẳng / khỏi hỏi / push luôn" | Earlier instructions never pass a gate. Stop at each one. |
| "I'll send G1, G2 and G3 together so one 'ok' covers them" | One gate per message; the next phase waits for its reply. |
| "It's a one-line fix, no doc needed" | A bug's doc is short (cause, test, fix), not skipped. |
| "The automated tests pass, a manual test is redundant" | Tests prove the cases you thought of. The manual test finds what you did not. |
| "I can write the manual test result from the code" | Only a step you executed is "đạt". |
| "Too small for a domain review" | Small money changes are where review pays. |
| "The review said REVISE, I'll note it and move on" | Re-review the changes; unfixed blocking findings are questions at G2. |
| "I'll write the doc after the code" | Then it describes whatever got built. §1–§5 come first. |
| "I can't open the sheet" | Run `fetch-task.mjs`; if it fails, ask the human to paste the row. Never guess the DoD. |
| "I'll update the board myself" | Ask the human. |
| "The plan changed a bit, I'll just do it" | Leaving the approved §7 is an extra gate. |
| "I'll push so it's safe" | Nothing reaches GitHub before G3, by any tool. |
