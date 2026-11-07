| # | Severity | Section | Finding | Evidence | Suggested fix |
|---|---|---|---|---|---|
| 1 | Resolved | §2; TC-76-02 | Oversized TTL validation gap is closed. | TTL now requires a safe integer in `1..604800`, validated before Redis; tests cover unchanged keys and fallback metric for oversized `set`/`incr`/`zadd`. Lua rollback limitations are explicit. | None. |

Verdict: APPROVE
