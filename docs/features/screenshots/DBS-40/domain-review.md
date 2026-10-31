DBS-40 design review (§§1–5): REVISE. Blocking: `infra/local/elasticmq.conf` inherits ElasticMQ default `node-address` (`localhost:9324`), while §2 promises queue URL from random mapped port and TC-40-02 expects it via `ListQueues`. ElasticMQ documents that returned QueueUrls use node-address, independent of bind port; set `node-address.host = "*"` in the mounted config or otherwise normalize/prove returned URLs against dynamic host port (official: https://github.com/softwaremill/elasticmq). Should-fix: TC-40-05 combines Docker-down preflight and cleanup-on-start-failure; preflight failure never creates a container, so separately inject a timeout/failure after creation and assert late-start cleanup. Should-fix: §2 promises stop→start recovery for both, but TC-40-03/04 only assert stop causes error, and TC-40-04 omits pause/timeout/resume entirely; add explicit cases for each transition with bounded client retries/timeouts and fresh probes. Should-fix: §2 says ElasticMQ HTTP SQS readiness but does not define a protocol probe; require `ListQueues`/`GetQueueUrl` (and confirm configured risk queue) rather than bare HTTP/port availability. Pause simulates unresponsive/down behavior, not tunable slow latency; document that limit clearly for future timeout/fallback tests.

Verdict: REVISE.

Re-review: dynamic ElasticMQ queue path normalization and GetQueueUrl readiness resolve the earlier blocker; unit tests now cover late-start and probe-failure cleanup, and integration covers pause/resume plus stop/start for both. Remaining should-fix: Valkey TC-40-03 still does not assert a Redis operation fails after `stop()` (it only verifies Docker inspect fails), although §4 explicitly promises a connection error. Add a fresh Redis client PING with bounded connect timeout before restart. Cleanup edge: `controlService.stop()` unpauses outside its `try`, so an unpause failure prevents `container.stop()` and marks no stopped state; place unpause inside try/finally and still attempt stop. Verdict: APPROVE for design with these small implementation corrections; no blocking design issue found.

Both remaining should-fix items were implemented: bounded Redis connect rejection after stop, and stop always attempts removal even if unpause fails.

---

## Vòng 2, lượt 1 (2026-10-28, model Sonnet) — áp 8 finding code review

| # | Severity | Mục | Finding | Evidence | Đề xuất sửa |
|---|---|---|---|---|---|
| 1 | blocking | §2 Vòng 2 | Nâng probe timeout ElasticMQ lên 135s làm tổng thời gian chờ tệ nhất của `startServiceContainer` (300s start + 135s probe = 435s) **vượt** `testTimeout: 360000` (360s) của Jest cho suite này. Đúng kịch bản "probe treo thật" mà fix AbortSignal nhắm tới, Jest sẽ tự giết test ở mốc 360s trước khi timeout nội bộ hoặc `AbortSignal` kịp chạy → không `container.stop()`, không abort, chỉ còn lỗi Jest "Exceeded timeout" chung — ngược mục tiêu "đáng tin cậy hơn" của vòng này. | `backend/test/jest-services.js:4` (`testTimeout: 360000`); `backend/test/support/postgres.container.ts:6` (`OVERALL_START_TIMEOUT_MS = 300_000`); `backend/test/support/service-container.ts:36-55` (hai timeout tuần tự: start rồi probe); doc §2 "ElasticMQ dùng 135s" | Hạ probe timeout ElasticMQ xuống mức giữ `start + probe` an toàn dưới `testTimeout` (ví dụ ≤ 50-55s còn lại sau 300s), hoặc tăng `testTimeout` của `jest-services.js` lên ≥ 450s, hoặc giảm `OVERALL_START_TIMEOUT_MS` áp dụng riêng cho service test. Phải tính lại tổng, không chỉ probe. |
| 2 | blocking | §1 Vòng 2 (phạm vi file) | Phạm vi file của vòng 2 chỉ liệt `service-container.ts`, `elasticmq.container.ts`, `testcontainers.services-spec.ts`, `jest-services.js`, bỏ sót `service-container.spec.ts` — file này gọi trực tiếp `startServiceContainer('Valkey', starting, () => Promise.resolve())` theo chữ ký 3 tham số cũ. Khi `startServiceContainer` đổi chữ ký (thêm `probeTimeoutMs`, probe nhận `AbortSignal`, trả `{ container, probeResult }`), file này vỡ build/test. Đồng thời TC-40-09 (Docker down không gọi `GenericContainer`/SDK cho Valkey/ElasticMQ), TC-40-10 (`stillPendingAfter`), TC-40-11 (`controlService` memoized) không có file đích nào được chỉ định. | `backend/test/support/service-container.spec.ts:14,31`; doc §1 dòng "8 finding trên backend/test/support/{service-container,elasticmq.container}.ts, ..."; doc §4 các dòng TC-40-09/10/11 không có cột file | Thêm `service-container.spec.ts` vào phạm vi vòng 2 (cập nhật lời gọi theo chữ ký mới, thêm TC-40-10/11); chỉ định rõ file (mới hoặc có sẵn) cho TC-40-09, theo mẫu mock `testcontainers`/SDK như `postgres.container.spec.ts`. |
| 3 | should-fix | §2 Vòng 2 | Dùng lại `assertDockerAvailable` (thông báo "...Please start Docker Desktop **to run database tests**...") cho Valkey/ElasticMQ làm đổi nội dung lỗi quan sát được khi Docker down, trong khi §2 khẳng định "không đổi ... hành vi quan sát được". | `backend/test/support/postgres.container.ts:40-43`; doc §2 Vòng2 "...giữ nguyên chữ ký và hành vi quan sát được" | Tham số hoá message theo context hoặc sửa câu chữ trong doc. |
| 4 | should-fix | §3 / §8 | §3 hứa "đề xuất BL-NNN riêng" nhưng §8 không có mục nào như vậy; `docs/BACKLOG.md` không có entry nào. | doc §3; `docs/BACKLOG.md` | Gán số BL thật (BL-055, BL-056) trước khi merge. |
| 5 | minor | §2 Vòng 2 | Biên an toàn 135s so với ngân sách retry tệ nhất ElasticMQ (~129,75s) chỉ còn ~5,25s (~4%). | `backend/test/support/elasticmq.container.ts:49-62` | Nới biên rộng hơn (145-150s). |

Verdict: REVISE

## Vòng 2, lượt 2 (2026-10-28, re-review sau khi sửa lượt 1, model Sonnet)

| # | Severity | Section của doc | Finding | Evidence | Suggested fix |
|---|---|---|---|---|---|
| 1 | should-fix | §2, bullet "Vòng 2 — ngân sách timeout Jest" | Công thức ngân sách tệ nhất bỏ sót `DOCKER_CHECK_TIMEOUT_MS` (15s), gọi trước mỗi lần `startXContainer()` (2 lần/test). Tính đúng: mỗi lần gọi = 15s + 300s + 150s (ElasticMQ) = 465s; 2 lần = **930s**, không phải 900s như doc nêu. Biên thật với `testTimeout=950s` là ~20s (~2,1%), không phải "~50s" như doc khẳng định — mỏng hơn cả biên 135s/~4% mà chính vòng này vừa chê. | `backend/test/support/postgres.container.ts:8` (`DOCKER_CHECK_TIMEOUT_MS = 15_000`); `backend/test/support/service-container.ts` (dùng lại hằng số này); `valkey.container.ts:18`, `elasticmq.container.ts:30` (gọi trước mỗi start); `testcontainers.services-spec.ts:65,112` (2 lần start/it) | Cộng `2×DOCKER_CHECK_TIMEOUT_MS` vào công thức; nâng `testTimeout` để khôi phục biên an toàn ≥~15%. |
| 2 | should-fix | §1 | Đoạn "Sau domain review vòng 2 (REVISE, xem §6)" trỏ tới §6 nhưng §6 chưa được cập nhật — vẫn chỉ chứa nội dung vòng 1. | §6 (trước khi sửa); `screenshots/DBS-40/domain-review.md` (trước khi nối) | Cập nhật §6 với bảng "đã sửa/không sửa" cho 5 finding vòng 2 lượt 1 và verdict REVISE; nối bản raw review vào `domain-review.md`. |
| 3 | minor | §4, dòng TC-40-12 | Biểu thức mã thiếu dấu `(` mở: `` `OVERALL_START_TIMEOUT_MS + ELASTICMQ_PROBE_TIMEOUT_MS) * 2 < testTimeout` `` | doc §4 dòng TC-40-12 | Thêm `(` ở đầu biểu thức. |
| 4 | minor | §9 | §8 công bố BL-055/056 nhưng §9 ("Tài liệu đã cập nhật") chưa nhắc tới. | §8 vs §9 | Thêm BL-055/056 vào §9. |

Verdict: REVISE

## Vòng 2, lượt 3 (2026-10-28, re-review sau khi sửa lượt 2, model Sonnet)

| # | Severity | Section của doc | Finding | Evidence | Suggested fix |
|---|---|---|---|---|---|
| 1 | blocking | §1 (dòng "Docker đã bật lại ở máy này...") và §5 ("Vòng 2: chạy lại M-40-01…03... trên Docker thật") | Doc khẳng định đã **chạy lại** M-40-01…03 trên Docker thật cho vòng 2, nhưng không có commit hay thay đổi working-tree nào chứa code vòng 2 (`probeTimeoutMs`, `AbortSignal`, `contextLabel`, `stillPendingAfter`, `testTimeout=1080000`, hai spec mới) — `git log`/`git status`/`git diff` xác nhận code vẫn là bản vòng 1. Tự mâu thuẫn với §8 ("kết quả sẽ ghi đầy đủ ở G4 sau khi implement/test xong"). | `git log --oneline -- backend/test/support/service-container.ts backend/test/support/elasticmq.container.ts backend/test/support/valkey.container.ts backend/test/jest-services.js` → chỉ `83b9803` (vòng 1); `git status --porcelain` → chỉ 3 file `.md`; `backend/test/jest-services.js:4` (`testTimeout: 360000`, chưa đổi) | Đổi câu chữ §1/§5 sang thời tương lai/điều kiện, nói rõ còn ở Phase 2 thiết kế, chưa chạy. |
| 2 | should-fix | §2, đoạn "Vòng 2 — ngân sách timeout Jest" | Đoạn vừa sửa vẫn gọi tên hàm `assertServiceDockerAvailable()` để giải thích hạng mục 15s, nhưng bullet ngay sau nói hàm này "bị xóa" và dùng `assertDockerAvailable` — mâu thuẫn tên hàm trong cùng mục. | Doc §2 dòng "ngân sách timeout Jest" vs dòng ngay sau ("assertServiceDockerAvailable... bị xóa") | Đổi tên hàm trong dòng ngân sách thành `assertDockerAvailable(undefined, 'service container tests (Valkey/ElasticMQ)')`. |

Xác nhận đã sửa đúng (không re-flag): công thức ngân sách 930s và `testTimeout=1.080.000ms` biên ~16,1% tính đúng; §6 đã có bảng ghi đủ finding lượt 1+2; TC-40-12 đã cân bằng dấu ngoặc; §9 đã liệt BL-055/056 khớp `docs/BACKLOG.md`.

Verdict: REVISE

## Vòng 2, lượt 4 (2026-10-28, re-review sau khi sửa lượt 3, model Sonnet)

| # | Severity | Section của doc | Finding | Evidence | Suggested fix |
|---|---|---|---|---|---|
| 1 | minor | `docs/BACKLOG.md` header | Header vẫn ghi "Cập nhật: 2026-10-26" trong khi BL-055/056 vừa thêm ngày 2026-10-28. | `docs/BACKLOG.md:3` vs BL-055/056 | Cập nhật ngày header thành 2026-10-28. |

Xác nhận riêng (không phải finding mới): hai fix của lượt 3 đều đúng — §1/§5 đã đổi hẳn sang thời tương lai, kết "Chưa chạy — còn ở Phase 2 thiết kế", khớp thực trạng code (đã đọc trực tiếp `jest-services.js`, `elasticmq.container.ts`, `valkey.container.ts` — vẫn là bản vòng 1); §2 dòng ngân sách đã đổi tên hàm thành `assertDockerAvailable(...)`, khớp bullet kế bên. Toán học 15+300+150=465×2=930, 15+300+10=325×2=650, `testTimeout=1.080.000ms` biên ~16,1% — đúng. TC-40-07…12 đều có file đích; §6 khớp `domain-review.md`; BL-055/056 khớp giữa §3/§8/§9 và `BACKLOG.md`.

Verdict: APPROVE
