# P4 · Bảng diễn tập sự cố

> **Status:** Draft · **Owner:** Dev / Platform & Ops · **Verified against code:** diễn tập local DBS-186; cloud chưa chạy

Mỗi dòng ghi môi trường và bằng chứng riêng. Kết quả container local không chứng minh Cognito, ECS, RDS hoặc ElastiCache trên AWS.

| Task / môi trường | Tác động chủ động | Phản ứng quan sát | Phục hồi | Bằng chứng / giới hạn |
|---|---|---|---|---|
| DBS-186 / local PG17, Valkey8, JWT local, actual role dbs_api; source `a6535dd` | Khách A GET200, operator khóa200 và cache có marker; FLUSHDB trên container riêng, PING=PONG, keyNULL | Request kế tiếp401 SESSION_REVOKED; SQL timestamp giữ microsecond; B200; audit/outbox khóa mỗi loại1; checker5 bất biếnPASS | Request bị từ chối nạp lại marker SQL vào Redis; không đo RTO của flush | [Feature và đối chiếu TC](../features/DBS-186-redis-revocation-drill.md), [output thô](../features/screenshots/DBS-186/manual-test.txt) |
| DBS-186 / cùng môi trường local | Khóa A200/key có rồi docker stop Valkey riêng | Request kế tiếp401 SESSION_REVOKED; B200; SQL marker nguyên; checkerPASS | docker start + ánh xạ lại cổng + API client mới ready + request401/cache có: **835 ms**, một lần chạy local, không phải SLO | Output như trên. Client mới dùng cho xác nhận phục hồi; không nhận là cùng connection tự reconnect hoặc full AppModule |
| DBS-186 / local boundary | Cache hit, FLUSHDB/miss, container down; A giữ LOCKED, accountB cùng chủ ACTIVE | iat bằng giây SQL401, giây sau200 trên đúng accountB; SQL marker nguyên, unlock sau boundary không phục hồi token cũ; checkerPASS | Không áp dụng đo RTO | Local claims điều khiển, không chứng minh clock/token issuance Cognito |
| DBS-186 / AWS | **Chưa chạy**: lock→flush/down qua Cognito/ECS/RDS/ElastiCache TLS | Chưa có kết quả | Chưa đo | User chỉ định chỉ chạy local; chưa có môi trường AWS. Thiếu AWS CLI/credentials và endpoint/runtime cloud; [BL-220/222](../BACKLOG.md). Ops chạy trong môi trường drill riêng, giữ TLS, lưu image SHA, SQL/invariant và thời gian recovery trước khi đóng DoD3 |
