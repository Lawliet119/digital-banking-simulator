# DBS-179 · Đo chi phí AWS thật theo dịch vụ và dự báo

> **Status:** Draft · **Vai:** #5 Platform & Ops · **Cặp đôi review:** Dev · **Nhánh:** `docs/DBS-179-cost-actual` · **PR:** — · **Cập nhật:** 2026-11-22

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 7, Deliverable P4, Ưu tiên Medium, board "To Do". **Expect:** Số thật cho câu bảo vệ 11 và P4 (capacity & cost). **Thực trạng (board):** mới có ước lượng chi phí trong `docs/DEPLOYMENT_OPTIONS_VPS_VS_CLOUD.md` và báo cáo tuần.
- **DoD** (nguyên văn):
  1. Bảng chi phí theo dịch vụ từ Cost Explorer kèm số giờ dựng, so với ngân sách và credit còn lại
  2. Ước tính chi phí chạy 24/7 và chi phí theo phiên làm việc
  3. Gửi nhóm mỗi thứ Hai; đề xuất cắt giảm nếu cần
  4. PR đã merge vào main; Dev review; không còn liên kết hỏng, tên bảng/cột/mã lỗi khớp các tài liệu khác (đã grep)
- **Phụ thuộc:** DBS-143 (Done, merge `main`: script `cost-report.py`, hai báo cáo 11-04 và 11-14), DBS-166 (Done, #224). Cả hai có trong `origin/main` `2424449b`.
- **Đã có gì:** [`infra/scripts/cost-report.py`](../../infra/scripts/cost-report.py) và test `test_cost_report.py` ([DBS-143](DBS-143-cost-report.md)); báo cáo [2026-11-04](../components/platform-infra/cost-reports/2026-11-04.md), [2026-11-14](../components/platform-infra/cost-reports/2026-11-14.md); ước tính theo giờ ở ADR-11 phụ lục; chi phí chênh Multi-AZ ở [DBS-180](DBS-180-rds-multi-az.md). `AWS_PROFILE=dbs` có quyền `ce:*` (đã chạy thật). **Baseline:** không đổi code; `verify-clean.sh` kết luận «sạch (13 loại)» (chỉ còn `base`), `cost-report.py` chạy thoát 0.
- **Ngoài phạm vi:** so sánh Single-AZ và Multi-AZ kèm RTO/RPO (DBS-182); ghép P4 (DBS-189); đối chiếu hóa đơn và số dư credit ở console Billing (việc của người, [BL-426](../BACKLOG.md)); đổi code `cost-report.py` (đã đủ cho DoD 1).
- **BL đã nêu:** [BL-290](../BACKLOG.md) mục (1) «số đo chi phí WAF trên Cost Explorer» được xử lý ở task này (số thật 1,0131 USD tới 21/11); các mục còn lại giữ (đánh số lại thành (1), (2); BL-291 đã sửa tham chiếu). [BL-291](../BACKLOG.md) (tắt WAF) vẫn ở lại, có thêm số để quyết.
- **Câu hỏi mở và quyết định ở G1** (agent tự quyết):
  1. *Dữ liệu cuối cùng?* Cost Explorer chốt tới hết 2026-11-21 UTC (`--end 2026-11-22`, exclusive); các phiên 22/11 chưa có. Báo cáo ghi «ước lượng, chưa đối chiếu hóa đơn» và có BL-426 để đối chiếu sau (theo TonightWorks §2 Phiên 3).
  2. *Mô hình 24/7 và theo phiên?* Tính từ đơn giá thật (chi phí ÷ quantity của từng usage type) nhân cấu hình docs/03 §13.1, kiểm bằng cả ngày UTC 21/11; không thêm script mới (số chỉ cần một lần, công thức nằm trong tài liệu).
  3. *«Gửi nhóm mỗi thứ Hai»?* Agent không gửi; báo cáo có đoạn tóm tắt để người dán, quy trình thứ Hai đã ở `infra/terraform/README.md` (DBS-143). 22/11 là Chủ nhật: báo cáo này là bản giữa tuần, bản thứ Hai 23/11 do người chạy cùng quy trình, cũng là lúc đóng BL-426.

## 2. Hành vi

Task tài liệu và số liệu, không có API. Đầu ra:

| # | Đầu ra | Chấp nhận khi |
|---|---|---|
| 2.1 | [Báo cáo `cost-reports/2026-11-22.md`](../components/platform-infra/cost-reports/2026-11-22.md): mục 1–4 là output nguyên của `cost-report.py --start 2026-10-01 --end 2026-11-22` (chỉ thêm chú thích nhãn dự báo); mục 5 (hai dòng), 6, 7, 8 viết tay (kiểm Down, ngân sách, credit, đề xuất, tóm tắt gửi nhóm) và có ghi chú nguồn ở đầu file | tổng và từng dòng khớp `aws ce get-cost-and-usage` chạy riêng; mọi con số có nguồn lệnh |
| 2.2 | [`02-capacity-cost.md`](../components/platform-infra/02-capacity-cost.md): chi phí thật theo dịch vụ, đơn giá quan sát, chi phí theo giờ và theo phiên, 24/7, dự báo tới 13/12, giới hạn | công thức tái tính được từ bảng đơn giá; mô hình lệch khỏi ngày UTC 21/11 có giải thích |
| 2.3 | `BACKLOG.md`: thêm BL-426 (đối chiếu hóa đơn, gửi nhóm) và BL-427 (nhãn dự báo và khuyết của `cost-report.py`), sửa BL-290 (bỏ mục 1) và tham chiếu ở BL-291 | `check-backlog.mjs` sạch |

Quy tắc: tiền là USD, tính bằng `decimal.Decimal`, làm tròn 4 chữ số khi in ở báo cáo và 2 chữ số ở tài liệu tổng hợp; không bịa số khi thiếu (ghi «chưa có» kèm BL); không in account id, ARN, tên miền.

## 3. Kiến trúc

Không đổi code, Terraform hay ADR. File mới: `docs/components/platform-infra/cost-reports/2026-11-22.md`, `docs/components/platform-infra/02-capacity-cost.md`, `docs/features/DBS-179-cost-actual.md`, `docs/features/screenshots/DBS-179/{manual-test.txt,calc.py,domain-review.md}`. File sửa: `docs/BACKLOG.md`, `docs/features/README.md`, `docs/components/index.md`, `infra/terraform/README.md` (một dòng trỏ tới tài liệu mới). Nguồn dữ liệu: Cost Explorer (`ce get-cost-and-usage`, `ce get-cost-forecast` qua script), `aws budgets describe-budgets`, `verify-clean.sh`. Chỉ đọc, không đổi AWS.

## 4. Test cases (task số liệu: kiểm bằng tái tính)

| ID | Truy vết | Lớp | Given · When · Then |
|---|---|---|---|
| TC-179-01 | DoD 1 | tái tính | tổng báo cáo mục 1 = tổng `get-cost-and-usage` MONTHLY theo `SERVICE` lọc bỏ `Credit`, `Refund` cùng khoảng · khớp 4 chữ số |
| TC-179-02 | DoD 1 | tái tính | số giờ ALB, node Valkey, RDS ở mục 2 = `UsageQuantity` theo ngày cộng lại |
| TC-179-03 | DoD 1 | tái tính | Budget 150 USD ACTUAL khớp `aws budgets`; credit đã dùng = tổng Credit theo tháng (`RECORD_TYPE`) = 8,7053; nhãn dự báo AWS kiểm bằng `get-cost-forecast` hai khoảng bắt đầu khác nhau (ra cùng số = dự báo cả tháng) |
| TC-179-04 | DoD 2 | tái tính | `calc.py` in mọi số suy ra ở `02-capacity-cost.md` §4–§6 (giờ 0,1394 và 0,2752; 24/7 112,43 và 203,95; phiên; 71/29 %; dự báo 6,15–6,95) · khớp từng số trong tài liệu |
| TC-179-05 | DoD 2 | tái tính | mô hình (12 giờ ALB × giờ cấu hình đo + phí theo tải thật) so với ngày UTC 21/11 thật 4,5290 · lệch được tính và giải thích (mô hình cao hơn ≈ 20 %); phép kiểm có thể trượt, không phải đồng nhất thức |
| TC-179-06 | DoD 3 | quy trình | có mục «Đề xuất cắt giảm» và «Tóm tắt gửi nhóm» viết tay. **Việc gửi nhóm mỗi thứ Hai do người làm: chưa đạt trong PR này**, ghi ở BL-426 |
| TC-179-07 | DoD 4 | quy trình + grep | `check-doc-links.mjs` sạch; `check-backlog.mjs` sạch; grep tên dịch vụ, usage type khớp báo cáo DBS-143. **Dev review chưa đạt về hình thức** (opus thay người, `Techlead waiver`) |

## 5. Test thủ công (operations run)

Điều kiện: `AWS_PROFILE=dbs`, `PYTHONUTF8=1`, bash; output thô ở [manual-test.txt](screenshots/DBS-179/manual-test.txt) (đã xóa account id).

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-179-01 | `bash infra/scripts/verify-clean.sh` | «sạch (13 loại)» |
| M-179-02 | `python infra/scripts/cost-report.py --start 2026-10-01 --end 2026-11-22` | thoát 0, 7 mục, tổng 8,2642 |
| M-179-03 | `aws ce get-cost-and-usage` MONTHLY nhóm `SERVICE`, lọc bỏ credit, cùng khoảng | tổng và dòng RDS, ALB, WAF khớp M-179-02 |
| M-179-04 | `get-cost-and-usage` DAILY, `UsageQuantity` ALB và Valkey theo ngày; M-179-04b: chi phí gộp từng ngày 24/10–21/11 và ngày 21/11 nhóm `SERVICE`+`USAGE_TYPE` | khớp bảng §2, §3 và §4 của `02-capacity-cost.md` |
| M-179-05 | `aws budgets describe-budgets` | `My Monthly Cost Budget` 150 USD, ACTUAL 7,766 USD, FORECASTED 8,567 |
| M-179-06 | `PYTHONUTF8=1 python docs/features/screenshots/DBS-179/calc.py` | khớp mọi con số ở `02-capacity-cost.md` §4–§6 |
| M-179-07 | `get-cost-and-usage` MONTHLY nhóm `RECORD_TYPE` từ 2026-08-01 | Credit = −Usage từng tháng, tổng 8,7053 |
| M-179-08 | `get-cost-forecast` ba khoảng (22/11, 23/11, 22/11–14/12) | 8,5669 cho hai khoảng đầu (dự báo cả tháng) |
| M-179-09 | `grep` `modules/waf/main.tf`, `envs/*/session` | 3 rule; chỉ `envs/dev/session` có WAF |
| M-179-10 | `check-doc-links.mjs`, `check-backlog.mjs` | 0 lỗi |

## 6. Domain review (AI)

**Reviewer:** subagent general-purpose, model opus, effort high, 2026-11-22 · **Vòng 1:** 16 phát hiện (blocking 2, should-fix 8, minor 6), verdict REVISE · [trả lời nguyên văn](screenshots/DBS-179/domain-review.md) · **Vòng 2:** (điền sau khi chạy)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | phiên BL-418 tính hai lần, ngày 21/11 gồm bốn phiên | đã sửa: BL-418 (16:58Z–18:02Z) và giờ đầu AWS-A đã nằm trong số 21/11; dự báo chỉ còn phần UTC 22/11 của AWS-A (2 giờ ALB); ngày 21/11 ghi bốn phiên; dự báo 6–7 USD (bản đầu 8–10) |
| 2 | blocking | SQS 0,1460 và data transfer lấy sai nguồn | đã sửa: chạy lại DAILY theo `SERVICE`+`USAGE_TYPE` ngày 21/11 (M-179-04b): SQS 0,1434, data transfer giữa AZ 0,0652 + 0,0428 + 0,0428 = 0,1508 (cả ba dòng đều ngày 21/11, nên số lũy kế cả kỳ trùng); phần theo tải 1,3173, theo giờ 3,2117 |
| 3 | should-fix | nhiều số không có trong output thô | đã sửa: M-179-04b, 07, 08, 09 vào `manual-test.txt`; nguồn đơn giá §3 ghi đúng |
| 4 | should-fix | credit đã dùng lớn hơn chi phí | đã kiểm (M-179-07): Credit = −Usage từng tháng, tổng 0,4411 + 0,0001 + 0,4977 + 7,7665 = 8,7054; reviewer dùng số 0,0545 của tháng 8 từ DBS-143, Cost Explorer đã điều chỉnh số tháng 8 lên 0,4411; không lệch |
| 5 | should-fix | 8,5669 là khoảng nào | đã kiểm (M-179-08): hai khoảng bắt đầu khác nhau ra cùng số, khớp FORECASTED cả tháng của Budget: là dự báo cả tháng 11; nhãn của script sai, ghi ở báo cáo mục 4, `02-capacity-cost.md` §6 và BL-427 |
| 6 | should-fix | phép kiểm mô hình đồng nhất thức | đã sửa: so mô hình độc lập (12 giờ × 0,3439 + phí tải thật = 5,44) với thật 4,53: mô hình cao hơn ≈ 20 %, ghi là cận trên |
| 7 | should-fix | production không có WAF | đã sửa: production 24/7 = 203,95 (vẫn vượt 150 và 200); dev 112,43, 104,43 khi tắt WAF từ 26/11 |
| 8 | should-fix | tham chiếu BL-290/291 | đã sửa: BL-291 trỏ «phần (1) của BL-290»; feature §1 ghi đánh số lại |
| 9 | should-fix | `calc.py` thiếu phép tính | đã sửa: `calc.py` viết lại, in mọi số suy ra ở §4–§6 |
| 10 | should-fix | tóm tắt gửi nhóm; DoD 3, 4 | đã sửa: tóm tắt viết tay; DoD 3 (gửi) và DoD 4 (Dev review) ghi chưa đạt ở TC-179-06, 07, §8 và BL-426 |
| 11 | minor | công thức theo phiên không nhất quán | đã sửa: một công thức (giờ × (giá giờ + WAF cố định) + phí tải) cho mọi dòng; dev theo tuần 6,01–7,52; AWS-A tính theo mô hình, DBS-167 tự ghi ≈ 0,5 USD/giờ |
| 12 | minor | thiếu secret của phiên | đã sửa: dòng secret 0,80 và 1,20 USD/tháng, ghi là giả định ở §7 |
| 13 | minor | số rule WAF | đã đối chiếu `modules/waf/main.tf`: 3 rule (M-179-09) |
| 14 | minor | NFR-COST-01 | đã sửa: Budget 150; NFR-COST-01 150–200 |
| 15 | minor | báo cáo không còn nguyên output | đã sửa: ghi chú nguồn từng mục ở đầu báo cáo; danh sách file §3 |
| 16 | chuyển việc | DBS-143 script, DBS-182, DBS-189 | BL-427 (script); DBS-182 dùng đơn giá đã xác minh; DBS-189 dùng số đã sửa |

**Quyết định ở G2** (agent tự quyết, 2026-11-22): duyệt thiết kế §2–§5 sau vòng 1 và các sửa trên (vòng 2 xem đầu mục). Không sửa `cost-report.py` trong task này (nhãn dự báo là BL-427) vì đổi script là mở rộng phạm vi; tài liệu ghi rõ nhãn sai.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Lệnh chứng minh | Commit |
|---|---|---|---|---|
| 1 | `cost-reports/2026-11-22.md` | TC-179-01, 02, 03 | M-179-02…05 | `docs(infra): báo cáo chi phí AWS tới 21/11 (DBS-179)` |
| 2 | `02-capacity-cost.md` | TC-179-04, 05 | M-179-06 | `docs(infra): capacity và chi phí 24/7, theo phiên (DBS-179)` |
| 3 | `BACKLOG.md`, `features/README.md`, `infra/terraform/README.md`, feature doc §8–§9, `manual-test.txt` | TC-179-06, 07 | `check-doc-links.mjs`, `check-backlog.mjs` | `docs(features): DBS-179 implemented` |

Rủi ro: Cost Explorer sửa số ngày cuối sau khi báo cáo viết (ngày 21/11 có thể tăng): ghi «ước lượng» và BL-426. Lùi: xóa ba file mới, không đổi AWS.
Quét giới hạn và DoD: DoD 1 → bước 1; DoD 2 → bước 2; DoD 3 → bước 1 (đề xuất, tóm tắt), người gửi; DoD 4 → bước 3. BL-290 (1) → bước 3.

## 8. Kết quả

(Điền sau Phase 4–5.)

## 9. Tài liệu đã cập nhật

(Điền sau Phase 5.)
