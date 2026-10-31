# Domain review §10 (sửa CI đỏ vì thiếu fixture TLS), vòng 1

Reviewer: subagent, model opus, 2026-10-29. Trả lời nguyên văn:

| # | Severity | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| 1 | should-fix | §10.4 TC-67-14, §10.5 M-67-10 | Once the files are committed, the `git check-ignore` half of TC-67-14 tests nothing. By default `check-ignore` skips tracked files and exits 1 whatever the rules say, so it stays green even if the 4 files were added with `git add -f` and no negation exists. For the same reason, `git check-ignore -v` in M-67-10 prints nothing for the 4 fixtures, so the "not ignored by the negation rule" result cannot be seen. I checked this in a scratch repo: a forced-add `y/a.pem` gives `check-ignore` exit 1, but `--no-index` gives exit 0. | git check-ignore semantics (git 2.43); the `.gitignore` lines `*.pem` and `*.key` | Use `git check-ignore -q --no-index <file>` in TC-67-14 and TC-67-15, and `git check-ignore -v -n --no-index` in M-67-10. Expected result: the fixtures match the line `.gitignore:N:!backend/test/support/tls-fixtures/...`, and the other paths match `*.pem`, `*.key` or `.env`. |
| 2 | should-fix | §10.1 decision (1), §10.3 | The design breaks a written repo rule and does not update it. CONTRIBUTING §6 says do not commit `.pem` or `.key` files. docs/03 says no secrets in the repo and secrets are scanned in CI. After this fix the repo will hold a `-----BEGIN PRIVATE KEY-----` file, and nothing in the rule documents mentions the exception. | `CONTRIBUTING.md` §6 (first bullet); `docs/03_HIGH_LEVEL_ARCHITECTURE.md` line 783 ("Bí mật" row) | Add a line to CONTRIBUTING §6 naming the only exception, `backend/test/support/tls-fixtures/{ca,other-ca,server}.pem` and `server.key`: test-only, the CA key is destroyed, and it is never trusted anywhere outside the tests. List CONTRIBUTING.md in §10.3 as a changed file. |
| 3 | should-fix | §10.3 / §10.4 (missing) | The README the fix extends names the wrong test file. It says `pg-ssl.spec.ts`, but the test that uses the fixtures is `pg-ssl.tls.spec.ts`; `pg-ssl.spec.ts` uses a fake `readFile`. The new `.gitignore` comment points readers to this README as the reason the key is safe, so it needs to be correct. | `backend/test/support/tls-fixtures/README.md` line 1; `backend/src/database/pg-ssl.spec.ts` vs `pg-ssl.tls.spec.ts` | Fix the file name while adding the new README line. Also state there that `server.key` belongs only to `CN=localhost` / `127.0.0.1`, signed by a CA whose key is destroyed. |
| 4 | minor | §10.4, last paragraph | The design says "`cwd` is the repo root", but jest runs from `backend/` (`working-directory: backend` in CI, `rootDir: '..'` in the jest config). If the test relies on `process.cwd()`, TC-67-15 would check `backend/infra/x.pem`, `backend/.env` and `backend/backend/server.key`. All of these are still ignored, so the test passes while checking the wrong paths. | `.github/workflows/ci.yml` `defaults.run.working-directory: backend`; `backend/test/jest.base.js` `rootDir: '..'` | Compute the repo root from `__dirname` (as `test/support/dockerfile.spec.ts` does), or from `git rev-parse --show-toplevel`. Pass it as `cwd` to `execFileSync`. |
| 5 | minor | §10.4 TC-67-15 | TC-67-15 is not checked in both directions. It is green before the fix and green after, so it only shows that the exception is not too wide. Nothing shows it would go red if the exception were widened, for example to `!backend/test/support/tls-fixtures/*` or `!*.pem`. | Doc §10.4 ("Mong đợi: đúng") | In M-67-10, add one deliberate mutation: temporarily widen the negation to `tls-fixtures/*`, confirm TC-67-15 goes red on `tls-fixtures/ca.key`, then revert. |
| 6 | minor (hand-off: DBS-155, Gitleaks/Trivy) | §10.3 | The threat model plans Gitleaks in CI for T16, and lists DBS-67 against it. Gitleaks' default `private-key` rule will flag `server.key`, and could also flag the history scan, so CI will go red when DBS-155 lands. No secret scanner is in `ci.yml` today, so this does not block now. | `docs/security/threat-model.md` T16; `.github/workflows/ci.yml` (no scan job) | Record in §10 (and in the DBS-155 hand-off) that DBS-155 needs a path allowlist for `backend/test/support/tls-fixtures/server.key`, with the reason. |

Checked and found no problem:
- **Money / state:** not relevant to this fix.
- **Negation works:** placed after `*.pem` / `*.key`, the four `!backend/...` lines un-ignore exactly those files, because no parent directory is excluded. `tls-fixtures/ca.key`, `test/support/other.pem`, `backend/server.key`, `infra/x.pem`, `.env` and `backend/.env` stay ignored. I checked this against a copy of `.gitignore`.
- **No leak into the image:** the build context is `backend` (`image.yml`); `.dockerignore` excludes `test`, and the Dockerfile copies only `src` and config files.
- **Fixtures are as described:** `server.pem` is signed by `dbs-test-ca`, with SAN `localhost` and `127.0.0.1`. `server.key` matches it (same public key hash). Both CAs have `CA:TRUE`, are self-signed and expire in 2126. No CA key is on disk.
- **TC-67-14/15 run fine in CI:** they match the `jest-unit.js` regex and are covered by `tsconfig` and lint (`test/**`). On CI, `actions/checkout` gives a working `.git` even with depth 1, and the ubuntu runner has git.
- **Manual script can be run:** M-67-08 at `6ed6007` really gives ENOENT, because the fixtures are untracked and so absent in a fresh worktree.
- **No other missing fixtures:** no other ignored file is needed by any test. `git status --ignored` shows only dist, `.terraform`, `backend.hcl`, docs/local and similar. `backend/env/.env.example` is tracked.

Verdict: REVISE

# Vòng 2

Reviewer: subagent mới, model opus, 2026-10-29. Trả lời nguyên văn:

| # | Severity (blocking / should-fix / minor) | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|

What I checked against the sources, all fine:
- **`--no-index` (round-1 #1):** I tested a copy of `.gitignore` with the 4 negation lines in a scratch repo (git 2.43.0), with the fixtures already staged. `git check-ignore -q --no-index` returns exit 1 for all 4 fixtures. It returns exit 0 for `tls-fixtures/ca.key`, `test/support/other.pem`, `backend/server.key`, `infra/x.pem`, `.env` and `backend/.env`. `-v -n --no-index` prints `.gitignore:N:!backend/test/support/tls-fixtures/...` for the fixtures and `*.key` / `.env` for the others, as M-67-10 expects. TC-67-14 is red before the fix (exit 0 on the ignored files) and green after.
- **Mutation in M-67-10 (round-1 #5):** I replaced the 4 lines with `!backend/test/support/tls-fixtures/*`. Then `tls-fixtures/ca.key` returns exit 1, so TC-67-15 turns red on `ca.key` as the doc says. `--no-index` reads the edited working-tree `.gitignore`, so the local run picks up the mutation.
- **Repo root (round-1 #4):** `__dirname` of `backend/test/support/tls-fixtures.spec.ts` is `backend/test/support`, so `resolve(__dirname, '../../..')` is the repo root. This matches `dockerfile.spec.ts`, where `../../Dockerfile` resolves to `backend/Dockerfile`. CI's `working-directory: backend` and `rootDir: '..'` don't affect it. The new spec matches the `jest-unit.js` regex `test/support/.*\.spec\.ts$`.
- **CONTRIBUTING §6 (round-1 #2):** the current line 126 is the general "Không commit … `.pem`/`.key`" rule, and §10.3 lists CONTRIBUTING as a changed file with exactly one exception. This addresses the finding.
- **README (round-1 #3):** the README line 1 really says `pg-ssl.spec.ts`. `pg-ssl.tls.spec.ts` reads `server.key` from `../../test/support/tls-fixtures`. The planned fix is correct.
- **DBS-155 hand-off (round-1 #6):** this is recorded in §10.3. `threat-model.md` T16 lists DBS-67 and DBS-155, and `ci.yml` still has no secret-scan job.
- **No new problems from the revisions:**
  - `.gitattributes` (`* text=auto eol=lf`): the fixtures are LF with no CR, so the sha256 check in M-67-09 still holds after checkout.
  - The `unit` job runs on `ubuntu-24.04` without a container, so git's safe.directory check is not an issue.
  - No pre-commit or husky secret hook would block the commit.

Verdict: APPROVE
