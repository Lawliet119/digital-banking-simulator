## Thay đổi gì

Task: DBS-78
Feature doc: docs/features/DBS-78-health-redis-degraded.md

`GET /health/ready` giữ PostgreSQL làm điều kiện sẵn sàng. PostgreSQL hoạt động nhưng Redis timeout/chết/breaker mở vẫn trả200, `status=ok`, `redis=degraded`; Redis PONG trả `redis=up`. PostgreSQL chết trả503. Liveness vẫn200 độc lập, endpoint public và không có prefix phiên bản.

Đã rebase riêng hai commit78 sau baseeb4ec89 lên main có DBS-76 PR52. Không chứa commit dependency cũ. Cập nhật RedisModule khởi tạo lazy và bắt đầu kết nối ở onModuleInit để lỗi bootstrap trước khi có context không giữ reconnect socket; shutdown và client tạo trực tiếp giữ hợp đồng cũ. Không đổi env/dependency/ADR/ErrorCode.

## Loại thay đổi

- [x] Tính năng mới
- [x] Hạ tầng / CI (thêm bước services test vào job e2e hiện có)
- [x] Tài liệu / ADR
- [x] Test

## Liên quan tới

DBS-76, ADR-12, docs03 §9.3/§13/§14: Redis không quyết định tính đúng của tiền và không được làm ALB loại task khi PostgreSQL vẫn ổn. Giữ nguyên sáu required check names.

## Đối chiếu test case

| DoD / yêu cầu | Test chứng minh | Khớp? |
|---|---|---|
| PG ổn/Redis chết hoặc chậm →200/degraded | TC-78-02 HTTP contract; TC-78-05 services với PostgreSQL17/Valkey thật, proxy delay250ms, dừng Valkey thật; M02/M04 | Khớp, không dùng mock làm bằng chứng outage |
| PG chết →không200 | TC-78-03 HTTP contract; services dừng PostgreSQL thật,503/database down; M05 | Khớp |
| E2e hai trường hợp | health.e2e-spec.ts và health-readiness.services-spec.ts; CI e2e có bước services riêng | Khớp; kết quả final CI ghi ở Checks |
| Không đổi liveness/path/không lộ secret | TC-78-04 public/version-neutral/live200; TC-78-02b non-PONG degraded, lỗi lập trình sanitized500 | Khớp |
| Lifecycle và regression Redis | Unit lazy connect, giữ client trực tiếp eager, bootstrap subprocess thực, services Redis hồi phục | Khớp; không tăng deadline để giấu leak |
| Swagger | TC-78-01 schema `redis=up/degraded`, giữ database info/details | Khớp |
| PR merge main/CI/Dev review | BL-163, main-based Draft PR và final Checks | Chờ CI thật, Dev khác review và merge |

## Kiểm tra

Local sau rebase: lint/typecheck/build đạt; full unit967/967 (60 suites), e2e148/148 (14 suites); readiness +Redis services7/7 với detectOpenHandles. Manual6/6 đạt trên tested HEAD b1341c8e9ffd4768c72da0ed6e729673f8cd3410 (source d0a7cd4); sau đó chỉ đổi docs/evidence. Full DB suite sẽ được chứng minh bằng CI, không suy ra từ các services test.

- [ ] CI xanh trên HEAD cuối — chỉ tích sau khi đủ6 job thành công
- [x] Test thủ công6/6 chạy lại trên commit sau rebase; output thật và ảnh tại docs/features/screenshots/DBS-78/
- [x] Có HTTP contract tests và services test dùng PostgreSQL/Valkey thật, không skip khi Docker lỗi
- [x] Không đổi schema/tiền/auth; không dừng Compose/cloud dùng chung; fixture tự dọn tài nguyên sở hữu
- [x] Không log token/Redis URL/credential/key; lỗi operational qua RedisUnavailableError
- [x] Feature doc1–9, review độc lập APPROVE và bảng test; user yêu cầu bỏ gate pauses, không nhận đã có human approvals
- [x] README/API/feature index/backlog được cập nhật, BL-163 chỉ theo dõi việc còn thiếu

## Ghi chú cho người review

Xem thứ tự PG check trước Redis và việc chỉ catch RedisUnavailableError; unexpected exception không bị chuyển thành false200. Controller dùng RedisClient public contract, không tạo raw ioredis khác và không thêm retry vòng ngoài.

Từ backend: `npm run test:e2e -- --runInBand --runTestsByPath test/health.e2e-spec.ts`; `npm run test:services -- --runInBand --detectOpenHandles --runTestsByPath test/services/health-readiness.services-spec.ts test/services/redis-adapter.services-spec.ts`; `node scripts/manual-dbs78.cjs`. Script dừng đúng container PG/Valkey fixture, không dừng Compose chung hoặc tài nguyên AWS.

Không có outage drill trên ALB/cloud trong scope; chỉ kiểm chứng HTTP trên app thật local và hợp đồng trả status cho health probe. Không coi AI review là Dev review trên GitHub. Agent không sửa sheet hoặc tự merge.
