# DBS-146 · Domain review vòng 4 (trả lời nguyên văn của subagent, model opus, effort medium, 2026-11-15)

| # | Severity | Section | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| 1 | should-fix | §6 header line (round 2) | The link `[nguyên văn](screenshots/DBS-146/domain-review-round2.md)` is now broken, because that file was moved into the sealed folder and `docs/features/screenshots/DBS-146/` only contains `domain-review.md`. As written, M-146-07 and DoD 4 («0 liên kết hỏng», `check-doc-links.mjs`) will fail. | `ls docs/features/screenshots/DBS-146/` → only `domain-review.md`; doc §6 line 148 | Point the link at the pointer file `screenshots/DBS-146/domain-review.md`, or remove it. Also add a round-3 line pointing to the pointer file. |
| 2 | minor | §6 row 3.2, §2.C line 82 | Some mechanism-adjacent detail is still public: «lift ≈ 45 và ≈ 52, độ phủ ≥ 0,87» together with M-146-01 «tell ở nhãn `FRAUD` về thuộc tính ngày của tài khoản», and «dòng nền NORMAL dùng chung thuộc tính». This mostly describes the generator before the fix, which will not be shipped, so the harm is small. It still contradicts the banner («không ghi … số liệu theo kịch bản / phân phối»). | FRAUD guide §6.2 row 2; banner line 5 | Replace with «đã đo, đủ lift; số ở `AUDIT-NOTES.md`». Drop the «dùng chung thuộc tính» clause. |
| 3 | minor | §3 «BL mới cho hạn chế mô phỏng» | `docs/BACKLOG.md` is public too. The new BL entry must follow the same rule as the report (type, count and sealed link only, no description of the pattern). The doc does not say this, and round-1 #15 suggested wording that did describe the mechanism. | `docs/BACKLOG.md` (public, e.g. BL-173 describes generator scale); doc §2.C line 52 | Add one sentence: the BL text is mechanism-free and points to `AUDIT-NOTES.md`. |
| 4 | minor | §2 seed file rule | A UTF-8 BOM (U+FEFF, Unicode category Cf, not a control character) from a Windows editor would be accepted silently as part of the seed. That gives a different seed, an unexplained exit 1 on `--tune-csv`, or a different tune. Also «một ký tự xuống dòng (`\n` hoặc `\r\n`)»: `\r\n` is two characters. | doc §2 line 24; TC-146-10 | Reject a leading BOM (or any Cf/Zs at the edges) and add a TC case. Reword to «một dấu xuống dòng». |

Checked against the sources:
- 3.1: the public doc no longer defines C3 or the single-recipient pattern, and the pointer file contains no mechanism (I read it in full).
- 3.3: the intrinsic table is now fixed.
- 3.5: the §2.D argument is acceptable. It stays within §6.1 («Luật nên bắt» measures recall on the targeted scenario), mandatory `dod2Notes` makes the report state every such pair, and the doc forbids P5 from presenting them as general capability.
- 3.6: `m2 = 2·whole + (".5"?1:0)` in BigInt matches `feature-projection.ts` lines 134–135.
- 3.7:
  - R3 `accountAgeHours < 24`: the value is `Number(ageNs)/Number(HOUR_NS)`, exact enough near 24 h because ns ≪ 2^53. The cap at 720 and negative age → 0 match R3.
  - R6 in BigInt on export's `fromBalanceBefore`/`sameOwner` is exact.
  - R1, R4 and R5 mappings are correct.
- 3.4: the trailing-newline rule plus the hand-off of `split.mjs` to BL-171 are OK.

Not checked: whether `split.mjs` really exports or contains `canonical`/`insideCheckout` (it is in the sealed folder). DBS-127 §2 describes the same behaviour (realpath of parent, refuse inside checkout or an existing target).

Once #1 is fixed, nothing blocking or should-fix remains, so it can go to APPROVE without another round.

Verdict: REVISE
