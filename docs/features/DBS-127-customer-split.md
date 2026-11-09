# DBS-127 · Chia tune/holdout theo khách hàng

> **Status:** Implemented · **Vai:** Dev dataset · **Nhánh:** `codex/dbs-127-dataset-split` · **PR:** — · **Cập nhật:** 2026-11-09

## 1. Bối cảnh

Task tuần 4, High, P5; board In Progress; DBS-126 Done và code trên main. **Expect:** #4 chạy được offline trên tập tune, holdout được giữ kín.

**DoD (nguyên văn):**
1. Chia theo khách hàng 70/30 bằng seed cố định; không khách nào xuất hiện ở cả hai tập
2. CSV tune giao #4 trong tuần 4 (ghi ngày giao); nhãn holdout lưu riêng, không nằm trong repo công khai hay thư mục #4 truy cập
3. #4 xác nhận chạy được offline trên tập tune
4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ

Thực trạng chạy thật: mixed mặc định DBS-126 có 2.000 khách; thành phần liên thông lớn nhất gồm 1.500 khách. Giữ mọi giao dịch và không để cả người gửi lẫn người nhận ở hai tập thì không thể chia thành 1.400/600. Chia theo sender đơn thuần sẽ lộ khách nhận; bỏ giao dịch xuyên tập làm sai lịch sử và số dư. User đã chọn sinh hai cohort độc lập trước khi sinh giao dịch; CLI không nhận CSV mixed cũ làm input.

Baseline: Node tests dataset 60/60, không skip; backend chung lint/typecheck/unit 1184/E2E153 xanh. Không sửa backend runtime. Nhận phần split của BL-171; giao tune, ACL nơi giữ nhãn và xác nhận của #4 chưa có bằng chứng, giữ bàn giao. BL-044/050 đánh giá và provenance AI, BL-162 tích hợp risk nằm ngoài phạm vi. Không sửa board, không phát sinh số đo recall hoặc xác nhận thay người nhận.

**Quyết định G1 (agent tự quyết, phạm vi cuối theo user):** sinh hai cohort độc lập trước giao dịch bằng seed cố định. Mặc định tổng 4.000 khách (2.800/1.200) vì generator mixed hỗ trợ tối thiểu 1.000 khách mỗi lần; không giảm validation của DBS-126 hoặc sửa nguồn generator. Tỉ lệ 70/30 là số khách, không hứa số giao dịch đúng 70/30. User chưa có nơi giữ holdout riêng: chỉ chuẩn bị code/test và CSV tune; không lưu nhãn holdout thật vào workspace hoặc repo chia sẻ.

## 2. Hành vi

`generateSplitDataset({ seed, customers=4000, days=60 })`: tính tune=`floor(7*N/10)`, holdout=N-tune; cả hai >=1000, tổng 3334–100000, ngày30–90, seed1–128 ký tự. Gọi generator hiện có hai lần với SHA256 của `[seed, tên cohort]`. Hai registry khách/tài khoản và cả người gửi/người nhận không giao nhau, nên không cắt bỏ giao dịch hoặc lịch sử nào. Generator gọi inspector để replay từng bộ, giữ số dư và tiền BigInt đúng, đủ scenario và prevalence theo contract DBS-126. Không đổi seed mặc định/bytes của generator cũ. Cùng seed/tham số cho byte-identical output, không phụ thuộc timezone/output path.

CLI `node load-tests/fraud-dataset/split.mjs --tune-dir <new-dir>` xuất `tune.csv` và manifest chỉ của tune. Có thể truyền `--seed`, `--customers`, `--days`. `--private-dir <new-dir>` là opt-in để lưu holdout có nhãn và manifest đầy đủ trong nơi Dev đã kiểm quyền. Từ chối private-dir trong checkout, bên trong tune-dir hoặc ngược lại; kiểm realpath của parent để không lách symlink. Từ chối output directory đã tồn tại, tránh ghi đè. Tạo private dir mode 0700 và file 0600 trên POSIX; Windows phải kiểm ACL ngoài công cụ. Không khẳng định chmod đảm bảo ACL Windows. Không in seed/labels/scenario stats hoặc path nhãn vào summary công khai; stdout chỉ thông tin tune và số khách của hai nhóm.

Không cần private-dir để tạo tune: holdout chỉ ở RAM, không persist. Manifest tune chứa version, CSV sha256, số dòng/số khách và schema; không source seed, code, oracle, simulation hoặc holdout IDs. Giữ đúng 12 cột CSV, `scenario` và `is_fraud` chỉ là nhãn, không feature. Không gửi message cho #4 khi chưa được user yêu cầu rõ.

## 3. Kiến trúc

File mới `load-tests/fraud-dataset/split.mjs`, `split.test.mjs`, `load-tests/verify-tune.mjs` (CSV-only, không import generator); `.github/workflows/ci.yml` nối suite split vào bước dataset hiện có và giữ nguyên ba suite cũ; dùng `generateFraudDataset`, `inspectDataset`, Node stdlib, không dependency mới. Runtime không gọi DB/AWS/backend. Không đổi exported symbol cũ hoặc schema/ADR. Dataset generator chỉ Dev dataset đọc; reviewer không mở source kín, đánh giá contract trong doc này và tài liệu công khai.

Thuật toán tổng khách tối đa100000; cần test hiệu năng và bộ nhớ trên mức lớn, không tuyên bố mọi mức đã nghiệm thu. API trả `{tune:{csv,simulation,stats},holdout:{csv,simulation,stats}}`. Simulation dùng để replay nội bộ, không giao cho #4. `writeSplit` chỉ ghi sau khi validate input/đường dẫn; khi I/O lỗi không báo thành công; không coi output dở là package hoàn tất. Dùng directory riêng mới và completion manifest cuối.

## 4. Test cases tự động

| ID | DoD | Lớp | Given · When · Then |
|---|---|---|---|
| TC-127-01 | 1 | Node | Fixed seed → byte-identical tune/holdout cả CSV, manifest và stats |
| TC-127-02 | 1 | Node | 4.000 khách → 2.800/1.200; giao cả hai đầu giao dịch/registry/accounts không trùng |
| TC-127-03 | 1 | Node | Tx IDs không trùng và inspector replay riêng mỗi cohort, không mất lịch sử trong cohort |
| TC-127-04 | 1 | Node | Cả from/to_customer cùng registry của tập, kể cả khách không hoạt động được tính vào 70/30 |
| TC-127-05 | 1 | Node | Tổng/seed/ngày sai bị từ chối; 3335 khách chia2334/1001 đúng floor70% |
| TC-127-06 | 2 | CLI | Tune-only không tạo holdout; manifest không leak seed/nhãn holdout, CSV hợp đồng 12 cột |
| TC-127-07 | 2 | CLI | Private path trong repo/nested/symlink/existing bị từ chối trước output; private hợp lệ chỉ được ghi opt-in |
| TC-127-08 | 1,2 | CLI | Invalid args/duplicate/noninteger/I/O fail → exit1, không success manifest; tiền trên 2^53 và schema do inspector kiểm |
| TC-127-09 | 1 | CLI | Hai output path/timezone → hash CSV giống nhau |
| Quy trình | 2,3,4 | Bàn giao | Ngày giao tune, ACL riêng, #4 xác nhận, CI/review/merge cần bằng chứng riêng |

## 5. Test thủ công

| Bước | Thao tác | Kỳ vọng |
|---|---|---|
| M-127-01 | Chạy CLI tune-only hai lần, đường dẫn mới, SHA256 và đọc header/count | Hash giống, đủ 12 cột và 2.800 khách |
| M-127-02 | Chạy `node load-tests/verify-tune.mjs <tune.csv>`: CSV-only kiểm đúng header, UUID/customer IDs, money canonical bằng BigInt, timestamp UTC canonical, nhãn0/1 và scenario allowlist; xuất count/hash | Không cần generator hoặc mạng; đây là kiểm tương thích Dev, không nhận thay #4 |
| M-127-03 | Chỉ định private-dir trong repo hoặc trùng/nested tune-dir, options hỏng | Từ chối trước ghi |
| M-127-04 | Có private-dir đã xác nhận ACL: sinh/lưu holdout, kiểm không tracked và #4 không đọc được | Chưa chạy nếu chưa có nơi riêng/quyền để kiểm |
| M-127-05 | Giao tune đúng kênh được phép, ghi ngày giao, nhận xác nhận offline của #4 | Không tự gửi hoặc tự xác nhận |

## 6. Domain review (AI)

Reviewer độc lập GPT-6 Astra (high). Vòng 1: 0 blocking, 2 should-fix (nối test vào CI và định danh CLI kiểm offline). Đã sửa §3/§5; tái review: `Verdict: APPROVE`. Review chỉ thiết kế, không phải Dev review PR.

[Trả lời nguyên văn của lần tái review cuối](screenshots/DBS-127/domain-review.md); sau lựa chọn của user và rebase main, reviewer xác nhận không có finding mới.

**Quyết định G2 (agent tự quyết):** qua; giữ giao thức CSV12 cột, hai cohort độc lập và không persist holdout khi chưa có nơi riêng.

## 7. Kế hoạch triển khai

| Bước | File | Test viết trước / lệnh | Commit |
|---|---|---|---|
| 1 | `load-tests/fraud-dataset/split.mjs`, `split.test.mjs`; `load-tests/verify-tune.mjs` | Node test deterministic/disjoint/replay/CLI/paths/offline; chạy đỏ vì module chưa có; `node --test load-tests/fraud-dataset/split.test.mjs` | `feat(fraud-dataset): separate tune and holdout customer cohorts (DBS-127)` |
| 2 | README dataset, load-tests/README, feature index, BACKLOG, feature doc, `.github/workflows/ci.yml`, evidence | full Node dataset tests, doc-links, CLI thật hai lần + verifier độc lập | `docs(fraud-dataset): record split evidence and remaining handoff (DBS-127)` |

Sweep: không thay generator/scenarios/inspector hiện có; không thêm dependency. CI giữ ba suite cũ và thêm suite split. Rủi ro: tăng mặc định4000 khách; ghi rõ count/ratio; privacy ngoài ACL không tự xác minh. Back-out: revert task, không ghi đè output cũ. **Quyết định G3 (agent tự quyết):** kế hoạch đủ test-first và manual, qua; không có tác động runtime/money.

## 8. Kết quả

**Gate phụ trước code (2026-11-09):** user chọn “Tạo hai nhóm khách độc lập 70/30” và xác nhận chưa có thư mục riêng. Thu hẹp §2–4: không cung cấp generic splitter cho CSV có sẵn; chỉ `generateSplitDataset` tạo cohort trước giao dịch, tránh phần subset-sum không cần cho lựa chọn đã chốt. TC04/05 trở thành kiểm biên count/seed và chứng minh không trùng cả hai đầu; không bỏ assertion disjoint/replay. Không persist holdout thật trong manual. Các kiểm CLI private dùng fixture tổng hợp nhỏ ở temp và xóa sau test, không phải artifact holdout dùng nghiệm thu. Không train/tune/scoring hay xác nhận thay #4.

**Đồng bộ main:** rebase lên `9520b8b`; không sửa code backend/DBS-101 đã merge. Commit code cuối `c3c6ffbb4765295b55dfc676468063a5ffdad697`. Test đầu đỏ vì module split chưa tồn tại; sau triển khai9/9 xanh; thêm I/O boundary thành10/10, cùng60 test cũ thành70/70. Chạy lại đầy đủ sau rebase:70/70 xanh, skipped0. [Kết quả tự động](screenshots/DBS-127/automated-tests.txt) giữ command/summary; output verbose cũ giữ cục bộ để không công bố chi tiết oracle của generator.

| ID | Test thực tế trong `split.test.mjs` | Kết quả |
|---|---|---|
| TC-127-01 | same seed produces byte-identical independent cohorts | đạt |
| TC-127-02/03/04 | both endpoints, accounts and all registry customers are disjoint2800/1200; inspector replay | đạt |
| TC-127-05 | invalid options; odd totals2334/1001 | đạt |
| TC-127-06 | tune-only writes no holdout/source/seed/simulation artifact | đạt |
| TC-127-07 | nested/checkout/existing/symlink paths reject; private transport fixture separate | đạt; fixture không chứng minh ACL thực tế |
| TC-127-08 | CLI args, I/O failure, CSV corruption và tiền trên2^53 | đạt |
| TC-127-09 | CLI hai timezone/output path và CSV-only verifier | đạt |
| DoD2/3/4 quy trình | BL-171, BL-202 | chưa hoàn tất |

**Manual trên commit code cuối:** [output thô Git Bash](screenshots/DBS-127/manual-test.txt).

| Bước | Lệnh/phản hồi thật | Kết quả |
|---|---|---|
| M-127-01 | CLI hai directory mới, `cmp` hai CSV và artifact bàn giao; registry2800/1200,101551 dòng, hash6366f108…b122c0, holdoutPersisted=false | đạt |
| M-127-02 | `node load-tests/verify-tune.mjs <tune.csv>` →101551 dòng,2485 khách hoạt động, cùng hash | đạt kiểm Dev; không thay xác nhận #4 |
| M-127-03 | private-dir trong checkout →exit1; output public chưa được tạo | đạt |
| M-127-04 | User chưa có private store; chưa ghi nhãn holdout thật hoặc kiểm ACL | **chưa chạy**, BL-171 |
| M-127-05 | Chưa có kênh giao #4 hoặc xác nhận độc lập; ngày tạo/giao artifact cho user2026-11-09 không ghi thành ngày giao #4 | **chưa chạy**, BL-171 |

Artifact giao user: tune.csv + manifest, không simulation hoặc holdout. Không có PNG: thiếu `01-cli.png`, `02-offline.png` vì lệnh chạy bằng terminal không có bề mặt UI chụp; không tạo ảnh giả từ output. Output text thực đã giữ. PR nêu hai ảnh thiếu này. Diff gồm đúng các file §7; >400 dòng vì hai CLI mới, test biên/filesystem/offline và bằng chứng cùng một thay đổi dữ liệu, tách PR sẽ làm implementation không có test/contract đi kèm. Không thêm dependency, không sửa env/secrets/board hoặc merge.

**Bàn giao:** BL-171 (private store/ACL, ngày giao #4, xác nhận offline), BL-202 (CI/review/merge); BL-173 giữ benchmark lớn và giới hạn tổng hợp, không nhận là đã nghiệm thu100000 khách. Không xóa BL-171 vì DoD còn thiếu.

## 9. Tài liệu đã cập nhật

`load-tests/fraud-dataset/README.md`, `load-tests/README.md`, `docs/features/README.md`; sửa BL-171, thêm BL-202 ở `docs/BACKLOG.md`; raw manual và domain review; summary tự động. Không sửa fact/schema/contract của backend.

## Checklist G4

- [x]9/9 case ID tự động đạt (10 test mới), không case tự động đơn giản hóa;70/70 toàn bộ dataset, skip0.
- [x]Manual M01–03 trên commit code cuối; M04/M05 chưa chạy và lý do/BL-171 nêu rõ.
- [x]Transcript UTF8 không token/credential/ARN; thiếu01-cli.png và02-offline.png được nêu rõ, không dùng ảnh giả.
- [x]Diff khớp §7 và gate phụ; không backend hoặc production dependency.
- [x]Baseline standalone dataset, CLI/verifier, doc-link check lúc bàn giao được chạy; không dùng test backend cũ làm bằng chứng cho generator mới.
- [x]Docs cập nhật, review APPROVE; chỉ chuyển Implemented sau G4. CI/review/merge chưa hoàn tất →BL-202.
- [x]Mọi việc bàn giao/DoD chưa đạt đã có BL-171/BL-202; benchmark lớn còn BL-173.

**Quyết định G4 (agent tự quyết, 2026-11-09):** qua với phần code/local đã kiểm; các tiêu chí thực địa và quy trình chưa đạt được giữ ở BL-171/202. Không ghi task Done. Không yêu cầu approval lại cho phạm vi user đã chọn.