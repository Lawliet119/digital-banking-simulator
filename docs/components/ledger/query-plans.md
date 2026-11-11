# Kế hoạch thực thi của các truy vấn nóng (DBS-171)

> **Cập nhật:** 2026-11-11 · **Nguồn ngưỡng:** [database-design §7](../_shared/database-design.md#7-truy-vấn-nóng-phải-được-kiểm-chứng-bằng-explain) · **Feature doc:** [DBS-171](../../features/DBS-171-explain-hot-queries.md)

Mỗi truy vấn nóng của §7 được `EXPLAIN (ANALYZE, BUFFERS)` bằng **đúng câu SQL của service** (hằng số hoặc hàm được import, không chép tay) trên PostgreSQL 17 thật với dữ liệu sinh bằng `generate_series` và `VACUUM (ANALYZE)`. Test khẳng định hình dạng plan (index, không `Seq Scan`, không `Sort`); thời gian là ngưỡng trần có biên cho CI, số đo thật nằm ở cột «Số đo» và ở nơi được trỏ tới.

| Truy vấn (§7) | SQL thật | Test | Dữ liệu của test | Plan được khẳng định | Số đo |
|---|---|---|---|---|---|
| Hạn mức ngày | `SENT_TODAY_SQL` (`sync-guard.service.ts`) | `daily-limit.db-spec.ts` TC-84-01 | 100.000 dòng ghi nợ của một tài khoản + 100.000 dòng của 500 tài khoản khác (test chỉ khẳng định plan, không khẳng định thời gian) | `Index Only Scan`, `ledger_entries_daily_debit_idx`, `Index Cond` có `created_at >=`, `Heap Fetches` 0, không `Seq Scan` | 0,163 ms trên 1.000.400 dòng ([database-design §7.1](../_shared/database-design.md), DBS-84, ngưỡng 5 ms) |
| Lịch sử trang đầu, 20 dòng | `buildHistorySql` (`transaction-history.query.ts`) | `transaction-history-plan.db-spec.ts` | 100.000 dòng của tài khoản nóng + 100.000 dòng của 500 tài khoản khác, 730 ngày | `Index Scan` theo `ledger_entries_account_history_idx`, hướng `Forward`, không `Sort`, không `Seq Scan`, đọc ≤ 21 dòng | [database-design §7.2](../_shared/database-design.md) (DBS-87, ngưỡng 20 ms) |
| R2, R4, R5 (và R1) | `factQueries` và `TransferFacts` (`transfer-facts.ts`) | `transfer-facts.db-spec.ts` TC-109-05 | 40.000 giao dịch từ 400 tài khoản gửi | các index một phần `transfers_account_completed_idx` và `transfers_pair_completed_idx`, không `Seq Scan` trên `transfers`; tổng thời gian của R2 (median), R4 và các truy vấn tổng hợp R1/R5 ≤ 30 ms | [DBS-109](../../features/DBS-109-online-feature-provider.md) |
| Relay lấy 100 sự kiện chưa gửi | `PENDING_BATCH_SQL` (`outbox-relay.service.ts`) | `outbox-relay-plan.db-spec.ts` TC-171-01 | 400.000 dòng đã gửi + 1.000 chưa gửi; thử cả khi 50 id bị «parked» | `Index Scan` trên `outbox_unpublished_idx`, không `Seq Scan`, không `Sort`, đọc ≤ 101 dòng, dưới 500 block, trung vị 5 lần dưới 25 ms (biên CI) | **0,096 ms** (không parked) và **0,110 ms** (50 parked), 5 block, ngày 2026-11-11 |
| Audit theo `correlationId` | `buildAuditSearchSql` (`audit-search.query.ts`) | `audit-search.db-spec.ts` TC-103-18 | ít nhất 50.000 dòng `audit_log`, một dòng khớp | `Index Scan` trên `audit_log_correlation_idx` ở mọi lần chạy; cả 5 lần chạy ấm đều ≤ 10 ms | [database-design §7.2 (audit)](../_shared/database-design.md) và [DBS-135](../../features/DBS-135-trace-by-correlation-id.md) |

## Quyết định về chỉ mục

Không cần chỉ mục hay migration mới: cả năm plan đã dùng đúng index của §7. Truy vấn relay dùng `outbox_unpublished_idx ON outbox_events (id) WHERE published_at IS NULL` nên không đọc 400.000 dòng đã gửi, kể cả khi lọc thêm `event_type = ANY(...)` và `id <> ALL(...)`.

## Quy tắc rút ra (giữ nguyên từ DBS-84)

Điều kiện trên cột có index không được chứa hàm `VOLATILE` (`clock_timestamp()`, `random()`): nó chỉ thành `Filter`, không thành `Index Cond`; đưa «bây giờ» vào làm tham số.

## Giới hạn

- Số liệu 1.000.400 dòng của §7.1 và §7.2 là lần đo tay của DBS-84 và DBS-87; các test trong CI dùng dữ liệu nhỏ hơn (cột «Dữ liệu của test») để chạy trong vài chục giây.
- Thời gian trong test chỉ là ngưỡng trần; plan là điều test khẳng định.
- Chưa đo trên dữ liệu của generator fraud và chưa đo trên RDS thật (BL-240).
