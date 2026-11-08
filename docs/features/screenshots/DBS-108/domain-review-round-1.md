## Kết luận: **CHƯA APPROVE**

Đây là review thiết kế và các contract được cung cấp, **không phải review implementation**: chưa có `scoring.service` hay mã sáu luật để xác minh. Không có test nào được chạy trong review này.

Thiết kế nhìn chung đúng hướng với ADR-14: mặc định rule-only, không tự gọi API, không tạo hit AI giả và giữ nguyên phạm vi worker/luồng tiền. Tuy nhiên còn các trường hợp blocking hoặc contract thiếu có thể tạo score sai hay phá fallback.

## Các điểm blocking

### 1. Overflow do AI chưa được quy định thống nhất với fallback baseline

§2 yêu cầu tổng vừa PostgreSQL `int`, TC-108-05 nói “từ chối overflow int”; đồng thời AI lỗi hoặc cấu hình AI sai phải fallback baseline. Chưa rõ xử lý khi **baseline hợp lệ nhưng AI làm tổng overflow**.

Ví dụ:

- `ruleScore = 2.147.483.640`, hợp lệ.
- AI `SUCCEEDED`, `p` đạt threshold, `weight = 10`.
- Tổng `2.147.483.650` vượt `2.147.483.647`.

Nếu ném lỗi theo TC-108-05, AI làm mất quyết định baseline; nếu trả tổng thì không lưu được vào cột `int`. Cần chốt policy: kiểm tra tổng trước khi cộng, coi phần AI không áp dụng được là lỗi AI/config, trả baseline với `aiAppliedWeight = 0` và trạng thái/lý do phù hợp. Nếu **riêng baseline** đã overflow thì fail-closed, không trả score cắt ngọn. Test cả hai nhánh và ranh giới đúng `2.147.483.647`.

Tương tự, AI weight được mô tả chỉ là “nguyên không âm”, chưa có giới hạn `int` hoặc safe integer. Ví dụ `weight = 2147483648` và AI đạt threshold: không được để một cấu hình AI sai khiến toàn bộ phép chấm thất bại thay vì fallback.

### 2. Chưa có contract runtime đủ chặt cho cấu hình rule fail-closed

`RuleParams` là TypeScript interface, không đảm bảo dữ liệu cấu hình tại runtime hợp lệ. Comment nói cấu hình được task sau validate, nhưng ADR ở đây yêu cầu **lỗi config rule fail-closed**, kể cả trước khi repository tương lai hoàn tất.

Ví dụ cần chốt rõ:

- `enabled: "false"` là string truthy trong JavaScript; nếu dùng trực tiếp, rule được cấu hình tắt có thể chạy.
- Weight của một rule đang enabled là `-1`, `1.5`, `NaN`, hoặc thiếu; nếu chỉ kiểm tổng sau khi tính, cấu hình sai có thể không bị phát hiện khi rule không hit.
- Thiếu một trong sáu cấu hình, hoặc threshold của rule thiếu/sai kiểu: không được ngầm coi là rule tắt hay score 0.

Cần quy định nơi validate và trách nhiệm cụ thể giữa scorer và từng rule: sáu entry phải hiện diện; `enabled` là boolean thật; weight và threshold tương ứng phải hợp lệ; lỗi lan ra caller. Cũng cần chốt có validate threshold/weight của rule **đã tắt** hay không để tránh hai implementation xử lý khác nhau. Test cấu hình sai ngay cả khi dữ liệu không làm rule hit. Không thể kết luận sáu rule hiện có đã thực hiện các kiểm tra này từ tài liệu được đưa ra.

### 3. Predicate AI cần định nghĩa theo kiểu runtime, không chỉ so sánh `p ≥ threshold`

Tài liệu nói “typed predicate hợp lệ” và “probability hợp lệ” nhưng chưa định nghĩa đầy đủ miền và kiểm tra runtime. TypeScript không ngăn response thực tế có kiểu sai.

Ví dụ nếu dùng phép so sánh JavaScript trực tiếp, `probability: "0.9"` có thể vượt threshold `0.8` do ép kiểu; `Infinity` cũng vượt threshold. Một `SUCCEEDED` với `p = 1.2` không phải xác suất hợp lệ nhưng vẫn có thể được cộng điểm.

Contract cần yêu cầu chính xác: assessment là object hợp lệ, `status === 'SUCCEEDED'`, `typeof probability === 'number'`, hữu hạn và `0 ≤ p ≤ 1`; AI threshold cũng phải là **number thật**, hữu hạn và thuộc `(0, 1]`; weight là integer hợp lệ. Không ép kiểu. Response thiếu field, status không nhận diện được, hoặc `SUCCEEDED` với `null`/`NaN`/`Infinity`/string/ngoài miền phải không cộng và giữ baseline. Test cả `p = 0`, `p = 1`, bằng threshold và các giá trị sai kiểu.

### 4. “Chỉ TRANSFER” chưa đủ contract để ngăn chấm event sai loại

Hành vi hiện ghi DEPOSIT trả `null`, TRANSFER được chấm, nhưng không nêu phải làm gì với event type khác hoặc discriminator thiếu/sai tại runtime. Nếu implementation chỉ kiểm tra `type === 'DEPOSIT'` rồi chấm mọi trường hợp còn lại, một event loại khác vẫn được scoring.

Cần chốt kiểm tra **allowlist TRANSFER**, không phải chỉ denylist DEPOSIT. Với type không hỗ trợ hoặc input sai, quy định rõ trả `null` hay ném lỗi; không gọi rule. Nếu contract input chỉ cho phép hai loại, vẫn cần xác định cách xử lý dữ liệu sai tại boundary. Test DEPOSIT, type lạ và discriminator thiếu; đồng thời xác nhận DEPOSIT không validate/chạy rule nếu chủ ý là bỏ qua hoàn toàn.

## Các contract cần làm rõ trước khi triển khai

1. **Status và mode thực tế khi fallback.** Kết quả có “AI status và mode thực tế” nhưng chưa định nghĩa mapping. Ví dụ mode `rules_with_external_ai` với config AI sai: trả `CONFIG_INVALID` và mode thực tế là gì? Mode lạ hoặc `rule_only` có assessment `SUCCEEDED` thì status là `DISABLED` hay giá trị khác? Không được phản ánh `SUCCEEDED` như AI đã được áp dụng khi thực tế assessment bị bỏ qua. Nên tách rõ status assessment đầu vào khỏi lý do áp dụng/bỏ qua nếu cần.

2. **RuleHit là ranh giới tin cậy.** Cần đảm bảo hit trả về có đúng ID rule đang chạy, weight bằng weight cấu hình hợp lệ và explanation đúng contract, hoặc scorer tự dựng phần đáng tin từ cấu hình. Nếu một rule lỗi trả `R1` với weight khác cấu hình hoặc `NaN`, chỉ kiểm tổng là chưa đủ để bảo đảm “tổng weight các hit R1–R6”. Lỗi phải fail-closed, không tạo kết quả sai.

3. **Không log dữ liệu nhạy cảm, kể cả đường lỗi.** Metric không có label khách hàng là tốt nhưng chưa đủ: `RuleHit.explanation`, exception từ rule, driver thủ công và log ở caller có thể chứa event, feature, assessment, request ID hay input hash. Cần contract explanation chỉ chứa thông tin được phép, không nhúng raw input/feature; không log/serialize toàn bộ đầu vào hay exception có payload nhạy cảm. Không đưa mode thô hoặc dữ liệu khách vào metric label. Đây là yêu cầu thiết kế; tài liệu chưa chứng minh có vi phạm log thực tế.

4. **Metric và tính thuần.** Class được mô tả là “hàm chấm thuần” nhưng lại tăng `prom-client` counter. Đây là side effect và có thể gây vấn đề đăng ký metric trùng khi tạo nhiều instance/test. Nên inject observer/counter hoặc trả tín hiệu để boundary tăng metric, và quy định metric lỗi không làm mất baseline. Không bắt buộc thay worker.

5. **Phạm vi ngưỡng và kiểm tra số.** Dùng `Number.isSafeInteger`/kiểm tra miền rõ ràng cho các số nguyên trước phép cộng; không dùng ép kiểu hay dựa vào JSON/TypeScript. Test `medium`, `high`, rule weight và tổng ở biên, bao gồm tổng >100 nhưng vẫn trong `int`.

## Điều kiện để APPROVE

Cần sửa contract và bổ sung test cho bốn điểm blocking, đặc biệt phân biệt **baseline overflow → fail-closed** với **AI làm overflow/config AI sai → baseline fallback**. Sau đó review implementation thực tế để xác minh validation, không log nhạy cảm và không có thay đổi ngoài phạm vi. CI, review, merge và kiểm thử tích hợp vẫn là việc chưa được chứng minh; không nên đánh dấu DoD hoàn tất chỉ từ thiết kế này.