
## Task delivery: DBS tickets (mandatory)

When the user requests implementation of a task with an ID
matching `DBS-<number>`, such as `implement DBS-20`:

1. Before writing code, locate and read:
   `.claude/skills/dbs-delivering-task/SKILL.md`

2. If not found, check:
   `.claude/commands/dbs-delivering-task.md`
   or search for the skill under `.claude/`.

3. Follow the delivery skill instructions.

4. Retrieve the exact task from the team tracking sheet.
   Read its requirements, acceptance criteria, dependencies,
   assignee, and current status. Never invent ticket details.

5. Inspect the relevant codebase and implement the task
   according to the skill and project conventions.

6. Add or update tests and run relevant verification.

7. Report changed files, test results, and remaining issues.

8. Do not automatically commit, push, create PRs, or change
   shared sheet status without authorization.

Do not ask the user to specify the skill again.
