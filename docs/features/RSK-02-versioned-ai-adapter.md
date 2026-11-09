# RSK-02: versioned AI adapter safety

Scope: standalone Decisions adapter, explicit caller configuration, loopback behavioral tests. Consumer/ledger and schema integration are owned separately.

Design: `DecisionOptions.rubric` is required; preserve its exact UTF-8 content and SHA-256 in provenance. Reject absent, whitespace-only, over-16,384-byte, or credential-reflecting instructions before admission/network. No request/raw-response/credential logging. The predicate and projected feature allowlist remain fixed.

Admission may be asynchronous. Its deadline is measured from selection, not acquisition start. Race acquisition against remaining admission time, observe rejected promises, and release late grants exactly once. Recheck the deadline immediately before fetch. Cleanup is best-effort, nonblocking, and observes asynchronous release rejection. A denied budget maps to BUDGET_EXHAUSTED; timeout/fault maps to UNAVAILABLE. Provider timeout remains separate.

Test-first plan: add loopback cases for selected Unicode rubric/hash, invalid rubrics, asynchronous grants/denials/rejections, never-resolving admission, late grants and late rejection, nonblocking release. Then update adapter, explicit CLI/manual fixture options and existing documentation. Existing timeout/refusal/provenance tests remain intact.

Safety limits: local admission is not a monetary cap, provider cancellation guarantee, or exactly-once paid-call guarantee. Rule-only remains the integration default. No real provider quality claim follows from loopback fixtures.

Verification on 2026-11-09: typecheck and targeted lint passed; adapter unit tests passed 121/121 and fraud AI CLI end-to-end tests passed 7/7. The isolated loopback manual fixture returned UNAVAILABLE after a stalled response body, with one acquisition, one request and one release. These are synthetic local checks, not a live OpenAI call or consumer integration.
