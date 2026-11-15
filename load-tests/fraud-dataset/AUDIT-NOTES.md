# Ghi chú kín cho DBS-146 (chỉ Dev dataset đọc)

> Thư mục này là phía «#6» của bức tường dữ liệu (FRAUD guide §6.2). Không trích nội dung file này sang `docs/`, PR description hay tin nhắn cho #4.

## Cơ chế của các phát hiện (đo 2026-11-15 trên tune mặc định `dbs-split-v1`, generator trước DBS-146)

- `scenarios.mjs` đặt `createdAt = START − 200 ngày` cho **mọi** khách của nhóm kịch bản (trừ BUST_OUT và HN_NEW_SALARY, đặt mở trước giao dịch 1 giờ). Trên tune: một giá trị `2025-06-14T17:00:00.000Z` duy nhất.
  - Nhãn `FRAUD`, cột `from_account_created_at = giá trị đó`: 1.987 dòng, 882 fraud → P(FRAUD|v) = 0,444; nền 1.009/101.551 = 0,00994; lift ≈ 45; độ phủ 882/1.009 = 0,874 (phần còn lại là BUST_OUT, tài khoản mở mới).
  - Nhãn `FRAUD`, cột `to_account_created_at = giá trị đó`: 1.946 dòng, 1.009 fraud → P = 0,518; lift ≈ 52; độ phủ 1,0.
  - Theo từng kịch bản, P(S|v) ≤ ~0,065 nên chỉ nhãn `FRAUD` thấy (vòng 2 #1).
- Năm kịch bản SLOW_DRIP, BUST_OUT, FAN_IN, VELOCITY_BURST, STRUCTURING mỗi cái dùng **một** tài khoản đích cho cả tập; ATO_DRAIN và MULE_FANOUT dùng 6 đích chung cho mọi episode; ROUND_TRIP một cặp tài khoản. Đây là loại «hạn chế mô phỏng» (gọi nội bộ là *cấu trúc*, kiểm C3: ≥ 50% dòng của S đi vào một `to_account`).
- Mỗi kịch bản fraud 126–127 dòng ở tune; HN: SELF_TRANSFER 1, NEW_SALARY 1, BORROW_REPAY 2, RENT 3, GROUP_MEAL 5.
- Dự phòng (vòng 3 #2): nếu nhãn `FRAUD` không đủ lift ở seed khác, so thuộc tính **theo tài khoản** giữa tài khoản thuộc nhóm kịch bản và nhóm nền (không theo dòng).

## Sửa ở DBS-146

Ngày mở của khách nhóm kịch bản suy ra bằng SHA-256 của `${seed}:cohort:created:${i}`: `START − (30 + h mod 700) ngày`, cùng công thức với nhóm NORMAL (`generate.mjs` dòng 74), giữ hai ngoại lệ. Không dùng `random()` của planner nên mọi cột khác không đổi.

## Bảng *nội tại* cố định (chốt trước khi chạy, vòng 3 #3)

Rút từ mô tả một câu ở FRAUD guide §6.1 và README dataset. Cặp ngoài bảng là *tell*.

| Kịch bản | Đặc trưng/bin được coi là nội tại | Luật C1 nội tại |
|---|---|---|
| ATO_DRAIN («chuyển gần hết tiền») | `drain_decile` | R6, R5, R1 |
| MULE_FANOUT | — | R5, R1 |
| VELOCITY_BURST («nhiều lệnh nhỏ») | `amount_log`, `amount_window` | R1 |
| BUST_OUT («tài khoản mới chuyển số tiền lớn ngay») | `age_bucket`, `from_created`, `from_created_hour`, `from_created_b30`, `drain_decile`, `amount_log`, `amount_window` | R3, R6 |
| ROUND_TRIP | — | R4 |
| SLOW_DRIP («rút nhỏ dần») | `amount_log`, `amount_window` | — |
| STRUCTURING («chia nhỏ dưới mốc») | `amount_log`, `amount_window` | — |
| FAN_IN | — | — |

Chốt lại 2026-11-15 **trước lần chạy đầu** (gate phụ ở feature doc §8): thêm đặc trưng số tiền cho VELOCITY_BURST, SLOW_DRIP, BUST_OUT theo đúng chữ trong mô tả một câu.

Bảng được viết thành hằng số trong `audit-split.mjs` và kiểm trong `audit-split.test.mjs`.

## Kết quả sau sửa (2026-11-15)

- Nhãn `FRAUD` và mức tài khoản: không còn ứng viên (trước sửa: 4 ứng viên nhãn `FRAUD` lift 15,9–52,2 và 1 ở mức tài khoản, share 0,659).
- Còn **một tell**: ROUND_TRIP × R6. Tài khoản B của cặp chuyển vòng mở với số dư 0, mỗi lượt chuyển ngược trả lại đúng số vừa nhận, nên `amount = from_balance_before` (100%) ở mọi chiều B→A; R6 bắt một nửa số dòng, `recall_pair = 1` vì chỉ có một cặp. Sửa = đổi số dư mở của B (ngữ nghĩa kịch bản), không làm trong DBS-146; BL.
- Hạn chế mô phỏng (C3): sáu kịch bản có ≥ 50% dòng vào một `to_account` (VELOCITY_BURST, BUST_OUT, SLOW_DRIP, STRUCTURING, FAN_IN = 1,0; ROUND_TRIP = 0,5). BL.
