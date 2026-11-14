# Demo giữa kỳ · Từ đăng ký tới tra `correlationId`

> **Status:** Draft (đã chạy local; cloud xem mục "Nhánh cloud" và [DBS-138 §8](../features/DBS-138-midterm-demo-script.md)) · **Owner:** Dev · **Nguồn:** [DBS-138](../features/DBS-138-midterm-demo-script.md) · **Cập nhật:** 2026-11-14

Một kịch bản duy nhất cho cả nhóm, chạy trọn luồng nghiệp vụ chính: khách đăng ký, mở tài khoản, được nạp tiền, chuyển một khoản lớn, hệ thống gắn cờ gian lận, nhân viên review, kiểm toán viên truy ra cả chuỗi bằng một mã. Mỗi bước có lệnh và kết quả mong đợi (đã thấy khi chạy thật). Các demo bắt buộc khác giữ ở [Demo 3](demo-3-failure-recovery.md) (lỗi và phục hồi) và [Demo 4](demo-4-security-audit.md) (an ninh và audit); kịch bản này nối các luồng đó lại cho buổi giữa kỳ.

| Bước | Nội dung | Vai | AC / tài liệu |
|---|---|---|---|
| 0 | Reset dữ liệu và seed | Dev | [backend/README §12](../../backend/README.md) (DBS-70) |
| 1 | Đăng ký (onboard khách) | Khách | UC-1, UC-2 |
| 2 | Mở tài khoản | Khách | UC-3 |
| 3 | Nạp tiền | Nhân viên | UC-4 |
| 4 | Chuyển tiền | Khách | UC-5, AC-5.x |
| 5 | Cờ gian lận xuất hiện | Nhân viên | UC-9, AC-9.1 |
| 6 | Khách không thấy cờ | Khách | AC-10.2 |
| 7 | Nhân viên review cờ (một lần) | Nhân viên | UC-10, `FLAG_ALREADY_REVIEWED` |
| 8 | Kiểm toán viên tra `correlationId` | Kiểm toán viên | UC-8, AC-8.2 |
| 9 | Ca từ chối: sai vai bị 403 và có nhật ký | Khách, kiểm toán viên | AC-8.1, FR-AUD-02 |

## Quy tắc khi quay

- **Token không bao giờ hiện trên màn hình.** Luôn gán vào biến (`X=$(…)`), không `echo "$X"`, không `set -x`, không `curl -v`, không dán token vào chat, ghi chú hay commit (cùng quy tắc với [demo-checklist](../runbooks/demo-checklist.md)). Token sống 15 phút: lấy lại bằng đúng lệnh ở bước 1 nếu quá hạn.
- **Dùng tên không dấu** trong thân JSON gửi bằng `curl -d` trên Windows (Git Bash): thân có dấu bị hỏng (tên lưu thành `Tr?n Van An`). Muốn tên có dấu thì ghi thân ra file và dùng `--data-binary @file`.
- **Ghi lại `C` ngay ở lần gọi chuyển tiền đầu tiên** (bước 4). Server sinh mã mới cho mỗi request: gửi lại cùng `Idempotency-Key` trả đúng kết quả cũ nhưng header `X-Correlation-Id` là mã mới, không có dòng audit nào mang mã đó.

## Chuẩn bị chung (local)

Từ thư mục gốc repo (cần Docker; `--wait` chờ cả ba dịch vụ khỏe rồi mới trả lại):

```bash
docker compose down -v && docker compose up -d --wait   # PostgreSQL 5432, Valkey 6379, ElasticMQ 9324
cd backend
npm install
cp env/.env.example env/.env.development                # bỏ chú thích AUTH_MODE=local và AUTH_LOCAL_JWKS_PATH=.auth-local/jwks.json
npm run auth:dev-keys                                    # chỉ lần đầu
npm run migration:run
```

Bật api và worker trong **một** process, nới giới hạn tốc độ để seed và kịch bản chạy liên tiếp (chi tiết ở [Demo 4, "Chuẩn bị chung"](demo-4-security-audit.md#chuẩn-bị-chung)):

```bash
RATE_LIMIT_TRANSFERS_PER_MINUTE=1000 RATE_LIMIT_REQUESTS_PER_IP_PER_MINUTE=10000 npm run start:dev   # APP_ROLE=both
```

Cổng 6379 bị chương trình khác chiếm thì `docker compose up` báo lỗi cổng: dừng chương trình đó, hoặc dùng một file override compose đổi cổng Valkey (`ports: !override ["6380:6379"]`) và đặt `REDIS_URL=redis://localhost:6380` cho api. Redis chết không làm hệ thống ngừng (trạng thái `degraded`), nhưng kịch bản sẽ khác Demo 3 phần D.

## Bước 0 · Reset dữ liệu và seed

Reset là dựng lại **cả ba dịch vụ**, không chỉ DB: ElasticMQ giữ message trong bộ nhớ và Valkey giữ bộ đếm tốc độ, nên chỉ xóa DB sẽ để message cũ trỏ vào giao dịch không còn. Lệnh `docker compose down -v && docker compose up -d --wait` ở phần chuẩn bị chính là reset; sau đó `migration:run` và bật lại api/worker.

```bash
npm run --silent seed          # tạo 3 khách, 4 tài khoản, 4 lệnh nạp, 2 lệnh chuyển, hoàn toàn qua API
npm run --silent seed          # chạy lần hai: không tạo trùng, số dư không đổi
npm run check:invariants       # sổ cái cân bằng
```

| Kiểm | Kết quả mong đợi |
|---|---|
| Bản tóm tắt seed lần 1 | Nguyễn Minh Anh: CHECKING 48.000.000 và SAVINGS 20.000.000; Trần Thu Hà: CHECKING 11.500.000; Nguyễn Văn Bình: CHECKING 5.500.000 VND; `Ledger invariant: … total ledger balance = 0` |
| Seed lần 2 | cùng số dư (mỗi lệnh nạp và chuyển chỉ gửi khi số dư chưa phản ánh bước đó) |
| `check:invariants` | `PASS` |

Seed dừng với mã thoát 1 nếu số dư nằm ngoài dãy kế hoạch (ai đó đã nạp hoặc chuyển thêm): khi đó reset lại như trên rồi seed. Các khách của seed (`demo-customer-*`) **không** dùng cho kịch bản bên dưới: An và Bình là hai khách mới để cờ gian lận xuất hiện đúng như mô tả.

## Bước 1–9 · Luồng chính

Đặt biến một lần (mỗi lần chạy lại dùng `RUN` mới để hai khách là người mới):

```bash
export API=http://localhost:3000
tok() { npm run --silent auth:dev-token -- --role "$1" ${2:+--sub "$2"}; }
field() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s)[process.argv[1]]))' "$1"; }
RUN=$(date +%s)
export AN=$(tok customer "demo-an-$RUN") BINH=$(tok customer "demo-binh-$RUN") OP=$(tok operator) AUD=$(tok auditor)
```

`--sub` **khác nhau** cho An và Bình là bắt buộc: thiếu thì cả hai là cùng một người (`dev-customer`), hai tài khoản cùng chủ và luật R5, R6 không áp dụng nên không có cờ.

### Bước 1 · Đăng ký

Onboard hai khách mới (lần đầu một token hợp lệ tạo bản ghi khách).

```bash
curl -sS -X POST $API/v1/customers/me -H "Authorization: Bearer $AN" -H 'Content-Type: application/json' -d '{"fullName":"Tran Van An"}'
curl -sS -X POST $API/v1/customers/me -H "Authorization: Bearer $BINH" -H 'Content-Type: application/json' -d '{"fullName":"Nguyen Thi Binh"}'
```

Mong đợi: 200 `{"id":"<uuid>","fullName":"Tran Van An","createdAt":"…"}` cho mỗi khách.

### Bước 2 · Mở tài khoản

```bash
AN_ACC=$(curl -sS -X POST $API/v1/accounts -H "Authorization: Bearer $AN" -H 'Content-Type: application/json' -d '{"type":"CHECKING"}' | field id)
BINH_ACC=$(curl -sS -X POST $API/v1/accounts -H "Authorization: Bearer $BINH" -H 'Content-Type: application/json' -d '{"type":"CHECKING"}' | field id)
echo "AN_ACC=$AN_ACC BINH_ACC=$BINH_ACC"
```

Mong đợi: hai mã tài khoản; mỗi tài khoản `status: "ACTIVE"`, `balance: "0"`.

### Bước 3 · Nạp tiền

```bash
curl -sS -X POST $API/v1/operator/deposits -H "Authorization: Bearer $OP" -H "Idempotency-Key: mid-dep-$RUN" -H 'Content-Type: application/json' -d "{\"toAccountId\":\"$AN_ACC\",\"amount\":\"21000000\"}"
```

Mong đợi: 201 `{"transferId":"<uuid>","status":"COMPLETED"}`.

### Bước 4 · Chuyển tiền (ghi `C` và `T`)

```bash
curl -sS -D /tmp/mid-h.txt -o /tmp/mid-b.json -X POST $API/v1/transfers -H "Authorization: Bearer $AN" -H "Idempotency-Key: mid-tr-$RUN" -H 'Content-Type: application/json' -d "{\"fromAccountId\":\"$AN_ACC\",\"toAccountId\":\"$BINH_ACC\",\"amount\":\"20000000\"}"
C=$(grep -i '^x-correlation-id' /tmp/mid-h.txt | tr -d '\r' | awk '{print $2}')
T=$(field transferId < /tmp/mid-b.json)
head -1 /tmp/mid-h.txt; cat /tmp/mid-b.json; echo; echo "C=$C T=$T"
```

Mong đợi: `HTTP/1.1 201 Created`; thân `{"transferId":"<T>","status":"COMPLETED"}`; `C` là một UUID. Số dư An còn 1.000.000.

### Bước 5 · Cờ gian lận xuất hiện

Chờ vài giây (worker chấm điểm sau khi nhận sự kiện), rồi nhân viên xem danh sách:

```bash
sleep 5
curl -sS $API/v1/operator/fraud-flags -H "Authorization: Bearer $OP"
```

Mong đợi: trong `items` có cờ với `transferId` bằng `T`, `score: 65`, `riskLevel: "MEDIUM"`, `reviewStatus: "OPEN"`, `ruleSetVersion: 1`. Danh sách chỉ có đúng một cờ sau khi reset; không reset thì có thêm cờ cũ, nên đọc cờ theo `transferId`.

Vì sao 65: tài khoản nguồn mở dưới 24 giờ chuyển trên 10 triệu (R3, 35) và chuyển ≥ 90% số dư (R6, 30); hai tài khoản khác chủ. Điểm 65 và `ruleSetVersion` 1 đúng với rule set seed của migration (`mode: rule_only`); quản trị đã tạo bản mới hoặc bật chế độ AI thì điểm có thể khác ([FRAUD-API-01](../features/FRAUD-API-01-external-ai-decision.md)).

### Bước 6 · Khách không thấy cờ

```bash
curl -sS $API/v1/transfers/$T -H "Authorization: Bearer $AN"
echo
curl -sS $API/v1/accounts/$AN_ACC/transactions -H "Authorization: Bearer $AN"
```

Mong đợi: 200 cho cả hai; thân **không** có `score`, `riskLevel`, `reviewStatus` hay bất kỳ trường nào về cờ (AC-10.2, BR-13).

### Bước 7 · Nhân viên review (chỉ một lần)

```bash
curl -sS $API/v1/operator/fraud-flags/$T -H "Authorization: Bearer $OP"
echo
curl -sS -X POST $API/v1/operator/fraud-flags/$T/review -H "Authorization: Bearer $OP" -H 'Content-Type: application/json' -d '{"decision":"CONFIRMED_FRAUD"}'
echo
curl -sS -X POST $API/v1/operator/fraud-flags/$T/review -H "Authorization: Bearer $OP" -H 'Content-Type: application/json' -d '{"decision":"CONFIRMED_FRAUD"}'
```

Mong đợi: lệnh đầu cho chi tiết cờ có `hits` R3 và R6 và `recentTransactions`; lệnh review đầu 200 `{"transferId":"<T>","reviewStatus":"CONFIRMED_FRAUD"}`; lệnh review thứ hai 409 `{"errorCode":"FLAG_ALREADY_REVIEWED",…}` và không đổi gì.

### Bước 8 · Kiểm toán viên tra `correlationId` (bấm giờ)

Mục tiêu: từ lúc auditor nhận `C` tới lúc thấy cả chuỗi dưới 5 phút (NFR-AUD-02).

```bash
curl -sS --get $API/v1/audit/entries -H "Authorization: Bearer $AUD" --data-urlencode "correlationId=$C" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const e of JSON.parse(s).entries)console.log(e.action,e.outcome,e.actorRole,e.correlationId===process.argv[1]?"=C":"≠C")})' "$C"
```

Mong đợi (mới nhất trước): `fraud_flag.review`, `fraud_flag.view`, `fraud.flagged`, `notification.sent`, `transfer`, đều `SUCCESS` và `=C`. `fraud_flag.view` chỉ có khi nhân viên đã mở chi tiết cờ (bước 7). Danh sách cờ (`fraud_flag.search`) và các lần tra của auditor (`audit.search`) mang mã của chính request đó nên **không** nằm trong chuỗi `C`. Đối chiếu từng dòng bằng Demo 4 phần E.

### Bước 9 · Ca từ chối

```bash
curl -sS -o /dev/null -w "khach xem co: %{http_code}\n" $API/v1/operator/fraud-flags -H "Authorization: Bearer $AN"
curl -sS -o /dev/null -w "auditor review: %{http_code}\n" -X POST $API/v1/operator/fraud-flags/$T/review -H "Authorization: Bearer $AUD" -H 'Content-Type: application/json' -d '{"decision":"CONFIRMED_FRAUD"}'
curl -sS --get $API/v1/audit/entries -H "Authorization: Bearer $AUD" --data-urlencode "action=access.denied"
```

Mong đợi: hai dòng `403`; lệnh cuối trả các dòng `access.denied` (lý do `NO_PERMISSION`) của hai lần vừa bị từ chối.

## Nhánh cloud

*(điền sau khi chạy phiên cloud ở DBS-138 M-138-13)*

## Checklist trước khi quay

- [ ] Reset sạch (bước 0), seed hai lần cho cùng số dư, `check:invariants` PASS.
- [ ] Chạy thử trọn bước 1–9 một lần trước giờ quay, trên đúng commit sẽ quay; mọi vấn đề gặp phải ghi thành issue hoặc dòng `docs/BACKLOG.md`.
- [ ] Token chưa quá 15 phút; màn hình không hiện dòng `Authorization` hay giá trị token.
- [ ] Reset lại ngay trước khi quay (An và Bình mới), vì cờ cũ làm danh sách ở bước 5 dài hơn.
- [ ] Cloud: làm theo [demo-checklist](../runbooks/demo-checklist.md) và nhớ `terraform destroy` + `verify-clean.sh` ngay sau khi quay.

## Kịch bản quay (thời lượng gợi ý, tổng ≈ 10 phút)

1. Mở màn (1 phút): nêu mục tiêu, bước 0 đã chuẩn bị sẵn.
2. Bước 1–4 (3 phút): đăng ký, mở tài khoản, nạp, chuyển. Dừng ở `C`: "đây là mã truy vết của giao dịch".
3. Bước 5–6 (2 phút): cờ xuất hiện ở phía nhân viên, khách không thấy gì.
4. Bước 7 (1 phút): review một lần, lần hai bị 409.
5. Bước 8 (2 phút): kiểm toán viên tra `C`, bấm giờ, thấy cả chuỗi.
6. Bước 9 (1 phút): ca từ chối và nhật ký.

## Giới hạn hiện tại

- Chưa có lần quay (DBS-140).
- 403 do `RolesGuard` đã ghi dòng `access.denied` (xem bước 9); [Demo 4](demo-4-security-audit.md) vẫn ghi giới hạn BL-132 ở phần D: cần đối chiếu và sửa ở đó (xem [DBS-138 §8](../features/DBS-138-midterm-demo-script.md)).
- Điểm 65 chỉ đúng với rule set seed (`rule_only`); không có AI trong kịch bản này.
