| # | Severity (blocking / should-fix / minor) | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| 1 | minor | R4 TC-57-14 (e3) | The regex itself is correct. It agrees exactly with PostgreSQL 17.11 on `dbs57-pg` (UTF8) and with `!isWellFormed() || includes(NUL)` for all 13 inputs I tried, in both keys and values. Rejected: NUL, lone high, lone low, low+high, high+ASCII, high+high+low, low+high+low, high+low+low, high+low+high, high at end of string. NUL fails with 22P05; the surrogate cases fail with 22P02. Accepted: the pair, Vietnamese text, U+FFFF, U+0001. Leaving out the `u` flag is right. The gap is in the tests: (e3) covers only high+ASCII and low+high. No case puts a lone surrogate next to a valid pair (high+high+low, high+low+low), which is where a wrong lookahead or lookbehind would show up. | Node 24 run of the regex with and without `u`; read-only psql on `dbs57-pg` for each case as key and value; doc R4 TC-57-14 (e3) | Add two values to (e3): high+high+low and high+low+low. Optionally low+high+low. |

Other fixes checked and correct: `||` URL rule; (e2) nested key case; R5 `bash -c` loop quoting and exit-code behaviour; section reference fixed.

Verdict: APPROVE
