# ADR-14: Fraud giữ sáu luật, dùng API AI bổ sung, không tự train model

| | |
|---|---|
| Trạng thái | **Proposed** — chưa thay thế quyết định Accepted của nhóm, chưa có implementation hoặc benchmark API |
| Ngày | 2026-10-23 (cập nhật 2026-10-25, vòng sửa 2 của FRAUD-API-01) |
| Người viết | Fraud |
| Người duyệt | Chờ một Dev và nhóm xác nhận |
| Quan hệ | Đề xuất thay phần học tham số `v2` và ONNX `v3` của [ADR-08](0008-fraud-detection-architecture.md); ADR-08 vẫn Accepted cho tới khi nhóm chấp nhận thay thế |
| Liên quan | D-4, UC-9/10/12, BR-11/13, AC-9.1/9.2/10.1/10.2, NFR-FRD-01…03; [ADR-03](0003-sync-transfer-async-outbox-sqs.md), [ADR-10](0010-fargate-egress-public-subnet.md), [ADR-13](0013-one-app-app-role.md) |

## Bối cảnh

Fraud cần phát hiện giao dịch đáng ngờ sau commit mà không tác động đường chuyển tiền. Phương án tự train và đóng gói model trong ADR-08 phát sinh pipeline Python, artifact, runtime native, kiểm tra tương thích image và quy trình cập nhật model. Nhóm muốn giảm phần vận hành ML bằng một dịch vụ đánh giá pretrained, nhưng không được đánh đổi tính đúng của luồng tiền, khả năng audit hoặc đánh giá độc lập.

Đây là thay đổi kiến trúc, không phải đổi tên công việc ONNX thành gọi API. Không train vẫn phải có dữ liệu tune/validation/holdout để đo báo nhầm và bỏ sót. Chưa có bằng chứng API tốt hơn rules hoặc model tự train; kết quả no-go là hợp lệ.

## Các phương án

| Tiêu chí | A. Chỉ R1–R6 | B. Tự train và host model | C. R1–R6 + API AI bổ sung |
|---|---|---|---|
| Tính đúng, giải thích | Luật thuần và số liệu cụ thể | Cần kiểm model, attribution và artifact | Luật giữ nguyên; tín hiệu API có provenance riêng, không giả thành luật |
| Vận hành | Không thêm dependency bên ngoài | Thêm pipeline train/export, model trong image | Không train hoặc artifact; thêm secret, egress, quota, timeout và chi phí API |
| Khả năng cải thiện chất lượng | Baseline để đối chiếu | Phải đo trên dữ liệu độc lập | Cũng phải đo; typed probability không chứng minh độ chính xác |
| Khi thành phần AI lỗi | Không áp dụng | Fallback rules theo thiết kế cũ | Commit baseline, ghi trạng thái AI; không chặn chuyển tiền |
| Dữ liệu | Lưu trong hệ thống | Có thể xử lý trong hạ tầng nhóm | Feature đi tới bên thứ ba; phải duyệt quyền gửi và điều kiện dịch vụ |

## Quyết định đề xuất

Chọn **C có gate**, đồng thời giữ **A là mặc định và đường vận hành độc lập**. Không tự train/fine-tune model, không thêm Python inference service, `.onnx`, `onnxruntime-node` hoặc alias mode cũ vào implementation của phương án này. Chọn ngưỡng/rubric/trọng số thủ công trên tune vẫn là lựa chọn tham số dựa trên dữ liệu và phải báo cáo, không phải bằng chứng model đã được calibration.

Nhà cung cấp đầu tiên là [OpenAI Decisions](https://developers.openai.com/api/docs/guides/decisions), endpoint `POST /v1/decisions`, model guide công bố là `gpt-6-luna`. Theo guide hiện hành (đọc 2026-10-25, người dùng cần xác nhận lại bằng mắt trước khi dựa vào): API đã GA sau giai đoạn beta; `gpt-6-luna` là model duy nhất đang được hỗ trợ; hỗ trợ ZDR/HIPAA cho khách hàng đủ điều kiện (điều kiện ở trang data controls); giá input $0,10 mỗi 1M token, output không tính phí; tối đa 400 câu hỏi mỗi request. Chưa có benchmark fraud của nhóm. Jev là lựa chọn có thể đối chiếu trong nghiên cứu, không tích hợp thêm adapter hoặc tự chuyển provider khi lỗi. Không hứa model alias là snapshot bất biến.

### Ranh giới giữ nguyên

- Chỉ chấm `TransferCompleted.type=TRANSFER`; DEPOSIT được consumer ghi dedup rồi bỏ qua. Event payload, outbox routing và queue không đổi.
- Sáu luật là hàm thuần; FeatureProvider chịu I/O. Mốc là `occurredAt`, R3/R6 dùng snapshot; `sameOwner` chỉ miễn R5/R6. Redis là cache SQL, không phải nguồn sự thật thứ hai.
- API chỉ được gọi trong risk worker, sau giao dịch chuyển tiền đã commit và ngoài callback transaction có retry. Không sửa ledger, số dư, sync guard hoặc quyền customer.
- Chỉ gắn cờ và operator review; không tự khóa, giữ tiền hoặc đảo giao dịch. Customer không thấy cờ, assessment hoặc lý do risk.

### Điểm và nguồn quyết định

Hai mode cấu hình bất biến là `rule_only` và `rules_with_external_ai`. Seed là rule-only; AI chỉ bật khi đủ gate dưới đây. Khi bật, provider/model/rubric, threshold, weight và giới hạn vận hành phải được xác nhận; không lấy ví dụ trong tài liệu làm default production.

`ruleScore = sum(ruleHits.weight)`. Nếu typed predicate `needs_operator_review` hợp lệ và `p >= ai.threshold`, `aiContribution = ai.weight`; các trường hợp khác contribution=0. `score = ruleScore + aiContribution`. Trọng số nguyên không âm, threshold hữu hạn trong `(0,1]`, tổng điểm không vượt PostgreSQL int. Không lấy `100*p` làm score. AI không trừ điểm hoặc hủy cờ baseline. Ngưỡng v1 vẫn LOW dưới 40, MEDIUM 40–69 và HIGH từ 70.

Rule hits chỉ chứa R1–R6. Phần AI hiển thị riêng trong `aiAssessment`; baseline trả null. `score` là tổng chuẩn, không yêu cầu client tự cộng riêng hits thành total. Lời giải thích AI là thông báo có nguồn/model/ngưỡng và số liệu feature, không được mô tả là suy luận nhân quả của model hoặc kết luận chắc chắn có gian lận. Cờ AI-only có thể không có rule hit; không tạo hit R1–R6 giả.

### Quyết định bất biến và transaction

Thiết kế đích thêm bảng risk-owned `risk_decisions`, một hàng cho **mọi TRANSFER ở cả hai mode**, kể cả LOW/fallback. Khóa theo `transfer_id` giữ quyết định commit đầu tiên, không chỉ eventId. Schema đề xuất và quyền nằm ở [phụ lục §3.8 của hồ sơ FRAUD-API-01](../features/FRAUD-API-01-external-ai-decision.md#38-phụ-lục-schema-đề-xuất-bảng-quyết-định-risk-proposed-chưa-có-migration); schema baseline Accepted ở [database-design §4.8](../components/_shared/database-design.md#48-nhóm-fraud) giữ nguyên cho tới khi nhóm chấp nhận ADR này. Tài liệu này không tạo migration.

Trước scoring/API kiểm event dedup và decision đã commit. Nếu transfer đã có decision thì dùng kết quả cũ, chỉ ghi dedup cho event mới nếu cần. Không đổi decision khi cấu hình/model thay đổi. Trong cùng transaction: claim `processed_events`, claim decision theo transfer, bên thắng ghi decision, cờ/hits nếu đủ điểm và audit tạo cờ; bên thua không tạo cờ/audit-create trùng. Quyết định LOW hoặc fallback không ghi audit (xem mục «Thay đổi yêu cầu và tác động cần nhóm duyệt»). SQL/audit lỗi thì rollback, không ack. Ack chỉ sau commit.

Hai worker đua trước commit hoặc một lần rollback có thể gọi provider nhiều lần; không hứa exactly-once billing. Request API không nằm trong callback SQL có retry. Bản ghi decision không được UPDATE/DELETE bởi vai API/worker. Cờ tham chiếu cùng transfer/version; score bằng rule_score cộng ai_applied_weight của decision, tổng hit chỉ bằng rule_score khi có cờ.

### Dữ liệu và xử lý lỗi

Payload là allowlist feature số/boolean/chuỗi tiền canonical: amount, snapshot số dư, tuổi tài khoản, sameOwner, số đếm cửa sổ, trung vị/số lịch sử, thời gian từ lệnh ngược và số người nhận. Không gửi UUID, correlationId, thời điểm tuyệt đối, tên/email, free text, nhãn, scenario hoặc raw history. Projection loại ID không làm dữ liệu giao dịch hết nhạy cảm; trước khi dùng dữ liệu ngoài tổng hợp phải duyệt quyền gửi và điều kiện provider. ZDR chỉ áp dụng nếu tài khoản đủ điều kiện theo trang data controls của nhà cung cấp và được nhóm xác nhận; không mặc định.

Thiếu/trùng tên answer, sai type, refusal, p không hữu hạn/ngoài [0,1], HTTP 401/402/429/5xx, timeout hoặc budget hết đều cho baseline và lưu trạng thái tương ứng; không retry provider trong một lần xử lý hoặc đổi nhà cung cấp. Không log request body, key hoặc Authorization; không lưu response thô. Decision giữ feature snapshot, input/rubric hash, model đã yêu cầu, model thực tế nếu provider có trả, typed result/status và request id nếu có để audit/replay policy.

Ba trường hợp lỗi khác nhau, không gộp:
- *Lỗi mã luật hoặc truy vấn feature* (một luật ném lỗi, SQL feature lỗi): rollback, không commit decision, không ack. SQS retry và chuyển DLQ sau `maxReceiveCount` (local 5 lần, visibility 30 giây, tức khoảng 2,5 phút); metric `risk_rule_error_total{rule}`. Lỗi tất định làm mọi event vào DLQ, nên alarm DLQ và runbook redrive là điều kiện bật AI và nên có cả khi chưa bật (BL-041).
- *Khối `ai.*` của version không hợp lệ* (weight, threshold, rubric, model, `ai.maxAdmissionDelayMs`, `ai.requestTimeoutMs`): bị từ chối ngay lúc tạo version (UC-12). Nếu vẫn đọc ra giá trị hỏng thì không đẩy DLQ: chấm R1–R6, lưu `ai_status = CONFIG_INVALID`, contribution 0, commit, kèm metric và alarm riêng (BL-041). AI chỉ cộng nên cấu hình AI hỏng không được làm dừng cờ của luật.
- *Cấu hình nền* (ngưỡng, trọng số R1–R6) hỏng: bị từ chối lúc tạo version; nếu vẫn đọc ra giá trị hỏng thì xử lý như lỗi mã luật. Lỗi provider vẫn fallback baseline như trên.

Giới hạn concurrency/ngân sách và deadline phải được Ops xác nhận trước bật. `ai.maxAdmissionDelayMs` và `ai.requestTimeoutMs` là số nguyên dương: kiểm monotonic elapsed từ lúc chọn cấu hình ngay trước gửi; quá admission thì fallback, request đã gửi có timeout hữu hạn. Không cấp egress/quota hoặc thêm secret trong task tài liệu này.

Tạo rule-only version mới là **chuyển cấu hình có độ trễ**, không là ngắt egress tức thì. Cache latest có TTL 60 giây; worker còn cấu hình cũ có thể tiếp tục xử lý theo version cũ. Khi hợp đồng kho cấu hình khỏe, lời gọi mới theo version cũ bị chặn sau tối đa 60 giây cộng admission budget; request đã gửi có thể kết thúc thêm một request timeout ở phía client. Client abort không bảo đảm provider đã hủy hoặc ngừng tính phí. Không tự dừng worker dùng chung để tắt riêng AI.

## Thay đổi yêu cầu và tác động cần nhóm duyệt

Mục này liệt kê nơi ADR-14 chạm vào yêu cầu hoặc quyết định đã Accepted. Không file Accepted nào được sửa theo các điểm này cho tới khi nhóm chấp nhận ADR-14; hiện chúng chỉ mang khung tham chiếu tới ADR này.

1. **Cờ chỉ do AI tạo (0 luật kích hoạt) được phép** khi tổng điểm đạt ngưỡng. Việc này đổi: FR-RSK-03 (giải thích bằng luật đã kích hoạt); ràng buộc 2 của [ADR-08](0008-fraud-detection-architecture.md) («mỗi cảnh báo phải giải thích được»): cờ AI-only bắt buộc hiển thị `aiAssessment` cho operator làm phần giải thích; ERD `fraud_flags–fraud_rule_hits` từ `1..*` thành `0..*`; dòng aggregate FraudFlag + RuleHit và class diagram ở docs/02 §7; docs/03 §15 và payload GET chi tiết cờ (`hits` có thể rỗng, UI phải xử lý); định nghĩa «cờ gian lận» ở docs/01 §10. Lựa chọn thay thế: bắt `ai.weight` nhỏ hơn ngưỡng MEDIUM để AI không tự tạo cờ, đổi lại AI chỉ đẩy các ca đã chạm luật vượt ngưỡng và không bắt được ca ngoài tầm luật.
2. **Audit:** `audit_log` chỉ ghi khi tạo cờ và khi review. `risk_decisions` là bảng kỹ thuật append-only cùng nhóm với `processed_events` (baseline không audit từng dòng), nên nằm ngoài FR-AUD-01; AC-8.2 chỉ cần chuỗi cờ → review. Không thêm quyền đọc cho vai auditor và không thêm cột `correlation_id` vào decision; muốn tra quyết định LOW thì cần task API riêng.
3. **Dung lượng ghi:** `risk_decisions` có một dòng cho mọi TRANSFER, tối đa RPS × 86.400 dòng/ngày (120 RPS liên tục ≈ 10,4 triệu dòng/ngày), giữ vĩnh viễn vì claim phải sống hơn `processed_events` và bảng không DELETE được. Kích thước dòng chưa đo; task migration/load test phải đo trước khi chốt retention. Phân vùng theo thời gian không tương thích PK `transfer_id` + `ON CONFLICT` + FK từ `fraud_flags` (PostgreSQL buộc khóa duy nhất của bảng phân vùng chứa cột phân vùng). Phải chọn trước một hướng: hash partition theo `transfer_id` (chỉ dàn tải, không bỏ dữ liệu theo tuổi), bảng claim hẹp tách khỏi bảng snapshot được phân vùng (bảng hẹp vẫn tăng không giới hạn), hoặc quy trình lưu trữ có ngoại lệ trigger được duyệt (BL-039).
4. **Logging:** adapter provider phải đi qua `SafeLogger` và cơ chế che dữ liệu của DBS-42, không log body, raw response, khóa hay `Authorization`.
5. **Tài liệu vai khác:** threat model nhận T25 (dữ liệu giao dịch gửi tới dịch vụ ngoài, secret, outage) ở trạng thái Đề xuất; platform-infra, observability, load-tests, dataset brief và owner của threat model/docs/01/P2 được bàn giao ở BL-040.

## Lý do và đánh đổi

Phương án giảm việc train/export/deploy model, không giảm nghĩa vụ xây feature, bảo vệ dữ liệu, dedup/audit hoặc đo chất lượng. Chỉ tác động các contract risk được chỉ rõ; Dev API/giao diện phải xác nhận cách hiển thị tổng điểm và assessment, Ops phải xác nhận secret/quota/egress/cost. Không hứa không ảnh hưởng ai.

Việc phụ thuộc provider mang thêm latency, outage, quota, chi phí và model drift. Baseline tiếp tục chạy khi AI không khả dụng nhưng chất lượng phần phát hiện bổ sung có thể mất. Gắn cờ sau commit không thu hồi được tiền đã chuyển. Dữ liệu tổng hợp không chứng minh hiệu quả trên ngân hàng thật; không có model train đối chứng thì không kết luận thắng LightGBM/XGBoost.

## Cách kiểm chứng và gate bật AI

1. So sánh B0 rules, B1 API riêng chỉ để phân tích offline, B2 rules+API trên cùng giao dịch/feature. Một capture API dùng chung B1/B2, không gọi hai lần rồi coi là cùng điều kiện. Báo cáo số lần thử rubric/threshold/weight.
2. Tách khách cho phần chọn cấu hình và validation trong tune; freeze trước validation. Nếu chỉnh tiếp theo validation thì công bố nó đã thành tune. Holdout giữ độc lập, giao sau freeze và chạy đúng một lần cho mọi phiên bản đã chốt.
3. Giữ recall gộp >=70% trên năm kịch bản mục tiêu và <=20 cờ/1.000 TRANSFER. B2 phải tăng recall ít nhất 5 điểm phần trăm trên grouped validation tại cùng ngân sách, khoảng tin cậy paired bootstrap theo khách 95% loại trừ 0. Baseline đã vượt ngân sách thì policy chỉ cộng không thể cứu nó; không bật AI bằng cách bỏ qua giới hạn.
4. Báo TP/FP/FN/TN, precision/recall/F1, hard negatives, từng scenario trong/ngoài tầm, cờ AI bổ sung đúng/sai, ablation và đường precision–recall. Không dùng accuracy của dữ liệu lệch lớp hoặc confidence của provider thay độ chính xác thực.
5. Đo B0/B2 cùng tải tới 120 RPS: end-to-end p95 giao dịch→cờ <5 giây, queue age, feature/provider/SQL time, fallback/timeout/429, coverage AI và duplicate calls. Cost/1.000 TRANSFER gồm mọi lần gọi; giá ước tính phải ghi assumptions, không gọi là hóa đơn thực.
6. Runtime tests thật phải chứng minh race cùng/khác event và khác mode, rule-only LOW không bị chấm lại, rollback/audit, quyền/append-only, customer isolation, review một lần, Redis fallback/parity và chuyển cấu hình trong cache/in-flight. Replay capture chỉ chứng minh policy, không tái hiện model live hoặc latency live.
7. Chưa có credential/dataset/quota/điều kiện dữ liệu/số đo thì ghi chưa kiểm chứng và giữ AI tắt. Không đủ lợi ích hoặc không đáp ứng gate thì no-go, không hạ gate để làm đẹp báo cáo.

## Chuyển đổi và bàn giao

[Feature doc FRAUD-API-01](../features/FRAUD-API-01-external-ai-decision.md#74-handoff-và-lộ-trình-implementation-kế-tiếp) xác định task giữ/thay, kế hoạch và bên nhận. [Backlog](../BACKLOG.md) ghi điều kiện đóng các việc chưa triển khai hoặc chưa bàn giao. Việc đổi phạm vi DBS-161/211–215 do người quản lý board và nhóm xác nhận; agent không sửa sheet và không nhận kết quả API là đã hoàn thành DoD ONNX.

ADR này là hồ sơ đề xuất, không phải bằng chứng backend đã chạy được fraud hoặc API đã được test thật. Implementation phải đi qua task/gate riêng; một Dev review và nhóm chấp thuận trước khi thay trạng thái ADR hoặc bật AI.
