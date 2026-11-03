```markdown
| # | Severity (blocking / should-fix / minor) | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|
| 1 | should-fix | §3 — caller/harness; §4 — regression; §5 — tương thích manual driver | Thiết kế chưa xử lý các caller đang giả định migration27 là migration cuối. Sau khi glob nạp migration116, `append-only.db-spec.ts` vẫn migrate toàn bộ rồi revert đúng một lần: TC-27-10 sẽ bỏ/tạo lại116 và so index sai; TC-27-11 thất bại tại assertion migration cuối; TC-27-12 có thể xanh nhưng chỉ kiểm revert/rerun116, không còn chứng minh trigger27 được gỡ rồi phục hồi. Manual driver27 cũng thất bại tại kiểm tra migration cuối. Đây là ảnh hưởng trực tiếp của việc thêm116, cần nằm trong scope thiết kế. | [data-source.ts:25](C:/Users/Admin/.codex/worktrees/dbs-parallel-20261102/DBS-116/backend/src/database/data-source.ts:25) nạp mọi migration; [append-only.db-spec.ts:100](C:/Users/Admin/.codex/worktrees/dbs-parallel-20261102/DBS-116/backend/test/db/append-only.db-spec.ts:100) migrate toàn bộ; các TC-27-10/11/12 tại dòng 330, 372, 413; [append-only.manual.ts:118](C:/Users/Admin/.codex/worktrees/dbs-parallel-20261102/DBS-116/backend/test/manual/append-only.manual.ts:118) yêu cầu migration cuối là27, sau CLI run tại dòng286; M-27-05 tại dòng332 cũng revert một lần. | Bổ sung hai file test/manual27 vào phạm vi tương thích. Chọn prefix hoặc hoàn tác các migration kế tiếp để mỗi chu kỳ thực sự up/down migration27; giữ nguyên assertion về trigger, dữ liệu và sequence. Thêm case regression chứng minh lifecycle27 vẫn kiểm đúng đối tượng khi116 tồn tại; tiếp tục có kiểm tra migration toàn bộ đến HEAD. Không cần sửa datasource hoặc migration27. |
| 2 | minor | §2.1; §3 — dữ liệu; §4 — TC-116-01 | Tài liệu yêu cầu “đúng 10 cột”, nhưng schema nguồn và chính bảng hợp đồng §2.1 chỉ có **9 cột**. Nếu triển khai assertion theo TC-116-01 hiện tại, migration đúng schema vẫn bị báo sai hoặc người triển khai phải tự suy đoán cột thứ mười. | [database-design.md:354](C:/Users/Admin/.codex/worktrees/dbs-parallel-20261102/DBS-116/docs/components/_shared/database-design.md:354), §4.9: `id`, `started_at`, `finished_at`, `status`, `total_debit`, `total_credit`, `total_balance`, `mismatched_accounts`, `details`; [feature doc:90](C:/Users/Admin/.codex/worktrees/dbs-parallel-20261102/DBS-116/docs/features/DBS-116-reconciliation-runs.md:90), dòng170 và TC-116-01 dòng202 đều ghi10. | Sửa cả ba chỗ thành9; TC-116-01 đối chiếu danh sách tên/thứ tự/kiểu/nullability/default cụ thể của9 cột. Không thêm cột mới. |

Verdict: REVISE
```

```markdown
| # | Severity (blocking / should-fix / minor) | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|

Verdict: APPROVE
```

## Review bổ sung fixture baseline

```markdown
| # | Severity (blocking / should-fix / minor) | Section of the doc | Finding | Evidence (file and section) | Suggested fix |
|---|---|---|---|---|---|

Verdict: APPROVE
```
