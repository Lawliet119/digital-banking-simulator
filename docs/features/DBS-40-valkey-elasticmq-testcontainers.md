# DBS-40 · Testcontainers cho Valkey và ElasticMQ

> **Status:** Implemented (vòng 2, G4 đang chờ duyệt; chưa push) · **Vai:** Dev · **Nhánh:** `test/DBS-40-valkey-elasticmq` · **PR:** [#18](https://github.com/Lawliet119/digital-banking-simulator/pull/18) · **Cập nhật:** 2026-10-28

## 1. Bối cảnh

- Board: DBS-40, Dev, High, In Progress, P4. Expect: “Test e2e có Redis và SQS thật khi cần (rate limit, relay, consumer).” Dependency DBS-39 đã Done và `postgres.container.ts` hiện có trên `origin/main`.
- DoD: (1) `valkey.container.ts`, `elasticmq.container.ts` cùng khuôn helper Postgres, ElasticMQ dùng `infra/local/elasticmq.conf`; (2) sample SET/GET và send/receive; (3) mô phỏng down/slow; (4) PR merge, CI xanh, Dev khác review, đối chiếu test case.
- Thực trạng: Compose có hai dịch vụ nhưng chưa có helper tự khởi tạo. Test DB dùng Jest global setup riêng; DBS-40 sẽ có cấu hình Jest riêng để mọi lần chạy sample đều khởi tạo container, không vô tình dùng Compose.
- Nhánh tạo từ `origin/main` `7ce5a23` với working tree sạch. Baseline trước khi sửa chưa được lưu thành transcript riêng; các lệnh hiện hành đã chạy sau triển khai, số đếm ở §8.
- BL-016 (CI không phủ nhánh Testcontainers DB) liên quan CI tổng thể, chưa giải quyết trong DBS-40. BL-017 (quyền Postgres) ngoài phạm vi vì helper này không sửa DB. DBS-41 (đã merge main) chỉ tích hợp hai suite Postgres vào job `e2e`; suite Valkey/ElasticMQ của DBS-40 (`test:services`) vẫn chưa có trong CI, xem BL-053.
- **Rebase 2026-10-27:** merge `origin/main` vào nhánh này sau khi DBS-41 và DBS-42 đã merge. Conflict ở `backend/package-lock.json` (giải quyết bằng `npm install` để sinh lại lockfile đúng, giữ cả dependency của DBS-40 và các PR khác), `docs/BACKLOG.md` (BL-023/024 của DBS-40 đổi thành BL-053/054 vì `main` đã dùng BL-023/024 cho DBS-42) và `docs/features/README.md` (giữ cả dòng DBS-40 và DBS-41). Không đổi helper, test hay logic nghiệp vụ.
- Ngoài phạm vi: Redis/SQS adapter nghiệp vụ, AWS thật, logic giao dịch, thay đổi event contract.
- Quyết định: người dùng đã yêu cầu triển khai thẳng, không dừng G1–G4; các quyết định thiết kế và bằng chứng vẫn lưu tại đây. Dùng dev dependencies `redis`, `@aws-sdk/client-sqs` để sample dùng protocol thật. Không thêm env var.

**Vòng 2 (2026-10-28) — áp fix từ code review `/code-review` trên PR #18, trước merge:** 8 finding trên `backend/test/support/{service-container,elasticmq.container,valkey.container}.ts`, `backend/test/support/service-container.spec.ts` (sửa theo chữ ký mới) và hai spec mới `backend/test/support/{valkey,elasticmq}.container.spec.ts`, `backend/test/services/testcontainers.services-spec.ts`, `backend/test/jest-services.js` — xem đối chiếu ở §6. Không đổi DoD, không đổi API test gọi từ ngoài (`startValkeyContainer`/`startElasticMqContainer` giữ nguyên chữ ký và hành vi quan sát được qua `test:services`); nội dung thông báo lỗi khi Docker không chạy có đổi, ghi ở §2 dưới. Docker đã bật lại ở máy này; test thủ công vòng 2 đã chạy thật ở Phase 4c, kết quả ở §8. Ngoài phạm vi vòng 2: sửa `postgres.container.ts`/`postgres.container.spec.ts` (thuộc DBS-39, đã merge main) theo cách đổi hành vi của nó — chỉ *thêm tham số tùy chọn có giá trị mặc định giữ nguyên hành vi cũ* (`assertDockerAvailable`) để dùng lại được, không đổi gì khác trong file đó; phần trùng lặp còn lại (khung start/stop/timeout tổng của `postgres.container.ts` so với `service-container.ts`) và việc hoãn `it.concurrent` cho hai lifecycle test độc lập đều ghi backlog thật (BL-055, BL-056) thay vì để lời hứa không có số, xem §3 và §8.

**Sau domain review vòng 2 (REVISE, xem §6):** sửa 2 blocking — (a) ngân sách thời gian tệ nhất của `testTimeout` Jest nhỏ hơn tổng hai lần start tuần tự khi tính đúng timeout probe mới của ElasticMQ; (b) phạm vi file vòng 2 ban đầu bỏ sót `service-container.spec.ts` (gọi `startServiceContainer` theo chữ ký cũ, sẽ vỡ) và không chỉ định file cho 3 test case mới — đã bổ sung vào danh sách file trên. Và 2 should-fix — (c) thông báo lỗi Docker-down đổi nội dung ("...to run database tests" không đúng cho test Redis/SQS) trong khi §2 ghi "không đổi hành vi quan sát được": sửa câu đó, thêm tham số `contextLabel` cho `assertDockerAvailable` để thông báo đúng ngữ cảnh mà không đổi hành vi với caller cũ (Postgres); (d) hai quyết định hoãn (trùng lặp khung timeout, `it.concurrent`) không có số BL thật: thêm BL-055/056.

## 2. Hành vi

- `startValkeyContainer()` khởi động Valkey 8 với cổng ngẫu nhiên, chờ lệnh PING thành công, trả endpoint và hàm `stop`, `pause`, `resume`. Pause làm lệnh treo để mô phỏng không phản hồi; resume khôi phục. Stop làm mất kết nối; gọi start lần nữa để khôi phục.
- `startElasticMqContainer()` nạp file config local vào container riêng, xác nhận queue `risk-events` bằng SQS `GetQueueUrl`, trả endpoint và queue URL dùng được từ cổng động. ElasticMQ quảng bá URL nội bộ `localhost:9324`; helper giữ đường dẫn queue thật và thay host/port bằng endpoint của Testcontainers.
- Mọi start lỗi hoặc quá hạn đều giải phóng container khởi động muộn. Docker không chạy là lỗi rõ ràng; test không skip.
- **Vòng 2:** timeout của protocol probe giờ tùy theo caller (`probeTimeoutMs`, mặc định 30s giữ cho Valkey — nới thành 10s tường minh, generous so với connect 5s+ping) thay vì cố định 30s cho mọi dịch vụ. Ngân sách thật của 40 lần retry ElasticMQ = 40×3000ms (timeout mỗi lần) + 39×250ms (nghỉ giữa các lần, lần cuối không nghỉ) = 129.750ms (~129,75s); `probeTimeoutMs` ElasticMQ đặt **150s**, biên an toàn ~20,25s (~15,6%) so với ngân sách retry thật — biên vòng đầu (135s, ~4%) quá mỏng, dễ false-timeout khi có jitter scheduler/GC qua 40 vòng, đã sửa theo should-fix của domain review vòng 2. Nếu timeout tổng vẫn bắn (probe treo thật), `startServiceContainer` hủy probe qua `AbortSignal` (loop ElasticMQ kiểm tra `signal.aborted` mỗi vòng và truyền `abortSignal` vào `sqs.send`) để không còn tác vụ async mồ côi chạy tiếp trên container đã bị stop. `riskQueuePath` không còn là biến side-effect ngoài scope + non-null assertion: `startServiceContainer` trả `{ container, probeResult }`, ElasticMQ probe trả thẳng path qua `probeResult`.
- **Vòng 2 — ngân sách timeout Jest (blocking, đã sửa, rồi sửa lại sau re-review):** mỗi `it` trong `testcontainers.services-spec.ts` gọi `startXContainer()` hai lần tuần tự (main + recovered); mỗi lần gọi trước tiên qua `assertDockerAvailable(undefined, 'service container tests (Valkey/ElasticMQ)')` (dùng lại `DOCKER_CHECK_TIMEOUT_MS` = 15s — xem bullet dưới về việc xóa `assertServiceDockerAvailable`), rồi `startServiceContainer` với `OVERALL_START_TIMEOUT_MS` (300s, bao cả image pull) + `probeTimeoutMs`. Ngân sách tệ nhất một lần gọi = 15 + 300 + `probeTimeoutMs`. ElasticMQ: 15+300+150=465s, ×2=**930s**; Valkey: 15+300+10=325s, ×2=650s. `testTimeout` của `jest-services.js` áp cho từng `it` riêng (không cộng dồn giữa hai `it` trong file), nên phải ≥ 930s (ca ElasticMQ, số lớn hơn). Bản sửa đầu quên cộng `DOCKER_CHECK_TIMEOUT_MS` (ra 900s) rồi chọn `testTimeout=950.000ms`, biên thật chỉ ~20s (~2,1%) — mỏng hơn cả biên 135s/~4% mà chính vòng này vừa chê; re-review bắt lại. Sửa lại: `testTimeout` nâng từ 360.000ms lên **1.080.000ms** (1080s), biên 150s (~16,1%) so với 930s — cùng tầm biên an toàn đã dùng cho `probeTimeoutMs` ElasticMQ. Khi Docker thật chậm, test báo đúng thông báo chẩn đoán của helper (`[Testcontainers] ... did not start within 300s` hoặc `protocol probe timed out`) thay vì bị Jest tự kill bằng lỗi chung không rõ nguyên nhân. Chạy bình thường (Docker khỏe) suite vẫn xong trong vài giây đến vài chục giây; số 1080s chỉ là ngân sách cho trường hợp xấu nhất, không phải thời gian chạy thường.
- **Vòng 2:** `assertServiceDockerAvailable` (bản sao không test được của `assertDockerAvailable`) bị xóa; Valkey và ElasticMQ gọi lại `assertDockerAvailable` đã có sẵn tham số inject và test ở `postgres.container.spec.ts` (TC-39-03/08). Thêm tham số thứ hai tùy chọn `contextLabel: string = 'database tests'` vào `assertDockerAvailable` (giá trị mặc định giữ nguyên câu thông báo cho `postgres.container.ts` và `postgres.container.spec.ts`, không đổi hành vi của DBS-39); Valkey/ElasticMQ gọi `assertDockerAvailable(undefined, 'service container tests (Valkey/ElasticMQ)')` để thông báo không còn nói "to run database tests" cho một test Redis/SQS — sửa theo should-fix của domain review vòng 2 (câu "không đổi hành vi quan sát được" ở trên chỉ áp cho hành vi `test:services`, không áp cho câu chữ thông báo lỗi Docker-down, nay đã nói rõ).
- **Vòng 2:** `controlService` cache handle Docker container một lần (lazy, memoized) thay vì gọi lại `getContainerRuntimeClient()` mỗi lần `pause()/resume()/stop()`.

## 3. Kiến trúc

- Helper ở `backend/test/support/`; Jest config `test/jest-services.js` chỉ chạy `test/services/*.services-spec.ts`. Không phụ thuộc `DATABASE_URL` hoặc Compose.
- Test Valkey dùng Redis client tới host/port Testcontainers; test ElasticMQ dùng SQS client tới endpoint động và queue theo config. Không sửa bảng hay transaction.
- `pause/resume` dùng Docker runtime trên container ID do Testcontainers trả về; cleanup trong `finally` kể cả assertion lỗi. Không dùng proxy latency có thể chỉnh mili giây: pause tạo tình huống không phản hồi, đủ cho test timeout/fallback về sau. Đây không phải phép đo độ trễ hữu hạn.
- **Vòng 2:** test pause/ping của Valkey (`testcontainers.services-spec.ts`) dùng hàm mới `stillPendingAfter(probe, ms)` (xuất từ `service-container.ts`) thay cho `Promise.race` viết tay — probe reject (connection-reset) hay hang đều được quy về `false`/`true` có kiểm soát, không còn khả năng unhandled rejection lọt qua `Promise.race` và làm test fail bằng lỗi socket khó hiểu.
- **Vòng 2 — trùng lặp còn lại, không sửa trong task này:** `postgres.container.ts` (DBS-39, đã merge main) vẫn tự có khung "check Docker → start với overall timeout → stop container khởi muộn" riêng, không dùng `service-container.ts`. Sửa chéo sang file đó đụng task đã đóng và spec của nó (`postgres.container.spec.ts`); ghi **BL-055** cho việc hợp nhất, xem §8.
- **Vòng 2 — không đổi trong task này:** hai `it` block độc lập trong `testcontainers.services-spec.ts` (Valkey, ElasticMQ) tiếp tục chạy tuần tự. Đã xét `it.concurrent` (Jest 30 hỗ trợ) nhưng log console đan xen giữa hai container cùng lúc làm transcript test thủ công khó đọc và tăng tải Docker daemon đồng thời — ngược với mục tiêu "đáng tin cậy hơn" của vòng sửa này; ghi **BL-056** thay vì đổi mô hình chạy test ở đây, xem §8.

## 4. Test cases tự động

| ID | DoD | Test và kết quả mong đợi |
|---|---|---|
| TC-40-01 | 1–2 | Container Valkey tự khởi, SET/GET qua cổng động, cleanup |
| TC-40-02 | 1–2 | ElasticMQ tự khởi với config repo, gửi/nhận queue `risk-events`, cleanup |
| TC-40-03 | 3 | Pause Valkey làm PING timeout; resume trả PONG; stop làm kết nối lỗi |
| TC-40-04 | 3 | Pause ElasticMQ làm request timeout; resume gửi/nhận lại; stop làm request lỗi |
| TC-40-05 | 1–3 | Docker down → test báo lỗi rõ, không skip; unit riêng kiểm container khởi động muộn hoặc probe lỗi đều được dọn |
| TC-40-06 | 4 | PR, CI, Dev review, merge: kiểm tra quy trình sau khi mở PR |
| TC-40-07 | 3 (vòng 2) | `service-container.spec.ts`: `startServiceContainer` dùng `probeTimeoutMs` riêng theo caller (mặc định 30s, ElasticMQ 150s, Valkey 10s), không còn cố định 30s cho mọi dịch vụ; khi timeout tổng bắn, `AbortSignal` truyền vào probe được `abort()` trước khi `stop()` container |
| TC-40-08 | 1–3 (vòng 2) | `elasticmq.container.spec.ts` (mới): `startServiceContainer` trả `{ container, probeResult }`; probe ElasticMQ trả `riskQueuePath` qua giá trị trả về, không qua biến side-effect + non-null assertion |
| TC-40-09 | 1–3 (vòng 2) | `valkey.container.spec.ts`, `elasticmq.container.spec.ts` (cả hai mới): mock `assertDockerAvailable` reject → `GenericContainer`/SQS client chưa từng được tạo hoặc gọi; Docker down thật (integration, M-40-03) vẫn lỗi rõ ràng, không skip |
| TC-40-10 | 3 (vòng 2) | `service-container.spec.ts`: `stillPendingAfter(probe, ms)` trả `true` khi probe treo quá `ms`, `false` khi probe resolve **hoặc reject** trước `ms` — không ném lỗi ra ngoài; thay cho `Promise.race` viết tay trong `testcontainers.services-spec.ts` |
| TC-40-11 | quy trình (vòng 2) | `service-container.spec.ts`: `controlService` gọi `getContainerRuntimeClient()` đúng một lần dù `pause()/resume()` được gọi nhiều lần |
| TC-40-13 | 1–3 (vòng 2, phát sinh ở Phase 4c) | `valkey.container.spec.ts`: `probeValkey` thử lại khi connect bị từ chối rồi thành công; không `destroy()` client đã đóng (không ném `ClientClosedError`); hết số lần thì ném đúng lỗi kết nối cuối; dừng khi `signal` đã abort; PING khác PONG thì ném lỗi và dọn client; `VALKEY_PROBE_TIMEOUT_MS` = 45s so với ngân sách retry 32,25s |
| TC-40-12 | 1–4 (vòng 2, sau 2 lượt REVISE) | `jest-services.js` + `elasticmq.container.ts`: hằng số `testTimeout=1080000` và `(DOCKER_CHECK_TIMEOUT_MS + OVERALL_START_TIMEOUT_MS + ELASTICMQ_PROBE_TIMEOUT_MS) * 2 < testTimeout` (930s < 1080s) nhất quán, kiểm bằng assertion số học trong spec, không phải chạy thật 1080s |

## 5. Test thủ công

| ID | Hành động | Mong đợi |
|---|---|---|
| M-40-01 | Chạy `npm run test:services -- --runInBand` khi Compose tắt | Sample tự tạo container, SET/GET và SQS send/receive thành công, dọn container |
| M-40-02 | Chạy kịch bản pause/resume và stop/start trong suite | Thấy timeout/down rồi phục hồi |
| M-40-03 | Tắt Docker, chạy lại suite | Exit khác 0, thông báo Docker rõ ràng, không skip |

**Vòng 2:** sẽ chạy lại M-40-01…03 nguyên vẹn trên Docker thật ở Phase 4c (không thêm bước tay mới) — các fix là nội bộ, không đổi hành vi quan sát được từ `test:services`; phần không quan sát được bằng tay (hủy probe qua AbortSignal khi outer timeout bắn, cache Docker handle) có unit riêng (TC-40-07, TC-40-10, TC-40-11) chạy với fake timer, không cần Docker. Đã chạy ở Phase 4c, xem §8.

## 6. Domain review (AI)

**Vòng 1:** reviewer độc lập phát hiện 1 blocking và một số should-fix qua hai lượt; [nguyên văn review](screenshots/DBS-40/domain-review.md). Đã sửa URL động ElasticMQ, probe SQS, test cleanup khi start muộn, test pause/resume và stop/start cho cả hai, Redis down thật và cleanup khi unpause lỗi. Verdict cuối: **APPROVE**.

**Vòng 2, lượt 1** (áp 8 finding code review, model Sonnet) — REVISE, 2 blocking + 2 should-fix + 1 minor:
1. *(blocking, đã sửa)* `testTimeout` không đủ cho ngân sách tệ nhất sau khi nâng probe timeout ElasticMQ — xem §2.
2. *(blocking, đã sửa)* Phạm vi file vòng 2 bỏ sót `service-container.spec.ts` (vỡ build vì đổi chữ ký) và không chỉ định file cho 3 case mới — đã bổ sung vào §1 và §4.
3. *(should-fix, đã sửa)* Thông báo lỗi Docker-down đổi nội dung ("...to run database tests") trong khi §2 nói không đổi hành vi quan sát được — thêm `contextLabel`, xem §2.
4. *(should-fix, đã sửa)* Hai quyết định hoãn không có số BL thật — thêm BL-055/056 vào `docs/BACKLOG.md`.
5. *(minor, đã sửa)* Biên an toàn 135s/~4% cho probe ElasticMQ quá mỏng — nâng lên 150s/~15,6%, xem §2.

**Vòng 2, lượt 2 (re-review sau khi sửa lượt 1, model Sonnet)** — REVISE, 2 should-fix + 2 minor:
1. *(should-fix, đã sửa)* Công thức ngân sách ở lượt 1 quên cộng `DOCKER_CHECK_TIMEOUT_MS` (15s, gọi trước mỗi `startXContainer()`); đúng ra ngân sách ElasticMQ là 930s chứ không phải 900s, biên thật của `testTimeout=950s` chỉ ~20s (~2,1%) — mỏng hơn cả biên bị chê ở lượt 1. Sửa: `testTimeout` nâng lên 1.080.000ms, xem §2.
2. *(should-fix, đã sửa)* §6 (mục này) chưa ghi lại review vòng 2 lượt 1 — đang sửa ngay trong bản cập nhật này.
3. *(minor, đã sửa)* TC-40-12 thiếu dấu `(` mở trong công thức — xem §4.
4. *(minor, đã sửa)* §9 chưa liệt BL-055/056 — đã thêm.

**Vòng 2, lượt 3 (re-review sau khi sửa lượt 2, model Sonnet)** — REVISE, 1 blocking + 1 should-fix:
1. *(blocking, đã sửa)* §1/§5 viết như đã "chạy lại test thủ công trên Docker thật" cho vòng 2, nhưng vẫn ở Phase 2 thiết kế — chưa có dòng code vòng 2 nào được viết (reviewer đối chiếu `git log`/`git status`, xác nhận code vẫn là bản vòng 1). Tự mâu thuẫn với chính §8 ("kết quả sẽ ghi đầy đủ ở G4 sau khi implement/test xong"). Sửa: đổi câu chữ §1/§5 sang thời tương lai, nói rõ còn ở Phase 2, chưa chạy.
2. *(should-fix, đã sửa)* §2 dòng ngân sách timeout gọi tên hàm `assertServiceDockerAvailable()` để giải thích 15s, nhưng bullet ngay sau nói hàm này "bị xóa" và dùng `assertDockerAvailable` — mâu thuẫn tên hàm trong cùng mục. Sửa: đổi tên hàm trong dòng ngân sách cho khớp.

**Vòng 2, lượt 4 (re-review sau khi sửa lượt 3, model Sonnet)** — **APPROVE**, 1 minor đã sửa luôn: header `docs/BACKLOG.md` ghi "Cập nhật: 2026-10-26" trong khi BL-055/056 vừa thêm ngày 2026-10-28 — sửa ngày header. Mọi phép tính (930s, 650s, biên ~16,1%), đối chiếu file/case ở §4, lịch sử §6 so với `domain-review.md`, và BL-055/056 giữa §3/§8/§9/`BACKLOG.md` đều được reviewer xác nhận khớp.

[Nguyên văn cả bốn lượt review vòng 2](screenshots/DBS-40/domain-review.md) (nối thêm vào file cũ của vòng 1).

Verdict cuối vòng 2: **APPROVE** (sau 3 REVISE + 1 APPROVE, tổng 8 finding gốc + 9 finding phát sinh qua các lượt re-review, tất cả đã sửa). AI review không thay Dev review PR.

## 7. Kế hoạch triển khai

**Vòng 1:**
1. Viết test sample và fault test trước, xác nhận đỏ vì thiếu helper/config (`TS2307` ở cả hai import).
2. Thêm hai helper, timeout, readiness, cleanup và pause/resume qua Docker runtime. Chạy test xanh.
3. Chạy lint, typecheck, unit, e2e, DB, build và kịch bản tay; ghi transcript/ảnh, cập nhật docs/backlog.

Rollback vòng 1: revert commit `83b9803`; không chạm dữ liệu Compose hoặc AWS.

**Vòng 2 (2026-10-28) — áp 8 finding code review, theo thiết kế đã APPROVE ở §6:**

1. **`assertDockerAvailable` thêm `contextLabel` tùy chọn** (sửa finding #3, một phần)
   - File: `backend/test/support/postgres.container.ts`, `backend/test/support/postgres.container.spec.ts`.
   - Test trước: thêm case "dùng `contextLabel` tùy chọn thay cho 'database tests' khi được truyền" gọi `assertDockerAvailable(mockGetRuntimeClient, 'custom label')`. Đỏ vì `TS2554: Expected 0-1 arguments, but got 2` (chữ ký cũ chỉ có 1 param).
   - Code: thêm param thứ hai `contextLabel: string = 'database tests'`, dùng trong template string thay vị trí cứng "database tests"; các test cũ không truyền param thứ hai vẫn giữ nguyên hành vi (default).
   - Chạy: `npx jest test/support/postgres.container.spec.ts`.
   - Commit: `fix(test): contextLabel tùy chọn cho assertDockerAvailable (DBS-40)`.

2. **Lõi `service-container.ts` + hai helper gọi nó + jest config — một đơn vị ghép** (sửa finding #1, #2, #3 phần còn lại, #6, #7; chuẩn bị cho #4)
   - File: `backend/test/support/service-container.ts`, `backend/test/support/elasticmq.container.ts`, `backend/test/support/valkey.container.ts`, `backend/test/support/service-container.spec.ts`, `backend/test/support/elasticmq.container.spec.ts` (mới), `backend/test/support/valkey.container.spec.ts` (mới), `backend/test/jest-services.js`.
   - Vì sao ghép một bước: đổi chữ ký `startServiceContainer` (thêm `probeTimeoutMs`, probe nhận `AbortSignal`, trả `{ container, probeResult }`) làm vỡ ngay cả hai caller hiện có; xóa `assertServiceDockerAvailable` buộc cả hai caller đổi sang `assertDockerAvailable` cùng lúc. Tách rời sẽ để lại trạng thái không compile được giữa hai commit.
   - Test trước (viết hết trước khi sửa `service-container.ts`):
     - `service-container.spec.ts`: sửa 2 case cũ cho chữ ký mới (`startServiceContainer(name, starting, probe, probeTimeoutMs)` trả `{ container, probeResult }`); thêm TC-40-07 (AbortSignal truyền vào probe khi outer timeout bắn), TC-40-10 (`stillPendingAfter` trả `true`/`false` cho hang/resolve/**reject**), TC-40-11 (`controlService` gọi `getContainerRuntimeClient` đúng 1 lần dù pause/resume nhiều lần), TC-40-12 (assertion số học: `(DOCKER_CHECK_TIMEOUT_MS + OVERALL_START_TIMEOUT_MS + ELASTICMQ_PROBE_TIMEOUT_MS) * 2 < require('../jest-services.js').testTimeout`).
     - `elasticmq.container.spec.ts` (mới), `valkey.container.spec.ts` (mới): TC-40-08 (ElasticMQ probe trả `riskQueuePath` qua `probeResult`, không qua biến ngoài scope), TC-40-09 (mock `assertDockerAvailable` reject → `GenericContainer`/`SQSClient` chưa từng được gọi).
   - Đỏ dự kiến: `TS2554`/`TS2339` ở các lời gọi theo chữ ký mới, và case TC-40-07/08/10/11/12 fail vì hàm/const chưa tồn tại (`stillPendingAfter`, `ELASTICMQ_PROBE_TIMEOUT_MS` chưa export).
   - Code: viết `service-container.ts` (thêm `probeTimeoutMs` param có default 30_000, truyền `AbortSignal` cho probe và `abort()` khi outer timeout bắn trước khi `container.stop()`, đổi `startServiceContainer` trả `{ container, probeResult }`, thêm `stillPendingAfter(probe, ms)` dùng `.then(() => false, () => false)` thay `Promise.race` tay, memoize Docker handle trong `controlService`, xóa `assertServiceDockerAvailable`); `elasticmq.container.ts` (export `ELASTICMQ_PROBE_TIMEOUT_MS = 150_000`, probe trả `riskQueuePath` qua return value, loop kiểm `signal.aborted` và truyền `abortSignal` vào `sqs.send`, gọi `assertDockerAvailable(undefined, 'service container tests (Valkey/ElasticMQ)')`); `valkey.container.ts` (probe dùng `probeTimeoutMs: 10_000`, gọi `assertDockerAvailable` với cùng `contextLabel`); `jest-services.js` (`testTimeout: 1_080_000`).
   - Chạy: `npx jest test/support/service-container.spec.ts test/support/elasticmq.container.spec.ts test/support/valkey.container.spec.ts --runInBand`.
   - Commit: `refactor(test): probeTimeoutMs, AbortSignal và dọn Docker-down cho service containers (DBS-40)`.

3. **`testcontainers.services-spec.ts` dùng `stillPendingAfter`** (sửa finding #4)
   - File: `backend/test/services/testcontainers.services-spec.ts`.
   - Test trước: chạy suite hiện tại trên Docker thật — pass bình thường (hành vi quan sát được không đổi khi probe không reject); không có đường để tạo đỏ an toàn cho nhánh reject thật (cần Docker pause gây connection-reset, không tái lập được xác định). Thay vào đó: đọc code, xác nhận `Promise.race([pending.then(() => false), ...])` có đúng vị trí `stillPendingAfter` sẽ thay; coi bước này là thay thế 1:1 đã được TC-40-10 (bước 2) chứng minh đúng hành vi của `stillPendingAfter`, rồi áp dụng.
   - Code: thay `Promise.race([pending.then(() => false), new Promise(...)])` bằng `await stillPendingAfter(() => pending, 500)`.
   - Chạy: `npm run test:services -- --runInBand` (cần Docker, đã bật).
   - Commit: `fix(test): dùng stillPendingAfter, tránh unhandled rejection khi pause Valkey (DBS-40)`.

4. **Xác minh toàn diện + bàn giao** (Phase 4b/4c/5)
   - Chạy đủ baseline (`lint:check`, `typecheck`, `build`, `test`, `test:e2e`, `test:db`, `test:services`) trên commit cuối.
   - Chạy lại M-40-01…03 trên Docker thật (không có bước tay mới — các fix không đổi hành vi quan sát được của `test:services`); chụp ảnh/transcript mới nếu output khác bản vòng 1.
   - Cập nhật §8/§9, xóa dòng BL đã đóng (không có — hai dòng BL-055/056 do task này sinh ra, không đóng), kiểm `check-doc-links.mjs`.

Rollback vòng 2: `git revert` các commit vòng 2 theo thứ tự ngược; không chạm `postgres.container.ts` ngoài tham số `contextLabel` (xóa param đó bằng revert cũng an toàn vì có default). Không chạm dữ liệu Compose hoặc AWS.

**Sweep theo DoD/limitations:** 8 finding gốc → bước 1 (#3 một phần), bước 2 (#1, #2, #3 phần còn lại, #6, #7), bước 3 (#4); #5 (trùng lặp khung timeout) và #8 (test tuần tự) ngoài phạm vi, đã ghi BL-055/BL-056 ở §3/§8. Không có dòng `docs/BACKLOG.md` nào khác cùng module `test/support/` cần xử lý trong PR này (đã rà `BL-016`, `BL-017`, `BL-053`, `BL-054` ở §1 vòng 1 — không đổi).

## 8. Kết quả

Commit code cuối: `83b9803341b26fbd69d7e32d5280b73ea8b65d28`. Test thủ công chạy trên SHA này, [output UTF-8](screenshots/DBS-40/manual-test.txt). Compose Valkey và ElasticMQ đã được dừng trước sample; `docker compose ps` lúc đó chỉ còn `postgres`. Suite tự tạo bốn container trên các cổng động, xác nhận SET/GET, SQS send/receive, pause timeout/resume, stop/restart; đối chiếu ID cho thấy mỗi container đã bị xóa. Sau test, Compose được khôi phục. Kịch bản Docker không truy cập được dùng `DOCKER_HOST=tcp://127.0.0.1:1`, exit 1 với lỗi `[Testcontainers] Docker is not running or unreachable`; không skip.

| Kiểm tra | Kết quả |
|---|---|
| `npm run lint:check`, `npm run typecheck`, `npm run build` | đạt |
| `npm test -- --runInBand` | 26 suite / 369 test đạt |
| `npm run test:e2e -- --runInBand` | 4 suite / 25 test đạt |
| `npm run test:db -- --runInBand` | 8 suite / 154 test đạt trên PostgreSQL 17 thật |
| `npm run test:services -- --runInBand` | 1 suite / 2 integration test đạt; Compose Valkey/ElasticMQ đã tắt trong manual run |

| Case | Bằng chứng | Kết luận |
|---|---|---|
| TC-40-01/02 | `testcontainers.services-spec.ts` + M-40-01 | đạt |
| TC-40-03/04 | Cùng suite + M-40-02, pause/resume/down/restart | đạt; pause mô phỏng không phản hồi, không có proxy độ trễ hữu hạn |
| TC-40-05 | `service-container.spec.ts` + M-40-03 | đạt |
| TC-40-06 | [PR #18](https://github.com/Lawliet119/digital-banking-simulator/pull/18) đã mở; [CI 6/6 xanh](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/40092690598); Dev review, merge | chưa đạt đủ, BL-054 |

![Output thật của sample service](screenshots/DBS-40/01-services-success.png)

![Output lỗi Docker không truy cập được](screenshots/DBS-40/02-docker-unreachable.png)

Hai ảnh là phần hiển thị được dựng từ **dòng output thật** trong `manual-test.txt`; transcript đầy đủ có container ID, cổng và exit code. Không có credential AWS thật. Không có `.skip` trong task test; lượt test chọn riêng Valkey khi debug có 1 test không được chọn, lượt cuối chạy đủ 2/2.

CI hiện tại chưa gọi `test:services`; [BL-053](../BACKLOG.md) bàn giao việc này cho DBS-41. [PR #18](https://github.com/Lawliet119/digital-banking-simulator/pull/18) đã mở và [CI 6/6 xanh](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/40092690598); Dev review/merge [BL-054](../BACKLOG.md) còn chờ; không kéo Done.

Checklist bàn giao: test case kỹ thuật TC-40-01…05 đạt, TC-40-06 còn chờ Dev review/merge; M-40-01…03 đã chạy trên commit code cuối; ảnh và transcript không chứa token/secret thật; link check 93 file, 0 link hỏng. CI 6/6 xanh; chưa có Dev review.

### Vòng 2 (2026-10-28 → 2026-10-30)

Các commit vòng 2: `2e82fce` (lockfile), `b2654a2` (bước 1), `5c241f7` (bước 2), `0edb96a` (bước 3), `bb0ac02` (bước 4 phát sinh, xem Lệch kế hoạch). Test thủ công chạy trên `bb0ac02`, commit cuối có đổi code: [output UTF-8](screenshots/DBS-40/manual-test.txt) (dòng đầu là SHA). Compose Valkey và ElasticMQ đã dừng trước khi chạy; `test:services` tự tạo container riêng. Không có secret trong transcript (đã quét `token|password|secret|AKIA|Authorization`, 0 kết quả).

| Kiểm tra (trên `bb0ac02`) | Kết quả |
|---|---|
| `npm run lint:check`, `npm run typecheck`, `npm run build` | đạt |
| `npm test -- --runInBand` | 33 suite / 516 test đạt |
| `npm run test:db -- --runInBand` | 8 suite / 154 test đạt (Testcontainers, PostgreSQL 17) |
| `npm run test:e2e -- --runInBand` | 8 suite / 57 test đạt, chạy trên Postgres tạm cổng 5433 (xem Môi trường) |
| `npm run test:services -- --runInBand` | 1 suite / 2 test đạt; 3 lần liên tiếp xanh sau bản sửa Valkey |

| Case | Bằng chứng | Kết luận |
|---|---|---|
| TC-40-07, 10, 11, 12 | `service-container.spec.ts` | đạt |
| TC-40-08, 09 | `elasticmq.container.spec.ts`, `valkey.container.spec.ts` | đạt |
| TC-40-13 | `valkey.container.spec.ts` (6 case) | đạt |
| M-40-01/02 | `manual-test.txt`, `test:services` 2/2, exit 0 | đạt |
| M-40-03 | `DOCKER_HOST=tcp://127.0.0.1:1`, exit 1, lỗi `Docker is not running or unreachable ... service container tests (Valkey/ElasticMQ)`, không skip | đạt |
| TC-40-06 | PR #18: CI đỏ ở `8e27b30` (xem Lệch kế hoạch), chưa có Dev review | chưa đạt, BL-054 |

**Lệch kế hoạch §7 (đã được duyệt):** bước 4 trong §7 là xác minh, nhưng test thủ công lộ lỗi thật: `test:services` đỏ 2/2 lần ở nhánh "recovered" của Valkey. Probe Valkey chỉ kết nối một lần; ngay sau khi container sẵn sàng, Docker Desktop (Windows) có thể chưa nối xong cổng nên lần connect đầu bị `ECONNREFUSED` (tái hiện độc lập: lần 1 từ chối, lần 2 `PONG`). Khi đó `client.destroy()` trong `finally` ném `ClientClosedError` và che lỗi thật. Người dùng duyệt mở rộng scope; sửa bằng `probeValkey` có retry và thêm TC-40-13, commit `bb0ac02`. Ngân sách probe Valkey đổi từ 10s lên 45s (retry 10×3000 + 9×250 = 32,25s, biên ~39%).

**Môi trường (không thuộc DBS-40):** máy này có PostgreSQL 18 native (dịch vụ Windows `postgresql-x64-18`) chiếm cổng 5432 nên container compose không nhận kết nối TCP (`28P01`). Không dừng được dịch vụ vì không có quyền Admin, nên `test:e2e` chạy trên một container Postgres tạm cổng 5433 với `DATABASE_URL` tương ứng (đã xóa sau khi chạy), đúng cách `manual-testing.md` mô tả. `docker-compose.yml` không bị sửa. CI trên GitHub không bị ảnh hưởng.

**Ảnh minh họa:** `01-services-success.png` và `02-docker-unreachable.png` là ảnh của vòng 1 (commit `83b9803`); chưa chụp lại cho `bb0ac02`. Transcript `manual-test.txt` đã là của vòng 2. Người dùng cần chấp nhận từng ảnh theo tên ở G4, hoặc yêu cầu chụp lại.

**Việc còn lại trước khi merge:** (1) chưa push, nên PR #18 vẫn ở `8e27b30` với CI đỏ ở `npm ci` (thiếu `@emnapi/core`, `@emnapi/runtime` trong lockfile); `2e82fce` sửa việc này, nhưng chỉ chạy lại CI sau khi push mới xác nhận được, vì `npm ci --dry-run` trên lockfile cũ cục bộ không tái hiện lỗi; (2) mô tả PR còn số cũ (369 unit, `BL-023`), cần cập nhật khi push; (3) Dev khác review (BL-054).

Hai quyết định hoãn trong vòng này đã có số backlog: **BL-055** (hợp nhất khung start/stop/timeout `postgres.container.ts`/`service-container.ts`), **BL-056** (hoãn `it.concurrent` cho hai lifecycle test độc lập), cả hai đã nằm trong `docs/BACKLOG.md`.

## 9. Tài liệu đã cập nhật

[`backend/README`](../../backend/README.md) có lệnh chạy và giới hạn pause; [feature index](README.md) thêm DBS-40; [`BACKLOG`](../BACKLOG.md) thêm BL-053/054 (đổi từ BL-023/024 khi rebase: trùng số đã dùng cho DBS-42 trên main). Không sửa ADR, docs/03, schema hoặc env var vì không thay kiến trúc runtime.

**Vòng 2:** [`BACKLOG`](../BACKLOG.md) thêm BL-055 (hợp nhất khung start/stop/timeout `postgres.container.ts`/`service-container.ts`) và BL-056 (hoãn `it.concurrent` cho hai lifecycle test độc lập).
