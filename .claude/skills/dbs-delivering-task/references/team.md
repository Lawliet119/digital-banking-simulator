# Team and how tasks are taken

Six people, three board roles: **`Dev`** (four software developers), **`#4 Fraud`**, **`#5 Platform & Ops`**. The Reviewer column says `Dev`. Every Dev does the same job on every task: plan, implement, test, manual test. The goal is output, not an even split of load.

## Taking a task (pull model)

- Any Dev takes **any `Dev` task that nobody has started and whose dependencies are Done**. Write `[Nhận: name]` at the start of its Thực trạng cell and move it to In Progress; that is the claim.
- To find a task: `node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs --next` lists the unstarted `Dev` tasks whose dependencies are Done, already in board order (`--next Fraud` and `--next Ops` for the other roles). The board lags: a task someone has already started but not claimed shows up too, so ask in the group before taking the first one.
- Work **in board order**: earliest week first, `High` before the rest, then the lower key. Nobody waits for anybody: if a task is blocked, take another unstarted one.
- `#4 Fraud` tasks and `#5 Platform & Ops` tasks are taken by those two people. If one falls behind, ask the group; do not silently take it.
- There is **no module owner and no fixed pair**. `references/module-notes.md` and the playbook list areas (ledger, accounts and identity, async and audit, foundation and data) as *knowledge*: read the notes for the area you touch.

## Rules

- **Every developer tests their own work** (unit, integration, manual test) as part of the task. The concurrency and security suites are separate board tasks: an *additional* adversarial check on money and auth paths, taken by a Dev who did not write the code under test when that is possible.
- **Two people in one module:** keep PRs small, rebase often. If your change needs an interface another open task is still building, agree it in an issue first. Never stub a guard, service or interface that an unfinished task is meant to deliver (SKILL.md, Phase 1).
- **Review:** any Dev other than the author, whoever is free first, reviews the PR (after the AI domain review at G2 has already shaped the design). The author does not merge before someone else has left a review. This is a team convention; GitHub does not enforce it. Terraform, CI and risk code are reviewed by a Dev too.
- **The wall:** the Dev who takes the fraud dataset generator tasks holds the generator and the holdout labels; #4 and any agent working for #4 never read the generator code (`references/fraud.md`).
- **Defense questions:** whoever did the related tasks prepares the answer; #4 answers 12, #5 answers 8, 9, 11. Each answer needs an evidence link from a feature doc.
