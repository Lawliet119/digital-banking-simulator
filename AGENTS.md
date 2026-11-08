
## Task delivery: DBS tickets (mandatory)

When the user requests implementation of a task with an ID
matching `DBS-<number>`, such as `implement DBS-20`:

1. Before writing code, locate and read:
   `.claude/skills/dbs-delivering-task/SKILL.md`

2. If not found, check:
   `.claude/commands/dbs-delivering-task.md`
   or search for the skill under `.claude/`.

3. Follow the delivery skill instructions. Its four gates (G1–G4)
   are self-review gates: run each one against evidence, decide
   open questions yourself, record the decision in the feature doc,
   and continue to the next phase without waiting for a human reply.
   If facts are missing and cannot be obtained, stop the task and
   report the evidence instead of guessing.

4. Retrieve the exact task from the team tracking sheet.
   Read its requirements, acceptance criteria, dependencies,
   assignee, and current status. Never invent ticket details.

5. Inspect the relevant codebase and implement the task
   according to the skill and project conventions.

6. Add or update tests and run relevant verification.

7. Report changed files, test results, and remaining issues.

8. Commit after each green step as the skill describes. Push and
   open the PR only after G4 passes (a Draft PR earlier only if the
   user asked for one); nothing reaches GitHub before G3. List the
   "chưa chạy" steps and the decisions you made alone in the PR
   description. Never merge, never push to `main`, and never change
   shared sheet or board status; tell the user to move it instead.

Do not ask the user to specify the skill again.
