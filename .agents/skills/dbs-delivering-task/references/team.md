# Team and how we work

Six people, three board roles: **`Dev`** (four software developers), **`#4 Fraud`**, **`#5 Platform & Ops`**. The board has no Reviewer column. Every Dev does the same job on every task: plan, implement, test, manual test. The goal is output, not an even split of load.

## Working together

- **Nobody waits for anybody.** A task is blocked by a dependency that is not Done: do another task. Set the board Status when you start, so the others can see it.
- There is **no module owner and no fixed pair**. `references/module-notes.md` describes areas (ledger, accounts and identity, async and audit, foundation and data) as *knowledge*: read the notes for the area you touch.
- `node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs --next [Dev|Fraud|Ops]` lists the tasks still To Do whose dependencies are Done, in board order. It is a view of the board, not an assignment, and the board lags the repo: check that nobody is already on a task.

## Rules

- **Every developer tests their own work** (unit, integration, manual test) as part of the task. The concurrency and security suites are separate board tasks: an *additional* adversarial check on money and auth paths, ideally by a Dev who did not write the code under test.
- **Two people in one module:** keep PRs small, rebase often. If your change needs an interface another open task is still building, agree it in an issue first. Never stub a guard, service or interface that an unfinished task is meant to deliver (SKILL.md, Phase 1).
- **PR review:** another Dev reviews (after the AI domain review at G2 has already shaped the design); the author does not merge before someone else has left a review. A team convention, GitHub does not enforce it.
- **The wall:** the Dev who takes the fraud dataset generator tasks holds the generator and the holdout labels; #4 and any agent working for #4 never read the generator code (`references/fraud.md`).
- **Defense questions:** whoever did the related tasks prepares the answer; #4 answers 12, #5 answers 8, 9, 11. Each answer needs an evidence link from a feature doc.
