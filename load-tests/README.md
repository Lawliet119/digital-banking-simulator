# load-tests

## Demo 1 — chuyển chéo nhiều khách và tài khoản nóng

Cần Node 24, Docker Desktop đang chạy, dependency cài qua `npm --prefix backend ci`. Trong Git Bash từ `backend/`:

```bash
env -u DATABASE_URL npm run test:db -- --runInBand transfer-concurrency
```

TC-99-01…03 dùng 5 khách P1…P5 (mỗi người nạp 100.000 đồng qua deposit API) và khách H có 0 đồng. Mỗi round gửi một Promise.all thật gồm 25 chuyển chéo vòng P1→P2→…→P5→P1 và 25 chuyển từ P vào H, mỗi lệnh 1.000 đồng, key riêng. Chạy 10 round liên tiếp, không sleep và không retry response lỗi.

Mong đợi mỗi round đủ 50×201, 50 transferId khác nhau; delta transfer/ledger/audit/outbox/key là 50/100/50/50/50. Mỗi P giảm 5.000 và H tăng 25.000 đồng/round. Sau round10 mỗi P còn 50.000, H có 250.000. Checker sau từng round phải PASS, tổng Nợ=Có, balance toàn hệ thống 0, không khách âm và đủ cặp bút toán. Bất cứ 500/503, treo, số dư/count lệch đều là failure cần điều tra.

Test fixture dùng pool60, không thay cấu hình production. Unset DATABASE_URL chỉ trong process con ép Testcontainers PostgreSQL 17. Suite chạy trong job db CI sẵn, chứa đủ 10 round; chỉ ghi nhận CI đạt khi có run URL thật. Demo correctness không thay benchmark k6/NFR hay nghiệm thu AWS.

## Demo 2 — request trùng song song

Từ checkout sạch, Node 24 và Docker Desktop đang chạy, cài dependency bằng `npm --prefix backend ci`. Trong Git Bash, từ `backend/` chạy:

```bash
env -u DATABASE_URL npm run test:db -- --runInBand customer-transfers
```

TC-79-07/TC-97-01…03 nạp 1.000.000 đồng cho A qua deposit API, B bắt đầu 0. Mỗi trong 10 round gửi 10 request cùng key/cùng amount `1000` bằng Promise.all thật. Mong đợi 10×201 body giống nhau, chỉ một giao dịch và hai bút toán/round, một audit/outbox/key; replay không ghi thêm, đổi amount thành `2000` trả 422 IDEMPOTENCY_KEY_REUSED. Sau 10 round A còn 990.000, B có 10.000 đồng. Mỗi round in report checker PASS, tổng balance 0 và không violation. Không retry để làm xanh; dừng và điều tra mọi lỗi bất thường.

Suite dùng DB tạm PostgreSQL 17, giữ seed qua deposit API. Lệnh bỏ DATABASE_URL chỉ trong process con để ép Testcontainers. Đây là demo correctness local/CI, không thay báo cáo hiệu năng k6 hoặc nghiệm thu AWS. CI job db hiện hữu chạy file này, nên một CI run chạy đủ 10 round. Ghi link CI thật khi có PR được phép tạo.

## Năm kịch bản k6

> **Status:** Implemented (script và smoke local); chưa nghiệm thu NFR trên AWS. Dev viết script, Platform & Ops chạy tải cùng region. [Thiết kế và bằng chứng DBS-165](../docs/features/DBS-165-k6-scenarios.md).

| Kịch bản | Mục đích | Liên quan |
|---|---|---|
| `baseline` | 12 →60 →120 RPS, mỗi plateau15 phút, 80% đọc/20% chuyển, một HTTP request/iteration | Từng plateau: chuyển p95<300ms, p99<1s; từng loại đọc số dư/lịch sử p95<150ms |
| `hot-account` | 20 chuyển/giây, 15 phút, nguồn Minh Anh vào cùng CHECKING Hà | NFR-SCAL-02: p95<1s, mọi lệnh201 COMPLETED |
| `duplicate` | 1 burst/giây trong60s;10 POST song song cùng user/key/body, rồi đổi amount | AC-5.4: 10 response201 cùng JSON; đổi amount422 IDEMPOTENCY_KEY_REUSED; DB đúng1transfer/2entries mỗi burst |
| `stress` | 120/180/240 RPS, mỗi plateau5 phút, 80/20 | Giữ thresholds NFR để tìm điểm gãy, không tự nới ngưỡng |
| `rate-limit` | 11 chuyển trong một phút,101 GET trong phút mới, luân phiên2URL API | 10 chuyển201 rồi429;100 GET200 rồi429; RATE_LIMITED/problem+json/Retry-After1..60 |

Sau mỗi lần chạy phải kiểm tra bất biến: tổng Nợ = tổng Có, tổng số dư = 0, không tài khoản khách nào âm.

`run.cjs` tự gọi checker này sau mỗi run (kể cả run đỏ), ghi `invariants.txt` và in `invariantExit` (BL-127); chạy tay (ví dụ sau k6 chạy trực tiếp) từ checkout có devDependencies: `npm run --silent check:invariants` trong `backend/` với `DATABASE_URL` của môi trường vừa chạy tải. Phải nhận exit **0**; exit **1** kèm IDs vi phạm, exit **2** là lỗi chưa kiểm được. Giữ report và mã thoát cùng bằng chứng load run, không bỏ qua lỗi. Công cụ kiểm thêm từng balance khớp sổ và mỗi COMPLETED đủ cặp/đúng tiền/nguồn/đích; funding được âm nhưng vẫn tính vào tổng. [Cách dùng, quyền DB và giới hạn full scan](../backend/README.md#9-kiểm-tra-bất-biến-sổ-cái). Câu SQL riêng trả report, CLI mới ánh xạ kết quả thành exit code.

Kết quả chạy lưu ở `load-tests/results/` (không commit); số liệu tổng hợp đưa vào báo cáo P4.

### Chuẩn bị môi trường riêng

Cần Node24, devDependencies backend (`npm --prefix backend ci`), PostgreSQL17 đã migrate, API thật và [k6](https://grafana.com/docs/k6/latest/set-up/install-k6/) trên PATH hoặc `K6_BIN` trỏ executable. Đã smoke với k6v2.3.0, không thêm npm dependency.

Chỉ dùng DB/khách demo dành riêng, không có traffic khác. Runner đối chiếu owner/status account với token/fixture, kiểm số dư và ngân sách ngày200triệu. Duplicate kiểm delta toàn bảng transfers/ledger_entries và từng key của run. Dữ liệu do [DBS-70](../docs/features/DBS-70-seed-demo-data.md) tạo qua API; nạp bù CHECKING lên50triệu qua deposit API. Không sửa tiền bằng SQL. Dùng DB mới mỗi đợt đo: seed đọc số dư qua API trước mỗi bước và dừng với thông báo khi số dư CHECKING đã lệch kế hoạch (đã nạp bù hoặc đã chạy tải, BL-213), nên prepare không chạy lại được trên DB đã đo. Hết ngân sách thì dừng và tạo đợt mới.

Cho baseline/hot/duplicate/stress: nâng `RATE_LIMIT_REQUESTS_PER_IP_PER_MINUTE` và `RATE_LIMIT_TRANSFERS_PER_MINUTE` bằng env hiện có ở API chạy tải, đủ cho workload (ví dụ1000000). Giữ auth, ownership và giới hạn tiền. Đây là cấu hình tải ở docs/03 §12; phải ghi lại và khôi phục trước bài rate-limit. Trên cloud, Ops cần ngoại lệ WAF cho IP máy chạy tải.

Ví dụ Git Bash từ root, sau khi start API performance với local JWKS theo [DBS-53](../docs/features/DBS-53-local-test-auth-keys-tokens.md):

```bash
export NODE_ENV=development
export BASE_URL=http://127.0.0.1:3000
export DATABASE_URL='<URL DB tải riêng>'
export LOAD_DEDICATED=1
export AUTH_KEY_DIR="$PWD/backend/.auth-local"
node load-tests/run.cjs baseline --smoke
```

Runner tự seed nếu chưa có fixture. Local token dùng helper DBS-53, hạn4giờ, chỉ cho local; đặt ACCESS_TOKEN_TTL_SECONDS tương ứng nếu diễn tập thu hồi phiên. Fixture/token chỉ ở results (gitignore, quyền0600 khi OS hỗ trợ). Không bật K6_HTTP_DEBUG, không in/commit fixture. Có thể tái dùng bằng `LOAD_FIXTURE=/absolute/path/to/fixture.json` với cùng BASE_URL. Runner kiểm exp đủ toàn run+biên, số dư và ngân sách ngày.

`--smoke` giảm tải/thời lượng nhưng giữ thresholds và gắn profile smoke; không chứng minh120RPS/15phút. Bỏ cờ để dùng tải mặc định. Tất cả có checks=100%, lỗi hệ thống<0,1%; bài arrival-rate yêu cầu dropped_iterations=0. Loại422 nghiệp vụ và429 khỏi lỗi hệ thống theo BRD, nhưng vẫn làm bài performance đỏ vì không đúng đường thành công. Không retry. Ngưỡng latency tách từng plateau/route. k6 có thể bắt đầu iteration đúng biên cuối; preflight cộng biên ngân sách và hậu kiểm dùng số burst thực tế.

### Cognito và TLS

`LOAD_TOKENS_FILE` là file JSON riêng trong results: thuộc tính `operator` và `customers` (map nhãn `demo-customer-minh-anh`, `demo-customer-thu-ha`, `demo-customer-van-binh` sang token Cognito). Đây là nhãn kế hoạch seed, sub thật lấy từ token và đối chiếu ownerDB. Token phải còn hạn toàn run (baseline khoảng46phút+biên), runner không tự gia hạn Cognito.

Đặt NODE_ENV=staging, DATABASE_SSL=true, DATABASE_SSL_CA_PATH trỏ CA RDS, BASE_URL dùng HTTPS. Preflight và checker xác minh chứng chỉ, không tắt TLS. Máy chạy cần kết nối DB/checker và devDependencies; không đặt credential trong argv.

### Rate limit

API phải dùng mặc định10chuyển/phút/user và100request/phút/IP, Valkey hoạt động. API_URL_2 trỏ instance thứ hai dùng chung DB/Valkey; không có traffic khác từ IP k6 trong hai phút đo. Script đợi phút mới trước mỗi pha, không xóa Redis, không giả X-Forwarded-For và fail nếu pha vượt biên phút. Không truyền API_URL_2 thì chạy1instance, không gọi đó là bằng chứng2task. Hai URL khác nhau chưa tự chứng minh2process: Ops phải xác nhận tuyến/instance/proxy đúng trên cloud. Smoke driver khởi động2process AppModule thật. Redis down phải làm bài này đỏ vì limiter fail-open.

### Output và kiểm harness

Mỗi run có `results/<scenario>-<runId>/raw.json` (JSON Lines), summary.json và invariants.txt; fixture cũng ở đây nếu tự seed. Raw giữ status/method/name/scenario/expected_response và tag hữu hạn, không Authorization/token. Route name không chứa UUID. [Arrival-rate của k6](https://grafana.com/docs/k6/latest/using-k6/scenarios/) lập lịch theo iteration; script đọc/ghi có đúng1request mỗi iteration.

Runner luôn gọi checker sau seed/preflight/k6, kể cả bài đỏ. Chỉ exit0 khi bài và checker cùng đạt; checker exit1=vi phạm,2=không kiểm được. Nếu k6 không chạy hoặc cardinality sai thì runner vẫn đỏ dù checkerPASS. Giữ rawJSON, report, imageSHA và cấu hình cùng bằng chứng; runner không tự chứng nhận AWS.

Từ checkout sạch, Docker đang chạy:

```bash
node --test load-tests/test/*.test.mjs
cd backend
npm ci --ignore-scripts
node node_modules/@nestjs/cli/bin/nest.js build
node -r ts-node/register -r tsconfig-paths/register ../load-tests/test/smoke.cjs
```

Driver tự tạo PostgreSQL/Valkey và JWKS riêng, chạy đủ5bài qua AppModule thật (2process cho limiter), rồi thử API unreachable, dừng Valkey riêng và PostgreSQL riêng. Mọi ca âm phải fail rõ. Không dừng Docker daemon/container dùng chung. Thử DB ngừng hoạt động không thay thao tác tắt cả Docker Desktop; khi daemon không truy cập được, Testcontainers phải fail thay vì skip. Khóa tạm chỉ ở TEMP, không trong git.

Bộ dữ liệu tổng hợp [fraud-dataset/README.md](fraud-dataset/README.md) có CLI NORMAL tương thích DBS-71 và CLI mixed (8 kịch bản gian lận, 5 hard negatives), cùng inspector replay/summary. Dữ liệu này phục vụ đánh giá offline; chưa là bằng chứng load test hoặc scoring runtime. CLI DBS-127 sinh cohort khách70/30 độc lập, có verifier CSV offline; tune đã tạo để bàn giao, nhưng nơi lưu holdout riêng và xác nhận nhận/chạy offline của #4 còn thiếu (BL-171).
