# DBS-85 · Review Focus 2: ranh giới nửa đêm giờ Việt Nam khi DB chạy UTC

> **Status:** Implemented · **Vai:** Dev (ledger; #4 review theo ghi chú 12/10 trên board) · **Nhánh:** `feat/DBS-85-midnight-boundary` · **PR:** [#75](https://github.com/Lawliet119/digital-banking-simulator/pull/75) · **Cập nhật:** 2026-11-08
>
> Techlead waiver: G1–G4 do agent tự duyệt theo yêu cầu của techlead (`huyasuo1109@gmail.com`); không có Dev khác (kể cả #4) review trước merge; không có ảnh PNG, bằng chứng là output thô; domain review do chính agent làm, không dùng subagent (§6).

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 3, Dev, ưu tiên High, Demo 1. **Expect:** «Hạn mức ngày reset đúng mốc 00:00 giờ Việt Nam.»
- **DoD:**
  1. Test với đồng hồ giả hoặc chèn `created_at` trực tiếp: lệnh 23:59:59+07 tính vào ngày cũ, 00:00:00+07 tính vào ngày mới.
  2. Kiểm với `SHOW timezone = UTC` của DB thử nghiệm.
  3. Chạy ổn định, không phụ thuộc giờ thật của máy chạy test; ghi vào 04-test-cases.md (file này không còn từ 11/10: test case ghi ở §4/§8 của doc này và bảng «Đối chiếu test case» của PR).
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ.
- **Phụ thuộc:** DBS-84 (`Clock` tiêm được và truy vấn tham số hóa): PR [#74](https://github.com/Lawliet119/digital-banking-simulator/pull/74) đã merge vào `main` trước khi PR này mở.
- **Đã có gì:** `SyncGuardService` tính mốc `date_trunc('day', $2::timestamptz AT TIME ZONE 'Asia/Ho_Chi_Minh') AT TIME ZONE 'Asia/Ho_Chi_Minh'` từ `Clock` (DBS-84). Cột «Thực trạng» («chưa có test ranh giới ngày») vẫn đúng: chưa test nào đặt `Clock` hay `created_at` quanh 00:00+07. [BL-154](../BACKLOG.md) đúng DoD này («dòng ghi nợ lúc 23:59 ngày trước không tính vào hạn mức ngày hôm sau») và được xóa trong PR này.
- **Baseline:** `main` sau #74: lint, typecheck sạch; unit 1073/1073; `test:db` 682/682.
- **Ngoài phạm vi:** đổi cách tính mốc ngày; độ lệch đồng hồ ECS–RDS (BL-177); thời gian ngày hạn mức hiển thị cho khách.
- **Quyết định ở G1 (agent tự duyệt):**
  1. Dùng **cả hai** cách DoD cho phép: `Clock` giả (quyết định "bây giờ") và chèn `created_at` trực tiếp bằng SQL (dòng sổ có đúng thời điểm). `ledger_entries` chỉ-thêm, nên dòng sổ lùi ngày được chèn như một giao dịch hoàn chỉnh (hai dòng, số dư khớp) để bất biến sổ cái vẫn PASS.
  2. Chọn ngày cố định `2026-03-15` (không phụ thuộc ngày chạy) và so sánh với cách tính theo ngày UTC (lỗi hay gặp) bằng hai điểm đối chứng: 23:00+07 ngày 14 vs 01:00+07 ngày 15 (cùng ngày UTC, khác ngày VN) và 01:00+07 vs 09:00+07 ngày 15 (khác ngày UTC, cùng ngày VN).
  3. Không đổi code production; chỉ thêm test, fixture và tài liệu. Nếu test phát hiện lỗi thì sửa theo quy trình bug.

## 2. Hành vi (đã có, nay có test)

Mốc ngày = 00:00:00.000 giờ Việt Nam (UTC+7, không có giờ mùa hè) của ngày chứa `Clock.now()`, đổi sang `timestamptz`; so sánh `created_at >= mốc` (**bao gồm** mốc).

| Dòng ghi nợ lúc (+07) | `Clock.now()` (+07) | Tính vào hạn mức? |
|---|---|---|
| 14/3 23:59:59 | 15/3 00:00:00 | **Không** (ngày cũ) |
| 14/3 23:59:59.999 | 15/3 00:00:00.000 | Không |
| 15/3 00:00:00 | 15/3 00:00:00 | **Có** (đúng mốc, `>=`) |
| 14/3 23:59:59 | 14/3 23:59:59 | Có (cùng ngày) |
| 15/3 00:00:00 | 15/3 23:59:59.999 | Có |
| 14/3 23:59:59 | 15/3 23:59:59.999 | Không |
| 15/3 00:00:00 | 16/3 00:00:00 | Không |
| 14/3 23:00 (= 16:00Z) | 15/3 01:00 (= 18:00Z 14/3) | **Không** (cùng ngày UTC, khác ngày VN) |
| 15/3 01:00 (= 18:00Z 14/3) | 15/3 09:00 (= 02:00Z 15/3) | **Có** (khác ngày UTC, cùng ngày VN) |

Kết quả không đổi khi múi giờ phiên của kết nối là `UTC`, `Asia/Ho_Chi_Minh`, `America/Los_Angeles` hay `Pacific/Kiritimati` (+14). `SHOW timezone` của DB thử nghiệm là `UTC`.

Ví dụ qua API (đồng hồ ứng dụng đặt 15/3 00:00:00+07; nguồn đã chuyển 200.000.000đ lúc 14/3 23:59:59+07): `POST /v1/transfers` 50.000.000đ → `201 COMPLETED`. Cùng đồng hồ, nguồn đã chuyển 200.000.000đ lúc 15/3 00:00:00+07: `POST` 1đ → `422 LIMIT_PER_DAY_EXCEEDED`.

## 3. Kiến trúc

- **Vị trí:** chỉ test: `test/db/midnight-boundary.db-spec.ts`, `test/support/backdated-transfer.ts` (chèn giao dịch hoàn chỉnh với `created_at` cho trước), một ca mới trong `sync-guard.service.spec.ts`, `scripts/manual-dbs85.cjs`.
- **Interface dùng:** `Clock` (`@common/clock`), `SENT_TODAY_SQL`, `SyncGuardService.checkGuards`. Không đổi interface.
- **Dữ liệu:** thêm `transfers` + hai `ledger_entries` + cập nhật `accounts.balance` trong DB tạm `dbs_test_*` bằng SQL (SQL INPUT, giải thích ở G1 câu 1); fixture từ chối chạy ngoài `dbs_test_*`.
- **Transaction:** mỗi giao dịch lùi ngày chèn trong một transaction của fixture; phần guard chạy trong `TransactionService.run` như thật, với `SET LOCAL TIME ZONE` để đổi múi giờ phiên.
- **Thay đổi cấp hệ thống:** không có. Xóa BL-154; README `ledger` bỏ câu «Chưa có test ở ranh giới nửa đêm (BL-154)».

## 4. Test cases tự động

| ID | Truy vết | Lớp | Given · When · Then | `errorCode` |
|---|---|---|---|---|
| TC-85-01 | DoD #2 | e2e Postgres | `SHOW timezone` trên kết nối của test và bên trong transaction của ứng dụng đều là `UTC` | — |
| TC-85-02 | DoD #1, #3 | e2e Postgres | 9 dòng ở bảng §2: dòng ghi nợ lùi ngày 1.000đ, `Clock` cố định, hỏi 600đ với hạn mức ngày 1.500đ → tính vào: `LIMIT_PER_DAY_EXCEEDED`, không tính: `null` | `LIMIT_PER_DAY_EXCEEDED` |
| TC-85-03 | DoD #1 | e2e Postgres | Mỗi dòng của TC-85-02 chạy với bốn múi giờ phiên (`UTC`, `Asia/Ho_Chi_Minh`, `America/Los_Angeles`, `Pacific/Kiritimati`) cho cùng kết quả | — |
| TC-85-04 | DoD #1, Expect | e2e HTTP | Đồng hồ 14/3 23:59:59+07: nguồn đã chuyển 200.000.000đ lúc 14/3 23:59:59 → `POST` 1đ bị từ chối; đồng hồ sang 15/3 00:00:00+07 → `POST` 50.000.000đ `201`. Nguồn thứ hai có 200.000.000đ lúc 15/3 00:00:00 → `POST` 1đ `422` | `LIMIT_PER_DAY_EXCEEDED` |
| TC-85-05 | DoD #3 | unit | `sync-guard.service.ts` không đọc giờ máy: không có `new Date(`, `Date.now(`, `clock_timestamp`, `now()` ngoài `this.clock.now()` | — |
| TC-85-06 | DoD #3 | e2e Postgres | Bất biến sổ cái PASS sau mỗi ca (dòng lùi ngày đủ cặp, số dư khớp) | — |
| Quy trình | DoD #4 | — | Merge, CI, Dev review | waiver |

## 5. Test thủ công

`node backend/scripts/manual-dbs85.cjs` (Docker, Node 24): app thật, JWT thật, Postgres 17 chạy UTC.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-85-01 | `SHOW timezone` và `SELECT` mốc ngày (`date_trunc … AT TIME ZONE 'Asia/Ho_Chi_Minh'`) cho 23:59:59+07 và 00:00:00+07 | `UTC`; hai thời điểm cho hai mốc ngày khác nhau (cách nhau 24 giờ) |
| M-85-02 | Nạp 300.000.000đ cho Vũ Thị Giang; chèn lùi ngày giao dịch 200.000.000đ lúc 14/3 23:59:59+07; đặt đồng hồ 14/3 23:59:59+07; chuyển 1đ cho Bùi Văn Hải | `422 LIMIT_PER_DAY_EXCEEDED` |
| M-85-03 | Đặt đồng hồ 15/3 00:00:00+07; chuyển 50.000.000đ | `201 COMPLETED` |
| M-85-04 | Đặt đồng hồ 15/3 00:00:00+07; chèn lùi ngày giao dịch 200.000.000đ lúc 15/3 00:00:00+07 cho người nhận Hải rồi Hải chuyển 1đ | `422 LIMIT_PER_DAY_EXCEEDED` (00:00:00 đã thuộc ngày mới) |
| cleanup | Dọn | `DBS-85 cleanup PASS` |

## 6. Domain review (AI)

**Reviewer:** chính agent (Sonnet 5.5), 2026-11-08; đọc `sync-guard.service.ts`, `limits.config.ts`, database-design nguyên tắc 6 và §6, BRD BR-06. Không dùng subagent.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | Chỉ test 23:59:59/00:00:00 sẽ không bắt được cài đặt tính theo ngày UTC | Hai điểm đối chứng (G1 câu 2), TC-85-02 |
| 2 | should-fix | Kết quả có thể phụ thuộc múi giờ phiên | TC-85-03 |
| 3 | minor | Chèn lùi ngày bằng SQL có thể làm hỏng bất biến | Chèn cả cặp, đúng số dư; TC-85-06 |
| 4 | minor | Mốc `>=` bao gồm 00:00:00.000 | Dòng 3 của bảng §2 |
| 5 | minor | Dòng ghi nợ lùi ngày nằm trước các dòng "thật" của cùng tài khoản trong cùng test | Mỗi ca dùng tài khoản mới; ca HTTP chỉ dùng ngày cố định ở quá khứ |

Không có phát hiện blocking. Verdict tự đánh giá: APPROVE.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Kết quả đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `test/support/backdated-transfer.ts`, `test/db/midnight-boundary.db-spec.ts` (TC-85-01..04, 06) | TC-85-02..04 | điền khi chạy (đột biến) | `npm run test:db -- --runInBand midnight-boundary` | `test(ledger): daily limit resets at 00:00 Vietnam time with the DB on UTC (DBS-85)` |
| 2 | `sync-guard.service.spec.ts` (TC-85-05) | TC-85-05 | điền khi chạy | `npm test -- sync-guard` | cùng commit |
| 3 | `scripts/manual-dbs85.cjs` | M-85-01..04 | — | `node backend/scripts/manual-dbs85.cjs` | `test(ledger): DBS-85 manual driver` |
| 4 | docs: doc này, index, README ledger, xóa BL-154, cập nhật BL-176 | — | — | `check-doc-links.mjs` | `docs(ledger): record DBS-85 evidence` |

Rủi ro: không có thay đổi production. Đột biến: tính theo ngày UTC (`AT TIME ZONE 'UTC'`) → TC-85-02 hàng 8–9 phải hỏng; đổi `>=` thành `>` → hàng 3 phải hỏng; dùng `SENT_TODAY_SQL` với `now()` thật → mọi hàng lệch.

**Quyết định ở G3 (agent tự duyệt):** theo bảng trên.

## 8. Kết quả

- **Lệnh kiểm tra** (Node 24.22.2, `backend/`, commit code cuối `34a030b`; SHA ở dòng đầu `manual-test.txt`):

| Lệnh | Kết quả |
|---|---|
| `npm run lint:check`, `typecheck`, `build` | đạt (mã thoát 0) |
| `npm test -- --runInBand` | **1074/1074**, 66 suite (+1 ca TC-85-05) |
| `npm run test:db -- --runInBand` | **693/693**, 38 suite (+11 ca, +1 suite so với 682/37 của DBS-84) |
| `npm run test:e2e` | không chạy cục bộ (task chỉ thêm test DB và unit, không đụng code `e2e`); CI chạy |
| `node scripts/manual-dbs85.cjs` | 4/4 bước + dọn dẹp đạt |

  0 test bị `.skip/.only/.todo`.

- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-85-01 | `midnight-boundary.db-spec.ts` › `TC-85-01` (`SHOW timezone` = `UTC` ở kết nối test và trong transaction của ứng dụng) | đạt |
| TC-85-02 | `midnight-boundary.db-spec.ts` › `TC-85-02 / TC-85-03 …` (9 hàng bảng §2). **Đột biến 1:** `AT TIME ZONE 'UTC'` → 5 hàng + ca API hỏng. **Đột biến 2:** `>` thay `>=` → 2 hàng + ca API hỏng | đạt |
| TC-85-03 | cùng test, mỗi hàng chạy với 4 múi giờ phiên (`UTC`, `Asia/Ho_Chi_Minh`, `America/Los_Angeles`, `Pacific/Kiritimati`) | đạt |
| TC-85-04 | `midnight-boundary.db-spec.ts` › `TC-85-04 through the API …` | đạt |
| TC-85-05 | `sync-guard.service.spec.ts` › `TC-85-05 …`. **Đột biến:** `new Date()` thay `this.clock.now()` → ca hỏng | đạt |
| TC-85-06 | `afterEach` của `midnight-boundary.db-spec.ts`: `checkLedgerInvariants` PASS sau từng ca | đạt |
| Quy trình | DoD #4 | chưa làm: Dev review (BL-176) |

  6 ca/nhóm đạt, 0 đơn giản hóa. Các test không đỏ trước khi viết vì hành vi đã đúng từ DBS-84 (task là bổ sung bằng chứng); độ nhạy được chứng minh bằng ba đột biến ở trên.

- **Test thủ công** (output thô [manual-test.txt](screenshots/DBS-85/manual-test.txt)):

| Bước | Kết quả thật | Kết quả |
|---|---|---|
| M-85-01 | `SHOW timezone = UTC`; mốc ngày của 23:59:59+07 là `2026-03-13 17:00:00+00`, của 00:00:00+07 là `2026-03-14 17:00:00+00` | đạt |
| M-85-02 | Giang đã chuyển 200.000.000đ lúc 14/3 23:59:59+07, đồng hồ cùng lúc, chuyển 1đ → 422 `LIMIT_PER_DAY_EXCEEDED` | đạt |
| M-85-03 | Đồng hồ 15/3 00:00:00+07, chuyển 50.000.000đ → 201 `COMPLETED` | đạt |
| M-85-04 | Khánh đã chuyển 200.000.000đ đúng 15/3 00:00:00+07; đồng hồ cùng lúc, 1đ → 422 | đạt |
| cleanup | JWKS, database tạm, container đã dọn; bất biến sổ cái PASS | đạt |

  Seed SQL: user/customer/tài khoản số dư 0 và hai giao dịch lùi ngày (ledger chỉ-thêm, nên chèn đúng thời điểm).

- **Phạm vi so với §7:** khớp. Thêm `sync-guard.service.spec.ts` (TC-85-05), `docs/BACKLOG.md` (xóa BL-154, cập nhật BL-176).
- **Ảnh chụp:** không có (waiver); bằng chứng là `manual-test.txt`.
- **Lệch so với kế hoạch:** (1) commit đầu lọt lỗi lint `no-unsafe-return` ở test (đã sửa ở commit kế); (2) không chạy `test:e2e` cục bộ; (3) **CI `db` đỏ lần đầu**: Postgres của CI báo `SHOW timezone` = `Etc/UTC`, máy local báo `UTC` (cùng múi giờ). TC-85-01 khẳng định đúng `UTC`, nên hỏng trên CI; đã sửa thành chấp nhận cả hai tên và kiểm thêm độ lệch bằng 0, chạy lại test thủ công trên SHA mới.
- **Bàn giao:** BL-176 (thêm PR này). Đã xóa BL-154. Không phát hiện lỗi production.

## 9. Tài liệu đã cập nhật

`backend/src/modules/ledger/README.md` (bỏ câu «chưa có test nửa đêm»), `docs/features/README.md`, `docs/BACKLOG.md` (xóa **BL-154**, thêm PR vào BL-176).
