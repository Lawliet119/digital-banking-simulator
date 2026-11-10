# DBS-186 · Thu hồi phiên khi Redis mất dữ liệu hoặc dừng

> **Status:** Plan approved · **Vai:** Dev · **Cặp đôi review:** Dev khác · **Nhánh:** `codex/DBS-186-redis-revocation-drill` · **PR:** — · **Cập nhật:** 2026-11-10

## 1. Bối cảnh

Task Tuần 8, Medium, Demo 3, board To Do. Expect nguyên văn: «Thu hồi phiên vẫn đúng khi Redis mất dữ liệu.»

DoD nguyên văn:
1. Khóa tài khoản A rồi flush hoặc tắt Redis: request kế tiếp của A vẫn bị từ chối (đọc users.sessions_revoked_at)
2. Chạy cả hai kiểu: Redis chết và Redis bị flush (còn sống nhưng mất khóa); kết quả như nhau
3. Có test tự động và một lần chạy trên cloud; ghi vào bảng sự cố P4
4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ

AC-11.1 nguyên văn từ BRD: «Khách A đang đăng nhập, tài khoản `ACTIVE` | Nhân viên khóa tài khoản A | Yêu cầu kế tiếp của A bị từ chối (không chờ phiên hết hạn)».

Phụ thuộc DBS-114 và DBS-75 đều Done trên sheet. Main `478ab4c` có SessionRevocationCache, guard SQL fallback, publish sau commit và Terraform Valkey TLS. ADR-12 là tài liệu kiến trúc, không phải ticket phụ thuộc bị thiếu. [DBS-114](DBS-114-session-revocation.md) đã kiểm flush và dừng Redis trước lock; task này bổ sung đúng thứ tự lock → fault → next request và kiểm cùng giây/giây sau khi cache mất hoặc dừng.

Đã đọc BRD AC-11.1/NFR-SEC-02; docs/03 §6.2,9,11; ADR-06/12; CONTRIBUTING §5/5b; database-design users và event-contract AccountStatusChanged; README identity; các feature114/115 và source/fixture tương ứng. Baseline main478ab4c: Compose 3 services started; lint/typecheck đạt, unit98 suites1770/1770 (157.268s), e2e17 suites163/163 (154.151s); DB revocation-cache+boundary2 suites14/14 (37.023s), 0 skip.

Phạm vi: test hồi quy PG17/Valkey/HTTP/JWT thật; driver thủ công container riêng; bảng sự cố P4 có nhãn local/cloud rõ ràng. Không sửa production, schema, tiền, event, dependency hoặc env. Không flush Redis chung. Cloud chưa có CLI, biến AWS/Cognito/endpoint hoặc credentials profile trong phiên; giữ mục cloud là chưa chạy và bàn giao BL-220, không suy diễn local thành AWS acceptance. BL-221 (p95/drift/flaky114) ngoài phạm vi; BL-222 chỉ nhận kiểm boundary cache local, cloud vẫn mở. BL-132/103/195 không thuộc task này.

**G1 qua — agent tự quyết:** dependency/source/baseline xanh; nhận toàn bộ test local và P4, cloud chưa chạy không được nhận đạt (BL-220/222); không thay production vì existing fallback đã chứng minh. Đề nghị user đưa board sang In Progress, agent không sửa sheet.

## 2. Hành vi

Khách A có account ACTIVE và token còn hạn gọi `GET /v1/accounts` → 200. Operator gọi `POST /v1/operator/accounts/{id}/lock` với `{"reason":"CONFIRMED_FRAUD"}` → 200 LOCKED; SQL marker và Redis key tồn tại trước fault. Sau FLUSHDB trên Valkey riêng (PING vẫn PONG, key mất) hoặc dừng container Valkey riêng, request kế tiếp của A → 401, `errorCode=SESSION_REVOKED`, correlationId trong body khớp header. Không thử request A ở giữa fault và phép kiểm này.

SQL marker giữ nguyên giá trị timestamptz; instrument chỉ quan sát query thật của source API để xác nhận có SELECT sessions_revoked_at, không mock kết quả. Flush phải nạp lại key từ SQL. Khi down, user B không bị revoke vẫn 200, chứng minh API/PG còn hoạt động. Sau recovery, client API mới đọc Redis thật, A vẫn 401; unlock không phục hồi token cũ.

Boundary: đọc epoch giây từ SQL sau lock; token iat bằng marker bị 401 cả khi miss/down; token iat=marker+1 dùng được account còn ACTIVE của cùng user (mở account thứ hai trước lock), không xóa marker SQL. Thao tác mở/khóa/deposit đi qua API; không seed balance/ledger. Không đổi code xác thực hoặc phát hành token cloud.

Security: role operator, ownership/JWT/ProblemDetails dùng production modules của fixture114; không thêm endpoint; không ghi JWT/Authorization/credentials. Không thay SQL/role/TLS; cloud giữ Cognito và rediss thật. Các yêu cầu idempotency transfer, SQL input hostile và BR-13 response không đổi; checker 5 bất biến sau từng scenario.

## 3. Kiến trúc

Không thay symbol production hoặc exported fixture. Dùng `createSessionRevocationFixture()` → PG17, Valkey riêng, proxy TCP, production identity/accounts/ledger modules với actual LOGIN dbs_api. `f.fresh()`, `f.lock()`, `f.me()`, `f.marker()`, `f.stopRedis()`, `f.startRedis()`, `f.second()`, `f.invariants()` đã tồn tại. Admin FLUSHDB chỉ trên URL container riêng. `jest.spyOn(f.current().source,'query')` gọi nguyên hàm thật để đếm SQL fallback.

Luồng nhiều thành phần giữ nguyên sơ đồ ở [DBS-114 §3](DBS-114-session-revocation.md#3-kiến-trúc): JWT → guard → Redis, miss/error → users.sessions_revoked_at → 401. Lock transaction status/revoke/audit/outbox đã COMMIT trước fault. Test không thay transaction boundary, ADR hay event contract.

## 4. Test cases tự động

| ID | Truy vết | Lớp | Given / When / Then | errorCode |
|---|---|---|---|---|
| TC-186-01 | DoD1/2, AC-11.1 | PG17 + Valkey + HTTP | GET200, lock200/key có, FLUSHDB/PONG/keyNULL, next GET401; SELECT SQL thật, timestamp nguyên, refill đúng; userB200; invariantPASS | SESSION_REVOKED |
| TC-186-02 | DoD1/2, AC-11.1 | PG17 + Valkey + HTTP | GET200, lock200/key có, stop container thật, next GET401; SELECT SQL thật, timestamp nguyên; userB200; restart/new client Redis ready, A401/key đúng; invariantPASS | SESSION_REVOKED |
| TC-186-03 | BL-222, AC-11.1 | PG17 + Valkey + HTTP | Cho từng hit/flush/down: giữ A LOCKED, mở B cùng chủ trước lock; GET accountB iat bằng marker401, giây sau200/idB/ACTIVE; hit giây sau phải SELECT SQL; ép miss trước từng boundary ở mode flush; SQL không đổi; invariantPASS | SESSION_REVOKED / 200 |
| Quy trình | DoD3 | cloud | Cognito/ECS/RDS/ElastiCache TLS thật, lock→flush/down→401; lưu image SHA, SQL/checker, recovery và P4 | chưa chạy |
| Quy trình | DoD4 | CI/review | CI head PR, bảng case, Dev khác review/merge | chờ bàn giao |

## 5. Test thủ công

Chạy `node scripts/manual-dbs186.cjs` từ backend qua Git Bash, output tee UTF-8; dùng fixture tạo container riêng, JWT thật ký local. Không coi đây là full AppModule hoặc Cognito acceptance.

| Bước | Thao tác | Kỳ vọng |
|---|---|---|
| M-186-01 | Tạo fixture, xác nhận current_user/session_user dbs_api; fresh; GET accounts | 200, marker NULL, deposit HTTP 1000000, checker PASS |
| M-186-02 | Lock A; đọc SQL timestamp/key; FLUSHDB rồi PING và GET key; request A kế tiếp; user B | 200 LOCKED → PONG/keyNULL →401 SESSION_REVOKED + correlationId; SQL giữ nguyên/refill đúng; B200; PASS |
| M-186-03 | Fresh; GET200; lock A/key có; docker stop riêng; request A kế tiếp; B; startRedis/second | 401SQL/marker nguyên; B200; client mới ready/401/cache có; PASS; ghi thời gian recovery local |
| M-186-04 | Với hit, flush và down, giữ A LOCKED và B cùng chủ ACTIVE; lấy SQL giây, token bằng/giây sau gọi GET accountB; kiểm SQL | bằng401, giây sau200/idB/ACTIVE, A LOCKED, marker không đổi, PASS; kiểm unlock không hồi sinh phiên cũ riêng sau boundary |
| M-186-05 | Đóng mọi resource fixture trong finally | không để container/pool/proxy riêng còn chạy |
| M-186-06 | Cloud: ghi account/region/image SHA đã che ID, token Cognito A/B/operator; lock→flush/down trên môi trường drill riêng, query RDS/checker và khôi phục | cùng401, SQL không mất, recovery có thời gian; chưa chạy vì chưa có endpoint/credentials/môi trường cloud |

| M-186-07 | Chạy suite từ clean clone local của commit cuối code, dùng node_modules đã cài qua junction; chạy lại childprocess Docker context trỏ endpoint đóng, DATABASE_URL rỗng | clone suite PASS; Docker-unreachable exit khác0, lỗi rõ, 0 skip; không dừng daemon chung |

## 6. Domain review (AI)

Review vòng 1: subagent độc lập GPT-6 (model kế thừa), 0 blocking, 3 should-fix, verdict REVISE. Đã sửa: (1) TC03/M04 giữ A LOCKED, dùng accountB ACTIVE cùng chủ; (2) thêm boundary cache hit và SQL fallback cho token giây sau; (3) thêm M07 clean clone và Docker-unreachable. Review vòng 2: 0 findings, `Verdict: APPROVE`. Raw: [vòng1](screenshots/DBS-186/domain-review.md), [vòng2](screenshots/DBS-186/domain-review-r1.md). **G2 qua — agent tự quyết:** nhận cả ba đề xuất review; không đổi production/ADR; cloud và review/merge là quy trình chưa đạt, không nhận local thay cloud.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước / red | Lệnh chứng minh | Commit |
|---|---|---|---|---|
| 1 | `backend/test/db/redis-revocation-drill.db-spec.ts` | TC01/02/03 trước driver; production đã có nên không kỳ vọng bug-red. Negative control tạm thời vô hiệu hóa SQL fallback trong IdentityService rồi khôi phục nguyên byte (không commit) phải làm TC01/02 fail401→200; ghi output riêng. | `node node_modules/jest/bin/jest.js --config test/jest-db.js --runInBand --runTestsByPath test/db/redis-revocation-drill.db-spec.ts` | `test(identity): cover revocation after Redis flush and outage` |
| 2 | `backend/scripts/manual-dbs186.cjs` | Dựa TC đã green, driver assert HTTP/SQL/recovery thực; Docker unavailable phải fail, không bỏ qua. | Git Bash `node scripts/manual-dbs186.cjs` tee output UTF-8 trên commit cuối code; negative Docker qua DOCKER_HOST unreachable chỉ trong childprocess | `test(identity): add isolated Redis revocation drill driver` |
| 3 | Feature này; `docs/features/screenshots/DBS-186/{domain-review*.md,manual-test.txt,verification.txt,01-flush-down.png}`; `docs/deliverables/P4-incident-table.md`; deliverables README; feature index; BACKLOG | Đối chiếu TC/DoD; cloud và Dev review/merge phải ghi chưa đạt và backlog; không claim AWS. | full lint/typecheck/unit/e2e; DB drill+114+115; build; check-doc-links; diff/secret/skip scan | `docs(identity): record Redis revocation drill evidence and cloud handoff` |

Plan sweep: mọi DoD có TC hoặc quy trình và BL-220/222; limitations114/115 ghi phạm vi ở §1. Không động BL-221 p95/flaky, không sửa production ngoài mutation tạm có restore finally để kiểm độ nhạy. Rủi ro: flush/stop nhầm target được tránh bằng fixture tự sở hữu container; restore/close trong finally; clock boundary lấy SQL, token exp còn hạn; timestamp so sánh dạng SQL text để giữ microsecond. Lùi: revert các commit test/docs, không migration/data production. **G3 qua — agent tự quyết:** đã sweep DoD và limitations, không có mục bị bỏ sót; ghi rõ cloud/p95 ngoài local. Thực hiện test-only với mutation negative control trong finally, không giả bug production; clean clone/Docker failure là kiểm chứng harness. Mọi file thay đổi và evidence nằm trong bảng; không thêm dependency/env.

## 8. Kết quả

Chưa triển khai. Cloud chưa chạy; BL-220/222 giữ mở. Không merge hoặc sửa sheet.

## 9. Tài liệu đã cập nhật

Chờ handover.
