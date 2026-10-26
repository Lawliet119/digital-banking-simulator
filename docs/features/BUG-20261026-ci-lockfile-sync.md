# BUG-20261026-ci-lockfile-sync · `backend/package-lock.json` không đồng bộ, CI đỏ trên `main`

<!-- Bug fix, không có board key. Tài liệu ngắn: nguyên nhân, test tái hiện, cách sửa, test thủ công trước/sau. -->

> **Status:** Implemented (sau G4) · **Vai:** Dev · **Nhánh:** `fix/BUG-20261026-ci-lockfile-sync` · **PR:** [#31](https://github.com/Lawliet119/digital-banking-simulator/pull/31) · **Cập nhật:** 2026-10-26

## 1. Bối cảnh

- **Không có board key.** Phát hiện khi kiểm tra CI trên `main` theo yêu cầu người dùng, không nằm trong task nào trên sheet.
- **Expect:** CI (`.github/workflows/ci.yml`, 6 job lint/typecheck/unit/e2e/db/build) chạy xanh trên `main` sau mỗi lần push, theo DoD của DBS-35.
- **Thực trạng:** commit `82c8e23` ("Feat/dbs 50 jwt auth guard jwks (#29)", merge 2026-10-26 11:04 +07) làm cả 6 job đỏ ngay ở bước `npm ci`. Run: [40267168552](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/40267168552).
- **Phụ thuộc:** không có.
- **Đã có gì:** PR #29 (DBS-50) thêm dependency `jose` (`^5.10.0`) vào `backend/package.json` nhưng `backend/package-lock.json` đi kèm commit không khớp — thiếu `@emnapi/core@1.11.3` và `@emnapi/runtime@1.11.3` (optional peer deps transitive của `@napi-rs/wasm-runtime`, dùng bởi một resolver gọi tới trong cây phụ thuộc dev). `npm ci` từ chối cài khi lockfile không khớp `package.json` tuyệt đối:
  ```
  npm error code EUSAGE
  npm error `npm ci` can only install packages when your package.json and
  package-lock.json or npm-shrinkwrap.json are in sync. Please update your
  lock file with `npm install` before continuing.
  npm error Missing: @emnapi/core@1.11.3 from lock file
  npm error Missing: @emnapi/runtime@1.11.3 from lock file
  ```
- **Baseline:** không chạy được — `npm ci` tại gốc vấn đề chính là baseline đỏ. Xác nhận lại trên `main` tại chỗ (Windows, npm 11.6.2): `npm ci` **pass** cục bộ (cây phụ thuộc tối ưu hoá khác theo platform: Windows không cần `@emnapi/*`, các gói toàn `peer: true/optional` bị bỏ qua khác nhau theo OS). CI chạy `ubuntu-24.04` + Node 24 nên cần lockfile sinh trên Linux.
- **Ngoài phạm vi:** không đổi version `jose`, không đổi hành vi DBS-50 (JWT guard). Không sửa các cảnh báo `npm audit` (13 vulnerability có sẵn trước PR #29, không liên quan bug này).
- **Câu hỏi mở:** không có.

## 2. Hành vi

Không áp dụng — đây là sửa lockfile, không đổi hành vi hệ thống. Kết quả mong đợi: `npm ci` (và do đó cả 6 job CI) pass trên `ubuntu-24.04`/Node 24 với cùng `package.json` (không đổi gói hay version nào), chỉ cập nhật cây dependency đã resolve (`package-lock.json`) cho khớp.

## 3. Kiến trúc

- **Vị trí:** `backend/package-lock.json` (duy nhất). Không chạm code nguồn.
- **Nguyên nhân gốc (đã tái hiện):** lockfile của PR #29 được tạo (hoặc merge) trên máy Windows/khác, nơi optional/peer deps dành cho binary WASM fallback (`@emnapi/core`, `@emnapi/runtime`) bị npm loại khỏi cây đã resolve. Trên Linux (CI), các gói này được yêu cầu nên `npm ci` thấy lockfile thiếu mục và từ chối — đúng hành vi an toàn của `npm ci`, không phải lỗi CI.
- **Cách sửa đúng chỗ:** sinh lại `package-lock.json` trong môi trường Linux + Node 24 giống CI (`node:24-bookworm` qua Docker), bằng `npm install --package-lock-only`, rồi xác nhận `npm ci` pass trong cùng container. Không sửa `package.json`.
- **Thay đổi cấp hệ thống:** không có.

## 4. Test cases tự động

| ID | Truy vết (DoD / AC) | Lớp | Given · When · Then | `errorCode` mong đợi |
|---|---|---|---|---|
| TC-BUG-01 | CI xanh (DoD DBS-35 #1), quy trình | script tái hiện (Docker, không phải unit test) | Given lockfile cũ trong container `node:24-bookworm` sạch, When chạy `npm ci`, Then thoát mã khác 0 với `npm error EUSAGE … Missing: @emnapi/core` | n/a |

Không có case unit/e2e/db vì bug không chạm logic nghiệp vụ; bằng chứng là `npm ci` chạy trong container giống CI, ghi ở §8 thay vì bảng test tự động của ứng dụng.

## 5. Test thủ công

| Bước | Việc làm (lệnh hoặc thao tác) | Kết quả mong đợi |
|---|---|---|
| M-BUG-01 | Trong `node:24-bookworm` sạch, mount `backend/`, chạy `npm ci` với lockfile **cũ** (trước fix) | Thoát lỗi `EUSAGE`, thiếu `@emnapi/core`, `@emnapi/runtime` |
| M-BUG-02 | Cùng container, chạy `npm install --package-lock-only` để sinh lockfile mới | `package-lock.json` đổi (diff khác rỗng) |
| M-BUG-03 | Container sạch mới, mount `backend/` với lockfile **mới**, chạy `rm -rf node_modules && npm ci` | Thoát mã 0, in `CI_OK` |

Điều kiện chạy: Docker Desktop bật, image `node:24-bookworm` (cùng Node version với CI: `NODE_VERSION: "24"` trong `ci.yml`).

## 6. Domain review (AI)

Bỏ qua — thay đổi chỉ là lockfile tự sinh bởi `npm install`, không có logic hay quyết định kiến trúc để review. Theo `task-kinds.md`, đây là "Test or harness"/CI-adjacent nhỏ nhất, rủi ro thấp (không đổi dependency version, không đổi code).

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Kết quả đỏ (1 dòng, điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `backend/package-lock.json` | M-BUG-01 (đã chạy, xem §8) | `npm error code EUSAGE … Missing: @emnapi/core@1.11.3 from lock file` (xác nhận trong container `node:24-bookworm` sạch, mount lockfile cũ từ commit `82c8e23`) | `docker run --rm -v backend:/app -w /app node:24-bookworm npm ci` | `fix(deps): regenerate package-lock.json for jose transitive deps (BUG-20261026)` |

Rủi ro: lockfile mới có thể kéo version khác cho vài gói dev (đã thấy diff 28 dòng thêm/31 dòng bớt, chủ yếu field `peer: true` được thêm lại và 3 gói `@emnapi/*`/`@napi-rs` mới). Không ảnh hưởng runtime vì đều là dev/optional deps. Cách lùi: revert commit, quay về lockfile cũ (CI vẫn đỏ, không làm tệ hơn hiện trạng).

**Quyết định ở G3:** duyệt nguyên vẹn, không có câu hỏi mở.

## 8. Kết quả

- **Lệnh kiểm tra:** không áp dụng bốn lệnh baseline backend (lint/typecheck/test/e2e) — task không chạm code nguồn, chỉ lockfile. Bằng chứng duy nhất là `npm ci` trong container Linux giống CI (dưới đây).
- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-BUG-01 | `docker run --rm -v .../old:/app -w /app node:24-bookworm sh -c "npm ci"` với lockfile cũ (commit `82c8e23`) | đạt — thoát `EUSAGE`, thiếu `@emnapi/core@1.11.3`, `@emnapi/runtime@1.11.3`, khớp CI run [40267168552](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/40267168552) |

- **Test thủ công:** chạy trên commit `cac890e426e872f147510859a5fd59d94a86ac83` (commit cuối đổi code). Output thô ở [manual-test.txt](screenshots/BUG-20261026-ci-lockfile-sync/manual-test.txt).

| Bước | Lệnh | Phản hồi (rút gọn) | Kết quả |
|---|---|---|---|
| M-BUG-01 | `npm ci` trong `node:24-bookworm` sạch, mount package.json + lockfile **cũ** (từ `82c8e23`) | `npm error code EUSAGE … Missing: @emnapi/core@1.11.3 from lock file / Missing: @emnapi/runtime@1.11.3 from lock file` | đạt |
| M-BUG-02 | `npm install --package-lock-only` trong container sạch, từ package.json + lockfile cũ | `added 914 packages... 13 vulnerabilities (có sẵn trước PR #29)`; lockfile sinh ra **byte-giống hệt** `backend/package-lock.json` tại commit `cac890e` (`diff -q` → identical) | đạt |
| M-BUG-03 | `rm -rf node_modules && npm ci` trong container sạch mới, mount lockfile **mới** (commit `cac890e`) | exit code 0, in `CI_OK` | đạt |

Không có đường "thất bại/phục hồi" riêng cho task này (bug chỉ có hai trạng thái: lockfile sync hoặc không); M-BUG-01 đóng vai trò ca biên "trước fix", M-BUG-03 là đường thành công.

- **Phạm vi so với §7:** `git diff --stat main...HEAD` → chỉ `backend/package-lock.json` (1 file, 28 dòng thêm/31 dòng bớt), khớp đúng §7. Không có file nào ngoài kế hoạch.
- **Ảnh chụp:** không áp dụng — bug này không có UI/API để chụp, bằng chứng là log `npm ci`/`npm install` nguyên văn trong `manual-test.txt` (theo `manual-testing.md`: "Docs-only tasks have no manual test: say so and take none" áp dụng tương tự cho log-only evidence; không có secret/token trong log nên không cần redact).
- **Lệch so với kế hoạch:** không có.
- **Bàn giao cho vai khác:** không có. Lưu ý: 13 `npm audit` vulnerability (7 moderate, 5 high, 1 critical) có sẵn từ trước PR #29, ngoài phạm vi bug này — không mở backlog row vì đã được loại ra ở §1 "Ngoài phạm vi" (nếu cần theo dõi riêng, đây là việc của một task khác, không phải phát sinh từ bug này).

## 9. Tài liệu đã cập nhật

- `docs/features/BUG-20261026-ci-lockfile-sync.md` (chính tài liệu này).
- `docs/features/screenshots/BUG-20261026-ci-lockfile-sync/manual-test.txt` (bằng chứng test thủ công).
- `docs/features/README.md` (thêm dòng cho task này).

## Checklist G4

- [x] 1/1 test case đạt đủ độ sâu, 0 đơn giản hóa.
- [x] Test thủ công chạy trên commit cuối đổi code `cac890e426e872f147510859a5fd59d94a86ac83` (SHA ở dòng đầu `manual-test.txt`): M-BUG-01/02/03 đều đạt; đường thành công (M-BUG-03) đã chạy.
- [x] Không có ảnh chụp — nêu rõ ở §8, lý do: không có UI/API để chụp, bằng chứng là log nguyên văn.
- [x] `manual-test.txt` không chứa token, header `Authorization`, id tài khoản AWS hay ARN (chỉ log `npm ci`/`npm install`) — không cần redact.
- [x] `git diff --stat main...HEAD` khớp danh sách file ở §7 (chỉ `backend/package-lock.json`).
- [x] Bốn lệnh kiểm tra không áp dụng cho loại task này (lockfile-only); bằng chứng thay thế là `npm ci` trong container CI-giống, đã chạy và ghi ở §8.
- [x] Docs đã sửa: `docs/features/README.md` (thêm dòng); `check-doc-links.mjs` sẽ chạy trước khi trình G4.
- [x] Không có bàn giao vai khác, không có DoD chưa đạt, không có `BL-NNN` mới.
