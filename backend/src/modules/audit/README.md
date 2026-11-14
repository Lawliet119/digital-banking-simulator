# audit 🟡 Supporting — #3

Nhật ký bất biến: ai làm gì, khi nào, trên đối tượng nào.

> **Status:** Implemented — schema, trigger, writer và API tra cứu; production role grants chưa triển khai · **Owner:** #3 · **Verified against code:** migration, `AuditService`, query/controller/module và các targeted PostgreSQL/HTTP tests; evidence bàn giao tại [DBS-56](../../../../docs/features/DBS-56-audit-service-record.md) và [DBS-103](../../../../docs/features/DBS-103-audit-search.md).

Migration `CreateAuditLog1792627200001` tạo [schema audit](../../../../docs/components/_shared/database-design.md#47-auditlog), actor nullable với FK `ON DELETE RESTRICT`, outcome CHECK và ba index truy vết. `down` chỉ cho phép transaction READ COMMITTED, khóa bảng rồi từ chối bằng SQLSTATE `55000` nếu có dữ liệu. [Bằng chứng DBS-26](../../../../docs/features/DBS-26-migration-audit-log.md#8-kết-quả) gồm CLI run/revert/run và tranh chấp khóa trên PostgreSQL thật.

Migration `AddAppendOnlyTriggers1792627200002` cung cấp hai trigger audit: UPDATE/DELETE theo hàng và TRUNCATE theo statement, cùng `public.forbid_mutation()` trả SQLSTATE `42501`. [DBS-27](../../../../docs/features/DBS-27-append-only-triggers.md) kiểm owner NOSUPERUSER, quyền thực và context RAISE; INSERT vẫn được phép. Revert27 gỡ trigger, giữ dữ liệu, nhưng bỏ lớp bảo vệ này.

`AuditService.record`/`recordDenied` ([DBS-56](../../../../docs/features/DBS-56-audit-service-record.md)) dùng `INSERT` SQL thuần, không `RETURNING` — chạy đúng dưới role chỉ có quyền INSERT (đã kiểm bằng role tạo tạm trong test, xem DBS-56 §3/§4). Thu quyền production (`dbs_api`, `dbs_worker`) và kiểm AC-8.1 đầy đủ với role đó còn chờ DBS-119.

|             |                                                                                               |
| ----------- | --------------------------------------------------------------------------------------------- |
| Use case    | UC-8 tra cứu cho kiểm toán viên · ghi nhật ký cho mọi thao tác thay đổi dữ liệu               |
| Chạy ở      | `AuditModule` (writer) dùng chung api/worker/both; `AuditHttpModule` (tra cứu UC-8) chỉ ở api/both |
| Sở hữu bảng | `audit_log` (chỉ INSERT và SELECT)                                                            |
| Thiết kế    | `docs/03` §8, §12 · `docs/BRD.md` BR-09                                                           |

## Phải giữ

- `AuditService.record(manager, { actor, role, action, outcome, target, correlationId, metadata })` được gọi **trong transaction của module gọi**, bằng chính `manager` đó. Không ghi được nhật ký (hoặc `metadata` sai định dạng) → cả transaction rollback (fail-closed, BR-09). **`record()` không bao giờ được `catch`** bên trong một callback của `TransactionService.run` — transaction đã bị Postgres abort (`25P02`); `catch` rồi tiếp tục khiến `COMMIT` âm thầm thành `ROLLBACK` mà `run()` vẫn resolve như thành công.
- `AuditService.recordDenied(input)` (không có `outcome`, luôn `DENIED`) dùng cho một lần bị từ chối phải để lại dấu vết dù lệnh gốc thất bại: tự mở transaction riêng, `record()` rồi tự `commit`. **Gọi nó ngoài mọi `TransactionService.run` khác** (trước `BEGIN` nghiệp vụ, hoặc sau khi transaction đó đã kết thúc) — không lồng bên trong một callback đang mở: giữ 2 connection, và một lần retry deadlock sẽ ghi trùng dòng. Nếu `recordDenied()` tự lỗi, để lỗi đó lan ra — không trả 404 "sạch" không có bằng chứng từ chối.
- `metadata` chỉ nhận `id`, `reason` (phải thuộc `ErrorCode` hoặc `AuditReason`, không phải câu tự do), `count` — `record()` tự kiểm ở runtime, không chỉ ở kiểu TypeScript. `action`, `role` và `target.type` là registry đóng ở compile time (`audit.registry.ts`: `AUDIT_ACTIONS`, `AUDIT_ACTOR_ROLES`, `AUDIT_TARGET_TYPES`; chỉ gồm giá trị đang được ghi, không đổi chuỗi đã lưu; cột DB vẫn là text mở): gõ sai là lỗi `tsc`, thêm giá trị mới thì thêm vào registry trước. `target.id` vẫn là chuỗi tự do — người gọi tự chịu trách nhiệm không nhồi PII vào đó.
- **Từ chối vai trò (403 của `RolesGuard`, BL-132):** `AuditService.recordRoleDenied({userId, roles, method, route, correlationId})` gọi `recordDenied` với `action = access.denied`, `target = {route, "<METHOD> <mẫu route>"}`, `actor_role` = mọi vai trò đã suy ra nối bằng dấu phẩy, `metadata.reason = NO_PERMISSION`. `AuditModule` cung cấp nó cho `RolesGuard` qua cổng `RoleDenialAudit` (định nghĩa ở identity). Fail-closed như mọi `recordDenied`: lỗi ghi lan ra thành 500/503, guard không trả 403 không có bằng chứng. Khác từ chối sở hữu (`NOT_OWNER`, action của thao tác bị thử, 404).
- Một consumer ghi `audit_log` **trong transaction của chính nó**, qua `AuditService.record` (ví dụ `risk` khi tạo cờ). Ma trận quyền production giới hạn `dbs_worker` ở INSERT trên bảng này; việc triển khai và chứng minh grants còn chờ DBS-119.
- **Action của một chuỗi giao dịch (DBS-135, AC-8.2)**, tất cả dưới `correlationId` của giao dịch: `transfer` (API), `notification.sent` (worker, một dòng mỗi event thông báo, `actor` NULL, metadata chỉ `count`, target `transfer` hoặc `account`), `fraud.flagged` (worker), `fraud_flag.view` (API, lượt operator xem chi tiết một cờ; metadata chỉ `{id}`; BL-226), `fraud_flag.review` (API; metadata `{reason, id}`). Với hai dòng `fraud_flag.*` của một cờ, `id` là mã request của chính lượt xem hoặc review đó (nối với log và header `X-Correlation-Id`). `audit.search` và `fraud_flag.search` dùng mã của request vì không gắn một giao dịch xác định.
- Ghi cả truy cập dữ liệu nhạy cảm và các lần bị từ chối quyền (qua `recordDenied`, trước khi trả dữ liệu).
- Revoke `UPDATE`/`DELETE` trên `audit_log` ở mức database.
- Kiểm toán viên chỉ đọc; chính việc tra cứu cũng được ghi.

## Export công khai (`index.ts`)

`AuditModule`, `AuditHttpModule`, `AuditService` (`record`, `recordDenied`, `recordRoleDenied`), `AuditOutcome`, `AuditTarget`, `AuditMetadata`, `AuditRecordInput`, `AuditReason`, `AuditMetadataError`, `AUDIT_ACTIONS`, `AUDIT_ACTOR_ROLES`, `AUDIT_TARGET_TYPES`, kiểu `AuditAction`, `AuditActorRole`, `AuditTargetType`.

`AuditSearchService` và parser/cursor/DTO là chi tiết của HTTP module, không export cho module khác. `AuditModule` không import `IdentityModule` (chỉ lấy token `RoleDenialAudit` và `ROLES` từ index của identity) hoặc đăng ký controller/query provider; worker vẫn ghi được qua writer mà không khởi tạo đường tra cứu.

## API tra cứu cho auditor

`GET /v1/audit/entries` dùng JWT guard toàn cục rồi `@Roles('auditor')`. Token chỉ có admin, operator hoặc customer nhận 403 `FORBIDDEN`; token có nhóm auditor cùng nhóm khác được phép. API không cung cấp mutation audit.

Các query tùy chọn là `actorUserId`, `action`, `from`, `to`, `correlationId`, `limit`, `cursor`. UUID chuẩn hóa chữ thường; action so khớp chính xác; khoảng UTC có cận `from` bao gồm và `to` loại trừ; limit mặc định 50, miền 1–100. Unknown/repeated/nested parameters hoặc cursor sai trả 400 với thông báo cố định, không thêm `errorCode`. Contract đầy đủ và ví dụ nằm tại [DBS-103 §2](../../../../docs/features/DBS-103-audit-search.md#2-hành-vi).

Response có `{ entries, nextCursor }` và `Cache-Control: no-store`. `id` là chuỗi bigint, `occurredAt` là UTC với sáu chữ số microsecond. Query SQL qualify `a.occurred_at` và `a.id` gốc trong ORDER/tuple cursor, không sắp theo alias `id` đã cast text. Cursor lấy dòng cuối thực sự trả, gắn SHA-256 của bộ lọc chuẩn hóa và cho phép đổi limit. Đây là live keyset, không phải snapshot xuyên request; dữ liệu commit muộn có thể cần tra lại từ đầu.

Mỗi request đúng token/vai/query, kể cả kết quả rỗng, mở một `TransactionService.run`: writer INSERT `audit.search/SUCCESS` trước, sau đó SELECT/map/cursor bằng cùng manager; chỉ resolve sau COMMIT. Actor là `CurrentUser.userId`, role cố định auditor, target `audit_search` mang correlation server, metadata `{}`. Không ghi bộ lọc/cursor/token/query vào audit hoặc log. INSERT/SELECT lỗi trước commit làm rollback; mất kết nối đúng lúc COMMIT có thể để lại trạng thái chưa xác định. 400/401/403 trước handler không ghi `audit.search`; global DENIED cho 403 vẫn thuộc BL-132.

OpenAPI tại `/docs` và `/docs-json` có schema thành công `application/json`, lỗi `application/problem+json`. [HTTP/PG tests](../../../../backend/test/db/audit-search.http.db-spec.ts) kiểm guard thật, bigint/microsecond, self-audit, SHARE-lock 503/recovery, 10 request đồng thời và worker isolation; [service PG tests](../../../../backend/test/db/audit-search.db-spec.ts) kiểm rollback SELECT 42501 và natural Index Scan của query thật trên ít nhất 50.000 dòng.

Production DB roles/full AC-8.1 chờ DBS-119; session revocation chưa có trong guard hiện tại và bàn giao DBS-114/186. Mutation route audit trả 404 vì không tồn tại; điều đó chưa chứng minh auditor bị chặn ở mọi API ghi nghiệp vụ sau này. [Manual evidence](../../../../docs/features/DBS-103-audit-search.md#8-kết-quả) gồm real curl/psql qua AppModule, trang precision/mixed-length, self-audit, SHARE-lock 503/recovery, natural Index Scan và cleanup. M05 chỉ đạt phần route audit; M09 production ACL chưa chạy. Session cleanup được observer SQL kiểm riêng; exit status và giới hạn của từng lượt manual nằm trong feature doc.
