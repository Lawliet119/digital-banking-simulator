| # | Mức | Mục | Phát hiện | Bằng chứng | Đề xuất |
|---|---|---|---|---|---|
| 1 | Blocking | §2, §4 | Chưa có consumer; RiskModule rỗng không thể chứng minh consumer chỉ chạy ở worker. | `backend/src/modules/index.ts`; DoD DBS-59 mục 3 | Ghi mục này đạt một phần và bàn giao test runtime khi có consumer. |
| 2 | Should-fix | §3 | `Features` và `RuleParams` chưa có hình dạng, đơn vị và quy tắc thời điểm cụ thể. | `docs/components/risk/FRAUD_DETECTION_GUIDE.md` §4.2; `02-architecture.md` §1 | Chốt kiểu readonly và đơn vị cho từng trường trong thiết kế. |
| 3 | Should-fix | §2, §4 | `TransferCompleted` gồm cả `DEPOSIT`, còn risk chỉ chấm `TRANSFER`; test chưa phủ ranh giới này. | `backend/src/common/events/event-types.ts`; fraud guide §4.1 | Thu hẹp kiểu đầu vào rule hoặc quy định caller lọc và thêm test. |
| 4 | Minor | §5 | Khi chưa có consumer, chạy API và worker chỉ chứng minh bootstrap, chưa chứng minh API không poll queue sau này. | `backend/src/modules/index.ts` | Ghi giới hạn của M-59-03. |

**Verdict: REVISE.**

Sau sửa §1–§5, reviewer xác nhận bốn phát hiện đã xử lý và kết luận: **Verdict: APPROVE cho phạm vi khung đã giới hạn rõ**. Còn cần #1/#6 xác nhận contract; không đánh dấu toàn bộ DoD #2/#3 đạt trước khi có xác nhận và consumer runtime.
