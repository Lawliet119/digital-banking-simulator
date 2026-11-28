# Kế hoạch tuần 23–29/11: hoàn thiện để bảo vệ

> **Trạng thái:** Bản nháp chờ nhóm duyệt · **Lập ngày:** 2026-11-22 · **Dựa trên:** `main` tại `ddd5dd8c` (#240) và board trên sheet đọc cùng ngày

Kế hoạch xếp các đầu việc còn mở từ quan trọng nhất trở xuống, để tuần 23–29/11 đưa sản phẩm tới trạng thái bảo vệ được. Thứ tự dựa trên một câu hỏi: thiếu việc này thì buổi bảo vệ hỏng, yếu hay không ảnh hưởng.

## 1. Tình hình tại `ddd5dd8c`

- **Đã xong trong repo nhưng board chưa cập nhật:** P4 đã ghép ([P4-production-engineering.md](../deliverables/P4-production-engineering.md), #237); DBS-167, 178, 179, 182, 186, 142 và RSK-05 đã merge. Board vẫn ghi các task này là To Do hoặc In Progress.
- **Phần còn mở nặng nhất là P5 (AI/fraud):** chưa chạy holdout (DBS-169), chưa có ablation (DBS-170), chưa viết P5 (DBS-190); DBS-174 và DBS-175 chưa đo.
- **Phần bảo vệ (tuần 9–10, DBS-191 đến DBS-207) chưa task nào xong**, trừ ghi chú câu 7 ([DBS-197](../features/DBS-197-defense-q7-notes.md)).
- **Repo không ghi ngày bảo vệ, hạn nộp, cũng không có văn bản của 12 câu bảo vệ.** P1, P2, P4, P5 đều ghi «chưa nộp» ở [deliverables/README.md](../deliverables/README.md).
- DBS-173: p95 tổng ở 120 RPS đạt, «từng phút < 300 ms» chưa đạt (BL-419); BL-413 giữ dòng theo quyết định ở [DBS-173 §2.4](../features/DBS-173-p95-120rps.md).

## 2. Đầu việc, từ quan trọng nhất trở xuống

### P0: thiếu thì không bảo vệ được

| # | Việc | Vì sao | Ai làm |
|---|---|---|---|
| 1 | Chốt ngày bảo vệ, hạn nộp P1–P5 và lấy văn bản 12 câu bảo vệ đưa vào repo | Mọi lịch phía dưới phụ thuộc vào đây. Hiện câu 7 đang phải đoán đề | Techlead, hỏi giảng viên |
| 2 | Chuỗi P5: kiểm DBS-132/133 (repo đã có `backend/src/scripts/evaluate-rules.ts` và [05-evaluation-b0-baseline](../components/risk/05-evaluation-b0-baseline.md)) → gỡ chặn holdout (BL-171 chỗ giữ nhãn, BL-392, BL-405) → BL-407 công cụ đo → **DBS-169 holdout (chạy đúng một lần)** → DBS-170 ablation → **DBS-190 viết P5 và câu 12** | Câu 12 là câu hội đồng hỏi nhiều nhất ([FRAUD guide §10](../components/risk/FRAUD_DETECTION_GUIDE.md)). Chưa có số holdout nào cho NFR-FRD-02. Đây là đường găng dài nhất và cần người | #4, #6; agent làm BL-407 |
| 3 | Kịch bản buổi bảo vệ (DBS-194) và slide (DBS-204) | Đây là thứ hội đồng thực sự nhìn thấy | Dev; agent soạn nháp |
| 4 | Chuẩn bị 12 câu kèm bằng chứng: DBS-193 (câu 2, 6, 10), DBS-195 (1, 3, 9), DBS-196 (4, 5), DBS-198 (8, 9, 11). Câu 7 đã có | Bằng chứng đã nằm sẵn trong P3, P4 và các báo cáo tải, chủ yếu cần ghép lại | Agent ghép, người luyện |
| 5 | Chạy Demo 1–5 trên cloud hai lần liên tiếp (DBS-206, DBS-207) và quay video làm kế hoạch B | Demo trực tiếp có thể hỏng. Video giữa kỳ (BL-390) cũng chưa quay | #5 và cả nhóm |

### P1: thiếu thì câu trả lời yếu

| # | Việc | Ghi chú |
|---|---|---|
| 6 | Thu hồi khóa OpenAI bị lộ và nạp khóa mới (BL-403, BL-397) | Làm mất 5 phút. Hội đồng hỏi bảo mật mà khóa lộ vẫn còn sống thì rất khó đỡ. Không có khóa mới thì DBS-174 chỉ đo được B0 |
| 7 | Phiên AWS-B: DBS-174 (thời gian từ giao dịch tới cờ), DBS-175 (relay), đo `hot-account` cho BL-413 | P5 phụ thuộc DBS-174. Dựng một lần, hủy trong ngày |
| 8 | Đóng băng code (DBS-200) rồi chạy lại toàn bộ test và tải trên code cuối (DBS-191 → DBS-192) | Số liệu hiện lấy từ nhiều thời điểm khác nhau. Nên đóng băng ngay sau 174/175, không đợi tuần 10 |
| 9 | Vá CVE CRITICAL của zlib trong image (BL-264) | Rẻ, và gỡ được một điểm trừ ở phần bảo mật |
| 10 | Tổng duyệt đủ 12 câu và vá lỗ hổng (DBS-199), có luyện với người khác (BL-387) | Làm trước ngày bảo vệ 2–3 ngày |
| 11 | Cho người review lại các PR đường tiền đã merge bằng `Techlead waiver` (#227, #238) | Opus review thay người nên DoD «Dev review» chưa đạt về hình thức. Hội đồng có thể hỏi «ai review» |

### P2: nên có

| # | Việc |
|---|---|
| 12 | Đồng bộ board với repo (DBS-167, 173 một phần, 178, 179, 181, 182, 184, 186, 189, 142, RSK-05) và nộp P1–P4 |
| 13 | Đối chiếu tài liệu và ADR với code cuối (DBS-201); lưu bằng chứng vào `docs/deliverables` (DBS-202) |
| 14 | Đo đủ bước «dựng từ trống ≤ 30 phút» (BL-251) và chạy `seed-cloud.sh` (BL-252), vì sáng ngày bảo vệ sẽ phải dựng stack |
| 15 | Gửi tóm tắt chi phí cho nhóm thứ Hai 23/11 (BL-426); tắt WAF (BL-291, hạn 26/11) nếu Demo 4 không cần WAF |

### P3: để sau bảo vệ hoặc bỏ

- **Để sau bảo vệ:** dọn AWS, hóa đơn, IAM (DBS-208–210); các BL còn lại (lô C, D, E, G, H, I); BL-104 và BL-109 (workflow Deploy).
- **Nên bỏ:**
  - **Giao diện web** (kế hoạch UI ngày 2026-11-15, vẫn là bản nháp, chưa có trên `main`): cần migration và đổi backend, đi ngược việc đóng băng code. Chỉ làm nếu tiêu chí chấm bắt buộc có UI.
  - Sửa BL-413: giữ quyết định của #239 và trình bày nó như một giới hạn đã biết.

## 3. Lịch tuần 23–29/11

| Ngày | Agent | Người |
|---|---|---|
| T2 23/11 | BL-407, BL-264 | Việc #1, #6; gửi chi phí; #4 và #6 gỡ BL-171, BL-392, BL-405 |
| T3 24/11 | Phiên AWS-B: DBS-174, DBS-175 (dựng một lần, hủy trong ngày) | #4 chạy holdout DBS-169 nếu đã gỡ chặn |
| T4 25/11 | Đóng băng code (tag), nháp DBS-194 và khung slide | #4 làm ablation DBS-170 |
| T5 26/11 | Phiên AWS: DBS-191 cùng lần chạy thử thứ nhất của Demo 1–5 | #4 viết P5; nhóm duyệt kịch bản |
| T6 27/11 | DBS-192; DBS-193, 195, 196, 198; DBS-201 | Review PR đường tiền; quay video kế hoạch B |
| T7 28/11 | Hoàn thiện slide, DBS-202 | Tổng duyệt DBS-199 (lần 1) |
| CN 29/11 | Sửa lỗ hổng sau tổng duyệt | Chạy thử demo trên cloud lần 2 (DBS-207) |

Nếu ngày bảo vệ rơi trước 29/11 thì dồn lịch lại theo thứ tự ở §2, không đổi thứ tự.

**Kế hoạch B cho P5:** nếu đến thứ Tư 25/11 holdout vẫn bị chặn, P5 báo cáo số trên tập tune kèm câu «holdout chưa chạy, lý do…». Không chạy holdout vội trên dữ liệu chưa được kiểm, vì holdout chỉ được dùng một lần ([09-freeze-rule-config](../components/risk/09-freeze-rule-config.md)).

## 4. Cần techlead quyết

1. Ngày bảo vệ và văn bản 12 câu.
2. Có cần UI không. Đề nghị: không.
3. Kế hoạch B của P5 ở §3 có chấp nhận được không.

## 5. Nguồn

- Board: `node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs DBS-<n>` (đọc 2026-11-22).
- [BACKLOG.md](../BACKLOG.md): các dòng BL nêu ở trên.
- Kịch bản demo: Demo 1, 2 ở [load-tests/README.md](../../load-tests/README.md); Demo 3 ở [demo-3-failure-recovery.md](../demos/demo-3-failure-recovery.md); Demo 4 ở [demo-4-security-audit.md](../demos/demo-4-security-audit.md); Demo 5 là báo cáo tải [DBS-166](../features/DBS-166-load-report.md).
