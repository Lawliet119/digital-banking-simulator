# DBS-129 / DBS-130 · API fraud dành cho operator

> Trạng thái: đã triển khai và kiểm tra cục bộ; chờ CI, Dev review và merge. Vai: #4 Fraud.

## Phạm vi và thiết kế

Chỉ operator được gọi `GET /v1/operator/fraud-flags`, `GET /v1/operator/fraud-flags/:transferId` và `POST /v1/operator/fraud-flags/:transferId/review`. Module chỉ đăng ký cho api/both; JWT và phân quyền toàn cục không đổi. Customer, admin và auditor không được đọc hoặc suy ra sự tồn tại của flag. Review không khóa tài khoản hay phát outbox.

List nhận `review_status` (mặc định OPEN), `level` (HIGH/MEDIUM), `limit` 1–100 và cursor gắn bộ lọc. Thứ tự HIGH trước MEDIUM, thời gian giảm dần rồi UUID giảm dần. Cursor giữ sáu chữ số microsecond PostgreSQL và từ chối năm 0000 hoặc ngày không hợp lệ bằng 400. Cursor không ký, không cấp quyền và không bảo đảm snapshot khi có insert/review đồng thời.

Detail trả score tổng đã lưu, hits theo rule và `aiAssessment` giới hạn status, probability, model, rubric hash. AI-only có `hits: []`; baseline có `aiAssessment: null`. Không trả raw provider, feature snapshot, input digest, request ID, review note hoặc secret. Tối đa 10 movement gần nhất của tài khoản nguồn dùng `buildHistorySql` và `TransactionItemDto` từ ledger; đây chỉ là truy vấn đọc, không thay logic tiền.

List, detail và review ghi audit trong cùng transaction. Audit lỗi thì không trả dữ liệu; review rollback toàn bộ. Review chỉ cập nhật flag OPEN, lần hai hoặc thua tranh chấp trả 409 `FLAG_ALREADY_REVIEWED`; không có flag trả 404. Note giới hạn độ dài, không đưa vào audit/response. Migration cấp `dbs_api` duy nhất SELECT `v_transfer_facts`; SELECT `risk_decisions` và quyền cập nhật các cột review đã có. Script role giữ cùng grant khi chạy lại.

## Tự review quyết định

- Sắp xếp trực tiếp `risk_level` (HIGH trước MEDIUM) để mở đường dùng index hàng đợi hiện có; cursor vẫn giữ microsecond/UUID. Chưa có index phủ đủ mọi status và tie-breaker UUID, chưa benchmark backlog lớn. Tạo index mới trên bảng đang dùng phải làm `CONCURRENTLY` theo kế hoạch triển khai riêng; migration hiện chạy gộp trong transaction.
- Mở rộng không phá tương thích `AuditReason` với `FRAUD_FALSE_POSITIVE` (xác nhận gian lận dùng lại `CONFIRMED_FRAUD` đã có). Review giữ action `fraud_flag.review`, actor operator thật và map kết luận vào `metadata.reason`; không mở thêm key metadata hay ghi note. **Cập nhật DBS-135:** dòng `fraud_flag.review` mang `correlationId` của giao dịch gốc (lấy qua `transferCorrelationId` của module ledger) để AC-8.2 tra được cả bước review bằng một mã; mã của request review nằm ở `metadata.id` (key `id` đã có trong danh sách đóng của metadata guard). Cần bàn giao mở rộng enum cho owner audit.
- Reuse truy vấn lịch sử ledger qua export chính thức, không sao chép hay sửa quy tắc sổ cái. Không cấp quyền sửa score, xóa flag hoặc xóa decision cho API.
- Một lệnh UPDATE có điều kiện và audit cùng transaction bảo đảm chỉ một review thành công. Không hứa snapshot toàn trang khi dữ liệu đang đổi.

## Kiểm thử cục bộ

| Kiểm tra | Kết quả |
|---|---|
| Lint toàn backend và typecheck | Đạt |
| Unit audit metadata/types | 2 suite, 39 test đạt |
| PostgreSQL + HTTP + JWT thực, kể cả role `dbs_api` hạn chế | 1 suite, 14 test đạt, gồm OpenAPI ví dụ và mã lỗi |
| Manual với dữ liệu tổng hợp | Operator detail 200; customer 403; review 200 rồi 409; audit được commit |

Suite kiểm tra phân quyền, token hết hạn, cursor/microsecond, lọc trạng thái và mức rủi ro, lịch sử 10 movement, baseline/AI-only, lỗi audit rollback, review đồng thời và quyền DB. Fixture role tạo PostgreSQL riêng với mật khẩu ngẫu nhiên trong bộ nhớ, kiểm tra không thể UPDATE score hay DELETE flag/decision. Test và manual không gọi provider.

Lệnh từ `backend/`: `npm run lint:check`, `npm run typecheck`, `npm test -- --runInBand --runTestsByPath src/modules/audit/audit.types.spec.ts src/modules/audit/audit-metadata.guard.spec.ts`, `npm run test:db -- --runInBand --runTestsByPath test/db/fraud-operator-http.db-spec.ts`, `npx ts-node -r tsconfig-paths/register test/manual/fraud-operator.manual.ts` với `DATABASE_URL` trỏ PostgreSQL thử nghiệm.

## Giới hạn

Chưa có CI hay Dev review độc lập trên PR. Kết quả synthetic không chứng minh chất lượng AI. Việc triển khai, egress và sử dụng dữ liệu thật vẫn cần quyền của owner dữ liệu và Ops; mặc định vẫn `rule_only`.
