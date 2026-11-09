# DBS-108 · Tính điểm từ sáu luật và tín hiệu AI

> **Status:** Implemented (scoring thuần); nối worker/provider thuộc DBS-109/110/111 (gốc: PR #100 của easterlywind, đưa vào main qua PR rebase của techlead) · **Vai:** #4 Fraud · **Nhánh:** `feat/DBS-105-r4-r6-scoring` · **PR:** xem README feature docs

## 1. Bối cảnh

DBS-108 là Story, tuần 4, ưu tiên High, Deliverable P5, trạng thái board `To Do`. Expect: «Từ một sự kiện ra được điểm, mức và giải thích.» DoD:

1. `scoring.service` gộp RuleHit thành điểm và mức; chỉ chấm TRANSFER, bỏ DEPOSIT.
2. Các ví dụ ở bảng §4.3 của guide trở thành unit test.
3. Luật tắt (`enabled=false`) trong cấu hình không được tính; điểm có thể >100.
4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ.
5. ScoringService đọc mode từ cấu hình: `rule_only` (mặc định) hoặc `rules_with_external_ai`; chế độ chưa hỗ trợ thì rơi về rule_only và ghi metric; `score = tổng weight các hit R1–R6 + ai_applied_weight`, trong đó `ai_applied_weight = ai.weight` nếu typed predicate hợp lệ và `p ≥ ai.threshold`, ngược lại 0 (không dùng `100·p`).
6. Bất biến: `score = rule_score + ai_applied_weight`; `fraud_rule_hits` chỉ chứa R1–R6 nên cờ chỉ do AI tạo có thể không có hit (có test).

DBS-93, DBS-94 và DBS-95 đã merge vào `main`. DBS-105/106/107 có code thuần và test trong cùng nhánh; đã vào `main` qua [#104](https://github.com/Lawliet119/digital-banking-simulator/pull/104), chưa có Dev review. `OnlineFeatureProvider` (DBS-109) và `RuleSetRepository` (DBS-110) đã có; `OfflineFeatureProvider`, consumer (DBS-111) và `risk_decisions` chưa hoàn thành. DBS-101 thuộc Dev đang `In Progress`; không thay thế ConsumerBase hoặc sửa luồng tiền. ADR-14 đặt `rule_only` làm mặc định, lỗi luật/feature fail-closed và lỗi AI fallback về luật. Bằng chứng chất lượng, quyền dữ liệu và vận hành AI vẫn cần BL-043/044/051; không bật AI production bằng task này.

**G1 (agent tự quyết):** phạm vi là hàm chấm thuần kết hợp sáu class rule và kết quả AI đã nhận, không tự gọi mạng/DB hoặc đăng ký worker. Đây không chứng minh tạo cờ, dedup, feature thật, customer isolation hay độ chính xác AI. Chuẩn hóa config dưới dạng `RuleParams` hiện có; repository DBS-110 chịu trách nhiệm ánh xạ seed JSON phẳng sang `thresholds`. CI/Dev review/merge là việc chưa xảy ra, không đánh dấu board Done.

**Bổ sung theo yêu cầu hoàn thiện fraud (agent tự quyết):** R2 trên `main` cho phép `medianAmount30dTimes2` tới `2 × MONEY_MAX`, trong khi `toAiFeatureInput` đang dùng `parsePositiveMoney` giới hạn ở một `MONEY_MAX` và từ chối trung vị hợp lệ lớn; đã tái hiện bằng feature tổng hợp. Sửa riêng phép parse của projection, viết test tái hiện trước; giữ input/output public, không gọi API hay đổi adapter/network. Trước đây lỗi được dự kiến giao RSK-02; sửa sớm để không đưa dữ liệu hợp lệ vào nhánh fallback khi tích hợp. Quyền egress và quality gates vẫn chưa hoàn tất.

**Quyết định bổ sung trước khi sửa R3 đã merge (agent tự quyết):** hợp đồng event nhận 1–9 chữ số thập phân, nhưng test mới trên R3 của `main` cho thấy `Date.parse` bỏ phần dưới mili giây, làm mất hit khi tuổi nhỏ hơn biên 24 giờ đúng 1 ns. Dùng lại `riskTimeNanoseconds` để so sánh bigint chính xác; giữ class, cấu hình, lỗi theo tên trường, mô tả và chính sách tuổi âm của R3 đã merge. Không giữ implementation R3 trùng. Cách này chỉ đổi phân loại R3 tại các biên dưới mili giây, không đổi luồng chuyển tiền. Review độc lập xác nhận phép tính và phạm vi; nhận xét regex về newline đã được bác bằng Node và parser thật ([bằng chứng](screenshots/DBS-95/velocity-review-correction.md)).

**Quyết định bổ sung sau review tích hợp, trước sửa projection (agent tự quyết):** [review độc lập](screenshots/DBS-108/integrated-review.md) chỉ ra AI projection cắt dưới mili giây và biến thời điểm giao dịch ngược ở tương lai thành 0 phút. Giữ R4 trả `null` khi ngoài cửa sổ vì DoD yêu cầu ca ngoài giờ không hit; trách nhiệm provider cấp fact hợp lệ vẫn thuộc DBS-109/128. Riêng projection AI dùng cùng parser nano, không gửi fact ở tương lai/đồng thời như thể xảy ra trước; AI fallback thuộc caller. Giữ chính sách tuổi âm R3/AI là 0, clip tuổi 720 giờ và không thay schema payload. Test tái hiện trước sửa.

**Quyết định bổ sung sau review tích hợp vòng 2 (agent tự quyết):** R2 từ chối median vượt `2 × MONEY_MAX` nhưng parse `BigInt` trước khi kiểm cận; chạy class thật với chuỗi một triệu chữ số mất 76,5 ms trước khi từ chối. Không có bằng chứng nguồn feature hiện cho người dùng gửi chuỗi này trực tiếp, nhưng bảo vệ event loop bằng kiểm độ dài tối đa 20 trước regex/parse; đầu vào hợp lệ và thông báo lỗi không đổi. Test R2 hiện có đã kiểm cận, bao gồm chuỗi 40 chữ số; đo lại bằng script tạm, không ghim thời gian vào test.

## 2. Hành vi

- Đầu vào `TransferCompleted`, `Features`, cấu hình đã chuẩn hóa (sáu `RuleParams`, ngưỡng `medium`/`high`, mode) và kết quả `AiAssessment` tùy chọn. Chỉ loại `TRANSFER` được chấm; DEPOSIT hoặc discriminator khác trả `null` trước khi đọc config/rule. TRANSFER dùng cùng snapshot và feature cho cả sáu luật.
- Sáu cấu hình phải hiện diện, kể cả luật tắt. Mỗi rule phải nhận `evaluate` ngay cả khi tắt và kiểm boolean `enabled`, weight nguyên `[0,2147483647]` cùng threshold thuộc miền của nó trước khi bỏ qua. Miền/key theo seed DBS-58 và implementation/test của từng rule; R1–R3 đã merge, R4–R6 trong nhánh này. Thiếu entry hoặc rule ném lỗi thì fail-closed. Mỗi hit phải mang ID của rule vừa chạy, weight đúng cấu hình, explanation là chuỗi không rỗng; sai thì fail-closed.
- `ruleScore` là tổng weight hit; phải là số nguyên không âm ≤ PostgreSQL `int`, nếu riêng baseline overflow thì ném lỗi. Ngưỡng config là số nguyên an toàn, `0 < medium < high ≤ 2147483647`. LOW < medium, MEDIUM từ medium đến dưới high, HIGH từ high trở lên; không giới hạn ở 100.
- Mode thiếu là `rule_only`; `rule_only` bỏ qua assessment và trả AI status `DISABLED`. Mode lạ dùng `rule_only`, AI status `DISABLED`, tăng counter một lần khi phát hiện mode lạ ở TRANSFER, kể cả nếu rule sau đó lỗi; non-TRANSFER không đọc config và không tăng counter.
- Trong mode AI, `config.ai` phải là object không null, `threshold` là number hữu hạn `(0,1]`, `weight` là integer `[0,2147483647]`; sai trả `CONFIG_INVALID`, contribution 0. Sau khi xác nhận assessment hợp lệ và `p ≥ threshold`, mới kiểm cộng weight có overflow không; nếu có thì `CONFIG_INVALID`, contribution 0, vẫn trả baseline. Không đánh dấu overflow tiềm năng khi chưa áp dụng weight. Mode vẫn là `rules_with_external_ai` khi config AI hỏng.
- Chỉ cộng khi assessment là object có `status=SUCCEEDED`, probability là number hữu hạn trong `[0,1]` và `p ≥ threshold`; không ép kiểu. `SUCCEEDED` thiếu/p hỏng hoặc status lạ thành `INVALID_RESPONSE`; null/thiếu assessment thành `UNAVAILABLE`; `DISABLED` ở mode AI thành `CONFIG_INVALID`; các trạng thái lỗi hợp lệ giữ baseline với probability null. Không có RuleHit AI giả. Caller phải validate toàn bộ config AI và tổng weight tối đa **trước egress**; phép chấm sau assessment không thay thế điều kiện này.
- Không log/serialize event, feature, assessment hay explanation. Giá trị số trong explanation vẫn là thông tin giao dịch nhạy cảm; chỉ consumer/API operator được phép xử lý. Chấm sau khi caller đã thu thập feature/assessment; việc kiểm model, rubric, secret, quota, admission, timeout trước egress và lưu provenance thuộc repository/consumer/RSK-02.

## 3. Kiến trúc

`backend/src/modules/risk/scoring.service.ts` cung cấp class đồng bộ với `score(event, features, config, assessment)`. Dùng sáu rule thuần, không ghi DB, không gửi HTTP, không thay event hay schema; tăng metric là side effect duy nhất. Kết quả gồm hits, `ruleScore`, `aiAppliedWeight`, `score`, level, AI status và mode thực tế. Counter `risk_unsupported_mode_total` không label, đăng ký singleton ở default Prometheus registry như `RedisMetrics`, không đưa mode/raw input vào label. Chỉ consumer tương lai quyết định tạo cờ MEDIUM/HIGH và persist trong transaction.

Chữ ký: `score(event: TransferCompleted, features: Features, config: ScoringConfig, assessment?: AiAssessment | null): ScoringResult | null`. `ScoringConfig.rules` gồm đủ sáu key `R1`–`R6`, mỗi key là `{enabled, weight, thresholds}`; seed DB đang là JSON phẳng nên caller không được chuyển thẳng seed mà không ánh xạ. `risk_decisions` và dữ liệu nguồn chưa có trên đường chạy này.

## 4. Test cases

| ID | Truy vết | Given → Then |
|---|---|---|
| TC-108-01 | DoD 1–3 | Các ví dụ guide: R6=30 LOW, R3+R6=65 MEDIUM, R5=40 MEDIUM, R1+R5=70 HIGH; luật tắt không đóng góp, tổng >100 không bị cắt. |
| TC-108-02 | DoD 1 | DEPOSIT, type lạ hoặc thiếu type không gọi luật; thiếu entry/threshold, threshold sai kiểu, weight âm dù tổng vẫn dương, config hỏng kể cả rule tắt hoặc lỗi luật được ném. |
| TC-108-03 | DoD 5–6 | AI-only p bằng threshold tạo score 40/MEDIUM, hits rỗng; p=0, p=1, dưới threshold/status lỗi chỉ cộng đúng policy; assessment null/thiếu field, p null/NaN/Infinity/chuỗi/ngoài miền và status lạ không cộng. AI không xóa điểm luật. |
| TC-108-04 | DoD 5 | Mode thiếu hoặc lạ dùng baseline, mode lạ tăng metric một lần ngay cả khi baseline lỗi, DEPOSIT không tăng; ai null/thiếu/threshold/weight sai thành CONFIG_INVALID mà không ngăn luật. |
| TC-108-05 | ADR-14 | score bằng ruleScore + aiAppliedWeight; baseline đúng int max hợp lệ, baseline overflow ném lỗi; AI gây overflow khi sẽ áp dụng fallback baseline với CONFIG_INVALID; p dưới threshold không coi overflow tiềm năng là lỗi; ngưỡng nền hỏng bị từ chối. |
| TC-108-06 | DoD 4 | CI, Dev review, merge thực tế theo PR; chưa thể coi đã đạt. |
| TC-108-07 | ADR-14 | Provider/worker/repository thực, transaction, quyền operator và chất lượng AI: test task tích hợp, chưa được chứng minh bởi unit. |
| TC-108-08 | BL-184 H5 | AI projection: median nhân đôi bằng `2 × MONEY_MAX` và lẻ ngay dưới cận giữ chính xác; vượt cận bị từ chối. |
| TC-108-09 | Review tích hợp | Projection giữ tuổi và khoảng cách thời gian 1 ns, từ chối giao dịch ngược cùng thời điểm/tương lai; R2 từ chối median dài trước parse. |

## 5. Test thủ công dự kiến

Chạy `npx ts-node -r tsconfig-paths/register test/manual/scoring.manual.ts` từ `backend/` với input tổng hợp: M-108-01 R3+R6=65; M-108-02 AI-only p bằng ngưỡng=40, không có rule hit; M-108-03 AI lỗi giữ baseline; M-108-04 DEPOSIT bỏ qua và ngưỡng nền sai báo lỗi; M-108-05 projection trung vị tối đa chính xác. Driver không gọi OpenAI hoặc lưu dữ liệu khách; không diễn giải là worker end-to-end.

## 6. Domain review

Vòng 1: reviewer model `default` của runtime, [phản hồi nguyên văn](screenshots/DBS-108/domain-review-round-1.md), kết luận chưa approve. Vòng 2: [phản hồi nguyên văn](screenshots/DBS-108/domain-review.md), kết luận chưa approve; đã làm rõ miền weight, trách nhiệm validate trong từng rule, thứ tự kiểm overflow AI, null/status và lifecycle metric tại §2–§4. Vòng 3: [phản hồi nguyên văn](screenshots/DBS-108/domain-review-round-3.md), **APPROVE**, không còn blocking; kiểm cấu hình hỏng khi tắt cho từng rule và thứ tự metric/overflow trong test.

Review code: [vòng 1](screenshots/DBS-108/code-review.md) chỉ ra property getter AI có thể ném và collision tên metric; đã sửa fallback AI và thêm regression, giữ collision là lỗi khởi tạo tường minh để không giả metric (BL-185). [Vòng 2](screenshots/DBS-108/code-review-round-2.md) phát hiện revoked proxy tại `Array.isArray`; đã sửa trong nhánh AI và thêm regression. [Vòng 3](screenshots/DBS-108/code-review-round-3.md) **APPROVE**, không thay Dev review.

[Review thiết kế sửa projection](screenshots/DBS-108/projection-design-review.md): APPROVE với điều kiện kiểm kiểu/độ dài trước `BigInt` và giữ lỗi chung.

[Review code projection](screenshots/DBS-108/projection-code-review.md) tìm thấy `Date.parse` có thể ép kiểu timestamp không phải chuỗi và `Object.keys` bỏ qua property ẩn/symbol. Agent tự quyết mở rộng sửa hai validation tại boundary AI, giữ allowlist và lỗi chung; không chứng minh có rò rỉ payload vì projection vốn dựng object mới. Bổ sung regression trước khi sửa.

[Review lại projection](screenshots/DBS-108/projection-code-review-round-2.md) tìm thấy timestamp accessor có thể thay đổi giữa kiểm kiểu và `Date.parse`; thêm regression và đọc snapshot một lần. Các parser tiền dùng chung đã giới hạn độ dài trước `BigInt` (`money.ts`).

[Review projection vòng 3](screenshots/DBS-108/projection-code-review-round-3.md) **APPROVE**, không thay Dev review.

[Review R3 nanosecond](screenshots/DBS-95/r3-nanosecond-review.md) xác nhận miền số và thứ tự kiểm; nhận xét newline được bác bằng thực nghiệm ([đính chính](screenshots/DBS-95/velocity-review-correction.md)). [Review code R3 cuối](screenshots/DBS-95/r3-code-review-final.md) **APPROVE**.

[Review tích hợp](screenshots/DBS-108/integrated-review.md) và [vòng 2](screenshots/DBS-108/integrated-review-round-2.md) phát hiện độ chính xác timestamp AI và parse median quá dài ở R2; hai vấn đề được sửa sau test/đo tái hiện. [Vòng 3](screenshots/DBS-108/integrated-review-round-3.md) **APPROVE** phạm vi đã cung cấp, với giả định provider kiểm chứng dữ liệu.

**Quyết định G2 (agent tự quyết):** giữ rule-only và fallback theo ADR-14; triển khai phép cộng sau assessment, không bật egress hoặc thay quyết định của người vận hành.

## 7. Kế hoạch

Viết test TC-108-01–05 trước; chạy đỏ do module chưa tồn tại; implement sáu rule + policy AI và metric; chạy test xanh. Sau đó review code, driver thủ công, lint/typecheck/build/unit/e2e theo khả năng môi trường; commit code, lưu output thật và cập nhật backlog. Không làm giả các dependency còn thiếu.

| Bước | File | Test trước / đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|
| Scoring và sáu luật | `scoring.service.ts`, `scoring.service.spec.ts`, rule R4–R6 | TC-108-01–05 đỏ vì module chưa có | `npm test -- --runInBand src/modules/risk/scoring.service.spec.ts` | `f536209` |
| Căn median và thời gian | `ai/feature-projection.ts`, `features/velocity-count.ts`, R2/R3 | Test median/1 ns và getter đỏ trước fix; R2 input dài được đo trước/sau | `npm test -- --runInBand src/modules/risk/ai/feature-projection.spec.ts src/modules/risk/rules/r2-unusual-amount.rule.spec.ts` | `f536209`, `5df0f0f` |
| Manual và bàn giao | `test/manual/scoring.manual.ts`, `docs/features/DBS-108-scoring.md`, `docs/BACKLOG.md` | Không áp dụng, driver chạy input tổng hợp | `npx ts-node -r tsconfig-paths/register test/manual/scoring.manual.ts` | code `f536209`; kết quả §8 trên `5df0f0f` |

Sweep hậu triển khai: không có migration/schema, worker, egress hoặc dữ liệu thực trong PR này; các phần còn thiếu có BL-041/184/185 và TC-108-06/07. Rollback bằng revert các commit code của nhánh; không sửa decision đã ghi vì component này chưa được nối runtime.

**Quyết định G3 (agent tự quyết):** thực hiện theo TC-108-01–08; sweep đối chiếu DoD và ADR-14 cho thấy tích hợp worker, quyền dữ liệu/egress và benchmark không thể chứng minh trong phạm vi scorer, được giữ là handoff thay vì tạo stub. Ca projection được bổ sung sau G3, đã ghi lý do ở §1.

## 8. Kết quả và bàn giao

- Code cuối `5df0f0f`: `lint:check`, `typecheck`, unit toàn backend **80 suite / 1.584 test** đạt. E2e chung **15 suite / 153 test** và build đạt; e2e không chứng minh fraud runtime. DB **43 suite / 735 test** đạt trên PostgreSQL cô lập trong quá trình triển khai, trước fix projection/R2 cuối; hai fix không đổi schema. Bộ riêng R3/scoring/DEPOSIT/velocity **4 suite / 171 test**; projection/R2 **2 suite / 134 test**.
- TC-108-01–05: **đạt** qua `scoring.service.spec.ts`; TC-108-08: **đạt** qua `ai/feature-projection.spec.ts`. TC-108-09: **đơn giản hóa**: regression projection kiểm 1 ns và reverse không hợp lệ; test R2 kiểm đầu vào dài bị từ chối, còn thứ tự parse chỉ đo thủ công với 1 triệu chữ số (76,5 ms / 0,3 ms trên máy chạy, không coi là benchmark tải). TC-108-06: **chưa đạt** vì CI PR, Dev review và merge chưa xảy ra. TC-108-07: **chưa làm**, không có provider/worker/repository thật trong phạm vi này; theo dõi [BL-041](../BACKLOG.md), [BL-184](../BACKLOG.md), [BL-185](../BACKLOG.md). Quyền dữ liệu, egress và đánh giá AI theo BL-043/044/051.
- Manual trên commit code cuối: `npx ts-node -r tsconfig-paths/register test/manual/scoring.manual.ts`. M-108-01 R3+R6 = 65/MEDIUM; M-108-02 AI tổng hợp p=0,9 cho 40 điểm và hits rỗng; M-108-03 UNAVAILABLE giữ 65 điểm baseline; M-108-04 DEPOSIT bỏ qua và config sai bị từ chối; M-108-05 median tối đa được giữ chính xác. [Output thật](screenshots/DBS-108/manual-test.txt), [ảnh terminal](screenshots/DBS-108/01-scoring.png). Không gọi OpenAI thật trong các bước này.
- Sau khi R3 merge vào `main`, bỏ class R3 trùng và dùng class đã merge; test mới tái hiện lỗi tuổi sát biên 1 ns trước khi sửa. R1 reference window cũng sửa để không mất phần dưới mili giây; provider thật vẫn cần test parity. Các quyết định bổ sung tại §1 và §6; không thay schema, ledger, mạng hoặc `RiskModule`.
- Guide còn các mục ONNX/train cũ mâu thuẫn ADR-14; chỉ policy lỗi §5.6 đã cập nhật trong PR, còn việc đồng bộ toàn guide và giữ anchor cũ được ghi [BL-186](../BACKLOG.md).
- Các task R4–R6 có độ lệch thứ tự tài liệu/review được ghi trong feature doc tương ứng; giữ PR Draft và không khẳng định quy trình G4 hoặc DoD đã hoàn tất. Review AI không thay Dev review.

## 9. Tài liệu

Đã cập nhật README risk, guide policy lỗi, `docs/features/README.md`, feature doc DBS-94/95 và `docs/BACKLOG.md` (BL-041/184/185); không thay ADR-14 hay hợp đồng event.

### Domain review bằng subagent (bù sau merge, 2026-11-09)

Reviewer: subagent `fable` (mô hình mạnh nhất có sẵn), prompt `prompts/domain-review.md` chỉnh cho code đã merge, đọc `main` ở `18f93dc`. [Phản hồi nguyên văn](screenshots/DBS-108/domain-review.md). Bước này lẽ ra chạy ở Phase 2; agent đã bỏ qua khi làm một mạch, vì suy diễn Techlead waiver rộng hơn lời dặn «không qua humangate» (chỉ miễn người duyệt gate). Chạy bù sau merge. Các vòng review có sẵn ở trên được giữ nguyên.

**Verdict: REVISE** (1 should-fix, 5 minor). Không có phát hiện về tiền hay bảo mật.

| # | Mức | Xử lý |
|---|---|---|
| 1 | should-fix | Không sửa: scorer ném lại lỗi thô nên consumer không gắn được nhãn `rule` cho `risk_rule_error_total` → BL-207 |
| 2 | minor | **Đã sửa:** `02-architecture.md` §7 theo ADR-14 (fail-closed) |
| 3 | minor | Không sửa: dùng nguyên văn ví dụ guide §4.3 và AC-9.1 làm test → BL-212 |
| 4 | minor | **Đã sửa:** §1 cập nhật trạng thái |
| 5 | minor | Bàn giao DBS-111/API: AC-9.1, AC-9.2, AC-10.2 chỉ chứng minh được khi nối consumer → BL-188 |
| 6 | minor | Bàn giao UC-12: bộ kiểm khi ghi phiên bản phải phủ R1–R6 → BL-188 |
