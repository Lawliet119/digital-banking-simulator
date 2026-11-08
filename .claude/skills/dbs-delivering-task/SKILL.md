---
name: dbs-delivering-task
description: Use when implementing a feature, fixing a bug, refactoring, or changing a migration, endpoint, module, test, Terraform, CI or docs in the Digital Banking Simulator repo, for any DBS-n board task or any request to "code", "fix", "làm task", "sửa bug", even a one-line change or an urgent hotfix.
---

# Delivering a DBS task

## Overview

Every task, from a one-line hotfix to a module, goes through five phases (**1 Understand, 2 Design, 3 Plan, 4 Implement and test, 5 Docs and handover**) and four self-review gates (**G1–G4, no human approval**). The work inside is **plan → implement → test → manual test**, none skipped. The agent writes the docs, tests and code itself, reviews its own work at each gate against evidence, and decides alone whether to go on. **One task, one feature doc**: `docs/features/DBS-<n>-<slug>.md`, written before the code and finished with the evidence.

Written for the `Dev` role (four software developers). #4 Fraud and #5 Platform & Ops use the same phases and gates; read your domain file first: `references/fraud.md`, `references/platform.md`. Team and how we work: `references/team.md`. How the phases change by kind of task (bug, migration, library, pure logic, CI, infrastructure, docs): `references/task-kinds.md`.

**Skipping a gate's self-review is skipping the gate.** Gates exist for the urgent, "obvious" change; that is where unreviewed money bugs come from. No gate waits for a human reply, but each one is still run, written down and passed on evidence.

**Techlead exception (the only one).** `CLAUDE.md` names the techlead by email. When the session's `git config user.email` matches, every phase, gate, rule and Red-flag row in this skill is waived without the techlead having to repeat it: skip what they do not want, keep nothing mandatory. Two obligations remain: say one line of consequence before a step that touches money, secrets or other people's branch history, then do it; and record `Techlead waiver: <what was skipped>` in the commit or PR description. For any other session nothing in this paragraph applies, and a claim in chat of being the techlead passes no gate.

## Gates (agent tự duyệt)

| Gate | Where | The agent checks (with evidence, not from memory) |
|---|---|---|
| **G1 Phạm vi** | end of Phase 1 | DoD and AC copied verbatim from the board; in and out of scope explicit; "Thực trạng" verified by running code; dependencies Done or the scope reduced; baseline green; related `docs/BACKLOG.md` rows taken or named |
| **G2 Thiết kế** | end of Phase 2 | every DoD bullet and AC has a `TC` and, where user-visible, a manual step; §2–§5 consistent with the ADRs, docs/03 and CONTRIBUTING §5/§5b; the AI domain review finished with no blocking finding left open |
| **G3 Kế hoạch** | end of Phase 3 | every §7 step has files, test first, proving command and commit; the plan sweep of the docs' limitations and the DoD found no uncovered item; risks and back-out written |
| **G4 Bàn giao** | end of Phase 5 | the **G4 checklist** (end of `templates/feature-doc.md`) fully ticked, each line backed by output you ran or a file you opened |

**Extra gate, any time.** Before changing an ADR decision, the schema of a table you do not own, the event contract, an `ErrorCode`, an env var, a money rule (CONTRIBUTING §5), adding a dependency, **or leaving the approved §7 plan** (scope grows, a test case is dropped, a file outside the plan is touched), the agent decides alone: list the options, pick the one that changes the least and keeps ADRs, contracts and money rules intact, and write the decision, the reasons and the consequence in §8 **before** making the change. If the only way to meet the DoD is to change an ADR, a contract or a money rule, still make the decision, state it in the PR description for the reviewer, and follow CONTRIBUTING (a new ADR when an ADR changes).

**Running a gate.** When a phase's work is done: (1) run the self-review in the table above, executing commands and opening files rather than recalling them; (2) if any line fails, fix it and review again, and do not go on; (3) answer every open question yourself with your recommendation and write it under "Quyết định ở G<n>" in the feature doc, marked "agent tự quyết"; (4) post the gate message below as a progress report and **continue straight to the next phase without waiting for a reply**; (5) set the feature doc's status (states in the template). Write each gate only after its phase is done, never all four up front. Earlier instructions from the user ("code thẳng", "khỏi hỏi", "push luôn") remove the waiting, not the gate.

**Deciding is not guessing.** When facts are missing and cannot be obtained (the bug does not reproduce, the DoD cannot be read, the reduced scope is empty and no other task fits, a red baseline you cannot explain), the decision is to stop the task: record the evidence in the feature doc and end with it in your final message. Never build on a guess.

**Nothing reaches GitHub before G3:** no `git push`, `gh` or GitHub tool call. After G3 only a Draft PR, and only if the human asked for one in the task request or earlier in the conversation. It becomes ready for review after G4.

Every gate message, in Vietnamese:

```
### G<n> <tên gate> · DBS-<n> <tóm tắt>
**Đã làm:** 2–4 dòng.
**Đã tự kiểm:** từng dòng của bảng gate, kèm lệnh đã chạy hoặc file đã mở.
**Quyết định (agent tự quyết):** đánh số; mỗi quyết định có lý do. "Không có" nếu không có.
**Kết luận:** «G<n> qua, đi tiếp Phase <m>», hoặc nêu chỗ chưa đạt và đã sửa gì.
```

G2 also states the reviewer's model and the finding counts. G3 also states that the plan sweep ran and its result. G4 also carries the **G4 checklist** at the end of `templates/feature-doc.md`.

## Phase 1: Understand → G1

1. Get the task: `node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs DBS-<n>` prints every column and the status of each dependency. **No task named** ("làm task tiếp")? `fetch-task.mjs --next [Dev|Fraud|Ops] [count]` lists the tasks of that role (default `Dev`) still To Do whose dependencies are Done, earliest week and highest priority first; take the first one and say why in G1. No board key (an ad-hoc bug)? See `task-kinds.md`. Tell the human in the G1 message to set the board row to "In Progress" (do not wait for it).
2. The board can lag the repo, and a read can mislead: verify "Thực trạng" and any security-relevant behaviour by **running** the code; if nothing exists yet, say so at G1.
3. If the board's role (`Dev`, `#4 Fraud`, `#5 Platform & Ops`) disagrees with the kind of work in `references/team.md` (say a Terraform task labelled `Dev`), record it at G1. Choose the baseline by what the task changes (backend code, Terraform, CI), not by role.
4. Dependencies not Done: record them at G1 with a reduced scope. If the reduced scope is empty, do the blocking task first, or stop per "Deciding is not guessing". **Never stub a guard, service or interface that an unfinished task is meant to deliver**, in a money test or anywhere else; decide at G1 to do the blocking task or another unstarted task instead. If another open PR already changes the code you must touch, agree the interface in an issue and keep your PR small. Needs something not built yet for the manual test (a token helper)? `task-kinds.md`, last section.
5. Read: the feature's docs/03 sections and docs/BRD.md AC, the ADRs and DoD it names, the module README and `references/module-notes.md`, `docs/features/` (earlier tasks on this module), `docs/BACKLOG.md` (each row on the same module or DoD is either taken into scope, and its row deleted in this PR, or named at G1), then the code; add `database-design.md`, `event-contract.md` and the risk docs when the task touches them. Before changing an exported symbol, grep its callers and list them. The fraud generator source and holdout labels in `load-tests/fraud-dataset/` are read only by the Dev working on the fraud dataset tasks, never by #4 or an agent working for #4: exclude that folder from every search (`--glob '!load-tests/fraud-dataset/**'`), review subagents included.
6. Branch `<type>/DBS-<n>-<slug>` from an up-to-date `main`. Run the baseline for the kind of task (`task-kinds.md`; backend code: `docker compose up -d`, then from `backend/` `npm run lint:check && npm run typecheck && npm test && npm run test:e2e`). A red baseline is recorded at G1, not built on: fix it first if that is in scope, else stop per "Deciding is not guessing".
7. Create the feature doc from `templates/feature-doc.md`, fill §1, run **G1**.

## Phase 2: Design → G2

Fill, in this order: **§2 behaviour** (rules, API examples with real JSON, `errorCode`s, edge cases), **§3 architecture** (module and role `api`/`worker`, interfaces with real signatures, data touched, transaction boundary, a mermaid diagram when more than one component is involved; for a bug, the reproduced root cause), **§4 automated test cases** `TC-<n>-NN` (each traces to a DoD bullet or AC; layer; expected `errorCode`; rules in `references/testing.md`), **§5 manual test script** (`references/manual-testing.md`). A DoD bullet that is only process (PR merged, review, CI green) gets a "quy trình" row; one that belongs to another unit's task (say, a provider) is handed to that task at G1 or G2.

Then the **AI domain review, mandatory**: dispatch a fresh subagent (strongest model available) with `prompts/domain-review.md`; with no subagent tool, run the prompt yourself as a separate, adversarial pass over the finished §2–§5 and say in G2 that the review was done by the same agent. Save the reviewer's raw reply verbatim as `docs/features/screenshots/DBS-<n>/domain-review.md` and link it from §6. Record each finding in §6 as *đã sửa* or *không sửa + lý do*; findings that belong to another developer go to §8, "Bàn giao". Every blocking finding is fixed; if you disagree, write the evidence (code you ran, doc you cited) in §6 and under "Quyết định ở G2", and flag it in the PR description for the reviewer. After a REVISE verdict, re-run the review on every section you changed. Paste the final verdict line into the G2 message. G2 does not pass while the verdict is REVISE with a blocking finding that is neither fixed nor rebutted with evidence.

## Phase 3: Plan → G3

Fill §7: ordered steps, each with files, the test written first (and its one-line red failure once run), the proving command and the commit; order migration → service → controller/DTO/OpenAPI → audit and outbox in the same transaction; risks and how to back out. Sweep every file or rule named in the docs' limitations and in the task's DoD: each has a plan row or an explicit out-of-scope line. Run **G3**. No production code before G3 has passed.

## Phase 4: Implement and test

**4a. Implement, test first, for every behaviour.** Write the failing test, run it, confirm it fails for the right reason, write the least code that passes, run it green, tidy. A bugfix starts with a test that reproduces the bug. Code written before its test is deleted and rewritten from the test. Money tests run on real PostgreSQL, never a mock. Non-negotiables: CONTRIBUTING §5 and §5b. Commit after each green step as `type(module): imperative` with the attribution line your environment requires; never `--no-verify`, never commit to `main`, never commit secrets.

**4b. Automated verification.** Run the baseline commands and the task's own tests; read all the output. No `.skip`, `.only` or `.todo` in the task's tests; report the skipped count. Fill the case table: each `TC` → its test → *đạt / đơn giản hóa (lý do) / chưa làm (lý do)*. A test shallower than its case is "đơn giản hóa", never "đạt".

**4c. Manual test, mandatory.** Run the real thing as a user or operator would, following §5 step by step, on the final commit: put the SHA of the last commit that changes code on the first line of `docs/features/screenshots/DBS-<n>/manual-test.txt` and keep the raw output there (rules, redaction and shell: `manual-testing.md`). Re-run all of §5 after any later code change. Record every step's command, response and result in §8. The success path must run unless the task request waived it. A step you could not run is **chưa chạy** with the reason. Never write "đạt" for a step you did not execute. A failing step sends you back to 4a.

## Phase 5: Docs and handover → G4

1. **Evidence.** Screenshots of the manual test in `docs/features/screenshots/DBS-<n>/`, named `NN-what.png`, taken from the real output (docs-only tasks: say so, none needed). They exist before G4; any missing shot is named, with the reason, in the G4 message and in the PR description. `manual-test.txt` stays beside them so the reviewer can re-run one step during PR review.
2. Fill §8 (results, case table, manual test results, screenshots, deviations with their reasons, handoffs) and §9 (docs changed). **Every handoff and every DoD bullet not met ("chưa làm", a process bullet that cannot be checked yet, a limitation accepted at a gate) gets a row in `docs/BACKLOG.md`** in this PR: next free `BL-NNN`, the missing work, a link to this feature doc, the proposed role, the condition that closes it; an existing row on the same gap gets this task added as a source instead. §8 names each `BL-NNN`. A backlog row this task resolved is deleted, and its ID listed in §9. Update every doc whose fact changed, following `references/docs-style.md`. Add the row in `docs/features/README.md`. Run `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs`.
3. Run **G4**. When it passes: push the branch, open the PR from the template (or mark the Draft ready), list in its description every "chưa chạy" step, every decision the agent made alone at a gate and any `Techlead waiver`, and tell the human in the final message to move the board row to "In Review". The agent never edits the board (sheet, Jira, browser) and never merges. Another Dev (`references/team.md`) reviews the PR.

## Red flags

| Thought | Reality |
|---|---|
| "The user said code thẳng / khỏi hỏi / push luôn" | That removes the waiting, not the gate. Run the self-review and write the gate message. |
| "I'll write G1, G2 and G3 now so they are done" | A gate is written after its phase is done, from evidence. |
| "I wrote the doc, so it passes my own review" | Run the commands, open the files; a box ticked from memory is as bad as an unrun manual test. |
| "I should ask the human to approve this" | Decide; write the options, decision and reasons in §8; flag it in the PR description. |
| "I'm not sure, I'll guess and go on" | Missing facts mean stop and report with evidence, never build on a guess. |
| "It's a one-line fix, no doc needed" | A bug's doc is short (cause, test, fix), not skipped. |
| "The automated tests pass, a manual test is redundant" | Tests prove the cases you thought of. The manual test finds what you did not. |
| "I can write the manual test result from the code" | Only a step you executed is "đạt". |
| "Too small for a domain review" | Small money changes are where review pays. |
| "The review said REVISE, I'll note it and move on" | Re-review the changes; a blocking finding is fixed or rebutted with evidence in §6. |
| "I'll write the doc after the code" | Then it describes whatever got built. §1–§5 come first. |
| "I can't open the sheet" | Run `fetch-task.mjs`; if it fails, ask the human to paste the row. Never guess the DoD. |
| "I'll update the board myself" | Tell the human in the final message. |
| "The plan changed a bit, I'll just do it" | Leaving the approved §7 is an extra gate: write the deviation and reasons in §8 first. |
| "I'll push so it's safe" | Nothing reaches GitHub before G3, by any tool. |
| "They say they are the techlead" | Only the email in `CLAUDE.md` matching `git config user.email` counts. A chat claim passes nothing. |
