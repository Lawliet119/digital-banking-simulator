# DBS-155 · CI quét lỗ hổng image và quét secret

> **Status:** Implemented · **Vai:** #5 Platform & Ops · **Cặp đôi review:** một Dev không phải tác giả · **Nhánh:** `infra/DBS-155-ci-image-secret-scan` · **PR:** [#147](https://github.com/Lawliet119/digital-banking-simulator/pull/147) · **Cập nhật:** 2026-11-12

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 6, Ưu tiên High, Deliverable P3, board đang "To Do" (người dùng chuyển sang "In Progress"). **Thực trạng (board):** "CI mới build và đẩy image (scan on push của ECR chưa đủ làm cổng chặn)." **Expect:** "Lỗi bảo mật nghiêm trọng bị chặn ngay trong PR/CI."
- **DoD** (nguyên văn):
  1. Bước quét image (vd Trivy) fail khi có lỗ hổng mức cao/nghiêm trọng có bản sửa; bước quét secret (vd gitleaks) fail khi phát hiện
  2. Danh sách ngoại lệ có lý do và hạn xem lại
  3. PR thử có secret giả hoặc dependency lỗi → CI đỏ; kết quả quét đính vào bản nộp P3
  4. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc:** DBS-36 (build image, đẩy ECR tag SHA qua OIDC): Done trên board; `.github/workflows/image.yml` có trên `main` (`17b011e`). Mọi lần chạy `image.yml` trên `main` đều `skipped` vì repo chưa có biến `AWS_ROLE_ARN` (BL-034).
- **Đã có gì** (đã mở file và chạy lệnh, `main` = `17b011e`):

| Nơi | Hiện trạng |
|---|---|
| [`ci.yml`](../../.github/workflows/ci.yml) | Trigger `pull_request` và `push` `main`; sáu job `lint`, `typecheck`, `unit`, `e2e`, `db`, `build` (dòng 32–231). Không job nào build image hay quét gì. Tên job là hợp đồng với required checks (dòng 3–6). |
| [`image.yml`](../../.github/workflows/image.yml) | Chỉ `push` `main` và `workflow_dispatch`; job `image-push`: `docker build` (dòng 65–72) rồi `docker push`; bước "Kết quả scan" (dòng 75–82) chỉ đọc `findingSeverityCounts` của ECR, lỗi chỉ `::warning::`, không chặn. |
| [`deploy.yml`](../../.github/workflows/deploy.yml) | `workflow_run` sau `Image`; không liên quan quét. |
| [`check-image-workflow.py`](../../.github/scripts/check-image-workflow.py) | Kiểm tĩnh `image.yml`: một job `image-push`, không chuỗi `pull_request`, không chuỗi `latest`, mọi `uses:` ghim SHA 40 ký tự; chỉ `image.yml`/`deploy.yml` được xin `id-token`. Chạy local: `OK`. Chỉ chạy trong `image.yml`/`deploy.yml` (sau merge), chưa chạy ở CI của PR. |
| [`backend/Dockerfile`](../../backend/Dockerfile) | Ba stage `node:24-alpine` (tag, không ghim digest), runtime chạy user `node`, `ADD --checksum` bundle CA RDS. `.dockerignore` loại `test`, `env`, `.auth-local`. |
| [`ecr.tf`](../../infra/terraform/envs/dev/base/ecr.tf) | `scan_on_push = true` (dòng 8–10), quét cơ bản của ECR, chạy sau khi đã push nên không chặn được. |
| Ghim action | Mọi `uses:` ghim SHA kèm comment phiên bản; quy tắc ở [CONTRIBUTING §4b](../../CONTRIBUTING.md#4b-đọc-kết-quả-ci-trên-github-actions) và BL-013. |
| Trivy, gitleaks | Không có trong repo (grep `trivy`, `gitleaks` trong `.github/`: 0). |

- **Baseline local** (máy này: không có Docker, Trivy, gitleaks, actionlint, act; Node 26.11.1 dù `.nvmrc` = 24; 12 CPU, 7,6 GB RAM):

| Lệnh (trong `backend/`) | Kết quả |
|---|---|
| `npm run lint:check` | thoát 0 |
| `npm run typecheck` | thoát 0 |
| `npm test` | lần đầu bị kill (137, hết RAM với 12 worker); `npm test -- --maxWorkers=3`: 110/110 suite, 1870/1870 test đạt |
| `npm run test:e2e -- --maxWorkers=3` | thoát 1: 14/17 suite, 149/149 test đạt; 3 suite (`metrics`, `roles-app`, `app-guard`) đỏ vì `ECONNREFUSED 127.0.0.1:5432`: không có PostgreSQL vì không có Docker. Không phải lỗi code |
| `npm run build` | thoát 0 |
| `node --test ../load-tests/fraud-dataset/*.test.mjs` (4 file của job `unit`) | 70/70 đạt |
| `test:db`, `test:services` | không chạy được (cần Docker) |
| `python3 .github/scripts/check-image-workflow.py` (gốc repo) | `OK` |

- **Phát hiện ban đầu (đọc, không sửa):**
  - `npm audit --omit=dev`: 10 lỗ hổng ở dependency production: 4 high, 6 moderate, 0 critical. Bốn high đều có bản sửa trong dải semver hiện tại: `body-parser` 2.0.0–2.3.0 (GHSA-27r3-jxmh-p828), `multer` 2.0.0–2.4.0 (GHSA-q7qp-rjg7-q26m, qua `@nestjs/platform-express`), `joi` 18.0.0–18.3.0 (GHSA-4528-x5fx-h6hg). Cả cây (gồm dev): 1 critical, 6 high, 37 moderate, 2 low; dependency dev không vào image. Nghĩa là cổng Trivy bật hôm nay sẽ **đỏ ngay**.
  - Quét lịch sử git bằng regex (`git log --all -p`, script tạm ở scratchpad, giá trị đã che; `git rev-list --count HEAD` = 138, `--all` = 494 vì có 52 nhánh remote): khối `PRIVATE KEY` có thân khóa chỉ ở `backend/test/support/tls-fixtures/server.key` (ngoại lệ CONTRIBUTING §6, BL-111); các chỗ khác chỉ là dòng tiêu đề (`dev-auth.spec.ts`, manual-test DBS-53, tài liệu). Hai chuỗi dạng JWT ở `logging.options.spec.ts` và tài liệu review DBS-42 (token thử). Không có `AKIA…`, `ghp_…`, `sk-…`, `xox…`, `AIza…`. Ước lượng này đã được thay bằng số đếm thật ngay dưới.
  - **gitleaks 8.30.1** (binary, `git --log-opts="HEAD" --redact`, bộ luật mặc định, chưa có cấu hình): thoát 1, "137 commits scanned", **122 phát hiện**: 1 `private-key` (`server.key`, BL-111) và 121 `generic-api-key`. Phân loại theo dạng giá trị (không in giá trị; report chưa che đã xóa): 113 là UUID trong `docs/features/screenshots/**/manual-test*.txt` (Idempotency-Key, `"key":"…"`, `idem_key`), 3 là id container Docker (hex 64) cùng thư mục, 5 là giá trị thử trong 5 file spec (`compose-redis-url`, `env.bootstrap`, `validation.schema`, `r2-unusual-amount`, `r3-new-account-large-transfer`). Không phát hiện nào giống credential thật; xử lý ở câu 13.
  - **Số commit gitleaks đếm không bằng một công thức git nào ổn định:** 137 so với `rev-list --count HEAD` = 138 (commit `a89b678` chỉ xóa file). Trên repo thử (§8) gitleaks còn bỏ commit chỉ đổi mode, chỉ đổi tên, rỗng, chỉ xóa file (kể cả commit revert xóa file), nên phép so bằng với `--diff-filter=AM` cũng sai. Chốt kiểu chặn ở H2.
  - **Lưu ý khi đo gitleaks:** gitleaks tự đọc `.gitleaksignore` ở **thư mục hiện tại** (mặc định `--gitleaks-ignore-path .`) và `.gitleaks.toml` ở thư mục được quét khi không có `--config`, cộng thêm với file truyền tường minh. Một lần đo baseline chạy trong repo đã có `.gitleaksignore` cho 114 thay vì 122; đo lại từ thư mục khác, với `--config` mặc định và ignore rỗng, ra lại 122 (5 spec, 3 id container DBS-40, 113 UUID, 1 khóa). Trong CI `run-gitleaks.sh` luôn truyền tường minh cả hai file.
  - **Trivy 0.76.1** `fs` trên `backend/package-lock.json` (dependency production, DB tải từ `mirror.gcr.io`): CRITICAL 0; HIGH 3 (cả 3 có bản sửa): `body-parser` 2.3.0 → 2.4.0 (CVE-2026-111181), `joi` 18.2.9 → 18.3.1 (CVE-2026-118772), `multer` 2.4.0 → 2.5.0 (CVE-2026-113872); MEDIUM 4 (có bản sửa); LOW 0; không có lỗi chưa có bản sửa. Lệnh chặn (a) thoát 1. `fs --scanners secret` trên cây (trừ `node_modules`): 0 phát hiện, thoát 0. Gói Alpine và `npm` đi kèm image `node` chưa quét được (cần image, chỉ có trên CI).
  - Chưa có bản ghép P3: [deliverables README](../deliverables/README.md) ghi P3 (Security & DevOps, #5, tuần 6) "chưa nộp", nguồn là `components/ci-cd`, threat model.
- **BACKLOG liên quan:**

| Dòng | Quyết định |
|---|---|
| BL-035 (chặn theo mức nghiêm trọng khi scan image và quét secret) | **Nhận phần quét**, không xóa dòng: điều kiện đóng còn "BL-012 xong", ngoài task này. Phase 5 thu hẹp BL-035 về đúng phần đó (thêm `image-scan`, `secret-scan` vào ruleset) và ghi ở §9 |
| BL-111 (allowlist gitleaks đúng đường dẫn `server.key`) | **Nhận**, xóa dòng |
| BL-013 (tên job khác sáu tên, `uses:` ghim SHA cho workflow quét) | **Nhận** phần quét; phần deploy đã có từ DBS-38, nên xóa dòng |
| BL-012 (required checks của `main`) | **Nêu tên**. DBS-37 Done trên board nhưng dòng còn; không kiểm được ruleset vì không gọi GitHub trước G3. Job mới chỉ chặn merge khi chủ repo thêm `image-scan`, `secret-scan` vào ruleset: phần này nằm ở BL-035 đã thu hẹp |
| BL-034, BL-104 (`image.yml` luôn `skipped` vì thiếu `AWS_ROLE_ARN`) | **Nêu tên**: bước chặn trong `image.yml` chỉ chứng minh được bằng kiểm tĩnh và chạy local cho tới khi biến có |
| BL-106 (`docker build` thật chưa chạy) | **Nêu tên**: job `image-scan` sẽ build thật trên runner (chứng minh `ADD --checksum`), ghi task này thêm làm nguồn ở Phase 5; phần AWS vẫn mở |
| BL-028 (Terraform trong CI), BL-225 (ghim image ElasticMQ) | **Nêu tên**, ngoài phạm vi |

- **Ngoài phạm vi:** sửa ruleset/required checks (chủ repo, BL-012); quét IaC/Terraform (BL-028); quét lỗ hổng dependency dev (không vào image); SBOM, ký image; chặn deploy theo kết quả scan ECR; viết bản ghép P3 (người dẫn dắt P3), task này chỉ đặt kết quả quét ở nguồn `components/ci-cd` và link từ hàng P3.
- **Câu hỏi mở** và **Quyết định ở G1** (agent tự quyết, 2026-11-11):

| # | Câu hỏi | Quyết định và lý do |
|---|---|---|
| 1 | Công cụ | **Trivy** cho image (lỗ hổng OS Alpine và gói npm trong image, kèm quét secret trong image), **gitleaks** cho repo. Đúng ví dụ DoD, docs/03 §12 ("quét bí mật trong CI"), NFR-SEC-04 ([BRD](../BRD.md): 0 bí mật trong mã nguồn, đo bằng quét trong CI), threat model T16. |
| 2 | Cách chạy, có tính là thêm dependency không | **Có**, là gate phụ (ghi ở §8). Chạy bằng **image Docker chính thức ghim digest**: `ghcr.io/aquasecurity/trivy:0.76.1@sha256:…` (GHCR, không Docker Hub ẩn danh bị giới hạn lượt kéo) và `ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:…`; không dùng action marketplace (không thêm JavaScript bên thứ ba chạy với token của job; gitleaks-action cần license với tài khoản tổ chức). Phiên bản và digest đã chọn: xem §8 "Chọn phiên bản" (digest index đa kiến trúc trùng nhau ở GHCR, ECR Public và Docker Hub; không có cosign nên không kiểm chữ ký, người dùng chưa cho tải cosign). Local dùng binary chính thức cùng phiên bản. |
| 3 | Đặt ở workflow/job nào | Hai job mới trong `ci.yml`: **`image-scan`** (build image, `docker save`, Trivy trên file tar) và **`secret-scan`** (gitleaks, cộng kiểm tĩnh workflow và ngoại lệ), chạy mọi PR và push `main`, tên khác sáu tên hợp đồng, `working-directory: .` (gốc repo; `ci.yml` mặc định `backend`). Trong **`image.yml`**: build, save, Trivy **trước** `configure-aws-credentials`; chỉ khi Trivy thoát 0 mới lấy credential, kiểm tag và push. Không nhét vào job `build`: đổi nghĩa một check hợp đồng và CONTRIBUTING §4b. |
| 4 | Ngưỡng | Trivy `--severity HIGH,CRITICAL --ignore-unfixed --exit-code 1` (đúng "cao/nghiêm trọng có bản sửa"); thêm một bước chỉ in (exit 0) HIGH/CRITICAL chưa có bản sửa để người đọc thấy. MEDIUM/LOW không chặn. Secret trong image: một lượt Trivy riêng `--scanners secret` **không lọc mức**, mọi phát hiện là đỏ. gitleaks: mọi phát hiện (bộ luật mặc định) là đỏ, `--redact`. |
| 5 | Ngoại lệ | Ba file ở gốc repo, mỗi mục có lý do và hạn xem lại. Trivy: **`.trivyignore.yaml`** (`statement`, `expired_at`; Trivy tự bỏ mục quá hạn nên lỗ hổng hiện lại). gitleaks theo đường dẫn: **`.gitleaks.toml`** (`useDefault = true`, `description` chứa `Hạn xem lại: YYYY-MM-DD`; path là đúng một file, trừ khi cùng allowlist có `targetRules`, `regexes` và `condition = "AND"`, xem H4). gitleaks theo phát hiện cụ thể trong commit đã có trên `main` (không viết lại được lịch sử): **`.gitleaksignore`**, mỗi fingerprint `commit:file:rule:line` có dòng `#` ngay trên ghi lý do và hạn. Hạn: **cuộn 90 ngày** (≤ hôm nay + 90 ngày, UTC), không gắn ngày kết thúc dự án; các mục để hạn lệch nhau để không hết hạn cùng ngày. `.trivyignore.yaml` luôn có trong repo (tối thiểu `vulnerabilities: []`), thiếu file là đỏ. `.github/scripts/check-scan-exceptions.py` đỏ khi thiếu lý do/hạn, hạn đã qua hoặc quá 90 ngày. Hạn qua là **cố ý đỏ**: #5 xem lại lý do rồi gia hạn bằng PR; người gia hạn là người review PR đó. |
| 6 | gitleaks quét gì | **Lịch sử tới `HEAD`** (`fetch-depth: 0`, `--log-opts="HEAD"`) ở cả PR (HEAD là merge commit nên gồm commit của PR và `main`) và `main`. Không quét `--all` (mặc định của chế độ `git`): checkout `fetch-depth: 0` kéo cả 52 nhánh remote (`rev-list --all` = 494 so với `HEAD` = 138), nên một nhánh rác có secret sẽ làm mọi PR đỏ. Secret đã revert trong PR vẫn đỏ; nhánh lỡ commit secret phải rotate rồi viết lại lịch sử nhánh (CONTRIBUTING §6). Chống xanh giả do công cụ hoặc clone (clone nông, `safe.directory`, mount sai): repo không nông, gitleaks quét ít nhất 1 commit và ít nhất 90% số commit không phải merge tới `HEAD` (H2). |
| 7 | 4 lỗ hổng high đang có bản sửa | **Sửa trong task này** bằng cập nhật `package-lock.json` trong dải semver hiện tại (không đổi `package.json` nếu dải cho phép), vì cổng không được đỏ ngay lúc merge và ngoại lệ cho lỗi đã có bản sửa đi ngược DoD #1. Gate phụ (đổi dependency, ghi §8); CI sáu job chứng minh không vỡ. Phát hiện Trivy khác npm audit (gói Alpine, `npm` đi kèm image `node`) xử lý ở Phase 4 theo kết quả thật: ưu tiên sửa (vd bỏ `npm`/`npx` khỏi stage runtime, runtime không dùng npm: `ecs.tf` dòng 99), cuối cùng mới là ngoại lệ có hạn. |
| 8 | Chứng minh "PR thử → CI đỏ" khi chưa lên GitHub | Trước G3 không chạm GitHub. Phase 4: chạy local đúng image, phiên bản và tham số workflow dùng (nhánh thử cục bộ có secret giả, có dependency lỗi, có ngoại lệ quá hạn). Sau đó chuẩn bị nhánh thử `test/DBS-155-scan-proof` (loại `test` có trong CONTRIBUTING §2) với các commit thử để coordinator đẩy lên Draft PR bỏ đi, **sau** khi Draft PR của nhánh task đã có run xanh (không chạy song song). Hai chuỗi tách nhau (ngoại lệ, rồi secret; chuỗi 2 cắt từ commit đầu nhánh task đã có run xanh ở M-08, không từ `main` vì `main` chưa có `secret-scan`), mỗi commit chỉ đẩy khi run trước đã xong vì `ci.yml` có `cancel-in-progress` cho PR (TC-19); xóa nhánh khi đã ghi link. Secret giả là khóa sinh ngẫu nhiên tại chỗ, không phải định dạng token của nhà cung cấp. Người dùng đã cho tải binary Trivy và gitleaks chính thức vào scratchpad; máy vẫn không có Docker nên phần cần `docker build` chỉ chứng minh trên CI (cột "Chạy được ở đâu" ở §4, §5). |
| 12 | CVE mới công bố làm PR không liên quan đỏ | Chấp nhận: base `node:24-alpine` theo tag và DB Trivy tải mới mỗi lần nên kết quả thay đổi theo ngày. Quy trình ở §2 H6. Ghim digest base image chuyển BACKLOG ở Phase 5 (đổi thì phải có người cập nhật digest, ngoài DoD). |
| 13 | 121 phát hiện `generic-api-key` sẵn có trong lịch sử | Không viết lại lịch sử `main`, không allowlist cả thư mục, không allowlist dạng hex 64. (a) Một allowlist chỉ cho luật `generic-api-key`, `condition = "AND"`, `regexTarget = "match"`: đoạn khớp phải là tên khóa idempotency (`key`, `idempotencyKey`, `Idempotency-Key`, `idem_key`) theo sau là **một UUID** và kết thúc ở đó, **và** file là `docs/features/screenshots/DBS-<n>/manual-test*.txt` (113 phát hiện). (b) 3 id container Docker (hex 64) ở `DBS-40/manual-test.txt` và 5 giá trị thử trong spec: 8 fingerprint trong `.gitleaksignore`, mỗi dòng có lý do và hạn. Đã chạy thử với gitleaks 8.30.1 (§8): lịch sử thật còn 0 phát hiện; `secret = <hex64>` mới trong `manual-test.txt`, `api_key = <uuid>` trong `.md`, bản sao `server.key` đều vẫn đỏ. Hệ quả còn lại: một UUID thật sự là secret ghi dưới tên `key=` trong log test thủ công sẽ lọt. |
| 9 | Kết quả quét cho P3 | Lưu bản tóm tắt kết quả (lệnh, phiên bản, số phát hiện theo mức, ngoại lệ) ở `docs/components/ci-cd/scan-results.md`, link từ concept brief ci-cd, hàng P3 của deliverables README và T16 của threat model. |
| 10 | Nhánh | `infra/`: CONTRIBUTING §2 ghi `infra` cho "Terraform, CI/CD"; DBS-35, DBS-41 dùng `infra/`. Không có loại `ci/`. |
| 11 | Board role | #5 khớp loại việc (CI quét image/secret là việc của #5 theo `platform.md`). |

## 2. Hành vi

Task không có API. Mô tả những gì CI chấp nhận và từ chối. `$T` là thư mục tạm của runner (`$RUNNER_TEMP`). Mọi lệnh chạy ở gốc repo (`working-directory: .`). **Cài đặt thực tế:** các đoạn lệnh H1, H2 dưới đây nằm trong [`run-trivy.sh`](../../.github/scripts/run-trivy.sh) và [`run-gitleaks.sh`](../../.github/scripts/run-gitleaks.sh) (§8 lệch 1); workflow chỉ gọi script và đặt image công cụ ghim digest, nên đoạn mã ở đây là dạng rút gọn, script mới là nguồn.

**H1. Job `image-scan` (`ci.yml`, mọi PR và push `main`, `timeout-minutes: 15`).**
- Bước: checkout (không giữ credential) → `docker build --provenance=false --sbom=false -t dbs-api:scan backend` → `docker save -o "$T/img.tar" dbs-api:scan` → tải DB → ba lượt Trivy.
- Container Trivy **không mount `docker.sock`**, không nhận biến môi trường của job, chỉ thấy thư mục cache DB và file cần quét (chỉ đọc). Lượt tải DB có mạng nhưng không thấy image; ba lượt quét chạy `--network none`, `--skip-db-update`, `--skip-java-db-update` (image không có JAR; thiếu cờ thì Trivy thử tải Java DB khi gặp JAR và đỏ vì không có mạng), `--offline-scan`:

```bash
TRIVY=ghcr.io/aquasecurity/trivy:0.76.1@sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c
DBREPO=mirror.gcr.io/aquasec/trivy-db:2,ghcr.io/aquasecurity/trivy-db:2
docker run --rm -v "$T/cache:/cache" "$TRIVY" image --cache-dir /cache --download-db-only --db-repository "$DBREPO"
test -f .trivyignore.yaml   # thiếu file thì docker -v tạo thư mục rỗng và Trivy lỗi khó hiểu: chặn trước
RUN="docker run --rm --network none -v $T/cache:/cache -v $T/img.tar:/scan/img.tar:ro -v $PWD/.trivyignore.yaml:/scan/.trivyignore.yaml:ro $TRIVY image --cache-dir /cache --skip-db-update --skip-java-db-update --offline-scan --input /scan/img.tar --ignorefile /scan/.trivyignore.yaml"
$RUN --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1   # (a) chặn lỗ hổng
$RUN --scanners secret --exit-code 1                                         # (b) chặn secret, không lọc mức; ngoại lệ ở mục secrets:
$RUN --scanners vuln --severity HIGH,CRITICAL --exit-code 0                                                       # (c) chỉ in, gồm lỗi chưa có bản sửa
```

- Kết quả (a): có ít nhất một lỗ hổng HIGH/CRITICAL có `FixedVersion` không nằm trong ngoại lệ còn hạn → thoát 1, job đỏ. Chỉ MEDIUM/LOW, hoặc HIGH/CRITICAL chưa có bản sửa → thoát 0 (lỗi chưa sửa hiện ở (c)). Kết quả (b): bất kỳ secret nào Trivy phát hiện trong các lớp của image, ở **mọi** mức → thoát 1.
- Ca biên: tải DB lỗi ở cả hai repo → bước tải thoát khác 0, job đỏ (fail-closed); chạy lại bằng "Re-run failed jobs". `docker build` lỗi (vd checksum bundle RDS đổi) → đỏ trước khi quét. Ngoại lệ quá hạn → Trivy bỏ mục đó, lỗ hổng hiện lại ở (a); đồng thời H4 đỏ.

**H2. Job `secret-scan` (`ci.yml`, mọi PR và push `main`, `timeout-minutes: 10`).**
- Bước: checkout `fetch-depth: 0` (không giữ credential) → `pip install pyyaml==6.0.2` → `python3 .github/scripts/check-image-workflow.py` (kiểm tĩnh mọi workflow, có fixture âm; xem H7) → `python3 .github/scripts/check-scan-exceptions.py` (H4) → gitleaks → so số commit.

```bash
set -o pipefail
docker run --rm -v "$PWD:/repo:ro" ghcr.io/gitleaks/gitleaks:v8.30.1@sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f \
  git /repo --log-opts="HEAD" --config /repo/.gitleaks.toml --gitleaks-ignore-path /repo/.gitleaksignore \
  --no-color --no-banner --redact --exit-code 1 --verbose 2>&1 | tee "$T/gitleaks.log"
scanned=$(sed -n 's/.* \([0-9]\+\) commits scanned.*/\1/p' "$T/gitleaks.log")
total=$(git rev-list --count --no-merges HEAD)
test "$(git rev-parse --is-shallow-repository)" = false
test -n "$scanned" && test "$scanned" -ge 1 && test "$scanned" -ge $(( (total * 9 + 9) / 10 ))
```

- `--no-color` bắt buộc: không có nó gitleaks 8.30.1 in mã ANSI trước số (`^[[1m8 commits scanned.`) kể cả khi không phải TTY, `sed` trả rỗng và bước đỏ mọi lần (đã thấy trên repo thử).
- Không so bằng: gitleaks không đếm commit chỉ đổi mode, chỉ đổi tên, rỗng, chỉ xóa file, nên mọi công thức git so bằng đều đỏ giả vĩnh viễn khi một commit như vậy vào `main`. Ngưỡng 90% số commit không phải merge: lịch sử thật đạt 138/139 và 138/140 (thêm một commit chỉ đổi tên); clone nông và 0 commit đều đỏ (§8). Ngưỡng chỉ chống lỗi công cụ hoặc clone; một `--log-opts` sai khoảng (vd `origin/main`, `HEAD~3`) vẫn quét trên 90% lịch sử và bỏ sót commit mới, nên khoảng commit do kiểm tĩnh H7 (đúng chuỗi `--log-opts="HEAD"`) và fixture âm TC-04 giữ, không do ngưỡng này. Không thêm `merge-base --is-ancestor`: cần SHA của PR truyền qua `env:` mà H7 đã bao phủ rẻ hơn. Ngưỡng có thể đỏ giả nếu hơn 10% lịch sử là commit không nội dung (repo thử 8/12): khi đó #5 xem lại ngưỡng bằng PR; lịch sử squash-merge của repo này không có dạng đó.

- Kết quả: bất kỳ phát hiện nào ở bất kỳ commit tới `HEAD` (trừ ngoại lệ còn hạn) → thoát 1; log chỉ có luật, file, dòng, commit, fingerprint, giá trị `REDACTED`. Không phát hiện → 0. Repo nông, gitleaks quét 0 commit hoặc dưới 90% (`safe.directory`, mount sai, `--log-opts` sai) → đỏ. `set -o pipefail` để `tee` không nuốt mã thoát.
- Ca biên: `backend/test/support/tls-fixtures/server.key` không báo (allowlist đúng đường dẫn); cùng nội dung ở đường dẫn khác vẫn báo. Secret đã revert vẫn đỏ. Nhánh remote khác có secret **không** ảnh hưởng (chỉ quét tới `HEAD`).

**H3. `image.yml`.** Thứ tự mới của job `image-push`: checkout → kiểm tĩnh → `docker build -t dbs-api:$IMAGE_TAG backend` → `docker save` → tải DB → Trivy (a) và (b) như H1 → `configure-aws-credentials` → ECR login → kiểm tag đã có → nếu chưa có: `docker tag` sang `$REGISTRY/$REPOSITORY:$IMAGE_TAG` và `docker push` → đọc scan ECR (chỉ cảnh báo, như cũ). Trivy thoát 1 → job đỏ trước khi có credential AWS hay token OIDC được dùng, không push, `Deploy` không chạy (chỉ chạy khi `Image` `success`). Hệ quả: image được build cả khi tag đã có trên ECR (vài phút runner, chấp nhận). Vẫn một job, không chuỗi `latest`, không `pull_request`.

**H4. Ngoại lệ** (ba file ở gốc repo).

`.trivyignore.yaml`:

```yaml
# Luôn có trong repo; không có ngoại lệ thì là `vulnerabilities: []` và `secrets: []`.
vulnerabilities:
  - id: CVE-2099-00000            # ví dụ dạng
    paths: ["usr/local/lib/node_modules/npm/node_modules/x/package.json"]
    statement: "Lý do cụ thể; ai chấp nhận (#5); cách đóng"
    expired_at: 2027-01-20
secrets:
  - id: private-key               # ví dụ dạng: khóa thử đi kèm một package
    paths: ["app/node_modules/some-pkg/test/fixture.key"]
    statement: "Khóa thử của package, không dùng ở runtime"
    expired_at: 2027-01-27
```

`.gitleaks.toml`:

```toml
[extend]
useDefault = true

[[allowlists]]
description = "Khóa thử TLS CN=localhost, CA đã hủy khóa, chỉ cho test (CONTRIBUTING §6, BL-111). Hạn xem lại: 2027-02-09"
paths = ['''^backend/test/support/tls-fixtures/server\.key$''']

[[allowlists]]
description = "Idempotency-Key (UUID) trong log test thủ công, không phải bí mật (§1 câu 13). Hạn xem lại: 2027-01-25"
targetRules = ["generic-api-key"]
condition = "AND"
regexTarget = "match"
regexes = ['''(?i)^"?(idempotency-?key|idem_key|key)"?\s*[:=]\s*"?[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}["\s]*$''']
paths = ['''^docs/features/screenshots/DBS-[0-9]+/manual-test[a-z-]*\.txt$''']
```

Đã chạy đúng cấu hình này với gitleaks 8.30.1 (§8). `Match` của luật bắt đầu ở tên khóa (không có dấu nháy mở: `key":"<uuid>"`) và kết thúc bằng khoảng trắng hoặc dấu nháy, nên regex có `"?` hai đầu và `["\s]*` ở cuối. Regex **neo đầu** (`^`) và chỉ cho ba tên khóa: bản cũ `\bkey` không neo cho `X-Api-Key: <uuid>`, `"client-secret-key": "<uuid>"`, `private.key=<uuid>` lọt qua (đã chạy so sánh ở §8, vòng 3 #1).

`.gitleaksignore` (chỉ khi cần, cho phát hiện trong commit bất biến trên `main`):

```text
# Id container Valkey (hex 64) trong log DBS-40, không phải bí mật. Hạn xem lại: 2027-01-18
6f6ec08941d3c2d17becdf87bb7a76b7cf87d58e:docs/features/screenshots/DBS-40/manual-test.txt:generic-api-key:15
# Mật khẩu thử trong spec ghép REDIS_URL, không phải credential. Hạn xem lại: 2027-01-04
7238cecbc35e1a98bacdde0c25341be2f5090461:backend/src/config/compose-redis-url.spec.ts:generic-api-key:6
```

Hai dòng mẫu lấy từ report baseline; bản đầy đủ có 8 fingerprint (3 dòng DBS-40, 5 spec).

`check-scan-exceptions.py` (Python chuẩn + PyYAML) thoát 1 và nêu tên mục khi: thiếu `.trivyignore.yaml`; mục Trivy (`vulnerabilities:` và `secrets:`) thiếu `statement` hoặc `expired_at`; allowlist gitleaks thiếu `description` hoặc không có `Hạn xem lại: YYYY-MM-DD`; một `paths` không neo `^…$`, hoặc có ký tự đại diện ngoài literal đã escape (`.`, `*`, `+`, `?`, `[`, `(`, `|`) mà allowlist đó không đồng thời có `targetRules`, `regexes` và `condition = "AND"` (vd `^docs/.+$` một mình là đỏ); fingerprint trong `.gitleaksignore` không có dòng `#` lý do + hạn ngay trên; hạn < hôm nay (UTC) hoặc > hôm nay + 90 ngày. Hạn qua thì CI đỏ có chủ ý cho tới khi #5 xem lại và gia hạn bằng PR. Chạy lại một commit cũ sau khi hạn của nó qua cũng đỏ: chấp nhận, vì cổng chỉ có nghĩa với đầu nhánh.

**H5. Dependency.** Cập nhật `package-lock.json` trong dải semver hiện tại cho `body-parser`, `multer` (qua `@nestjs/platform-express`), `joi`. Sau đó `npm audit --omit=dev` không còn high/critical; diff phiên bản resolve chỉ gồm các gói đó và phụ thuộc của chúng (ghi ở §8); `package.json` không đổi nếu dải cho phép. Rủi ro đường tiền: `joi` kiểm schema sự kiện outbox (`src/common/events/event-schemas.ts`) và cấu hình; `body-parser` giữ giới hạn kích thước body (413, BL-023).

**H6. CVE mới công bố làm PR không liên quan đỏ.** Base `node:24-alpine` theo tag và DB Trivy cập nhật mỗi lần chạy, nên một CVE mới có bản sửa có thể làm mọi PR đỏ qua đêm (gồm PR đường tiền, khi check thành bắt buộc). Quy trình: người thấy đỏ báo #5; #5 trong một ngày làm việc (1) sửa trước: nâng lockfile hoặc build lại với base mới; (2) chỉ khi chưa sửa được mới thêm ngoại lệ có lý do và hạn ≤ 90 ngày, review như PR thường. Image `ci.yml` quét và image `image.yml` đẩy có thể khác nhau (base theo tag, build khác thời điểm): vì vậy `image.yml` tự quét lại image chính nó đẩy (H3). Ghim digest base image: BACKLOG ở Phase 5.

**H7. Kiểm tĩnh chạy trên mọi PR.** Kiểm theo **đối số của lệnh gitleaks/Trivy tách từ `run:` bằng `shlex`**, không theo chuỗi con của cả file (để comment hay chuỗi nằm chỗ khác không đánh lừa được). `check-image-workflow.py` mở rộng và chạy trong `secret-scan` (H2), không chỉ trong `image.yml`/`deploy.yml` (luôn `skipped`, BL-034). Kiểm thêm: hai job mới tồn tại, tên không trùng sáu tên, `working-directory: .`, `timeout-minutes` có, `contents: read`, không `id-token`, `persist-credentials: false`; image công cụ ghim `@sha256:` 64 hex trên GHCR; đủ cờ ở H1/H2 (gồm `--log-opts="HEAD"`, `--no-color`, `--redact`, `--network none`, `--skip-java-db-update`, `--ignorefile` ở cả (a) và (b), `fetch-depth: 0`, các dòng chặn nông và 90%); không chuỗi `docker.sock` ở bất kỳ workflow nào; trong `image.yml` bước Trivy đứng trước `configure-aws-credentials` và `docker push`; `ci.yml` có bước gọi chính script này. Mỗi điều có fixture âm.

## 3. Kiến trúc

- **Vị trí:** `.github/workflows/ci.yml` (hai job mới), `.github/workflows/image.yml` (sắp lại bước), `.github/scripts/check-image-workflow.py` (H7), mới `.github/scripts/check-scan-exceptions.py`, `.github/scripts/tests/test_check_scan_exceptions.py`, `.trivyignore.yaml`, `.gitleaks.toml`, `.gitleaksignore` (nếu cần); `backend/package-lock.json`; có thể `backend/Dockerfile` (§1 câu 7, theo kết quả Trivy). Không đổi code ứng dụng; role `api`/`worker` không đổi.
- **Interface:** không đổi symbol exported. Hợp đồng tên check: thêm `image-scan`, `secret-scan`; sáu tên cũ giữ nguyên. `image.yml` vẫn một job `image-push`.
- **Dữ liệu, transaction:** không áp dụng.
- **Quyền và cô lập:** hai job mới chỉ `contents: read`, không `id-token`, `persist-credentials: false`, không `secrets.*`, không cache Actions. Container công cụ không có `docker.sock`, không biến môi trường của job (`ACTIONS_RUNTIME_TOKEN`, `ACTIONS_ID_TOKEN_REQUEST_*`, credential AWS không đi vào container), lượt quét không có mạng. Trong `image.yml` Trivy chạy trước khi có credential AWS.
- **Thời gian:** `image-scan` 15 phút (build lạnh `npm ci` + Nest build + kéo image + DB), `secret-scan` 10 phút. Số đo thật ghi ở §8.
- **Sơ đồ:**

```mermaid
flowchart LR
    PR[PR hoặc push main] --> CI[ci.yml]
    CI --> J6[sáu job cũ]
    CI --> IS[image-scan: build, save tar, Trivy không mạng]
    CI --> SS[secret-scan: kiểm tĩnh, ngoại lệ, gitleaks tới HEAD, so số commit]
    M[push main] --> IMG[image.yml image-push]
    IMG --> B[build và save tar] --> T[Trivy chặn]
    T -->|thoát 0| C[credential AWS, ECR login] --> P[push ECR] --> ECR[scan on push ECR, chỉ cảnh báo]
    T -->|thoát 1| X[job đỏ, không credential, không push, Deploy không chạy]
```

- **Thay đổi cấp hệ thống:** docs/03 §13.3 (Build: Trivy chặn trước push, gitleaks), CONTRIBUTING §4b (bảng check thêm hai dòng chạy ở gốc repo, quy tắc tên job, thời gian tối đa 15 phút cho `image-scan`), CONTRIBUTING §6 (ba file ngoại lệ, gia hạn), concept brief ci-cd, threat model T16 (Trạng thái, NFR-SEC-04), deliverables README hàng P3. Không đổi ADR.

## 4. Test cases tự động

Lớp "tĩnh": script Python, chạy local và trong `secret-scan`. Lớp "công cụ": chạy đúng phiên bản và tham số của workflow trên dữ liệu thử. Lớp "Actions": chỉ đạt khi có link run thật. Cột "Ở đâu": **L** chạy được trên máy này (binary đã tải), **CI** chỉ trên GitHub (cần `docker build`).

| ID | Truy vết | Lớp | Ở đâu | Given · When · Then | Mong đợi |
|---|---|---|---|---|---|
| TC-155-01 | DoD 1 | tĩnh | L, CI | `ci.yml` · `check-image-workflow.py` · hai job mới, tên không trùng sáu tên, `working-directory: .`, `timeout-minutes`, `contents: read`, không `id-token`, `persist-credentials: false`, image ghim `ghcr.io/…@sha256:` 64 hex | `OK` |
| TC-155-02 | DoD 1 | tĩnh | L, CI | Đủ cờ H1 (a)(b), `--network none`, `--skip-java-db-update`, `--ignorefile` ở (a) và (b); H2 `--log-opts="HEAD"`, `--no-color`, `--redact`, `--exit-code 1`, `fetch-depth: 0`, chặn nông và 90% | `OK` |
| TC-155-03 | DoD 1 | tĩnh | L, CI | `image.yml`: Trivy trước `configure-aws-credentials` và `docker push`; không `docker.sock` ở mọi workflow; vẫn một job, không `latest`, không `pull_request` | `OK` |
| TC-155-04 | DoD 1 | tĩnh, fixture âm | L, CI | Bỏ từng cờ ở TC-02, giữ cờ nhưng đổi giá trị `--log-opts="HEAD~3"` và `--log-opts="origin/main"`, chuỗi `--log-opts="HEAD"` đúng chỉ nằm trong comment còn lệnh thật sai, digest thành tag, Docker Hub thay GHCR, Trivy sau credential, thêm `docker.sock`, tên job `build`, bỏ `working-directory` | mỗi fixture `FAIL` |
| TC-155-05 | DoD 1 | tĩnh | CI (Actions) | `ci.yml` có bước chạy `check-image-workflow.py` trong `secret-scan`; log run có dòng `OK` | `OK` trong log |
| TC-155-06 | DoD 2 | unit Python | L, CI | `check-scan-exceptions.py` với mục đủ lý do và hạn trong 90 ngày (ba file) | thoát 0 |
| TC-155-07 | DoD 2 | unit Python | L, CI | Thiếu `.trivyignore.yaml`; thiếu `statement` (ở `vulnerabilities` và ở `secrets`); thiếu `expired_at`; hạn đã qua; hạn > hôm nay + 90; allowlist thiếu hạn; `paths` không neo; `^docs/.+$` không kèm `targetRules`/`regexes`/`condition = "AND"`; fingerprint không có dòng lý do | mỗi ca thoát 1, nêu tên mục |
| TC-155-08 | DoD 2, BL-111 | tĩnh | L, CI | `.gitleaks.toml` thật có đúng hai allowlist: (1) path literal đúng `server.key`, không `targetRules`; (2) `targetRules = ["generic-api-key"]`, `condition = "AND"`, `regexTarget = "match"`, một regex có UUID, path `manual-test*.txt` | `OK` |
| TC-155-09 | DoD 1, 3 | công cụ | L (`trivy fs` lockfile), CI (image) | Thêm dependency production có lỗ hổng HIGH đã có bản sửa · Trivy (a) | thoát 1, bảng nêu CVE |
| TC-155-10 | DoD 1, 3, NFR-SEC-04 | công cụ | L, CI | Commit chứa khóa sinh ngẫu nhiên ở `tmp/fake.key` · gitleaks H2 | thoát 1, giá trị `REDACTED` |
| TC-155-11 | DoD 1, 3, NFR-SEC-04 | công cụ | L, CI | Sau `git revert` commit đó | vẫn thoát 1 |
| TC-155-12 | DoD 1, NFR-SEC-04 | công cụ | L (gitleaks, `trivy fs`), CI (image) | Nhánh task sau sửa lockfile · gitleaks và Trivy (a)(b) | thoát 0; chạy đúng đoạn shell H2 (không đọc số bằng mắt): không nông, số quét ≥ 90% |
| TC-155-13 | DoD 2 | công cụ | L (`trivy fs`), CI | Ngoại lệ hợp lệ cho CVE ở TC-09 → thoát 0; `expired_at` về hôm qua → Trivy (a) thoát 1 và `check-scan-exceptions.py` thoát 1 | 0 rồi 1 |
| TC-155-14 | DoD 2 | công cụ | L, CI | Repo thử từ lịch sử thật với cấu hình H4: (a) bản sao `server.key` ở đường dẫn khác; (b) `secret = <hex64>` mới trong `manual-test.txt`; (c) `api_key = <uuid>` trong `.md` dưới screenshots; (d) `key=<uuid>` mới trong `manual-test.txt`; (e) `X-Api-Key: <uuid>`, (f) `"client-secret-key": "<uuid>"`, (g) `private.key=<uuid>` trong `manual-test.txt`; (h) `{"secret":{"key":"<uuid>"}}` (khóa lồng: `Match` chỉ có thể bắt đầu ở `key`, nên ca này **được bỏ qua**, đi theo "hệ quả còn lại" ở §1 câu 13, không phải lỗi mới: ghi nhận, không sửa); dùng UUID mà luật mặc định thấy được (bộ lọc entropy ẩn một số UUID) | (a)(b)(c)(e)(f)(g) thoát 1; (d) và (h) thoát 0; lịch sử thật còn 0 phát hiện |
| TC-155-15 | DoD 1 | công cụ | L (`trivy rootfs`), CI (image) | Thư mục/image có file khóa riêng · Trivy (b) | thoát 1 |
| TC-155-16 | DoD 1 | công cụ | L | Repo thử có nhánh khác chứa secret, `HEAD` sạch · gitleaks H2 | thoát 0 (chỉ quét tới `HEAD`) |
| TC-155-17 | DoD 1 | công cụ | L | Đoạn shell H2 trên repo thử: clone nông; repo chỉ có commit rỗng (0 commit quét); lịch sử thật thêm commit chỉ đổi mode và chỉ đổi tên; repo có merge | nông và 0 commit thoát 1; lịch sử thật thêm commit không nội dung vẫn thoát 0 |
| TC-155-18 | DoD 1, NFR-SEC-04 | Actions | CI | Draft PR của nhánh task: `image-scan`, `secret-scan` và sáu job cũ xanh | link run |
| TC-155-19 | DoD 2, 3 | Actions | CI | Draft PR thử `test/DBS-155-scan-proof`, mỗi commit chỉ đẩy khi run trước đã xong. Chuỗi 1: c1 dependency lỗi → `image-scan` đỏ; c2 ngoại lệ hợp lệ → `image-scan` xanh; c3 hạn về hôm qua → `image-scan` đỏ và `secret-scan` đỏ ở `check-scan-exceptions.py`. Reset nhánh thử về **commit đầu nhánh task đã có run xanh ở M-08** (SHA ghi ở M-09; không về `main`, vì `main` chưa có job `secret-scan` nên c4, c5 sẽ không có check nào để đỏ), hoặc mở PR thử thứ hai cắt từ commit đó. Chuỗi 2: c4 secret giả → `secret-scan` đỏ; c5 revert → `secret-scan` vẫn đỏ | link từng run |
| TC-155-20 | DoD 3 | tài liệu | L | `scan-results.md` có lệnh, phiên bản, số phát hiện theo mức, ngoại lệ; link từ hàng P3, ci-cd, T16; `check-doc-links.mjs` sạch | 0 link hỏng |
| TC-155-21 | DoD 1 (H5) | backend | L một phần, CI | Sau sửa lockfile: `npm audit --omit=dev` 0 high/critical; lint, typecheck, unit, build local; trên CI xanh đủ: `test/error-handling.e2e-spec.ts` (413, BL-023), `test/db/money-flow.db-spec.ts`, các suite `test:services` outbox và consumer; diff phiên bản resolve chỉ gồm gói dự định | xanh |
| TC-155-22 | DoD 4 | quy trình | — | PR merge vào `main` với CI xanh, Dev khác review, bảng đối chiếu điền đủ | quy trình |

## 5. Test thủ công

Công cụ local: binary chính thức Trivy 0.76.1 và gitleaks 8.30.1 ở scratchpad, gọi bằng đường dẫn tuyệt đối (§8 "Chọn phiên bản"). Không Docker nên không build image local. Nhánh thử `test/DBS-155-scan-proof` tạo cục bộ; chỉ coordinator đẩy lên GitHub, sau G3 và sau M-155-08.

| Bước | Việc làm | Ở đâu | Kết quả mong đợi |
|---|---|---|---|
| M-155-01 | `trivy fs --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 backend/package-lock.json` trên nhánh task (sau sửa lockfile) | L | thoát 0 (đường thành công, phần npm) |
| M-155-02 | Chạy nguyên đoạn shell H2 (binary thay `docker run`, cùng cờ) trên nhánh task | L | gitleaks thoát 0; `server.key` không bị báo; các dòng `test` thoát 0 |
| M-155-03 | Nhánh thử: thêm dependency production có HIGH đã sửa, `trivy fs` lockfile | L | thoát 1, CVE hiện trong bảng (bị từ chối) |
| M-155-04 | Nhánh thử: commit khóa sinh bằng `openssl genpkey` vào `tmp/fake.key`, gitleaks; `git revert`, gitleaks lại | L | cả hai lần thoát 1, `REDACTED` |
| M-155-05 | Ngoại lệ hợp lệ cho CVE M-03 → `trivy fs` thoát 0; `expired_at` về hôm qua → `trivy fs` thoát 1 và `check-scan-exceptions.py` thoát 1 nêu tên mục | L | 0 rồi 1 |
| M-155-06 | `trivy rootfs --scanners secret --exit-code 1` trên thư mục tạm có file khóa riêng | L | thoát 1 |
| M-155-07 | `check-image-workflow.py`, `check-scan-exceptions.py`, test fixture âm | L | `OK`, thoát 0 |
| M-155-08 | Draft PR của nhánh task | CI | tám check xanh; log `image-scan` có ba lượt Trivy, log `secret-scan` có `OK` kiểm tĩnh và số commit khớp; link run |
| M-155-09 | Draft PR thử `test/DBS-155-scan-proof` theo đúng thứ tự TC-19 (c1…c3, reset về SHA gốc, c4…c5), đẩy từng commit sau khi run trước xong; ghi SHA gốc của từng chuỗi (SHA commit đầu nhánh task đã xanh ở M-08) cùng link run | CI | c1 `image-scan` đỏ; c2 xanh; c3 `image-scan` đỏ và `secret-scan` đỏ; c4, c5 `secret-scan` đỏ; log không lộ giá trị; link từng run; đóng PR, xóa nhánh |
| M-155-10 | `image.yml` thật trên `main` | CI | **chưa chạy được** cho tới khi có `AWS_ROLE_ARN` (BL-034); thay bằng M-155-07 (thứ tự bước) và M-155-08 (cùng lệnh Trivy) |

## 6. Domain review (AI)

**Reviewer:** subagent, model claude-opus-5-5 (coordinator gửi, chỉ đọc), ngày 2026-11-11 · **Kết quả vòng 1:** 15 phát hiện (blocking 1, should-fix 9, minor 5), verdict REVISE · [trả lời nguyên văn](screenshots/DBS-155/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | `fetch-depth: 0` kéo mọi nhánh; gitleaks `git` mặc định quét `--all`, nhánh thử có secret làm mọi PR đỏ | **đã sửa** §1 câu 6, H2 (`--log-opts="HEAD"`), TC-02, TC-16; M-08 và M-09 chạy lần lượt. Đã kiểm: `rev-list --count HEAD` = 138, `--all` = 494 |
| 2 | should-fix | `ci.yml` mặc định `working-directory: backend`, lệnh H1/H2 giả định gốc repo | **đã sửa** H1, H2, H7, TC-01, TC-04; §3 thêm sửa bảng CONTRIBUTING §4b. Đã kiểm `ci.yml` dòng 27–29 |
| 3 | should-fix | Mount `docker.sock` cho Trivy quyền root trên runner, đọc được token OIDC/AWS/`ACTIONS_RUNTIME_TOKEN` | **đã sửa** H1, H3, §3: `docker save` + `--input`, không socket, quét `--network none`; `image.yml` quét trước `configure-aws-credentials`; TC-03, TC-04 cấm `docker.sock` |
| 4 | should-fix | Chỉ có allowlist theo path, hạn cứng 2026-12-14 làm CI đỏ không sửa được | **đã sửa** §1 câu 5, H4: thêm `.gitleaksignore` theo fingerprint có lý do và hạn; hạn cuộn ≤ 90 ngày; hạn qua là cố ý đỏ, #5 gia hạn bằng PR; chạy lại commit cũ đỏ là chấp nhận |
| 5 | should-fix | Không chống xanh giả khi gitleaks quét 0 commit | **đã sửa** H2 (so số commit, `pipefail`), TC-12, TC-17, M-02, M-08. Chạy binary thật cho thấy so với `rev-list --count HEAD` sẽ đỏ giả (137 ≠ 138, commit chỉ xóa file); cách chặn đã đổi hai lần: `--diff-filter=AM` (vòng 1, sai với commit chỉ đổi mode, xem vòng 2 #2), rồi chặn nông + ≥ 90% (H2 hiện hành) |
| 6 | should-fix | Kiểm tĩnh chỉ chạy trong `image.yml`/`deploy.yml` luôn `skipped` | **đã sửa** H7: chạy trong `secret-scan` mọi PR; TC-05 |
| 7 | should-fix | §5 không ghi bước nào chạy được, thiếu chứng minh revert và ngoại lệ hết hạn | **đã sửa** cột "Ở đâu" ở §4, §5; binary đã tải nên M-01…07 chạy local; M-09 thêm commit revert và commit ngoại lệ hết hạn; TC-19 |
| 8 | should-fix | Xóa BL-035 trong khi điều kiện đóng còn BL-012 | **đã sửa** §1 bảng BACKLOG: giữ, thu hẹp về phần ruleset |
| 9 | should-fix | `--severity HIGH,CRITICAL` lọc cả secret | **đã sửa** H1 lượt (b) riêng không lọc mức, §1 câu 4, TC-15, M-06 |
| 10 | should-fix | Kết quả không tất định (base theo tag, DB mới), không có quy trình | **đã sửa** H6, §1 câu 12; ghim digest base chuyển BACKLOG ở Phase 5 |
| 11 | minor | Nâng lockfile chạm đường tiền (`joi`, `body-parser`) | **đã sửa** H5, TC-21 nêu suite bắt buộc và diff phiên bản |
| 12 | minor | Docker Hub ẩn danh, chưa kiểm digest, DB không mirror | **đã sửa** §1 câu 2 (GHCR), H1 `--db-repository` hai nguồn; kiểm cosign image ở Phase 3; binary local đã chọn theo advisory (§8) |
| 13 | minor | Chưa truy vết NFR-SEC-04 | **đã sửa** §1 câu 1, TC-10, 11, 12, 18; T16 ở §3 |
| 14 | minor | `scratch/` không phải loại nhánh | **đã sửa** dùng `test/DBS-155-scan-proof`, xóa sau khi ghi link |
| 15 | minor | Job mới thiếu `timeout-minutes` | **đã sửa** H1 15 phút, H2 10 phút, §3, TC-01; CONTRIBUTING §4b cập nhật ở Phase 5 |

**Vòng 2** (cùng reviewer, cùng ngày): 9 phát hiện mới (blocking 0, should-fix 5, minor 4), verdict REVISE; reviewer xác nhận 11 phát hiện vòng 1 đã sửa đúng.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | Mã ANSI làm `sed` đọc số commit ra rỗng, bước đỏ mọi lần | **đã sửa** H2 `--no-color`, giải thích kèm bằng chứng; TC-12, M-02 chạy nguyên đoạn shell. Đã thấy ANSI trên repo thử (§8) |
| 2 | should-fix | Công thức `--diff-filter=AM` sai với commit chỉ đổi mode | **đã sửa** H2: bỏ so bằng, dùng chặn nông + ≥ 1 + ≥ 90% `rev-list --no-merges`; §1, câu 6; TC-17 thêm repo thử. Đo: repo thử 8/12 (mode, rename, rỗng, xóa không đếm), lịch sử thật 138/139 và 138/140 |
| 3 | should-fix | Allowlist hex 64 và cả cây screenshots quá rộng | **đã sửa** câu 13, H4: bỏ hex 64 (3 id container thành fingerprint), `regexTarget = "match"` cần tên khóa idempotency + UUID, path chỉ `DBS-<n>/manual-test*.txt`; TC-14 (b)(c) âm. Đã chạy: lịch sử thật 0 phát hiện, ca âm đỏ |
| 4 | should-fix | Checker chấp nhận path có ký tự đại diện | **đã sửa** H4: ký tự đại diện chỉ được khi allowlist có `targetRules` + `regexes` + `condition = "AND"`; TC-07 thêm `^docs/.+$`; TC-08 viết lại cho hai allowlist |
| 5 | should-fix | Chuỗi PR thử không chứng minh được, `cancel-in-progress` mất run | **đã sửa** TC-19, M-09, câu 8: hai chuỗi tách nhau, có commit ngoại lệ hợp lệ xanh ở giữa, đẩy từng commit sau khi run trước xong, cột mong đợi đúng từng job |
| 6 | minor | Chưa có cách kiểm nguồn gốc digest chạy được | **đã sửa** §8: so digest index qua API registry đọc ẩn danh, Trivy giống nhau ở GHCR, ECR Public, Docker Hub; gitleaks giống nhau ở GHCR và Docker Hub; không trùng digest IoC; release Trivy Immutable. Không tải cosign (chưa được cho phép) nên chữ ký vẫn chưa kiểm |
| 7 | minor | Java DB tải lười khi `--network none` | **đã sửa** H1 `--skip-java-db-update`; TC-02 |
| 8 | minor | Lượt (b) không có ignorefile; file thiếu thì `docker -v` tạo thư mục | **đã sửa** H1 `--ignorefile` ở cả (a)(b), `test -f`; H4 mục `secrets:`, file luôn có; checker đỏ khi thiếu file; TC-07 |
| 9 | minor | Ví dụ `.gitleaksignore` sai luật và file | **đã sửa** H4 dùng hai fingerprint thật từ report baseline; hạn lệch nhau (ghi chú phần dư của reviewer) |

**Vòng 3** (cùng reviewer): 4 phát hiện mới (blocking 0, should-fix 2, minor 2), verdict REVISE; reviewer xác nhận 9 phát hiện vòng 2 đã đóng.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | `\bkey` không neo đầu đoạn khớp: `X-Api-Key`, `client-secret-key`, `private.key` + UUID lọt allowlist | **đã sửa** H4: regex neo `^` với ba tên khóa; TC-14 thêm (e)(f)(g). Đã chạy gitleaks 8.30.1: lịch sử thật 0 phát hiện, ba ca âm đỏ, ba ca hợp lệ xanh; regex cũ cho ba ca lọt (§8). Hai điều rút ra khi chạy: `Match` không có dấu nháy mở nên cần `"?` ở đầu, và phải chọn UUID mà luật mặc định thấy được |
| 2 | should-fix | Reset chuỗi 2 về `main` làm mất `secret-scan` | **đã sửa** câu 8, TC-19, M-09: reset về SHA commit đầu nhánh task đã xanh ở M-08, ghi SHA gốc từng chuỗi |
| 3 | minor | Ngưỡng 90% không chặn khoảng commit sai | **đã sửa** H2, câu 6: nói rõ ngưỡng chỉ chống lỗi công cụ/clone, khoảng commit do H7 và TC-04 giữ; không thêm `merge-base` (lý do ghi ở H2) |
| 4 | minor | H1 còn `<digest>` | **đã sửa** H1 điền digest Trivy như §8, bỏ câu "chốt ở Phase 3" |

**Vòng 4** (cùng reviewer): **APPROVE**, 2 minor; reviewer xác nhận 4 phát hiện vòng 3 đã đóng.

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | minor | TC-04 thiếu fixture đổi giá trị `--log-opts` | **đã sửa** TC-04 thêm `HEAD~3`, `origin/main`, chuỗi đúng chỉ trong comment; H7 kiểm theo đối số tách bằng `shlex` |
| 2 | minor | Khóa lồng `{"secret":{"key":"<uuid>"}}` được bỏ qua | **không sửa, đã ghi** TC-14 (h): thuộc "hệ quả còn lại" §1 câu 13; sửa sẽ buộc nới regex |

**Quyết định ở G2** (agent tự quyết, 2026-11-12): verdict APPROVE, không còn phát hiện blocking hay should-fix chưa xử lý; qua G2 (tin nhắn G2 ở cuối phiên Phase 2).

## 7. Kế hoạch triển khai

Thứ tự: dependency → script kiểm ngoại lệ → file ngoại lệ → kiểm tĩnh workflow → workflow → tài liệu. Test viết trước, chạy đỏ, rồi mới viết mã. "Kết quả đỏ" điền khi chạy (Phase 4). `GL` = binary gitleaks 8.30.1 ở scratchpad, gọi bằng đường dẫn tuyệt đối.

| Bước | File | Test viết trước | Kết quả đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `backend/package-lock.json` | TC-09, TC-21: `npm audit --omit=dev` (4 high), đối chiếu diff phiên bản | điền khi chạy | `cd backend && npm audit --omit=dev; npm run lint:check && npm run typecheck && npm test && npm run build`; `npm run test:e2e -- test/error-handling.e2e-spec.ts` | `fix(deps): bump body-parser, multer and joi to patched versions` |
| 2 | `.github/scripts/tests/test_check_scan_exceptions.py`, rồi `.github/scripts/check-scan-exceptions.py` | TC-06, TC-07 (ba file, mỗi ca đỏ nêu tên mục, `^docs/.+$`, hạn 90 ngày, thiếu `.trivyignore.yaml`) | điền khi chạy | `python3 .github/scripts/tests/test_check_scan_exceptions.py` | `feat(ci): validate scan exception files for reason and review date` |
| 3 | `.trivyignore.yaml` (`vulnerabilities: []`, `secrets: []`), `.gitleaks.toml`, `.gitleaksignore` (8 fingerprint), `.github/scripts/tests/test_gitleaks_config.py` (chạy gitleaks khi có `GITLEAKS_BIN`, bỏ qua có thông báo khi không có) | TC-08, 10, 11, 14, 16, 17 trên repo thử; lịch sử thật 0 phát hiện | gitleaks mặc định: 122 phát hiện | `GITLEAKS_BIN=$GL python3 .github/scripts/tests/test_gitleaks_config.py`; `check-scan-exceptions.py` thoát 0 | `feat(ci): add gitleaks and trivy exception files with reasons and review dates` |
| 4 | `.github/scripts/check-image-workflow.py` (H7), `.github/scripts/tests/test_check_image_workflow.py` (fixture âm) | TC-01…04: fixture đỏ trước khi có job; thêm job vào fixture để xanh | điền khi chạy | `python3 .github/scripts/tests/test_check_image_workflow.py` | `test(ci): static checks for scan jobs, flags and step order` |
| 5 | `.github/workflows/ci.yml` (`image-scan`, `secret-scan`) | TC-01, 02, 05 (bước 4 phải xanh trên file thật) | `check-image-workflow.py` đỏ vì chưa có job | `python3 .github/scripts/check-image-workflow.py`; YAML parse; chạy local đoạn shell H2 bằng `GL` (TC-12, 17) | `feat(ci): add image-scan and secret-scan jobs` |
| 6 | `.github/workflows/image.yml` | TC-03 | `check-image-workflow.py` đỏ vì Trivy chưa trước credential | `python3 .github/scripts/check-image-workflow.py` | `feat(ci): block image push on trivy findings before aws credentials` |
| 7 | `docs/components/ci-cd/scan-results.md`, `docs/components/ci-cd/01-concept-brief.md`, `docs/03_HIGH_LEVEL_ARCHITECTURE.md` §13.3, `CONTRIBUTING.md` §4b và §6, `docs/security/threat-model.md` T16, `docs/deliverables/README.md` hàng P3, `docs/BACKLOG.md`, `docs/features/README.md`, feature doc §8, §9 | TC-20 (`check-doc-links.mjs`) | điền khi chạy | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `docs(ci): document scan gates and results for DBS-155` |
| 8 | Nhánh thử cục bộ `test/DBS-155-scan-proof` (c1…c5 theo TC-19), **chỉ tạo, không đẩy** | M-155-09 | không áp dụng | log của nhánh | không commit vào nhánh task |

Phụ thuộc giữa bước: bước 5 cần 3 và 4; bước 6 cần 4; bước 7 cần kết quả của 1 đến 6. Bước cần Trivy thật (TC-09 lượt image, TC-13, TC-15, M-155-01, 03, 05, 06) **chưa kiểm**: chưa được tải Trivy và DB, xin phép riêng. Phần chỉ chứng minh được trên GitHub (TC-05, 18, 19, M-155-08, 09, 10) chờ người dùng duyệt Draft PR.

**Rủi ro và cách lùi:**
- Hai job mới đỏ ngay lúc merge vì phát hiện sẵn có: giảm bằng bước 1 (lockfile) và bước 3 (ngoại lệ có lý do). Image Alpine và `npm` đi kèm chưa quét được local; nếu Trivy ở CI thấy HIGH có bản sửa trong image, xử lý theo §1 câu 7 (ưu tiên sửa Dockerfile, cuối cùng ngoại lệ có hạn) trong cùng PR trước khi merge.
- `image.yml` luôn `skipped` (BL-034) nên thay đổi ở đây chỉ kiểm tĩnh được: lùi bằng revert bước 6.
- Hai check mới chưa là required (BL-012, BL-035): không chặn merge cho tới khi chủ repo thêm vào ruleset; lùi = bỏ khỏi ruleset hoặc revert bước 5.
- Cập nhật lockfile đổi `joi` và `body-parser` trên đường tiền: lùi bằng revert bước 1; suite ở TC-21 là chốt.
- Tải DB Trivy lỗi giữa chừng làm mọi PR đỏ (fail-closed, H1): chấp nhận, quy trình ở H6.

**Quét kế hoạch (plan sweep):** đã đối chiếu từng điều sau với một dòng kế hoạch hoặc một dòng ngoài phạm vi: DoD 1 (bước 4 đến 6), DoD 2 (bước 2, 3), DoD 3 (bước 3, 7, 8; phần GitHub chờ duyệt), DoD 4 (quy trình, TC-22); BL-035 (bước 5, 6, 7: giữ dòng, thu hẹp), BL-111 (bước 3, xóa dòng ở bước 7), BL-013 (xóa dòng ở bước 7), BL-106 (bước 7 thêm nguồn); docs/03 §13.3, CONTRIBUTING §4b và §6, T16, hàng P3, ci-cd (bước 7); `check-image-workflow.py` hiện chỉ chạy trong `image.yml` (bước 4, 5); NFR-SEC-04 (TC-10, 11, 12). Không có mục chưa phủ.

**Quyết định ở G3** (agent tự quyết, 2026-11-12): kế hoạch đủ file, test trước, lệnh chứng minh và commit; không dùng `act` (không có trên máy, không tải); nhánh proof chỉ chuẩn bị cục bộ, đẩy cần người dùng duyệt.

## 8. Kết quả

- **Chọn phiên bản** (2026-11-11, trước khi tải):
  - Trivy: advisory [GHSA-69fq-xp46-6x23](https://github.com/aquasecurity/trivy/security/advisories/GHSA-69fq-xp46-6x23) (CVE-2026-33634, Critical, 2026-03-21): binary v0.69.4; image `0.69.4`, `latest` (GHCR, ECR Public, Docker Hub) và `0.69.5`, `0.69.6` (chỉ Docker Hub); `trivy-action` tag `0.0.1`–`0.34.2`; `setup-trivy` `v0.2.0`–`v0.2.6` bị chiếm quyền trong các cửa sổ 2026-03-19…23. Image tham chiếu theo digest không bị ảnh hưởng. Advisory [GHSA-mcj4-mphf-j9ff](https://github.com/aquasecurity/trivy/security/advisories/GHSA-mcj4-mphf-j9ff) (High, path traversal qua DB tải về) vá ở 0.71.1. Chọn **v0.76.1** (2026-10-21, release Immutable, sau mọi advisory). Không lấy v0.76.2 (2026-11-05, mới 6 ngày) để có thời gian ổn định.
  - gitleaks: trang advisory của `gitleaks/gitleaks` không có advisory nào. Chọn **v8.30.1** (2026-03-21, Latest). Release không có dấu Immutable.
- **Tải** (người dùng cho phép, vào `scratchpad/tools/<công cụ>-<ver>/`, gọi bằng đường dẫn tuyệt đối, không cài hệ thống):

| File | URL | Kích thước (byte) | sha256 | Kiểm |
|---|---|---|---|---|
| `trivy_0.76.1_Linux-64bit.tar.gz` | `https://github.com/aquasecurity/trivy/releases/download/v0.76.1/trivy_0.76.1_Linux-64bit.tar.gz` | 52676794 | `c7cbe3137fb8a48a17574bede3dd6beb16742d1e9772929940fc90082c39d9c0` | `sha256sum -c` với `trivy_0.76.1_checksums.txt`: OK; không trùng hash IoC của advisory |
| `trivy_0.76.1_checksums.txt` | cùng thư mục release | 2121 | — | — |
| `trivy_0.76.1_Linux-64bit.tar.gz.sigstore.json` | cùng thư mục release | 10383 | — | **chưa kiểm chữ ký**: máy không có cosign |
| `gitleaks_8.30.1_linux_x64.tar.gz` | `https://github.com/gitleaks/gitleaks/releases/download/v8.30.1/gitleaks_8.30.1_linux_x64.tar.gz` | 8230402 | `551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb` | `sha256sum -c` với `gitleaks_8.30.1_checksums.txt`: OK; release không có file chữ ký |
| `gitleaks_8.30.1_checksums.txt` | cùng thư mục release | 999 | — | — |

  Binary sau giải nén: `trivy` sha256 `d1dfca6a…3d83`, `--version` = 0.76.1; `gitleaks` sha256 `88f91962…5509`, `version` = 8.30.1. DB Trivy tải từ `mirror.gcr.io/aquasec/trivy-db:2` (nguồn mặc định đầu tiên của 0.76.1, cùng giá trị ghi ở H1), cache 1,7 GB ở `scratchpad/trivy-cache`, giữ đến hết task.
- **Nguồn gốc digest image** (thay chữ ký cosign; HEAD manifest với token ẩn danh, chỉ đọc, 2026-11-11):

| Image | GHCR | ECR Public | Docker Hub |
|---|---|---|---|
| Trivy `0.76.1` | `sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c` | trùng | trùng (`aquasec/trivy`) |
| gitleaks `v8.30.1` | `sha256:c00b6bd0aeb3071cbcb79009cb16a60dd9e0a7c60e2be9ab65d25e6bc8abbb7f` | không phát hành | trùng (`zricethezav/gitleaks`) |

  Cả hai là OCI image index (đa kiến trúc). Không trùng digest IoC trong GHSA-69fq-xp46-6x23. Release Trivy v0.76.1 ghi Immutable, commit release ký GPG đã xác minh trên GitHub, release note không ghi digest. Giới hạn: ba registry cùng do một bên đẩy, nên trùng digest chỉ chứng minh nhất quán, không chứng minh chữ ký; chữ ký cosign chưa kiểm vì không có cosign và chưa được cho tải.
- **Chạy thử đoạn shell H2 và cấu hình H4** (repo thử trong scratchpad, gitleaks 8.30.1):

| Repo | gitleaks | Số quét / không merge | Kết quả chặn |
|---|---|---|---|
| Đủ dạng commit (c1, c2, nhánh, merge, đổi tên, đổi mode, rỗng, xóa file, binary, xóa dòng) | 0 | 8 / 12 | đỏ (90% = 11): đúng giới hạn đã ghi ở H2 |
| Không `--no-color` | — | dòng `INF^[[0m ^[[1m8 commits scanned.^[[0m` | `sed` rỗng |
| Clone nông | 0 | 1 / 1 | đỏ (nông) |
| Nhánh khác có khóa, `HEAD` sạch | 0 | 2 / 2 | xanh |
| Khóa giả, rồi revert | 1, 1 | 2 / 2, 2 / 3 | gitleaks đỏ cả hai lần, `REDACTED` |
| Lịch sử thật (clone) | 1 (chưa cấu hình) | 138 / 139 | xanh |
| Lịch sử thật + commit chỉ đổi tên | 1 (chưa cấu hình) | 138 / 140 | xanh |
| Chỉ commit rỗng | 0 | 0 / 1 | đỏ |
| Lịch sử thật, cấu hình H4 (hai allowlist + 8 fingerprint) | **0 phát hiện** | 138 | — |
| + `key=<uuid>` mới trong `manual-test.txt` | 0 | — | xanh (đúng) |
| + `secret = <hex64>` trong cùng file | 1 | — | đỏ |
| + `api_key = <uuid>` trong `.md` dưới screenshots | 1 | — | đỏ |
| Vòng 3, regex neo đầu: lịch sử thật | **0 phát hiện** (rc 0) | — | — |
| + `key=<uuid>`, `{"idempotencyKey":"<uuid>"}`, `{"key":"<uuid>"}` trong `manual-test.txt` | 0, 0, 0 | — | xanh (đúng) |
| + `X-Api-Key: <uuid>`, `{"client-secret-key": "<uuid>"}`, `private.key=<uuid>`, `api_key=<uuid>` trong `manual-test.txt` | 1 mỗi ca | — | đỏ (đúng) |
| Đối chứng: regex cũ không neo (`\bkey`), cùng UUID | `X-Api-Key`, `client-secret-key`, `private.key`: 0; `api_key`: 1 | — | ba ca đầu lọt: xác nhận phát hiện vòng 3 #1 |

  Lưu ý về cách thử: gitleaks có bộ lọc entropy nên một số UUID không bị luật mặc định thấy; script chọn UUID mà luật mặc định bắt được ở cả năm dạng dòng trước khi thử (lần chạy đầu dùng UUID bị ẩn nên cho 0 phát hiện ở mọi ca, kết quả đó bị loại). gitleaks 8.30.1 tải lại sau khi scratchpad bị dọn (sha256 tar.gz `551f6fc8…70eb`, `sha256sum -c` OK, binary `88f91962…5509`, trùng bản trước).
| + bản sao `server.key` ở `backend/test/support/` | 1 `private-key` | — | đỏ |
- **Quét local trên nhánh task, trước khi sửa gì** (chỉ đọc, kết quả và giải thích ở §1 "Phát hiện ban đầu"): gitleaks 122 phát hiện (1 `private-key`, 121 `generic-api-key`), 137 commit; Trivy `fs` lockfile HIGH 3 có bản sửa, MEDIUM 4, CRITICAL 0, không có lỗi chưa sửa; Trivy secret `fs` 0.
- **Chứng minh ở đâu:** local chạy được TC-01…17 trừ phần "image" của TC-09, 12, 15 (dùng `trivy fs`/`rootfs` thay); chỉ CI: Trivy trên image thật (gói Alpine, `npm` đi kèm, secret trong lớp image), TC-05, TC-18, TC-19, phần e2e/db của TC-21.

- **Lệch so với kế hoạch / gate phụ (ghi trước khi làm):**
  1. *Thêm dependency công cụ CI* (Trivy, gitleaks). Phương án: (a) action marketplace ghim SHA; (b) image Docker chính thức trên GHCR ghim digest; (c) tải binary kèm checksum trong job. Chọn (b): ít mã bên thứ ba nhất chạy trong job, không cần license, ghim bất biến, cô lập được (không socket, không mạng khi quét). Local dùng binary chính thức cùng phiên bản (người dùng cho phép tải). Hệ quả: cập nhật digest thủ công khi nâng phiên bản (giống quy tắc SHA ở CONTRIBUTING §4b); job tốn thêm thời gian kéo image và DB.
  2. *Đổi dependency backend* (`package-lock.json`, 4 high có bản sửa trong dải). Phương án: sửa ngay; ngoại lệ có hạn; tách task. Chọn sửa ngay trong dải semver: DoD #1 không cho bỏ qua lỗi đã có bản sửa nếu không có lý do, và cổng không được đỏ khi merge. Hệ quả: PR chạm `backend/`; CI sáu job và các suite ở TC-21 là bằng chứng không vỡ; không đổi `package.json` trừ khi dải không đủ.

- **Lệnh kiểm tra** (chạy lúc bàn giao Phase 4, commit mã cuối `8bf5438`; binary gitleaks 8.30.1 ở scratchpad):

| Lệnh | Kết quả |
|---|---|
| `python3 .github/scripts/check-image-workflow.py` | `OK` |
| `python3 .github/scripts/check-scan-exceptions.py` | `OK` |
| `python3 .github/scripts/tests/test_check_scan_exceptions.py` | 28/28 đạt |
| `python3 .github/scripts/tests/test_check_image_workflow.py` | 37/37 đạt (1 cây thật `OK`, 36 fixture âm `FAIL`) |
| `python3 .github/scripts/tests/test_run_trivy.py` (`docker` giả) | 11/11 đạt |
| `GITLEAKS_BIN=… python3 .github/scripts/tests/test_gitleaks_config.py` | 16/16 đạt (không có `GITLEAKS_BIN` thì bị bỏ qua có thông báo) |
| `test_deploy.py`, `test_migrate.py`, `test_render_task_definition.py` (không đổi) | đạt |
| `cd backend && npm audit --omit=dev` | trước: 10 (4 high); sau: 5 moderate, 0 high, 0 critical |
| `npm run lint:check`, `npm run typecheck`, `npm run build` | thoát 0 |
| `npm test -- --maxWorkers=3` | 110/110 suite, 1870/1870 test đạt (khớp baseline) |
| `npm run test:e2e -- --maxWorkers=3` | 14/17 suite, 149/149 test đạt; 3 suite đỏ vì không có PostgreSQL (`ECONNREFUSED`): giống hệt baseline, không do lockfile |
| `npm run test:e2e -- test/error-handling.e2e-spec.ts` (413, BL-023) | 16/16 đạt |
| `test:db`, `test:services` (money-flow, outbox, consumer) | **chưa chạy**: cần Docker; trên CI |
| `check-doc-links.mjs` | 0 link hỏng |

  Không có `.skip`/`.only` trong test mới; `test_gitleaks_config.py` chỉ bỏ qua khi thiếu `GITLEAKS_BIN`. Diff phiên bản resolve của lockfile: `@nestjs/platform-express` 11.2.7 → 11.2.9, `multer` 2.4.0 → 2.5.0, `body-parser` 2.3.0 → 2.4.0, `joi` 18.2.9 → 18.3.2, `qs` 6.16.0 → 6.17.1; `package.json` không đổi.

- **Đối chiếu test case:**

| ID | Test | Đạt? |
|---|---|---|
| TC-155-01…03 | `test_check_image_workflow.py` › `test_real_tree_passes` và `check-image-workflow.py` trên cây thật | đạt |
| TC-155-04 | `test_check_image_workflow.py` (36 fixture âm: bỏ cờ, đổi `--log-opts` thành `HEAD~3`/`origin/main`, chuỗi đúng chỉ trong comment, tag thay digest, Docker Hub, `docker.sock`, sai thứ tự bước…) | đạt |
| TC-155-05 | log run Actions có `OK` | chưa làm (cần GitHub) |
| TC-155-06, 07 | `test_check_scan_exceptions.py` (28 ca) | đạt |
| TC-155-08 | `test_gitleaks_config.py` › `test_config_has_two_allowlists`; `test_real_history_is_clean` | đạt |
| TC-155-09 | `trivy fs` lockfile trước khi nâng: HIGH 3 có bản sửa, thoát 1 (đo trước, scratchpad đã dọn); lượt image | đơn giản hóa (chỉ lockfile, đã đo; Trivy hiện không có trên máy); lượt image chưa làm |
| TC-155-10, 11 | `test_gitleaks_config.py` › `test_fake_secret_is_red_and_revert_stays_red`; M-155-04 | đạt |
| TC-155-12 | `test_real_history_is_clean`, `test_history_with_mode_only…`, `test_merge_commit…`; `npm audit` 0 high | đạt phần gitleaks và audit; lượt Trivy chưa làm |
| TC-155-13 | `check-scan-exceptions.py` ca hết hạn (M-155-05); lượt Trivy | đơn giản hóa (phần checker; Trivy chưa chạy) |
| TC-155-14 | `test_gitleaks_config.py` (a)(b)(c)(d)(e)(f)(g)(h) | đạt |
| TC-155-15 | `trivy rootfs --scanners secret` | chưa làm (cần Trivy) |
| TC-155-16, 17 | `test_secret_on_other_branch…`, `test_shallow_clone_is_red`, `test_empty_commit_only_is_red`, hai ca mode/rename/merge | đạt |
| TC-155-18 | [run 43227579236](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/43227579236): `image-scan`, `secret-scan` và sáu job cũ xanh | đạt |
| TC-155-19 | Draft PR thử `test/DBS-155-scan-proof-1`, `-2` (#148, #150, đã đóng) | đạt (bảng dưới) |
| TC-155-20 | `check-doc-links.mjs`; `scan-results.md` | đạt |
| TC-155-21 | audit 0 high, lint/typecheck/unit/build/e2e như bảng trên | đơn giản hóa (e2e/db/services đầy đủ chưa chạy: thiếu Docker) |
| TC-155-22 | quy trình | chưa làm |
| TC-155-23 | `backend/test/support/dockerfile.spec.ts` › TC-155-23 (2 ca) | đạt (thêm sau lần chạy CI đầu) |

- **Test thủ công:** output thô ở [manual-test.txt](screenshots/DBS-155/manual-test.txt) (dòng đầu là SHA `8bf5438`, đã bỏ giờ khỏi log gitleaks; không có token, khóa giả bị che `REDACTED`).

| Bước | Kết quả |
|---|---|
| M-155-02 | **đạt**: `run-gitleaks.sh` trên nhánh task, thoát 0, 148 commit quét, ngưỡng 135, `server.key` không bị báo. Đối chứng ở commit `d901ab3` với luật mặc định: 122 phát hiện, thoát 1 |
| M-155-04 | **đạt**: khóa giả bị báo (`private-key`, `Secret: REDACTED`), thoát 1; sau `git revert` vẫn thoát 1 |
| M-155-05 | **đạt một phần**: checker `OK` với `expired_at` hợp lệ, `FAIL` nêu tên mục khi về hôm qua; lượt Trivy **chưa chạy** |
| M-155-07 | **đạt**: kiểm tĩnh và bốn bộ test như bảng trên |
| M-155-01, 03, 06 | **chưa chạy**: cần Trivy và DB Trivy (chưa được tải) |
| M-155-08 | **đạt** sau một lần sửa: run đầu 43131596232 `image-scan` đỏ (6 HIGH trong npm của image base, xem trên), sửa Dockerfile, [run 43227579236](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/43227579236) tám check xanh; log `image-scan` có ba lượt Trivy, `secret-scan` có `OK` kiểm tĩnh |
| M-155-09 | **đạt**: bảng TC-19 ngay dưới, đúng kỳ vọng ở cả năm commit |
| M-155-10 | **chưa chạy**: `image.yml` thiếu `AWS_ROLE_ARN` (BL-034) |

- **Phạm vi so với §7:** thêm so với kế hoạch: `.github/scripts/run-trivy.sh`, `.github/scripts/run-gitleaks.sh`, `.github/scripts/tests/test_run_trivy.py` (xem lệch 1); `image.yml` đổi cách cài PyYAML (lệch 3); `docs/features/DBS-67-…md` một dòng ghi BL-111 đã xử lý.
- **Lệch so với kế hoạch** (agent tự duyệt, ghi trước khi bàn giao Phase 5; mục 1, 2 đã thực hiện trong Phase 4, nêu lý do và hệ quả):
  1. *Lệnh quét nằm trong script, không inline trong workflow* (H1, H2 viết inline). Phương án: giữ inline; tách `run-trivy.sh`, `run-gitleaks.sh`. Chọn tách: một nguồn duy nhất cho `ci.yml` và `image.yml`, kiểm tĩnh bằng `shlex` trên script, chạy được local và test với `docker` giả hoặc binary gitleaks. Hệ quả: H7 kiểm script thay vì `run:`; `GITLEAKS_RUN` truyền lệnh `docker run … --user $(id -u):$(id -g)` (tránh lỗi git "dubious ownership" khi container đọc repo của runner, chưa kiểm vì không có Docker). `run-trivy.sh` và test của nó được viết sau script (không test-first); test mô phỏng bằng `docker` giả nên chỉ chứng minh luồng và cờ, không chứng minh Trivy phát hiện gì.
  2. *`check-image-workflow.py` đọc thư mục gốc từ `CHECK_IMAGE_WORKFLOW_ROOT`* để test được bằng fixture. Mặc định không đổi.
  3. *Cài PyYAML bằng venv* (`python3 -m venv` + `pip install pyyaml==6.0.2`) ở `secret-scan` và `image.yml`, thay `pip install` thẳng: runner ubuntu-24.04 dùng Python hệ thống có thể chặn `pip install` (PEP 668); bước cũ trong `image.yml` chưa từng chạy (job luôn `skipped`). Chưa kiểm trên runner.
  4. *Lượt (b) Trivy dùng `--ignorefile` và gate không dùng `--severity`* như đã duyệt ở G2; không lệch.
  5. *Quét `.gitleaks.toml`/`.gitleaksignore` tự động:* phát hiện khi chạy: gitleaks tự đọc `.gitleaksignore` ở thư mục hiện tại và `.gitleaks.toml` ở thư mục quét; `run-gitleaks.sh` luôn truyền tường minh nên CI không bị ảnh hưởng; ghi ở §1 để người sau đo baseline đúng.
- **Kết quả thật của lần chạy CI đầu** ([PR #147](https://github.com/Lawliet119/digital-banking-simulator/pull/147), run 43131596232): `secret-scan` đạt (18 giây, quét cả lịch sử), sáu job cũ đạt, **`image-scan` đỏ** với 6 phát hiện HIGH có bản sửa, 0 CRITICAL, 0 secret, 0 lỗ hổng gói Alpine, 0 lỗ hổng gói ứng dụng (`app/node_modules`). Cả 6 nằm ở npm đi kèm image `node:24-alpine`, không phải dependency của app:

| Gói | Đường dẫn trong layer | Số CVE | Bản sửa |
|---|---|---|---|
| `brace-expansion` | `usr/local/lib/node_modules/npm/node_modules/brace-expansion/package.json` | 2 (CVE-2026-102276, CVE-2026-102278) | 5.0.11, 3.0.8, 2.1.6, 1.1.20 |
| `undici` | `usr/local/lib/node_modules/npm/node_modules/undici/package.json` | 4 (CVE-2026-109383, 109869, 19534, 87018) | 6.29.1, 7.30.1, 8.12.2 |

  Đây là đúng kịch bản §1 câu 7 và H6 (phát hiện trong image mà `npm audit` không thấy). Cổng hoạt động đúng: bắt được lỗ hổng thật ở lần chạy đầu. Xử lý (gate phụ, đổi Dockerfile, agent tự quyết): **loại bỏ khỏi runtime image thứ không cần** thay vì ngoại lệ: stage `runtime` xóa `/usr/local/lib/node_modules/npm`, `/usr/local/lib/node_modules/corepack` và các liên kết `npm`, `npx`, `corepack`, vì runtime chỉ chạy `node` (`CMD ["node","dist/main.js"]` và task migration `node ./node_modules/typeorm/cli.js`, đã kiểm trong `ecs.tf`). Các stage build giữ npm. Không có ngoại lệ trong `.trivyignore.yaml`. Test mới TC-155-23 (`backend/test/support/dockerfile.spec.ts`, 7/7 đạt: đỏ trước khi sửa Dockerfile). Hệ quả: image không còn `npm` để vào chạy lệnh trong container (debug bằng `node`); nếu sau này cần npm ở runtime thì phải xử lý lỗ hổng của nó. Kết quả sau sửa: [run 43227579236](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/43227579236) trên commit `0c4081b` (đẩy sau `ee00459`): cả tám check đạt: `image-scan` 1m49s, `secret-scan` 18s, `build` 41s, `lint` 58s, `typecheck` 42s, `unit` 1m24s, `db` 6m30s, `e2e` 9m17s.
- **Bằng chứng TC-155-19 / M-155-09** (chạy 2026-11-12):

| Chuỗi | Commit | Thay đổi | Run | `image-scan` | `secret-scan` |
|---|---|---|---|---|---|
| 1 (PR #148) | c1 `a173834` | lockfile cũ (3 HIGH có bản sửa: `body-parser`, `joi`, `multer`) | [43229246454](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/43229246454) | **đỏ**: 3 HIGH (CVE-2026-111181, 113872, 118772) | xanh |
| 1 | c2 `79cad8f` | `.trivyignore.yaml` có ngoại lệ hợp lệ cho ba CVE (hạn 2027-01-20) | [43230960266](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/43230960266) | **xanh** | xanh |
| 1 | c3 `967302e` | cùng ngoại lệ, `expired_at` = 2026-11-11 (hôm qua) | [43231235322](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/43231235322) | **đỏ** | **đỏ** (kiểm tra ngoại lệ hết hạn; log chưa đọc từng dòng) |
| 2 (PR #150) | c4 `9e8b5a2` | khóa riêng ed25519 giả sinh bằng `openssl`, ghi rõ FAKE, ở `tmp/FAKE-DBS-155-proof.key` | [43231705451](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/43231705451) | xanh (file không vào image) | **đỏ** |
| 2 | c5 `76f5fff` | `git revert` c4 | [43232073324](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/43232073324) | xanh | **đỏ**: vẫn thấy khóa ở commit c4 trong lịch sử |

Cả hai chuỗi cắt từ `0c4081b` (commit xanh của nhánh task, run 43227579236), base của hai PR thử là nhánh task, không phải `main`; mỗi commit chỉ đẩy sau khi hai job quét của run trước đã xong. Log `secret-scan` ở c5: `Secret: REDACTED`, `RuleID: private-key`, `File: tmp/FAKE-DBS-155-proof.key`, `Commit: 9e8b5a2…`, 154 commit đã quét; thân khóa không xuất hiện trong log. Hai PR đã đóng, hai nhánh thử đã xóa trên origin, không merge.

- **Đã chứng minh trên CI nhờ các run trên:** Trivy chạy trên image thật (và bắt được npm của image base), `docker run --user` với gitleaks, venv/pip, kéo `ghcr.io` ẩn danh, thông tin ngoại lệ hết hạn làm cả hai job đỏ.
- **Chưa chứng minh:** `image.yml` thật (thiếu `AWS_ROLE_ARN`, BL-034); Trivy chạy local (chưa được tải); mermaid §3 chưa render; chữ ký cosign (BL-245); `test:db`/`test:services` đạt trên CI (run 43227579236) nhưng không chạy local. Lưu ý: `.trivyignore.yaml` ở nhánh task vẫn rỗng; ngoại lệ ở c2 chỉ có trên nhánh thử đã xóa.
- **Bàn giao cho vai khác:** chủ repo thêm `image-scan`, `secret-scan` vào ruleset (BL-035, BL-012); cosign (BL-245); ghim digest base image (BL-244). Dòng BACKLOG: BL-244, BL-245 thêm mới (BL-246 đã thêm rồi xóa vì DoD 3 đã chứng minh trên GitHub); BL-035 thu hẹp; BL-106 thêm nguồn; BL-111, BL-013 đã xóa.

## 9. Tài liệu đã cập nhật

`CONTRIBUTING.md` §4b (hai dòng bảng check, đoạn về `image-scan`/`secret-scan`) và §6 (cổng quét, ngoại lệ); `docs/03_HIGH_LEVEL_ARCHITECTURE.md` §13.3 (bước Build); `docs/components/ci-cd/01-concept-brief.md`; `docs/components/ci-cd/scan-results.md` (mới); `docs/security/threat-model.md` T16 (Trạng thái, NFR-SEC-04); `docs/deliverables/README.md` (hàng P3); `docs/features/README.md` (hàng DBS-155); `docs/features/DBS-67-rds-tls-secrets.md` (BL-111 đã xử lý). `docs/BACKLOG.md`: **xóa** BL-111 và BL-013; **thu hẹp** BL-035; **thêm nguồn** vào BL-106; **thêm** BL-244, BL-245.
