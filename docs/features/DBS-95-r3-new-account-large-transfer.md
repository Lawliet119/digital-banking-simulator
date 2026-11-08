# DBS-95 · Luật R3 tài khoản mới chuyển lớn: tuổi < 24 giờ và > 10.000.000đ

> **Status:** Plan approved · **Vai:** #4 Fraud · **Nhánh:** `feat/DBS-95-r3-new-account` · **PR:** — · **Cập nhật:** 2026-11-08

> **Ghi chú quy trình:** phiên chạy bởi techlead (`Techlead waiver`). Các gate do agent duyệt thay theo yêu cầu của techlead; mỗi gate có đoạn «Quyết định» riêng.

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 3, ưu tiên Medium, Deliverable P5, vai #4 Fraud. **Expect:** «R3 đúng với dữ liệu snapshot trong event.»
- **DoD:**
  1. Hàm thuần: tuổi = occurredAt − fromAccountCreatedAt; kích hoạt khi < 24 giờ và amount > 10.000.000.
  2. Test: đúng ngưỡng 24 giờ và 10.000.000 (không kích hoạt), vượt cả hai, thiếu trường snapshot xử lý rõ ràng.
  3. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ.
- **Phụ thuộc:** DBS-59 (Done, [khung risk](DBS-59-risk-module-skeleton.md)). R1 ([DBS-93](DBS-93-r1-velocity.md)) và R2 ([DBS-94](DBS-94-r2-unusual-amount.md)) là khuôn: class `implements RiskRule`, ném lỗi khi dữ liệu hoặc cấu hình sai, bỏ qua `DEPOSIT`.
- **Đã có gì:** R3 chỉ dùng **snapshot trong event**, không cần `Features` và không đọc DB: `occurredAt`, `fromAccountCreatedAt` (ISO-8601 UTC có `Z`, bắt buộc theo [event-contract](../components/_shared/event-contract.md) và schema Joi trong `@common/events`), `amount` (chuỗi đồng canonical). Seed DBS-58 cho R3: `{ enabled: true, weight: 35, maxAccountAgeHoursExclusive: 24, minAmountExclusive: '10000000' }` ([migration](../../backend/src/database/migrations/1792713600000-CreateFraudStorage.ts)): số tiền ngưỡng là **chuỗi**. Guide §4.2: ví dụ explanation «Tài khoản mở 3 giờ trước, chuyển 20.000.000đ».
- **Baseline** (`main` `4024f74`, có R1 và R2, Node 24.22.2): `lint:check`, `typecheck` đạt; unit 74 suite, 1295 test.
- **Ngoài phạm vi:** consumer (DBS-111) gọi luật và kiểm schema event trước; scoring; đọc cấu hình phiên bản từ DB và ánh xạ key seed sang `thresholds` (task cấu hình); R4–R6. Tính đúng của snapshot `fromAccountCreatedAt` do bên phát event (ledger) bảo đảm, ngoài task này.
- **Câu hỏi mở:** (1) Thiếu hoặc sai trường snapshot: **ném lỗi** có tên trường (không có giá trị), không trả `null` (khuôn R1/R2, fail-closed, DoD «xử lý rõ ràng»): đề xuất đồng ý. (2) `fromAccountCreatedAt` **sau** `occurredAt` (tuổi âm): cùng đồng hồ DB nên chỉ xảy ra khi đồng hồ lùi hoặc failover sang máy lệch. Luật coi tuổi âm là **0** (tài khoản vừa mở, tín hiệu mạnh nhất) và vẫn chấm, khớp `ai/feature-projection.ts` (`Math.max(0, …)`) và nguyên tắc «chỉ gắn cờ, không chặn». Ném lỗi sẽ làm luật bị bỏ qua (guide §8: luật ném lỗi thì ghi lỗi và các luật khác chạy tiếp), tức không cờ nào: fail-open cho việc gắn cờ. Đề xuất đồng ý (sửa sau review #1); kiểm chéo `fromAccountCreatedAt ≤ occurredAt` ở schema event là bàn giao. (3) Định dạng explanation theo mẫu guide (dấu chấm ngăn nghìn, hậu tố `đ`), khác R1/R2 vốn dùng số trần: nêu như bàn giao thống nhất ở BACKLOG, không đổi R1/R2 trong task này. (4) Hàm kiểm UTC thật nằm riêng tư trong `event-schemas.ts`; luật có bản kiểm riêng thay vì mở export của `@common/events` (ngoài phạm vi): ghi bàn giao. (5) Rule tắt thì **không** kiểm `amount` và snapshot (chỉ kiểm cấu hình), để vô hiệu hóa R3 bằng phiên bản luật mới là cách giảm thiểu khi dữ liệu snapshot hỏng, không sinh lỗi cho luật đã tắt: khác R1/R2 ở điểm này, đề xuất đồng ý (review #5).
- **Quyết định ở G1** (agent duyệt thay techlead): chấp nhận cả năm.

## 2. Hành vi

`R3NewAccountLargeTransferRule.evaluate(event, features, params)` trả `RuleHit | null`, đồng bộ, thuần; tham số `features` không dùng.

1. **Chỉ chấm `TRANSFER`:** `event.type` khác `TRANSFER` trả `null` ngay đầu hàm (như R1, R2).
2. **Cấu hình:** `enabled` boolean; `weight` nguyên trong `[0, 2147483647]`; `thresholds.maxAccountAgeHoursExclusive` số nguyên an toàn trong `[1, 87600]` (v1 là 24); `thresholds.minAmountExclusive` **chuỗi** số đồng canonical qua `parseMoney` (`0 … MONEY_MAX`; v1 là `'10000000'`). Sai kiểu (số thay vì chuỗi), thiếu key hay ngoài miền thì ném `Error` (`Invalid R3 configuration`), kể cả khi rule tắt.
3. **Rule tắt:** sau khi kiểm cấu hình, `enabled = false` trả `null` ngay, không đọc `amount` hay snapshot.
4. **Snapshot:** `event.amount` qua `parsePositiveMoney`; lỗi được bắt và ném lại thành `Invalid R3 snapshot field: amount` (không giá trị, không `cause`). `event.occurredAt` và `event.fromAccountCreatedAt` phải là ISO-8601 UTC có `Z`, giây, tối đa 9 chữ số thập phân, ngày giờ có thật (không `2026-02-30`, không giờ 24, không offset `+00:00`). Thiếu (`undefined`, `null`, rỗng) hoặc sai thì ném `Error` với thông báo `Invalid R3 snapshot field: <tên trường>` (tên trường, không bao giờ có giá trị). So sánh ở độ chính xác **mili giây** (phần dưới mili giây bị cắt; nhà phát event dùng `Date#toISOString()` nên chỉ có mili giây, sai số dưới 1 ms). Cách kiểm: khớp regex `^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(\.\d{1,9})?Z$`, `Date.parse` ra số, rồi đòi `new Date(ms).toISOString().slice(0, 19) === value.slice(0, 19)` (chặn `2026-02-30`, `…T24:00:00Z`, giây `60`, `1900-02-29`; năm `0099` vẫn là năm 99, không thành 1999).
5. **Tuổi:** `ageMs = max(0, occurredAt − fromAccountCreatedAt)`; tuổi âm coi là 0 (xem câu hỏi mở 2).
6. **Kích hoạt** khi rule bật **và** `ageMs < maxAccountAgeHoursExclusive × 3 600 000` **và** `amount > minAmountExclusive` (bigint; cả hai biên là chặt: đúng 24 giờ hoặc đúng 10.000.000 thì **không** kích hoạt).
7. **Kết quả:** `{ id: 'R3', weight, explanation }`. Explanation: `Tài khoản mở {tuổi} trước, chuyển {amount}đ`. Tuổi luôn **cắt xuống**, không bao giờ nói quá tuổi thật: dưới 1 phút ghi `dưới 1 phút`, từ 1 đến 59 phút ghi `{n} phút`, từ 60 phút ghi `{n} giờ`. Số tiền có dấu chấm ngăn nghìn theo mẫu guide (`20.000.000đ`), tạo **chỉ trên chuỗi chữ số** (`replace(/\B(?=(\d{3})+(?!\d))/g, '.')`), không `Number`, không `toLocaleString` (mất chính xác trên 2^53 và phụ thuộc ICU). Không chứa ID hay dữ liệu khách.
8. Ví dụ: tài khoản mở lúc 00:15:42, `occurredAt` 03:15:42 cùng ngày, `amount = "20000000"` → `Tài khoản mở 3 giờ trước, chuyển 20.000.000đ`, weight 35.

## 3. Kiến trúc

- **Vị trí:** module `risk`; file mới `backend/src/modules/risk/rules/r3-new-account-large-transfer.rule.ts` (+ `.spec.ts`), driver `backend/test/manual/r3-new-account-large-transfer.manual.ts`. Không đăng ký vào `RiskModule`, không đổi `index.ts`, `rule.ts`, `Features`, event, schema, env, dependency. Chưa có caller production (consumer DBS-111).
- **Interface:** `class R3NewAccountLargeTransferRule implements RiskRule { readonly id = 'R3'; evaluate(event: TransferEvent, features: Features, params: RuleParams): RuleHit | null }`. Dùng `parseMoney`, `parsePositiveMoney` từ `@common/money`.
- **Dữ liệu / transaction:** không có. Luật không đọc DB, đúng ý «snapshot trong event, không đọc lại DB».
- **Sơ đồ:** không cần.
- **Thay đổi cấp hệ thống:** README module risk (trạng thái R3). Không đổi ADR, `_shared`.

## 4. Test cases tự động

Cấu hình v1: `{ weight 35, maxAccountAgeHoursExclusive 24, minAmountExclusive '10000000' }`. `occurredAt = 2026-10-19T03:15:42.123Z`; tuổi chỉnh bằng `fromAccountCreatedAt`.

| ID | Truy vết | Lớp | Given · When · Then |
|---|---|---|---|
| TC-95-01 | DoD 1, 2 | unit | Biên 24 giờ với `amount = 20000000`: tuổi đúng 24 giờ → `null`; thiếu 1 ms (23 giờ 59 phút 59,999 giây) → hit; thừa 1 ms → `null`; cùng biên qua ngày chuyển giờ mùa hè (2026-03-29) vẫn 86 400 000 ms; `maxAccountAgeHoursExclusive` 1 và 87600 là biên hợp lệ |
| TC-95-02 | DoD 1, 2 | unit | Biên tiền với tuổi 1 giờ: `amount = 10000000` → `null`; `10000001` → hit; `minAmountExclusive = '0'` hợp lệ và `amount = '1'` → hit; `sameOwner: true` vẫn hit (guide chỉ miễn cho R5, R6) |
| TC-95-03 | DoD 2 | unit | Vượt cả hai (tuổi 3 giờ, 20 000 000) → hit R3 weight 35, explanation đúng mẫu guide |
| TC-95-04 | DoD 1 | unit | Chỉ một điều kiện đạt → `null`: tài khoản cũ (30 ngày) chuyển 1 tỷ; tài khoản mới (1 phút) chuyển 1 000 000 |
| TC-95-05 | số tiền lớn | unit | `MONEY_MAX` với tuổi 1 giờ → hit, explanation giữ đủ 19 chữ số và dấu chấm; ngưỡng cấu hình `'9223372036854775806'`: `MONEY_MAX` → hit, `'9223372036854775807'` làm ngưỡng → `null` |
| TC-95-06 | explanation | unit | Chuỗi chính xác: tuổi 0 và 59,999 giây → `dưới 1 phút`; 1 phút → `1 phút`; 45 phút; 59 phút 59,999 giây → `59 phút`; 60 phút → `1 giờ`; 1 giờ 59 phút → `1 giờ`; 3 giờ → mẫu guide; 23 giờ 59 phút → `23 giờ`; số tiền 10 000 001 → `10.000.001đ`; 999 999 999 → `999.999.999đ`; kết quả như nhau với `TZ` và `LANG` khác nhau |
| TC-95-07 | DoD 2 (thiếu snapshot) | unit | `fromAccountCreatedAt` `undefined`, `null`, `''`, số, `'not a date'`, `'2026-10-19T03:15:42+00:00'`, `'2026-02-30T00:00:00Z'`, `'1900-02-29T00:00:00Z'`, `'2100-02-29T00:00:00Z'`, `'2026-10-19T24:00:00Z'`, `'2026-10-19T03:15:60Z'`, thiếu `Z` → ném lỗi có chuỗi `fromAccountCreatedAt` và không có giá trị đầu vào; `occurredAt` sai tương tự → lỗi có chuỗi `occurredAt`; `amount` sai → lỗi `amount`; được nhận: `2024-02-29`, phần thập phân 1 chữ số (`.1` = 100 ms) và 9 chữ số; năm `0099` là năm 99 (tuổi rất lớn → `null`, không thành 1999); `fromAccountCreatedAt` sau `occurredAt` 1 ms → coi tuổi 0 và hit (có `dưới 1 phút`); rule tắt với snapshot hỏng → `null`, không ném |
| TC-95-08 | cấu hình | unit | Hợp lệ (cả `enabled` đúng/sai); ném lỗi cả khi tắt: `weight` −1, 1,5, NaN, Infinity, 2147483648, `'35'`; `maxAccountAgeHoursExclusive` 0, −1, 1,5, NaN, `'24'`, 87601, `null`; `minAmountExclusive` số `10000000`, `''`, `'-1'`, `'1e7'`, `'007'`, `'9223372036854775808'`, `undefined`; thiếu từng key và thiếu `thresholds`; `thresholds` là `undefined` hoặc `null`; `enabled` không phải boolean; `amount` không hợp lệ (`'0'`, `''`, `'-5'`, `'007'`, số) khi rule bật |
| TC-95-09 | cấu hình dùng thật | unit | Rule tắt → `null`; ngưỡng 48 giờ, 5 000 000 và weight 10 được dùng thay seed (tài khoản 30 giờ chuyển 6 000 000 → hit weight 10; 5 000 000 → `null`; 48 giờ đúng → `null`) |
| TC-95-10 | khuôn R1/R2 | unit | `DEPOSIT` với dữ liệu hợp lệ hoặc hỏng → `null`, không ném |
| Quy trình | DoD 3 | — | CI xanh, bảng đối chiếu trong PR; Dev khác review: chưa có (BL-183) |

Không có `errorCode` HTTP, không đổi tiền hay số dư.

## 5. Test thủ công

Driver `backend/test/manual/r3-new-account-large-transfer.manual.ts` gọi chính class rule với event tổng hợp (không DB, không mạng). Từ `backend/`: `npx ts-node -r tsconfig-paths/register test/manual/r3-new-account-large-transfer.manual.ts`.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-95-01 | Tài khoản 3 giờ chuyển 20 000 000 | hit R3 weight 35, `Tài khoản mở 3 giờ trước, chuyển 20.000.000đ` |
| M-95-02 | Biên: đúng 24 giờ (20 000 000) và đúng 10 000 000 (tuổi 1 giờ) | `null` cả hai |
| M-95-03 | Thiếu 1 ms đến 24 giờ; và 10 000 001 | hit cả hai |
| M-95-04 | Tài khoản cũ chuyển 1 tỷ; tài khoản 1 phút chuyển 1 000 000 | `null` cả hai |
| M-95-05 | `MONEY_MAX` | hit với 19 chữ số đủ |
| M-95-06 | Thiếu `fromAccountCreatedAt`; `amount` sai | lỗi nêu tên trường, không hit |
| M-95-07 | Rule tắt; `DEPOSIT` | `null` cả hai |
| M-95-08 | Tài khoản 45 phút chuyển 20 000 000; và `fromAccountCreatedAt` sau `occurredAt` 1 ms | `Tài khoản mở 45 phút trước, chuyển 20.000.000đ`; hit `dưới 1 phút` (tuổi âm coi là 0) |

Output thô và ảnh lưu ở `docs/features/screenshots/DBS-95/` (`manual-test.txt` có SHA commit code ở dòng đầu). Chỉ dữ liệu tổng hợp trong bộ nhớ. Không chứng minh snapshot đúng trên dữ liệu thật: đó là việc của bên phát event.

## 6. Domain review (AI)

**Reviewer:** subagent general-purpose (model của phiên), 2026-11-08 · **Kết quả:** 11 phát hiện (blocking 0, should-fix 4, minor 7), verdict REVISE; đã sửa hoặc chuyển nơi nhận, không còn blocking · [trả lời](screenshots/DBS-95/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | Ném lỗi khi tuổi âm khác đường AI (cắt về 0) và thực chất là fail-open cho việc gắn cờ | đã sửa §1 câu 2, §2.5: tuổi âm coi là 0 và vẫn chấm; TC-95-07 |
| 2 | should-fix | Baseline và liên kết R2 khi R2 chưa merge | đã sửa: R2 đã merge (#96), rebase lên `main` `4024f74`, đo lại baseline (74 suite, 1295 test) |
| 3 | should-fix | Cách tạo dấu chấm ngăn nghìn chưa rõ, `toLocaleString` mất chính xác | đã sửa §2.7: chỉ trên chuỗi chữ số; TC-95-05, 06 (kể cả `TZ`/`LANG` khác) |
| 4 | should-fix | Cách kiểm UTC còn bỏ ngỏ, các bẫy `Date` | đã sửa §2.4: regex + `Date.parse` + khớp 19 ký tự đầu qua `toISOString`; TC-95-07 |
| 5 | minor | Kiểm snapshot khi rule tắt làm sai `risk_rule_error_total` và mất cách giảm thiểu | đã sửa §1 câu 5, §2.3: rule tắt thì chỉ kiểm cấu hình |
| 6 | minor | `0 phút` gượng, `1 giờ` cho 1h59 | đã sửa §2.7: `dưới 1 phút`, cắt xuống có chủ ý; TC-95-06 |
| 7 | minor | Cắt dưới mili giây lật biên | không sửa: không thực tế (nhà phát dùng `toISOString()`); ghi §2.4 |
| 8 | minor | Lỗi `amount` thiếu tên trường | đã sửa §2.4: `Invalid R3 snapshot field: amount`; TC-95-07 |
| 9 | minor | Thiếu ca biên | đã sửa TC-95-01, 02, 06, 07, 08 |
| 10 | minor | Kịch bản thủ công thiếu câu `phút`, thiếu nơi lưu bằng chứng | đã sửa §5: M-95-08 và đường lưu |
| 11 | minor | README xung đột với R2 | đã xử lý bằng rebase sau khi R2 merge |
| Bàn giao | — | consumer, schema event (export `isRealUtcTime` hoặc kiểm chéo `fromAccountCreatedAt ≤ occurredAt`), task cấu hình, guide, định dạng tiền thống nhất, Dev review | **BL-184** (thêm H7–H9) và **BL-183** (thêm PR DBS-95) |

**Quyết định ở G2** (agent duyệt thay techlead, 2026-11-08): duyệt thiết kế; không còn blocking. Sau vòng REVISE, các phần đã sửa được kiểm bằng test viết trước (§4), chưa chạy lại vòng review thứ hai.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Đỏ dự kiến | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `rules/r3-new-account-large-transfer.rule.spec.ts` | TC-95-01..10 | `TS2307` thiếu module | `npm test -- src/modules/risk/rules/r3` | không commit khi đỏ |
| 2 | `rules/r3-new-account-large-transfer.rule.ts` | — | — | cùng lệnh, `lint:check`, `typecheck`; đột biến (biên 24 giờ, biên tiền, bỏ cắt tuổi âm, bỏ kiểm UTC, bỏ guard `DEPOSIT`) | `feat(risk): implement R3 new-account large-transfer rule (DBS-95)` |
| 3 | `test/manual/r3-new-account-large-transfer.manual.ts` | — | — | chạy driver, SHA vào `manual-test.txt`, ảnh | cùng commit |
| 4 | feature doc §8–§9, README risk, `docs/features/README.md`, `docs/BACKLOG.md` | — | — | `check-doc-links.mjs`, `lint`, `typecheck`, `build`, `npm test`, `test:e2e` (với `DATABASE_URL` của Postgres test) | `docs(risk): record DBS-95 verification` |

**Rà soát DoD:** DoD 1 → TC-95-01, 02, 03, 04, 09; DoD 2 → TC-95-01, 02, 03, 07; DoD 3 quy trình. Không file nào ngoài bảng. **Rủi ro và cách lùi:** hàm thuần chưa có caller, revert commit là đủ.

**Quyết định ở G3** (agent duyệt thay techlead, 2026-11-08): duyệt kế hoạch.
