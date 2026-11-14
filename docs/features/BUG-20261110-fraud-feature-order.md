# Sửa feature fraud khi giao event đảo thứ tự

## Nguyên nhân và thay đổi

Đã tái hiện trên PostgreSQL/Valkey: warm R1 rồi commit B/C nhưng xử lý C trước nhận 2 thay vì 3; R5 tương tự nhận 2 thay vì 3; replay recipient 31 ngày trước làm cửa sổ mới nhận 1 thay vì 2. Coverage Redis không chứng minh mọi commit đã được consume; member recipient có thể bị ghi lùi timestamp.

R1 dùng SQL count/filter/bool_or; R5 dùng count trên truy vấn novelty 30 ngày. Không materialize toàn bộ transfer/recipient trong đường extract. Mọi truy vấn đọc `v_transfer_facts`, chỉ COMPLETED TRANSFER, so sánh event-time mili giây bằng biên timestamp giữ khả năng dùng index. Timestamp trước epoch cũng làm tròn xuống đúng mili giây. R3/R6 giữ snapshot event. SQL/luật lỗi propagate; không fallback feature thiếu.

Constructor: `new OnlineFeatureProvider({ facts: TransferFacts, perTxLimit: bigint })`. Bỏ counter Redis và `invalidateCounters()`, cập nhật worker, consumer harness và restart tests. Giữ Redis cho cấu hình luật cùng metric dùng nơi khác; SQL feature không tăng Redis fallback.

## Kiểm thử và quyết định tự review

| Kiểm tra | Kết quả |
|---|---|
| Lint toàn backend, typecheck, unit provider | Đạt; 8 test unit |
| PostgreSQL facts và consumer | 2 suite, 24 test đạt, gồm plan trên 40.000 hàng |
| PostgreSQL service regressions | 2 suite, 5 test đạt; sau bổ sung test trước epoch, suite thứ tự có 4 test đạt |
| Chạy tay | R1/R5 đếm các commit chưa giao event; replay lịch sử không đổi cửa sổ tương lai |

Lệnh từ `backend/`: `npm run lint:check`, `npm run typecheck`, `npm test -- --runInBand --runTestsByPath src/modules/risk/features/online-feature-provider.spec.ts`, `npm run test:db -- --runInBand --runTestsByPath test/db/transfer-facts.db-spec.ts test/db/risk-scoring-consumer.db-spec.ts`, `npm run test:services -- --runInBand --runTestsByPath test/services/online-feature-provider.services-spec.ts test/services/risk-feature-order.services-spec.ts`, và `npx ts-node -r tsconfig-paths/register test/manual/online-feature-provider.manual.ts` với PostgreSQL thử nghiệm.

Chọn tính từ fact đã commit thay vì duy trì cache thứ tự nhận event: đúng với các ca tái hiện và không thay event, schema hay logic tiền. Test không chứng minh tải production; CI và Dev review còn chờ.

## Snapshot và đo cục bộ (BL-187)

**Snapshot.** `OnlineFeatureProvider.extract` mở `TransferFacts.snapshot`: một transaction `REPEATABLE READ READ ONLY` trên một connection riêng (`statement_timeout` 5 giây, `idle_in_transaction_session_timeout` 10 giây, đặt `is_local`), chạy lần lượt năm SELECT rồi `COMMIT`; lỗi thì `ROLLBACK`, trả connection về pool và `extract` reject, không chấm điểm từ feature thiếu. Một transfer commit ở connection khác sau khi snapshot mở không bị tính ở SELECT nào trong năm câu (trước đây mỗi câu tự commit ở connection riêng nên có thể thấy khác nhau). Test: `test/db/online-feature-snapshot.db-spec.ts` (TC-187-01..05: chèn fact sau khi snapshot mở không đổi feature; không snapshot thì hai SELECT lệch nhau; 1 connection, `START … READ ONLY`, năm SELECT, `COMMIT`; ghi bị từ chối 25006 và timeout không rò sang connection khác; lỗi giải phóng connection). Các regression đảo thứ tự và replay (`risk-feature-order`, `online-feature-provider`, `risk-scoring`) giữ nguyên kết quả. Queryable không cho mượn connection (`QueryRunner`, test double) chạy như cũ, snapshot là việc của người gọi.

**Đo cục bộ** (số **cục bộ**, không phải RDS: PostgreSQL 17 Testcontainers trên máy phát triển Windows/Docker, không mạng, một tiến trình đo; `npx ts-node -r tsconfig-paths/register test/manual/online-feature-provider.bench.manual.ts`). Tài khoản nóng như bài `hot-account` của k6: 18.000 fact COMPLETED trong giờ trước, 200 người nhận, pool 10; `legacy` là bản 5 SELECT song song ở 5 connection trước BL-187.

| | SELECT gửi mỗi extract | connection mượn | tuần tự p50 / p95 (ms) | 20 extract/giây (open loop) p50 / p95 / p99 (ms) |
|---|---|---|---|---|
| legacy (trước) | 5 | tới 5 | 14,5 / 19,5 | 12,3 / 18,9 / 23,9 |
| snapshot (nay) | 7 (BEGIN, 5 SELECT, COMMIT) | 1 | 38,6 / 46,7 | 35,0 / 45,9 / 48,4 |
| snapshot, tài khoản không có fact | 7 | 1 | 6,3 / 9,3 | không đo |

Đọc: nhất quán một snapshot làm độ trễ của một extract trên tài khoản nóng tăng khoảng 2,5 lần (năm câu chạy nối tiếp thay vì song song) nhưng giảm số connection mượn từ 5 xuống 1; p95 46 ms ở 20 extract/giây là nhỏ so với phần còn lại của đường chấm điểm bất đồng bộ. Con số đúng với tốc độ chuyển tiền thật của các bài tải (hot-account 20 chuyển/giây; baseline 120 RPS với 20% chuyển, khoảng 24 chuyển/giây): một request HTTP không phải một extract. Một lượt sơ bộ khác (tài khoản có thêm 50.000 fact lịch sử, nhiễu do máy đang chạy việc khác nên không đưa vào bảng) cho tuần tự p50 khoảng 58–65 ms (legacy) và 79 ms (snapshot); mở 120 extract/giây vào đúng một tài khoản như vậy làm hàng đợi dài hàng chục giây ở cả hai bản, tức câu `history` (quét cửa sổ 30 ngày của tài khoản) mới là phần tốn kém và nó tăng theo số fact của tài khoản, không theo snapshot.

**Còn lại.** Chưa đo trên RDS: 120 extract/giây vào một tài khoản, nhiều consumer đồng thời, đối chiếu với pool và CPU RDS thật (BL-187).
