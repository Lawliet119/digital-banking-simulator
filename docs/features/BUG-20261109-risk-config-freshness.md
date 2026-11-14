# BUG-20261109 · Ngăn cấu hình fraud cũ ghi đè phiên bản mới

> **Status:** Đang xác minh · **Vai:** #4 Fraud · **Nhánh:** `fix/DBS-110-rule-cache-freshness`

## 1. Phạm vi

DBS-110 ([PR #106](https://github.com/Lawliet119/digital-banking-simulator/pull/106)) đã merge trên `main`; yêu cầu của task là thay đổi cấu hình có hiệu lực trong tối đa 60 giây, kể cả khi Redis hỏng. `RuleSetRepository.current()` đọc PostgreSQL rồi `SET latest EX 60`: một truy vấn v1 chậm ghi đè v2 mà worker khác đã chọn. Đã tái hiện bằng PostgreSQL 17 + Valkey 8 thật: test `older SQL read` trên `77a5cac` trả phiên bản **1** sau khi v2 đã được chọn (mong đợi **2**). Rủi ro đặc biệt là một chuyển từ chế độ có AI sang `rule_only` có thể có hiệu lực chậm hơn tài liệu hứa.

Không thay luật, schema, luồng tiền, consumer hay tự bật AI. Nguồn sự thật là PostgreSQL primary; giả định version bất biến và writer UC-12 commit số version tăng tuần tự, Redis thuộc phạm vi tin cậy. Writer UC-12 và chính sách egress thuộc task khác.

## 2. Hành vi và thiết kế dự kiến

- Valkey chỉ cho publish `latest` trước deadline tuyệt đối lấy từ Redis TIME trước truy vấn SQL; ghi version nhỏ hơn key còn hợp lệ phải bị chặn nguyên tử. Lệnh đến muộn hơn deadline không được ghi. Nội dung version dùng `SET NX`, không ghi đè.
- Kiểm deadline và elapsed đến thời điểm trả kết quả; nếu snapshot quá 60 giây, đọc lại tối đa một lần rồi báo lỗi. Redis hỏng thì đọc SQL, không thay bằng giá trị mặc định.
- Giữ interface `RuleSetRepository.current()` và parser/scorer hiện có. Thay đổi cache là nội bộ, không đòi thay caller.

**Quyết định bổ sung trước thay đổi (agent tự quyết):** reviewer độc lập chỉ ra worker cũ vẫn
`SET cfg:risk:latest` bằng số trần, có thể xen giữa hai worker mới và làm mất bảo vệ. Hai lựa
chọn: dùng chung tên và bắt buộc dừng toàn bộ worker cũ; hoặc chuyển worker mới sang
`cfg:risk:latest:v2`. Chọn key phiên bản riêng để không xung đột khi deploy luân phiên. Đây là
thay đổi tên cache nội bộ so với literal trong DBS-110; version nội dung `cfg:risk:v{n}` không
đổi, repository tự đọc key mới. Worker cũ vẫn có giới hạn cũ cho tới khi được thay hết và không
được coi là đã tuân thủ bound mới. `RiskModule` trên main hiện chưa đăng ký consumer.

Bound 60 giây giả định Redis/primary là nội bộ đáng tin cậy, đồng hồ Redis (kể cả lúc failover)
và đồng hồ local không lùi hoặc chạy sai tốc độ, primary dùng READ COMMITTED, và UC-12 serialize
version tăng **và thứ tự commit**. Không có các điều kiện này thì không hứa deadline thực.

**Review thiết kế:** [review độc lập](screenshots/BUG-20261109-cache/design-review.md) phát hiện
key cũ trong lúc rollout có thể phá bảo đảm; test tái hiện đỏ và đã chuyển key như trên.
Re-review không còn finding blocking trong các giả định đã ghi.

## 3. Kế hoạch chứng minh

1. Viết test PostgreSQL + Valkey thật: worker A đã đọc v1 nhưng tạm dừng; commit v2; worker B đọc/publish v2; tiếp tục A; một worker khác phải vẫn đọc v2. Chạy đỏ trên `main`.
2. Viết test Valkey về deadline, lệnh timeout hoàn tất muộn, wrong-type, và nguồn version bất biến; test lựa chọn snapshot chậm/đồng hồ lùi.
3. Sửa nguyên tử Redis, repository và test liên quan; chạy unit, service, lint/typecheck/build, manual trên PostgreSQL/Valkey tạm; không gửi dữ liệu ra OpenAI.
4. Review độc lập, ghi lại giới hạn, cập nhật tài liệu và tạo Draft PR. Đây là bugfix nhỏ trên DBS-110 đã merge, không coi là fraud end-to-end.

## 4. Kết quả kiểm chứng

| Trường hợp | Bằng chứng |
|---|---|
| SQL v1 hoàn tất sau v2, kể cả worker cũ ghi key cũ | `rule-set-repository.services-spec.ts`: đỏ trên bản cũ; xanh với PostgreSQL và Valkey thật |
| Timeout ghi xong muộn, deadline hết, wrong-type, TTL bị kéo dài, immutable NX | `risk-version-cache.services-spec.ts`: Valkey thật, có proxy giữ lệnh tới sau timeout |
| SQL chậm/lỗi, Redis hỏng, TIME trả muộn, đồng hồ local lùi | `rule-set.repository.spec.ts` và services-spec; clock được tiêm chỉ trong test |
| Điểm và version từ cấu hình seed | `rule-set-repository.db-spec.ts`: PostgreSQL thật, 4/4 |

- `lint:check`, `typecheck`, `format:check`, `build`: đạt trên code đã sửa; unit toàn backend
  84 suite / 1.621 test và e2e 15 suite / 153 test đạt. Sau đó thêm hai unit test clock,
  chạy riêng 7/7; không khẳng định đã chạy lại toàn suite với số mới.
- Services cache và các regression Redis adapter/rate-limit: 4 suite / 25 test đạt; sau đó bổ sung
  ca hết deadline và key cũ, chạy riêng hai suite cache 13/13. Không tuyên bố CI xanh trước khi
  GitHub chạy.
- Manual `npx ts-node -r tsconfig-paths/register test/manual/risk-config-freshness.manual.ts`
  dùng PostgreSQL và Valkey tạm, chạy lại trên commit code `7c575ff`: M-CACHE-01…04 đều đạt
  ([output](screenshots/BUG-20261109-cache/manual-test.txt)); M-CACHE-03 chủ động rút TTL xuống
  100 ms để test hết hạn, không chờ đủ 60 giây. Không gọi OpenAI, không dùng dữ liệu khách.
- Full DB suite trên nhánh cũ bị timeout 600 giây; ở nhánh sửa chỉ chạy bộ DB liên quan 4/4,
  không lấy nó làm bằng chứng toàn bộ DB suite đã xanh. Chưa test consumer vì chưa có consumer.
- Review độc lập: [thiết kế](screenshots/BUG-20261109-cache/design-review.md); hai reviewer
  implementation không phát hiện lỗi blocking trong giả định §2. Dev review và merge chưa có.

## 5. Bàn giao

UC-12 phải serialize thứ tự commit version và kiểm cấu hình lúc ghi; consumer phải giữ đúng
version đã chọn, áp admission và chờ thay hết worker cũ. Các việc này thuộc BL-188 và các task
DBS-111/RSK-02, không được xem là đã hoàn thành bởi bugfix cache. Nếu Redis clock lùi, cache bị
ghi nội dung sai nhưng vẫn hợp lệ, hay writer commit version sai thứ tự, bound 60 giây không
được bảo đảm. Dừng dùng cache hoặc xử lý tại Ops khi các giả định này không đúng.

Đổi thêm một dòng CI để chạy service regression mới cùng DBS-110; không sửa ledger, schema,
thanh toán hoặc quyền DB. Tài liệu cập nhật: feature này, DBS-110, Redis README và index.

## Sau rebase (techlead review PR #108, 2026-11-09)

Rebase lên `main` `18f93dc`; hai dòng `BL-188` và `DBS-110` trong `docs/BACKLOG.md` / `docs/features/README.md` giữ bản của PR trên nền main (đã có DBS-113). Chạy lại: lint, typecheck sạch; unit 85 suite / 1.634 test; services (`rule-set-repository`, `risk-version-cache`, `redis-adapter`, `online-feature-provider`) 21/21 trên Valkey và PostgreSQL thật; `rule-set-repository.db-spec` 4/4; manual `risk-config-freshness.manual.ts` M-CACHE-01…04 đạt trên commit `7c575ff`. PR vẫn là Draft theo ý tác giả; chưa đổi trạng thái.

## Cập nhật BL-188 (2026-11-14): thay worker cũ và giám sát giả định

- **Thay hết worker cũ:** `deploy.sh` nay kết thúc bằng `verify-worker-rollout.sh`: chỉ khi không còn deployment hay task worker revision cũ (kể cả `STOPPING`) mới xanh; quy trình bật phiên bản luật mới (deploy xong, kiểm lại, rồi mới POST UC-12) ở [runbook](../runbooks/risk-config-rollout.md); hậu quả của worker cũ (key `cfg:risk:latest` không có bound 60 s; `parseRuleSet` hẹp hơn API làm event vào DLQ) cũng ở đó. Chi tiết script: [DBS-38 §12](DBS-38-auto-deploy-ecs.md).
- **Giám sát giả định §2:** thêm counter `risk_config_freshness_exceeded_total` (mỗi lần `RuleSetRepository` bỏ một lần chọn vì quá 60 s hoặc đồng hồ lùi/lệch, kể cả lần đọc lại) và alarm `dbs-dev-risk-config-freshness`. Redis sống/lỗi đã có `redis-node-missing`, `redis-fallback`, `risk-config-redis-fallback`. Đồng hồ Fargate/ElastiCache dựa vào Amazon Time Sync Service; không có metric lệch giờ trực tiếp nên không dựng alarm giả. Test: `rule-set.repository.spec.ts`, `metrics.service.spec.ts`, `alarms.tftest.hcl` (TC-ALM-12).
- **Chưa chạy trên AWS:** xem dòng BL-188 ở `docs/BACKLOG.md`.

