# Docs style (Phase 5)

Rules for every doc you create or update at handover.

- **Current state, not history.** A doc states what the system does now. No "verified on <date>", "as of <date>", "fixed in <ticket>" in reference docs. Verify a behaviour by running it, then write the result as plain fact. A backlog or limitation that is now resolved is deleted, not struck through.
- **Status line.** Every doc keeps its `Status` line (`Draft | Accepted | Implemented`, owner, verified against code or not); a feature doc uses `Draft | Design approved | Plan approved | Implemented`. Set "Verified against code" only for what you actually compared with the code.
- **One truth, one place.** Change the source (docs/03, `database-design.md`, `event-contract.md`, an ADR), and link to it from elsewhere. A decision that reverses an Accepted ADR is a new ADR, not an edit.
- **Mermaid must render.** Check every diagram you add or touch on mermaid.live or with mermaid-cli. The mistakes that recur: a `;` in a sequence-diagram message or note, a literal `<` or `>` or an HTML entity in a condition label, a message line without an arrow, a message split over several lines, two keys on one `erDiagram` attribute without a comma.
- **Links.** Run `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs`; it checks relative links, heading anchors and images. A link written inside backticks is not checked: use a real Markdown link for any file the reader must find.
- **Feature index.** Add or update the task's row in `docs/features/README.md`.
