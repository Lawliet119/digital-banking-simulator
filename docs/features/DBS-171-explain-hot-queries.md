# DBS-171 · EXPLAIN các truy vấn nóng trên dữ liệu đủ lớn

> **Trạng thái:** Kiểm chứng cục bộ; chờ CI và Dev review · **Vai:** Dev · **Nhánh:** `perf/DBS-171-explain-hot-queries` · **PR:** [#139](https://github.com/Lawliet119/digital-banking-simulator/pull/139) · **Cập nhật:** 2026-11-11

> **Ghi chú về lịch sử (2026-11-11):** bản đầu của PR chép tay năm câu SQL vào một test mới (không phải SQL của service), thiếu R2/R4/R5, trùng TC-84-01, TC-87 và TC-103-18, có ba bộ số đo mâu thuẫn, ghi SHA sai và sửa timeout toàn cục. Một review độc lập (subagent, 2026-11-11) chỉ ra điều đó. Bản này bỏ test chép tay, chỉ thêm phần thật sự mới (plan của relay outbox, trên SQL thật), và gom cả năm truy vấn vào một bảng trỏ tới test dùng SQL thật. G1 đến G3 và domain review độc lập lúc làm bản đầu không được ghi; không dựng lại dấu vết đó.

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 7, High, Demo 5. **Thực trạng:** «database-design §7 liệt kê truy vấn nóng và plan mong đợi; chưa kiểm trên dữ liệu lớn.» **Expect:** «Mọi truy vấn nóng dùng đúng index.»
- **DoD (chép nguyên văn từ board):**
  1. Sinh dữ liệu đủ lớn (generate_series hoặc dữ liệu generator) rồi chạy EXPLAIN (ANALYZE, BUFFERS) cho: hạn mức ngày, lịch sử trang đầu, R2/R4/R5, relay outbox, audit theo correlationId
  2. So với ngưỡng ở §7; không còn Seq Scan trên bảng lớn
  3. Lưu kết quả vào database-design hoặc docs/components/ledger; sửa index nếu cần (cùng migration)
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc:** DBS-84, DBS-87 Done; DBS-135 có trên `main`.
- **Đã có trên `main` (EXPLAIN với SQL thật của service):** hạn mức ngày (TC-84-01), lịch sử trang đầu (`transaction-history-plan.db-spec.ts`), R1/R2/R4/R5 (TC-109-05), audit theo correlationId (TC-103-18).
- **Phần mới của task này:** (a) relay outbox chưa có test nào EXPLAIN truy vấn lấy lô: thêm `outbox-relay-plan.db-spec.ts` dùng hằng số `PENDING_BATCH_SQL` (tách từ `outbox-relay.service.ts`, SQL không đổi) trên 400.000 dòng đã gửi; (b) DoD 3: bảng tổng hợp ở `docs/components/ledger/query-plans.md` và §7.3 của database-design.
- **Quyết định (agent tự quyết):**
  - Không viết lại bốn EXPLAIN đã có (chúng dùng SQL thật); bảng tổng hợp trỏ tới chúng thay vì sao chép số.
  - Ngưỡng thời gian của relay trong test là 25 ms (biên cho CI) trong khi §7 nói «vài ms»; số đo thật ghi ở bảng.
  - Không cần chỉ mục hay migration mới (cả năm plan đã đúng).
- **Ngoài phạm vi:** đo trên dữ liệu generator fraud và trên RDS thật (BL-240).

## 2. Hành vi

| # | Điều kiện | Kết quả |
|---|---|---|
| S1 | outbox có 400.000 dòng đã gửi và 1.000 dòng chưa gửi; chạy `PENDING_BATCH_SQL` với `limit` 100, các loại sự kiện được route, 0 hoặc 50 id «parked» | `Index Scan` trên `outbox_unpublished_idx`, không `Seq Scan`, không `Sort`, đọc không quá 101 dòng, dưới 500 block, trung vị 5 lần dưới 25 ms |

## 3. Kiến trúc

`backend/src/modules/outbox/outbox-relay.service.ts` (hằng số `PENDING_BATCH_SQL` xuất ra, thân hàm gọi nó; không đổi hành vi); `backend/test/db/outbox-relay-plan.db-spec.ts`; `docs/components/ledger/query-plans.md`; `docs/components/_shared/database-design.md` §7.3. Không đổi schema.

## 4. Test cases tự động

| ID | Truy vết | Nội dung |
|---|---|---|
| TC-171-01 | DoD 1, 2 (relay) | S1, hai biến thể (0 và 50 id parked) |
| TC-171-02 | DoD 1, 2 (bốn truy vấn còn lại) | tham chiếu TC-84-01, `transaction-history-plan.db-spec.ts`, TC-109-05, TC-103-18: đã có trên `main`, không viết lại |
| TC-171-03 | DoD 3 | `check-doc-links` sạch; bảng ở `query-plans.md` khớp test |
| TC-171-04 | DoD 4 | PR merge, CI xanh, Dev review |

Hành vi của relay (`OutboxRelayService`) không đổi và đã có test riêng (DBS-90); `typecheck` và các test hiện có chứng minh phần tách hằng số.

## 5. Test thủ công

`cd backend && npm run test:db -- test/db/outbox-relay-plan.db-spec.ts` trên commit cuối, ghi số đo thật (`relay_poll`); chạy thêm bốn spec EXPLAIN có sẵn để xác nhận chúng vẫn đạt. Kết quả ở `screenshots/DBS-171/manual-test.txt` (SHA ở dòng đầu).

## 6. Domain review (AI)

Review độc lập (subagent, 2026-11-11), nguyên văn không lưu. Phát hiện và xử lý: SQL chép tay thay vì SQL service (đã bỏ test, dùng `PENDING_BATCH_SQL`); thiếu R2/R4/R5 (tham chiếu TC-109-05 dùng `factQueries`); trùng TC-84-01, TC-87, TC-103-18 (đã bỏ bản trùng); ba bộ số đo mâu thuẫn và một claim sai về thứ tự index (`event_id` thay vì `id`) trong `query-plans.md` (đã viết lại từ số đo thật và nguồn); SHA sai và sửa timeout toàn cục (đã bỏ). Chưa có lượt review thứ hai. Self-review đầu bị loại.

## 7. Kế hoạch triển khai

Một commit mã (tách hằng số, test, xóa test chép tay), một commit doc và bằng chứng. Lùi: revert; không đổi schema.

## 8. Kết quả

- `outbox-relay-plan.db-spec.ts` đạt: **0,096 ms** (0 parked) và **0,110 ms** (50 parked), 5 block, `outbox_unpublished_idx`, trên 400.000 dòng đã gửi; lint và typecheck sạch.
- **Chưa làm:** dữ liệu generator fraud và RDS thật (BL-240); số đo 1 triệu dòng trong CI (CI dùng 100 đến 400 nghìn dòng, 1 triệu dòng là lần đo tay §7.1 và §7.2); ảnh chụp (đầu ra là log test); review độc lập thứ hai; DoD 4.
- **Bàn giao:** BL-240.

## 9. Tài liệu đã cập nhật

`docs/components/ledger/query-plans.md`, `docs/components/_shared/database-design.md` (§7.3), `docs/features/README.md`, `docs/BACKLOG.md` (BL-240), doc này.

## Checklist G4 (2026-11-11)

- [x] Test mới đạt đủ độ sâu; bốn truy vấn còn lại dựa vào test có sẵn (đơn giản hóa nêu ở §1)
- [x] Test thủ công trên commit cuối (SHA ở dòng đầu `manual-test.txt`)
- [ ] Ảnh chụp: không có (lý do ở §8)
- [ ] G1 đến G3 và domain review độc lập lúc làm: không có (ghi ở đầu tài liệu)
- [x] Bàn giao và DoD chưa đạt ở §8 và BL-240
