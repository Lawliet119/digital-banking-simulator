# DBS-71 · Domain review độc lập

## Lượt 1 — REVISE

1. λ đề xuất ban đầu 0,35–1,3 không khớp dải 0,3–3 của FRAUD_DETECTION_GUIDE §6.1; dùng phân phối lệch để vẫn đạt khoảng 100.000 giao dịch và test hai đầu dải.
2. Có cộng lương nhưng chưa tạo đỉnh tần suất ngày lương; tăng cường độ ngày lương và test định lượng.
3. Chỉ kiểm không âm chưa đủ; cần funding nội bộ, mỗi giao dịch debit=credit và tổng số dư kể cả funding bằng 0.
4. Điều kiện 80% người nhận quen và số tiền lệch phải cần ngưỡng đo được trong test.
5. Script test tay cần lệnh cụ thể, file output khác nhau và hash thực tế.

## Lượt 2 — APPROVE (raw reply)

Re-review of revised §1–§5 against FRAUD_DETECTION_GUIDE §6.1–6.2: all five earlier findings are addressed. λ now spans 0.3–3 with expected mean ~0.84; payday intensity and quantitative test are specified; funding accounting and debit/credit reconciliation are explicit; distribution tests have measurable bounds; manual hashes use distinct files and concrete commands. Exact 12-column header and #4/#6 wall remain consistent. No new verified findings. Verdict: APPROVE.

Reviewer chỉ đọc tài liệu thiết kế; không đọc generator source hoặc nhãn holdout.
