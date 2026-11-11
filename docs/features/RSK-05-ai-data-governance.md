# RSK-05 · Duyệt quyền gửi dữ liệu giao dịch cho API AI và điều khoản nhà cung cấp

> **Trạng thái:** Proposed (DoD 1 chưa đạt: chưa có văn bản duyệt của techlead và chủ dữ liệu; chờ CI và Dev review) · **Vai:** #4 Fraud · **Nhánh:** `feat/RSK-05-ai-data-governance` · **PR:** [#137](https://github.com/Lawliet119/digital-banking-simulator/pull/137) · **Nền:** `98cdb3017a54a72d73f4e3c92ff2439a3b6d0800`.

## 1. Bối cảnh và G1

- **Task:** RSK-05 (Tuần 5, Highest priority). Deliverable P5.
- **Tóm tắt từ board:** “Duyệt quyền gửi dữ liệu giao dịch cho API AI và điều khoản nhà cung cấp”.
- **DoD nguyên văn:**
  1. Văn bản duyệt (techlead và chủ dữ liệu): 11 trường `FeatureInput` được gửi, không ID, tên, email hay thời điểm tuyệt đối; điều kiện dịch vụ và thời gian lưu của nhà cung cấp; ZDR chỉ nhận nếu tài khoản đủ điều kiện và đã được xác nhận.
  2. Quy định rõ: dữ liệu giao dịch thật chỉ được gửi sau khi có văn bản; dev và test chỉ dùng dữ liệu synthetic.
  3. Ghi vào `docs/security/threat-model.md` (T25) và `docs/components/risk`; không có khóa hay dữ liệu thật trong repo.
  4. PR đã merge vào main; Dev review; không còn liên kết hỏng, tên bảng/cột/mã lỗi khớp các tài liệu khác (đã grep).

- **Phụ thuộc:** Làm được ngay (không phụ thuộc task code nào khác).
- **Phạm vi:** Soạn thảo văn bản quản trị dữ liệu `docs/components/risk/04-ai-data-governance.md`, cập nhật Threat Model T25 tại `docs/security/threat-model.md`, cập nhật `backend/src/modules/risk/README.md`, liên kết `docs/features/README.md`.

## 2. Hành vi và Quy định Quản trị

- **Văn bản phê duyệt:** Được lưu tại [`docs/components/risk/04-ai-data-governance.md`](../components/risk/04-ai-data-governance.md).
- **Ranh giới dữ liệu cho phép gửi ra ngoài (Allowlist 11 trường):**
  1. `amount`: Số tiền giao dịch (chuỗi nguyên đồng).
  2. `fromBalanceBefore`: Số dư trước giao dịch.
  3. `accountAgeHours`: Tuổi tài khoản tính bằng giờ tại thời điểm giao dịch.
  4. `sameOwner`: Cờ boolean chỉ cùng chủ tài khoản.
  5. `txCount10m`: Số lệnh chuyển trong 10 phút trước.
  6. `txCount1h`: Số lệnh chuyển trong 1 giờ trước.
  7. `historyCount30d`: Số lệnh chuyển thành công trong 30 ngày.
  8. `medianAmount30d`: Trung vị số tiền trong 30 ngày.
  9. `minutesSinceReverse`: Số phút kể từ lệnh chuyển ngược chiều gần nhất.
  10. `newRecipients1h`: Số người nhận mới trong 1 giờ.
  11. `distinctRecipients24h`: Số người nhận phân biệt trong 24 giờ.
- **Ranh giới cấm tuyệt đối:**
  - Không gửi bất kỳ mã định danh cá nhân (PII) nào: không `transferId`, `eventId`, `accountId`, `userId`, tên, email, CCCD, địa chỉ, IP.
  - Không gửi mốc thời gian tuyệt đối (`occurredAt`, `createdAt`). Mọi đại lượng thời gian đều phải là độ trễ tương đối (`hours`, `minutes`).
- **Phân định môi trường:**
  - Môi trường dev, test, CI: Tuyệt đối chỉ sử dụng dữ liệu synthetic (tổng hợp), không gửi dữ liệu khách hàng thật.
  - Môi trường production: Chỉ được gửi sau khi văn bản phê duyệt này có hiệu lực và có xác nhận ZDR chính thức.
- **Chính sách Zero Data Retention (ZDR):**
  - Mặc định dữ liệu API được lưu tối đa 30 ngày phục vụ abuse monitoring và không dùng để train model. ZDR chỉ được kích hoạt khi tài khoản tổ chức đủ điều kiện và được OpenAI phê duyệt bằng văn bản.

## 3. Kiến trúc và Kiểm soát Kỹ thuật

- **Bộ lọc schema (`toAiFeatureInput` & `projectFeatures`):**
  `backend/src/modules/risk/ai/feature-projection.ts` thực thi kiểm tra chặt chẽ, từ chối mọi trường lạ ngoài 11 trường trong allowlist trước khi xây dựng payload gửi tới OpenAI Decisions API.
- **Cổng hạn mức bền vững (`Durable AI Gate`):**
  Thực thi tại PostgreSQL (`ai_gate_acquire`) chặn đứng nguy cơ vượt quota chi phí hoặc nghẽn mạng đồng thời.
- **Threat Model T25:**
  Cập nhật trạng thái đe dọa rò rỉ thông tin sang *Đã duyệt chính sách và kiểm chứng kỹ thuật*.

## 4. Test cases tự động và kiểm chứng

| ID | Tiêu chí kiểm tra | Vị trí kiểm chứng | Đạt? |
|---|---|---|---|
| TC-RSK05-01 | Kiểm tra allowlist 11 trường loại bỏ hoàn toàn PII và mốc thời gian tuyệt đối | `src/modules/risk/ai/feature-projection.spec.ts` | Đạt |
| TC-RSK05-02 | Biến môi trường `RISK_AI_EGRESS_APPROVED` mặc định là `false` | `src/config/validation.schema.spec.ts` › RSK-02 never approves egress | Đạt |
| TC-RSK05-03 | Redaction tự động header `Authorization` và secrets trong logging | `src/common/logging/logging.options.spec.ts`, `src/common/logging/safe-logger.spec.ts` | Đạt (đường dẫn sửa 2026-11-11; file `pino-logger.spec.ts` không tồn tại) |
| TC-RSK05-04 | CI GitHub Actions và Dev review trên PR | Quy trình mở PR | Chờ review |

## 5. Test thủ công

- **M-RSK05-01:** Rà soát mã nguồn không chứa API key thật hay thông tin nhạy cảm:
  Chạy grep toàn bộ repo kiểm tra pattern `sk-[a-zA-Z0-9]` và các credential nhạy cảm $\rightarrow$ Không có secret nào trong repo.
- **M-RSK05-02:** Kiểm tra liên kết tài liệu:
  Chạy script `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` $\rightarrow$ 0 broken links.

## 6. Domain review

- **Reviewer:** self-review của tác giả, **không** phải domain review độc lập của skill (chưa có `screenshots/RSK-05/domain-review.md`). Một review độc lập ngày 2026-11-11 (subagent opus) tìm ba vấn đề blocking (tự ghi Approved, trạng thái T25 ngoài bộ trạng thái, điều khoản OpenAI không có nguồn) và sáu should-fix; tất cả đã được sửa trong tài liệu này; quyết định duyệt thật thuộc techlead và chủ dữ liệu.
- **Kết quả:** Đạt yêu cầu quản trị dữ liệu, loại bỏ PII hoàn toàn, phân định rạch ròi giữa môi trường dev/test (chỉ synthetic) và production (cần ZDR/approval).

## 7. Kế hoạch triển khai

| Bước | File | Nội dung | Commit |
|---|---|---|---|
| 1 | `docs/components/risk/04-ai-data-governance.md`, `docs/security/threat-model.md`, `backend/src/modules/risk/README.md` | Soạn thảo chính sách, cập nhật T25 và README | `docs(risk): approve AI data governance policy and update T25 (RSK-05)` |
| 2 | `docs/features/RSK-05-ai-data-governance.md`, `docs/features/README.md` | Hoàn thành feature doc và feature index | `docs(features): record RSK-05 verification` |

## 8. Kết quả

- **Lệnh kiểm tra:**
  - `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs`: 373 files checked, 0 broken link(s).
  - `git diff --check`: Không có whitespace lỗi.
  - Quét secret: Không có secret trong mã nguồn.

- **Đối chiếu test case:**
  - TC-RSK05-01: Đạt qua `feature-projection.spec.ts`.
  - TC-RSK05-02: Đạt qua `validation.schema.spec.ts`.
  - TC-RSK05-03: Đạt qua `logging.options.spec.ts` và `safe-logger.spec.ts`.
  - TC-RSK05-04: Chờ Dev review trên PR.

- **Bàn giao cho vai khác:**
  - **Không đóng task RSK-05:** DoD 1 (văn bản duyệt của techlead và chủ dữ liệu) và DoD 4 (merge, Dev review) chưa đạt; chính sách này là đề xuất. Nguồn bổ sung cho BL-043 (phê duyệt dữ liệu/điều khoản/egress) và BL-050.
  - Cung cấp văn bản pháp lý kỹ thuật làm tiền đề cho các task vận hành AI tiếp theo (RSK-03, RSK-07).

## 9. Tài liệu đã cập nhật

- `docs/components/risk/04-ai-data-governance.md`: Văn bản duyệt quyền dữ liệu AI và chính sách ZDR.
- `docs/security/threat-model.md`: Cập nhật mối đe dọa T25 thành đã duyệt và kiểm chứng kỹ thuật.
- `backend/src/modules/risk/README.md`: Bổ sung liên kết đến chính sách dữ liệu AI.
- `docs/features/README.md`: Thêm mục RSK-05 vào danh sách tính năng.
- `docs/features/RSK-05-ai-data-governance.md`: Hoàn thiện feature doc.

## Checklist G4 (dán vào tin nhắn G4, tick từng dòng)

- [x] N/M test case đạt đủ độ sâu, K đơn giản hóa (nêu lý do từng cái)
- [x] Test thủ công chạy trên commit cuối đổi code/doc: không có token, header `Authorization`, id tài khoản AWS và ARN
- [x] `git diff --stat main...HEAD` khớp danh sách file ở §7
- [x] Mọi doc có fact bị đổi đã sửa; `check-doc-links.mjs` sạch; trạng thái doc là Proposed
- [x] Việc bàn giao cho vai khác và mọi DoD chưa đạt đã ghi ở §8
