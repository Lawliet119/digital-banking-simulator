# Demo 4 · Security & audit review

> **Status:** Draft (chưa quay; bằng chứng hiện có là các test tự động và lần chạy tay của [DBS-135](../features/DBS-135-trace-by-correlation-id.md) §5) · **Owner:** Dev · **Nguồn:** [DBS-158](../features/DBS-158-security-suite.md) DoD 3, BL-237 · **Cập nhật:** 2026-11-13

Demo bắt buộc "Security & audit review" ([docs/03 §17](../03_HIGH_LEVEL_ARCHITECTURE.md#17-demo-bắt-buộc)): chứng minh khách không chạm được dữ liệu của khách khác, khóa tài khoản có hiệu lực ngay, kiểm toán viên chỉ đọc, và một giao dịch truy được trọn chuỗi bằng một mã. Mỗi bước dưới đây có lệnh chạy tay để quay và test tự động chứng minh cùng điều đó.

| Phần | Nội dung | AC | Test tự động chính |
|---|---|---|---|
| A | Khách A truy cập tài khoản hoặc giao dịch của khách B: 404 như thể không tồn tại, có nhật ký `DENIED` | AC-5.8 | TC-86-02/03, TC-87-06, TC-61-03, TC-65-05, TC-159-03 |
| B | Dùng lại `Idempotency-Key` của khách khác: không lộ gì | AC-5.8 | TC-159-01, TC-159-02, TC-159-04 |
| C | Khóa tài khoản: yêu cầu kế tiếp của chủ tài khoản bị từ chối | AC-11.1 | TC-159-07, TC-113-04, TC-114-01, TC-114-04..08 |
| D | Kiểm toán viên chỉ đọc; sổ nhật ký chỉ thêm | AC-8.1 | TC-158-02, TC-103-07, TC-103-16, TC-27-04..06 |
| E | Truy một giao dịch theo `correlationId` | AC-8.2 | TC-135-01..05 |
| — | Khách không thấy cờ gian lận; lỗi không lộ nội bộ | AC-10.2 | TC-87-09, TC-158-01 |

## Chuẩn bị chung

Từ thư mục gốc repo, rồi từ `backend/` (chi tiết ở [backend/README.md](../../backend/README.md), mục "Chạy local" và mục 10):

```bash
docker compose up -d                       # PostgreSQL, Valkey, ElasticMQ
cd backend
npm install
cp env/.env.example env/.env.development   # chú thích mọi dòng COGNITO_*, thêm AUTH_MODE=local và AUTH_LOCAL_JWKS_PATH=.auth-local/jwks.json
npm run auth:dev-keys
npm run migration:run
npm run start:dev                          # APP_ROLE=both: API và worker cùng một process
```

Phần E cần worker chạy để có `notification.sent` và `fraud.flagged`. Muốn kill riêng worker như [DBS-135 M-135-08](../features/DBS-135-trace-by-correlation-id.md#5-test-thủ-công), chạy hai process như phần "Chuẩn bị chung" của [Demo 3](demo-3-failure-recovery.md#chuẩn-bị-chung).

**Token** (sống 15 phút, lấy lại khi hết hạn; không dán vào chat hay commit):

```bash
export API=http://localhost:3000
tok() { npm run --silent auth:dev-token -- --role "$1" ${2:+--sub "$2"}; }
export AN=$(tok customer tran-van-an) BINH=$(tok customer nguyen-thi-binh)
export OP=$(tok operator) AUD=$(tok auditor)
```

**Dữ liệu mở màn** (chạy một lần; dùng hai khách mới để cờ gian lận xuất hiện đúng như [DBS-135 M-135-01..02](../features/DBS-135-trace-by-correlation-id.md#5-test-thủ-công)):

| Việc | Lệnh | Kết quả mong đợi |
|---|---|---|
| Onboard hai khách | `curl -sS -X POST $API/v1/customers/me -H "Authorization: Bearer $AN" -H 'Content-Type: application/json' -d '{"fullName":"Trần Văn An"}'`; tương tự với `$BINH` và `"Nguyễn Thị Bình"` | 200 |
| Mở tài khoản | `curl -sS -X POST $API/v1/accounts -H "Authorization: Bearer $AN" -H 'Content-Type: application/json' -d '{"type":"CHECKING"}'`; tương tự với `$BINH` | 201; ghi `id` thành `AN_ACC`, `BINH_ACC` |
| Nạp tiền cho An | `curl -sS -X POST $API/v1/operator/deposits -H "Authorization: Bearer $OP" -H 'Idempotency-Key: demo4-dep-1' -H 'Content-Type: application/json' -d "{\"toAccountId\":\"$AN_ACC\",\"amount\":\"21000000\"}"` | 201 `COMPLETED` |
| An chuyển cho Bình | `curl -sS -i -X POST $API/v1/transfers -H "Authorization: Bearer $AN" -H 'Idempotency-Key: demo4-K1' -H 'Content-Type: application/json' -d "{\"fromAccountId\":\"$AN_ACC\",\"toAccountId\":\"$BINH_ACC\",\"amount\":\"20000000\"}"` | 201 `COMPLETED`; ghi `transferId` thành `T` và header `X-Correlation-Id` thành `C` |

Chuyển 20.000.000đ từ nguồn mới tới người nhận mới đạt ngưỡng R3 + R6 = 65 điểm (MEDIUM), nên worker tạo cờ vài trăm ms sau ([Demo 3 phần B](demo-3-failure-recovery.md#b-worker-chết-cờ-vẫn-xuất-hiện-dbs-124)).

## A. Truy cập chéo → 404 và nhật ký (AC-5.8)

| Bước | Làm | Kết quả mong đợi | Test chứng minh |
|---|---|---|---|
| A1 | Bình đọc tài khoản của An: `curl -sS -i $API/v1/accounts/$AN_ACC -H "Authorization: Bearer $BINH"` | 404 `application/problem+json` có `correlationId`, không có số dư hay chủ tài khoản. Cùng hình dạng với tài khoản không tồn tại, tài khoản `SYSTEM` và id sai dạng | TC-64-03 (`test/db/account-reads.db-spec.ts`, HTTP); TC-86-02/03 (`test/db/resource-ownership.db-spec.ts`, tầng service) |
| A2 | Bình xem giao dịch của An: `curl -sS -i $API/v1/transfers/$T -H "Authorization: Bearer $BINH"` | 404; thân không chứa `T`, số tiền hay hai id tài khoản. An gọi cùng lệnh thì 200 | TC-159-03 (`test/db/auth-attacks.db-spec.ts`) |
| A3 | Bình xem lịch sử của tài khoản An: `curl -sS -i $API/v1/accounts/$AN_ACC/transactions -H "Authorization: Bearer $BINH"` | 404, cùng câu trả lời với tài khoản không tồn tại | TC-87-06 (`test/db/transaction-history.db-spec.ts`) |
| A4 | Bình chuyển từ tài khoản của An (`fromAccountId=$AN_ACC`), key mới | 404, không có `errorCode`, không tạo `transfers`, `ledger_entries`, `outbox_events` | TC-61-03 (`test/db/customer-transfers.db-spec.ts`), TC-65-05 (`test/db/money-flow.db-spec.ts`), TC-159-01 (số dòng các bảng không đổi) |
| A5 | Auditor tra nhật ký: `curl -sS --get $API/v1/audit/entries -H "Authorization: Bearer $AUD" --data-urlencode 'action=account.read'` (lặp với `transfer.read`, `ledger.transfer`) | Có dòng `outcome: "DENIED"`, `actorRole: "customer"`, `actorUserId` là của Bình, `correlationId` bằng `correlationId` của phản hồi 404 ở bước tương ứng | TC-159-01, TC-159-03 (đối chiếu `audit_log` theo `correlationId` của phản hồi 404); TC-86-02 (đúng một dòng `DENIED` có chủ thể, tầng service); TC-64-03 |

Lý do 404 thay vì 403: không tiết lộ tài khoản đó có tồn tại ([docs/03 §7](../03_HIGH_LEVEL_ARCHITECTURE.md#7-api-tổng-quan)). Chủ ý nói khi quay: audit `DENIED` ghi **trước** khi trả 404.

## B. Dùng lại mã yêu cầu của người khác (AC-5.8)

| Bước | Làm | Kết quả mong đợi | Test chứng minh |
|---|---|---|---|
| B1 | Bình gửi lại **đúng** `Idempotency-Key: demo4-K1` và đúng thân lệnh chuyển của An (bước "An chuyển cho Bình") | 404 thường của nguồn không thuộc mình, không có `transferId`, số tiền hay `errorCode`; không dòng nào mới trong `transfers`, `idempotency_keys`, `ledger_entries`, `outbox_events` | TC-159-01 |
| B2 | Bình gửi cùng thân nhưng `fromAccountId` là UUID ngẫu nhiên | Thân phản hồi y hệt B1 (trừ `correlationId`): mã yêu cầu không nói gì thêm | TC-159-01 |
| B3 | Bình dùng cùng key cho lệnh chuyển của chính mình | Một lệnh mới, độc lập; An vẫn replay được lệnh cũ. Key theo từng người dùng | TC-159-02, TC-159-04 (nạp tiền: key theo từng operator) |

## C. Khóa tài khoản → yêu cầu kế tiếp bị từ chối (AC-11.1)

| Bước | Làm | Kết quả mong đợi | Test chứng minh |
|---|---|---|---|
| C1 | Trước khi khóa, An gọi `curl -sS -o /dev/null -w '%{http_code}\n' $API/v1/accounts -H "Authorization: Bearer $AN"` | 200 | TC-159-07 |
| C2 | Operator khóa: `curl -sS -X POST $API/v1/operator/accounts/$AN_ACC/lock -H "Authorization: Bearer $OP" -H 'Content-Type: application/json' -d '{"reason":"CONFIRMED_FRAUD"}'` | 200 `{id,type,status:"LOCKED",updatedAt}`, không có số dư | TC-113-01 (`test/db/operator-account-status.db-spec.ts`) |
| C3 | An lặp lại đúng lệnh ở C1 với **token cũ** | 401 `SESSION_REVOKED` ngay, không chờ token hết hạn; thử cả một lệnh chuyển từ tài khoản còn `ACTIVE` của An: cũng 401, không ghi gì | TC-159-07, TC-113-04, TC-114-01 (đường Redis), TC-114-04 và TC-114-05..07 (Redis xóa, chậm hoặc chết vẫn không mở lại token cũ) |
| C4 | Bình chuyển cho tài khoản đã khóa của An | 422 `ACCOUNT_NOT_ACTIVE` kèm `transferId` (lệnh bị từ chối vẫn được lưu) | TC-113-04 |
| C5 | Auditor tra `action=account.lock`; operator mở khóa (`/unlock`, `{"reason":"OPERATOR_UNLOCK"}`); chờ qua giây kế tiếp rồi lấy token mới cho An (`AN=$(tok customer tran-van-an)`) | Có dòng `account.lock` do operator; sau mở khóa, token **cấp sau** thời điểm khóa dùng được, token cũ vẫn 401 | TC-113-02, TC-159-07 (nửa sau), TC-114-08 |

Giới hạn khi giải thích: thu hồi dựa trên mốc `users.sessions_revoked_at` (giây) so với `iat` của token; token cấp trong cùng giây với lệnh khóa vẫn bị coi là cũ ([docs/03 §7](../03_HIGH_LEVEL_ARCHITECTURE.md#7-api-tổng-quan), dòng `lock`).

## D. Kiểm toán viên chỉ đọc (AC-8.1)

| Bước | Làm | Kết quả mong đợi | Test chứng minh |
|---|---|---|---|
| D1 | Auditor thử từng route ghi, ví dụ `curl -sS -i -X POST $API/v1/operator/deposits -H "Authorization: Bearer $AUD" -H 'Idempotency-Key: demo4-aud' -H 'Content-Type: application/json' -d "{\"toAccountId\":\"$BINH_ACC\",\"amount\":\"1000\"}"`; lặp với `/v1/transfers`, `/v1/accounts`, `/v1/customers/me`, `lock`, `unlock`, `fraud-flags/<id>/review` | Cả bảy route: 403 `FORBIDDEN`; số dòng của `transfers`, `ledger_entries`, `accounts`, `customers`, `outbox_events`, `fraud_flags` không đổi; `audit_log` chỉ tăng đúng một dòng `access.denied` cho mỗi lần bị từ chối | TC-158-02 (`test/security/security-boundaries.db-spec.ts`), TC-159-10 |
| D2 | Auditor gửi `POST`, `PUT`, `PATCH`, `DELETE` tới `/v1/audit/entries` | 404: API không có route sửa hay xóa nhật ký; băm toàn bộ `audit_log` trước và sau bằng nhau | TC-103-16 (`test/db/audit-search.http.db-spec.ts`) |
| D3 | Customer, operator, admin gọi `GET /v1/audit/entries` | 403 `FORBIDDEN` (kể cả khi gắn "auditor" vào header, query hoặc thân) | TC-103-07 |
| D4 | Ngay cả người có quyền DB cũng không sửa được: `docker compose exec postgres psql -U banking -d banking -c "UPDATE audit_log SET outcome='SUCCESS' WHERE id=(SELECT min(id) FROM audit_log)"` | `ERROR: UPDATE on audit_log is not allowed (append-only)`; `DELETE` và `TRUNCATE` cũng bị chặn | TC-27-04, TC-27-05, TC-27-06 (`test/db/append-only.db-spec.ts`, có `audit_log`) |

Từ BL-132 ([#161](https://github.com/Lawliet119/digital-banking-simulator/pull/161)), 403 do `RolesGuard` ghi dòng audit `access.denied` (`outcome: "DENIED"`, `metadata.reason: "NO_PERMISSION"`, `target` là route bị gọi), giống 404 quyền sở hữu ở phần A. Kiểm bằng auditor: `curl -sS --get $API/v1/audit/entries -H "Authorization: Bearer $AUD" --data-urlencode "action=access.denied"` (đã chạy ở bước 9 của [demo giữa kỳ](demo-midterm-end-to-end.md#bước-9--ca-từ-chối), DBS-138).

## E. Truy một giao dịch bằng một mã (AC-8.2)

Mã `C` là header `X-Correlation-Id` của phản hồi chuyển tiền ở phần chuẩn bị (client không tự đặt được: server bỏ qua giá trị gửi lên).

| Bước | Làm | Kết quả mong đợi | Test chứng minh |
|---|---|---|---|
| E1 | Chờ vài giây; operator xem cờ: `curl -sS $API/v1/operator/fraud-flags -H "Authorization: Bearer $OP"` | Có một cờ với `transferId` = `T`, `riskLevel` MEDIUM, `reviewStatus` OPEN; điểm 65 nếu rule set là rule-only (nếu đang bật AI, điểm có thể khác: [DBS-135 M-135-00](../features/DBS-135-trace-by-correlation-id.md#5-test-thủ-công)) | TC-135-01 |
| E2 | Operator review: `curl -sS -i -X POST $API/v1/operator/fraud-flags/$T/review -H "Authorization: Bearer $OP" -H 'Content-Type: application/json' -d '{"decision":"CONFIRMED_FRAUD"}'` | 200; header `X-Correlation-Id` **khác** `C` (đó là mã của request review) | TC-135-03 |
| E3 | **Bấm giờ.** Auditor tra: `curl -sS --get $API/v1/audit/entries -H "Authorization: Bearer $AUD" --data-urlencode "correlationId=$C"` | Đúng 4 `entries` cùng `correlationId` `C`: `transfer` (sớm nhất), `notification.sent`, `fraud.flagged`, `fraud_flag.review` (muộn nhất; `metadata.id` là mã request review). Nếu operator có mở chi tiết cờ (`GET /v1/operator/fraud-flags/$T`) trước khi review thì có thêm một dòng `fraud_flag.view` (BL-226) ngay trước dòng review, `metadata.id` là mã request xem; danh sách `GET /v1/operator/fraud-flags` ở E1 không thêm dòng vào chuỗi. Mục tiêu dưới 5 phút từ lúc auditor nhận `C` (NFR-AUD-02) | TC-135-01, TC-135-02 (metadata chỉ có `id`, `count`, `reason`; không rule, điểm hay ghi chú review) |
| E4 | Tra một UUID lạ; tra `C` lần nữa; review lần hai | `entries: []`; vẫn đúng 4 dòng (các dòng `audit.search` mang mã của chính lần tra); review lần hai 409 `FLAG_ALREADY_REVIEWED` và không thêm dòng | TC-135-04, TC-135-05 |
| E5 | Chỉ ra truy vấn rẻ: dùng `Index Scan` trên `audit_log_correlation_idx`, ≤ 10 ms | Kết quả có sẵn trong test, không cần chạy tay | TC-103-18 (`test/db/audit-search.db-spec.ts`) |

Lần chạy tay đã đo thời gian: [DBS-135 §5](../features/DBS-135-trace-by-correlation-id.md#5-test-thủ-công) (M-135-01..08, kể cả dừng worker rồi bật lại, không dòng nào nhân đôi).

## Khách không thấy cờ, lỗi không lộ nội bộ (AC-10.2)

Thêm vào kịch bản như một đoạn ngắn sau phần E:

| Bước | Làm | Kết quả mong đợi | Test chứng minh |
|---|---|---|---|
| F1 | An gọi `GET /v1/accounts/$AN_ACC/transactions` và `GET /v1/transfers/$T` (giao dịch `T` đang có cờ) | 200; không có trường nào về cờ, điểm hay mức rủi ro | TC-87-09 (`test/db/transaction-history.db-spec.ts` và `test/db/transfer-status.db-spec.ts`) |
| F2 | An hoặc Bình gọi `GET /v1/operator/fraud-flags` | 403 `FORBIDDEN`, không lộ cờ có tồn tại hay không | test «enforces actual signed token roles and does not expose existence» (`test/db/fraud-operator-http.db-spec.ts`, chưa có id) |
| F3 | Gọi không token, sai vai, id sai dạng, query sai, route lạ; gọi bằng token hết hạn | 401, 403, 404, 400, 404; token hết hạn 401 `TOKEN_EXPIRED`. Tất cả `application/problem+json` có `correlationId`; không có `stack`, đường dẫn `.ts`, câu SQL | TC-158-01 (năm lỗi đầu), TC-159-05, TC-159-06 |

## Chạy bộ test tự động

Cần Docker bật (`test:db` tự dựng PostgreSQL 17 bằng Testcontainers khi không có `DATABASE_URL`; `test:services` dựng ElasticMQ). Từ `backend/`:

```bash
# Phần mới của DBS-158: lỗi problem+json, auditor bị từ chối trên mọi route ghi (TC-158-01, TC-158-02)
npm run test:db -- --runInBand test/security

# Toàn bộ test dùng làm bằng chứng cho Demo 4 (A đến D, F)
npm run test:db -- --runInBand \
  test/security \
  test/db/resource-ownership.db-spec.ts test/db/transaction-history.db-spec.ts \
  test/db/transfer-status.db-spec.ts test/db/customer-transfers.db-spec.ts \
  test/db/money-flow.db-spec.ts test/db/auth-attacks.db-spec.ts \
  test/db/operator-account-status.db-spec.ts test/db/session-revocation-cache.db-spec.ts \
  test/db/audit-search.http.db-spec.ts test/db/audit-search.db-spec.ts \
  test/db/fraud-operator-http.db-spec.ts test/db/notification-consumer.db-spec.ts \
  test/db/append-only.db-spec.ts

# Phần E: chuỗi giao dịch, thông báo, cờ, review (TC-135-01..05; HTTP thật, PostgreSQL và ElasticMQ).
# test:services không tự dựng PostgreSQL: cần DATABASE_URL trỏ tới một PostgreSQL 17 chạy sẵn
# (ví dụ docker run -d --rm -p 55433:5432 -e POSTGRES_USER=test -e POSTGRES_PASSWORD=test postgres:17)
DATABASE_URL=postgres://test:test@localhost:55433/postgres \
  npm run test:services -- --runInBand --runTestsByPath test/services/audit-trace.services-spec.ts
```

Đã chạy lại các lệnh trên ngày 2026-11-13 trên `main` `f48ee33` cộng các commit tài liệu này (Node 24.22.2, Windows): `test/security` cùng 11 file `test:db` đầu danh sách đạt 12 suite / 199 test; `account-reads`, `audit-search` và `append-only` đạt 3 suite / 46 test; `audit-trace.services-spec.ts` đạt 3/3. Chạy `test:services` không có `DATABASE_URL` thì cả ba test đỏ với lỗi "DATABASE_URL is not set".

`--runInBand` cần khi chạy nhiều file một lúc: các file `test:db` cùng tạo role DB và tranh nhau nếu chạy song song. CI chạy `npm run test:db` (job `db`, gồm `test/security` nhờ regex ở `backend/test/jest-db.js`) và từng file `test:services` (bước `audit-trace` ở `.github/workflows/ci.yml`).

## Kịch bản quay (thứ tự và thời lượng gợi ý)

1. Mở màn (1 phút): nói mục tiêu, chạy "Dữ liệu mở màn" (đã chuẩn bị trước nếu muốn quay gọn).
2. A và B (3 phút): A1, A2, A4, A5; B1, B2. Nhấn mạnh 404 giống hệt id không tồn tại và dòng `DENIED`.
3. C (3 phút): C1 đến C5. Nhấn mạnh "không chờ phiên hết hạn".
4. D (2 phút): D1 (một vài route, rồi tra `action=access.denied`), D2, D4.
5. E (4 phút): E1 đến E4, bấm giờ ở E3.
6. F và kết (1 phút): F1, F3; chạy lệnh `test/security` cho thấy 2 test đạt.

## Giới hạn hiện tại

- Chưa có lần quay: các lệnh chạy tay lấy từ README, [DBS-113](../features/DBS-113-lock-unlock-account.md), [DBS-135](../features/DBS-135-trace-by-correlation-id.md) và test; cần chạy thử trọn một lượt trước khi quay.
- Suite `test/security` chỉ có hai test mới (TC-158-01, TC-158-02); AC-5.8 và AC-10.2 dựa vào test có sẵn ở DBS-86, 87, 61, 65, 159 như bảng đầu trang ([DBS-158 §1](../features/DBS-158-security-suite.md#1-bối-cảnh)).
- Demo chạy local (`AUTH_MODE=local`). Trên AWS dùng `infra/scripts/demo-token.sh` và checklist ở [demo-checklist](../runbooks/demo-checklist.md); chưa kiểm demo này trên cloud.
