# DBS-22 · @common/money: kiểu tiền bigint/string và DTO validator

> **Status:** Plan approved · **Vai:** Dev · **Nhánh:** `feat/DBS-22-common-money` · **PR:** — · **Cập nhật:** 2026-10-17

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 1, ưu tiên High, Deliverable/Demo **P2**, Status "In Progress" (đã đặt sẵn). Role trên board `Dev`, khớp loại việc (thư viện dùng chung của backend).
- **Expect:** "Mọi module xử lý tiền theo một cách, không ai dùng number."
- **DoD** (chép nguyên văn):
  1. @common/money export kiểu Money (bigint trong domain), hàm parse từ string, format ra string, cộng/trừ an toàn
  2. Validator DTO: chỉ nhận chuỗi số nguyên dương, không dấu, không số 0 đứng đầu, không thập phân, không số mũ, không vượt 2^63−1
  3. Test: "9007199254740993" (> 2^53) đi qua DTO → domain → serialize không mất chữ số; "0", "-1", "1.5", "1e3", "01", " 1" bị từ chối
  4. Serialize JSON của bigint không ném lỗi (trả string)
  5. backend/README ghi cách dùng và điều cấm (parseInt, Number trên tiền)
  6. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Thực trạng (board):** "Chưa có backend/src/common/money. eslint.config.mjs đã nhắc @common/money làm ví dụ import hợp lệ nhưng thư mục chưa tồn tại. Driver pg trả BIGINT dạng string; quy tắc «không dùng number cho tiền» mới chỉ nằm trong tài liệu." Đã kiểm: đúng. `backend/src/common/` chỉ có `app-role`, `errors`, `filters`, `middleware`, `utils`; ví dụ import nằm ở [`eslint.config.mjs`](../../backend/eslint.config.mjs) dòng 53; `grep` không thấy `@common/money` ở code nào.
- **Phụ thuộc:** không có ("làm được ngay"). DBS-21 (cột `bigint`) đã merge vào `main` (PR #8, `78bf96c`), nên các cột tiền đã có; task này không cần bảng nào.
- **Đã có gì:**
  - Quy tắc: [CONTRIBUTING §5](../../CONTRIBUTING.md), [database-design §1 quy tắc 2 và §11 (cột `bigint`)](../components/_shared/database-design.md), [docs/02 §7.2 value object Money](../02_REQUIREMENTS_AND_DOMAIN_MODEL.md), [ADR-07 dòng 58](../adr/0007-nestjs-typeorm-explicit-sql.md) (đã hứa "tiền đi qua `@common/money` (DBS-22)"), [threat-model T5](../security/threat-model.md) (biện pháp "DTO chỉ nhận chuỗi số nguyên dương", bằng chứng giao cho DBS-22).
  - Code gần: [`config/validation.schema.ts`](../../backend/src/config/validation.schema.ts) dòng 4 (`MONEY_PATTERN = /^[1-9]\d{0,17}$/`) và [`config/limits.config.ts`](../../backend/src/config/limits.config.ts) (`BigInt(env…)`): hai nơi đã tự xử lý chuỗi tiền theo cách riêng (xem câu hỏi 1). [`app.setup.ts`](../../backend/src/app.setup.ts) (`configureHttpApp`, `ValidationPipe` với `whitelist`, `forbidNonWhitelisted`, `transform`), [`problem-details.filter.ts`](../../backend/src/common/filters/problem-details.filter.ts) (lỗi validate ra 400 kèm `errors[]`, không có `errorCode`), [`ErrorCode`](../../backend/src/common/errors/error-code.enum.ts) (chưa có mã nào về số tiền sai định dạng). `class-validator` 0.15 và `class-transformer` đã là dependency; task không cần thêm gói nào.
  - Tiền lệ test: [DBS-20 TC-20-14, TC-20-19](DBS-20-migration-users-customers-accounts.md) và [DBS-21 TC-21-26](DBS-21-migration-transfers-ledger-idempotency.md) đã chứng minh DB giữ nguyên `9007199254740993` và `9223372036854775807` dạng chuỗi; task này làm nốt đoạn code phía trước DB. Chưa có DTO hay controller nào nhận tiền (task chuyển tiền và nạp tiền chưa làm).
  - Ranh giới: `common` không được import module (eslint, `sharedCodeImportsAModule`); `@common/*` ánh xạ `src/common/*`.
- **Baseline** (nhánh mới từ `origin/main` `78bf96c`, 2026-10-17, từ `backend/`): `lint:check` sạch, `typecheck` sạch, `npm test` 13 suite / 128 test đạt, `npm run test:e2e` 3 suite / 20 test đạt. Không bật Docker: hai tầng test này không cần DB và task này không chạm DB nên không chạy `test:db`.
- **Backlog** (`docs/BACKLOG.md`): không có dòng nào cùng module hay cùng DoD để xử lý trong task này. BL-001 (chưa có CI) chặn DoD #6, nên Phase 5 thêm DBS-22 vào nguồn của BL-001. BL-002…006 thuộc task outbox, chuyển tiền và migration 6, 7, không đụng tới task này.
- **Task khác đang mở:** các nhánh trên `origin` chỉ có DBS-20, DBS-21 (đã merge) và nhánh docs của skill; không thấy nhánh nào đụng `common/`. Không có `gh` nên chưa kiểm được danh sách PR đang mở, nhờ bạn nói nếu có PR nào đang sửa `app.setup.ts` hoặc `common/`.
- **Ngoài phạm vi:**
  - Mọi DTO, controller, service thật có nhận hoặc trả tiền (chuyển tiền, nạp tiền, số dư, lịch sử): task đó dùng `@common/money` sau khi task này merge.
  - Đổi `config/validation.schema.ts` và `config/limits.config.ts` sang dùng `@common/money` (câu hỏi 1).
  - Luật nghiệp vụ trên số tiền: hạn mức mỗi lần và theo ngày (BR-06), số dư tối thiểu (BR-03). `@common/money` chỉ lo định dạng, phạm vi `bigint` và số học an toàn.
  - Tiền tệ khác VND, phần lẻ, làm tròn, định dạng hiển thị có dấu chấm ngăn cách (BR-01: một loại tiền, số nguyên đồng).
  - Lint chặn `parseInt` và `Number` (câu hỏi 4).
  - Mã lỗi mới trong `ErrorCode` (câu hỏi 2).
- **Câu hỏi mở** (mỗi câu có đề xuất):
  1. **Hai nơi đang tự xử lý chuỗi tiền.** `MONEY_PATTERN` ở `validation.schema.ts` giới hạn 18 chữ số (tối đa 999.999.999.999.999.999), chặt hơn 2^63−1 (19 chữ số), và `limits.config.ts` gọi `BigInt()` trực tiếp. Expect nói "mọi module xử lý tiền theo một cách". *Đề xuất:* **không sửa hai file này trong task này.** Đổi sang `@common/money` làm giá trị hợp lệ của biến môi trường `TRANSFER_LIMIT_PER_*` rộng thêm một chữ số (gate phụ về env var, CONTRIBUTING §5b), và config chạy lúc khởi động nên rủi ro của nó khác một thư viện chưa có người gọi. Ghi một dòng `BL-NNN` giao cho Dev làm task chuyển tiền (hoặc ai chạm config): thay `MONEY_PATTERN` và `BigInt()` bằng `parseMoney`.
  2. **Lỗi từ DTO không có `errorCode`.** `ValidationPipe` trả 400 kèm `errors[]` và không có `errorCode`; `ErrorCode` có quy tắc "chỉ thêm mã khi client phải rẽ nhánh". *Đề xuất:* **không thêm mã mới.** Client chỉ có một việc làm với số tiền sai định dạng: sửa rồi gửi lại. Test kiểm khóa ràng buộc ổn định của class-validator (ví dụ `isMoneyAmount`), không kiểm câu chữ. Nếu bạn muốn client phân biệt được (ví dụ `INVALID_AMOUNT`) thì đó là gate phụ về `ErrorCode`, nói ngay để mình đưa vào thiết kế.
  3. **Serialize `bigint` ra JSON (DoD #4).** `JSON.stringify(1n)` ném `TypeError`. Cách thông dụng nhất là gắn `BigInt.prototype.toJSON` (một thay đổi toàn cục cho cả tiến trình). Cách khác là không bao giờ để `bigint` trần chui vào response: mọi DTO phản hồi gọi `formatMoney`. *Đề xuất:* làm **cả hai lớp**: `formatMoney` là đường chính thức, và một hàm cài `toJSON` cho `bigint` (có test, idempotent) được `configureHttpApp` gọi, để một chỗ quên `formatMoney` ra chuỗi chứ không thành lỗi 500. Chi tiết (đặt ở đâu, test thế nào) chốt ở G2. Nếu bạn không muốn đụng prototype toàn cục thì chọn chỉ `formatMoney` và DoD #4 được hiểu là "hàm serialize của thư viện không ném lỗi".
  4. **Cấm `parseInt` và `Number` trên tiền chỉ ở tài liệu (DoD #5).** Một luật eslint không phân biệt được tiền với số khác (cổng, TTL, số trang đều dùng `Number`), nên chặn chung sẽ nhiều dương tính giả. *Đề xuất:* chỉ ghi vào `backend/README` và chú thích docblock như DoD yêu cầu; ghi một dòng `BL-NNN` đề nghị cân nhắc lint hẹp hơn (ví dụ cấm `Number()` và `parseInt()` áp lên giá trị có kiểu `Money` hay trong thư mục có tên `money`) khi đã có vài module dùng thư viện.
  5. **Test thủ công khi chưa có endpoint nào nhận tiền.** Theo `task-kinds.md`, loại "thư viện chưa có người gọi" dùng một script lái. *Đề xuất:* (a) một script chạy bằng `ts-node` đưa các giá trị biên (`"9007199254740993"`, `"9223372036854775807"`, `"9223372036854775808"`, `"0"`, `"01"`, `" 1"`, `"1e3"`, `"-1"`, `"1.5"`, số `1000`, `null`) qua DTO → domain → JSON và in kết quả; (b) trong test e2e, dựng một controller **chỉ có trong file test** với đúng `configureHttpApp` của production để chứng minh đường HTTP thật (body JSON → `ValidationPipe` → `Money` → response). Controller trong test không phải là stub của task chưa xong: nó không ship. Nếu bạn muốn một lần chạy tay qua HTTP thật thì phải chờ task có endpoint nhận tiền; mình không đề xuất.
  6. **DoD #6:** "CI xanh" không kiểm được (repo chưa có workflow, BL-001). *Đề xuất:* như DBS-20, DBS-21: dán kết quả chạy local (bốn lệnh) vào PR và thêm DBS-22 vào nguồn của BL-001. Vì không có `gh`, bạn tạo PR từ nội dung mình soạn.
  7. **Tên nhánh:** CONTRIBUTING có ví dụ `chore/DBS-22-money-helpers`; mình dùng `feat/DBS-22-common-money` vì đây là thư viện dùng chung mới, không phải việc lặt vặt. Không cần quyết định gì thêm trừ khi bạn muốn đổi.

> **Cập nhật sau review vòng 1 (cho G2):** phần "Ngoài phạm vi" ở trên nói thư viện chỉ lo định dạng, miền `bigint` và số học an toàn. Review phát hiện `Money ≥ 0` không đủ cho luồng nạp tiền vì `funding` âm theo ADR-09, nên thiết kế thêm kiểu `Balance` có dấu (§2.1). Đây là phần **vượt DoD** (DoD chỉ nêu `Money`); nó nằm trong thiết kế chờ G2 duyệt, không phải đã quyết (xem §6 và câu hỏi 1 của G2).

**Quyết định ở G1 (2026-10-17):** duyệt cả 7 đề xuất, không sửa. Hệ quả: không đụng `config/validation.schema.ts` và `limits.config.ts` (một dòng `BL-NNN` mới, câu 1); không thêm `ErrorCode` (câu 2); làm cả `formatMoney` lẫn `BigInt.prototype.toJSON` (câu 3); lint chặn `Number`/`parseInt` chưa làm, có một dòng `BL-NNN` (câu 4); test thủ công bằng script lái cộng controller thăm dò chỉ nằm trong file test (câu 5); DoD #6 xử lý như DBS-20/21 (câu 6); nhánh `feat/DBS-22-common-money` (câu 7).

## 2. Hành vi

Không có API mới. "Hành vi" là những gì `@common/money` chấp nhận và từ chối. Test kiểm **`reason` của `MoneyError`** và **khóa ràng buộc `isMoneyAmount`**, không kiểm câu chữ.

**2.1 Hai kiểu, hai việc.**

| Kiểu | Là gì | Miền | Dùng cho |
|---|---|---|---|
| `Money` | số tiền của một giao dịch | `[0, 2^63−1]` | `transfers.amount`, `ledger_entries.amount`, `amount` trong request, event, hạn mức |
| `Balance` | số dư có dấu | `[−2^63, 2^63−1]` (đúng miền `bigint` của Postgres) | `accounts.balance`, `ledger_entries.balance_after`, `fromBalanceBefore` trong event, tổng đối soát |

Lý do có `Balance`: tài khoản SYSTEM `funding` **âm theo thiết kế** (ADR-09: "`funding` âm đúng bằng tổng tiền đã nạp", docs/02 §7.3, docs/03 §8) và lệnh nạp đi qua cùng luồng chuyển tiền với `funding` là nguồn. Nếu chỉ có `Money ≥ 0`, lệnh nạp đầu tiên (`0 − 300000`) và việc đọc `accounts.balance` của `funding` đều ném lỗi. `Balance` chỉ cho biết số đó nằm trong miền `bigint`; "số dư khách ≥ 0" vẫn do sync guard và `accounts_balance_non_negative` giữ (BR-03), không phải kiểu.

Dạng truyền của cả hai là **chuỗi chuẩn**: `Money` là `0` hoặc `[1-9][0-9]*`; `Balance` là `0` hoặc `-?[1-9][0-9]*`. Không dấu `+`, không `-0`, không số 0 đứng đầu, không dấu cách, không thập phân, không số mũ, không ngăn cách hàng nghìn.

**2.2 Thuật toán `parseMoney(raw)`** (thứ tự này là hợp đồng; `parseBalance` tương tự):

1. `raw` không phải kiểu `string`, hoặc không khớp `/^(0|[1-9][0-9]*)$/` (Balance: `/^(0|-?[1-9][0-9]*)$/`) → `INVALID`.
2. Số chữ số (không kể dấu `-`) > 19 → `OVERFLOW`, **không** gọi `BigInt` (chuỗi 100.000 chữ số bị chặn trong thời gian tuyến tính).
3. `BigInt(raw)` ra ngoài miền → `OVERFLOW` (Money: > 2^63−1; Balance: > 2^63−1 hoặc < −2^63).

`parsePositiveMoney(raw)` = `parseMoney` rồi `"0"` → `NOT_POSITIVE`. Đây là hàm **service dùng** cho số tiền giao dịch và nạp (docs/03 §6.1: `amount > 0` là validate tĩnh của service), để một lệnh đi vào từ worker hay lời gọi nội bộ không qua DTO vẫn không đẩy `0` xuống `CHECK (amount > 0)` rồi thành lỗi 500.

**2.3 `parseMoney` và `@IsMoneyAmount()`** (cùng một lõi; chỉ khác ở số 0):

| Đầu vào | `parseMoney` | `parsePositiveMoney` và `@IsMoneyAmount()` |
|---|---|---|
| `"1"`, `"500000"`, `"1500000"` | `1n`, `500000n`, `1500000n` | chấp nhận |
| `"9007199254740993"` (2^53+1) | `9007199254740993n`, **không mất chữ số** | chấp nhận |
| `"9223372036854775807"` (2^63−1) | chấp nhận | chấp nhận |
| `"9223372036854775808"`, `"99999999999999999999"` (20 chữ số), `"1"` + 999 số `0`, `"9"` × 100000 | `OVERFLOW` | từ chối |
| `"0"` | `0n` (số dư 0 là hợp lệ) | **từ chối** (`NOT_POSITIVE`; BR-01, docs/03 §6.1) |
| `"-1"`, `"-0"`, `"+1"` | `INVALID` | từ chối |
| `"01"`, `"00"`, `"0001"` | `INVALID` | từ chối |
| `"1.5"`, `"1.0"`, `"1."`, `".5"` | `INVALID` | từ chối |
| `"1e3"`, `"1E3"` | `INVALID` | từ chối |
| `" 1"`, `"1 "`, `"1\n"`, `"\t1"`, `""` | `INVALID` | từ chối |
| `"1,000"`, `"1.000.000"`, `"1_000"`, `"0x10"`, `"NaN"`, `"Infinity"` | `INVALID` | từ chối |
| `"１２"` (chữ số toàn chiều rộng), `"٣"` (chữ số Ả Rập) | `INVALID` | từ chối |
| số `1000`, số `9007199254740993`, `1000n`, `null`, `undefined`, `true`, `{}`, `[]`, `["1"]`, `new String("1")` | `INVALID` (chỉ nhận kiểu `string`) | từ chối |

`tryParseMoney(raw)` cùng quyết định nhưng trả `null` thay vì ném. `toMoney(value: bigint)` và `toBalance(value: bigint)` là cách **duy nhất** tạo `Money` / `Balance` từ một `bigint` đã tính ra ngoài thư viện (tổng đối soát, `SUM(Có) − SUM(Nợ)`): ngoài miền → `OVERFLOW` (cùng lý do mà `parseMoney` / `parseBalance` cho cùng giá trị); `toMoney` với số âm, và cả hai với kiểu không phải `bigint` → `INVALID`.

**2.4 `parseBalance`:** chấp nhận `"0"`, `"-300000"`, `"300000"`, `"9223372036854775807"`, `"-9223372036854775808"`, `"-9007199254740993"`; `INVALID` cho `"-0"`, `"--1"`, `"+1"`, `"-"`, `"-01"`, `"1.5"`, `"-1.5"`, `"1e3"`, `" -1"`, `"- 1"`, `"−1"` (dấu trừ Unicode U+2212) và mọi kiểu không phải `string`; `OVERFLOW` cho `"9223372036854775808"`, `"-9223372036854775809"` và chuỗi 1.000 chữ số.

**2.5 Phép tính.** Không phép nào đi qua `number`.

| Hàm | Kết quả |
|---|---|
| `addMoney(a, b)` | chính xác; > 2^63−1 → `OVERFLOW` (`MAX + 0` được, `MAX + 1` không) |
| `subtractMoney(a, b)` | `a − b`; `a < b` → `UNDERFLOW` (không bao giờ tạo `Money` âm); `a − a = 0n` |
| `creditBalance(balance, amount)` | `balance + amount` (`Balance`); ra ngoài miền → `OVERFLOW` |
| `debitBalance(balance, amount)` | `balance − amount` (`Balance`); **được phép âm** (nạp từ `funding`: `0 − 300000 = −300000`); thấp hơn −2^63 → `OVERFLOW`. Không kiểm "đủ số dư": đó là sync guard (BR-03) |

So sánh `Money` với `Balance` dùng toán tử quan hệ `<`, `<=`, `>`, `>=` có sẵn của `bigint` (ví dụ `balance < amount` trong sync guard). Không dùng `===` giữa hai kiểu khác nhãn (TypeScript báo TS2367); muốn so bằng thì mở rộng về `bigint` trước: `(a as bigint) === b`.

**2.6 `formatMoney(m)` / `formatBalance(b)`** trả chuỗi chuẩn (chữ số thập phân, không dấu phân cách; `Balance` âm có dấu `-`); `formatMoney(parseMoney(s)) === s` và `formatBalance(parseBalance(s)) === s` với mọi `s` hợp lệ. Không phải hàm hiển thị ("1.500.000đ" thuộc giao diện). Với giá trị không hợp lệ (ép kiểu từ `bigint` trần ngoài miền) ném `INVALID`. Khi truyền tiền vào SQL, dùng `formatMoney` / `formatBalance` làm tham số, như các test DBS-20, DBS-21.

**2.7 `MoneyError`.** `extends Error`, có `reason: 'INVALID' | 'OVERFLOW' | 'UNDERFLOW' | 'NOT_POSITIVE'` (với `Balance`, ra ngoài miền ở cả hai phía là `OVERFLOW`). Thông điệp **không chép lại giá trị đầu vào** (đầu vào có thể là rác dài từ client, hoặc lọt vào log); chỉ nói loại lỗi. Không phải `HttpException`: người gọi thật sự bắt lỗi nghiệp vụ; nếu lọt ra ngoài thì `ProblemDetailsFilter` trả 500 `Internal server error` như mọi lỗi lạ, không lộ gì.

**2.8 Serialize `bigint` ra JSON (DoD #4).** `installBigIntJson()` gắn `BigInt.prototype.toJSON` trả `this.toString()`: `JSON.stringify({ amount: 9007199254740993n })` ra `{"amount":"9007199254740993"}`, kể cả `bigint` lồng trong object hoặc mảng. Gọi hai lần không đổi gì. Nếu `BigInt.prototype.toJSON` đã có thì **không ghi đè** khi nó giữ nguyên chữ số (kiểm bằng `2n ** 53n + 1n` ra `"9007199254740993"`); nếu nó làm mất chữ số (ví dụ `return Number(this)`), `installBigIntJson()` **ném lỗi lúc khởi động**, vì đó đúng là sự mất chính xác mà DoD #3, #4 chặn. Không đổi cách `number` được serialize. Không có hàm này thì `JSON.stringify(1n)` ném `TypeError: Do not know how to serialize a BigInt`. `formatMoney` / `formatBalance` vẫn là đường chính thức (G1 câu 3): `toJSON` chỉ để một chỗ quên format ra chuỗi chứ không thành lỗi 500.

**2.9 Qua HTTP với đúng cấu hình production** (`ValidationPipe`: `whitelist`, `forbidNonWhitelisted`, `transform`, **không** `enableImplicitConversion`; route có tiền tố `/v1` vì `defaultVersion: '1'`):

| Body gửi tới `POST /v1/probe/money` | Kết quả |
|---|---|
| `{"amount":"9007199254740993"}` | 201; `received` = `"9007199254740993"`, `plusOne` = `"9007199254740994"`, `fundingAfter` = `"-9007199254740993"` (số âm lớn hơn 2^53 vẫn chính xác), tất cả là chuỗi |
| `{"amount":"0"}`, `"-1"`, `"1.5"`, `"1e3"`, `"01"`, `" 1"` | 400 `application/problem+json`, `errors[]` có đúng 1 lỗi, **không có `errorCode`** (G1 câu 2); handler không được gọi |
| `{"amount":9007199254740993}` (số JSON) | 400. `JSON.parse` đã làm tròn về `9007199254740992` trước khi tới validator, nên **chữ số mất ở đây, trước khi vào code của ta**; luật "chỉ nhận chuỗi" chặn cả trường hợp này |
| `{"amount":1000}`, `null`, `{}` | 400 |

Một số JSON không bao giờ được chấp nhận, kể cả khi chính xác (`1000`): một luật duy nhất, "tiền là chuỗi".

## 3. Kiến trúc

- **Vị trí:** thư viện dùng chung `backend/src/common/money/`, import qua `@common/money`; chạy ở cả `api` lẫn `worker` (hàm thuần, không I/O). `common` không import module (eslint). Tên file: `money.ts` (kiểu, lỗi, parse, format, cộng, trừ), `balance.ts`, `is-money-amount.decorator.ts`, `bigint-json.ts`, `bigint-json.bootstrap.ts`, `index.ts`, mỗi file có `*.spec.ts` cạnh nó. Danh sách ca từ chối dùng chung nằm ở `backend/test/support/money-cases.ts` (ngoài `src/`, nên `nest build` không đưa vào `dist/`; các spec và script lái import nó).
- **Cung cấp** (chữ ký sẽ có trong code):

```ts
declare const moneyBrand: unique symbol;
declare const balanceBrand: unique symbol;
export type Money = bigint & { readonly [moneyBrand]: true };      // bigint trần không gán được vào Money
export type Balance = bigint & { readonly [balanceBrand]: true };  // Money và Balance không thay nhau được
export const MONEY_MAX: Money;      // 9223372036854775807n
export const MONEY_ZERO: Money;     // 0n
export const BALANCE_ZERO: Balance; // 0n
export type MoneyErrorReason = 'INVALID' | 'OVERFLOW' | 'UNDERFLOW' | 'NOT_POSITIVE';
export class MoneyError extends Error { readonly reason: MoneyErrorReason }
export function parseMoney(raw: string): Money;                 // ném MoneyError
export function parsePositiveMoney(raw: string): Money;         // service dùng cho số tiền giao dịch
export function tryParseMoney(raw: unknown): Money | null;
export function toMoney(value: bigint): Money;
export function toBalance(value: bigint): Balance;
export function formatMoney(value: Money): string;
export function addMoney(a: Money, b: Money): Money;
export function subtractMoney(a: Money, b: Money): Money;
export function parseBalance(raw: string): Balance;
export function formatBalance(value: Balance): string;
export function creditBalance(balance: Balance, amount: Money): Balance;
export function debitBalance(balance: Balance, amount: Money): Balance;
export function IsMoneyAmount(options?: ValidationOptions): PropertyDecorator;  // key 'isMoneyAmount'
export function installBigIntJson(): void;
```

- `bigint-json.ts` khai `declare global { interface BigInt { toJSON?(): string } }` (thuộc tính **tùy chọn**), để `delete BigInt.prototype.toJSON` trong test biên dịch được dưới `strict` với `lib: ["ES2022"]`.
- **Dùng:** DTO giữ trường kiểu `string` có `@IsMoneyAmount()`; **service** gọi `parsePositiveMoney(dto.amount)` một lần ở đầu (không dùng `@Transform` của class-transformer, vì nó chạy trước validator và làm validator thấy `bigint`). Số tiền đọc từ cột `amount` qua `parseMoney`; số dư đọc từ `accounts.balance`, `balance_after` qua `parseBalance` (vì `funding` âm). Response và event dùng `formatMoney` / `formatBalance`.
- **Người gọi bị ảnh hưởng:** `configureHttpApp(app, settings)` thêm một lời gọi `installBigIntJson()` (import từ `@common/money`), chữ ký giữ nguyên; người gọi: `main.ts`, `test/health.e2e-spec.ts`, `test/error-handling.e2e-spec.ts`. `main.ts` thêm `import '@common/money/bigint-json.bootstrap';` ngay sau `./config/env.bootstrap`, vì `worker` không đi qua `configureHttpApp` mà vẫn serialize payload (SQS, outbox, `jsonb` của audit) bằng `JSON.stringify`.
- **Dữ liệu:** không chạm bảng nào. Cột `bigint` đã có (DBS-20, DBS-21); `pg` trả chuỗi → `parseMoney` / `parseBalance`; ghi lại bằng `formatMoney` / `formatBalance`.
- **Ranh giới transaction:** không có (hàm thuần).
- **Build:** `nest build` viết lại alias `@common/*` thành đường dẫn tương đối (đã kiểm: `dist/modules/index.js` dòng 4). `app.setup.ts` và `main.ts` dùng alias nên M-22-06 kiểm được điều đó cho `@common/money`.

```mermaid
flowchart LR
  C[Client JSON] -->|"số JSON mất chữ số ở JSON.parse"| P[ValidationPipe]
  P -->|"@IsMoneyAmount: chỉ chuỗi chuẩn, > 0"| S[Service: parsePositiveMoney]
  S --> D[(pg bigint: tham số format, đọc lại là chuỗi)]
  D -->|"amount: parseMoney, balance: parseBalance"| S
  S -->|"addMoney, subtractMoney, creditBalance, debitBalance"| R[Response / event: format]
  R -.->|"chỗ quên format: toJSON ra chuỗi"| J[JSON]
```

- **Thay đổi cấp hệ thống:** [`backend/README.md`](../../backend/README.md) (mục cách dùng và điều cấm, dòng cấu trúc `common/`), [database-design §11](../components/_shared/database-design.md) (hàng "Cột `bigint`": `parseMoney` cho số tiền, `parseBalance` cho số dư), [threat-model T5](../security/threat-model.md) (Thiết kế → Đã kiểm, link feature doc), `docs/BACKLOG.md` (thêm dòng, BL-001 thêm nguồn), `docs/features/README.md`. Không có ADR mới: ADR-07 đã quy định `@common/money`. **Bàn giao (không sửa trong PR này):** [event-contract](../components/_shared/event-contract.md) ghi `fromBalanceBefore` là "string (đồng)" mà không nói có thể âm; với `DEPOSIT` nó âm (nguồn là `funding`). Thêm vào BL-002 (đang là việc của event contract / `DEPOSIT`), và nêu DBS-24 (`backend/src/common/events`): type và schema của event phải coi `fromBalanceBefore` là chuỗi `Balance` có dấu (`parseBalance`) và `amount` là chuỗi `Money`; dùng `@IsMoneyAmount` cho `fromBalanceBefore` sẽ đẩy mọi event `DEPOSIT` vào DLQ.

## 4. Test cases tự động

Lớp **unit** (`npm test`, `*.spec.ts` cạnh file) và **e2e không DB** (`npm run test:e2e`, `configureHttpApp` thật). Không có `test:db` (không chạm DB). Các bảng từ chối ở §2.3 và §2.4 là **dữ liệu dùng chung**, mỗi bảng một danh sách (`MONEY_REJECT` cho §2.3: spec của `parseMoney`, `parsePositiveMoney`, `tryParseMoney` và `@IsMoneyAmount` đọc cùng mảng; `BALANCE_REJECT` cho §2.4: spec của `parseBalance`; mỗi phần tử có `reason` mong đợi; `"-1"` bị `Money` từ chối nhưng `Balance` chấp nhận nên hai danh sách không gộp được), (`backend/test/support/money-cases.ts`), để chúng không thể lệch nhau mà test vẫn xanh. Ở lớp HTTP, bộ lọc lỗi chỉ trả thông điệp phẳng nên không thấy khóa ràng buộc: e2e chỉ kiểm "400, đúng 1 lỗi, handler không chạy, và cùng body với `"1"` thì 201"; việc lỗi đến từ `isMoneyAmount` do TC-22-19, TC-22-20 giữ.

**Checklist bảo mật** (`testing.md`): *lỗi không lộ nội bộ* → TC-22-12, TC-22-21, TC-22-30; *đầu vào số tiền bị tấn công (threat-model T5)* → TC-22-19, TC-22-20, TC-22-27, TC-22-28. Các mục còn lại (role guard, kiểm sở hữu, `Idempotency-Key`, audit, BR-13, SQL tham số hóa, TLS và secret): **không áp dụng**, vì task không có endpoint thật, không chạm DB và không có secret.

Trong mô tả ca, giá trị sai kiểu (số, `null`, `1000n`…) truyền vào hàm có chữ ký `string` bằng `x as unknown as string`, và số học dùng giá trị dựng từ `parseMoney('1')`, `parseBalance('…')`, không dùng literal trần (`1`, `1n`), để ts-jest biên dịch được.

| ID | Truy vết | Lớp | Given · When · Then | Mong đợi |
|---|---|---|---|---|
| TC-22-01 | DoD #1 | unit | `"0"`, `"1"`, `"500000"`, `"1500000"` · `parseMoney` · đúng giá trị `bigint` | — |
| TC-22-02 | DoD #1, #3 | unit | `"9007199254740993"`, `"9223372036854775807"` · `parseMoney` rồi `formatMoney` · đúng chuỗi cũ, giá trị `bigint` bằng nhau (không bị `number` làm tròn) | — |
| TC-22-03 | DoD #1, #3 | unit | 2^53−1, 2^53, 2^53+1, 2^63−1 và mọi `10^k`, `10^k ± 1` (k = 0..18) · `format(parse(s))` · bằng `s` | — |
| TC-22-04 | DoD #1, #2 | unit | các hàng `INVALID` của bảng §2.3 (dạng chuỗi) · `parseMoney` · ném `MoneyError` `INVALID` | `reason` |
| TC-22-05 | DoD #1, #2 | unit | `"9223372036854775808"`, `"99999999999999999999"`, `"1"` + 999 số `0`, `"9"` × 100000 · `parseMoney` · `OVERFLOW` (chuỗi 100000 chữ số xong ngay, không treo) | `reason` |
| TC-22-06 | DoD #1 | unit | số `1000`, số `9007199254740993`, `1000n`, `null`, `undefined`, `true`, `{}`, `[]`, `["1"]`, `new String("1")` · `parseMoney` · `INVALID` | `reason` |
| TC-22-07 | DoD #1 | unit | cùng các bảng · `tryParseMoney` · `null` cho mọi ca từ chối, giá trị cho ca chấp nhận | — |
| TC-22-08 | DoD #1, #2 | unit | `parsePositiveMoney`: `"1"` ok; `"0"` → `NOT_POSITIVE`; mọi hàng `INVALID`/`OVERFLOW` ở trên giữ nguyên lý do | `reason` |
| TC-22-09 | DoD #1 | unit | `addMoney`: 2^53 + 1 = 9007199254740993; (2^63−2) + 1 = MAX; MAX + `MONEY_ZERO` = MAX; `addMoney(MONEY_MAX, parseMoney('1'))` → `OVERFLOW` | `reason` |
| TC-22-10 | DoD #1 | unit | `subtractMoney`: 9007199254740993 − 1 = 9007199254740992; a − a = 0; 0 − 1 và 5 − 6 → `UNDERFLOW` | `reason` |
| TC-22-11 | DoD #1 | unit | `toMoney(-1n)` và `toMoney(1.5 as never)` → `INVALID`; `toMoney(2n**63n)` → `OVERFLOW` (cùng lý do với `parseMoney("9223372036854775808")`); `toMoney(0n)`, `toMoney(2n**63n - 1n)` ok; `toBalance(2n**63n)` và `toBalance(-(2n**63n) - 1n)` → `OVERFLOW`, `toBalance(-(2n**63n))` ok; `formatMoney` của giá trị ép kiểu âm → `INVALID` | `reason` |
| TC-22-12 | DoD #1 | unit | thông điệp của `MoneyError` (Money và Balance) khi đầu vào là chuỗi dài 40 ký tự có từ lạ · không chứa đầu vào | — |
| TC-22-13 | DoD #1 (số dư) | unit | `parseBalance` chấp nhận `"0"`, `"-300000"`, `"300000"`, `"9223372036854775807"`, `"-9223372036854775808"`, `"-9007199254740993"`; `format(parse(s)) === s` | — |
| TC-22-14 | DoD #1 (số dư) | unit | các hàng `INVALID` và `OVERFLOW` của §2.4 (gồm `"−1"` U+2212, chuỗi 1000 chữ số, kiểu không phải chuỗi) · `parseBalance` · lý do đúng | `reason` |
| TC-22-15 | DoD #1 (số dư) | unit | kịch bản `funding` của docs/02 §7.3: `funding` = `BALANCE_ZERO`; nạp 300000 → `debitBalance` = −300000 và `formatBalance` = `"-300000"`, đọc lại `parseBalance("-300000")` đúng (đây là `fromBalanceBefore` của lệnh nạp kế tiếp); nạp lần hai → −600000; `creditBalance` cho khách; tổng ba số dư (cộng bằng `bigint`, đưa về `Balance` bằng `toBalance`) = 0 | — |
| TC-22-16 | DoD #1 (số dư) | unit | với `balanceMax = parseBalance('9223372036854775807')`, `balanceMin = parseBalance('-9223372036854775808')`, `one = parseMoney('1')`: `creditBalance(balanceMax, one)` và `debitBalance(balanceMin, one)` → `OVERFLOW`; `debitBalance(parseBalance('500000'), parseMoney('300000'))` = 200000; `debitBalance(BALANCE_ZERO, one)` = −1 (cho phép: kiểm đủ số dư là việc của sync guard) | `reason` |
| TC-22-17 | DoD #1 ("không dùng number") | unit (biên dịch) | `// @ts-expect-error -- <lý do>` (eslint `ban-ts-comment` đòi có mô tả; biến đích đặt tên `_m` để qua `no-unused-vars`): gán `1n` hoặc `1` cho `Money`; `addMoney(1, 2)`; `formatMoney(5n)`; `formatMoney(balance)`; `creditBalance(money, money)`; `debitBalance(balance, balance)` · `typecheck` và ts-jest báo lỗi đúng dòng đó | — |
| TC-22-18 | DoD #2 | unit | DTO mẫu · `validate` với `"1"`, `"500000"`, `"9007199254740993"`, `"9223372036854775807"` · không lỗi | — |
| TC-22-19 | DoD #2, #3 | unit | DTO mẫu · `validate` với `"0"`, `"-1"`, `"1.5"`, `"1e3"`, `"01"`, `" 1"` (đúng danh sách DoD), `"9223372036854775808"` và các hàng của danh sách dùng chung · đúng một lỗi cho `amount`, ràng buộc `isMoneyAmount` | khóa `isMoneyAmount` |
| TC-22-20 | DoD #2 | unit | `validate` với số `1000`, số `9007199254740993`, `1000n`, `null`, thiếu trường, `[]`, `["1"]`, `{}` · từ chối | khóa `isMoneyAmount` |
| TC-22-21 | DoD #2 | unit | `ValidationOptions.message` tùy biến được dùng; thông điệp mặc định không chứa giá trị đầu vào | — |
| TC-22-22 | DoD #4 | unit | sau `delete BigInt.prototype.toJSON`: `JSON.stringify(1n)` ném `TypeError`; sau `installBigIntJson()`: `{a: 9007199254740993n}`, mảng và object lồng ra chuỗi đúng chữ số | — |
| TC-22-23 | DoD #4 | unit | `installBigIntJson()` gọi hai lần cùng kết quả; `toJSON` có sẵn do người khác định nghĩa và giữ chữ số (`2n**53n+1n` → `"9007199254740993"`) không bị ghi đè; `toJSON` có sẵn làm mất chữ số → `installBigIntJson()` ném lỗi (đồ thử dựng bằng `BigInt.prototype.toJSON = function (this: bigint) { return Number(this); } as unknown as () => string`, và `afterEach(() => { delete BigInt.prototype.toJSON; })` gỡ đi để các ca sau trong cùng file không thừa hưởng); `JSON.stringify({a: 1.5})` không đổi | — |
| TC-22-24 | DoD #4 (worker) | unit | `delete BigInt.prototype.toJSON` rồi `await jest.isolateModulesAsync(async () => { await import('./bigint-json.bootstrap'); })` (không dùng `require`: eslint `no-require-imports`) · `toJSON` có mặt | — |
| TC-22-25 | DoD #4 (worker) | unit | đọc `src/main.ts`: có đúng một dòng `import '@common/money/bigint-json.bootstrap';` ở đầu dòng (không nằm trong comment) và đứng trước dòng `import { AppModule }` · bảo vệ việc `worker` có `toJSON` (`main.ts` tự chạy khi import nên không import được trong test) | — |
| TC-22-26 | DoD #3 (đường chính) | e2e | controller thăm dò trong file test, `configureHttpApp` thật · `POST /v1/probe/money` `{"amount":"9007199254740993"}` · 201; `received` = `"9007199254740993"`, `plusOne` = `"9007199254740994"`, `fundingAfter` = `"-9007199254740993"`, đều là chuỗi trong JSON thô | — |
| TC-22-27 | DoD #3 | e2e | từng giá trị `"0"`, `"-1"`, `"1.5"`, `"1e3"`, `"01"`, `" 1"` · 400 `problem+json`, `errors.length === 1`, không có `errorCode`, bộ đếm lời gọi handler vẫn 0; ca đối chứng cùng test: `"1"` → 201 và bộ đếm = 1 | HTTP 400 |
| TC-22-28 | DoD #2, #3 | e2e | body thô `{"amount":9007199254740993}`, `{"amount":1000}`, `{"amount":null}`, `{}` · 400 như trên, handler không chạy, ca đối chứng `"1"` → 201 (ghim rằng cấu hình pipe không bật `enableImplicitConversion`) | HTTP 400 |
| TC-22-29 | DoD #4 | e2e | handler trả `bigint` trần lồng trong object và mảng; `BigInt.prototype.toJSON` bị xóa trước khi dựng app · 200 với chuỗi, không 500: chứng minh `configureHttpApp` tự gắn | — |
| TC-22-30 | quy tắc lỗi | e2e | handler gọi `addMoney(MONEY_MAX, parseMoney('1'))` · 500 `Internal server error` chung, không lộ chi tiết | HTTP 500 |
| TC-22-31 | DoD #5 | tài liệu | `backend/README.md` có cách dùng và điều cấm (`parseInt`, `Number` trên tiền) | kiểm khi review ở G4; `check-doc-links.mjs` |
| TC-22-32 | DoD #6 | quy trình | PR merge, CI xanh, Dev review, bảng "Đối chiếu test case" | chưa kiểm được: BL-001; chờ review |

## 5. Test thủ công

Loại "thư viện chưa có người gọi" (`task-kinds.md`): một **script lái** `backend/test/support/money-driver.ts` (nằm trong PR, không trong `src/` nên không vào `dist/`) và **controller thăm dò** dùng chung `backend/test/support/money-probe.ts` với e2e. Chạy trong Git Bash, từ `backend/`, ghi `| tee -a ../docs/features/screenshots/DBS-22/manual-test.txt`.

Điều kiện: Node 24 và `npm ci` đã chạy. Chỉ M-22-07 cần Docker. PostgreSQL 18 cài trên Windows chiếm cổng 5432 trên máy này (như DBS-20, DBS-21), nên M-22-07 dùng file override **ngoài repo** map container ra cổng 5433 và đặt `DATABASE_URL` bằng biến môi trường (biến này thắng giá trị trong `env/.env.development`).

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-22-01 (thành công) | `npx ts-node -r tsconfig-paths/register test/support/money-driver.ts table` | bảng cho `"9007199254740993"` và `"9223372036854775807"`: `ACCEPT`, giá trị `bigint`, chuỗi `format` và `JSON` giống hệt đầu vào, cột `same` = true |
| M-22-02 (biên, từ chối) | cùng lệnh | `"0"`, `"-1"`, `"1.5"`, `"1e3"`, `"01"`, `" 1"`, `"9223372036854775808"` đều `REJECT` ở cột validator; `parseMoney("0")` vẫn ra `0n`, `parsePositiveMoney("0")` ra `NOT_POSITIVE` |
| M-22-03 (mất chữ số) | cùng lệnh, mục `json-number` | `JSON.parse('{"amount":9007199254740993}')` ra `9007199254740992`, bị `REJECT` vì là số; so với chuỗi `"9007199254740993"` giữ nguyên |
| M-22-04 (số học và `funding`) | cùng lệnh, mục `arithmetic` | 2^53 + 1 = 9007199254740993; MAX + 1 → `OVERFLOW`; 0 − 1 → `UNDERFLOW`; `funding` 0 nạp 300000 ra `-300000`, nạp tiếp ra `-600000`, tổng với hai tài khoản khách = 0 |
| M-22-05 (HTTP thật, thành công) | terminal A: `npx ts-node -r tsconfig-paths/register test/support/money-driver.ts serve` (Nest + `configureHttpApp` thật, cổng 3999); terminal B: `curl -i -X POST localhost:3999/v1/probe/money -H 'content-type: application/json' -d '{"amount":"9007199254740993"}'` | 201, body có `"received":"9007199254740993"`, `"plusOne":"9007199254740994"`, `"fundingAfter":"-9007199254740993"` |
| M-22-05b (HTTP, từ chối) | cùng server: `-d '{"amount":"1.5"}'`, `-d '{"amount":9007199254740993}'`, `-d '{"amount":1000}'` | cả ba 400 `application/problem+json`, `errors[]` có 1 lỗi, không có `errorCode`; terminal A không in lời gọi handler |
| M-22-06 (build) | `npm run build`; `grep -n "common/money" dist/app.setup.js dist/main.js`; `grep -rn "@common/" dist/ \|\| echo none`; `node -e "const m=require('./dist/common/money');console.log(m.formatMoney(m.parseMoney('9007199254740993')))"` | build sạch; `dist/app.setup.js` có `require("./common/money")` và `dist/main.js` có `require("./common/money/bigint-json.bootstrap")` (alias đã được viết lại); lệnh `grep -rn "@common/"` in `none` (không alias nào còn sót); in ra `9007199254740993` |
| M-22-07 (khởi động thật, cần Docker) | từ gốc repo: `docker compose -f docker-compose.yml -f <override ngoài repo> up -d postgres valkey elasticmq`; từ `backend/`: terminal A `DATABASE_URL=postgres://banking:banking_local_only@localhost:5433/banking APP_ROLE=api node dist/main.js`, terminal B `curl -i localhost:3000/health/live`; dừng A; chạy lại với `APP_ROLE=worker` | `api` log "Listening" và `/health/live` 200; `worker` log "Worker started (role=worker)": thay đổi ở `main.ts` không làm hỏng khởi động của cả hai role |

M-22-07 chỉ chứng minh không hỏng khởi động; việc `worker` thật sự có `toJSON` do TC-22-24, TC-22-25 giữ. Ghi rõ ở §8.

## 6. Domain review (AI)

**Reviewer:** subagent Claude Opus 5.5, effort medium, 2026-10-17 · **Vòng 1:** 9 phát hiện (blocking 1, should-fix 4, minor 4), verdict **REVISE** · [trả lời nguyên văn](screenshots/DBS-22/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | `Money ≥ 0` không biểu diễn được số dư âm của `funding` (ADR-09): lệnh nạp đầu tiên `0 − 300000` ném `UNDERFLOW`, đọc `accounts.balance` / `balance_after` của `funding` ném `INVALID`, `fromBalanceBefore` của `DEPOSIT` âm nên `formatMoney` ném trong transaction outbox. Câu "câu hỏi 1 ở G2" trỏ tới thứ chưa có | **đã sửa**, đã kiểm lại với ADR-09, docs/02 §7.3, docs/03 §8: thêm kiểu `Balance` có dấu `[−2^63, 2^63−1]` (`parseBalance`, `formatBalance`, `creditBalance`, `debitBalance`), `Money` giữ ≥ 0 cho số tiền giao dịch (§2.1, §2.4, §2.5, §3, TC-22-13…17, M-22-04). Việc thêm kiểu thứ hai vượt DoD nên thành câu hỏi 1 của G2. Phần event-contract không nói `fromBalanceBefore` có thể âm: chuyển sang §8 Bàn giao (thêm vào BL-002) |
| 2 | should-fix | Đường curl `/probe/money` bị 404 vì `defaultVersion: '1'` | **đã sửa** `/v1/probe/money` ở §2.9, M-22-05, M-22-05b, TC-22-26 |
| 3 | should-fix | M-22-07 lặp lỗi DBS-21: compose chỉ map cổng 5432, `.env.development` trỏ 5432 (vào PostgreSQL 18 của Windows), lệnh "rồi" không hợp lệ | **đã sửa** M-22-07: override ngoài repo, `DATABASE_URL` đặt bằng biến môi trường, hai lệnh `APP_ROLE` tách riêng; câu điều kiện ở đầu §5 sửa theo |
| 4 | should-fix | §2.1 (`{0,18}`) mâu thuẫn §2.2 / TC-22-04 (20 chữ số ra `OVERFLOW`); chuỗi dài chưa có quy tắc | **đã sửa** §2.2 ghi thuật toán ba bước (kiểu và regex → độ dài > 19 → `BigInt` so với miền); TC-22-05 thêm chuỗi 1000 và 100000 chữ số |
| 5 | should-fix | e2e chỉ thấy "400 có `errors[]`": bộ lọc làm phẳng, không chứng minh lỗi đến từ `isMoneyAmount`; kiểm tên trường là kiểm câu chữ | **đã sửa** TC-22-27, TC-22-28 kiểm `errors.length === 1`, handler không chạy, cùng body với `"1"` thì 201; khóa ràng buộc do TC-22-19, TC-22-20 giữ, ghi ở đầu §4 |
| 6 | minor | `addMoney(MAX, 1n)` không biên dịch vì `1n` là `bigint` trần | **đã sửa** TC-22-09, TC-22-30 dùng `parseMoney('1')` / `MONEY_ZERO` |
| 7 | minor | kiểm văn bản `main.ts` pass cả với dòng bị comment; `import` bị đưa lên trước `delete` | **đã sửa** TC-22-24 dùng `delete` rồi `jest.isolateModules(require)` (sau đó thay bằng `jest.isolateModulesAsync` + `import()`, vòng 2 #1); TC-22-25 khớp dòng `import` ở đầu dòng và đứng trước `import { AppModule }` |
| 8 | minor | M-22-06 grep `dist` không chứng minh alias được viết lại vì code import tương đối | **đã sửa** §3: `app.setup.ts` và `main.ts` import bằng `@common/money`, M-22-06 grep `require` tương đối ở `dist` |
| 9 | minor | "> 0" chỉ ở decorator, worker hay lời gọi nội bộ để `0` lọt xuống `CHECK (amount > 0)` thành 500 | **đã sửa** thêm `parsePositiveMoney` (service dùng) và lý do `NOT_POSITIVE`; TC-22-08 |

**Vòng 2** (cùng reviewer, trên §1–§6 đã sửa; xác nhận #1–#5, #9 của vòng 1 đã sửa đúng, #6–#8 mới sửa một phần): 10 phát hiện (blocking 0, should-fix 3, minor 7), verdict **REVISE**. Trả lời nguyên văn ở cuối cùng [file trên](screenshots/DBS-22/domain-review.md).

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | TC-22-24 dùng `require`, vi phạm eslint `no-require-imports` (đã kiểm: `recommended-type-checked.js` dòng 44) | **đã sửa** dùng `await jest.isolateModulesAsync(async () => { await import(…) })` (jest 30 có `isolateModulesAsync`) |
| 2 | should-fix | `delete BigInt.prototype.toJSON` không biên dịch (TS2339 / TS2790) | **đã sửa** §3: `declare global { interface BigInt { toJSON?(): string } }` thuộc tính tùy chọn |
| 3 | should-fix | §4 thiếu checklist bảo mật của `testing.md` | **đã sửa** §4 có đoạn "Checklist bảo mật": hai mục áp dụng ánh xạ vào TC, các mục còn lại "không áp dụng" kèm lý do |
| 4 | minor | giá trị sai kiểu và literal trần (`1`, `1n`) không biên dịch với chữ ký `string` / `Money` | **đã sửa** §4 nêu quy ước ép kiểu `as unknown as string`; TC-22-16 dựng giá trị bằng `parseBalance` / `parseMoney` |
| 5 | minor | `grep "common/money"` khớp cả alias chưa được viết lại | **đã sửa** M-22-06 thêm `grep -rn "@common/" dist/ \|\| echo none` (mong đợi `none`) và nêu đúng dòng `require` cần thấy |
| 6 | minor | `money === balance` là TS2367 | **đã sửa** §2.5 chỉ cho toán tử quan hệ; so bằng thì mở rộng về `bigint` |
| 7 | minor | không có cách có kiểm tra để tạo `Balance` từ `bigint` tính ra; `toMoney(2^63)` ra `INVALID` còn `parseMoney` ra `OVERFLOW` | **đã sửa** thêm `toBalance`; `toMoney`/`toBalance` ngoài miền đều `OVERFLOW`; TC-22-11, TC-22-15 |
| 8 | minor | `toJSON` có sẵn kiểu `Number(this)` sẽ làm mất chữ số mà vẫn qua | **đã sửa** §2.8: giữ nếu giữ chữ số, ném lỗi lúc khởi động nếu không; TC-22-23 |
| 9 | minor | danh sách ca dùng chung chưa có tên file; để trong `src/` sẽ vào `dist/` | **đã sửa** `backend/test/support/money-cases.ts` (§3, §4) |
| 10 | minor | hand-off: DBS-24 (`common/events`) phải coi `fromBalanceBefore` là `Balance` | **chuyển sang §8 Bàn giao**: đã ghi ở §3, Phase 5 thêm vào BL-002 |

**Vòng 3** (cùng reviewer): xác nhận cả 10 phát hiện vòng 2 đã sửa đúng; 4 phát hiện mới, **đều minor**, verdict **APPROVE** (reviewer nói sửa trong doc, không cần vòng nữa). Trả lời nguyên văn cuối [file trên](screenshots/DBS-22/domain-review.md).

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | minor | đồ thử `toJSON` làm mất chữ số không biên dịch với `toJSON?(): string` (TS2322); không gỡ sau test nên các ca sau thừa hưởng | **đã sửa** TC-22-23: ép kiểu `as unknown as () => string` và `afterEach` gỡ |
| 2 | minor | `// @ts-expect-error` trần vi phạm eslint `ban-ts-comment`; biến đích vi phạm `no-unused-vars` | **đã sửa** TC-22-17: có mô tả sau directive, biến đích `_m` |
| 3 | minor | không thể có một danh sách từ chối chung cho `Money` và `Balance` (`"-1"` khác nhau) | **đã sửa** §4: hai danh sách `MONEY_REJECT`, `BALANCE_REJECT`, mỗi phần tử có `reason` |
| 4 | minor | §6 vòng 1 dòng 7 còn ghi `jest.isolateModules(require)` | **đã sửa** thêm ghi chú trỏ về vòng 2 #1 |

**Tổng kết:** 3 vòng, 23 phát hiện (blocking 1, should-fix 7, minor 15), đều đã xử lý hoặc chuyển sang §8 Bàn giao; verdict cuối **APPROVE**. Chưa có phát hiện nào "không sửa".

**Quyết định ở G2 (2026-10-17):** duyệt «duyệt G2», không sửa. Hệ quả: thêm kiểu `Balance` ngoài `Money` (câu 1, vượt DoD đã được duyệt); `main.ts` được sửa một dòng import (câu 2); `installBigIntJson()` ném lỗi lúc khởi động khi gặp `toJSON` làm mất chữ số (câu 3); service dùng `parsePositiveMoney` (câu 4); ba file hỗ trợ test ở `backend/test/support/` (câu 5). Người duyệt **cho phép bật Docker** cho M-22-07 (câu 6): được bật Docker Desktop và `docker compose` với file override cổng 5433 nằm ngoài repo.

## 7. Kế hoạch triển khai

Mọi bước theo thứ tự test trước: viết test, chạy, thấy **đỏ vì đúng lý do**, viết code tối thiểu, chạy xanh, dọn, commit (cuối commit có dòng `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`). Task thuần thư viện nên không có migration, service hay audit/outbox. Lệnh chạy từ `backend/`; `UT` = `npx jest --config ./test/jest-unit.js`, `E2E` = `npx jest --config ./test/jest-e2e.js`.

| Bước | File | Test viết trước | Kết quả đỏ (điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1. `Money` | mới: `src/common/money/money.ts`, `money.spec.ts`, `test/support/money-cases.ts` (`MONEY_REJECT`) | TC-22-01…12 | (điền) | `UT src/common/money/money.spec.ts` | `feat(money): Money type with parse, format and safe arithmetic` |
| 2. `Balance` | mới: `balance.ts`, `balance.spec.ts`; `money-cases.ts` (`BALANCE_REJECT`) | TC-22-13…17 | (điền) | `UT src/common/money/balance.spec.ts` rồi `npm run typecheck` (TC-22-17 là kiểm biên dịch) | `feat(money): signed Balance for account balances` |
| 3. `@IsMoneyAmount` | mới: `is-money-amount.decorator.ts`, `.spec.ts` | TC-22-18…21 | (điền) | `UT src/common/money/is-money-amount.decorator.spec.ts` | `feat(money): IsMoneyAmount DTO validator` |
| 4. JSON an toàn cho `bigint` | mới: `bigint-json.ts`, `bigint-json.spec.ts`, `bigint-json.bootstrap.ts`, `bigint-json.bootstrap.spec.ts` | TC-22-22, 23, 24 | (điền) | `UT src/common/money/bigint-json` | `feat(money): JSON-safe bigint with fail-fast on lossy toJSON` |
| 5. Cửa vào `@common/money` và `main.ts` | mới: `index.ts`, `main-wiring.spec.ts`; sửa: `src/main.ts` (một dòng import) | TC-22-25 | (điền) | `UT src/common/money/main-wiring.spec.ts` | `feat(money): public index and worker bootstrap import` |
| 6. HTTP với cấu hình thật | mới: `test/support/money-probe.ts`, `test/money.e2e-spec.ts`; sửa: `src/app.setup.ts` (gọi `installBigIntJson()`) | TC-22-26…30 | (điền) | `E2E test/money.e2e-spec.ts`; rồi cả `npm run test:e2e` (health, error-handling vẫn xanh) | `feat(money): install JSON-safe bigint in configureHttpApp` |
| 7. Script lái cho test thủ công | mới: `test/support/money-driver.ts` (mục `table`, `json-number`, `arithmetic`, `serve`) | không có TC; được kiểm bằng chính M-22-01…05b | không áp dụng | `npx ts-node -r tsconfig-paths/register test/support/money-driver.ts table` chạy được | `test(money): manual-test driver for @common/money` |
| 8. Kiểm tra tự động toàn bộ | không sửa file | cả bộ | không áp dụng | `npm run lint:check && npm run typecheck && npm test && npm run test:e2e`; kiểm không có `.skip`, `.only`, `.todo` trong test của task | (nếu phải sửa lỗi lint thì commit riêng `fix(money): …`) |
| 9. Test thủ công (4c) | `docs/features/screenshots/DBS-22/manual-test.txt` (dòng đầu là SHA commit cuối đổi code), ảnh `01…0N-*.png` | M-22-01…07 | không áp dụng | theo §5; M-22-07 cần Docker (được phép bật) | `docs(features): DBS-22 manual test evidence` |
| 10. Tài liệu (Phase 5) | `backend/README.md` (cách dùng, điều cấm `parseInt`/`Number`, dòng cấu trúc `common/`); `database-design.md` §11; `threat-model.md` T5; `docs/BACKLOG.md`; `docs/features/README.md`; feature doc §8, §9 | TC-22-31 (đọc lại), `check-doc-links.mjs` | không áp dụng | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `docs: DBS-22 README, database-design, threat model, backlog` |

**Sweep (đã chạy):** mỗi DoD bullet và mỗi giới hạn nêu trong tài liệu có một dòng kế hoạch hoặc một dòng "ngoài phạm vi".

| Nguồn | Xử lý |
|---|---|
| DoD #1 (kiểu, parse, format, cộng trừ) | bước 1, 2 |
| DoD #2 (validator) | bước 3 |
| DoD #3 (`9007199254740993` qua DTO → domain → serialize; sáu giá trị bị từ chối) | bước 1 (TC-22-02), 3 (TC-22-19), 6 (TC-22-26…28) |
| DoD #4 (JSON không ném lỗi) | bước 4, 5, 6 (TC-22-22…25, 29) |
| DoD #5 (README) | bước 10 |
| DoD #6 (merge, CI, review, bảng đối chiếu) | quy trình: bảng đối chiếu điền ở PR; "CI xanh" chưa kiểm được (BL-001); chờ review của Dev khác |
| ADR-07 dòng 58 ("cấm `parseInt` và `Number` trên tiền") | bước 10 (README); lint chặn là ngoài phạm vi, `BL-NNN` mới (G1 câu 4) |
| threat-model T5 (Thiết kế → Đã kiểm) | bước 10 |
| database-design §11 hàng "Cột `bigint`" | bước 10 |
| `config/validation.schema.ts` `MONEY_PATTERN`, `config/limits.config.ts` `BigInt()` | ngoài phạm vi, `BL-NNN` mới (G1 câu 1) |
| event-contract `fromBalanceBefore` có thể âm; DBS-24 `common/events` | không sửa trong PR này; thêm vào BL-002 (§3 Bàn giao) |
| BL-001 | thêm DBS-22 vào nguồn (bước 10) |
| `CONTRIBUTING.md` §5, README module `ledger`, `src/scripts/README.md` | không sửa: quy tắc không đổi, script lái nằm ở `test/support/` |
| `eslint.config.mjs` dòng 53 (ví dụ `@common/money`) | đã đúng, không sửa |

**Rủi ro và cách lùi:**
- *`BigInt.prototype.toJSON` là thay đổi toàn cục.* Lùi: bỏ hai lời gọi `installBigIntJson()` (`main.ts`, `configureHttpApp`); `formatMoney` / `formatBalance` vẫn là đường chính thức nên không hàm nào của thư viện hỏng.
- *Ném lỗi lúc khởi động khi gặp `toJSON` lạ.* Đã kiểm `node_modules` không có gói nào gắn `toJSON`. Lùi: đổi `throw` thành cảnh báo log và ghi đè.
- *Kiểu nhãn (`Money`, `Balance`) làm người dùng sau phải đi qua `parseMoney` / `toMoney`.* Đó là chủ đích; nếu quá cứng thì nới `Money` thành `bigint` trần ở một PR sau mà không đổi hàm nào.
- *Thêm `Balance` vượt DoD.* Đã được duyệt ở G2. Lùi: xóa `balance.ts` và các TC-22-13…17; `Money` không phụ thuộc vào nó.
- *Docker và cổng 5433 ở M-22-07.* Dùng file override ngoài repo như DBS-20, DBS-21. Sau khi chạy: `docker compose … stop` (không `down -v`, không xóa volume).
- *Nhánh docs của skill chưa merge.* Nhánh này tách từ `main` nên `SKILL.md`, `CLAUDE.md` còn bản cũ; không ảnh hưởng code, và PR này không đụng hai file đó.

**Quyết định ở G3 (2026-10-17):** duyệt «duyệt G3», không sửa. Kế hoạch 10 bước giữ nguyên; không có file ngoài danh sách.

## 8. Kết quả

(Phase 4–5)

## 9. Tài liệu đã cập nhật

(Phase 5)
