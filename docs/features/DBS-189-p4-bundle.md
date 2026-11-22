# DBS-189 · Ghép và nộp P4: load test, reliability, dashboard, SLI/SLO, capacity & cost

> **Status:** Implemented · **Vai:** Dev (ghép) · **Cặp đôi review:** #5 · **Nhánh:** `docs/DBS-189-p4-bundle` · **PR:** — · **Cập nhật:** 2026-11-22

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

Không đổi code, Terraform hay ADR. File mới: `docs/deliverables/P4-production-engineering.md`, `docs/features/DBS-189-p4-bundle.md`, `docs/features/screenshots/DBS-189/{verify-numbers.py,verify-output.txt,domain-review.md}`. File sửa: `docs/deliverables/README.md` (dòng P4), `docs/deliverables/P4-incident-table.md` (ba hàng), `docs/deliverables/defense-q7-ha-recovery.md` (hàng Redis và giới hạn đã cũ), `docs/features/README.md`.

## 4. Test cases (tái tính và đối chiếu)

| ID | Truy vết | Lớp | Given · When · Then |
|---|---|---|---|
| TC-189-01 | DoD 1 | đối chiếu | bản ghép có đủ năm mục: báo cáo tải, bảng sự cố, SLO, dashboard, chi phí · đọc mục lục §1 · mỗi mục có phần và link nguồn |
| TC-189-02 | DoD 2 | script | `verify-numbers.py` · chạy · mọi cặp «số trong bản ghép ↔ chuỗi trong nguồn» của `CHECKS` (các số ở §1–§6 nêu trong `CHECKS`), bảng SLO nguyên văn và số ảnh đều khớp (thoát 0); các số không nằm trong `CHECKS` (ví dụ 30 phút ở §6.3) chỉ được đối chiếu mắt ở domain review |
| TC-189-03 | DoD 2 | script (có thể trượt) | đổi ba số trong bản sao của bản ghép, **không** nằm trong danh sách kiểm cũ (121 ms, 39,99, 1.881) · chạy lại · thoát 1, in dòng `FAIL` cho từng cặp |
| TC-189-04 | DoD 1, 2 | đối chiếu | các chỗ nguồn ghi «chưa» (p95 từng phút, hot-account ≥ 40.000 dòng, failover RDS chưa xác nhận, RTO Single-AZ, chi phí chưa đối chiếu) xuất hiện ở §7 và ở §1/§3/§6 với cùng mức khẳng định |
| TC-189-05 | DoD 1 | đối chiếu | mỗi hàng của bảng sự cố §3 có số khớp `P4-incident-table.md` (đã thêm hàng DBS-167 tắt, chậm và DBS-181 trong PR này) hoặc báo cáo 05 |
| TC-189-06 | DoD 3 | quy trình | `docs/deliverables/README.md` có link tới bản ghép; **việc nộp do người làm: chưa đạt trong PR này** |
| TC-189-07 | DoD 4 | quy trình + grep | `check-doc-links.mjs` sạch (kể cả anchor); `check-backlog.mjs` sạch; tên BL, DBS, tên alarm và dashboard khớp (`dbs-dev-overview`, `dbs-dev-outbox-age`…). **Dev review chưa đạt về hình thức** |

## 5. Test thủ công (tài liệu, không gọi AWS)

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-189-01 | `PYTHONUTF8=1 python docs/features/screenshots/DBS-189/verify-numbers.py` | mọi dòng `PASS`, `KET LUAN: mọi cặp khớp`, thoát 0 |
| M-189-02 | sao bản ghép ra tệp tạm, đổi `121 ms` thành `112 ms`, `39,99` thành `49,99`, `1.881 timeout` thành `1.188 timeout`, chạy `P4_BUNDLE=<bản sao> python verify-numbers.py` | thoát 1, có các dòng `FAIL` cho từng cặp bị đổi (5 FAIL); bản sao thứ hai đổi 8,2642, 191,29, 43,2 phút, 91,9 ms, «timeout 2 giây»: 6 FAIL |
| M-189-03 | mở từng link nguồn ở §2–§6 (bằng `check-doc-links.mjs`) | 0 link và anchor hỏng |
| M-189-04 | đối chiếu mắt §3 với `P4-incident-table.md` và báo cáo 05 | mỗi số có trong nguồn, không dòng nào mạnh hơn nguồn |
| M-189-05 | `check-backlog.mjs` | 0 lỗi |

## 6. Domain review (AI)

**Reviewer:** subagent general-purpose, model opus, effort high, 2026-11-22 · **Vòng 1:** 17 phát hiện (should-fix 9, minor 8), verdict REVISE · [trả lời nguyên văn](screenshots/DBS-189/domain-review.md) · **Vòng 2 (diff review cuối, opus high):** 10 phát hiện (should-fix 4, minor 6), verdict REVISE, đã sửa hết: defense-q7 §1 và §4 còn câu «local», script chưa phủ §1 và một số số ở §3 và §6.2, «0 và 5,8 giây» (reviewer đúng), «không do event loop/GC» gán nhầm cho BL-418, `meetsDoD3` ở §1, 3/4 lượt gồm lượt tắt, 0,3439, header ngày, M-189-01 kỳ vọng và TC-189-06

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | script chỉ kiểm 28 chuỗi của bản ghép; đổi 5 số vẫn «khớp» | đã sửa: script viết lại theo **cặp** (chuỗi bản ghép ↔ chuỗi nguồn) cho hơn 90 số, kiểm bảng SLO từng dòng với docs/03, đếm ảnh; M-189-02 đổi ba số ngoài danh sách cũ (121 ms, 39,99, 1.881) và có 5 dòng FAIL |
| 2 | should-fix | có bốn lượt `baseline`, không phải ba | đã sửa: §2.1 thêm cột S1 (lượt 2 «trước») với 344,0 / 1.406,0, 171 lỗi, 54 dropped, 7/16 khung |
| 3 | should-fix | bảng sự cố «đầy đủ» thiếu Redis dưới tải và failover RDS; defense-q7 đã cũ | đã sửa: thêm ba hàng (DBS-167 tắt, DBS-167 chậm, DBS-181) vào `P4-incident-table.md`; sửa hàng Redis và giới hạn của `defense-q7-ha-recovery.md` |
| 4 | should-fix | bảng SLO «nguyên văn» nhưng đã rút gọn | đã sửa: chép nguyên bảng docs/03 §14 kèm cột «Đo ở đâu»; script kiểm từng dòng |
| 5 | should-fix | alarm «gửi SNS email» không nêu giới hạn | đã sửa: §4 và §7 ghi BL-276 (`alarm_email` chưa đặt), BL-341 (chưa kêu bằng tải thật) |
| 6 | should-fix | ảnh dashboard không phải ảnh console | đã sửa: §5 và §7 ghi BL-262, BL-404 |
| 7 | should-fix | «DBS-173 và 189 đã xong» sai | đã sửa: DBS-173 làm một phần; DBS-179, 182, 189 chờ merge |
| 8 | should-fix | plateau 180 «0,13 % lỗi» nghe gần đạt | đã sửa: «105 dropped, p95 493 ms» |
| 9 | should-fix | HA thiếu điều kiện của nguồn | đã sửa: «nếu có ngân sách riêng và nếu số đo giữ được dưới tải thật», production giả định |
| 10 | should-fix | feature doc còn chỗ trống | đã sửa: §6, §8, §9, README, status |
| 11 | minor | `meetsDoD3 false` chỉ do 1 dropped | đã sửa ở §2.1 |
| 12 | minor | 137 s đo với cấu hình tạm | đã sửa ở §3 |
| 13 | minor | «1–3 giây» và thời gian hồi phục «0 và 5,8 giây» | đã sửa: «timeout 2 giây, tới 3 giây, ở cửa sổ `pre`» và `redis: up` sau 0 và 5,8 giây ở hai lượt chậm (05 §4.1). Lần đầu tôi bác sai phát hiện này (grep cắt dòng ở 300 ký tự); reviewer vòng cuối đúng |
| 14 | minor | thiếu «mất phục vụ ≈ 290 s» | đã sửa ở §3 |
| 15 | minor | 1,03 đặt sai cột «Production» | đã sửa: cột riêng «cấu hình đo + máy tải» |
| 16 | minor | tên alarm ngắn, thiếu link, link xếp chồng | đã sửa: `dbs-dev-redis-fallback`, link BL; PR phải merge sau PR của DBS-182 |
| 17 | minor | thiếu BL-417 | đã sửa ở §7 |

**Quyết định ở G2** (agent tự quyết): duyệt thiết kế sau vòng 1 và các sửa trên; thêm ba hàng vào bảng sự cố gốc thay vì để bản ghép trích nguồn khác nhau, vì DoD 1 đòi một «bảng sự cố» và DoD 2 đòi số trùng báo cáo gốc.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Lệnh chứng minh | Commit |
|---|---|---|---|---|
| 1 | `screenshots/DBS-189/verify-numbers.py` | TC-189-02, 03 | M-189-01, M-189-02 | gộp |
| 2 | `P4-production-engineering.md` | TC-189-01, 04, 05 | M-189-01, M-189-04 | `docs(deliverables): bản ghép P4 (DBS-189)` |
| 3 | `deliverables/README.md`, `features/README.md`, feature doc §8–§9 | TC-189-06, 07 | M-189-03, M-189-05 | gộp |

Rủi ro: nguồn đổi sau khi ghép (PR của DBS-179 và DBS-182 chưa merge lúc viết; sau rebase `verify-numbers.py` phải chạy lại). Lùi: xóa bản ghép và dòng README. Quét DoD: 1 → bước 2; 2 → bước 1–2; 3 → bước 3 (nộp: người); 4 → bước 3. Không đóng BL; không thêm BL mới trừ khi phát hiện khuyết nguồn.

## 8. Kết quả

- **Lệnh kiểm tra** (2026-11-22, nhánh xếp chồng trên PR DBS-182 #236, nền `origin/main` `0f40b496`): `verify-numbers.py` mọi cặp PASS, thoát 0; ca trượt (M-189-02) 5 FAIL, thoát 1; `check-doc-links.mjs` 520 tệp, 0 link và anchor hỏng; `check-backlog.mjs` 107 dòng, 0 lỗi. Không đổi code nên không chạy baseline backend. Output thô: [verify-output.txt](screenshots/DBS-189/verify-output.txt).
- **Đối chiếu test case:**

| ID | Cách kiểm | Đạt? |
|---|---|---|
| TC-189-01 | §1 của bản ghép có năm mục (tải, sự cố, SLO, dashboard, chi phí), mỗi mục có phần và link nguồn | đạt |
| TC-189-02 | M-189-01: hơn 90 cặp bản ghép ↔ nguồn, bảng SLO 9 dòng nguyên văn, 25 + 25 ảnh | đạt |
| TC-189-03 | M-189-02: ba số ngoài danh sách cũ bị đổi · 5 dòng FAIL, thoát 1 | đạt |
| TC-189-04 | §7 và §1/§3/§6 cùng mức khẳng định (p95 từng phút chưa, hot-account ≥ 40.000 dòng chưa, failover RDS chưa xác nhận, RTO Single-AZ chưa đo, chi phí chưa đối chiếu, alarm chưa email) | đạt (đối chiếu mắt, domain review vòng 1) |
| TC-189-05 | bảng sự cố §3 so với `P4-incident-table.md` (đã có DBS-167 tắt, chậm, DBS-181) và báo cáo 05 | đạt |
| TC-189-06 | `docs/deliverables/README.md` có link tới bản ghép; **việc nộp chưa làm (người)** | chưa đạt (việc của người; ghi ở §7 của bản ghép) |
| TC-189-07 | `check-doc-links` 0, `check-backlog` 0, tên alarm và BL khớp; **Dev review chưa đạt về hình thức** | đạt phần script; review: chưa làm (opus thay, `Techlead waiver`) |

- **DoD:**

| DoD | Kết quả |
|---|---|
| 1. Bản ghép có báo cáo tải, bảng sự cố, SLO, dashboard, chi phí | đạt |
| 2. Mọi số trùng báo cáo gốc, có link | đạt theo `verify-numbers.py` (cặp số ↔ nguồn, phạm vi `CHECKS`) và đối chiếu mắt ở domain review; chi phí vẫn là ước lượng chưa đối chiếu hóa đơn (BL-426) |
| 3. Nộp đúng hạn; link ghi vào README | link: đạt; **nộp: chưa làm** (việc của người; hạn chưa có trong repo) |
| 4. PR merge, Dev review, link, tên khớp | link và tên: đạt; **Dev review: chưa đạt về hình thức** (opus thay người, `Techlead waiver`); merge sau CI |

- **Test thủ công:** M-189-01…05 đã chạy, không có bước «chưa chạy»; không gọi AWS.
- **Phạm vi so với §7:** thêm ngoài kế hoạch ban đầu `P4-incident-table.md` (ba hàng) và `defense-q7-ha-recovery.md` (một hàng và một câu giới hạn) theo review #3; còn lại khớp §3.
- **Ảnh chụp:** không áp dụng (tài liệu; ảnh dashboard là của DBS-178).
- **Lệch so với kế hoạch:** (1) thêm ba hàng vào bảng sự cố gốc và sửa `defense-q7` (quyết định G2 ở §6); (2) viết lại `verify-numbers.py` theo cặp sau review; (3) một commit nháp rồi sửa. Quyết định agent tự duyệt.
- **Bàn giao cho người:** nộp P4 (hạn do giảng viên xác nhận); cập nhật board (DBS-167, 173, 178, 179, 181, 182, 184, 186, 189); gửi tóm tắt chi phí (BL-426); chạy lại `verify-numbers.py` nếu nguồn đổi. Không thêm BL mới (mọi giới hạn đã có BL).


## 9. Tài liệu đã cập nhật

- `docs/deliverables/P4-production-engineering.md` (mới); `docs/deliverables/README.md` (dòng P4 trỏ tới bản ghép, «chưa nộp»); `docs/deliverables/P4-incident-table.md` (ba hàng: DBS-167 tắt, DBS-167 chậm, DBS-181); `docs/deliverables/defense-q7-ha-recovery.md` (hàng Redis và giới hạn đã cũ); `docs/features/README.md` (hàng DBS-189). Không thêm hay đóng BL.

**Quyết định ở G4** (agent tự quyết): chấp nhận không có ảnh chụp; nộp P4, cập nhật board và gửi chi phí là việc của người; DoD 3 (nộp) và Dev review ghi chưa đạt.
