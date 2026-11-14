# risk — Architecture

> **Trạng thái:** kiến trúc theo [ADR-14](../../adr/0014-fraud-rules-external-ai.md); nhánh triển khai này cần CI và Dev review trước merge. `rule_only` là mặc định; dữ liệu thật/egress AI chưa được cấp phép.

## 1. Cấu trúc

| Thành phần | Chạy ở | Trách nhiệm |
|---|---|---|
| `RiskWorkerModule`, `RiskScoringConsumer` | worker | Nhận `TransferCompleted` qua `risk-events`; dedup, chấm, lưu decision/cờ/audit; không chặn giao dịch đã hoàn tất |
| `ScoringService`, `rules/r1-*.ts` … `r6-*.ts` | worker/offline | Sáu luật thuần, tính baseline một lần; áp dụng weight AI theo cấu hình, không gọi I/O |
| `OnlineFeatureProvider`, `TransferFacts` | worker | 5 SELECT tới view `v_transfer_facts` trong một transaction `REPEATABLE READ READ ONLY` (một snapshot, một connection) theo event-time mili giây; R1/R5 dùng SQL aggregate thay cache theo thứ tự nhận event |
| `OfflineFeatureProvider` | offline | Trích đặc trưng trên snapshot fact tổng hợp bất biến; xuất cùng 11 trường qua mapper |
| `RuleSetRepository` | worker | Chọn version trong `risk_rule_sets`; Redis cache cấu hình, lỗi/miss đọc PostgreSQL |
| `RiskAiService`, `ai/openai-decisions.ts`, `AiGate` | worker | Với version AI hợp lệ: admission bền vững, gửi 11 trường cho OpenAI Decisions có timeout, lưu provenance/fallback |
| `FraudHttpModule`, `fraud-http.*` | api/both | List/detail/review cờ cho operator; audit fail-closed; không phục vụ customer |

UC-12 API tạo version chưa nằm trong phạm vi nhánh này. Không có pipeline tự train hoặc ONNX: phần này của ADR-08 đã được thay bằng ADR-14. Xem [DBS-128](../../features/DBS-128-offline-features.md), [DBS-129/130](../../features/DBS-129-130-fraud-operator-api.md), [RSK-02](../../features/RSK-02-durable-ai-gate.md).

## 2. Dữ liệu

### 2.1 Bảng sở hữu

| Đối tượng | Bất biến chính |
|---|---|
| `risk_rule_sets` | Version bất biến; cấu hình baseline R1–R6, thresholds, mode và khối `ai` tùy chọn; seed `rule_only` |
| `risk_decisions` | Tối đa một decision bất biến trên mỗi TRANSFER, kể cả LOW/fallback; lưu snapshot đã tối giản, trạng thái AI và provenance |
| `fraud_flags` | Một cờ khi score MEDIUM/HIGH; score là **tổng** rule + AI đã áp dụng; review một lần |
| `fraud_rule_hits` | Chỉ R1–R6 thực sự kích hoạt, giải thích tiếng Việt; có thể rỗng với AI-only và không nhất thiết cộng bằng score tổng |
| `ai_gate_policy`, `ai_gate_days`, `ai_gate_permits` | Policy và reservation dùng chung worker; không có policy mặc định, không refund reservation hay tự hết hạn permit |

### 2.2 Tương thích scoring

`rule_only` chỉ chạy sáu luật. `rules_with_external_ai` dùng cùng baseline, nếu AI thành công và xác suất đạt threshold của version thì cộng weight; AI không thay đổi hit luật. Config AI sai, thiếu key, provider lỗi hay quota không xóa kết quả rule. [Schema decision](../../features/RSK-01-risk-decisions-migration.md) và [gate](../../features/RSK-02-durable-ai-gate.md) mô tả ràng buộc cụ thể.

### 2.3 Truy cập và hiệu năng

Worker đọc `v_transfer_facts`, không cần đọc trực tiếp bảng chuyển tiền. Các cửa sổ dựa `occurredAt`; SQL aggregate tính fact đã commit, tránh kết quả phụ thuộc thứ tự delivery. Năm SELECT chung một snapshot (BL-187): commit đồng thời không làm feature lệch nhau. Đo cục bộ (không phải RDS) hot-account 18.000 fact: p95 khoảng 46 ms ở 20 extraction/s, xem [regression thứ tự](../../features/BUG-20261110-fraud-feature-order.md); chưa đo 120 extraction/s hay RDS. Redis chỉ cache cấu hình, không dùng để quyết định số lượng feature. Cursor API sắp xếp HIGH trước MEDIUM, thời gian rồi UUID giảm dần; chưa benchmark backlog lớn.

## 3. Interface công khai

### 3.1 Export qua `index.ts`

`RiskWorkerModule` chỉ được đưa vào worker/both; API review được đăng ký trong api/both. Không module tiền nào cần gọi trực tiếp `risk`: giao tiếp qua outbox và `risk-events`.

### 3.2 Sự kiện nhận vào (Queue `risk-events`)

Nhận `TransferCompleted`; chỉ chấm `TRANSFER`, không chấm `DEPOSIT`. Event không hợp lệ hoặc lỗi rule/feature được retry/DLQ theo consumer hiện hành.

### 3.3 Endpoint HTTP (chạy ở role `api`)

| Method và path | Vai trò | Hành vi |
|---|---|---|
| `GET /v1/operator/fraud-flags` | operator | Lọc `review_status`, `level`, phân trang cursor/limit; audit truy cập |
| `GET /v1/operator/fraud-flags/:transferId` | operator | Score tổng, hits, `aiAssessment` allowlist, tối đa 10 movement gần nhất của tài khoản nguồn; audit |
| `POST /v1/operator/fraud-flags/:transferId/review` | operator | `CONFIRMED_FRAUD` hoặc `FALSE_POSITIVE`, note tùy chọn; lần hai/đua thua → 409 `FLAG_ALREADY_REVIEWED` |

Customer, admin và auditor không được gọi ba endpoint này. `aiAssessment` null cho baseline; raw AI, snapshot, digest đầu vào, request ID và note không được trả. Không phát event review ở v1. Contract chi tiết: [DBS-129/130](../../features/DBS-129-130-fraud-operator-api.md).

## 4. Luồng nội bộ

### 4.1 Luồng chấm điểm bất đồng bộ tại Worker (UC-9)

```mermaid
sequenceDiagram
    participant L as Ledger / outbox
    participant Q as SQS risk-events
    participant W as Risk worker
    participant D as PostgreSQL
    participant A as OpenAI Decisions
    L->>Q: TransferCompleted
    Q->>W: TRANSFER
    W->>D: Dedup; version và features
    W->>W: R1–R6 và snapshot 11 trường
    opt Mode AI hợp lệ, egress và policy được phép
        W->>D: Xin reservation / permit
        W->>A: Đánh giá có timeout
        A-->>W: Xác suất hoặc lỗi
        W->>D: Nhả permit có giới hạn
    end
    W->>D: Transaction: claim decision, flag/hits/audit nếu cần
    W->>Q: Ack sau commit
```

Mỗi delivery có thể gọi AI, nhưng chỉ một decision thắng khi đua. Gọi ngoài transaction retry không bảo đảm exactly-once billing. Rule/feature lỗi không ghi decision, consumer retry; lỗi AI giữ baseline. Thiếu key/khối AI sai → `CONFIG_INVALID`; thiếu approval/policy hoặc gate lỗi → `UNAVAILABLE`.

### 4.2 Luồng nhân viên review cờ gian lận (UC-10)

`UPDATE ... WHERE review_status = 'OPEN'` và `AuditService.record` chạy trong cùng transaction. Cờ không tồn tại trả 404; cờ đã review hoặc request đua thua trả 409. Audit ghi actor và kết luận bằng reason cố định, không ghi note. Lỗi audit rollback review và không trả chi tiết.

## 5. Phụ thuộc

- Outbox/SQS chuyển sự kiện; identity xác thực và phân quyền; audit ghi trong transaction; ledger cung cấp truy vấn lịch sử chỉ đọc.
- PostgreSQL lưu facts, decision, cờ và quota; Redis cache cấu hình. Sự cố DB được retry/DLQ, Redis cấu hình lỗi đọc DB.
- Provider thật, secret, egress, ngân sách/alarm, quyền gửi dữ liệu và xác nhận điều khoản thuộc phối hợp Fraud, data owner và Platform & Ops; chưa mặc định bật. Không giả định ZDR hoặc ngừng tính phí khi client abort.

## 6. Phân quyền

API `dbs_api` chỉ đọc decision, facts và cờ, cập nhật các cột review được cấp; `dbs_worker` đọc facts qua view và ghi decision/cờ/hit/audit. Chỉ `dbs_worker` được EXECUTE hai hàm gate, không được truy cập bảng gate trực tiếp. Owner migration/policy tách biệt. Operator được xem/review; khách không thấy cờ.

## 7. Lỗi và sự cố

| Tình huống | Hành vi |
|---|---|
| Event trùng | Dedup sớm; database claim ngăn decision/cờ/audit trùng; có thể có nhiều lần gọi AI khi xử lý đồng thời |
| Rule hoặc truy vấn feature lỗi | Không ack hay commit decision; retry rồi DLQ theo cấu hình queue |
| Redis cấu hình lỗi | Đọc version/config từ PostgreSQL; feature vẫn đọc SQL |
| Provider lỗi/timeout/refusal/429 | Ghi trạng thái tương ứng và score baseline; không ghi body hay secret |
| Gate không khả dụng / hết quota | Không gọi provider; giữ baseline; reservation không tự hoàn |
| Review trùng / audit lỗi | 409 hoặc rollback fail-closed; không ghi đè kết luận |

Chưa có chứng cứ provider thật, chất lượng B0/B1/B2, 120 TPS hay alarm production; xem [backlog](../../BACKLOG.md) và [RSK-02](../../features/RSK-02-durable-ai-gate.md).
