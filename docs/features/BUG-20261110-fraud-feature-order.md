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

## Rủi ro vận hành còn lại

Mỗi extract chạy song song **5 SELECT độc lập**, không nằm trong decision transaction và không có chung snapshot. Commit đồng thời có thể được thấy khác nhau giữa feature; regression tuần tự không chứng minh snapshot nhất quán hay cạnh tranh. Không đổi transaction nghiệp vụ trong bản sửa này.

Tải DB tăng so với cache ấm; tại 120 lần extract/giây tương đương khoảng 600 feature SELECT/giây, chưa kể config/dedup/decision và retry. Đây là phép tính số lệnh, không phải benchmark. Chưa đo 120 TPS, hot-account, pool saturation hay SLO production. Cần owner/Ops chuẩn bị môi trường và đo trước rollout tải thật. Mặc định `rule_only` không đổi.
