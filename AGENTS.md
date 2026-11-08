
## Task delivery skill (mandatory)

The delivery skill lives only under `.claude/skills/dbs-delivering-task/`.
Codex does not load it automatically (there is no `.agents/skills/`
copy), so you must read it yourself.

Before changing **any** file in this repo (code, test, migration,
Terraform, CI, docs), including a one-line change or an urgent
hotfix, and for every request that names a task such as
`implement DBS-20`:

1. Read `.claude/skills/dbs-delivering-task/SKILL.md` in full, and
   `CLAUDE.md` (project rules, the techlead exception, language).
   Every relative path the skill mentions (`references/`, `prompts/`,
   `templates/`, `scripts/`) resolves inside
   `.claude/skills/dbs-delivering-task/`; read the reference files it
   points to for the kind of task you are doing, and the domain file
   for your role (`references/fraud.md`, `references/platform.md`).
   If the skill file is missing, say so and stop.

2. Follow the skill: five phases and four gates. The gates (G1–G4)
   are self-review gates: run each one against evidence, decide open
   questions yourself, record the decision in the feature doc, and
   continue to the next phase without waiting for a human reply.
   If facts are missing and cannot be obtained, stop the task and
   report the evidence instead of guessing.

3. Retrieve the exact task from the team tracking sheet with
   `node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs DBS-<n>`.
   Read its requirements, acceptance criteria, dependencies,
   assignee, and current status. Never invent ticket details.

4. Inspect the relevant codebase and implement the task according to
   the skill and project conventions, test first, with a real manual
   test.

5. Report changed files, test results, and remaining issues.

6. Commit after each green step as the skill describes. Push and
   open the PR only after G4 passes (a Draft PR earlier only if the
   user asked for one); nothing reaches GitHub before G3. List the
   "chưa chạy" steps and the decisions you made alone in the PR
   description. Never merge, never push to `main`, and never change
   shared sheet or board status; tell the user to move it instead.

Reply to the user and write docs in Vietnamese.
Do not ask the user to specify the skill again.
