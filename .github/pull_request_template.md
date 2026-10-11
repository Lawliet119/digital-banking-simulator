## Thay đổi gì

<!-- Mô tả ngắn: PR này làm gì, vì sao -->

Task: DBS-
Feature doc: docs/features/DBS-

## Loại thay đổi

- [ ] Tính năng mới
- [ ] Sửa lỗi
- [ ] Hạ tầng / CI
- [ ] Tài liệu / ADR
- [ ] Test

## Liên quan tới

<!-- Use case, FR, NFR, AC trong docs/02 — ví dụ: UC-5, FR-LED-05, AC-5.4 -->

## Đối chiếu test case

<!-- Mỗi tiêu chí trong DoD của task và mỗi AC (docs/02 §3) mà PR đụng tới: test nào chứng minh, độ sâu có khớp không (khớp / đơn giản hóa + lý do / chưa làm + lý do) -->

| DoD / AC | Test | Khớp? |
|---|---|---|

## Kiểm tra

- [ ] Chạy được ở local với `docker compose`
- [ ] Có test; logic về tiền được test trên PostgreSQL thật
- [ ] CI xanh
- [ ] Không có secret trong code, log, commit
- [ ] Feature doc đủ mục 1–8 (đã qua 4 gate), ảnh chụp ở `docs/features/screenshots/DBS-<n>/`
- [ ] Đã cập nhật tài liệu / ADR / OpenAPI nếu cần (đổi thiết kế → `docs/03` hoặc `docs/components/_shared/`)

## Ghi chú cho người review

<!-- Chỗ nào cần xem kỹ, rủi ro, cách test thủ công -->
