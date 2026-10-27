| # | Severity | Section of the doc | Finding | Evidence | Suggested fix |
|---|---|---|---|---|---|
| 1 | minor | §2.7 item 8, §1.6 item 5, §3.7 mapping table, TC-17 (iii) | The rule "số cũ luôn kèm hậu tố «cũ»" is not literally true. The "Cũ" column cells of the §3.7 table (BL-023 to BL-031) have no suffix. §1.6 item 5 cites "BL-023–026 trên main" for DBS-42, which is correct and is not an old PR number. TC-17 (iii) says "không còn BL-023–026 ngoài dòng DBS-42". A literal run of its grep would also flag the table cells and §1.6 item 5. Clause (i) already exempts those places by location. | Lines 63, 233–245 and 337 of the feature doc. | Reword the rule to "kèm «cũ» hoặc nằm trong cột «Cũ» của bảng §3.7". Add §1.6 item 5 and the §3.7 table to the exemptions in TC-17 (iii). |
| 2 | minor | §2.7 item 7(b) | "Dữ liệu bị sửa ngoài luồng" is not a realistic cause. `risk_rule_sets` is designed append-only, with `forbid_mutation` triggers (BL-021). Only the "version tạo trước khi có kiểm tra" case can occur. This does not affect the design. | `docs/components/_shared/database-design.md` §8.3 and the migration order. | Drop the out-of-band clause, or say it covers a DBA bypass of the triggers. |
| 3 | minor | TC-13 (state of the check) | Run on the stated scope, the grep still returns 3 hits: `docs/adr/0014-…` line 32, feature doc §2.1 (line 75) and §3.4 (line 184). They all say "public beta". The §2.3 ZDR sentence is fixed and no longer matches. This is expected because C4 does this rewrite. The check is therefore a real, able-to-fail gate, not a defect. | `grep -n -i -E 'public beta\|không khẳng định ZDR'` on the stated scope. | Make the C4 exit criterion "TC-13 returns 0 hits", and re-run it at G3. |

**Verified in the doc and consistent**
- **§3.3 last paragraph.** It now points to §3.7. It lists the guide and docs/02 as the only files with baseline fixes. It does not contradict §3.2 or §2.7 item 1.
- **BL numbering.**
  - §1.6 item 7 and §2.7 items 7 and 8 use "cũ" correctly, and the mapping range reads 023–031 to 027–035.
  - Notes say "số mới" in §3.8 and §6.1.
  - The §3.7 table matches `origin/main`, whose last BL row is 026, and matches HEAD's fraud rows 023–031.
  - New rows 036 to 038 are free. §8 still uses the old numbering. §3.7 schedules it for C4 and C6, so this is not a contradiction.
- **§2.7 item 7(b) and (c).**
  - `ai.*` is rejected at version creation, with the two timeout fields in the list. The checks reference §2.2 and §2.4.
  - `CONFIG_INVALID` is described as a safety net only, and its metric and alarm go to BL-038.
  - This agrees with §3.2 and with the §3.8 status and metadata CHECKs.
- **§2.7 item 6.** Options (a), (b) and (c) match the earlier findings, and the §3.8 retention bullet agrees ("ba hướng").
- **§3.2 read access.** It now says "chỉ qua projection operator (không thêm quyền auditor)", consistent with §2.7 item 5 and the §3.8 privileges.
- **§2.3 ZDR sentence.** It is rewritten to the eligibility condition, and §2.3 is in the TC-13 scope.
- **§2.7 item 2.** The median form is a numeric average of the two middle rows by `row_number`. TC-15 runs it on PostgreSQL and expects a failure with the old `percentile_cont` above 2^53.
- **§6.1 disposition tables.**
  - Every "Đã sửa" claim for rounds 5 and 6 is true in the doc.
  - `domain-review-round-5.md` and `domain-review-round-6.md` exist, so the links resolve.
  - The round-6 file holds 7 findings plus the verdict line.

**Hand-offs:** unchanged from round 6.

Verdict: APPROVE
