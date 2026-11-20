# DBS-141 · Danh sách nợ kỹ thuật sau demo và giao theo vai

> **Status:** Plan approved (sau G3) · **Vai:** Dev · **Cặp đôi review:** Dev khác · **Nhánh:** `docs/DBS-141-post-demo-tech-debt` (xếp trên nhánh PR #215) · **PR:** — · **Cập nhật:** 2026-11-20

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 5, Ưu tiên High, Deliverable/Demo «Giữa kỳ», Vai `Dev`, status To Do. **Expect:** «Mọi việc dở dang sau demo có người nhận và có hạn.»
- **Thực trạng (chép từ board):** «Chưa có danh sách nợ kỹ thuật vì demo giữa kỳ chưa diễn ra. Mỗi vai tự ghi vấn đề trong lúc chạy thử, #2 gom lại sau khi quay.»
- **DoD (chép nguyên văn từ board):**
  1. Mỗi vấn đề thấy trong demo thành một issue có nhãn tech-debt, gán vai và mức ưu tiên
  2. Danh sách gom ở một chỗ (issue board hoặc bảng trong roadmap) và gửi cả nhóm
  3. Phân loại: sửa trước giai đoạn bảo mật/tải, hoặc ghi vào 05-backlog
  - Ghi chú trên board [Cập nhật 11/10]: không còn file 02-architecture, 03-feature, 04-test-cases, 05-backlog theo component; test case ghi trong PR; thiết kế vào docs/03 hoặc docs/components/_shared. Nên «05-backlog» nay là [`docs/BACKLOG.md`](../BACKLOG.md).
- **Phụ thuộc:** DBS-140 Done trên board. **Trong repo:** [DBS-140](DBS-140-midterm-demo-video-prep.md) chỉ chuẩn bị, video **chưa quay** (BL-390), và §1 của nó ghi DBS-141, DBS-142 làm «sau khi có video»; `docs/deliverables/midterm-demo-video.md` ghi «chưa có link». Sheet và repo lệch nhau: có thể nhóm đã quay ngoài repo.
- **Đã có gì:** [`docs/BACKLOG.md`](../BACKLOG.md): 100 dòng việc còn tồn chia theo vai, mỗi dòng có ID, nguồn, vai, điều kiện đóng. Chưa có mức ưu tiên, phân loại, hạn; GitHub chưa có nhãn `tech-debt` (`gh label list`); chỉ 2 issue GitHub tồn tại (DLQ, phối hợp), không dùng cho nợ kỹ thuật.
- **Giai đoạn «bảo mật/tải» còn lại (kiểm bằng `fetch-task.mjs`):** WAF (DBS-153) và KMS (DBS-154) Done; các task **tải** còn To Do: DBS-166 (chạy tải 12→60→120 RPS), 167 (Redis), 173, 174, 175 (p95, thời gian tới cờ, relay), 178 (dashboard lúc tải), 179 (chi phí AWS thật). Hôm nay (2026-11-20) là tuần 8 (19–25/11), nên các hạn tuần 7 đã **trễ**.
- **Baseline (docs-only, `main` + nhánh PR #215):** `check-doc-links.mjs` → 484 file, 0 liên kết hỏng; 100 dòng BACKLOG đều 5 cột.
- **Ngoài phạm vi:** tạo GitHub issue và nhãn `tech-debt` (người dùng chọn «Phân loại BACKLOG hiện có»); gửi danh sách cho nhóm (việc của người, xem BL-401); xử lý các khoản nợ (DBS-142 và các task khác); nối `check-backlog.mjs` vào CI (BL-402).
- **Dòng BACKLOG cùng DoD:** cả bảng. BL-390 (video giữa kỳ) và BL-351 là nơi sinh «vấn đề thấy trong demo».
- **Quyết định ở G1 (agent tự quyết):**
  1. **Xếp nhánh trên PR #215** (cùng sửa bảng BACKLOG; rebase lên `main` sau khi #215 merge).
  2. **Không tạo GitHub issue/nhãn** (người dùng chọn). Vì vậy **DoD 1 chưa đạt**: không có «vấn đề thấy trong demo» để chuyển thành dòng (demo chưa có bằng chứng trong repo) và không có issue. Cái đạt được là **hạ tầng của DoD 1**: mỗi dòng nợ có vai, ưu tiên, hạn, và định dạng sẵn cho vấn đề mới. Phần còn thiếu là **BL-401** (gom vấn đề sau buổi quay, gửi cả nhóm).
  3. **DoD 2** đạt phần «gom ở một chỗ» (BACKLOG, 102 dòng); phần «gửi cả nhóm» là việc của người (BL-401), agent không gửi.
  4. **DoD 3** đạt: mỗi dòng có nhóm «Trước tải», «Trong tải» hoặc «Hoãn» kèm mã (§2).
  5. **Expect «có hạn» chỉ đạt một phần, nói thẳng:** mọi dòng có cột Hạn đúng dạng, nhưng (a) 23 dòng ghi «Không có» là **chưa có hạn** (DoD 3 cho phép «ghi vào backlog»); (b) dòng H3/H4 mặc định «Trước DBS-202 (tuần 10)» chỉ là **hạn danh nghĩa** (DBS-202 chỉ lưu bằng chứng, không nhận việc đó); (c) BL-390 («Tuần 5 (đã trễ)») và BL-401 («Sau BL-390») **chưa có ngày mới**: cần techlead đặt; (d) hạn «trước DBS-166» là một mốc của task đang trễ, không phải ngày lịch.
  6. **Dọn khi gom:** BL-278 xóa; BL-279, 397, 398 sửa chữ; BL-104, 247, 251, 252 sửa chữ vì lỗi thời; BL-397 tách khóa lộ sang BL-403; BL-291/292 ghi phụ thuộc WAF (bằng chứng ở §2.3). Các dòng khác **không** được kiểm lại từng dòng với repo: giới hạn của task này, ghi ở §8.
  7. **Sửa SKILL.md (Phase 5) và `templates/feature-doc.md`** để dòng mới đủ cột: là thay đổi quy trình cho mọi vai, cần techlead duyệt (ghi ở PR).
  8. **Lệch thứ tự:** `check-backlog.mjs` và test được viết trước khi G2 qua để thử thiết kế bằng dữ liệu thật; `SKILL.md`, `templates/feature-doc.md` và `docs/BACKLOG.md` (đã áp ba cột) cũng được sửa trong working tree trước G3. Chưa commit gì trước G3 (ghi ở §8).
- **Câu hỏi mở (đã chốt):** «giai đoạn bảo mật/tải» = trước các task tải DBS-166…179; phân loại theo bảng mã có thứ tự áp (§2.2); «có hạn» = cột Hạn.

## 2. Hành vi

### 2.1 Định dạng mới của bảng BACKLOG

Mỗi bảng có 8 cột: `ID | Việc còn thiếu | Nguồn | Vai đề xuất | Đóng khi | Ưu tiên | Xử lý | Hạn`.

- **Xử lý** = `<nhóm> · <mã>`: `Trước tải · T1..T4`, `Trong tải · L (DBS-n)`, `Hoãn · H1..H6` (`H6` cũng nêu task: `Hoãn · H6 (DBS-187, DBS-188)`).
- **Ưu tiên** ∈ {Cao, Trung bình, Thấp}. Mỗi mã có mức **mặc định** và **tập cho phép**: một dòng được nâng hoặc hạ trong tập đó khi có lý do (cổng đã trễ, hạn cứng, task Highest), lý do ghi ở cột «Lý do» §2.4. `T1`, `T3` luôn Cao; `H1`, `H2`, `H5`, `H6` chỉ Thấp hoặc Trung bình.
- **Hạn** (bắt buộc, kiểm bằng regex): `Trước DBS-n (tuần k)`, `DBS-n (tuần k)`, `Sau BL-nnn`, `Tuần k`, `YYYY-MM-DD`, `Ngay`, hoặc `Không có` (có thể thêm «, đã trễ» nhưng không bắt buộc: trạng thái «trễ» suy ra từ tuần và ngày hôm nay). **Mặc định theo mã:** `T*` = trước DBS-166 (tuần 7); `T3` về nhãn holdout và duyệt API AI = trước DBS-169; `L` và `H6` = hạn của task nêu tên; `H3`, `H4` = trước DBS-202 (tuần 10, hạn danh nghĩa); `H1`, `H2`, `H5` = `Không có`. Ngoại lệ có ghi lý do ở §2.4 (BL-390, BL-401, BL-228, BL-351, BL-387, BL-291, BL-397, BL-403...).
- **Vai đề xuất:** vai đứng đầu là **người nhận**; bảng chia theo vai đó. Mục «Người thật và quay video» là một **loại việc** (cần người thật), không phải một vai. Dòng có hai vai ở hai mục khác nhau được chuyển về mục của vai đầu (BL-397, BL-398 sang Platform & Ops).
- Kiểm bằng `check-backlog.mjs`: đủ 8 cột; ID đúng dạng, không trùng, tăng dần trong mục; ô Việc, Nguồn, Vai, Đóng khi, Hạn không trống; Ưu tiên trong tập cho phép của mã; mã `L`/`H6` có task, mã khác không; Hạn đúng dạng; đầu BACKLOG định nghĩa đủ mã với nhóm và mức mặc định khớp `RULES`.

### 2.2 Quy tắc phân loại

Thứ tự áp: mã đầu tiên khớp trong **T1, T3, T2, T4, L, H1, H2, H3, H4, H5, H6** (nhưng `H6` chỉ khi task board nhận **trọn** việc; nhận một phần thì dùng mã khác và ghi phần còn lại ở «Lý do»).

| Mã | Nhóm | Ưu tiên mặc định (cho phép) | Áp khi |
|---|---|---|---|
| T1 | Trước tải | Cao (Cao) | chặn dựng hoặc chạy phiên cloud: quyền, credential, image/deploy, seed, dựng từ trống |
| T3 | Trước tải | Cao (Cao) | rủi ro bảo mật hoặc rò dữ liệu đang mở: CVE nghiêm trọng, khóa lộ, nhãn holdout, file chứa body sự kiện |
| T2 | Trước tải | Trung bình (Cao, Trung bình) | quyết định, cấu hình hoặc việc phải có sẵn **trước** lần chạy tải (miễn WAF cho k6, số task api, chọn chu kỳ) |
| T4 | Trước tải | Trung bình (Cao, Trung bình) | lỗi hoặc lỗ hổng giám sát của thứ đang chạy mà lượt tải hoặc diễn tập sẽ chạm |
| L | Trong tải | Trung bình (Cao, Trung bình) | là một phần của một task tải trên board hoặc do task đó tạo ra; nêu task; hạn là hạn của task |
| H1 | Hoãn | Thấp (Thấp, Trung bình) | chỉ cần cho `envs/prod` hoặc mức bảo mật production |
| H2 | Hoãn | Thấp (Thấp, Trung bình) | điều tra lỗi công cụ cục bộ (Windows) đã có cách tránh |
| H3 | Hoãn | Trung bình (cả ba) | việc của người thật: quay, luyện, bấm giờ, duyệt, xác nhận chéo |
| H4 | Hoãn | Trung bình (cả ba) | đo hoặc chạy kiểm bổ sung trên dữ liệu hoặc cloud thật, sau khi có phiên và số đo |
| H5 | Hoãn | Thấp (Thấp, Trung bình) | cải tiến tùy chọn hoặc giảm chi phí |
| H6 | Hoãn | Thấp (Thấp, Trung bình) | một task board khác nhận trọn việc; nêu task |

**Vòng đời (rà lại):** khi DBS-166 xong, hoặc khi DBS-200 (đóng băng code) bắt đầu, mỗi dòng còn «Trước tải» hoặc «Trong tải» được đóng, hoặc đổi sang «Hoãn» kèm lý do ở feature doc của task làm việc đó (quy tắc ghi ở đầu BACKLOG).

### 2.3 Dòng xóa, sửa, chuyển, thêm khi gom

| Dòng | Việc | Căn cứ (đã kiểm) |
|---|---|---|
| BL-278 | **xóa** | điều kiện đóng «CI xanh trên head cuối, trong đó các `*.db-spec.ts` đối soát pass»: PR #178 merge 2026-11-20, 10 check xanh gồm `db` |
| BL-279 | sửa chữ | PR #178 đã merge, CI xanh, board DBS-123 Done; còn «Dev khác review và điền bảng đối chiếu» (`gh pr view 178 --json reviews` rỗng) |
| BL-397, BL-398 | sửa chữ, chuyển mục | PR #213, #214 đã merge theo techlead nhưng `reviews` rỗng: **giữ** «Dev khác review»; vai đầu là #5 Platform & Ops nên chuyển từ «Người thật và quay video» sang Platform & Ops |
| BL-397, BL-403 | tách | BL-397 gộp ba việc (thu hồi khóa lộ, `apply` thật, Dev review); phần **khẩn** (thu hồi khóa lộ ở PR #45, chỉ cần tài khoản OpenAI) thành **BL-403** (T3, «Ngay»); BL-397 còn `apply` và nạp khóa mới (H4, «Sau BL-265») |
| BL-252 | sửa chữ (việc và điều kiện đóng) | `infra/scripts/seed-cloud.sh` có sẵn (commit `5379761`, [DBS-70 §8.3](DBS-70-seed-demo-data.md)): việc còn lại là chạy một lần trên AWS thật; điều kiện đóng quay lại chữ của #180 |
| BL-251 | sửa chữ | bước «`seed --auth cloud`» thành «`seed-cloud.sh`» |
| BL-104 | sửa chữ | workflow `Image` xanh trên `main` (2026-11-20); `Deploy` `skipped` vì repo chỉ có biến `AWS_ROLE_ARN`, thiếu `AWS_DEPLOY_ROLE_ARN` (`gh variable list`) |
| BL-247 | sửa chữ | «cần image trong ECR» không còn đúng: bước đẩy ECR của `Image` đã xanh |
| BL-105 | sửa vai, đổi mã | bỏ «(khi có prod)»; H4 «Sau BL-104» (kiểm sau khi `Deploy` chạy, không chặn dựng phiên) |
| BL-291, BL-292 | ghi phụ thuộc | WAF tắt từ 2026-11-26 (`waf_off_date`) và k6 cần miễn WAF (docs/03 §12): chưa ai quyết «WAF bật hay tắt trong lượt tải»; hai dòng ghi rõ; BL-292 và BL-290 (2) hết áp dụng nếu tải chạy sau 2026-11-26 với WAF tắt |
| BL-402 | **thêm** | nối kiểm BACKLOG vào CI (ngoài phạm vi); vai Dev; H5 |
| BL-401 | **thêm** | DoD 1 và DoD 2 phần «gửi cả nhóm» chưa đạt (§1 quyết định 2, 3); vai Dev (người quay) và người gom (#2); hạn «Sau BL-390» |
| BL-041, 236, 238 | giữ nguyên | «chờ `backend/data/fraud/`»: thư mục chưa có trong repo (`ls`), nhưng tập tune đã được dùng ở DBS-161 từ chỗ khác: **chưa kiểm được**, #4 xác nhận |

### 2.4 Bảng phân loại 102 dòng

| Dòng | Mục | Mã | Nhóm · Ưu tiên | Hạn | Lý do |
|---|---|---|---|---|---|
| BL-042 | Dev | H5 | Hoãn · Thấp | Không có | giao diện risk chưa có; không chặn tải |
| BL-121 | Dev | H2 | Hoãn · Thấp | Không có | lỗi harness test, chưa tái hiện |
| BL-125 | Dev | H2 | Hoãn · Thấp | Không có | crash native Windows của bộ test DB |
| BL-135 | Dev | H3 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | bước thử trên trình duyệt do người chạy |
| BL-179 | Dev | L (DBS-166) | Trong tải · Cao | DBS-166 (tuần 7) | ngưỡng rate limit chốt theo số đo tải của DBS-166 (task Highest) |
| BL-190 | Dev | H3 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | nộp P2: người nộp, hạn ngoài tải |
| BL-191 | Dev | H2 | Hoãn · Thấp | Không có | lỗi launcher Windows |
| BL-192 | Dev | H2 | Hoãn · Thấp | Không có | lỗi launcher Windows |
| BL-198 | Dev | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | chạy luồng tiền trên cloud: kiểm bổ sung, không chặn tải |
| BL-199 | Dev | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | negative control CI của DBS-65, bằng chứng bổ sung |
| BL-200 | Dev | H2 | Hoãn · Thấp | Không có | crash native Windows, đã chạy được trên Node 24.22.2 |
| BL-215 | Dev | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | thử khi Docker tắt thật, bổ sung kiểm |
| BL-218 | Dev | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | chạy worker thật kill/restart, bổ sung kiểm |
| BL-220 | Dev | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | drill thu hồi phiên trên cloud, bổ sung kiểm |
| BL-221 | Dev | L (DBS-167) | Trong tải · Trung bình | DBS-167 (tuần 7) | đo p95 đọc khi Redis chậm: chính là DBS-167 |
| BL-222 | Dev | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | kiểm quy tắc iat trên cloud, bổ sung kiểm |
| BL-231 | Dev | H2 | Hoãn · Thấp | Không có | crash native Windows của bộ test DB |
| BL-233 | Dev | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | ảnh và kiểm harness của k6 local |
| BL-235 | Dev | H5 | Hoãn · Thấp | Không có | giao diện web tùy chọn |
| BL-240 | Dev | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | chạy lại EXPLAIN trên dữ liệu thật hơn, sau tải |
| BL-262 | Dev | L (DBS-178) | Trong tải · Trung bình | DBS-178 (tuần 7) | ảnh console dashboard lúc chạy tải thuộc DBS-178 |
| BL-279 | Dev | H3 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | review của Dev khác cho PR #178 đã merge |
| BL-283 | Dev | H1 | Hoãn · Thấp | Không có | chiều môi trường chỉ cần khi dev và prod chạy cùng lúc |
| BL-381 | Dev | T4 | Trước tải · Trung bình | Trước DBS-166 (tuần 7) | SIGTERM giữa transaction trả 500; triển khai lúc tải chạm tới |
| BL-384 | Dev | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | đo lại mã thoát/thời gian dừng worker trên cloud |
| BL-400 | Dev | H5 | Hoãn · Thấp | Không có | nhớ lượt chạy trước của dlq:resend, tùy chọn |
| BL-402 | Dev | H5 | Hoãn · Thấp | Không có | nối check-backlog.mjs vào CI, tùy chọn |
| BL-040 | Fraud | H3 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | cập nhật board và xác nhận guide: người quản lý board |
| BL-041 | Fraud | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | bàn giao tập tune (backend/data/fraud/ chưa có) và đối chiếu parity |
| BL-043 | Fraud | T3 | Trước tải · Cao | Trước DBS-169 (tuần 7) | duyệt dữ liệu và egress trước khi gửi cho API AI; hạn theo holdout |
| BL-044 | Fraud | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | đo B0/B1/B2 gồm phần AI mà DBS-169, 170 không phủ hết |
| BL-050 | Fraud | H3 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | owner tài liệu xác nhận ADR-14 |
| BL-138 | Fraud | H3 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | xác nhận chữ ký Features/RuleParams giữa các vai |
| BL-171 | Fraud | T3 | Trước tải · Cao | Trước DBS-169 (tuần 7) | nơi lưu nhãn holdout quyền riêng, bảo vệ bức tường dữ liệu; hạn theo holdout |
| BL-173 | Fraud | H6 (DBS-190) | Hoãn · Thấp | DBS-190 (tuần 9) | giới hạn bộ mixed ghi ở P5 (DBS-190) |
| BL-187 | Fraud | L (DBS-166) | Trong tải · Cao | DBS-166 (tuần 7) | đo p95 extract fraud ở 120 extract/s trên RDS: tài khoản nóng của DBS-166 |
| BL-188 | Fraud | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | chạy thật verify-worker-rollout và thư SNS |
| BL-236 | Fraud | H4 | Hoãn · Trung bình | Sau BL-041 | chạy export-features trên tập tune thật (chờ backend/data/fraud/, BL-041); hạn đổi theo kiểm mù M-141-05 |
| BL-238 | Fraud | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | chạy parity trên tập tune thật (chờ backend/data/fraud/) |
| BL-340 | Fraud | H6 (DBS-187, DBS-188) | Hoãn · Thấp | DBS-188 (tuần 8) | counter cờ/1.000 giao dịch và alarm thuộc DBS-187, DBS-188 |
| BL-391 | Fraud | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | phát hiện còn lại của audit dataset DBS-146 |
| BL-392 | Fraud | T3 | Trước tải · Cao | Trước DBS-169 (tuần 7) | hợp đồng kịch bản nằm trong docs/ nơi #4 đọc được; hạn theo holdout |
| BL-027 | Platform | H3 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | người thứ hai chạy terraform init với bucket state |
| BL-029 | Platform | H4 | Hoãn · Trung bình | DBS-208 (tuần 10) | runbook teardown bucket state: DBS-208 chỉ quyết giữ hay xóa, không viết và chạy runbook |
| BL-033 | Platform | H5 | Hoãn · Thấp | Không có | thêm ngưỡng budget 150 USD |
| BL-037 | Platform | H1 | Hoãn · Thấp | Không có | ACM công khai chỉ cần cho môi trường thật |
| BL-104 | Platform | T1 | Trước tải · Cao | Trước DBS-166 (tuần 7) | Deploy thật là đường đưa image lên cloud: còn thiếu biến AWS_DEPLOY_ROLE_ARN (Image đã xanh) |
| BL-105 | Platform | H4 | Hoãn · Trung bình | Sau BL-104 | kiểm OIDC và từ chối workflow khác: việc sau khi BL-104 chạy Deploy |
| BL-109 | Platform | T1 | Trước tải · Cao | Trước DBS-166 (tuần 7) | migration lỗi và Deploy thật trước khi chạy cloud |
| BL-117 | Platform | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | kích thử alarm Redis khi có phiên |
| BL-127 | Platform | L (DBS-166) | Trong tải · Cao | DBS-166 (tuần 7) | invariants.txt đi kèm mọi lượt tải: DoD của DBS-166 (task Highest) |
| BL-182 | Platform | T4 | Trước tải · Trung bình | Trước DBS-166 (tuần 7) | alarm outbox-age phát hiện mất worker sau 9 phút; phần đo lô relay dưới tải thuộc DBS-175 |
| BL-216 | Platform | L (DBS-167) | Trong tải · Trung bình | DBS-167 (tuần 7) | drill Redis chậm/chết dưới tải: DBS-167 |
| BL-232 | Platform | L (DBS-166) | Trong tải · Cao | DBS-166 (tuần 7) | nghiệm thu 5 script k6 trên cloud: chính là DBS-166 (task Highest) |
| BL-247 | Platform | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | chạy nhóm B của DBS-121 trên AWS; image đã có trong ECR (Image xanh) |
| BL-251 | Platform | T1 | Trước tải · Cao | Trước DBS-166 (tuần 7) | đo dựng từ trống ≤ 30 phút (DBS-139) |
| BL-252 | Platform | T1 | Trước tải · Cao | Trước DBS-166 (tuần 7) | seed cloud thật bằng seed-cloud.sh (đường qua ALB đã thay) |
| BL-264 | Platform | T3 | Trước tải · Cao | Trước DBS-166 (tuần 7) | CVE CRITICAL trên image dbs-api |
| BL-265 | Platform | T1 | Trước tải · Cao | Trước DBS-166 (tuần 7) | IAM user dev1 không dựng được phiên cloud |
| BL-274 | Platform | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | đo đường thật của alarm đối soát khi có phiên |
| BL-275 | Platform | T4 | Trước tải · Trung bình | Trước DBS-166 (tuần 7) | alarm đối soát không bắt worker chết hay lỗi trước khóa |
| BL-276 | Platform | T4 | Trước tải · Trung bình | Trước DBS-166 (tuần 7) | chưa nhận thư SNS thật khi alarm kêu |
| BL-277 | Platform | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | đo chu kỳ đối soát trên dataset lớn để chọn chu kỳ production |
| BL-280 | Platform | H1 | Hoãn · Thấp | Không có | dựng envs/prod |
| BL-281 | Platform | H1 | Hoãn · Thấp | Không có | pipeline, alarm, WAF cho prod |
| BL-282 | Platform | H1 | Hoãn · Thấp | Không có | tách Cognito và SG của prod |
| BL-284 | Platform | H1 | Hoãn · Thấp | Không có | CMK riêng cho prod |
| BL-285 | Platform | H1 | Hoãn · Thấp | Không có | đồng bộ dev/prod và max_connections của prod |
| BL-290 | Platform | T2 | Trước tải · Trung bình | Trước DBS-166 (tuần 7) | phần (2) đổi miễn rate rule WAF về [] cùng cơ chế BL-292; phần chi phí là H4 |
| BL-291 | Platform | H5 | Hoãn · Trung bình | 2026-11-26 | tắt WAF sau tuần 8 để giảm chi phí; hạn cứng 2026-11-26 |
| BL-292 | Platform | T2 | Trước tải · Trung bình | Trước DBS-166 (tuần 7) | miễn rate rule WAF cho IP k6 trước khi chạy k6 |
| BL-293 | Platform | H5 | Hoãn · Thấp | Không có | cải tiến WAF ngoài phạm vi |
| BL-300 | Platform | H1 | Hoãn · Thấp | Không có | CMK cho log, ECR, SNS, state: mức bảo mật production |
| BL-301 | Platform | H1 | Hoãn · Thấp | Không có | tách CMK theo dịch vụ/prod |
| BL-302 | Platform | T1 | Trước tải · Cao | Trước DBS-166 (tuần 7) | xoay secret và dựng mới dưới key policy DBS-154 trên AWS |
| BL-324 | Platform | H5 | Hoãn · Thấp | Không có | alarm nhắc tắt Multi-AZ |
| BL-325 | Platform | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | kiểm dữ liệu qua chuyển Single/Multi-AZ |
| BL-326 | Platform | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | kiểm destroy khi Multi-AZ |
| BL-341 | Platform | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | kích thử 18 alarm trên AWS khi có phiên |
| BL-350 | Platform | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | script đăng ký khách cho demo cloud |
| BL-361 | Platform | T3 | Trước tải · Cao | Trước DBS-166 (tuần 7) | .gitignore chưa chặn file chứa body sự kiện và handle |
| BL-362 | Platform | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | đường đọc processed_events cho Ops |
| BL-363 | Platform | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | kiểm danh sách quyền tối thiểu của runbook DLQ |
| BL-382 | Platform | T2 | Trước tải · Trung bình | Trước DBS-166 (tuần 7) | quyết định số task api khi chạy; RTO ≈ 2 phút |
| BL-385 | Platform | L (DBS-166) | Trong tải · Cao | DBS-166 (tuần 7) | đo p95 120 RPS khi consumer lỗi: kịch bản k6 của DBS-166 (task Highest) |
| BL-386 | Platform | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | diễn tập failover có probe và video |
| BL-388 | Platform | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | diễn tập PITR/snapshot |
| BL-394 | Platform | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | diễn tập rollback revision INACTIVE |
| BL-395 | Platform | H1 | Hoãn · Thấp | Không có | role vận hành riêng cho rollback |
| BL-396 | Platform | T4 | Trước tải · Trung bình | Trước DBS-166 (tuần 7) | revision cũ còn ACTIVE có thể bị chọn nhầm khi rollback |
| BL-397 | Platform | H4 | Hoãn · Trung bình | Sau BL-265 | terraform apply thật cho RSK-03 và nạp khóa mới; cần phiên cloud (BL-265); khóa lộ tách sang BL-403 |
| BL-398 | Platform | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | kích thử hai alarm RSK-04 trên AWS |
| BL-399 | Platform | H4 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | chạy dlq:resend trên SQS AWS thật |
| BL-403 | Platform | T3 | Trước tải · Cao | Ngay | khóa OpenAI lộ ở PR #45 chưa thu hồi; chỉ cần tài khoản OpenAI |
| BL-228 | Người | H3 | Hoãn · Trung bình | Sau BL-390 | người bấm giờ M-135-05; đóng cùng BL-390 |
| BL-351 | Người | H3 | Hoãn · Trung bình | Sau BL-390 | người nhóm chạy kịch bản giữa kỳ; đóng cùng BL-390 |
| BL-380 | Người | H3 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | quay video AC-5.10 trên cloud |
| BL-383 | Người | H3 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | quay incident-cloud.sh liền mạch |
| BL-387 | Người | H3 | Hoãn · Trung bình | Trước DBS-199 (tuần 9) | luyện câu bảo vệ 7 trước tổng duyệt DBS-199 |
| BL-390 | Người | H3 | Hoãn · Cao | Tuần 5 (đã trễ) | cổng tuần 5 đã trễ 3 tuần; là điều kiện của DBS-141 DoD 1 |
| BL-393 | Người | H3 | Hoãn · Trung bình | Trước DBS-202 (tuần 10) | quay drill rollback |
| BL-401 | Người | H3 | Hoãn · Trung bình | Sau BL-390 | dòng mới của task này: gom vấn đề của buổi quay và gửi cả nhóm |

### 2.5 Tóm tắt (để gửi cả nhóm)

| Mục | Trước tải · Cao | Trước tải · Trung bình | Trong tải · Cao | Trong tải · Trung bình | Hoãn · Cao | Hoãn · Trung bình | Hoãn · Thấp | Tổng |
|---|---|---|---|---|---|---|---|---|
| Dev | 0 | 1 | 1 | 2 | 0 | 12 | 11 | 27 |
| Fraud (#4) | 3 | 0 | 1 | 0 | 0 | 9 | 2 | 15 |
| Platform & Ops (#5) | 9 | 7 | 3 | 1 | 0 | 20 | 12 | 52 |
| Người thật và quay video | 0 | 0 | 0 | 0 | 1 | 7 | 0 | 8 |
| **Tổng** | 12 | 8 | 5 | 3 | 1 | 48 | 25 | 102 |

Đầu ra thật của `check-backlog.mjs --summary` ở [manual-test.txt](screenshots/DBS-141/manual-test.txt).

## 3. Kiến trúc

- **Vị trí:** tài liệu và công cụ của quy trình; không chạm `backend/`, DB, hạ tầng.
- **File sửa:** `docs/BACKLOG.md` (khối «Phân loại» ở đầu; tám cột; §2.3), `.claude/skills/dbs-delivering-task/SKILL.md` (Phase 5 mục 2: dòng mới đủ ba cột và chạy `check-backlog.mjs`), `.claude/skills/dbs-delivering-task/templates/feature-doc.md` (nhắc ở §8 và G4), `docs/features/README.md` (hàng DBS-141).
- **File mới:** `.claude/skills/dbs-delivering-task/scripts/check-backlog.mjs` và `check-backlog.test.mjs`; `docs/features/screenshots/DBS-141/classification.mjs` (mã, lý do, hạn của từng dòng) và `apply-classification.mjs` (áp một lần vào BACKLOG; đọc bản 5 cột từ `git show <base>:docs/BACKLOG.md` với `--base`, nên chạy lại được sau rebase).
- **Interface:** `checkBacklog(text) → { errors, rows, summary }`; `checkRulesDefined(text) → errors`; `RULES` (nguồn duy nhất của mã → nhóm, mức mặc định, tập cho phép, `needsTask`) do `apply-classification.mjs` import. CLI `node …/check-backlog.mjs [đường dẫn] [--summary]`: thoát 0 sạch, 1 có lỗi.
- **Người gọi / phụ thuộc (grep):** không symbol nào đổi. Không có script hay workflow nào phân tích hàng BACKLOG (`grep` `.github/`, `.claude/`, `docs/` chỉ tìm thấy liên kết tới `BACKLOG.md` và ID `BL-`); liên kết giữ nguyên đường dẫn.
- **CI:** chưa nối `check-backlog.mjs` (BL-402); chạy tay ở Phase 5 như `check-doc-links.mjs`.
- **Thay đổi cấp hệ thống:** quy trình thêm ba cột và quy tắc phân loại; cần techlead duyệt phần sửa SKILL và template (quyết định 7). Không đổi ADR hay contract.

## 4. Test cases tự động

`T` = `.claude/skills/dbs-delivering-task/scripts/check-backlog.test.mjs` (`node --test`).

| ID | Truy vết | Lớp | Given · When · Then | Kết quả |
|---|---|---|---|---|
| TC-141-01 | định dạng | unit · T | bảng đúng | không lỗi |
| TC-141-02 | định dạng | unit · T | dòng thiếu cột (cả `\|BL-001\|` không khoảng trắng) | lỗi «cần 8 cột» |
| TC-141-03 | DoD 1 (ưu tiên) | unit · T | ưu tiên lạ; ngoài tập cho phép của mã (T2 Thấp; T1 Trung bình; H5 Cao); H5 Trung bình hợp lệ | lỗi nêu ID và mã |
| TC-141-04 | DoD 3 | unit · T | `Xử lý` sai định dạng, mã lạ, nhóm không khớp mã, mã không-task có task | lỗi |
| TC-141-05 | định dạng | unit · T | ID trùng, sai dạng, thứ tự không tăng | lỗi |
| TC-141-06 | Expect (người nhận, hạn) | unit · T | ô Việc, Nguồn, Vai, Đóng khi, Hạn trống | lỗi «trống» |
| TC-141-07 | định dạng | unit · T | `\|` đã thoát | không tách cột |
| TC-141-08 | định dạng | unit · T | tiêu đề sai cột | lỗi |
| TC-141-09 | DoD 2 (gom, tóm tắt) | unit · T | tóm tắt | đếm đúng theo mục, nhóm, ưu tiên |
| TC-141-10 | định dạng | unit · T | dòng BL ngoài bảng có tiêu đề | lỗi |
| TC-141-14 | DoD 3 | unit · T | bảng mã thiếu mã, hoặc lệch nhóm/mức mặc định với `RULES` | lỗi |
| TC-141-18 | DoD 3 (H6, L nêu task) | unit · T | `L` và `H6` không task; task ở mã khác | lỗi |
| TC-141-19 | Expect (hạn) | unit · T | các dạng Hạn hợp lệ và không hợp lệ | đúng |
| TC-141-20 | định dạng | unit · T | dòng lệch (không/hai khoảng trắng, thụt đầu dòng), CRLF | bắt lỗi; CRLF vẫn sạch |
| TC-141-21 | định dạng | unit · T | văn xuôi có chữ `BL-` hoặc `\|` | không bị tính |
| TC-141-11 | DoD 1, 3, Expect | dữ liệu thật | `check-backlog.mjs` trên `docs/BACKLOG.md` | 102 dòng, 0 lỗi, thoát 0 |
| TC-141-12 | DoD 2 | dữ liệu thật | `--summary` | tổng 102; khớp §2.5 |
| TC-141-13 | §2.3 | grep | BL-278 vắng; BL-279, 397, 398, 104, 247, 251, 252, 291, 292 có chữ mới; BL-105 hết «(khi có prod)»; BL-401, 402, 403 có; BL-397, 398 ở mục Platform & Ops | đạt |
| TC-141-15 | quy trình | grep | `SKILL.md` Phase 5 và `feature-doc.md` nêu ba cột và `check-backlog.mjs` | đạt |
| TC-141-16 | quy trình | lệnh | `check-doc-links.mjs` | 0 hỏng |
| TC-141-17 | quy trình | — | PR merge, CI xanh, Dev review, bảng đối chiếu | sau G4 |

Chưa có test tự động cho: kết quả chọn mã của từng dòng (là phán đoán, kiểm bằng review và M-141-05); `apply-classification.mjs` (chạy một lần, kết quả được `check-backlog.mjs` kiểm).

## 5. Test thủ công

Điều kiện: Node 24 (`export PATH="$APPDATA/fnm/node-versions/v24.22.2/installation:$PATH"`), từ gốc repo, **sau khi** `apply-classification.mjs --write` đã chạy (BACKLOG đã có tám cột và khối «Phân loại»). Không cần docker hay cloud.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-141-01 | `node .claude/skills/dbs-delivering-task/scripts/check-backlog.mjs --summary` | thoát 0; «102 dòng, 0 lỗi»; số theo mục, nhóm khớp §2.5 |
| M-141-02 | từ chối: bản sao đổi `Cao` thành `Thấp` ở một dòng `T1` | thoát 1; lỗi nêu ID |
| M-141-03 | từ chối: bản sao xóa ô cuối một dòng; nhân đôi một dòng; đổi thứ tự hai dòng | thoát 1; «cần 8 cột», «ID trùng», «tăng dần» |
| M-141-04 | dòng mới từ buổi quay: thêm vào bản sao một dòng đủ 5 cột cũ | thoát 1; thêm ba cột đúng thì thoát 0 |
| M-141-05 | **kiểm độc lập mã:** một subagent (opus, high) nhận quy tắc §2.2 và 20 dòng ngẫu nhiên (seed 141) lấy từ bản 5 cột gốc (`git show HEAD:docs/BACKLOG.md`, không có ba cột mới), tự chọn mã; so với bảng | báo tỉ lệ khớp (mã đầu); mọi dòng lệch được xem lại và ghi ở §8 |
| M-141-06 | biên: dòng cuối file không có xuống dòng; file CRLF (ô có `\|` thoát do TC-141-07 phủ: BACKLOG thật không có dòng nào như vậy) | thoát 0 |
| M-141-07 | `check-doc-links.mjs` | 0 liên kết hỏng |

(Không có bước phục hồi: không có trạng thái để phục hồi.)

## 6. Domain review (AI)

**Reviewer:** subagent `opus`, effort `high` (theo yêu cầu của người dùng), ba lượt, 2026-11-20 · **Lượt 1:** 15 phát hiện (blocking 3, should-fix 8, minor 4), REVISE · **Lượt 2:** 12 phát hiện (blocking 0, should-fix 5, minor 7), REVISE · **Lượt 3:** 2 phát hiện minor, **Verdict: APPROVE**; cả hai đã sửa · [trả lời nguyên văn cả ba lượt](screenshots/DBS-141/domain-review.md)

| # | Mức | Phát hiện (rút gọn) | Xử lý |
|---|---|---|---|
| L1-1 | blocking | T2 gộp «việc trước lượt tải» với «kết quả do chính task tải tạo ra» | đã sửa: nhóm «Trong tải · L (task)» (BL-232, 127, 179, 187, 216, 221, 262, 385); T2 chỉ còn việc phải có sẵn trước tải |
| L1-2 | blocking | Expect «có hạn» không đạt nhưng §2.1 trình bày như đạt | đã sửa: cột Hạn kiểm bằng regex; §1 quyết định 5 nói thẳng phần chưa có hạn hoặc chỉ danh nghĩa |
| L1-3 | blocking | DoD 1 báo «đạt theo quy ước» dù chưa có vấn đề nào từ demo | đã sửa: DoD 1 **chưa đạt**; thêm BL-401 (và quyết định 2, 3) |
| L1-4..11 | should-fix | dòng lỗi thời (BL-252, 104, 247, 251); review của #213, #214; mã sai (BL-198, 290, 105); ưu tiên mất thông tin; H6 chỉ phủ một phần; validator bỏ sót dòng lệch; script chưa thêm bảng mã; thiếu vòng đời | đã sửa từng mục (§2.1–§2.3; ưu tiên có tập cho phép và ghi đè có lý do; `H6` và `L` bắt buộc nêu task; validator chặt hơn; script áp đủ; quy tắc «Rà lại») |
| L1-12..15 | minor | thiếu `manual-test.txt`, truy vết TC, thứ tự ID, hand-off SKILL/template | đã sửa: Phase 4c, §4, sắp ID khi áp, §1 quyết định 7 |
| L2-1..5 | should-fix | BL-252 «Đóng khi» còn cũ; Hạn danh nghĩa của H3/H4; WAF bật hay tắt trong lượt tải chưa ai quyết; sửa sớm SKILL/template/BACKLOG; BL-105 sai mã | đã sửa: «Đóng khi» của BL-252, BL-251; quyết định 5 nói rõ hạn danh nghĩa; BL-291 và BL-292 ghi quyết định mở (**không** do agent quyết); quyết định 8 nêu đủ; BL-105 H4 |
| L2-6..12 | minor | ưu tiên không nhất quán; «đã trễ» gõ tay; mục «Người thật» vs quy tắc vai đầu; BL-397 gộp việc khẩn; BL-029 sai H6; script chỉ chạy trên bản 5 cột; thiếu file manual-test | đã sửa: mọi dòng của DBS-166 ở mức Cao; bỏ «đã trễ» khỏi mặc định, cho phép `Tuần k` và `RSK-n`; mục «Người thật» là loại việc; tách BL-403; BL-029 H4; `--base` bắt buộc; `manual-test.txt` tạo ở Phase 4c |
| L3-1, 2 | minor | `--base` mặc định `HEAD` sai sau khi commit; BL-403 thiếu nguồn DBS-141 | đã sửa: `--base` bắt buộc; BL-403 có nguồn DBS-141 §2.3 |

### Quyết định ở G2 (agent tự quyết)

1. **Hai lượt REVISE được xử lý đến khi APPROVE:** mọi phát hiện được sửa, trừ các điểm cần **quyết định của người** (WAF bật hay tắt trong lượt tải; ngày mới cho BL-390 và BL-401; xác nhận BL-041/236/238), được ghi thành dòng hoặc ghi chú, không do agent quyết.
2. **Ưu tiên là mặc định theo mã, có ghi đè** trong tập cho phép (bác ý «chỉ suy ra từ mã» vì mất thông tin của cổng đã trễ và hạn cứng).
3. **Giữ BL-041/236/238** nguyên vẹn: chưa kiểm được (thư mục `backend/data/fraud/` chưa có).

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Kết quả đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `.claude/skills/dbs-delivering-task/scripts/check-backlog.mjs`, `check-backlog.test.mjs` | TC-141-01..10, 14, 18..21 | lượt đầu: `ERR_MODULE_NOT_FOUND` (chưa có module); đột biến bỏ từng quy tắc (ưu tiên theo mã, `\|` thoát, ID trùng, tập cho phép, `needsTask`, thứ tự, regex Hạn, CRLF) làm đúng test tương ứng đỏ | `node --test .claude/skills/dbs-delivering-task/scripts/check-backlog.test.mjs` | `feat(skill): check-backlog.mjs kiểm bảng BACKLOG (DBS-141)` |
| 2 | `docs/features/screenshots/DBS-141/classification.mjs`, `apply-classification.mjs`, `docs/BACKLOG.md` (khối «Phân loại», tám cột, §2.3) | TC-141-11, 12, 13 | đã chạy: `check-backlog.mjs` trên BACKLOG gốc 5 cột báo 115 lỗi (tiêu đề sai, thiếu mã); sau khi áp: 102 dòng, 0 lỗi | `node …/apply-classification.mjs --base <ref> --write`; `node …/check-backlog.mjs --summary` | `docs(backlog): ưu tiên, xử lý, hạn cho từng dòng nợ (DBS-141)` |
| 3 | `.claude/skills/dbs-delivering-task/SKILL.md` (Phase 5 mục 2), `templates/feature-doc.md` | TC-141-15 | `grep` trước khi sửa: không có «Ưu tiên, Xử lý, Hạn» | `grep -n "Ưu tiên" …` | `docs(skill): dòng BACKLOG mới đủ ba cột (DBS-141)` |
| 4 | feature doc, `docs/features/README.md`, `screenshots/DBS-141/*` (review, manual-test), BACKLOG (BL-401, 402, 403) | TC-141-16 | `check-doc-links`: 1 liên kết hỏng tới `manual-test.txt` trước khi tạo | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `docs: feature doc DBS-141 và bằng chứng` |

**Quét kế hoạch:** DoD 1 (chưa đạt ⇒ BL-401), DoD 2 («gom» ⇒ bước 2; «gửi» ⇒ BL-401), DoD 3 (bước 2), Expect người nhận (cột Vai đã có; TC-06), Expect hạn (cột Hạn; phần danh nghĩa nói thẳng ở §1), BL-390 và BL-351 (nơi sinh vấn đề ⇒ BL-401), quy tắc BACKLOG «xóa dòng khi xử lý» (BL-278 xóa, §2.3), dòng cùng DoD (cả bảng), phụ thuộc PR #215 (nhánh xếp trên nó), CI (BL-402), hand-off techlead (SKILL, template: PR). Không còn mục nào chưa có hàng.

**Rủi ro và cách lùi:** tài liệu và công cụ; lùi bằng `git revert` từng commit. Rủi ro chính là xung đột khi PR khác sửa bảng BACKLOG: bảng tám cột đổi mọi dòng, nên PR này nên merge sớm sau #215 và các PR đang mở phải rebase (`apply-classification.mjs --base <ref>` chạy lại được). Một dòng phân loại sai được sửa ở `classification.mjs` rồi áp lại, hoặc sửa tay và để `check-backlog.mjs` kiểm.

**Quyết định ở G3 (agent tự quyết):** commit theo bốn bước trên sau khi G3 qua (đã sửa file trong working tree trước G3, ghi ở §8).

## 8. Kết quả

- **Lệnh kiểm tra** (2026-11-20, Node 24.22.2, gốc repo; task chỉ chạm tài liệu và script quy trình nên không chạy `lint`/`typecheck`/`test` của `backend/`):

```text
node --test .claude/skills/dbs-delivering-task/scripts/check-backlog.test.mjs → 15 test, 15 đạt, 0 lỗi
node .claude/skills/dbs-delivering-task/scripts/check-backlog.mjs            → 102 dòng, 0 lỗi, thoát 0
node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs          → 486 file, 0 liên kết hỏng
```

  Kiểm đột biến validator (bỏ từng quy tắc thì đúng test tương ứng đỏ): ưu tiên theo mã, ID trùng, tập ưu tiên cho phép, `needsTask`, thứ tự ID, regex Hạn, xử lý CRLF, xử lý `\|`.

- **Đối chiếu test case** (T = `check-backlog.test.mjs`):

| ID | Test | Đạt? |
|---|---|---|
| TC-141-01..10, 14, 18, 19, 20, 21 | T › cùng tên | đạt |
| TC-141-11 | `check-backlog.mjs` trên `docs/BACKLOG.md`: 102 dòng, 0 lỗi (manual-test.txt, M-141-01) | đạt |
| TC-141-12 | `--summary`: tổng 102; theo mục 27/15/52/8; khớp §2.5 từng ô | đạt |
| TC-141-13 | `grep` (BL-278 vắng; BL-279, 397, 398, 104, 247, 251, 252, 291, 292 có chữ mới; BL-105 hết «khi có prod»; BL-401, 402, 403 có; BL-397, 398, 403 ở mục Platform & Ops) | đạt |
| TC-141-15 | `grep`: `SKILL.md` Phase 5 nêu «Ưu tiên, Xử lý, Hạn» và `check-backlog.mjs`; `feature-doc.md` nêu `check-backlog.mjs` | đạt |
| TC-141-16 | `check-doc-links.mjs` | đạt (486 file, 0 hỏng) |
| TC-141-17 | PR merge, CI xanh, Dev review, bảng đối chiếu | chưa làm (sau PR) |

  Đơn giản hóa: kết quả chọn mã của từng dòng là phán đoán, **không** có test tự động; kiểm bằng ba lượt review độc lập và M-141-05 (đã chạy, xem dưới).

- **Test thủ công** (cây sạch, commit `46f1e6f`; output thô [manual-test.txt](screenshots/DBS-141/manual-test.txt)):

| Bước | Kết quả |
|---|---|
| M-141-01 | **đạt**: thoát 0, 102 dòng 0 lỗi; số theo mục (Dev 27, Fraud 15, Platform 52, Người 8), theo nhóm (Trước tải 20, Trong tải 8, Hoãn 74) và ưu tiên (Cao 18, Trung bình 59, Thấp 25) khớp §2.5 |
| M-141-02 | **đạt**: đổi `Cao` thành `Thấp` ở BL-104 (T1): thoát 1, «mã T1 chỉ cho Ưu tiên Cao, dòng ghi Thấp» |
| M-141-03 | **đạt**: xóa ô cuối BL-121 → «cần 8 cột, có 7»; nhân đôi → «ID trùng»; đổi chỗ → «ID phải tăng dần»; cả ba thoát 1 |
| M-141-04 | **đạt**: dòng mới 5 cột → thoát 1 «cần 8 cột, có 5»; thêm ba cột đúng → thoát 0 |
| M-141-05 | **đạt có ghi nhận lệch:** subagent `opus` high mã hóa mù 20 dòng (seed 141) từ bản 5 cột và quy tắc ở đầu BACKLOG: khớp **mã 17/20 (85%)**, khớp **nhóm 18/20 (90%)**, ưu tiên 17/17 trên các dòng khớp mã, hạn của dòng nêu task 3/3. Ba dòng lệch mã: BL-215 (H4/H5), BL-362 (H4/T2), BL-398 (H4/T4), đều là dòng chính subagent nêu lưỡng lự, giữ nguyên và ghi lý do; một hạn đổi (BL-236 → «Sau BL-041»). Nguyên văn và so sánh ở [blind-recoding.md](screenshots/DBS-141/blind-recoding.md) |
| M-141-06 | **đạt**: không xuống dòng cuối và CRLF đều thoát 0, 102 dòng |
| M-141-07 | **đạt**: 486 file, 0 liên kết hỏng |

  Không dùng seed SQL (không có DB).

- **Đối chiếu DoD và Expect (nói thẳng):**

| Mục | Kết quả |
|---|---|
| DoD 1 «mỗi vấn đề thấy trong demo thành một issue, có nhãn, vai, ưu tiên» | **chưa đạt**: chưa có buổi quay (BL-390) nên chưa có «vấn đề thấy trong demo»; không tạo issue/nhãn theo lựa chọn của người dùng. Đã có: mỗi dòng nợ hiện tại có vai, ưu tiên, hạn; định dạng cho vấn đề mới. Phần còn lại: **BL-401** |
| DoD 2 «gom ở một chỗ và gửi cả nhóm» | **một phần**: gom ở `docs/BACKLOG.md` (102 dòng, §2.5 là bản tóm tắt để gửi). «Gửi cả nhóm» là việc của người: **BL-401** |
| DoD 3 «phân loại trước tải hoặc ghi backlog» | **đạt**: mỗi dòng có nhóm và mã |
| Expect «có người nhận và có hạn» | **một phần**: người nhận đủ (kiểm tự động); hạn: 23 dòng «Không có», nhiều dòng chỉ có hạn danh nghĩa, BL-390 và BL-401 chưa có ngày mới (§1 quyết định 5) |
| PR đã merge, CI xanh, Dev review, bảng đối chiếu | chưa (sau PR) |

- **Phạm vi so với §7:** `git diff --stat origin/main...HEAD` (nhánh xếp trên #215, chỉ phần DBS-141): `check-backlog.mjs` + test, `classification.mjs`, `apply-classification.mjs`, `docs/BACKLOG.md`, `SKILL.md`, `templates/feature-doc.md`, feature doc, `docs/features/README.md`, `screenshots/DBS-141/*`: đều nằm trong §7 (bước 1–4).
- **Ảnh chụp:** không áp dụng (task chỉ chạm tài liệu và script, không có giao diện); output thô ở `manual-test.txt`.
- **Chạy lại `apply-classification.mjs`:** đã chạy với `--base f9a78f0` (bản 5 cột, tip của nhánh PR #215 trước commit này) rồi `--write`. Sau khi #215 merge và nhánh này rebase lên `main`, chạy lại với `--base <commit chứa bản 5 cột>` nếu `main` đổi bảng.
- **Lệch so với kế hoạch (ghi trước khi làm, hoặc ngay khi phát hiện):**
  1. **Thứ tự gate:** `check-backlog.mjs`, test, `SKILL.md`, `templates/feature-doc.md` và `docs/BACKLOG.md` (đã áp ba cột) được viết hoặc sửa trong working tree **trước G3**; chưa commit trước G3. Lý do: thử thiết kế bằng dữ liệu thật; reviewer nêu ở lượt 2 và đã ghi ở §1 quyết định 8.
  2. Thiết kế đầu (một nhóm «Trước tải/Hoãn», ưu tiên suy ra cứng, không cột Hạn) được thay sau review; đã ghi ở §6.
  3. **BL-277** được đổi từ T2 sang H4 khi viết lại phân loại (việc là đo chu kỳ đối soát trên dataset lớn để chọn chu kỳ production, không chặn lượt tải).
  4. Lần chạy đầu của subagent M-141-05 bị người dùng dừng giữa chừng; người dùng cho chạy lại và nó hoàn tất.
- **Bàn giao (dòng BACKLOG đã thêm):** **BL-401** (Dev người quay và người gom: gom vấn đề sau buổi quay, gửi cả nhóm), **BL-402** (Dev: nối `check-backlog.mjs` vào CI), **BL-403** (chủ tài khoản OpenAI: thu hồi khóa lộ ở PR #45, Hạn «Ngay»). **Việc cần người quyết, không có dòng riêng:** (a) WAF bật hay tắt trong lượt tải DBS-166 (ghi ở BL-291, BL-292); (b) ngày mới cho BL-390 và BL-401; (c) #4 xác nhận BL-041, 236, 238; (d) techlead duyệt phần sửa `SKILL.md` và `templates/feature-doc.md`; (f) gửi bản tóm tắt §2.5 cho cả nhóm. **Đã xóa/sửa:** BL-278 xóa; BL-279, 397, 398, 104, 247, 251, 252, 291, 292 sửa chữ; BL-105 đổi vai và mã (§2.3).

## 9. Tài liệu đã cập nhật

- `docs/BACKLOG.md`: khối «Phân loại» ở đầu, tám cột, §2.3; xóa **BL-278**; thêm **BL-401, 402, 403**.
- `.claude/skills/dbs-delivering-task/SKILL.md` (Phase 5 mục 2) và `templates/feature-doc.md` (§8 và checklist G4): dòng BACKLOG mới đủ ba cột, chạy `check-backlog.mjs`.
- `docs/features/README.md`: hàng DBS-141.
- Không đổi ADR, `docs/03`, runbook hay contract.
