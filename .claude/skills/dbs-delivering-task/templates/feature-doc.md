# DBS-<n> · <Tóm tắt task>

<!-- Tài liệu làm việc, không phải báo cáo: ưu tiên bảng hơn văn xuôi; không chép lại DoD hay danh sách case ở §8 ngoài ID. Task nhỏ nên trong khoảng 2.500 từ; nếu dài hơn thì cắt văn xuôi trước, không bao giờ cắt kết quả test thủ công. -->

> **Status:** (đặt sau mỗi gate) Draft (đang làm, đến G2) → Design approved (sau G2) → Plan approved (sau G3) → Implemented (sau G4) · **Vai:** #<n> <tên vai> · **Cặp đôi review:** #<n> · **Nhánh:** `<type>/DBS-<n>-<slug>` · **PR:** — · **Cập nhật:** YYYY-MM-DD

## 1. Bối cảnh

- **Task trên board:** loại, tuần, Deliverable/Demo. **Expect:** chép nguyên văn.
- **DoD:** chép nguyên văn, đánh số từng gạch đầu dòng.
- **Phụ thuộc:** từng task kèm trạng thái thật trong repo (không chỉ theo board).
- **Đã có gì:** file code, tài liệu, task trước liên quan (link). **Baseline:** kết quả bốn lệnh kiểm tra, kèm số test.
- **Ngoài phạm vi:** những gì task này cố ý không làm, và task nào làm.
- **Câu hỏi mở:** đánh số, mỗi câu có đề xuất. **Quyết định ở G1:** ghi lại sau khi được duyệt.

## 2. Hành vi

Mỗi hành vi một mục: điều kiện → kết quả, ví dụ request/response JSON thật, `errorCode` khi lỗi, quy tắc và ca biên (giá trị cụ thể). Task không có API thì mô tả những gì hệ thống chấp nhận và từ chối.

## 3. Kiến trúc

- **Vị trí:** module, role (`api` / `worker` / cả hai), file chính.
- **Interface dùng và cung cấp:** chữ ký thật lấy từ code. Người gọi (grep) của symbol nào bị đổi.
- **Dữ liệu:** bảng, cột, index, ràng buộc chạm tới (đối chiếu `database-design.md`).
- **Ranh giới transaction:** những gì nằm trong một `TransactionService.run`; không gọi Redis, HTTP, SQS bên trong (ngoại lệ duy nhất: outbox relay, có transaction riêng và không dùng retry deadlock của `TransactionService`).
- **Sơ đồ:** mermaid sequence hoặc flow nếu có từ hai thành phần trở lên.
- **Bug:** nguyên nhân gốc (đã tái hiện) và vì sao cách sửa đúng chỗ.
- **Thay đổi cấp hệ thống:** mục docs/03, `_shared`, ADR cần sửa trong cùng PR, hoặc "không có".

## 4. Test cases tự động

| ID | Truy vết (DoD / AC) | Lớp (unit / integration–e2e Postgres thật / security) | Given · When · Then | `errorCode` mong đợi |
|---|---|---|---|---|
| TC-<n>-01 | DoD #1, AC-x.y | e2e | … | … |

Mọi gạch đầu dòng DoD có ít nhất một case. Gạch đầu dòng chỉ là quy trình (merge PR, review, CI) ghi một dòng "quy trình" thay vì case.

## 5. Test thủ công

Kịch bản chạy tay bằng ứng dụng thật, theo `references/manual-testing.md`. Có ít nhất một đường thành công, một đường bị từ chối hoặc ca biên, và một ca lỗi hay phục hồi nếu task có (kill, gửi lại, tắt Redis).

| Bước | Việc làm (lệnh hoặc thao tác) | Kết quả mong đợi |
|---|---|---|
| M-<n>-01 | … | … |

Điều kiện chạy: cần môi trường nào (docker compose, token vai nào, dữ liệu mẫu).

## 6. Domain review (AI)

**Reviewer:** subagent, model …, ngày … · **Kết quả:** N phát hiện (blocking a, should-fix b, minor c), verdict … · [trả lời nguyên văn](screenshots/DBS-<n>/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | … | đã sửa §2 / không sửa vì … / chuyển sang §8 Bàn giao |

**Quyết định ở G2:** ghi lại sau khi được duyệt.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Kết quả đỏ (1 dòng, điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | … | TC-<n>-01 | … | `npm run test:e2e -- <file>` | `type(module): …` |

Rủi ro và cách lùi. **Quyết định ở G3:** ghi lại sau khi được duyệt.

## 8. Kết quả

- **Lệnh kiểm tra** (chạy lúc bàn giao): kết quả có số lượng, dán dạng text.
- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-<n>-01 | `test/….e2e-spec.ts` › tên test | đạt / đơn giản hóa (lý do) / chưa làm (lý do) |

- **Test thủ công:** từng bước M-<n>-NN với lệnh, phản hồi thật (rút gọn) và kết quả *đạt / không đạt / chưa chạy (lý do)*. Output thô nằm ở [manual-test.txt](screenshots/DBS-<n>/manual-test.txt). Bước nào dùng SQL seed thì ghi "seed SQL".
- **Phạm vi so với §7:** kết quả `git diff --stat main...HEAD` đối chiếu với danh sách file ở §7.
- **Ảnh chụp** (`docs/features/screenshots/DBS-<n>/`; task chỉ sửa docs thì ghi "không áp dụng"):

![Mô tả](screenshots/DBS-<n>/01-ten.png)

- **Lệch so với kế hoạch:** nêu rõ từng chỗ, kèm lý do và **lần người duyệt đồng ý** (gate phụ). Chỗ lệch chưa được duyệt thì chưa qua G4.
- **Bàn giao cho vai khác:** vai nào, việc gì, đề xuất; hoặc "không có".

## 9. Tài liệu đã cập nhật

Danh sách file docs khác đã sửa trong PR này, hoặc "không có".

## Checklist G4 (dán vào tin nhắn G4, tick từng dòng)

- [ ] N/M test case đạt đủ độ sâu, K đơn giản hóa (nêu lý do từng cái)
- [ ] Test thủ công chạy trên commit cuối đổi code (SHA ở dòng đầu `manual-test.txt`): kết quả từng bước M-<n>-NN; đường thành công đã chạy (trừ khi G1 đã miễn); mọi bước "chưa chạy" nêu tên để người duyệt chấp nhận
- [ ] Ảnh chụp có đủ trong `screenshots/DBS-<n>/` (hoặc nêu từng ảnh còn thiếu); `manual-test.txt` đã xóa token, header `Authorization`, id tài khoản AWS và ARN
- [ ] `git diff --stat main...HEAD` khớp danh sách file ở §7; mỗi file lạ có phê duyệt gate phụ ghi ở §8
- [ ] Bốn lệnh kiểm tra (hoặc baseline của loại task) chạy lúc bàn giao, có số đếm
- [ ] Mọi doc có fact bị đổi đã sửa; `check-doc-links.mjs` sạch; trạng thái doc đang là Plan approved (chuyển thành Implemented sau khi G4 được duyệt)
- [ ] Việc bàn giao cho vai khác đã ghi ở §8
