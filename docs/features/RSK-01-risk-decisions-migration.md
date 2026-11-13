# RSK-01 · Migration `risk_decisions`: một dòng cho mọi TRANSFER, khóa ngoại ghép từ `fraud_flags`, quyền và append-only

> **Status:** Implemented · **Vai:** #4 Fraud (techlead làm thay theo yêu cầu) · **Cặp đôi review:** Dev · **Nhánh:** `feat/RSK-01-risk-decisions` · **PR:** — · **Cập nhật:** 2026-11-10

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 5, task fraud/AI thêm theo ADR-14. RSK-01 là phụ thuộc trực tiếp của DBS-111: consumer chấm điểm phải claim decision trước khi tạo cờ. Board không ghi Expect riêng; theo DoD, kỳ vọng là "bảng quyết định bất biến sẵn sàng để DBS-111 ghi".
- **DoD** (chép nguyên văn):
  1. Migration tạo risk_decisions theo schema §3.8 (khóa transfer_id, CHECK mode/ai_status/probability, tổng điểm vừa int) và thêm khóa ngoại ghép (transfer_id, rule_set_version) từ fraud_flags; revert chạy được
  2. Trigger chặn UPDATE/DELETE; role dbs_worker chỉ INSERT, dbs_api không ghi (khớp ma trận §8; cập nhật infra/scripts/db-roles.sql và test db-roles)
  3. Chốt và ghi hướng giữ dữ liệu (không phân vùng, hash partition hoặc bảng claim hẹp) sau khi đo kích thước dòng; deploy luân phiên không lỗi khóa ngoại
  4. Test DB trên PostgreSQL thật: hai claim cùng transfer_id chỉ một bên thắng, CHECK từ chối trạng thái sai
  5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc** (board không ghi; thực tế cần, tất cả đã có trên `main` 24fa3d0):
  - ADR-14, Accepted 2026-11-08 (BL-040).
  - Schema đích ở [FRAUD-API-01 §3.8](FRAUD-API-01-external-ai-decision.md#38-phụ-lục-schema-đề-xuất-bảng-quyết-định-risk-proposed-chưa-có-migration).
  - Migration fraud của DBS-58 (`1792713600000-CreateFraudStorage`).
  - Migration role của DBS-119 (`1793664000000-CreateDbRolesAndGrants`).
- **Đã có gì:**
  - `risk_rule_sets`, `fraud_flags`, `fraud_rule_hits` (DBS-58).
  - Hàm `forbid_mutation()` (DBS-27), ném `42501`.
  - Ma trận quyền `database-design.md` §8.1, `infra/scripts/db-roles.sql`, test `db-roles.db-spec.ts`.
  - **Chưa có writer nào trong `backend/src`** ghi `fraud_flags`: grep `INSERT INTO fraud_flags` trong `src` cho 0 kết quả. Chỉ các test chèn thẳng: `rule-set-repository`, `transaction-history`, `transfer-status`, `support/db-role-permissions.ts`.
- **Baseline:** code trên `main` 24fa3d0 giống commit `9d90d51` của DBS-159, chạy 2026-11-10.
  - `lint:check` và `typecheck` sạch.
  - Unit: 98 suite / 1.767 test.
  - `test:e2e`: 17 suite / 163 test.
  - `test:db`: 60 suite / 863 test.
- **Ngoài phạm vi:**
  - Consumer ghi decision và cờ: DBS-111.
  - Constraint trigger kiểm bất biến liên bảng: `rule_score = sum(hits.weight)`, `fraud_flags.score = rule_score + ai_applied_weight`, mức cờ theo threshold, chỉ `COMPLETED`/`TRANSFER`. FRAUD-API-01 §3.8 gọi đây là "migration tương lai"; chuyển sang BL mới. **Đã làm ở BL-223** (migration `1795000006000-AddRiskInvariantTriggers`, test `test/db/risk-invariants.db-spec.ts`; xem `database-design.md` §11 mục 10). Hệ quả cho RSK-01: các test chèn thẳng `fraud_flags` và **commit** phải ghi decision, cờ, hit nhất quán (`insertFlaggedDecision` trong `test/support/risk-decisions.ts`); test chỉ rollback không bị ảnh hưởng.
  - Lời gọi AI: task tích hợp riêng.
- **Dòng BACKLOG liên quan:**
  - BL-048 (FK ghép và rolling deploy) và BL-049 (retention) được nhận vào phạm vi và xóa khi xong.
  - BL-021 và BL-047 đã đóng ở DBS-58, không còn trong BACKLOG.
- **Quyết định ở G1** (agent tự quyết):
  1. Người dùng (techlead) yêu cầu DBS-111. RSK-01 là phụ thuộc chưa xong và DBS-111 không được dựng stub, nên làm RSK-01 trước, trong PR riêng.
  2. **FK ghép bằng `ALTER TABLE fraud_flags`.** §3.8 viết "FK inline, không ALTER trên bảng đã có dữ liệu", nhưng `fraud_flags` đã tồn tại từ DBS-58. Vì không có writer, bảng đang rỗng ở mọi môi trường. Migration khóa rồi kiểm không có cờ mồ côi trước khi `ADD CONSTRAINT`; có cờ mồ côi thì dừng với `55000`, không bịa decision.
  3. Quyền: `dbs_worker` S I, `dbs_api` S (theo §3.8 và DoD). Không **role ứng dụng** nào có U/D/TRUNCATE. `dbs_migrator` nhận ALL qua default privileges của bước 7 nhưng bị trigger chặn.
  4. Board vẫn ghi RSK-01 To Do; người dùng chuyển sang In Progress.

## 2. Hành vi

Task không có API. Mục này mô tả những gì DB chấp nhận và từ chối.

**Bảng `risk_decisions`:** đúng SQL ở FRAUD-API-01 §3.8, nhưng **mọi ràng buộc đặt tên tường minh** theo quy ước `database-design.md` §11:

| Ràng buộc | Nội dung |
|---|---|
| `risk_decisions_pkey` | PK `transfer_id` |
| `risk_decisions_transfer_id_fkey` | → `transfers(id)` RESTRICT |
| `risk_decisions_rule_set_version_fkey` | → `risk_rule_sets(version)` RESTRICT |
| `risk_decisions_transfer_version` | UNIQUE `(transfer_id, rule_set_version)`, đích của FK ghép |
| `risk_decisions_mode_check` | `mode IN ('rule_only','rules_with_external_ai')` |
| `risk_decisions_rule_score_check` | `rule_score >= 0` |
| `risk_decisions_feature_snapshot_check` | `jsonb_typeof = 'object'` |
| `risk_decisions_ai_status_check` | 7 giá trị (viết hoa) |
| `risk_decisions_ai_applied_weight_check` | `>= 0` |
| `risk_decisions_rubric_sha256_check`, `risk_decisions_input_sha256_check` | `^[0-9a-f]{64}$` |
| `risk_decisions_total_fits_int` | `rule_score + ai_applied_weight <= 2147483647` |
| `risk_decisions_mode_metadata` | ba nhánh của §3.8 |
| `risk_decisions_status_probability` | p ∈ [0,1] chỉ khi `SUCCEEDED`; còn lại p null và weight 0 |

`feature_snapshot`: DB chỉ ép kiểu object. Giữ allowlist §2.3 (không ID, tên, email, ghi chú, nhãn) là trách nhiệm của writer, tức DBS-111, bàn giao ở §8.

`probability` là `double precision`, nên cần nói rõ: `NaN` **không** thỏa `p >= 0 AND p <= 1`, vì PostgreSQL xếp NaN lớn hơn mọi số nên `NaN <= 1` là false. Vì vậy `NaN`, `Infinity`, `-Infinity` đều bị `risk_decisions_status_probability` từ chối, còn `-0` được nhận. Test khẳng định đúng từng giá trị.

**Claim:** `INSERT … ON CONFLICT DO NOTHING RETURNING transfer_id`, **không chỉ định conflict target**. Lý do: bảng có hai unique index (PK và `risk_decisions_transfer_version`). Nếu target chỉ là `(transfer_id)` thì index kia vẫn kiểm kiểu thường, và hai phiên cùng lọt qua bước kiểm trước có thể khiến bên thua nhận `23505` thay vì 0 dòng. Không target thì mọi unique index đều là arbiter. Hệ quả:
- Hai transaction cùng `transfer_id`: đúng một bên nhận 1 dòng.
- Bên kia nhận 0 dòng sau khi bên thắng commit. Nếu bên thắng rollback, bên kia thắng.
- Không có lỗi `23505` trong mọi trường hợp. Ràng buộc này bàn giao cho DBS-111.

**FK ghép mới trên `fraud_flags`:** `fraud_flags_decision_fkey (transfer_id, rule_set_version) REFERENCES risk_decisions (transfer_id, rule_set_version) ON DELETE RESTRICT`. Cờ không có decision, hoặc có decision nhưng khác version, bị từ chối `23503`. **Mới trên `fraud_rule_hits`:** `fraud_rule_hits_weight_check CHECK (weight >= 0)`.

**Append-only:** trigger `risk_decisions_append_only` (BEFORE UPDATE OR DELETE) và `risk_decisions_no_truncate` (BEFORE TRUNCATE) gọi `forbid_mutation()` → `42501 … is not allowed (append-only)`, với mọi role, kể cả owner, `dbs_migrator` và superuser. `TRUNCATE risk_decisions` không kèm CASCADE dừng trước ở `0A000`, vì bảng có FK tham chiếu tới. Test dùng `TRUNCATE … CASCADE` để tới được trigger.

**Quyền (thêm vào ma trận §8.1):** `risk_decisions`: `dbs_api` S, `dbs_worker` S I. `dbs_api` hoặc `dbs_worker` gọi UPDATE/DELETE/TRUNCATE nhận `42501 permission denied`.

**Ví dụ bị từ chối** (`23514` kèm tên constraint, mỗi probe dựng trên một dòng nền hợp lệ và ghi đủ các ràng buộc nó vi phạm):

| Dòng nền | Đổi | Ràng buộc |
|---|---|---|
| `rule_only` | `mode='hybrid'` | `risk_decisions_mode_check` (cũng vi phạm `mode_metadata`; PostgreSQL báo theo thứ tự tên, test chấp nhận một trong hai và ghi rõ) |
| `rule_only` | `mode='RULE_ONLY'` | như trên |
| `rule_only` | `ai_status='SUCCEEDED'` | `risk_decisions_status_probability` hoặc `mode_metadata` (vi phạm cả hai) |
| `rule_only` | `rule_score=-1` | `risk_decisions_rule_score_check` |
| `rule_only` | `feature_snapshot='[]'` | `risk_decisions_feature_snapshot_check` |
| AI `SUCCEEDED` | `probability=1.2`, `NaN`, `Infinity`, `-Infinity`, `NULL` | `risk_decisions_status_probability` |
| AI `UNAVAILABLE` (p null) | `ai_status='unavailable'` | `risk_decisions_ai_status_check` |
| AI `SUCCEEDED` | `rubric_sha256='ABC'` / `input_sha256` viết hoa | `risk_decisions_rubric_sha256_check` / `risk_decisions_input_sha256_check` |
| AI `SUCCEEDED` | `ai_applied_weight=-1` | `risk_decisions_ai_applied_weight_check` |
| AI `SUCCEEDED` | `rule_score=2147483647`, `ai_applied_weight=1` | `risk_decisions_total_fits_int` |
| AI `SUCCEEDED` | `provider=NULL` | `risk_decisions_mode_metadata` |
| AI `UNAVAILABLE` | `ai_applied_weight=5` | `risk_decisions_status_probability` |

**Migration `up`:**
- `SET LOCAL lock_timeout = '5s'`.
- `LOCK TABLE fraud_rule_hits IN ACCESS EXCLUSIVE MODE` (ADD CHECK cần mức này; khóa ngay từ đầu để không nâng cấp khóa giữa chừng) và `LOCK TABLE fraud_flags IN SHARE ROW EXCLUSIVE MODE` (đủ cho ADD FOREIGN KEY), rồi đếm cờ. Có cờ thì dừng `55000`; cả transaction migration rollback, gồm migration chưa chạy khác trong cùng lượt (`transaction: 'all'`).
- Không có cờ thì tạo bảng, trigger, FK ghép, CHECK weight, grant (chỉ khi role tồn tại).

**Revert (`down`):**
- Chỉ chạy trong transaction READ COMMITTED, giống DBS-58.
- Khóa ACCESS EXCLUSIVE `fraud_rule_hits`, `fraud_flags`, `risk_decisions`.
- Từ chối `55000` nếu `risk_decisions` có dòng, vì xóa decision là mất bằng chứng.
- Rỗng thì bỏ CHECK weight, FK ghép, trigger, bảng. Grant đi theo bảng.

**Retention (DoD #3):**
- Đo `pg_column_size` của dòng `rule_only` và dòng `rules_with_external_ai`, với `feature_snapshot` đủ key allowlist §2.3 và giá trị cỡ thật (chuỗi tiền canonical cỡ lớn).
- Đo `pg_total_relation_size` sau 10.000 dòng (heap, PK, UNIQUE), rồi tính GB/ngày ở 120 RPS (NFR-SCAL-01) và ở tải demo.
- Chốt hướng ghi vào ADR-14 và `database-design.md` §10.
- Hướng dự kiến là **không phân vùng**, kèm ngưỡng xem lại theo kích thước bảng.

**Rolling deploy (DoD #3):**
- Bản app trước RSK-01 không ghi `fraud_flags`, nên chạy song song với schema mới không bao giờ gặp `23503`.
- Writer đầu tiên là DBS-111, ghi decision trước cờ trong cùng transaction.
- Mốc rollback: lùi app về trước DBS-111 an toàn vì không còn writer. Lùi migration chỉ được khi `risk_decisions` rỗng.

## 3. Kiến trúc

- **Vị trí:**
  - Migration `backend/src/database/migrations/1793836800000-CreateRiskDecisions.ts`, chạy sau `1793750400000-AddNotificationLogCorrelationId` (thứ tự thực tế của thư mục).
  - Không code ứng dụng nào đổi.
- **Grant trong migration:** `DO $$ … IF EXISTS (pg_roles …)` rồi `GRANT SELECT ON risk_decisions TO dbs_api; GRANT SELECT, INSERT … TO dbs_worker`.
  - Hệ quả biết trước: chạy lại riêng bước 7 (`REVOKE ALL ON ALL TABLES`) sẽ xóa hai grant này. Cùng tính chất với mọi bảng tạo sau bước 7; ghi ở §8 và `database-design.md` §11.
- **`infra/scripts/db-roles.sql`:** thêm grant bọc trong `DO $$ BEGIN IF to_regclass('public.risk_decisions') IS NOT NULL THEN … END IF; END $$`, để file chạy được cả trên DB chỉ tới bước 7 (TC-119-01).
- **Test support:** thêm `backend/test/support/risk-decisions.ts` với `insertRuleOnlyDecision(runner, transferId, { version = 1, eventId? })`. Hàm chèn một dòng `rule_only`/`DISABLED`, snapshot `{}` đủ hợp lệ cho test. Các test đang chèn `fraud_flags` gọi hàm này trước, bằng kết nối owner:
  - `rule-set-repository`, `transaction-history`, `transfer-status`: trong cùng runner.
  - `support/db-role-permissions.ts`: owner **commit** decision cho các transfer của fixture ngay lúc dựng fixture. Dòng tồn tại vĩnh viễn trong container riêng. Nhờ vậy `dbs_worker` và `dbs_api` nhìn thấy decision trong transaction rollback của họ, và lỗi ACL `42501` không bị nhầm với FK `23503`.
- **Test revert phải ghim mốc:** `notification-correlation.db-spec.ts` TC-134-02 dùng `migrate` đủ rồi `undoLast`. Đổi sang `migrateThrough(db.url, 'AddNotificationLogCorrelationId1793750400000')`. Các file revert khác đã dùng `migrateThrough` hoặc đếm số lần revert: kiểm bằng `npm run test:db` toàn bộ.
- **Thay đổi cấp hệ thống:**
  - `database-design.md`:
    - §4.8: thêm bảng, bỏ ghi chú "chưa có migration", sửa câu "tổng `weight` luôn bằng `score`" thành bất biến ADR-14.
    - §8.1: ma trận.
    - §8.3: trigger.
    - §10: retention.
    - §11: thứ tự thật, thêm cả 1793750400000.
  - ADR-14: mục dung lượng ghi hướng đã chốt.
  - BACKLOG: xóa BL-048, BL-049; thêm BL cho constraint trigger liên bảng.

## 4. Test cases tự động

File mới: `backend/test/db/risk-decisions.db-spec.ts`, chạy trên PostgreSQL thật (temp DB). Dữ liệu `transfers` bằng SQL seed (task là migration).

| ID | Truy vết | Given · When · Then | Mong đợi |
|---|---|---|---|
| TC-RSK01-01 | DoD #1 | Migrate đủ: `pg_constraint` có đúng tập tên ở §2 cộng `fraud_flags_decision_fkey`, `fraud_rule_hits_weight_check`; cột, kiểu, NOT NULL khớp §3.8 | khớp |
| TC-RSK01-02 | DoD #1, #4 | Dòng hợp lệ: `rule_only`; AI `SUCCEEDED` với p = 0, 1, `-0`; AI `UNAVAILABLE`; `CONFIG_INVALID` (provider/hash null) | chèn được |
| TC-RSK01-03 | DoD #1, #4 | Mỗi probe ở bảng §2, trong savepoint riêng | `23514` + tên ràng buộc mong đợi (probe vi phạm hai thì chấp nhận đúng tập hai tên) |
| TC-RSK01-04a | DoD #4 | A `BEGIN` + claim, giữ; B claim cùng `transfer_id`, khác `event_id`, chờ trên `Lock` (`pg_stat_activity`); A commit | A 1 dòng, B 0 dòng, không lỗi; dòng mang `event_id` của A |
| TC-RSK01-04b | DoD #4 | Như 04a nhưng A rollback | B 1 dòng; dòng mang `event_id` của B |
| TC-RSK01-04c | DoD #4 | 20 transfer × 2 kết nối claim song song (`Promise.all`, không giữ khóa trước) | mỗi transfer đúng 1 thắng, 0 lỗi `23505`. Đây là smoke test: cửa sổ race tính bằng micro giây nên ca này không phân biệt claim có target hay không; bằng chứng cho "không target" là lập luận ở §2 cộng tài liệu PostgreSQL về `conflict_target` |
| TC-RSK01-05 | DoD #1 | Cờ không có decision; cờ có decision nhưng khác `rule_set_version` | `23503 fraud_flags_decision_fkey` |
| TC-RSK01-06 | DoD #1 | `fraud_rule_hits.weight = -1` (cờ và decision hợp lệ) | `23514 fraud_rule_hits_weight_check` |
| TC-RSK01-07 | DoD #2 | Owner UPDATE, DELETE, `TRUNCATE … CASCADE`; thêm owner NOSUPERUSER (như TC-58-04) | `42501` với thông điệp append-only; dòng còn nguyên. `TRUNCATE` không CASCADE → `0A000` |
| TC-RSK01-08 | DoD #2 | `SET ROLE dbs_worker`: SELECT, INSERT được; UPDATE, DELETE, TRUNCATE → `42501 permission denied`. `SET ROLE dbs_api`: SELECT được; INSERT → `42501` | đúng ma trận |
| TC-RSK01-09 | DoD #1 | Revert khi rỗng: không còn bảng, FK ghép, CHECK weight, trigger; migrate lại được. Revert khi có 1 dòng | lần đầu thành công; lần sau `55000`, dữ liệu còn |
| TC-RSK01-10 | DoD #1 | Migrate tới 1793750400000, chèn một cờ (mồ côi theo nghĩa mới), chạy RSK-01 | `55000`; bảng `migrations` không có RSK-01, `risk_decisions` không tồn tại |
| TC-RSK01-11 | DoD #2 | `db-roles.db-spec.ts`: TC-119-01 (db-roles.sql trên DB tới bước 7) vẫn xanh; thêm ca chạy db-roles.sql trên DB migrate đủ → `risk_decisions` có S cho `dbs_api`, S I cho `dbs_worker`; TC-119-05 thêm `risk_decisions` với `dbs_migrator` (UPDATE/DELETE/TRUNCATE CASCADE → trigger `42501`) | xanh |
| TC-RSK01-12 | DoD #3 | Đo `pg_column_size` hai dạng dòng (snapshot allowlist §2.3) và `pg_total_relation_size` sau 10.000 dòng; in số để ghi §8 | số đo thật |
| quy trình | DoD #3 (rolling) | Grep `fraud_flags` trong `backend/src`: chỉ SELECT và UPDATE review, không INSERT; ghi §8 | — |
| quy trình | DoD #5 | PR, CI, bảng đối chiếu | — |

**Test hiện có phải sửa và phải xanh:**
- Chèn decision trước cờ: `rule-set-repository`, `transaction-history`, `transfer-status`, `db-role-permissions`.
- Ghim mốc revert: `notification-correlation` TC-134-02.
- Cuối cùng: toàn bộ `npm run test:db` xanh.

## 5. Test thủ công

Chạy CLI migration thật trên database thật và nhìn kết quả bằng `psql` (qua `docker exec dbs63-fix-pg psql -U test -d banking_rsk01`).

Chuẩn bị (từ `backend/`):
- Tạo database: `docker exec dbs63-fix-pg psql -U test -d postgres -c "CREATE DATABASE banking_rsk01"`.
- `export DATABASE_URL=postgres://test:test@localhost:55433/banking_rsk01`.

Dữ liệu `users`, `customers`, `accounts`, `transfers` dùng **seed SQL**.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-RSK01-01 | `npm run migration:run`; `\d risk_decisions`, `\d fraud_flags`, `\d fraud_rule_hits` | Bảng đủ cột và ràng buộc có tên; `fraud_flags_decision_fkey`; `fraud_rule_hits_weight_check` |
| M-RSK01-02 | Hai phiên psql: phiên 1 `BEGIN; INSERT … ON CONFLICT DO NOTHING RETURNING transfer_id;` (giữ), phiên 2 cùng lệnh (chờ), phiên 1 `COMMIT` | Phiên 1 trả 1 dòng; phiên 2 trả 0 dòng sau khi phiên 1 commit |
| M-RSK01-03 | Chèn cờ cho transfer **không** có decision | `23503 fraud_flags_decision_fkey` |
| M-RSK01-04 | Owner `UPDATE`, `DELETE`, `TRUNCATE risk_decisions CASCADE` | `42501 … is not allowed (append-only)` |
| M-RSK01-05 | `SET ROLE dbs_worker; INSERT` một decision → được; `SET ROLE dbs_api; INSERT` → `42501` | đúng ma trận |
| M-RSK01-06 | `npm run migration:revert` khi bảng có dòng → `55000`. DB mới: `migration:run`, `migration:revert` (rỗng), `migration:run` lại | lần đầu bị từ chối; khi rỗng revert sạch, chạy lại thành công |
| M-RSK01-07 | Chèn 10.000 decision (snapshot allowlist), `pg_total_relation_size`, `pg_column_size` | số đo ghi vào §8, `database-design.md` §10 và ADR-14 |

## 6. Domain review (AI)

**Reviewer:** subagent general-purpose, model Opus (effort medium), 2026-11-10.
- **Vòng 1:** 16 phát hiện (blocking 2, should-fix 5, minor 9), verdict REVISE · [nguyên văn](screenshots/RSK-01/domain-review.md).
- **Vòng 2:** 16/16 đã xử lý, 4 minor mới đã sửa, verdict **APPROVE** · [nguyên văn](screenshots/RSK-01/domain-review-r2.md).

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | `db-roles.sql` grant bảng chưa có làm TC-119-01 đỏ | đã sửa §3: bọc `to_regclass`; TC-RSK01-11 |
| 2 | blocking | TC-134-02 `undoLast` sẽ hoàn tác RSK-01 | đã sửa §3/§4: ghim `migrateThrough` |
| 3 | should-fix | `ON CONFLICT (transfer_id)` để lọt `23505` từ unique index thứ hai | đã sửa §2: claim không target; TC-RSK01-04c; bàn giao DBS-111 |
| 4 | should-fix | TRUNCATE không CASCADE dừng ở `0A000` | đã sửa §2/§4/§5 |
| 5 | should-fix | Fixture role cần decision đã commit | đã sửa §3 |
| 6 | should-fix | Tên ràng buộc phải tường minh | đã sửa §2 (bảng tên), TC-RSK01-01 |
| 7 | should-fix | BL-049 cần ghi vào ADR; snapshot đo phải theo allowlist | đã sửa §2/§3/§4 |
| 8 | minor | Probe vi phạm hai ràng buộc | đã sửa bảng probe, dòng nền rõ |
| 9 | minor | Thiếu NaN/Infinity/-0, enum hoa thường, rollback race | đã thêm TC-02/03/04b |
| 10 | minor | `dbs_migrator` có ALL qua default privileges | đã sửa §1 QĐ3; TC-119-05 thêm bảng |
| 11 | minor | DB không ép allowlist | đã ghi §2; bàn giao DBS-111 |
| 12 | minor | BL-021/047 đã đóng | đã sửa §1 |
| 13 | minor | Câu "tổng weight = score" trong §4.8 | đã đưa vào danh sách sửa §3 |
| 14 | minor | `lock_timeout`, khóa trước đếm, SQLSTATE TC-10 | đã sửa §2 "Migration `up`", TC-10 |
| 15 | minor | Thứ tự migration thực tế | đã sửa §3 |
| 16 | minor | Thiếu bước thủ công worker INSERT, `23503`, TRUNCATE; lệnh tạo DB | đã thêm M-03/04/05 và chuẩn bị |
| N1 (vòng 2) | minor | Câu NaN tự mâu thuẫn | đã sửa |
| N2 (vòng 2) | minor | Nâng cấp khóa `fraud_rule_hits` có thể deadlock | đã sửa: ACCESS EXCLUSIVE ngay đầu `up` |
| N3 (vòng 2) | minor | 04c không phân biệt hai cách claim | đã ghi rõ là smoke test |
| N4 (vòng 2) | minor | Probe `succeeded` vi phạm hai ràng buộc | đã đổi dòng nền sang `UNAVAILABLE`; sửa câu dẫn |

**Quyết định ở G2** (agent tự quyết): ghi nhận, không sửa, việc chạy lại riêng bước 7 sẽ xóa grant của bảng tạo sau nó (phát hiện ngoài lề của #1). Đây là tính chất chung của bước 7 với mọi bảng tạo sau, không riêng RSK-01; đã ghi ở §3 và sẽ ghi `database-design.md` §11. Vòng 2 APPROVE.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước | Kết quả đỏ (điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `backend/test/db/risk-decisions.db-spec.ts`, `backend/test/support/risk-decisions.ts` | TC-RSK01-01..10, 12 | | `env -u DATABASE_URL npm run test:db -- --runInBand --runTestsByPath test/db/risk-decisions.db-spec.ts` | (cùng commit bước 2) |
| 2 | `backend/src/database/migrations/1793836800000-CreateRiskDecisions.ts` | như trên → xanh | | như trên | `feat(database): risk_decisions table, composite flag FK and grants (RSK-01)` |
| 3 | `rule-set-repository`, `transaction-history`, `transfer-status` db-spec, `support/db-role-permissions.ts`, `notification-correlation.db-spec.ts` | các test hiện có đỏ dưới FK mới / undoLast | | `npm run test:db -- --runTestsByPath <5 file>` | `test(database): seed a decision before each flag; pin TC-134-02 (RSK-01)` |
| 4 | `infra/scripts/db-roles.sql`, `backend/test/db/db-roles.db-spec.ts` | TC-RSK01-11 | | `npm run test:db -- --runTestsByPath test/db/db-roles.db-spec.ts` | `feat(infra): grant risk_decisions in db-roles.sql (RSK-01)` |
| 5 | `docs/components/_shared/database-design.md`, `docs/adr/0014-fraud-rules-external-ai.md`, `docs/BACKLOG.md`, `docs/features/README.md`, doc này, `screenshots/RSK-01/` | — | — | `check-doc-links.mjs`; toàn bộ `npm run test:db` | `docs(risk): RSK-01 schema, grants and retention decision` |

Quét giới hạn và DoD: DoD #1 → bước 1–2; DoD #2 → bước 2, 4; DoD #3 retention → TC-12 + bước 5 (ADR-14, §10), rolling → §8 grep; DoD #4 → TC-03/04. BL-048, BL-049 xóa ở bước 5; BL mới cho constraint trigger liên bảng; bàn giao DBS-111 (claim không target, allowlist snapshot). Không file nào ngoài bảng.

**Rủi ro:** test revert khác dựa vào "migration cuối" có thể đỏ → chạy toàn bộ `test:db` trước bước 5, ghim mốc nếu cần (gate phụ ghi §8). **Cách lùi:** migration có `down` có guard; revert PR khi bảng rỗng.

**Quyết định ở G3** (agent tự quyết): bước 1 và 2 cùng commit (test đỏ ghi ở cột kết quả, rồi migration làm xanh), để không có commit đỏ trên nhánh.

## 8. Kết quả

- **Lệnh kiểm tra** (từ `backend/`, trên `e688e10`):
  - `lint:check`, `typecheck`: sạch.
  - `npm test`: 98 suite / 1.767 test.
  - `test:e2e`: 17 suite / 163 test.
  - `test:db` toàn bộ (Testcontainers PostgreSQL 17): 61 suite / 879 test đạt, 690 s.
  - `check-doc-links`: 0 link hỏng.
  - Không có `.skip`, `.only` hay `.todo`.
- **Đỏ trước, xanh sau:**
  - Chạy `risk-decisions.db-spec.ts` trước khi có migration: 14/14 đỏ (`relation "risk_decisions" does not exist`). Sau khi có migration: 14/14 xanh. Lần chạy đầu có 1 ca đỏ do lỗi của chính test (`max(name)` theo thứ tự chữ), đã sửa thành `ORDER BY timestamp`.
  - Các test hiện có đỏ đúng dự đoán của review: 7 ca trong 5 file (`db-role-permissions` ×3, `transaction-history`, `transfer-status`, `rule-set-repository`, `notification-correlation` TC-134-02). Sau khi chèn decision trước cờ và ghim mốc revert, cả 5 file xanh.
  - `db-roles.db-spec.ts`: 11/11, gồm TC-RSK01-11a/b.
- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-RSK01-01 | `risk-decisions.db-spec.ts` › TC-RSK01-01 | đạt: 14 ràng buộc tên `risk_decisions_*`, đúng 16 cột, định nghĩa FK ghép |
| TC-RSK01-02 | › TC-RSK01-02 | đạt (`rule_only`, AI p = 0/1/-0, `UNAVAILABLE`, `CONFIG_INVALID`) |
| TC-RSK01-03 | › TC-RSK01-03 | đạt: 17 probe, mỗi probe `23514` và tên nằm trong tập mong đợi |
| TC-RSK01-04a/b | › TC-RSK01-04a, 04b | đạt: bên chờ `Lock` nhận 0 dòng khi A commit, thắng khi A rollback |
| TC-RSK01-04c | › TC-RSK01-04c | đạt (smoke, như ghi ở §4: không phân biệt claim có target hay không) |
| TC-RSK01-05 | › TC-RSK01-05 | đạt (`23503 fraud_flags_decision_fkey` cả khi thiếu decision lẫn khi khác version) |
| TC-RSK01-06 | › TC-RSK01-06 | đạt |
| TC-RSK01-07 | › TC-RSK01-07 (owner superuser) và › TC-RSK01-07 non-superuser owner | đạt (`42501` append-only; `TRUNCATE` không CASCADE → `0A000`) |
| TC-RSK01-08 | › TC-RSK01-08 | đạt |
| TC-RSK01-09 | › TC-RSK01-09 | đạt |
| TC-RSK01-10 | › TC-RSK01-10 | đạt (`55000`, migration mới nhất vẫn là `AddNotificationLogCorrelationId1793750400000`) |
| TC-RSK01-11 | `db-roles.db-spec.ts` › TC-119-01 (db-roles.sql trên DB tới bước 7), › TC-RSK01-11a, › TC-RSK01-11b | đạt |
| TC-RSK01-12 | › TC-RSK01-12 | đạt; số đo ở dưới |
| DoD #3 rolling | grep `INSERT INTO fraud_flags` trong `backend/src`: 0 kết quả | đạt: không có writer cũ nào gặp `23503` |

- **Test thủ công** chạy trên container `dbs63-fix-pg`, DB `banking_rsk01`, dùng CLI migration thật và `psql`; dữ liệu nền là **seed SQL**. Output thô ở [manual-test.txt](screenshots/RSK-01/manual-test.txt), dòng đầu là SHA `e688e10`.

| Bước | Phản hồi thật (rút gọn) | Kết quả |
|---|---|---|
| M-RSK01-01 | `Migration CreateRiskDecisions1793836800000 has been executed successfully`; `\d risk_decisions` đủ 16 cột, 14 ràng buộc tên tường minh, 2 trigger, "Referenced by fraud_flags_decision_fkey"; `fraud_rule_hits_weight_check CHECK ((weight >= 0))` | đạt |
| M-RSK01-02 | Phiên 2 bắt đầu 01:49:54.425, trả về 01:49:56.621 (chờ phiên 1). Phiên 1 `INSERT 0 1`, phiên 2 `INSERT 0 0`, `(0 rows)`; bảng có 1 dòng mang `event_id` của phiên 1 | đạt |
| M-RSK01-03 | Cờ không có decision → `violates foreign key constraint "fraud_flags_decision_fkey"`; cờ có decision → `INSERT 0 1` | đạt |
| M-RSK01-04 | UPDATE, DELETE, `TRUNCATE … CASCADE` → `… is not allowed (append-only)`, context `forbid_mutation()`; `TRUNCATE` không CASCADE → `cannot truncate a table referenced in a foreign key constraint` | đạt |
| M-RSK01-05 | `dbs_worker` INSERT → 1 dòng (rollback); `dbs_api` INSERT → `permission denied for table risk_decisions`; `dbs_api` SELECT → `1` | đạt |
| M-RSK01-06 | Revert khi có dòng → `code: '55000'`, migration và dòng còn nguyên. DB mới: run → revert (`reverted successfully`, không còn bảng và FK) → run lại thành công | đạt |
| M-RSK01-07 | 10.000 dòng, trung bình 480 B/dòng, heap 5.000 kB, index 984 kB, 616 B/dòng tổng | đạt |

- **Retention (DoD #3), đã chốt:**
  - Số đo: dòng `rule_only` với snapshot allowlist §2.3 là 480 B, dòng AI là 696 B. Bảng 10.000 dòng cộng PK và UNIQUE là 616 B/dòng.
  - Dự phóng: 120 RPS **liên tục** (đỉnh NFR) là 10,4 triệu dòng/ngày, ≈ 6,4 GB/ngày. Tải demo (≤ 50.000 TRANSFER/ngày) ≈ 31 MB/ngày.
  - **Hướng chọn: không phân vùng, giữ vĩnh viễn**, vì:
    - decision là bằng chứng append-only, nên không có dữ liệu nào được bỏ theo tuổi;
    - hash partition chỉ dàn tải, không giảm dung lượng;
    - bảng claim hẹp thêm một bảng và một FK nữa mà chưa có nhu cầu ở quy mô dự án.
  - Ngưỡng xem lại: bảng vượt 100 GB, hoặc lưu lượng thật vượt 1 triệu TRANSFER/ngày kéo dài.
  - Ghi ở ADR-14 mục 3 và `database-design.md` §10.
- **Rolling deploy (DoD #3):**
  - Không có writer `fraud_flags` trong `src` (grep 0 kết quả), nên bản app cũ chạy song song với schema mới không gặp `23503`.
  - Migration tự từ chối nếu có cờ mồ côi (TC-RSK01-10, `55000`).
  - Mốc rollback: lùi app về trước DBS-111 an toàn. Lùi migration chỉ khi bảng rỗng (TC-RSK01-09).
- **Phạm vi so với §7:** các file trong `git diff --stat` đều thuộc 5 bước của §7, cộng thêm hai file:
  - `backend/src/modules/risk/README.md`: câu "`risk_decisions` chưa được nối" đã lỗi thời.
  - `docs/features/README.md`: thêm dòng RSK-01.
  - Không có file code ngoài kế hoạch.
- **Ảnh chụp** (dựng từ chính `manual-test.txt`):

![Claim song song và FK ghép](screenshots/RSK-01/01-claim-race-and-flag-fk.png)

![Append-only và quyền](screenshots/RSK-01/02-append-only-and-roles.png)

![Revert và kích thước](screenshots/RSK-01/03-revert-and-size.png)

- **Lệch so với kế hoạch:**
  1. TC-RSK01-11 tách thành 11a (ma trận sau khi chạy `db-roles.sql`) và 11b (`dbs_migrator` bị trigger chặn). 11b dùng temp DB riêng: chèn transfer vào DB dùng chung của `db-roles.db-spec.ts` sẽ làm lệch kiểm đối soát và bất biến chạy sau trong cùng file. Agent tự quyết trước khi viết.
  2. Kiểu `Runner` trong helper được nới thành `{ query(sql, args) }` để nhận cả `DataSource` của fixture role.
- **Bàn giao cho vai khác:**
  - **BL-223** (Fraud và Dev migration): constraint trigger cho bất biến liên bảng.
  - **BL-224** (Fraud, DBS-111): claim không target, kiểm snapshot theo allowlist, ghi decision trước cờ.
  - Chạy lại riêng bước 7 sẽ xóa quyền của các bảng tạo sau nó, nên phải chạy lại `db-roles.sql`. Đã ghi vào `database-design.md` §11; không thêm BL vì đây là quy trình vận hành đã có (đầu `db-roles.sql` đã ghi "run AFTER every `migration:run`").

## 9. Tài liệu đã cập nhật

- `docs/components/_shared/database-design.md`:
  - Ghi chú đầu trang: đã có migration.
  - §4.8: mục `risk_decisions`; sửa câu "tổng weight luôn bằng score" theo bất biến ADR-14.
  - §8.1: dòng ma trận.
  - §10: retention và số đo.
  - §11: thêm bước 8 (DBS-134) và bước 9 (RSK-01), kèm ghi chú quyền khi chạy lại bước 7.
- `docs/adr/0014-fraud-rules-external-ai.md` mục 3 "Dung lượng ghi": số đo và hướng đã chốt.
- `infra/scripts/db-roles.sql`: khối grant có `to_regclass`.
- `backend/src/modules/risk/README.md`: trạng thái `risk_decisions`.
- `docs/features/README.md`: dòng RSK-01.
- `docs/BACKLOG.md`:
  - **Xóa BL-048** (thứ tự FK và rolling deploy: chốt "FK trước writer", mốc rollback ở §8).
  - **Xóa BL-049** (retention: đã đo và chốt).
  - **Thêm BL-223, BL-224.**
