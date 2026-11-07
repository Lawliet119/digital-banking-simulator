# DBS-79 · Idempotency: ON CONFLICT DO NOTHING, replay đúng kết quả cũ, request_hash

> **Status:** Implemented · **Vai:** Dev · **Nhánh:** `feat/DBS-79-idempotency-replay` · **PR:** [#69](https://github.com/Lawliet119/digital-banking-simulator/pull/69) · **Cập nhật:** 2026-11-08
>
> Techlead waiver: G1–G4 do agent tự duyệt theo yêu cầu của techlead (không có người duyệt từng gate); không có Dev khác review trước merge; không có ảnh PNG, bằng chứng là `manual-test.txt` thô; domain review do chính agent làm, không dùng subagent (§6).

## 1. Bối cảnh

- **Task trên board:** Story, Tuần 3, Dev, ưu tiên Highest, Demo 2. **Expect:** «Gửi lại cùng một lệnh bao nhiêu lần cũng chỉ trừ tiền một lần.»
- **DoD:**
  1. Thứ tự đúng docs/03 §6.1: `INSERT idempotency_keys … ON CONFLICT DO NOTHING` trước; nếu đã có: SELECT response lưu sẵn và trả lại; `request_hash` khác → `IDEMPOTENCY_KEY_REUSED` (422).
  2. Lưu `response_code`/`response_body` vào key cuối transaction rồi mới commit.
  3. AC-5.3 (gửi lại cùng nội dung → đúng kết quả cũ), AC-5.4 (10 request song song cùng key → 1 giao dịch, 2 bút toán, 10 phản hồi giống nhau), AC-5.5 (cùng key khác số tiền → từ chối) xanh trên Postgres thật.
  4. Số tiền > 2^53 đi hết đường API → DB → response không mất chữ số.
  5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ.
- **Phụ thuộc:** DBS-61 và DBS-60 đều đã vào `main`.
- **Cột «Thực trạng» của board đã cũ.** Nó ghi «chưa xử lý replay hay xung đột», nhưng #65 (`1d75e18`) đã thêm `LedgerPostingService.claimKey/replay/storeResult` dùng chung cho nạp tiền và chuyển tiền. Đã chạy lại trên `main` `a71713d` (Node 24.11.1): `lint:check`, `typecheck` sạch, `npm test` 1062/1062, `test:db -- customer-transfers operator-deposits` 48/48 (gồm TC-79-01..06).
- **Đối chiếu DoD với `main`:**

| DoD | Hiện trạng trên `main` | Khoảng trống task này lấp |
|---|---|---|
| #1 thứ tự, REUSED | Có (`claimKey`, `ledger-posting.service.ts`); TC-79-01..02 | Không |
| #2 lưu kết quả cuối transaction | Có (`storeResult` là câu ghi cuối, TC-61-08 hỏng đúng câu này) | Không |
| #3 AC-5.3, AC-5.5 | Có (TC-79-01, 02) | Không |
| #3 AC-5.4 | Chỉ kiểm «cùng `transferId`, 1 dòng `transfers`» (TC-61-07); **không** kiểm 2 bút toán, 1 audit/outbox/key, hay 10 body giống hệt; chưa có ca 10 lệnh song song bị từ chối | Thêm TC-79-07, 08 |
| #4 > 2^53 | Có cho đường đi lần đầu (TC-61-10); **chưa** có replay và chưa chứng minh `request_hash` phân biệt `…992` với `…993` (hai số này bằng nhau khi ép sang `number`) | Thêm TC-79-09 |
| ADR-05: hash «sắp xếp khóa JSON» | `hashRequest` băm `JSON.stringify` theo **thứ tự khóa người gọi viết**; đúng hôm nay vì hai người gọi tình cờ viết theo bảng chữ cái, nhưng không có gì ép buộc | Sắp xếp khóa trong `hashRequest` (TC-79-11); giá trị băm hiện có không đổi |
| Replay của 422 | Có (TC-79-03) nhưng chỉ so `errorCode` và `transferId` | Thêm so cả body (TC-79-10) |
| #5 | Quy trình | Ghi waiver |

- **Ngoài phạm vi:** lệnh gốc rollback khi lệnh cùng key đang chờ (DBS-81); retry deadlock và timeout (DBS-80); xóa key quá 7 ngày (DBS-136); AC-5.10 trên cloud (DBS-185); key của user khác không lộ response (DBS-159, đã có một phần ở TC-61-07).
- **Backlog:** không có dòng nào trên cùng module/DoD cần lấy vào task này (BL-148 đã bị xóa ở #65).
- **Câu hỏi mở / quyết định ở G1 (agent tự duyệt):** (1) Giữ nguyên hành vi API; chỉ siết test và chuẩn hóa hash — không đổi `ErrorCode`, schema, event, env. (2) Sắp xếp khóa **đệ quy** để bám ADR-05, vì hôm nay body chỉ phẳng nhưng hàm nhận `Record`.

## 2. Hành vi

Không đổi hành vi nhìn thấy từ API; đây là các hành vi được chứng minh (tất cả đã đúng trên `main`, trừ hash phụ thuộc thứ tự khóa của người gọi):

| # | Điều kiện | Kết quả |
|---|---|---|
| B1 | Key mới | Chạy lệnh, ghi kết quả vào key ở câu cuối, commit; 201 hoặc 422 đã lưu |
| B2 | Key đã có, cùng `request_hash` | Trả lại đúng `response_code` và `response_body` đã lưu (201 hoặc cùng 422 và `transferId`); không ghi dòng nào mới |
| B3 | Key đã có, `request_hash` khác (số tiền, nguồn, đích hoặc path khác) | 422 `IDEMPOTENCY_KEY_REUSED`, không đổi gì |
| B4 | 10 lệnh cùng key chạy song song | Một lệnh thực hiện; chín lệnh chờ ở `INSERT … ON CONFLICT`, rồi đọc kết quả đã lưu; cả 10 body giống hệt; 1 transfer, 2 bút toán, 1 audit, 1 outbox, 1 key |
| B5 | Số tiền > 2^53 (ví dụ `9007199254740993`) | Giữ nguyên chuỗi ở body, DB, bút toán, event, replay; `…993` và `…992` cho hai hash khác nhau nên đổi số tiền như vậy là `IDEMPOTENCY_KEY_REUSED` |
| B6 | `request_hash` | SHA-256 hex của `JSON.stringify({method, path, body})` với **mọi khóa của `body` được sắp xếp (đệ quy)**; cùng nội dung viết khác thứ tự khóa cho cùng hash |

Ví dụ B3 (422, `application/problem+json`):

```json
{ "errorCode": "IDEMPOTENCY_KEY_REUSED", "type": "about:blank", "title": "Unprocessable Entity", "status": 422, "detail": "Idempotency-Key was already used with a different request", "correlationId": "…" }
```

## 3. Kiến trúc

- **Vị trí:** module `ledger`, role `api`. File đổi: `ledger-posting.service.ts` (`hashRequest`). Không đổi người gọi: `TransferService`, `DepositService` (`grep hashRequest` → đúng hai nơi).
- **Interface:** `hashRequest(path: string, body: Record<string, string>): string` giữ nguyên chữ ký; bên trong sắp xếp khóa.
- **Dữ liệu:** `idempotency_keys(user_id, idem_key, request_hash, transfer_id, response_code, response_body)`; không đổi schema.
- **Transaction:** không đổi; `claimKey` là câu đầu, `storeResult` là câu cuối của cùng một `TransactionService.run`.
- **Hệ quả của việc chuẩn hóa:** hai người gọi hiện có đã viết khóa theo bảng chữ cái nên **mọi hash đã lưu vẫn khớp** (TC-79-11 khóa lại hash của TC-61-01).
- **Thay đổi cấp hệ thống:** không có (ADR-05 đã mô tả đúng hành vi này).

## 4. Test cases tự động

PostgreSQL 17 thật qua HTTP và JWT thật (`test/db/customer-transfers.db-spec.ts`), trừ TC-79-11 là unit. Sau mỗi ca có kiểm tra bất biến sổ cái.

| ID | Truy vết | Lớp | Given · When · Then | `errorCode` |
|---|---|---|---|---|
| TC-79-01..06 | DoD #1–#3 | e2e Postgres | Đã có trên `main`: replay 201, REUSED, replay 422, replay sau khi tài khoản đã đủ tiền, replay nạp tiền | `IDEMPOTENCY_KEY_REUSED` |
| TC-79-07 | DoD #3, AC-5.4 | e2e Postgres | 10 lệnh song song cùng key, A đủ tiền → cả 10 là 201 với body `toEqual` nhau; đúng 1 transfer, 2 bút toán, 1 audit, 1 outbox, 1 key; A giảm đúng một lần | — |
| TC-79-08 | DoD #3, AC-5.4 + BR-07 | e2e Postgres | 10 lệnh song song cùng key, A thiếu tiền → cả 10 là 422 cùng `transferId`, cùng `errorCode`; 1 transfer REJECTED, 0 bút toán, 1 audit | `INSUFFICIENT_FUNDS` |
| TC-79-09 | DoD #4 | e2e Postgres | Amount `9007199254740993`: 201, replay cùng body, DB/bút toán/event đúng chữ số, không bút toán thứ ba; cùng key với `9007199254740992` → 422 | `IDEMPOTENCY_KEY_REUSED` |
| TC-79-10 | DoD #3 | e2e Postgres | Replay của 422 có body bằng body lần đầu (trừ `correlationId`, vốn của request hiện tại); `transferId` giữ nguyên | `INSUFFICIENT_FUNDS` |
| TC-79-11 | ADR-05, DoD #1 | unit | `hashRequest` bằng nhau khi đảo thứ tự khóa (kể cả lồng), khác khi đổi giá trị/path; bằng đúng SHA-256 của JSON theo thứ tự bảng chữ cái (khớp hash lưu của TC-61-01) | — |
| Quy trình | DoD #5 | — | Merge, CI, Dev review | ghi waiver |

## 5. Test thủ công

`node backend/scripts/manual-dbs79.cjs` (cần Docker, Node 24). Dựng app NestJS thật, JWT thật, Postgres 17 Testcontainers; mọi khoản tiền vào qua API nạp tiền. Không in token.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-79-01 | Nạp 1.000.000 cho Nguyễn Văn An; An chuyển 300.000 cho Trần Thị Bình với key K; gửi lại K hai lần | Ba phản hồi 201 giống hệt; An 700.000, Bình 300.000; 1 transfer, 2 bút toán; số hàng không tăng ở hai lần gửi lại |
| M-79-02 | Dùng K với số tiền 400.000 | 422 `IDEMPOTENCY_KEY_REUSED`; không đổi gì |
| M-79-03 | 10 lệnh 1.000 song song cùng key K2 | 10 phản hồi 201 giống hệt; thêm đúng 1 transfer và 2 bút toán |
| M-79-04 | Lệnh 5.000.000 khi chỉ có ~700.000, rồi gửi lại cùng key | 422 `INSUFFICIENT_FUNDS` hai lần cùng `transferId`; 1 transfer REJECTED |
| M-79-05 | Số `9007199254740993`: chuyển, gửi lại, rồi cùng key với `…992` | 201, 201 giống hệt, số dư/bút toán/event đúng chữ số; lần ba 422 REUSED |
| cleanup | Đóng app, xóa thư mục JWKS, drop database, dừng container | Dòng `DBS-79 cleanup PASS` chỉ in khi mọi bước trước đạt |

## 6. Domain review (AI)

**Reviewer:** chính agent (Sonnet 5.5), 2026-11-08, đọc `claimKey/replay/storeResult`, hai người gọi, ADR-05, docs/03 §6.1, database-design §4.5. Không dùng subagent (waiver ở đầu file). Không có raw reply riêng; các phát hiện nằm trong bảng.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | `hashRequest` phụ thuộc thứ tự khóa của người gọi, lệch ADR-05 | Đã đưa vào phạm vi: sắp xếp khóa (TC-79-11) |
| 2 | should-fix | AC-5.4 chưa kiểm 2 bút toán và 10 body giống hệt | Đã đưa vào phạm vi: TC-79-07, 08 |
| 3 | should-fix | Cặp 2^53 `…992/…993` chưa được dùng để chứng minh hash không đi qua `number` | Đã đưa vào phạm vi: TC-79-09 |
| 4 | minor | Replay chạy sau `getOwnedAccount`: nếu nguồn đổi chủ giữa hai lần gửi, lần gửi lại nhận 404 thay vì kết quả cũ | Không sửa: đúng hướng an toàn (AC-5.8 thắng replay); ghi ở §8 |
| 5 | minor | `database-design.md:244` ghi `request_hash` là hash của «(from, to, amount, type)» trong khi code băm method + path + body | Sửa chú thích (§9) |
| 6 | minor | `claimKey` ném `Error` thường khi key «biến mất» hoặc chưa có kết quả → 500 | Không sửa: trạng thái không thể có trong thiết kế (key và kết quả cùng commit); 500 đúng |

Không có phát hiện blocking. Verdict tự đánh giá: APPROVE sau khi đưa 1–3 vào phạm vi.

## 7. Kế hoạch triển khai

Mọi lệnh chạy từ gốc repo với `PATH` có `C:\Program Files\nodejs` (Node 24.11.1) và `npm --prefix backend`.

| Bước | File | Test viết trước | Kết quả đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `src/modules/ledger/ledger-posting.service.spec.ts`, `ledger-posting.service.ts` | TC-79-11 | điền khi chạy | `npm --prefix backend test -- ledger-posting` | `fix(ledger): sort request body keys before hashing the idempotency request` |
| 2 | `test/db/customer-transfers.db-spec.ts` | TC-79-07, 08, 09, 10 | Dự kiến không đỏ (chỉ siết bằng chứng); kiểm chứng bằng đột biến | `npm --prefix backend run test:db -- customer-transfers` | `test(ledger): prove AC-5.4 and exact replay above 2^53` |
| 3 | `scripts/lib/ledger-manual-harness.cjs`, `scripts/manual-dbs79.cjs`, `docs/features/screenshots/DBS-79/*` | M-79-01..05 | — | `node backend/scripts/manual-dbs79.cjs` | `test(ledger): add DBS-79 manual driver and shared harness` |
| 4 | feature doc, `docs/features/README.md`, `database-design.md` | — | — | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `docs(ledger): record DBS-79 evidence` |

Đột biến cho bước 2: tạm bỏ `ON CONFLICT … DO NOTHING` khỏi `claimKey` (TC-79-07/08 phải hỏng bằng `23505`), và tạm đổi hash sang `Number(amount)` (TC-79-09 phải hỏng). Hoàn nguyên bằng `git checkout`.

Rủi ro: chuẩn hóa hash đổi hash đã lưu nếu người gọi từng viết khóa không theo bảng chữ cái (kiểm: hai người gọi đều theo bảng chữ cái, TC-79-11 khóa lại). Lùi: `git revert` từng commit; không có migration.

**Quyết định ở G3 (agent tự duyệt):** theo bảng trên.

## 8. Kết quả

- **Lệnh kiểm tra** (Node 24.11.1, trên `backend/`, commit code cuối `1bc9b51`; sau đó chỉ thêm test, script và docs):

| Lệnh | Kết quả |
|---|---|
| `npm run lint:check` | đạt |
| `npm run typecheck` | đạt |
| `npm run build` | đạt |
| `npm test -- --runInBand` | **1066/1066** đạt, 65 suite |
| `npm run test:e2e -- --runInBand` | **148/148** đạt, 14 suite, với `DATABASE_URL` tới Postgres 17 tạm (không có `DATABASE_URL` thì app thoát ngay lúc dựng cấu hình; đó là hành vi sẵn có, không do task này) |
| `npm run test:db -- --runInBand` | **638/638** đạt, 32 suite (toàn bộ) |
| `node scripts/manual-dbs79.cjs` | 5/5 bước + dọn dẹp đạt |

  0 test bị `.skip`/`.only`/`.todo` trong phần task thêm.

- **Đối chiếu test case** (`test/db/customer-transfers.db-spec.ts`, trừ TC-79-11):

| ID | Test | Đạt? |
|---|---|---|
| TC-79-01..06 | đã có trên `main`, chạy lại trong 52/52 của `customer-transfers` + `operator-deposits` | đạt |
| TC-79-07 | `TC-79-07 AC-5.4: ten parallel requests…` | đạt. Đột biến: bỏ `ON CONFLICT DO NOTHING` → hỏng (cùng TC-79-08) |
| TC-79-08 | `TC-79-08 AC-5.4: ten parallel requests that are refused…` | đạt (đột biến như trên) |
| TC-79-09 | `TC-79-09 above 2^53…` | đạt. Đột biến: hash đi qua `Number()` → hỏng |
| TC-79-10 | `TC-79-10 a replayed 422 is the first answer…` | đạt |
| TC-79-11 | `src/modules/ledger/ledger-posting.service.spec.ts` (4 ca) | đạt. Đỏ trước khi sửa: 2/4 hỏng vì hash phụ thuộc thứ tự khóa |
| Quy trình | DoD #5 | chưa làm: Dev review chưa có, ghi ở BL-174 |

  11 ca mới/được siết đạt đủ độ sâu, 0 đơn giản hóa. TC-79-07..10 không đỏ trước khi viết vì code replay đã có từ #65; độ nhạy được chứng minh bằng đột biến thay cho bước đỏ.

- **Test thủ công** (`node backend/scripts/manual-dbs79.cjs`, chạy sau commit `1fa2730`; output thô: [manual-test.txt](screenshots/DBS-79/manual-test.txt), dòng đầu là SHA):

| Bước | Kết quả thật | Kết quả |
|---|---|---|
| M-79-01 | Chuyển 300.000 key K → 201; gửi lại hai lần → hai 201 giống hệt; An 700.000, Bình 300.000; số hàng không tăng | đạt |
| M-79-02 | K với 400.000 → 422 `IDEMPOTENCY_KEY_REUSED`; không ghi gì | đạt |
| M-79-03 | 10 lệnh song song → 10 × 201 cùng body; +1 transfer, +2 bút toán, +1 key | đạt |
| M-79-04 | 5.000.000 khi thiếu tiền → 422 `INSUFFICIENT_FUNDS`, gửi lại → cùng `transferId`; đúng 1 dòng REJECTED | đạt |
| M-79-05 | `9007199254740993`: 201, replay giống hệt, DB/bút toán/event đúng chữ số; `…992` → 422 REUSED | đạt |
| cleanup | JWKS, database tạm, container đã dọn (kiểm lại bằng `pg_database` và `docker ps`) | đạt |

  Dữ liệu vào: user/customer/tài khoản số dư 0 bằng SQL ("seed SQL"); mọi khoản tiền vào qua API nạp tiền.

- **Phạm vi so với §7:** khớp: `ledger-posting.service.ts` (+13/−2), `ledger-posting.service.spec.ts` (mới), `customer-transfers.db-spec.ts` (+114), `scripts/lib/ledger-manual-harness.cjs`, `scripts/manual-dbs79.cjs`, doc này, index, `database-design.md` (một dòng chú thích), `BACKLOG.md` (BL-174).
- **Ảnh chụp:** không có (waiver); bằng chứng là `manual-test.txt`.
- **Lệch so với kế hoạch:** không có lệch về file. Bước đỏ của TC-79-07..10 thay bằng đột biến (đã nêu ở trên).
- **Ghi nhận:** replay chạy sau `getOwnedAccount`, nên nếu nguồn đổi chủ giữa hai lần gửi thì lần gửi lại nhận 404 (phát hiện #4, chủ ý).
- **Bàn giao:** BL-174 (Dev review các PR DBS-79..83). Không còn DoD kỹ thuật nào chưa đạt.

## 9. Tài liệu đã cập nhật

`docs/features/README.md` (dòng DBS-79), `docs/components/_shared/database-design.md` (chú thích `request_hash`), `docs/BACKLOG.md` (thêm BL-174). Không xóa dòng BL nào. Không đổi docs/03 vì hành vi nhìn thấy từ API không đổi.
