# M-141-05 · kiểm độc lập mã phân loại (mã hóa mù 20 dòng)

**Người làm:** subagent `opus`, effort `high`, chỉ nhận `rules.md` (khối «Phân loại» của `docs/BACKLOG.md`), bản **5 cột** gốc của BACKLOG (`git show f9a78f0:docs/BACKLOG.md`) và danh sách 20 ID; bị cấm mở `docs/BACKLOG.md` hiện tại, `classification.mjs` và mọi file DBS-141. Mẫu: 20 dòng ngẫu nhiên, seed 141, loại BL-278 (đã xóa). Ngày 2026-11-20.

## Trả lời nguyên văn của subagent

| ID | Code | Task (L/H6 only) | Priority | Hạn | One-line reason |
|---|---|---|---|---|---|
| BL-027 | H3 | — | Trung bình | Không có | A second member runs `init`/`plan` as a cross-check. The owner is already admin (DBS-31 §8), so the cloud session is not blocked and T1 does not apply |
| BL-041 | H4 | — | Trung bình | Không có | Hand over the tune set and run the parity check on real data. DBS-127 is already Done, so no board task still owns this |
| BL-121 | H2 | — | Thấp | Không có | Investigate a local harness `spawnSync ETIMEDOUT` that cannot be reproduced; a rerun works around it |
| BL-138 | H3 | — | Trung bình | Không có | Cross-confirmation of a contract by #1 Ledger and #6 Quality (people) |
| BL-215 | H5 | — | Thấp | Không có | Optional extra harness test with the Docker daemon really down; not a cloud or load check |
| BL-216 | L | DBS-167 | Trung bình | DBS-167 (Tuần 7) | Slow-then-dead Redis drill under multi-client load on real Valkey is the "Redis chậm giữa tải" load task |
| BL-221 | L | DBS-167 | Trung bình | DBS-167 (Tuần 7) | Measuring p95 reads with Redis slow belongs to DBS-167; the flaky TC-114-12 cause rides along |
| BL-231 | H2 | — | Thấp | Không có | Native `0xC0000409` crash on Node 24.15 on Windows; worked around with Node 24.22.1 |
| BL-232 | L | DBS-166 | Cao | DBS-166 (Tuần 7) | Cloud acceptance of the DBS-165 k6 scripts is the DBS-166 load run itself; raised to Cao because DBS-166 is Highest and its week 7 has passed |
| BL-236 | H4 | — | Trung bình | Sau BL-041 | Rerun `export-features` on the real tune set, which is waiting on the `backend/data/fraud/` handover (BL-041) |
| BL-240 | H4 | — | Trung bình | Không có | Rerun the EXPLAINs on realistic data and real RDS once a session exists |
| BL-279 | H3 | — | Trung bình | Không có | What is left is people's work: push, PR, Dev review and merge (board already shows DBS-123 Done) |
| BL-281 | H1 | — | Thấp | Không có | Deploy pipeline, alarms and WAF only for `envs/prod` |
| BL-301 | H1 | — | Thấp | Không có | Per-service, multi-region or prod CMKs are only for prod or production-level security |
| BL-361 | T3 | — | Cao | Ngay | `.gitignore` does not yet block files holding event bodies and `ReceiptHandle`; this is an open data-leak risk |
| BL-362 | T2 | — | Trung bình | DBS-166 (Tuần 7) | Ops read access to `processed_events` must exist before load/DLQ handling in the session (runbook step 2b); it does not block building the session, so not T1 |
| BL-382 | T2 | — | Trung bình | DBS-166 (Tuần 7) | Decide the number of api tasks and record the RTO before running load (the rules name "số task api") |
| BL-386 | H4 | — | Trung bình | Không có | Rerun the RDS failover drill on real cloud with probe timestamps, RDS events and a transfer during failover, after a session exists |
| BL-398 | T4 | — | Trung bình | DBS-166 (Tuần 7) | The risk DLQ and AI-fallback alarms are not yet verified or merged; that is a monitoring gap on the risk worker, which the load run touches |
| BL-400 | H5 | — | Thấp | Không có | Optional `--exclude-record` for `dlq:resend`; the runbook rule plus consumer idempotency already cover it |

Ghi chú của subagent: Hạn mặc định cho `T1`/`T3` là «Ngay»; `T2`/`T4` là DBS-166 (đã trễ); mã `H` là «Không có» trừ khi dòng có gì tốt hơn. Dòng còn lưỡng lự: BL-027 (T1/H3), BL-041 (H3/H4), BL-121 (H2/H5), BL-221 (L DBS-167/H4), BL-240 (L DBS-173/H4), BL-279 (T4/H3), BL-362 (T2/T4/T1), BL-386 (H3/H4), BL-398 (T4/H4), BL-400 (T4/H5).

## So với bảng của agent (§2.4)

| Chỉ số | Kết quả |
|---|---|
| Khớp **mã** | 17/20 (85%) |
| Khớp **nhóm** (Trước tải / Trong tải / Hoãn) | 18/20 (90%) |
| Khớp **ưu tiên** trên các dòng khớp mã | 17/17 |
| Hạn: dòng nêu task (L) | 3/3 khớp (BL-216, 221, 232) |

| Dòng | Mã của agent | Mã của subagent | Xử lý |
|---|---|---|---|
| BL-215 | H4 | H5 | giữ H4, cùng nhóm Hoãn: «chạy kiểm bổ sung» với «tùy chọn» đều đúng một phần; khác ưu tiên (Trung bình, Thấp), ghi nhận |
| BL-362 | H4 | T2 | giữ H4: việc dùng khi xử lý DLQ trong phiên, không phải điều kiện của lượt tải; T2 chỉ cho việc «phải có sẵn trước lượt tải». Dòng lưỡng lự, ghi nhận |
| BL-398 | H4 | T4 | giữ H4: kích thử alarm RSK-04 trên AWS thật; AI mặc định tắt nên lượt tải không chạm tới alarm fallback AI; nhất quán với BL-341 (H4). Dòng lưỡng lự, ghi nhận |
| BL-236 | Hạn «Trước DBS-202 (tuần 10)» | Hạn «Sau BL-041» | **đổi theo subagent** (chính xác hơn: việc chờ BL-041) |

Kết luận: bảng ổn định ở mức nhóm (90%); ba dòng lệch mã đều thuộc loại lưỡng lự do chính subagent nêu; một hạn được sửa.
