## Verdict: REVISE

|Mức|Vị trí|Phát hiện và bằng chứng|Sửa tối thiểu|
|---|---|---|---|
|**should-fix · P2**|`docs/features/DBS-160-risk-config-api.md:34` (§3)|**Kiểm tra block AI cả trong `rule_only`.** Cách kiểm `aiConfigInvalid` được mô tả không thực hiện được cam kết §2: `parseRuleSet` bỏ qua hoàn toàn `ai` trong mode baseline và trả `aiConfigInvalid=false`. Vì vậy, kiểm parser rồi sáu luật vẫn không phát hiện `ai.threshold=7`, timeout âm hoặc tổng điểm AI overflow ở baseline. Bằng chứng: `backend/src/modules/risk/config/rule-set.ts:122–134`; hành vi này được khẳng định tại `rule-set.spec.ts:132–137`.|Nếu request có `ai`, kiểm thêm bằng parser trên bản sao với `mode='rules_with_external_ai'`; từ chối khi `aiConfigInvalid`, nhưng lưu nguyên mode được yêu cầu. Giữ fallback worker hiện tại. Bổ sung TC-160-02 cho cùng block AI sai ở **cả hai mode**, kể cả overflow.|

Không ghi nhận blocking/minor khác có đủ bằng chứng trong §§1–5. **Confidence: 0,94.**

### Khóa writer và cache

Phương án **transaction-level advisory lock, cùng cặp số cố định cho mọi writer**, phù hợp với hợp đồng mà không cần tăng quyền bảng:

- Lấy khóa qua **cùng `manager`** của `TransactionService.run`, rồi chạy `MAX(version)+1` bằng **câu SQL riêng sau khi lấy khóa**, ở `READ COMMITTED`. Không gộp khóa và `MAX` trong một statement/CTE: snapshot có thể được lấy trước lúc chờ khóa.
- Giữ khóa đến khi insert và audit commit/rollback; không dùng session-level lock trên connection pool.
- Giữ API không ghi/xóa Redis: repository đọc PostgreSQL và tự hết hạn latest trong 60 giây. Không thấy cần thay repository để hỗ trợ writer đã serialize.
- Writer thủ công bỏ qua khóa nằm ngoài bảo đảm đã ghi rõ ở §3; cần công bố chính xác cặp khóa trong hướng dẫn vận hành.
- TC-160-03 nên giữ writer A trước commit để chứng minh B thực sự chờ; thêm nhánh audit A lỗi để chứng minh rollback nhả khóa và không để lại version/audit.

Không đề nghị `SHARE ROW EXCLUSIVE`, tăng grants hoặc khóa hàng bằng `FOR UPDATE`. Khoảng thiếu audit 403 của `RolesGuard` là **BL-132 có sẵn**, không phải lỗi mới của thiết kế này.

Chỉ đọc tài liệu/code; không chỉnh file hoặc chạy build/lint/test/formatter.
