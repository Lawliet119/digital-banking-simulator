# load-tests: Kết quả đo B2 (`rules_with_external_ai`), thời gian từ giao dịch tới cờ (2026-11-22)

> **Status:** Implemented (một phiên AWS thứ hai trong ngày, B2 đã đo ở 12/60/120 RPS với dữ liệu tổng hợp, đã dọn sạch) · **Owner:** Dev (đo thay Platform & Ops) · **Verified against code:** chạy thật trên AWS `ap-southeast-1` từ 15:29Z đến khi hủy ngày 2026-11-22 (đồng hồ UTC), image `27af44052e679616500c09f4a1c8ca9462985402` (build của workflow Image trên `main`), mọi số lấy từ PostgreSQL (`flag-latency.json`), k6, CloudWatch và bảng `ai_gate_*` của lượt thật · **Cập nhật:** 2026-11-22 · Thiết kế: [DBS-174](../../features/DBS-174-time-to-flag.md) · Báo cáo B0 cùng ngày: [06](06-ket-qua-thoi-gian-toi-co-2026-11-22.md) · Kết quả thô: [results/dbs174-b2-baseline](results/dbs174-b2-baseline/)

## 0. Tóm tắt

Đây là phần DoD 5 của DBS-174 («đo ở cả B0 và B2; ghi fallback, timeout, 429 và độ phủ AI»), chạy sau khi người dùng nạp khóa OpenAI và cho phép tạo secret ở Secrets Manager. Dữ liệu gửi sang OpenAI chỉ là **11 trường FeatureInput của dữ liệu tải tổng hợp** (không ID, tên, email), theo [RSK-05](../risk/04-ai-data-governance.md) (duyệt 2026-11-22; ZDR hay 30 ngày chưa chọn, egress chỉ bật trong state tạm và đã tắt trước khi hủy).

| Câu hỏi | Kết quả (B2, cờ ở mọi giao dịch như B0) |
|---|---|
| p95 tới cờ ở **12 RPS** | **3.744 ms** (< 5.000 ms, đạt); p50 1.427 ms, p99 5.525 ms, lớn nhất 8.443 ms. B0 cùng mức: 578 ms. Độ phủ AI 100% (2.160 `SUCCEEDED`) |
| p95 tới cờ ở **60 RPS** | **không hội tụ**: tải 12 giao dịch/giây vào, hệ thống xử lý ≈ 4,2 giao dịch/giây. Cuối 15 phút chỉ 8.318 trong 10.799 giao dịch có quyết định (p95 trên các giao dịch đã quyết định 1.216 giây). Trong 8.743 quyết định ra khi B2 còn bật: 392 `SUCCEEDED` (**độ phủ AI 4,5%**; 3,6% nếu tính cả 2.056 quyết định `DISABLED` ra sau khi tắt AI), 8.351 `UNAVAILABLE` (95,5%, fallback giữ điểm của luật). Số «p95 sau tháo hàng 1.335 giây» chỉ mô tả lượt này (phụ thuộc lúc tắt AI), không phải đặc tính ổn định |
| p95 tới cờ ở **120 RPS** | **không hội tụ**: không giao dịch nào của plateau có quyết định trong 15 phút (**21.600** giao dịch chưa có quyết định cuối plateau, 24.078 cả lượt; `undecidedAfterSettle` ghi 24.086 vì đợi 122 giây thêm); chỉ sau khi tắt AI mới được xử lý bằng `rule_only` (độ phủ AI 0%), p95 sau tháo hàng 1.187 giây: thời gian chờ trong backlog, không phải đặc tính của B2 |
| Nguyên nhân (hai giới hạn đồng thời, **chưa tách được**) | (1) **Consumer có trần ≈ 4,2 tin/giây ở B2**: mỗi lần nhận tối đa 10 tin và `processBatch` dùng `Promise.all` nên chờ tin chậm nhất trước khi nhận lô sau; mỗi tin qua cổng AI mất 1 đến 2,4 giây, nên 10 tin mỗi ≈ 2,35 giây. Dữ liệu: `risk_q_received` đứng ở 250 đến 260 tin mỗi phút (≈ 4,25/giây) từ 16:12Z dù tải 60 hay 120 RPS, và `risk_q_notvisible` = 10. `RISK_AI_CONCURRENCY=32` vì vậy không bao giờ dùng hết (≤ 10 yêu cầu đồng thời). (2) **CPU worker 0,25 vCPU bão hòa** (trung vị theo phút 99%, đỉnh 100%): relay, consumer, **hai kết nối PostgreSQL TLS mới cho mỗi lần chấm** (xin quota và trả quota) và một yêu cầu HTTPS. Ở B0 cùng consumer xử lý 24 tin/giây vì mỗi tin chỉ vài chục ms, nên giới hạn (1) chỉ lộ ra ở B2. Outbox cũng tồn đọng (tuổi lớn nhất **≥ 1.044 giây**, 995 giây ở điểm CloudWatch cuối): relay bị đói CPU |
| API đồng bộ | **không bị ảnh hưởng**: 0 lỗi, 0 dropped, p95 chuyển tiền phía k6 33 / 39 / 51 ms ở 12 / 60 / 120 RPS, CPU api đỉnh 31%, CPU RDS đỉnh 37%, invariant PASS (ADR-03: đường bất đồng bộ tách khỏi đường tiền) |
| Fallback, timeout, 429 | **Fallback** = `UNAVAILABLE`: 8.351 quyết định (95,5% quyết định B2 ở 60 RPS). **Timeout** nhà cung cấp (20 giây): không thấy (thời gian một lần gọi AI p99 ≤ 4.852 ms, lớn nhất 5.000 ms theo bucket). **429**: **không quan sát được**: lỗi HTTP của nhà cung cấp, hết cửa sổ nhận 1 giây và lỗi cổng đều thành `UNAVAILABLE` mà không ghi log hay metric riêng ([BL-443](../../BACKLOG.md)); DoD 5 vì vậy **đạt một phần** (fallback, timeout, độ phủ có số; 429 không). Có 10.901 lần quota được cấp nhưng chỉ 2.560 `SUCCEEDED`, tức ≈ 8.341 lần được cấp mà không ra kết quả. Khả năng cao nhất là **hết cửa sổ nhận 1 giây** (`ai_call_p50` ≈ 1.000 ms suốt 16:12 đến 16:43, đúng bằng `maxAdmissionDelayMs`; hạn của cổng 2.000 ms lớn hơn cửa sổ 1.000 ms nên quota cấp muộn vẫn bị trừ rồi trả lại), nhưng **chưa chứng minh** và 429 không loại trừ được |
| Tắt mềm AI | **hoạt động**: tạo phiên bản `rule_only` lúc 16:45:51Z (có hiệu lực sau ≤ 60 giây vì cache cấu hình); queue và outbox tháo hết lúc 16:57:06Z (**11 phút 15 giây**, ≈ 24.000 sự kiện, ≈ 36 sự kiện/giây so với ≈ 4,2/giây lúc B2), mọi quyết định sau đó là `DISABLED` |
| Chi phí OpenAI | 10.901 lần quota được cấp (gồm 5 lần smoke và 1 lần thử tay), 2.560 thành công: theo ước lượng ≈ 2,3 USD cho 43.000 giao dịch ở [09-freeze-rule-config](../risk/09-freeze-rule-config.md) thì **≈ 0,6 USD, cận trên theo số lần gọi** (giá giả định, chưa tính chênh token đầu ra); **chưa đối chiếu hóa đơn OpenAI**. Trần ngày đặt 40.000, dùng 10.901 |

**Kết luận trung thực.** Ở cấu hình hiện tại (worker 0,25 vCPU, consumer nhận tối đa 10 tin mỗi lô, cổng AI mở hai kết nối PostgreSQL mới mỗi lần) **B2 chỉ chạy được ở mức tải đã đo là 12 RPS**: p95 tới cờ 3,7 giây (p99 5,5 giây) và độ phủ AI 100%. Từ 60 RPS đường bất đồng bộ không hội tụ (xử lý ≈ 4,2 giao dịch/giây, vào 12 và 24 giao dịch/giây) và phải tắt AI; ngưỡng thật nằm giữa 12 và 60 RPS (≈ 21 RPS nếu trần 4,2 giao dịch/giây là đúng, **chưa đo**). Chưa biết nguyên nhân chính là CPU hay trần đồng thời của consumer: [BL-441](../../BACKLOG.md). Mọi số là **một lượt**, không có khoảng tin cậy.

## 1. Cấu hình đo

Như [06 §1](06-ket-qua-thoi-gian-toi-co-2026-11-22.md#1-cấu-hình-đo) (2 task api 0,5 vCPU, 1 worker 0,25 vCPU, RDS `db.t4g.small` Multi-AZ, Valkey 1+1, máy tải `t3.medium`, k6 v2.3.0, DB mới, fixture 3 khách, một lượt `baseline` 12→60→120 sau smoke). Khác:

| Hạng mục | Giá trị |
|---|---|
| Image | `27af44052e679616500c09f4a1c8ca9462985402`, build của workflow Image trên `main` (không build tay, không có tag nào để xóa) |
| Secret | `dbs/dev/openai-api-key` tạo bằng `terraform apply -target=aws_secretsmanager_secret.openai_api_key` ở `dev/base` (1 thêm, 1 sửa: mô tả KMS; hai alarm và sáu thay đổi khác của plan `base` **không** apply: [BL-409](../../BACKLOG.md)); khóa nạp bằng `put-secret-value` từ file cục bộ, không in ra; khóa và model `gpt-6-luna` kiểm bằng `GET /v1/models` trước khi dựng stack |
| Worker | `risk_ai_egress_approved=true` (state tạm), `RISK_AI_POLICY_REVISION=RSK-05-2026-11-22`, `RISK_AI_DAILY_REQUEST_CAP=40000`, `RISK_AI_CONCURRENCY=32`, `RISK_AI_GATE_TIMEOUT_MS=2000` (tổng kết nối PostgreSQL 2×10 + (10 + 32) + 5 = 67 ≤ 74) |
| Cấu hình luật | v2: luật v1, ngưỡng `medium` 30 / `high` 70 (cờ ở mọi giao dịch), `mode` `rules_with_external_ai`, khối `ai` của [v4-ai-r4.json](../../../backend/src/modules/risk/evaluation/configs/v4-ai-r4.json) (`gpt-6-luna`, `threshold` 0,65, `weight` 40, `requestTimeoutMs` 20.000, `maxAdmissionDelayMs` 1.000) → v3 `rule_only` (tắt mềm) lúc 16:45:51Z |
| Cổng AI | hàng `ai_gate_policy` **phải do Ops tạo** (xem §2): `(true, 'RSK-05-2026-11-22', 40000, 32)` |
| Smoke | lần 1: 6/6 `UNAVAILABLE` (chưa có hàng policy); lần 2 (sau khi tạo): 5/5 `SUCCEEDED`, p50 quyết định 1.062 ms |

## 2. Phát hiện cấu hình: hàng `ai_gate_policy` không do công cụ nào tạo

Worker dựng đúng (secret đọc được, log `Outbox relay started`, không có cảnh báo cấu hình) nhưng **mọi quyết định đều `UNAVAILABLE`**: `ai_gate_acquire` trả `unavailable` vì bảng `ai_gate_policy` trống (hàm cần một hàng singleton khớp revision, trần ngày và số đồng thời của worker), và cổng nuốt lỗi không log. Không script hay Terraform nào tạo hàng này ([RSK-02](../../features/RSK-02-durable-ai-gate.md): «Policy singleton do owner/Ops tạo»); tôi tạo bằng task master. Bằng chứng: [ai-gate-evidence.txt](results/dbs174-b2-baseline/ai-gate-evidence.txt). [BL-442](../../BACKLOG.md).

## 3. Kết quả

### 3.1 `baseline` B2: cuối lượt và sau khi tháo hết hàng đợi

«Cuối lượt» là `flag-latency.json` ngay sau k6 (đợi 122 giây); «sau tháo hàng» là lần chạy lại sau khi queue và outbox về 0 ([flag-latency-drained.json](results/dbs174-b2-baseline/flag-latency-drained.json)).

| Mức | Chuyển | Có quyết định cuối lượt | `SUCCEEDED` / `UNAVAILABLE` / `DISABLED` (sau tháo hàng) | qđ p50 / p95 / p99 / max cuối lượt (ms) | qđ p50 / p95 / p99 / max sau tháo hàng (ms) | **Cờ p95 sau tháo hàng (ms)** |
|---|---|---|---|---|---|---|
| 12 RPS | 2.160 | 2.160 | 2.160 / 0 / 0 | 1.418,7 / 3.727,2 / 5.515,8 / 8.356,2 | (như cột trước) | **3.743,6** |
| 60 RPS | 10.799 | 8.318 | 392 / 8.351 / 2.056 | 643.524,7 / 1.215.991,5 / 1.279.395,5 / 1.340.683,1 | 821.707,5 / 1.334.958,5 / 1.374.728,6 / 1.407.504,2 | **1.334.961,9** |
| 120 RPS | 21.600 | 0 | 0 / 0 / 21.600 | không có | 1.024.384,7 / 1.187.217,2 / 1.208.562,5 / 1.219.634,4 | **1.187.224,6** |
| Cả lượt | 34.561 | 10.483 | 2.553 / 8.351 / 23.657 | | 991.149,7 / 1.266.098,2 / 1.351.090,1 / 1.407.504,2 | |

Cả 34.561 giao dịch đều có quyết định và cờ sau khi tháo hàng (`backlog: false`; mọi giao dịch gắn cờ vì cấu hình v2/v3 ngưỡng 30 như B0). Cờ ghi cùng transaction với quyết định nên lệch vài ms.

### 3.2 Hàng đợi, outbox, worker và AI (cả lượt, 15:50Z đến 16:52Z)

| Chỉ số | Giá trị |
|---|---|
| CPU worker trung vị / lớn nhất theo phút | 99% / 100% (B0 ở 120 RPS: 89% / 95%); tin đang xử lý (`risk_q_notvisible`) luôn 10; nhận ≈ 255 tin/phút |
| Tuổi outbox chưa gửi lớn nhất | **995 giây** ở điểm CloudWatch cuối (16:44Z) và **1.044 giây** ở lần đo tay lúc 16:47Z (B0: 1,73 giây): relay cũng bị đói CPU |
| Queue risk: độ sâu lớn nhất / tuổi tin cũ nhất | 4.218 tin / 810 giây; DLQ 0; cách ly 0 |
| `NumberOfMessagesSent` / `Received` trong lượt | 14.837 / 10.528 (cuối cửa sổ xuất; phần còn lại sau tháo hàng) |
| Thời gian một lần gọi AI (cổng + nhà cung cấp, bucket) | p50 1.000 ms (trung vị theo phút), p95 ≤ 1.996 ms, p99 lớn nhất 4.852 ms, lớn nhất 5.000 ms |
| Quyết định theo `AiStatus` (CloudWatch) | `SUCCEEDED` 2.548, `UNAVAILABLE` 8.040 (dừng ở điểm 16:44Z, thấp hơn 8.351 của DB vì phần ra sau đó); không có `REFUSED`, `INVALID_RESPONSE`, `BUDGET_EXHAUSTED`, `CONFIG_INVALID` |
| Cổng | 10.901 lần quota được cấp (`ai_gate_days.requests`, gồm 5 lần smoke và 1 lần thử tay không trả), 27 permit còn treo (`released_at IS NULL`; gồm lần thử tay): quota ngày đã trừ lúc cấp, permit treo chiếm chỗ đồng thời cho tới hết TTL; không hoàn |
| k6 | 0 lỗi, 0 dropped, `meetsDoD3` đạt ở cả ba plateau; `invariantExit` 0 |

Cơ chế: ở 12 RPS còn đủ chỗ (B0: CPU worker 16%; B2 vẫn đạt p95 3,7 giây); từ 60 RPS tải (12 giao dịch/giây) vượt trần ≈ 4,2 giao dịch/giây của consumer ở B2 và CPU worker chạm 100%, hai giới hạn không tách được từ một lượt. Hệ quả: hết cửa sổ nhận 1 giây thì quyết định rơi về `UNAVAILABLE` mà vẫn tốn một lần chấm; mỗi yêu cầu đã cấp quota nhưng hỏng (≈ 8.341) cũng tốn quota. Cổng mở **hai** kết nối PostgreSQL mới mỗi lần (một để xin, một để trả quota), kết nối trả quota không nằm trong ngân sách kết nối ở §1; `rds_conn` lớn nhất 40.

## 4. So với B0 (cùng cấu hình luật, cùng DB mới)

| Mức | B0 p95 tới cờ ([06 §3.1](06-ket-qua-thoi-gian-toi-co-2026-11-22.md#31-baseline-trên-db-mới-cờ-ở-mọi-giao-dịch-dod-1-của-dbs-174)) | B2 p95 tới cờ | Chênh |
|---|---|---|---|
| 12 RPS | 578 ms | 3.744 ms | +3.166 ms: một lần gọi AI (cổng + nhà cung cấp) ≈ 0,5 đến 1 giây (p50 520 ms, p95 ≤ 1.040 ms); phần còn lại ≈ 2 giây là chờ queue và lô (queue có lúc tồn tới 11 giây), **chưa tách** |
| 60 RPS | 828 ms | không hội tụ (xử lý ≈ 4,2/giây so với 12/giây vào) | không so sánh được |
| 120 RPS | 2.009 ms | không hội tụ (xử lý ≈ 4,2/giây so với 24/giây vào) | không so sánh được |

## 5. Giới hạn

1. **Một lượt, không có khoảng tin cậy**, ba khách, một IP nguồn; cờ ở mọi giao dịch (trường hợp xấu nhất của worker) như B0. Dữ liệu tổng hợp: B2 chưa đo trên dữ liệu thật và độ chính xác của AI không được đánh giá ở đây (DBS-169 và đánh giá offline).
2. **Hàng đợi tồn đọng làm các mức sau bị nhiễu bởi mức trước và hai mức 60, 120 RPS không có trạng thái ổn định**: tải vào 12 và 24 giao dịch/giây vượt xa ≈ 4,2/giây xử lý được, nên p95 «sau tháo hàng» (1.335 và 1.187 giây) phụ thuộc lúc người vận hành tắt AI (16:45:51Z) và tốc độ tháo hàng, và với 60 RPS còn gồm 2.056 giao dịch xử lý bằng `rule_only`. Hai số này chỉ mô tả lượt này; kết luận đúng là «không hội tụ». Đo B2 ở 60 và 120 RPS cần hệ thống xử lý nổi tải (BL-441).
3. **Độ phủ AI ở 60 RPS bị chia hai phần**: 8.743 quyết định ra khi B2 còn bật (392 `SUCCEEDED`, 8.351 `UNAVAILABLE`; cuối lượt mới thấy 8.318 trong số đó, vì 425 quyết định ra sau ảnh chụp cuối lượt, trong ≤ 60 giây cache cấu hình) và 2.056 xử lý sau khi tắt AI (`DISABLED`). Độ phủ 4,5% tính trên 8.743; 3,6% tính trên 10.799.
4. **Không tách được nguyên nhân `UNAVAILABLE`** (lỗi HTTP gồm 429, hết cửa sổ nhận, lỗi cổng): BL-443. Không thấy timeout 20 giây (không có bucket nào > 5.000 ms), nhưng không loại trừ các lần hủy khác. **Không tách được giới hạn của consumer khỏi giới hạn CPU** (§0): chỉ một lượt, cùng một cỡ worker.
5. Chi phí là ước lượng từ báo cáo capture (cận trên theo số lần gọi), chưa đối chiếu hóa đơn OpenAI; metric `risk_ai_call_duration_ms` lượng tử hóa theo bucket ([BL-440](../../BACKLOG.md)).
6. Số «gửi/nhận» ở §3.2 chỉ phủ tới điểm CloudWatch cuối của lần xuất (16:44Z; SQS phát mỗi phút nhưng lần xuất dừng ở đó), phần còn lại được xử lý sau tháo hàng (xem `drain-after-rule-only.txt`: tuổi outbox còn 1.044 giây lúc 16:47Z).

## 6. Dọn dẹp và bằng chứng

| Bước | Kết quả |
|---|---|
| Tắt egress AI (`risk_ai_egress_approved=false`) trước khi hủy | `Apply complete! 1 added, 0 changed, 2 destroyed` (16:57Z); task definition worker chỉ còn `secrets` `DB_USER`, `DB_PASSWORD`, `REDIS_AUTH_TOKEN` (không còn `OPENAI_API_KEY`) |
| `terraform destroy` `session` | `Destroy complete! Resources: 66 destroyed`, thoát 0 (16:58Z đến 17:05Z) |
| `terraform destroy` `loadgen` | `Destroy complete! Resources: 14 destroyed`, thoát 0 |
| `infra/scripts/verify-clean.sh` | thoát 0, `KET LUAN: sạch (13 loại)` |
| Cognito | `list-user-pool-clients` chỉ còn `dbs-app` |
| `terraform plan` của `base` | **2 thêm (hai alarm DLQ), 6 sửa** (SSE-KMS 4 hàng đợi, `worker_sqs`, `cognito_seeder`): đúng phần còn lại của [BL-409](../../BACKLOG.md) sau khi secret và mô tả KMS đã apply riêng |
| State tạm | `dev/loadgen-dbs174b2.tfstate` và `dev/session-dbs174b2.tfstate` đã xóa; `base.tfstate` có thêm secret `openai_api_key` (cố ý) |
| ECR `dbs-api` | không build tay nên không có tag nào để xóa |
| Token | xóa khỏi bucket ngay sau `prepare` và khỏi máy vận hành (`shred`); bucket tải hủy cùng stack |
| **Secret OpenAI** | **còn lại ở `base`** (`dbs/dev/openai-api-key`, đã nạp khóa, KMS CMK dùng chung; ≈ 0,4 USD/tháng): để chạy lại B2 sau BL-441. Muốn xóa: `aws secretsmanager delete-secret --secret-id dbs/dev/openai-api-key --force-delete-without-recovery` rồi bỏ khỏi state bằng `terraform apply`; khóa gốc vẫn ở `backend/env/.env.openai` (gitignore) |
| Thời gian và chi phí | stack sống 15:29Z đến 17:06Z (1 giờ 37 phút); ≈ 0,5 USD/giờ ⇒ ≈ 0,8 USD, cộng tín dụng CPU RDS vượt (nhỏ) và OpenAI ≈ 0,6 USD (cận trên); **ước lượng, chưa đối chiếu hóa đơn** |

## 7. Kết quả thô

[results/dbs174-b2-baseline](results/dbs174-b2-baseline/): `aggregate.json`, `per-minute.json`, `summary.json`, `exit.json` (`runExit` 0, `invariantExit` 0, `flagLatencyExit` 1: còn 24.078 giao dịch chưa có quyết định lúc kết thúc lượt, đúng như ghi ở §3.1), `invariants.txt`, `requests.csv.gz`, `raw.json.sha256` và `.size` (`raw.json` không commit), `cloudwatch.json`, `flag-latency.json` (cuối lượt), `flag-latency-drained.json` (sau tháo hàng), `drain-after-rule-only.txt` (độ sâu queue và tuổi outbox mỗi 40 giây sau khi tắt AI), `ai-gate-evidence.txt`. `run.log` không commit (tên miền ALB).
