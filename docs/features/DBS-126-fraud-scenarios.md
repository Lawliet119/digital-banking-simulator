# DBS-126 · Generator kịch bản gian lận và hard negatives

> **Status:** Implemented (G4 đã duyệt; final-code manual đạt, đang xuất bản Draft PR) · **Vai:** Dev (#6 Quality/data) · **Review:** Dev khác người viết generator, không phải #4 Fraud · **Nhánh:** `codex/DBS-126-fraud-scenarios-20261106` · **PR:** — · **Cập nhật:** 2026-11-06

## 1. Bối cảnh

### Task trên board

Đọc bằng `node .claude/skills/dbs-delivering-task/scripts/fetch-task.mjs DBS-126` ngày 2026-11-06.

| Cột | Nội dung |
|---|---|
| Issue Key | DBS-126 |
| Loại / Tuần | Story / Tuần 4 |
| Tóm tắt | Generator: 5 kịch bản gian lận trong tầm luật, 3 ngoài tầm và hard negatives |
| Assignee (vai) / Ưu tiên / Status | Dev / High / In Progress |
| Phụ thuộc (phải xong trước) | • DBS-71 Generator dữ liệu gian lận, phần giao dịch bình thường (T2) |
| Deliverable / Demo | P5 |
| Thực trạng | Chỉ có giao dịch bình thường (DBS-71). Thiết kế kịch bản ở FRAUD guide §6.1. |
| Expect | #4 có dữ liệu đủ để tune và đánh giá. |

**DoD nguyên văn** (đánh số để truy vết):

1. Kịch bản ATO_DRAIN, MULE_FANOUT, VELOCITY_BURST, BUST_OUT, ROUND_TRIP (trong tầm luật) và SLOW_DRIP, STRUCTURING, FAN_IN (ngoài tầm); ~1% gian lận
2. Hard negatives: tiền nhà, chuyển sang tài khoản của chính mình, khách mới nhận lương, chia tiền ăn nhóm, mượn-trả trong ngày
3. Cột scenario và is_fraud đúng; seed cố định tái lập được
4. Báo cáo thống kê ngắn: tỉ lệ gian lận, phân phối số tiền, số giao dịch/khách/ngày
5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ

### Phụ thuộc và thực trạng đã kiểm

- **DBS-71: Done trên board.** `main` và `origin/main` cùng SHA `2df7d0a` sau `git fetch origin main`; generator và bước test trong CI đã nằm trong main. Feature doc DBS-71, feature index và BL-142 còn thông tin chờ merge cũ; không dùng thông tin đó để kết luận dependency đang chặn.
- Đã chạy [generator](../../load-tests/fraud-dataset/generate.mjs) qua `generateDataset()` trên Node v24.15.0: 96.200 dòng, tất cả `scenario=NORMAL`, `is_fraud=0`; chưa có 8 kịch bản hoặc 5 hard negatives có nhãn. `minBalance=0`, debit=credit=96.043.641.000; tổng số dư khách cộng funding bằng 0.
- Registry hiện có một tài khoản mỗi khách, tuổi tài khoản ít nhất 30 ngày. Hard negative chuyển cùng chủ cần nhiều tài khoản cho một khách; BUST_OUT và khách mới nhận lương cần tài khoản thực sự mới tại thời điểm giao dịch.
- Interface hiện có: `generateDataset({ seed, customers, days } = {}) → { csv, profiles, stats }`, export `COLUMNS`. Người gọi trực tiếp: CLI trong `generate.mjs` và [generate.test.mjs](../../load-tests/fraud-dataset/generate.test.mjs). [CI unit job](../../.github/workflows/ci.yml) gọi test này. Chưa quyết định đổi interface; quyết định ở G2.
- Nguồn phạm vi: [FRAUD guide §6.1–6.2](../components/risk/FRAUD_DETECTION_GUIDE.md#61-bộ-dữ-liệu-tổng-hợp-do-6-làm), [docs/02 §2.1](../02_REQUIREMENTS_AND_DOMAIN_MODEL.md#21-danh-mục-luật-phát-hiện-gian-lận-đầu-vào-cho-fr-rsk-02), [docs/03 §15.4](../03_HIGH_LEVEL_ARCHITECTURE.md#154-đánh-giá), [ADR-08](../adr/0008-fraud-detection-architecture.md), [dataset brief](../components/fraud-dataset/01-concept-brief.md), [DBS-71](DBS-71-normal-fraud-dataset.md).
- Nhánh cũ `codex/DBS-126-fraud-scenarios` đã nằm ở worktree khác, sạch và chưa có commit riêng so với main. Nhánh làm việc mới tạo từ `origin/main` để giữ nguyên worktree đó.

### Baseline trước thay đổi

| Kiểm tra | Kết quả |
|---|---|
| `docker compose up -d` | Đạt; PostgreSQL, Valkey, ElasticMQ khởi động |
| Backend `npm run lint:check` | Đạt, exit 0 |
| Backend `npm run typecheck` | Đạt, exit 0 |
| Backend `npm test` | Đạt: 56 suites, 832/832 tests, 0 bỏ qua |
| Backend `npm run test:e2e` | Lần mặc định: 133/135 đạt; 2 lỗi `spawnSync ... ETIMEDOUT` ở `dev-auth-bootstrap.e2e-spec.ts` và `logging-bootstrap.e2e-spec.ts`. Chạy lại toàn bộ bằng `npm run test:e2e -- --maxWorkers=2`: đạt 13 suites, 135/135 tests, 0 bỏ qua |
| `node --test load-tests/fraud-dataset/generate.test.mjs` | 4 đạt, 0 lỗi, 0 bỏ qua |
| `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | 206 files checked, 0 broken links |

Hai suite backend được chạy đồng thời ở lần đầu; lần E2E sau chạy riêng với hai worker. Rerun xanh chứng minh baseline E2E chạy được với giới hạn worker; chưa xác định nguyên nhân gốc timeout lần đầu. Task generator không sửa bootstrap hoặc test backend. Nếu lỗi tái hiện trong bước verification, báo rõ và không nhận lần chạy đỏ là đạt.

### Phạm vi đề xuất ở G1

- Bổ sung 8 kịch bản đúng ngữ nghĩa thời gian, người nhận, tuổi tài khoản, lịch sử và số dư; 5 nhóm hard negatives hợp lệ có `is_fraud=0`; giữ CSV 12 cột và ID tổng hợp.
- Đo tỉ lệ fraud trên các dòng thực sự xuất, đề xuất khoảng **0,8–1,2% với cấu hình mặc định** cho yêu cầu ~1%; quy định cấu hình nhỏ không đủ dữ liệu ở G2. Không gắn nhãn NORMAL thành gian lận mà thiếu hành vi tương ứng.
- Giữ tái lập theo seed, số tiền nguyên dương, thời gian không lùi, snapshot trước ghi nợ đúng và bảo toàn số dư mô phỏng. Đây là dữ liệu tổng hợp cục bộ, không ghi ledger/balance ứng dụng.
- Báo cáo thống kê từ CSV thực tế: tỉ lệ, số dòng từng scenario, phân phối số tiền, số giao dịch/khách/ngày gồm các ngày không giao dịch. Test ngữ nghĩa kịch bản và nhãn, regression DBS-71, test CLI và tái lập.
- Manual bằng CLI thật: sinh dữ liệu mặc định, đối chiếu hai lần cùng seed và seed khác, kiểm CSV/báo cáo bằng bước kiểm độc lập, chạy tham số lỗi. Không cần AWS, scoring worker hoặc token.
- Cập nhật README generator, tài liệu mô tả dữ liệu có fact thay đổi và feature index khi bàn giao. Output nằm trong thư mục kết quả đã gitignore; không commit CSV hoặc gửi generator cho #4.

### Ngoài phạm vi và backlog liên quan

- **DBS-127** (board: To Do, phụ thuộc DBS-126) làm chia tune/holdout 70/30 theo khách, giữ nhãn holdout và giao tune cho #4; DBS-126 không tự giao toàn bộ CSV có nhãn. Chỉ mô tả tên và một câu cho mỗi kịch bản trong tài liệu dành cho #4.
- Không triển khai luật R1–R6, provider/scoring, ML, API AI, đo precision/recall/F1 hoặc vận hành tải. “Ngoài tầm luật” là chủ đích kịch bản theo guide, không khẳng định đã chạy scoring hay recall thực tế.
- [BL-040, BL-041, BL-044, BL-050](../BACKLOG.md): ADR-14 vẫn Proposed; consumer/provider/đánh giá chất lượng và xác nhận liên vai thuộc task riêng. Giữ các cột khóa khách sẵn có để hỗ trợ chia tập sau này, không đóng các backlog này bằng thống kê generator.
- BL-142 chứa trạng thái bàn giao DBS-71 cũ; task này không xác nhận lại review/CI của PR đó hoặc sửa lịch sử bằng suy đoán. Sự có mặt của code trong main đã được kiểm tra trực tiếp.
- Không sửa backend, schema, ErrorCode, env, dependency, luật tiền hoặc Accepted ADR. Không commit/push/tạo PR/sửa board khi chưa được người dùng cho phép; agent không tự merge.

### Câu hỏi / quyết định G1

1. Đề xuất duyệt phạm vi trên, mốc ~1% ở cấu hình mặc định là 0,8–1,2%, và manual bằng CLI cục bộ; việc chia/giao dữ liệu để DBS-127 thực hiện.

**Quyết định ở G1:** Người dùng trả lời “duyệt g1” ngày 2026-11-06; duyệt phạm vi, tỉ lệ mặc định 0,8–1,2%, manual CLI và bàn giao việc chia/giao dữ liệu cho DBS-127. Không có ủy quyền commit/push/PR.

## 2. Hành vi

### 2.1 CLI, dữ liệu và tương thích

CLI mới (đã triển khai sau G3):

```bash
node load-tests/fraud-dataset/generate-fraud.mjs --seed dbs-fraud-v1 --customers 2000 --days 60 --output load-tests/results/fraud-mixed.csv
```

- Mặc định như ví dụ. Giữ `generate.mjs` và mặc định NORMAL của DBS-71; thêm metadata replay vào kết quả hàm, không thay CSV hoặc summary CLI cũ. Golden SHA-256 CSV mặc định đo trước khi sửa: `60e10c49abe8a6f9377dab29b729eaaf4a0f1d1a11dadfa759d8813aa7a7476f`; phải giữ nguyên.
- Mixed hỗ trợ `customers` nguyên 1.000–100.000, `days` nguyên 30–90, seed 1–128 ký tự. Đây là giới hạn riêng của CLI mới, để đủ số khách, thời gian và ngân sách cho đủ 13 nhóm; CLI cũ giữ miền 9–100.000 khách, 1–365 ngày. Thiếu/trùng/không biết option, số thập phân, NaN, ngoài miền hoặc seed rỗng: exit 1, không tạo/thay output.
- CSV UTF-8, LF, đúng 12 cột và thứ tự DBS-71. `is_fraud` chỉ `0`/`1`; `NORMAL` và 5 `HN_*` là `0`, đúng 8 scenario fraud là `1`. Mọi ID là UUID tổng hợp tất định, không chứa seed gốc hoặc thông tin người thật. Thời gian ISO UTC; ngày thống kê theo `Asia/Ho_Chi_Minh`.
- Cùng seed/tham số cho cùng bytes của CSV, manifest và report; đổi seed đổi dữ liệu. Không dùng đồng hồ thật, `Math.random`, timezone máy hoặc đường dẫn tuyệt đối trong các artifact có hash.
- Xuất thêm `<output>.simulation.json` (registry và lịch sử cấp vốn để kiểm lại) và `<output>.stats.json` (report). Cả ba nằm trong `load-tests/results/` mặc định, không commit hoặc bàn giao cho #4 trong task này. Đây chưa phải tune/holdout; manifest không dùng làm feature đầu vào scoring.
- Chỉ ghi file sau khi sinh và kiểm tất cả bất biến/tỉ lệ. Nếu ghi file gặp lỗi I/O: exit 1, không in kết quả thành công; file chưa hoàn chỉnh không được coi là bộ dữ liệu dùng được. G4 lưu đủ hash ba file để xác định bộ thành công; không hứa atomic nhiều file.

### 2.2 Bố trí dữ liệu và tỉ lệ

Chia registry tất định thành background (75% số khách, sinh theo DBS-71) và cohort kịch bản (25% còn lại). Tài khoản hai nhóm không chuyển qua lại; đây là lựa chọn mô phỏng để kiểm được lịch sử và ngữ nghĩa kịch bản, phải nêu trong giới hạn P5, không nhận là mô hình giao dịch thực tế. `customers` là tổng khách, gồm cả khách/ngày không giao dịch. Mỗi khách tối đa 3 tài khoản; tài khoản thứ hai cho HN_SELF_TRANSFER cùng chủ nhưng khác account ID. Khách/tài khoản mới không có hoạt động hoặc khoản cấp vốn trước ngày mở.

Background giữ hồ sơ Poisson/log-normal, lương và người quen; cohort có lịch sử nền hợp lệ khi cần (ví dụ tiền nhà và các fraud ngoài tầm). Mặc định mixed dự kiến khoảng 70–80 nghìn dòng thay vì 96.200 dòng NORMAL gốc do dành cohort cho kịch bản; số thực tế được báo cáo, không ép bằng dòng giả. Guide dùng quy mô xấp xỉ; DoD ticket không yêu cầu đúng 100.000 dòng.

Đặt `N0` bằng số dòng background, lịch sử nền cohort và hard negatives **thực sự xuất**. Ngân sách fraud gần `round(N0/99)`, phân bổ gần đều theo số dòng cho 8 nhóm, làm tròn theo episode hoàn chỉnh. Mỗi nhóm có ít nhất một episode; điều chỉnh bằng episode hoàn chỉnh để gần 1%, không cắt giữa episode hoặc đổi nhãn. Tính lại `fraudRows/totalRows`; mặc định phải trong [0,008; 0,012]. Các cấu hình mixed hỗ trợ cũng phải đủ 8+5 nhóm và đạt khoảng này hoặc từ chối rõ ràng trước ghi file nếu không đủ cohort/ngân sách. Không bỏ kịch bản âm thầm. Report công khai số dòng mỗi scenario để thấy chênh lệch phân bổ.

### 2.3 Hợp đồng kịch bản

Mỗi episode dùng nguồn chuyên biệt, đích riêng theo nhóm; được phép chia sẻ một đích giữa nhiều nguồn cùng scenario. Không reuse nguồn qua scenario khác. Chọn ngày/giờ, số tiền và người tham gia từ PRNG theo seed, không gắn một giờ/số tiền duy nhất cho toàn bộ scenario. Lịch sử nền gắn NORMAL và có thể kiểm từ CSV. Mọi chuyển tiền thực hiện sau sắp lịch, không chèn vào CSV đã có bằng snapshot giả.

| Scenario, nhãn | Điều kiện phải thấy trên CSV và registry |
|---|---|
| ATO_DRAIN, 1 | Tài khoản cũ; một nguồn có ≥6 lệnh đi trong <10 phút, gửi cho ít nhất 5 người nhận khác chủ chưa từng nhận từ nguồn trong 30 ngày trước; ít nhất một dòng chuyển ≥90% số dư trước dòng đó, số dư trước ≥1tr. Cả episode là luồng chiếm đoạt |
| MULE_FANOUT, 1 | Có dòng tiền vào mule trước khi mule thực hiện ≥6 lệnh đi cho ≥5 người nhận khác chủ, mới trong 30 ngày, trong <10 phút; số gửi ra được tài trợ bởi số nhận vào (mule mở đầu bằng 0, không có lương trước episode); dòng nhận và dòng rải cùng scenario fraud, nhưng dòng nhận không tính vào số outgoing của mule |
| VELOCITY_BURST, 1 | Một nguồn có ≥6 lệnh nhỏ (50k–500k) trong <10 phút, khác account đích với nguồn; không chỉ sáu dòng không liên hệ |
| BUST_OUT, 1 | Nguồn mở sau đầu kỳ và trước giao dịch, tuổi <24h; amount >10tr và ≥90% số dư trước, số dư trước ≥1tr; không có lịch sử trước mở |
| ROUND_TRIP, 1 | Có A→B rồi B→A, `0 < t_return − t_forward < 1h`, khác chủ, số trả bằng số vay; một cặp là episode tối thiểu, có thể lặp cặp nhiều vòng trong episode; cả hai chiều fraud. Hai chiều cùng timestamp không hợp lệ cho episode này |
| SLOW_DRIP, 1 | Cùng nguồn rút 50k–200k/ngày cho một đích trong ≥7 ngày khác nhau; nguồn cũ, lịch sử ≥5 lệnh ở mức tương tự; không tự tạo R1/R2/R3/R4/R5/R6 theo điều kiện số học v1 bên dưới |
| STRUCTURING, 1 | Cùng nguồn có ≥6 lệnh 9,5–9,9tr, trải ≥3 ngày, cách nhau ≥2h; một đích quen, nguồn cũ, đủ lịch sử mức tương tự, không rút cạn. “Dưới ngưỡng” là mốc 10tr minh họa trong guide, không sửa hạn mức chuyển tiền của hệ thống |
| FAN_IN, 1 | ≥6 nguồn khác chủ chuyển đến cùng một đích trong ≤1h; mỗi nguồn chỉ một lệnh trong episode, nguồn cũ, lịch sử bình thường tương đương và đủ số dư; chỉ chấm phía gửi nên hành vi tập trung nhận không được sáu luật chủ đích phủ |
| HN_RENT, 0 | Nguồn có ≥5 lệnh nhỏ trước đó; tiền thuê 5–15tr >5×trung vị lịch sử; ≥2 lần trả cùng chủ nhà cách nhau 28–31 ngày, nên cấu hình 30 ngày đặt lịch ở ngày 0 và 29; hợp lệ dù có thể dính R2 |
| HN_SELF_TRANSFER, 0 | Chuyển ≥90% số dư, số dư trước ≥1tr, account ID khác nhau và `from_customer===to_customer`; registry xác nhận cùng chủ, không sửa nhãn chỉ vì luật R6 có ngoại lệ |
| HN_NEW_SALARY, 0 | Khách và tài khoản mới, nhận lương có bản ghi funding ở manifest, sau đó chuyển >10tr trong tuổi <24h; không có hoạt động trước mở, đủ tiền; lương không giả thành TRANSFER fraud |
| HN_GROUP_MEAL, 0 | Một người trả 50k–500k cho ≥5 bạn mới khác chủ trong ≤1h; cả nhóm vẫn hợp lệ dù trông như fan-out |
| HN_BORROW_REPAY, 0 | A→B rồi B→A cùng số tiền, `0 < t_return − t_forward < 1h` và cùng ngày Việt Nam; cả hai chiều `0`, đối chứng với ROUND_TRIP; hai chiều cùng timestamp không hợp lệ |

Với SLOW_DRIP/STRUCTURING/FAN_IN, kiểm độc lập trên **toàn bộ lịch sử nguồn**, gồm NORMAL: ≤5 lệnh trong 10 phút; amount ≤5×median 30 ngày khi có ≥5 lịch sử; tuổi nguồn ≥24h; không có chiều ngược trong 1h; <5 đích mới trong 1h; amount <90% balanceBefore khi balanceBefore≥1tr. Dùng so sánh số nguyên, median chẵn giữ tử số/2; không gọi hoặc giả lập interface `RiskRule`/FeatureProvider chưa triển khai. Đây là kiểm hình dạng dữ liệu theo đặc tả v1, không phải chứng cứ recall/scoring runtime hoặc quy tắc đã tune.

### 2.4 Số dư, báo cáo và an toàn

- Tiền mô phỏng mới dùng BigInt và chuỗi canonical; so tỷ lệ drain bằng nhân chéo. Mỗi dòng trừ nguồn/cộng đích cùng lượng, số dư khách không âm; `from_balance_before` là snapshot ngay trước trừ. Không clamp hoặc bỏ dòng scenario khi thiếu tiền: lỗi generation, không ghi bộ dữ liệu. Vốn/lương là funding credit có thời điểm, không phải TRANSFER; mọi credit có funding đối ứng âm.
- Manifest chứa version, seed/tham số, khoảng thời gian, từng customer/account/createdAt/openingBalance, credit với timestamp/amount/kind và ending balances. Khách mới có openingBalance=0 và funding sau mở. Không có nhãn holdout hoặc nguồn dữ liệu thật. Tổng opening balance + funding ban đầu=0; replay từng credit/transfer kiểm snapshot và ending balance; tổng ending khách + funding cuối=0, debit=credit.
- Report từ các dòng xuất: `transactions`, `fraudTransactions`, `fraudRate`, `scenarioCounts`, amount `{min,p50,p90,p99,max}` (chuỗi đồng, quantile nearest-rank/index quy định: `floor((n-1)*p)`), activity `{customers,days,customerDays,mean,p50,p90,max}` trên số outgoing TRANSFER/khách/ngày Việt Nam gồm zero; cùng `sha256` CSV và các tổng bảo toàn tiền. Không in metric precision/recall/F1. Không có số đo mới nào được ghi là kết quả trước khi chạy.

| Checklist bảo mật | Áp dụng / bằng chứng |
|---|---|
| Role/ownership API, idempotency key, audit REJECTED/DENIED, DTO ẩn cờ | Không áp dụng: CLI synthetic không mở endpoint, không ghi DB và không đổi backend |
| SQL tham số hóa, TLS PostgreSQL/Redis | Không áp dụng: không có kết nối SQL/Redis/network |
| Không PII/secret; không làm lộ holdout | UUID tổng hợp, output gitignore, không gửi dữ liệu cho #4; TC-126-12 |
| Không lộ internals trong HTTP / correlationId | Không áp dụng: không có HTTP; CLI exit 1 cho lỗi input/I/O, không có project `ErrorCode` mới; TC-126-11 |

## 3. Kiến trúc

Chạy script cục bộ bằng Node standard library, không thuộc role `api`/`worker`. Không DB/schema/transaction ứng dụng, event contract, dependency mới hoặc thay Accepted ADR.

**Interface đã có:** `generateDataset({seed,customers,days}={}) → {csv,profiles,stats}` và `COLUMNS` trong `generate.mjs`; callers đã liệt kê §1. Giữ chữ ký và CSV; bổ sung trường trả về `simulation` để giữ opening balances, credits và ending balances cho kiểm lại, không đổi các trường cũ. CLI cũ chỉ in `stats` như trước.

**Interface đã triển khai:**

- `generateFraudDataset({seed='dbs-fraud-v1',customers=2000,days=60}={}) → {csv,simulation,stats}` trong `generate-fraud.mjs`. Gọi generator NORMAL cho background với seed namespace riêng, lập registry/lịch cohort, rồi replay cohort theo `(timestamp, credit-before-transfer, sequence)`; merge với CSV background theo timestamp và stable sequence, không đổi snapshot background. ID namespace tách biệt và kiểm không trùng. Chỉ background accounts xuất hiện trong background, chỉ cohort accounts xuất hiện trong cohort.
- `inspectDataset(csv,simulation) → report` trong `inspect-fraud.mjs`: parser/replay độc lập, không import planner/PRNG/generator hoặc tin tổng số từ generator; kiểm header, ID, canonical money, thời gian, labels, registry, snapshot, bảo toàn và thống kê từ dữ liệu. CLI `node .../inspect-fraud.mjs --csv <path> --simulation <path>` in JSON report, exit 0/1; không ghi CSV. Checker đọc được cả NORMAL trace để đối chiếu background. Unit test kiểm đầu vào bị sửa tay, không chỉ so checker với chính output của nó.

Manifest gộp trace NORMAL và cohort theo cùng định dạng; mọi credit có stable sequence. Các khoản đồng timestamp được cấp trước TRANSFER; `createdAt ≤ creditAt`, `createdAt < transferAt`. Khoản vốn đầu kỳ cho tài khoản cũ được ghi openingBalance, không double-count như credit; lương ghi credit đúng ngày 00:00 Việt Nam như DBS-71.

Luồng trong cùng script: `seed/options → NORMAL background + lịch cohort → replay cohort → merge CSV → inspectDataset → kiểm đủ scenario/tỉ lệ → ghi 3 artifact → stdout summary`. Đây là các hàm trong một tiến trình, không thêm module/service hoặc component runtime; không cần sơ đồ nhiều thành phần.

**Điểm cần cập nhật tài liệu:** README generator/load-tests, dataset concept brief đang ghi “chưa có code”, feature index và giới hạn P5 về cohort. Không thay nội dung thiết kế Accepted của guide; bổ sung link hướng chạy khi cần. `.github/workflows/ci.yml` unit step cần chạy cả test mới qua Node test runner; giữ nguyên sáu job và action pins.

## 4. Test cases tự động

Các case Node test chạy trên dữ liệu tổng hợp trong bộ nhớ/file thật; không dùng mock DB và không tuyên bố là test tiền ứng dụng. Mỗi scenario/hard negative là subtest riêng, không gom thành kiểm có tên nhãn.

| ID | Truy vết | Lớp / Given · When · Then | ErrorCode |
|---|---|---|---|
| TC-126-01 | DoD 3, tương thích DBS-71 | Integration: golden hash NORMAL trước thay đổi giữ nguyên; 4 test cũ vẫn chạy; mixed cùng seed bằng bytes CSV/manifest/report, seed khác khác bytes; TZ=UTC và Asia/Ho_Chi_Minh bằng bytes qua process riêng | Không áp dụng |
| TC-126-02 | DoD 1 | 5 subtest kiểm ATO_DRAIN, MULE_FANOUT, VELOCITY_BURST, BUST_OUT, ROUND_TRIP theo từng điều kiện §2.3 từ CSV/registry: ATO/mule ≥6 outgoing/10 phút từ đúng nguồn, không tính incoming mule; tuổi mới và chiều trả có timestamp lớn hơn chiều đi; nhiều episode không thiếu/chồng nguồn | Không áp dụng |
| TC-126-03 | DoD 1 | 3 subtest kiểm SLOW_DRIP/STRUCTURING/FAN_IN đủ người/ngày/số tiền, và sáu điều kiện v1 không kích hoạt trên toàn bộ lịch sử đã xuất, bao gồm snapshot, median nửa đồng và same-owner | Không áp dụng |
| TC-126-04 | DoD 2 | 5 subtest hard negatives: cadence rent + lịch sử, cùng chủ khác account, lương funding rồi tài khoản mới chuyển lớn, ≥5 bạn mới, mượn-trả có chiều trả sau chiều đi và cùng ngày Việt Nam; tất cả dòng tương ứng is_fraud=0 | Không áp dụng |
| TC-126-05 | DoD 1, 3 | Default và seeds `dbs-fraud-v1`, `dbs-fraud-v2`, `dbs-fraud-edge`: đủ 8+5 nhóm, tỷ lệ từ CSV trong [0,008;0,012]; min cấu hình 1000/30 cũng kiểm, không gán label dựa vào số thứ tự dòng | Không áp dụng |
| TC-126-06 | DoD 3; §2.4 | Toàn CSV: đúng 12 cột, IDs duy nhất, owner/createdAt khớp registry, không self-account transfer, amount>0 canonical, createdAt<transfer, labels đúng tập; cùng timestamp có thứ tự ổn định | Không áp dụng |
| TC-126-07 | DoD 3; §2.4 | Replay độc lập mọi opening/credit/transfer, snapshot chính xác, không âm, ending balance và funding khớp, debit=credit; checker bắt CSV sai snapshot và manifest thiếu credit | Không áp dụng; assert throw/CLI exit 1 |
| TC-126-08 | DoD 4 | Report tính lại từ CSV bằng oracle test: scenario totals, fraud ratio, quantiles min/p50/p90/p99/max, hoạt động gồm zero; fixture 23:59:59/00:00:00 Việt Nam phân ngày đúng, nhiều account cùng chủ cộng theo customer | Không áp dụng |
| TC-126-09 | DoD 3, 4 | Fixture inspector có 9007199254740993đ giữ chính xác qua parse/replay/quantile/JSON; fixture median lịch sử chẵn kiểm bằng nhân chéo, không floating point hoặc làm tròn | Không áp dụng |
| TC-126-10 | DoD 3 | CLI mixed thật ghi đủ 3 file, stdout/sidecar/checker cùng hash và report; seed khác đổi hash; output custom path được dùng; inspector chạy process riêng | Exit 0 |
| TC-126-11 | DoD 3; biên | CLI reject min-1/max+1 khách/ngày, fractional, NaN, seed rỗng, unknown/duplicate/missing option; file sentinel có sẵn không bị sửa khi input sai. Output là directory gây lỗi I/O → exit 1, không in success | Exit 1; không thêm project ErrorCode |
| TC-126-12 | DoD 3; security | Không dùng clock/Math.random; seed chứa dấu phẩy/newline không lọt ID/CSV; schema chỉ dữ liệu synthetic; `git check-ignore` xác nhận artifact mặc định đã ignored, `git status` không có CSV được thêm | Không áp dụng |
| Quy trình | DoD 5 | CI thật, Dev review, bảng đối chiếu và merge được xác nhận riêng sau ủy quyền; agent không merge/sửa board | Không áp dụng |

Mutation input inspector còn gồm: label không hợp lệ/sai cặp scenario, ID trùng/không có registry, timestamp không ISO hoặc lùi, owner lệch, thiếu cột, amount âm/số mũ, credit trước mở tài khoản. Checker phải từ chối thay vì tính tiếp hoặc sửa dữ liệu. Oracle ngữ nghĩa trong TC-126-02/04 có fixture hai chiều cùng timestamp: replay số dư có thể hợp lệ nhưng oracle phải từ chối episode ROUND_TRIP/HN_BORROW_REPAY vì không thỏa cửa sổ lịch sử R4. Không dùng test `.skip`/`.only`/`.todo`.

## 5. Test thủ công

CLI/inspector đã có; script chạy thật nằm ở [manual-test.sh](screenshots/DBS-126/manual-test.sh), kết quả từng bước ở §8. Cần Node 24 và Git Bash đã có tại `C:/Program Files/Git/bin/bash.exe`; đã chạy kiểm tra `node --version` (v24.15.0), `command -v sha256sum` và `command -v cmp` thành công trong Git Bash. Chạy từ gốc repo. Không cần Docker/AWS/token. Output nằm dưới thư mục results đã ignored.

| Bước | Lệnh/thao tác | Kết quả mong đợi |
|---|---|---|
| M-126-01 | `node load-tests/fraud-dataset/generate-fraud.mjs --output load-tests/results/dbs126-a.csv` | Exit 0, đủ CSV/simulation/stats; stdout số dòng, hash và tỉ lệ 0,8–1,2%; đủ 8+5 nhóm trong report |
| M-126-02 | Cùng lệnh đổi output thành `dbs126-b.csv`; `sha256sum load-tests/results/dbs126-{a,b}.csv`; đối chiếu bytes cả hai simulation/stats bằng `cmp` | Ba cặp file bằng nhau; report không chứa output path gây sai hash |
| M-126-03 | `node load-tests/fraud-dataset/generate-fraud.mjs --seed dbs-fraud-v2 --output load-tests/results/dbs126-c.csv`; `sha256sum load-tests/results/dbs126-{a,c}.csv` | Exit 0, hash khác, vẫn đủ nhóm và tỷ lệ hợp lệ |
| M-126-04 | `node load-tests/fraud-dataset/inspect-fraud.mjs --csv load-tests/results/dbs126-a.csv --simulation load-tests/results/dbs126-a.csv.simulation.json`; đối chiếu JSON report với file stats | Exit 0, report khớp, replay toàn CSV đạt; đọc header, một dòng mỗi scenario và cặp cùng chủ để kiểm mắt, lưu output rút gọn |
| M-126-05 | CLI mixed với `--customers 999 --output load-tests/results/dbs126-invalid.csv`; sau đó min `--customers 1000 --days 30 --output load-tests/results/dbs126-min.csv` | Lệnh đầu exit 1 không có artifact; lệnh min exit 0, đủ nhóm và tỉ lệ; cả mã thoát ghi transcript |
| M-126-06 | Tạo bản sao CSV a trong results, sửa `from_balance_before` của một dòng giảm 1đ bằng script Node ngắn; chạy inspector với manifest a | Exit 1 vì snapshot lệch; giữ bản a nguyên; sau đó chạy lại inspector a đạt để chứng minh đường phục hồi |
| M-126-07 | Chạy CLI NORMAL cũ và `node --test load-tests/fraud-dataset/generate.test.mjs` | Golden hash CSV cũ không đổi, 4 test DBS-71 đạt |

Git Bash ghi UTF-8 transcript bằng `2>&1 | tee -a .../manual-test.txt` với `set -o pipefail`; lưu PIPESTATUS ngay sau pipeline để giữ mã thoát. Runner lấy SHA commit cuối chạm source/CI, từ chối nếu source lệch commit đó, ghi SHA ở dòng đầu transcript. Sau G4 đã chạy lại đủ M-126-01–07 trên `8699311adccaa24a60abed488d6465efe500853c`; bốn ảnh đã cập nhật theo output lần này.

## 6. Domain review (AI)

**Reviewer:** agent độc lập `gpt-6-astra`, reasoning high, ngày 2026-11-06, read-only; không đọc generator hoặc nhãn holdout. Lượt 1: 2 should-fix, 0 blocking, 0 minor, verdict REVISE; [nguyên văn lượt 1](screenshots/DBS-126/domain-review-round-1.md). Đã sửa cả hai. Lượt 2 review lại §2–§4 và consistency §1/§5: 0 finding còn lại, **Verdict: APPROVE**; [nguyên văn lượt cuối](screenshots/DBS-126/domain-review.md).

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | ATO/mule chỉ 5 outgoing chưa tạo R1 >5/10 phút; dòng incoming mule không phải outgoing | Đã sửa §2.3 và TC-126-02 thành ≥6 outgoing từ đúng nguồn, vẫn ≥5 đích mới |
| 2 | should-fix | Chiều trả cùng timestamp không nằm trong lịch sử R4 | Đã sửa ROUND_TRIP/HN_BORROW_REPAY thành độ trễ dương <1h; TC-126-02/04 thêm fixture đồng timestamp |

**Quyết định ở G2:** Người dùng trả lời “duyệt g2” ngày 2026-11-06; duyệt thiết kế gồm cohort 75/25 và quy mô mặc định dự kiến 70–80 nghìn dòng, giữ CLI NORMAL gốc, kiểm độc lập qua manifest và chưa giao dữ liệu cho #4. Không có ủy quyền commit/push/PR.

## 7. Kế hoạch triển khai

### 7.1 Thứ tự thực hiện và test viết trước

Bảng được lập trước code và thực hiện sau khi G3 được duyệt. G4 đã ủy quyền commit/xuất bản; code/test/CI/runner nằm trong commit `8699311adccaa24a60abed488d6465efe500853c`, docs/evidence được commit riêng sau khi chạy lại manual. Cột đỏ ghi lỗi thực tế, output và kết quả xanh nằm trong [verification.txt](screenshots/DBS-126/verification.txt). Không có migration/service/controller/audit/outbox cần sắp thứ tự vì task không thay backend.

| Bước | File | Test viết trước | Kết quả đỏ | Lệnh chứng minh (tại gốc repo trừ khi ghi khác) | Commit đề xuất, chỉ khi được phép |
|---|---|---|---|---|---|
| 1. Trace NORMAL và giữ tương thích | `load-tests/fraud-dataset/generate.test.mjs`, `generate.mjs` | TC-126-01: golden SHA đã đo; TC-126-07: opening/credits/ending trace NORMAL replay được. Viết assertions cho trường simulation trước khi thêm trace; giữ cả 4 test cũ | Đỏ thật: đọc version từ simulation undefined; xanh 5/5 | `node --test load-tests/fraud-dataset/generate.test.mjs` | `feat(dataset): expose reproducible simulation trace` |
| 2. Inspector độc lập | `load-tests/fraud-dataset/inspect-fraud.test.mjs`, `inspect-fraud.mjs` | TC-126-06/07/08/09 và mutation §4 bằng fixture viết tay có tổng đã biết: replay, validation, BigInt, median oracle, quantile và activity theo ngày Việt Nam. Sau fixture mới thử trace NORMAL bước 1 | Đỏ thật: ERR_MODULE_NOT_FOUND inspector; xanh 38/38 cùng NORMAL | `node --test load-tests/fraud-dataset/inspect-fraud.test.mjs load-tests/fraud-dataset/generate.test.mjs` | `feat(dataset): validate and inspect synthetic transfers` |
| 3. Dựng 8 scenario fraud, replay và merge | `load-tests/fraud-dataset/generate-fraud.test.mjs`, `generate-fraud.mjs`, `scenarios.mjs` | TC-126-02/03/05/06/07: mỗi scenario subtest riêng, assertions trước implementation tương ứng; oracle R1–R6 theo số học và lịch sử CSV; incoming mule không tính outgoing, chiều trả phải muộn hơn chiều đi. Test lỗi thiếu cohort/thiếu tiền thay vì clamp hoặc cắt episode | Đỏ thật: module thiếu, sau đó từng missing SCENARIO; warmup ngoài 30 ngày bị bắt; xanh 10/10 | `node --test load-tests/fraud-dataset/generate-fraud.test.mjs` | `feat(dataset): generate eight coherent fraud scenarios` |
| 4. Hard negatives và cân tỉ lệ toàn bộ | `load-tests/fraud-dataset/generate-fraud.test.mjs`, `generate-fraud.mjs`, `scenarios.mjs` | TC-126-04/05: 5 nhóm HN riêng, hai lần tiền nhà, cùng chủ khác account, lương trước chuyển; điều chỉnh ngân sách trên N0 thực tế sau HN/lịch sử, không đổi label; các seed và cấu hình min đều đủ 13 nhóm | Đỏ thật: 5 HN thiếu + all-label coverage; xanh 17/17 | `node --test load-tests/fraud-dataset/generate-fraud.test.mjs` | `feat(dataset): add hard negatives and balance fraud prevalence` |
| 5. CLI, artifact, tái lập và lỗi | `load-tests/fraud-dataset/generate-fraud.test.mjs`, `inspect-fraud.test.mjs`, `generate-fraud.mjs`, `inspect-fraud.mjs` | TC-126-01/08/10/11/12: subprocess thật, ba artifact bằng bytes theo seed/TZ, report độc lập, output tùy chọn, tham số invalid, sentinel không bị sửa, I/O failure không in success; seed dấu phẩy/newline không lọt CSV | Đỏ thật: CLI không tạo CSV, invalid input exit 0, API không reject; xanh toàn bộ 59/59 | `node --test load-tests/fraud-dataset/generate.test.mjs load-tests/fraud-dataset/inspect-fraud.test.mjs load-tests/fraud-dataset/generate-fraud.test.mjs` | `feat(dataset): expose reproducible fraud generation CLI` |
| 6. Đưa test mới vào CI và full verification | `.github/workflows/ci.yml`, `docs/features/screenshots/DBS-126/verification.txt` | Giữ nguyên tất cả TC và 4 test DBS-71. CI unit step gọi tường minh cả 3 test file như bước 5 (đường dẫn thêm `../` vì cwd CI là backend); không đổi job/pin/trigger | Không có red test YAML riêng; lệnh CI tương đương chạy 59/59, không tạo test giả cho chuỗi lệnh | Lệnh Node bước 5; các lệnh backend tại §7.2; `git diff --check` | `ci(dataset): run fraud generator and inspector tests` |
| 7. Manual, tài liệu và bàn giao | Tất cả file docs/evidence trong §7.3 | Thực hiện M-126-01–07 theo §5 trên code cuối; đối chiếu từng TC với test thực tế, không thay độ sâu test bằng unit chung | 7/7 bước đạt trên final code commit 8699311; BL-153 đã giải quyết | `bash docs/features/screenshots/DBS-126/manual-test.sh`; `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs`; đối chiếu file bằng `git status --short` và diff khi chưa commit | `docs(dataset): document fraud dataset behavior and evidence` |

`scenarios.mjs` là file nội bộ cho các hàm lập lịch cohort trong cùng tiến trình đã duyệt ở §3, không phải service/interface backend mới. Nó giữ PRNG/UUID/lập lịch/episode; `generate-fraud.mjs` điều phối NORMAL background, replay, merge, kiểm tỉ lệ và CLI; inspector không import planner/generator. Test ngữ nghĩa/oracle đặt trong `generate-fraud.test.mjs`, fixture inspector trong `inspect-fraud.test.mjs`; không thêm thư viện hay test framework.

### 7.2 Verification và điều kiện dừng

1. Mỗi hành vi chạy đỏ rồi xanh riêng trước khi đi tiếp; lưu lỗi đỏ thực tế vào bảng trên và output cần thiết vào `verification.txt`. Bước 3/4 có nhiều scenario: thực hiện lần lượt từng subtest để không viết cả module trước test. Không `.skip`/`.only`/`.todo`.
2. Sau thay đổi cuối, chạy toàn bộ 3 file Node test trong bước 5. Tính số case đạt từ assertions thực tế; một case thiếu độ sâu phải ghi đơn giản hóa/chưa làm, không nhận đạt.
3. Trong `backend/`, chạy lần lượt `npm run lint:check`, `npm run typecheck`, `npm test -- --maxWorkers=2`, `npm run test:e2e -- --maxWorkers=2`, `npm run test:db -- --maxWorkers=2`, `npm run build`. Docker compose phục vụ baseline; DB suite dùng harness hiện có/DB thử riêng, không seed balance ứng dụng bằng SQL và không sửa `.env`. Giới hạn worker cho local để giảm tranh tài nguyên; không sửa cấu hình CI. Lỗi nào xuất hiện phải báo với output, không lặp để che lỗi.
4. `.github/workflows/ci.yml` chỉ đổi lệnh Node test ở unit job. Đã kiểm công cụ local: `actionlint` chưa có; không thêm dependency để lấy linter. Kiểm diff YAML/lệnh tường minh và chạy chính lệnh Node tương đương ở local. Remote CI và các bước ElasticMQ/Testcontainers của job e2e chỉ được nhận đạt khi có run thật sau ủy quyền PR; local backend/unit không thay bằng chứng đó.
5. Chạy §5 bằng CLI thật, lưu transcript UTF-8, exit, SHA/hashes, từng M-ID và bốn ảnh output thật. `manual-test.sh` chỉ gọi CLI/checker, đối chiếu artifact và tạo bản sao hỏng ở results cho M-126-06; không gọi test runner để thay các bước M-126-01–06. Test runner ở M-126-07 là regression bổ sung đúng §5. Không nhận kiểm CLI là bằng chứng chấm điểm gian lận/precision/recall.
6. Chạy link check và `git diff --check`. Trước G4, nếu chưa commit thì đối chiếu file tracked bằng diff với main và **thêm danh sách untracked từ `git status --short`**; `git diff main...HEAD` một mình chưa bao gồm công việc này. Không stage/commit tự động để làm báo cáo đẹp.

### 7.3 Danh sách file được phép thay đổi

Ngoài danh sách này cần báo và xin duyệt gate phụ trước khi sửa.

| Nhóm | File cụ thể | Mục đích |
|---|---|---|
| Source có sẵn | `load-tests/fraud-dataset/generate.mjs` | Chỉ thêm trace simulation, giữ CSV/stats cũ và golden hash |
| Source mới | `load-tests/fraud-dataset/generate-fraud.mjs`, `scenarios.mjs`, `inspect-fraud.mjs` | Planner, generator mixed, inspector độc lập và hai CLI |
| Test | `load-tests/fraud-dataset/generate.test.mjs`, `generate-fraud.test.mjs`, `inspect-fraud.test.mjs` | Toàn bộ TC-126-01–12, regression DBS-71, oracle/fixture độc lập |
| CI | `.github/workflows/ci.yml` | Unit job chạy đủ ba test file |
| Tài liệu sử dụng | `load-tests/fraud-dataset/README.md`, `load-tests/README.md` | CLI/schema/report, phạm vi NORMAL/mixed, giới hạn cohort, quyền truy cập #4 và task DBS-127 |
| Tài liệu component | `docs/components/fraud-dataset/01-concept-brief.md` | Sửa fact chưa có generator; nêu thực trạng mixed và giới hạn cohort, giữ Proposed ADR-14 và việc chia/giao chưa làm |
| Bàn giao | `docs/features/DBS-126-fraud-scenarios.md`, `docs/features/README.md`, `docs/BACKLOG.md` | Trạng thái gate, TC/manual/evidence, dòng feature và backlog/handoff thực tế |
| Review nguyên văn | `docs/features/screenshots/DBS-126/domain-review-round-1.md`, `domain-review.md` | Giữ nguyên trả lời reviewer đã có, không sửa nội dung |
| Evidence text/script | `docs/features/screenshots/DBS-126/manual-test.sh`, `manual-test.txt`, `verification.txt` | Kịch bản lặp lại, transcript thật, validation và giới hạn final SHA nếu chưa được phép commit |
| Ảnh output thật | `docs/features/screenshots/DBS-126/01-summary.png`, `02-reproducibility.png`, `03-inspection.png`, `04-rejection-recovery.png` | Bằng chứng §5; thiếu ảnh nào ghi tên ở G4 |

Tên file sau dấu phẩy trong cùng ô được hiểu tương đối theo thư mục của file đầu tiên. Output CSV, simulation, stats và các bản sao kiểm thử ở `load-tests/results/` là dữ liệu sinh ra đã ignored, **không là file đưa vào PR**. Fixture nhỏ viết tay đặt trong test, không commit dataset sinh ra.

### 7.4 Plan sweep: DoD, giới hạn và handoff

Đã đối chiếu §1–§6, DoD 1–5, các giới hạn của DBS-71/README/brief, `.github/workflows/ci.yml`, `.gitignore` và các backlog cùng module. Kết quả: **TC-126-01–12 đều có bước thực hiện; 8 scenario, 5 HN và M-126-01–07 đều có nơi kiểm chứng; không có yêu cầu implementation bị bỏ trống**.

| Yêu cầu / giới hạn | Được xử lý ở đâu / quyết định |
|---|---|
| DoD 1: 8 scenario, gần 1%, episode không bị cắt | Bước 3/4; TC-126-02/03/05; M-126-01/03/05; rate tính từ CSV cuối |
| DoD 2: 5 HN, same owner, mới nhận lương, rent tháng | Bước 4; TC-126-04; M-126-01/04 |
| DoD 3: nhãn, seed, schema và tái lập | Bước 1/2/3/5; TC-126-01/06/07/09/10/11/12; M-126-02/03/06/07 |
| DoD 4: fraud rate, amount và activity gồm zero | Bước 2/5; TC-126-08/09; M-126-01/04; report không có đường dẫn/thời gian thật |
| DoD 5: bảng TC, CI thật, Dev review và merge | Bước 6/7 cho phần local và TC; remote/Dev review/merge còn chờ ủy quyền/hành động người có quyền. G4 thêm backlog với điều kiện đóng rõ ràng; agent không tự merge |
| Giới hạn scale 75/25, quy mô mixed dự kiến 70–80k; NORMAL cũ giữ nguyên | G2 đã duyệt; bước 1/4/7; golden hash + report count thật và tài liệu P5, không thêm dòng giả cho đủ số lượng |
| Trace/tiền lớn/ngày Việt Nam/lỗi/I/O | Bước 1/2/5; TC-126-06–12; không sửa luật tiền ứng dụng, không gọi PostgreSQL thay cho sổ mô phỏng |
| Scenario “ngoài tầm”, chưa có scoring | Bước 3 oracle shape theo v1, không tạo stub Rule/FeatureProvider. Runtime score/recall/ML nằm ngoài task, BL-041/044 tiếp tục mở |
| Tune/holdout 70/30 và giao/xác nhận với #4 | DBS-127; G4 có dòng handoff vào backlog (hoặc thêm nguồn DBS-126 vào dòng cùng gap nếu đã có). Không tạo/tặng holdout hay gửi source |
| BL-040/050 Proposed ADR-14 và xác nhận liên vai | Giữ ngoài phạm vi như G1; giữ cột customer trong CSV, không nhận là đã split/giao tune hoặc đã đóng BL-050 |
| BL-142 và trạng thái tài liệu DBS-71 cũ | Không sửa lịch sử review/merge bằng suy đoán; code có trong main đã xác minh ở G1. Không đóng BL-142 trong task này |
| Backend/schema/env/dependency/ADR/event contract và các module khác | Ngoài phạm vi; không file sửa tương ứng trong §7.3. docs/03/guide giữ thiết kế Accepted, brief/README ghi giới hạn implementation mới |
| Nội dung `.gitignore`, package manifest/lockfile và các file evidence task khác | Không cần sửa: results đã ignored, dùng Node standard library. Chỉ kiểm, không mở rộng phạm vi |

### 7.5 Rủi ro và cách lùi

- **Trace thay output NORMAL:** thêm trace không được tiêu thụ thêm số ngẫu nhiên hoặc thay thứ tự sort/JSON cũ; golden hash và test cũ chặn regression. Nếu sai, sửa trước khi đi bước 2.
- **Ngân sách/cohort không đủ hoặc scenario bị hụt tiền:** lập episode hoàn chỉnh, xác nhận sức chứa trước replay, từ chối trước ghi file khi không đủ; không vay actor qua nhóm hoặc đổi nhãn để xanh. Nếu phải đổi giới hạn/độ sâu đã duyệt, dừng xin gate phụ.
- **Checker cùng sai với generator:** fixture có expected tính tay, mutation và oracle ngữ nghĩa độc lập; inspector không import generator/planner. Funding/credits cùng timestamp tuân §3; mỗi khoản chỉ ghi một lần.
- **Time/precision/CI:** BigInt cho money và so tỷ lệ; UTC milliseconds cố định, ngày thống kê Việt Nam. Kiểm TZ hai process, thêm 3 test file tường minh vào CI để không phụ thuộc shell glob Windows/Linux.
- **Quy mô lớn/tải máy:** không chạy backend unit/e2e/db đồng thời; báo cấu hình/giới hạn nếu chưa kiểm được cận trên lớn. Không bỏ assertions hoặc nâng timeout backend để hợp thức hóa lỗi unrelated.
- **Rollback:** trước commit chỉ phục hồi riêng các phần task sở hữu từ diff đã kiểm, không ghi đè thay đổi người dùng hoặc dùng reset/clean diện rộng. Sau khi có commit được ủy quyền, rollback bằng revert commit task qua review; không có DB/cloud mutation cần đảo. Dataset ignored được tái sinh từ seed, không xóa diện rộng.

**Quyết định ở G3:** Người dùng trả lời “duyệt g3” ngày 2026-11-06. Bắt đầu triển khai theo §7. Chưa có ủy quyền commit, push hoặc Draft PR; không coi duyệt G3 đơn thuần là ủy quyền xuất bản.

## 8. Kết quả

### 8.1 Verification và final code commit

[Output tự động đầy đủ](screenshots/DBS-126/verification.txt). Các kiểm tra tự động bên dưới chạy trên đúng nội dung source đã commit (đối chiếu SHA-256). Code/test/CI commit `8699311adccaa24a60abed488d6465efe500853c`; toàn bộ manual chạy lại sau commit, SHA ở dòng đầu transcript. Docs/evidence commit riêng không thay code. G4 đã cho phép commit, push và Draft PR; không sửa board hoặc merge.

| Lệnh | Kết quả |
|---|---|
| Node test runner, cả ba file `generate.test.mjs`, `inspect-fraud.test.mjs`, `generate-fraud.test.mjs` | **59/59 đạt**, 0 skipped; gồm 4 regression DBS-71, trace, 13 nhóm hành vi và các fixture/mutation/CLI |
| `npm run lint:check` | Đạt, exit 0 |
| `npm run typecheck` | Đạt, exit 0 |
| `npm test -- --maxWorkers=2` | 56 suites, **832/832 đạt**, 0 skipped |
| `npm run test:e2e -- --maxWorkers=2` | 13 suites, **135/135 đạt**, 0 skipped |
| `npm run test:db -- --maxWorkers=2` | PostgreSQL thật, 20 suites, **369/369 đạt**, 0 skipped; có cảnh báo listener dưới đây |
| `npm run build` | Đạt, exit 0 |

DB suite phát `MaxListenersExceededWarning` cho `listening`, `error`, `close` trên `Server` (11 listeners, giới hạn 10). Chưa xác định nguồn/root cause; không suppression hoặc sửa harness. Bàn giao **BL-154**. Hai timeout bootstrap ở baseline G1 không tái hiện trong lần verification E2E này; không tuyên bố đã sửa nguyên nhân cũ. Remote CI và các bước ElasticMQ/Testcontainers đặc thù CI chưa chạy cho thay đổi này (**BL-151**).

### 8.2 Đối chiếu test case

| ID | Test / bằng chứng | Đạt? |
|---|---|---|
| TC-126-01 | `generate.test.mjs` golden hash/trace; `generate-fraud.test.mjs` real CLI across paths/TZ và identical memory artifacts | Đạt |
| TC-126-02 | Năm test riêng ATO/mule/velocity/bust-out/round-trip, outgoing đúng nguồn, timestamp chiều trả dương | Đạt |
| TC-126-03 | Ba test riêng SLOW_DRIP/STRUCTURING/FAN_IN; toàn bộ history của mỗi nguồn và reverse candidates được kiểm theo sáu predicate v1 | Đạt; shape oracle, không phải runtime scoring |
| TC-126-04 | Năm test riêng rent/self/new-salary/group-meal/borrow-repay; fixture same timestamp bị oracle từ chối | Đạt |
| TC-126-05 | Emitted prevalence và all-label seeds/minimum configuration; insufficient cohort throws | Đạt |
| TC-126-06 | Inspector registry/CSV và 30 mutation; default mixed replay | Đạt |
| TC-126-07 | NORMAL trace replay, manual inspector và thiếu credit/sai snapshot/funding/ending bị từ chối | Đạt |
| TC-126-08 | Fixture tính tay quanh nửa đêm Việt Nam, zero days, nhiều account cùng chủ cộng được thành 2 outgoing trong cùng ngày | Đạt |
| TC-126-09 | Fixture 9007199254740993đ qua CSV/replay/report và oracle median 3,5đ so bằng nhân chéo | Đạt |
| TC-126-10 | Real CLI tạo CSV + 2 sidecar, inspector subprocess, report/hash khớp | Đạt |
| TC-126-11 | CLI/API input boundaries, sentinel unchanged, I/O failure không in success, inspector invalid args/corrupt CSV | Đạt |
| TC-126-12 | Date.now/Math.random ném lỗi trong lần tái lập, hostile seed, UUID/schema và git check-ignore ba artifact | Đạt; `git status` không có generated CSV |

12/12 nhóm đạt độ sâu đã thiết kế, không bỏ/đơn giản hóa case. DoD 5 về PR/CI/review/merge chưa đạt, có **BL-151**; không tính là test pass.

### 8.3 Manual và thống kê đo được

Đã chạy lại `bash docs/features/screenshots/DBS-126/manual-test.sh` sau commit; [transcript UTF-8](screenshots/DBS-126/manual-test.txt) giữ lệnh, response và exit từng bước. Dòng đầu là **`8699311adccaa24a60abed488d6465efe500853c`**, tiếp theo SHA-256 bốn source file. **7/7 bước đạt trên commit code cuối**, đủ điều kiện đóng BL-153. Không có bước chưa chạy, không dùng SQL seed/DB để tạo dữ liệu.

| Bước | Lệnh / phản hồi thật rút gọn | Kết quả |
|---|---|---|
| M-126-01 | CLI mặc định → 73.106 rows, 723 fraud, rate 0,009889749131398244; đủ 8+5 nhóm; exit 0 | Đạt trên commit 8699311 |
| M-126-02 | CLI a/b; sha256sum + cmp CSV/simulation/stats → cả ba cặp cùng bytes, tất cả cmp exit 0 | Đạt trên commit 8699311 |
| M-126-03 | Seed dbs-fraud-v2 → 76.447 rows, 731 fraud; hash `9fb24e3d…` khác `fc08c565…`; cmp exit 1 như mong đợi | Đạt trên commit 8699311 |
| M-126-04 | Inspector a → report khớp sidecar bằng deepEqual, replay thành công; in header và một dòng thật mỗi scenario | Đạt trên commit 8699311 |
| M-126-05 | Customers 999 → exit 1, không artifact; 1000/30 → 18.773 rows, 159 fraud, 0,846961%, đủ nhóm, exit 0 | Đạt trên commit 8699311 |
| M-126-06 | Sửa snapshot bản sao giảm 1đ → `balance snapshot mismatch at row 1`, exit 1; inspector a nguyên bản sau đó exit 0 | Đạt trên commit 8699311 |
| M-126-07 | NORMAL CLI → 96.200 rows, hash `60e10c49…` giữ nguyên; 5 test đạt, gồm 4 test DBS-71 cũ và 1 trace mới | Đạt trên commit 8699311 |

Mẫu `dbs-fraud-v1`, 2.000 khách, 60 ngày:

| Chỉ số | Số đo |
|---|---|
| Fraud / toàn bộ | 723 / 73.106 = **0,988975%** |
| Fraud từng nhóm | ATO 90; mule 91; velocity 90; bust-out 91; round-trip 90; slow-drip 91; structuring 90; fan-in 90 |
| Hard negatives | Rent 3; self 1; new-salary 1; group-meal 5; borrow-repay 2 (12 rows) |
| Amount min / p50 / p90 / p99 / max | 2.000 / 507.000 / 2.541.000 / 8.960.000 / 60.795.000 đồng |
| Outgoing/khách/ngày, gồm zero | 120.000 customer-days; mean 0,6092167; p50 0; p90 2; max 45 |
| Tổng debit = credit | 80.100.216.350 đồng |
| Ending khách + funding | 207.873.984.000 + (−207.873.984.000) = 0; min customer balance 0 |
| SHA-256 CSV | `fc08c565275646cb19068f088749ae4a6f89e71eb7b172cc1804de8f7b57f7e1` |
| SHA-256 simulation / stats | `93b6a534392d57566c4385cb073ce902bf3f3fd2e38815bced7c1861a64525da` / `bc291565b3b5357164c6ba48bb3364a164d693d4125b1d4c30132e2ae6c85862` |

Không có precision/recall, split hoặc scoring online được đo. Cận rất lớn 100.000 khách/90 ngày chưa benchmark; còn **BL-155**, không nhận đã kiểm mọi cấu hình chỉ từ min/default.

### 8.4 Ảnh và phạm vi

Bốn ảnh chụp bằng browser từ **bản hiển thị read-only của output CLI thực tế**, không phải ảnh terminal native; header ảnh nêu final code commit `8699311adccaa24a60abed488d6465efe500853c`. JSON chỉ xuống dòng để đọc; transcript là nguồn raw. Trang HTML viewer là artifact ignored tại results, không đưa vào PR; đã dừng server localhost sau chụp.

- [01-summary.png](screenshots/DBS-126/01-summary.png): lệnh và report mặc định.
- [02-reproducibility.png](screenshots/DBS-126/02-reproducibility.png): sha256sum/cmp cả ba artifact.
- [03-inspection.png](screenshots/DBS-126/03-inspection.png): report replay độc lập.
- [04-rejection-recovery.png](screenshots/DBS-126/04-rejection-recovery.png): invalid input, cấu hình min, snapshot sai và bản gốc phục hồi.

Đã đối chiếu **23/23 file đúng §7.3**, không có file lạ hoặc generated CSV; diff commit code và docs/evidence chỉ gồm danh sách được duyệt. Không thêm dependency, env, backend hoặc migration. Source NORMAL chỉ thêm trace, giữ golden CSV. Không sửa worktree DBS-126 cũ hoặc dữ liệu người dùng. Link check 208 files/0 broken links, diff --check sạch. Bốn source hash khớp transcript; evidence UTF-8, không token/Authorization/AWS identifier.

**Lệch/gate phụ:** không đổi hành vi hoặc file ngoài kế hoạch. G4 đã ủy quyền xuất bản; final-code manual được chạy lại sau commit nên không còn ngoại lệ BL-153. Lỗi warmup đã được test bắt/sửa trong phạm vi; không bỏ case.

**Bàn giao:** BL-151 (CI/review/merge); BL-152 (DBS-127, wall/split/giao); BL-154 (harness warning); BL-155 (giới hạn cohort/HN/quy mô và P5). Các BL-040/041/044/050/142 còn nguyên phạm vi G1, không đóng bằng suy đoán.

**G4:** Người dùng trả lời “duyệt g4” ngày 2026-11-06 cho đề xuất commit → chạy lại manual trên code SHA cuối → cập nhật bằng chứng → push và mở Draft PR. Đã commit code và chạy lại manual đủ 7/7; đang hoàn tất xuất bản. Không tự merge/sửa board; Dev khác review PR.

## 9. Tài liệu đã cập nhật

- Tài liệu này, [feature index](README.md), [BACKLOG](../BACKLOG.md): thêm BL-151/152/154/155; BL-153 đã giải quyết bằng final-code manual và xóa khỏi backlog.
- [README generator](../../load-tests/fraud-dataset/README.md), [README load-tests](../../load-tests/README.md), [dataset brief](../components/fraud-dataset/01-concept-brief.md): cách chạy, report thực tế, giới hạn cohort và handoff DBS-127.
- Hai review nguyên văn §6 giữ nguyên; script/transcript/verification và bốn ảnh §8 bổ sung bằng chứng.

## Checklist G4

- [x] 12/12 nhóm TC đạt đủ độ sâu, 0 đơn giản hóa; 59 Node tests đạt, không skip.
- [x] Manual M-126-01–07 đạt trên final code commit `8699311adccaa24a60abed488d6465efe500853c`; SHA dòng đầu transcript, bốn ảnh cập nhật; BL-153 đã giải quyết.
- [x] Đủ 4 ảnh output thật và transcript UTF-8; đã kiểm không có token, header Authorization, AWS account hoặc ARN.
- [x] 23 file đúng §7.3, diff code + docs/evidence không có file lạ hoặc generated CSV.
- [x] Baseline/verification chạy lúc bàn giao: lint/typecheck/build đạt; unit 832, e2e 135, DB 369, Node 59; cảnh báo listener đã ghi.
- [x] Tài liệu đã cập nhật, link check sạch; status Implemented sau duyệt G4; handoff và DoD chưa đạt có BL-151/152/154/155.
