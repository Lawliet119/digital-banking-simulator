# DBS-189 · Ghép và nộp P4: load test, reliability, dashboard, SLI/SLO, capacity & cost

> **Status:** Plan approved · **Vai:** Dev (ghép) · **Cặp đôi review:** #5 · **Nhánh:** `docs/DBS-189-p4-bundle` · **PR:** — · **Cập nhật:** 2026-11-22

## 1. Bối cảnh

- **Task trên board:** Story, Tuần 8, Deliverable P4, Ưu tiên Highest, board "To Do". **Expect:** Bản P4 đủ các mục thầy yêu cầu, mọi con số truy được về nguồn. **Thực trạng (board):** số liệu load test, sự cố, SLO, chi phí đang nằm rải rác; nguồn P4: components/observability, load-tests.
- **DoD** (nguyên văn):
  1. Bản ghép P4 trong docs/deliverables: báo cáo tải, bảng sự cố (làm gì → phản ứng → thời gian phục hồi), SLO chính thức, dashboard, chi phí
  2. Mọi con số trùng báo cáo gốc (có link)
  3. Nộp đúng hạn; link ghi vào docs/deliverables/README
  4. PR đã merge vào main; Dev review; không còn liên kết hỏng, tên bảng/cột/mã lỗi khớp các tài liệu khác (đã grep)
- **Phụ thuộc** (board và trong repo):

| Task | Board | Trong repo |
|---|---|---|
| DBS-178 dashboard | To Do | xong, `main` #233 ([feature doc](DBS-178-dashboard-complete.md), 25 ảnh × 2 lượt) |
| DBS-167 Redis có/không/chậm | To Do | xong, `main` #232 ([báo cáo 05](../components/load-tests/05-ket-qua-redis-2026-11-22.md)) |
| DBS-181 failover RDS | Done | xong; **failover chưa xác nhận** (AZ không đổi trong raw, [BL-386](../BACKLOG.md)) |
| DBS-184 sự cố cloud | Done | xong ([DBS-184](DBS-184-cloud-incident-scenarios.md)) |
| DBS-182 bảng chi phí HA | To Do | xong ở PR riêng của DBS-182 (nhánh xếp chồng lên PR #235, chưa merge lúc viết) |
| DBS-173 p95 < 300 ms | To Do | làm một phần: p95 tổng đạt, «từng phút < 300 ms» chưa đạt, [BL-419](../BACKLOG.md) (ghi đúng trong bản ghép, không nâng thành «đạt») |

  Agent không sửa board; DBS-179 (nguồn chi phí) ở PR #235.
- **Đã có gì:** [P4-incident-table.md](../deliverables/P4-incident-table.md), [defense-q7](../deliverables/defense-q7-ha-recovery.md), báo cáo tải 02–05, [02-capacity-cost.md](../components/platform-infra/02-capacity-cost.md), mẫu bản ghép [P3-security-devops.md](../deliverables/P3-security-devops.md). **Baseline:** không đổi code; `check-doc-links.mjs` sạch.
- **Ngoài phạm vi:** nộp P4 (việc của người: hạn do giảng viên xác nhận, chưa có trong repo); đo thêm thời gian tới cờ (DBS-174, DBS-175); sửa báo cáo gốc; video.
- **Câu hỏi mở và quyết định ở G1** (agent tự quyết): (1) bản ghép là **tài liệu mới** `docs/deliverables/P4-production-engineering.md`, theo kiểu P3 (trỏ về nguồn, chép số nguyên văn), không viết lại báo cáo; (2) mọi số trong bản ghép được kiểm tự động với nguồn bằng một script (`verify-numbers.py`), vì DoD 2 là «mọi con số trùng báo cáo gốc»; (3) chỗ nguồn nói «chưa» (p95 từng phút, tài khoản nóng, failover RDS chưa xác nhận, chi phí chưa đối chiếu) được ghi nguyên là chưa, không nâng lên «đạt»; (4) việc nộp, cập nhật board và gửi tóm tắt chi phí ghi là việc của người.

## 2. Hành vi

Đầu ra: [`docs/deliverables/P4-production-engineering.md`](../deliverables/P4-production-engineering.md) gồm §1 tóm tắt, §2 báo cáo tải (ba lần đo `baseline`, tài khoản nóng, stress, trùng lặp), §3 bảng sự cố, §4 SLI/SLO chính thức, §5 dashboard, §6 capacity và chi phí (kể cả HA có đáng tiền không), §7 giới hạn và việc còn lại, §8 danh mục nguồn; dòng P4 ở [`docs/deliverables/README.md`](../deliverables/README.md) trỏ tới bản ghép, trạng thái «chưa nộp (việc của người)».
Quy tắc: số chép nguyên văn từ nguồn có link; không tính lại hay làm tròn lại; không diễn giải mạnh hơn nguồn (đo, thiết kế, chưa đo); bảng sự cố tóm tắt chỉ chứa số có trong `P4-incident-table.md` hoặc báo cáo gốc.

## 3. Kiến trúc

Không đổi code, Terraform hay ADR. File mới: `docs/deliverables/P4-production-engineering.md`, `docs/features/DBS-189-p4-bundle.md`, `docs/features/screenshots/DBS-189/{verify-numbers.py,verify-output.txt,domain-review.md}`. File sửa: `docs/deliverables/README.md` (dòng P4), `docs/features/README.md`.

## 4. Test cases (tái tính và đối chiếu)

| ID | Truy vết | Lớp | Given · When · Then |
|---|---|---|---|
| TC-189-01 | DoD 1 | đối chiếu | bản ghép có đủ năm mục: báo cáo tải, bảng sự cố, SLO, dashboard, chi phí · đọc mục lục §1 · mỗi mục có phần và link nguồn |
| TC-189-02 | DoD 2 | script | `verify-numbers.py` · chạy · mọi số của bản ghép có nguyên văn trong tài liệu gốc (thoát 0) |
| TC-189-03 | DoD 2 | script (có thể trượt) | đổi một số trong bản ghép tạm thời (bản sao) · chạy lại · thoát 1, in dòng `FAIL` |
| TC-189-04 | DoD 1, 2 | đối chiếu | các chỗ nguồn ghi «chưa» (p95 từng phút, hot-account ≥ 40.000 dòng, failover RDS chưa xác nhận, RTO Single-AZ, chi phí chưa đối chiếu) xuất hiện ở §7 và ở §1/§3/§6 với cùng mức khẳng định |
| TC-189-05 | DoD 1 | đối chiếu | bảng sự cố §3 khớp từng dòng với `P4-incident-table.md` (số giây, môi trường) |
| TC-189-06 | DoD 3 | quy trình | `docs/deliverables/README.md` có link tới bản ghép; **việc nộp do người làm: chưa đạt trong PR này** |
| TC-189-07 | DoD 4 | quy trình + grep | `check-doc-links.mjs` sạch (kể cả anchor); `check-backlog.mjs` sạch; tên BL, DBS, tên alarm và dashboard khớp (`dbs-dev-overview`, `dbs-dev-outbox-age`…). **Dev review chưa đạt về hình thức** |

## 5. Test thủ công (tài liệu, không gọi AWS)

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-189-01 | `PYTHONUTF8=1 python docs/features/screenshots/DBS-189/verify-numbers.py` | mọi dòng `PASS`, `KET LUAN: mọi số khớp nguồn`, thoát 0 |
| M-189-02 | sao bản ghép ra thư mục tạm, đổi `91,9 / 585,5` thành `92,9 / 585,5`, chạy script trỏ vào bản sao | thoát 1 và có dòng `FAIL bản ghép có 91,9 / 585,5` |
| M-189-03 | mở từng link nguồn ở §2–§6 (bằng `check-doc-links.mjs`) | 0 link và anchor hỏng |
| M-189-04 | đối chiếu mắt §3 với `P4-incident-table.md` và báo cáo 05 | mỗi số có trong nguồn, không dòng nào mạnh hơn nguồn |
| M-189-05 | `check-backlog.mjs` | 0 lỗi |

## 6. Domain review (AI)

(Điền sau Phase 2.)

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Lệnh chứng minh | Commit |
|---|---|---|---|---|
| 1 | `screenshots/DBS-189/verify-numbers.py` | TC-189-02, 03 | M-189-01, M-189-02 | gộp |
| 2 | `P4-production-engineering.md` | TC-189-01, 04, 05 | M-189-01, M-189-04 | `docs(deliverables): bản ghép P4 (DBS-189)` |
| 3 | `deliverables/README.md`, `features/README.md`, feature doc §8–§9 | TC-189-06, 07 | M-189-03, M-189-05 | gộp |

Rủi ro: nguồn đổi sau khi ghép (PR của DBS-179 và DBS-182 chưa merge lúc viết; sau rebase `verify-numbers.py` phải chạy lại). Lùi: xóa bản ghép và dòng README. Quét DoD: 1 → bước 2; 2 → bước 1–2; 3 → bước 3 (nộp: người); 4 → bước 3. Không đóng BL; không thêm BL mới trừ khi phát hiện khuyết nguồn.

## 8. Kết quả

(Điền sau Phase 4–5.)

## 9. Tài liệu đã cập nhật

(Điền sau Phase 5.)
