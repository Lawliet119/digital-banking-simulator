| # | Severity (blocking / should-fix / minor) | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| — | — | §1–§5, lượt review lại | Không còn phát hiện chưa xử lý trong các phần sửa. Thiết kế đã bổ sung oracle cardinality độc lập cho duplicate trên DB dành riêng, negative control khi invariant vẫn PASS, thresholds theo plateau/endpoint, nguồn/đích hot cố định, nạp bù qua API và preflight số dư/hạn mức ngày. | Đối chiếu `docs/BRD.md` AC-5.4, NFR-PERF-01/02, NFR-SCAL-01/02; `backend/test/support/invariants.sql`; `backend/src/scripts/seed.ts`; `backend/src/modules/ledger/sync-guard.service.ts` và `SENT_TODAY_SQL`; `docs/03_HIGH_LEVEL_ARCHITECTURE.md` §9, §12, §14. | Triển khai và chứng minh các oracle/negative control như thiết kế trước G4. |

Verdict: APPROVE
