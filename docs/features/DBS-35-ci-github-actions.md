# DBS-35 · GitHub Actions CI: lint → typecheck → unit → build trên mỗi PR

> **Status:** Implemented · **Vai:** Dev · **Nhánh:** `infra/DBS-35-ci-github-actions` · **PR:** — · **Cập nhật:** 2026-10-19

## 1. Bối cảnh

- **Task trên board:** Task, Tuần 1, ưu tiên Highest, Deliverable/Demo **P3**, Status "In Progress" (đã đặt sẵn). Role trên board `Dev`, khớp với việc ("code nền: CI test", ghi chú 12/10 chuyển từ #5 sang #6). Job deploy, quét image và quét secret vẫn là của #5 ([platform.md](../../.claude/skills/dbs-delivering-task/references/platform.md)).
- **Expect:** "Mọi PR được kiểm tự động, kết quả xanh/đỏ nhìn thấy ngay trên PR."
- **DoD** (chép nguyên văn):
  1. .github/workflows/ci.yml chạy khi mở/cập nhật PR và khi push main: lint:check → typecheck → test → build
  2. Cache npm; tổng thời gian ≤ 10 phút
  3. Tên job ổn định để đưa vào required status checks (DBS-37)
  4. PR thử cố tình làm hỏng lint hoặc test → CI đỏ; sửa lại → xanh; README/CONTRIBUTING ghi cách đọc log CI
  5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Thực trạng (board):** ".github/workflows rỗng; .github chỉ có pull_request_template.md. Cục bộ đã có các lệnh lint:check, typecheck, test, test:e2e, build." Đã kiểm: đúng. [`.github/workflows/`](../../.github/workflows/) chỉ có `.gitkeep` (0 byte); [`.github/`](../../.github/) có `pull_request_template.md` (ô "CI xanh" trong mục Kiểm tra).
- **Phụ thuộc:** DBS-12 (baseline trên máy sạch) Done trên board; baseline chạy lại ở dưới cho thấy các lệnh đó chạy được. Task xuôi dòng: DBS-37 (required status checks) dùng tên job của task này.
- **Đã có gì:**
  - Lệnh trong [`backend/package.json`](../../backend/package.json): `lint:check`, `typecheck`, `test` (unit, `src/**/*.spec.ts`), `test:e2e` (`test/**/*.e2e-spec.ts`, không cần Docker), `test:db` (`test/db/*.db-spec.ts`, cần PostgreSQL qua `DATABASE_URL`, xem [`jest-db.js`](../../backend/test/jest-db.js) và [`temp-database.ts`](../../backend/test/support/temp-database.ts)), `build` (`nest build`). `engines.node` là `>=24`; `package-lock.json` có sẵn; không có `.nvmrc`.
  - [`docker-compose.yml`](../../docker-compose.yml): PostgreSQL 17 với `-c timezone=UTC`, user `banking`.
  - Quy tắc: [CONTRIBUTING §1, §4, §6](../../CONTRIBUTING.md) ("không dùng `pull_request_target` cho workflow chạy code từ fork", "GitHub Actions kết nối AWS qua OIDC"), [docs/03 §13.3](../03_HIGH_LEVEL_ARCHITECTURE.md), [ci-cd concept brief](../components/ci-cd/01-concept-brief.md) (Draft, chưa có thiết kế pipeline), [testing.md](../../.claude/skills/dbs-delivering-task/references/testing.md) (dòng "CI workflows … DBS-35").
  - Task trước nhắc tới task này: [DBS-20](DBS-20-migration-users-customers-accounts.md), [DBS-21](DBS-21-migration-transfers-ledger-idempotency.md), [DBS-22](DBS-22-common-money-type-dto-validator.md) đều ghi "CI xanh" chưa kiểm được và đẩy sang BL-001.
- **Baseline** (nhánh mới từ `origin/main` `4dae992`, 2026-10-19). Chạy trên **bản clone sạch** của nhánh (Windows, Node 24.11, không có `backend/env/.env.development`; **không phải Linux**, nên Linux chỉ được chứng minh bằng Actions và bằng M-35-02 chạy trong container), `npm ci`, rồi từ `backend/` (`DATABASE_URL` **không đặt** cho năm lệnh đầu, chỉ đặt cho `test:db`, đúng như CI): `lint:check` sạch, `typecheck` sạch, `npm test` 19 suite / 201 test đạt, `npm run test:e2e` 4 suite / 25 test đạt, `npm run build` sạch, `npm run test:db` **3 suite / 49 test đạt** trên container `postgres:17` mặc định (user `postgres` là superuser, timezone `Etc/UTC`). Hệ quả: unit và e2e không cần file env; không cần biến môi trường nào ngoài `DATABASE_URL` cho `test:db`.
  - Chạy lần đầu `docker compose up -d` lỗi vì Docker Desktop chưa bật; sau khi bạn bật, `test:db` vẫn đỏ 49/49 với `password authentication failed for user "banking"`. Nguyên nhân (đã kiểm): **một PostgreSQL cài sẵn trên Windows (tiến trình `postgres`) đang nghe `0.0.0.0:5432`** và chặn container (`localhost` đi vào nó). Chỉ là chuyện máy này, không phải lỗi repo; baseline `test:db` chạy trên container tạm ở cổng 25432 (cổng 55432 nằm trong dải Windows chặn). Câu hỏi 6 ở G1 đã xong.
- **Backlog** (`docs/BACKLOG.md`): **BL-001 là chính task này** ("Repo chưa có CI … chạy `lint:check`, `typecheck`, `test`, `test:e2e` và `test:db`, service Postgres 17, role superuser"), đề xuất lấy vào phạm vi và xóa dòng trong PR này (câu hỏi 1). BL-002…009 thuộc outbox, chuyển tiền, migration 6/7, lint tiền, không đụng tới task này.
- **Task khác đang mở:** `origin` chỉ có `main` và ba nhánh DBS-20/21/22 đã merge; không nhánh nào đụng `.github/`. Nhánh `feat/DBS-24-common-events` (cục bộ, chưa push) không liên quan; thư mục `docs/features/screenshots/DBS-24/` chưa theo dõi trên cây làm việc là của DBS-24, mình không chạm tới.
- **Ngoài phạm vi:**
  - Deploy lên AWS (OIDC), build và quét image, push ECR, quét secret, `npm audit` (#5, task hạ tầng/CD).
  - Bật required status checks và cấu hình ruleset của `main` (DBS-37; chỉ người quản lý repo làm được, task này chỉ cung cấp tên job ổn định).
  - Testcontainers (DBS-39…41): `test:db` dùng service container Postgres của Actions, không phải Testcontainers.
  - Sửa bất kỳ test hay code backend nào để cho CI xanh (nếu CI đỏ vì lỗi thật thì báo, không né).
  - Dependabot, badge, matrix nhiều phiên bản Node, cache build `dist/`.
- **Câu hỏi mở** (mỗi câu có đề xuất):
  1. **Phạm vi lệnh: DoD ghi bốn lệnh, BL-001 và CONTRIBUTING §4 đòi năm.** DoD #1 chỉ nêu `lint:check → typecheck → test → build`, nhưng "định nghĩa xong" ([CONTRIBUTING §4](../../CONTRIBUTING.md)) có `test:e2e`, README backend có `test:db`, và BL-001 chính là task này. *Đề xuất:* chạy **cả sáu**: `lint:check`, `typecheck`, `test`, `test:e2e`, `test:db`, `build`; lấy BL-001 vào phạm vi, xóa dòng đó ở Phase 5. Hệ quả: DBS-20/21/22 có thể chốt "CI xanh" thật. Nếu bạn muốn đúng chữ DoD (bốn lệnh) thì BL-001 giữ lại, đổi nguồn và phạm vi còn `e2e` và `db`.
  2. **Cấu trúc job và tên job (DoD #3).** *Đề xuất:* mỗi lệnh một **job song song**, `name:` cố định và không bao giờ đổi sau khi DBS-37 dùng: `lint`, `typecheck`, `unit`, `e2e`, `db`, `build`. Lý do: PR thấy ngay lệnh nào đỏ, tổng thời gian ≈ job chậm nhất thay vì cộng dồn (DoD #2). Giá phải trả là mỗi job chạy `npm ci` riêng (cache npm làm việc này rẻ). Không đặt `paths:` filter ở trigger: một check bắt buộc mà workflow bị bỏ qua sẽ treo "Expected" vĩnh viễn. Phương án thay: một job tuần tự tên `backend` (đúng mũi tên trong DoD, một tên duy nhất, nhưng không thấy lệnh nào đỏ trong danh sách check và chậm hơn).
  3. **Trigger, quyền và an toàn.** *Đề xuất:* `pull_request` (mọi nhánh đích) và `push` lên `main`; **không** `pull_request_target`; `permissions: contents: read`; `concurrency` hủy lần chạy cũ của cùng PR nhưng không hủy lần chạy trên `main`; `timeout-minutes` cho từng job (ví dụ 10) để job treo không tốn phút Actions; chỉ dùng action chính chủ `actions/checkout`, `actions/setup-node`, ghim theo tag chính (`@v4`), không action bên thứ ba, không secret. Draft PR cũng chạy CI (mặc định). Nếu bạn muốn ghim theo commit SHA thì nói, mình tra SHA khi viết plan.
  4. **Node và cache.** *Đề xuất:* `node-version: 24` (khớp `engines >=24` và `node:24-alpine` trong Dockerfile), `actions/setup-node` với `cache: npm` và `cache-dependency-path: backend/package-lock.json`, `npm ci`, `working-directory: backend`. Không thêm `.nvmrc` (đổi cách chọn phiên bản Node là việc khác).
  5. **Test thủ công DoD #4 (PR cố tình làm hỏng).** Theo [task-kinds.md](../../.claude/skills/dbs-delivering-task/references/task-kinds.md): sau G3 bạn xin **Draft PR** (nếu muốn), rồi trên đúng PR đó mình đẩy lần lượt (a) một commit làm hỏng lint → chỉ job `lint` đỏ; (b) revert, rồi một commit làm hỏng một test → chỉ job `unit` đỏ; (c) revert → tất cả xanh. Link các lần chạy là bằng chứng; squash merge xóa các commit thử. *Đề xuất:* làm như vậy. Việc này cần đẩy lên GitHub nên **chỉ sau G3 và chỉ khi bạn xin Draft PR**; trước G3 mình chỉ kiểm bằng `actionlint` (chưa cài, mình sẽ thử chạy qua Docker hoặc `go run`) và chạy từng lệnh ở local. Vì chưa chắc có `gh` đăng nhập, bạn có thể phải tạo PR từ nội dung mình soạn, và dán link run cho mình.
  6. **Docker cho `test:db` ở local.** Hai việc cần Docker: baseline `test:db` (chưa chạy được) và kiểm cấu hình service Postgres. *Đề xuất:* bạn bật Docker Desktop, mình chạy `docker compose up -d` rồi `test:db` làm baseline trước khi sang G2. Nếu không bật được thì `test:db` chỉ được chứng minh bằng chính lần chạy trên Actions (bằng chứng ở §8, đánh dấu "không có baseline local").
  7. **README/CONTRIBUTING ghi cách đọc log CI (DoD #4).** *Đề xuất:* thêm một mục ngắn vào CONTRIBUTING (cách mở tab Checks, đọc job đỏ, chạy lại đúng lệnh ở local, danh sách tên job cho DBS-37) và một dòng trỏ tới đó ở [README](../../README.md) mục chuẩn bị mở PR; đồng bộ [backend/README](../../backend/README.md) dòng 50 nếu lệnh đổi. Không ghi lịch sử, chỉ trạng thái hiện tại ([docs-style.md](../../.claude/skills/dbs-delivering-task/references/docs-style.md)).
  8. **DoD #5 và "CI xanh trên main".** PR merge, Dev khác review và bảng «Đối chiếu test case» là quy trình; "xanh trên `main`" chỉ kiểm được sau merge. *Đề xuất:* một dòng "quy trình" trong §4, và bạn báo lại kết quả lần chạy `push main` đầu tiên để mình bổ sung vào §8 (hoặc ghi vào PR).

**Quyết định ở G1 (2026-10-19):** «ok duyệt», không sửa: duyệt cả 8 đề xuất. Hệ quả: sáu lệnh và sáu job song song tên `lint`, `typecheck`, `unit`, `e2e`, `db`, `build` (câu 1, 2); BL-001 lấy vào phạm vi và xóa ở Phase 5; trigger, quyền, `concurrency`, `timeout-minutes`, chỉ action chính chủ (câu 3); Node 24, cache npm (câu 4); Draft PR sau G3 nếu bạn xin, đẩy commit hỏng lint rồi hỏng test (câu 5); mục đọc log trong CONTRIBUTING và dòng ở README (câu 7); DoD #5 là quy trình (câu 8). Một chi tiết của câu 3 cần chốt lại ở G2: «ghim `@v4`» (câu hỏi 1 của G2).

## 2. Hành vi

### 2.1 Khi nào CI chạy

| Sự kiện | Chạy? | Ghi chú |
|---|---|---|
| Mở, cập nhật (push thêm commit), mở lại PR, đích bất kỳ | có | `pull_request` với kiểu mặc định (`opened`, `synchronize`, `reopened`); Draft PR cũng chạy |
| Push lên `main` (kể cả commit squash merge) | có | `push` với `branches: [main]`; kết quả hiện trên commit, là bằng chứng "CI xanh trên main" cho DoD #5 |
| Push lên nhánh khác khi chưa có PR | không | tránh chạy đôi (push + pull_request) |
| PR chỉ sửa tài liệu | **có** | không dùng `paths:`. Một check bắt buộc mà workflow bị bỏ qua sẽ treo ở "Expected" vĩnh viễn (DBS-37) |
| PR từ fork | có, token chỉ đọc, không secret | task không dùng secret nào; **không** `pull_request_target` (CONTRIBUTING §6). Không thử được trước khi merge (không có case riêng): bảo đảm bằng thiết kế, TC-35-16 kiểm tĩnh. Repo công khai nên ai cũng mở được PR từ fork; chi phí 0 đồng (runner chuẩn miễn phí cho repo công khai), sáu job song song, mỗi job tối đa 10 phút. Bật thêm cài đặt repo "Require approval for first-time contributors" là việc của người quản lý repo |
| PR đang xung đột với `main` | **không có check nào chạy** | GitHub không chạy workflow `pull_request` khi PR có xung đột. Sau DBS-37 PR hiện sáu check "Expected" và không có log: gỡ xung đột với `main` rồi push (ghi trong CONTRIBUTING) |
| Hai lần push liên tiếp lên cùng PR | lần cũ bị hủy, lần mới chạy | `concurrency` theo ref, `cancel-in-progress` chỉ khi là `pull_request` |
| Hai lần merge liên tiếp vào `main` | **cả hai chạy hết, không lần nào bị hủy** | `cancel-in-progress: false` chỉ giữ lần đang chạy; còn một lần *đang chờ* trong cùng nhóm vẫn bị lần mới đè. Nên lần push dùng nhóm riêng theo `run_id` (không bao giờ trùng) |

### 2.2 Sáu job song song

Mỗi job độc lập (không `needs:`), nên một job đỏ không che job khác: PR cho thấy cùng lúc mọi thứ hỏng. Mỗi job: checkout, cài Node 24 có cache npm, `npm ci`, đúng một lệnh, tất cả trong `backend/`.

| Job (`name:` = id, **không đổi** sau khi DBS-37 dùng) | Lệnh | Cần Postgres | Đỏ khi |
|---|---|---|---|
| `lint` | `npm run lint:check` | không | eslint báo lỗi (gồm luật ranh giới module) |
| `typecheck` | `npm run typecheck` | không | `tsc` báo lỗi kiểu |
| `unit` | `npm test` | không | một test `src/**/*.spec.ts` đỏ |
| `e2e` | `npm run test:e2e` | không (DB đã mock) | một test `test/**/*.e2e-spec.ts` đỏ |
| `db` | `npm run test:db` | **có**: service `postgres:17` | một test `test/db/*.db-spec.ts` đỏ, **hoặc không nối được Postgres** (đỏ, không bao giờ bỏ qua) |
| `build` | `npm run build` | không | `nest build` lỗi |

Mỗi job tối đa 10 phút (`timeout-minutes: 10`). Chạy song song nên tổng thời gian của workflow xấp xỉ job chậm nhất; mốc cần chứng minh là **≤ 10 phút** (DoD #2) cả khi chưa có cache lẫn khi có cache. Ước tính từ baseline: `db` ~20 giây test, các job còn lại dưới 40 giây test, cộng `npm ci` và khởi động runner.

### 2.3 Job `db`

- Service container `postgres:17` (cùng major với `docker-compose.yml`), `POSTGRES_USER=postgres`, `POSTGRES_PASSWORD=postgres`, `POSTGRES_DB=banking`, cổng `5432:5432`. Health check: `options: --health-cmd "pg_isready -h 127.0.0.1 -U postgres -d banking" --health-interval 2s --health-timeout 5s --health-retries 30`. Phải có `-h 127.0.0.1` (nối qua TCP): `pg_isready` mặc định nối qua Unix socket, mà bước khởi tạo của image chạy một server tạm chỉ nghe socket, nên không có `-h` thì "sẵn sàng" có thể đến trước khi server thật nghe TCP. `--health-interval` mặc định 30 giây nên phải hạ xuống (docker-compose cũng dùng 5 giây). Các bước sau chỉ chạy khi service khỏe. Dữ liệu và mật khẩu này chỉ sống trong runner tạm; không phải secret.
- Bước kiểm trước khi chạy test (bước `Kiểm Postgres`): `psql` hỏi `select rolsuper from pg_roles where rolname = current_user` và `show timezone`; **job đỏ** nếu không phải `t` và `UTC`/`Etc/UTC`. Nhờ vậy điều kiện của BL-001 và ADR-02 (superuser, `timezone=UTC`) được CI kiểm thật, không dựa vào mặc định của image. `psql` có sẵn trên `ubuntu-24.04`; nếu thiếu, bước này là lý do đỏ đầu tiên và được sửa ở §7.
- `DATABASE_URL=postgres://postgres:postgres@localhost:5432/banking`. Role phải là **superuser** vì TC-21-24 dùng `session_replication_role = replica` ([BL-001](../BACKLOG.md)); user `postgres` của image chính thức là superuser (đã kiểm: `rolsuper = t`). Timezone `Etc/UTC` là mặc định của image (đã kiểm), khớp `-c timezone=UTC` của compose; service container của Actions không cho truyền tham số dòng lệnh cho Postgres, nên task không ép thêm.
- Mỗi file test tự tạo database `dbs_test_<hex>` rồi xóa (xem [`temp-database.ts`](../../backend/test/support/temp-database.ts)), nên các suite không thấy dữ liệu của nhau và runner không cần dọn.
- Không nối được Postgres hoặc thiếu `DATABASE_URL` → test ném lỗi → job đỏ (đã kiểm ở baseline: sai mật khẩu cho 49/49 test đỏ, không test nào bị bỏ qua).

### 2.4 Kết quả nhìn thấy trên PR

Tab *Checks* và khung trạng thái cuối PR liệt kê đúng sáu check `lint`, `typecheck`, `unit`, `e2e`, `db`, `build`. Check đỏ có link thẳng vào log; bước đỏ tự mở sẵn. CONTRIBUTING có mục hướng dẫn: cách mở log, cách đọc lỗi eslint/tsc/jest, cách chạy đúng lệnh đó ở local (bảng ở §2.2), cách chạy lại job lỗi tạm thời (*Re-run failed jobs*), và danh sách tên job cho DBS-37.

### 2.5 Ca biên

| Tình huống | Hành vi |
|---|---|
| `package-lock.json` lệch `package.json`, hoặc lệch phiên bản npm mới hơn | `npm ci` lỗi → cả sáu job đỏ (cố ý: lockfile không đồng bộ là lỗi thật). Đã xảy ra thật ở lần chạy thử trên Linux (npm 11.19 từ chối lockfile mà npm 11.6 chấp nhận), xem §8 Lệch kế hoạch |
| Chưa có cache (lần đầu hoặc lockfile mới) | chạy chậm hơn, vẫn xanh; ghi thời gian ở §8. `setup-node` chỉ lưu cache khi job xanh (`post-if: success()`), nên một lần chạy đỏ (M-35-06, M-35-08) không ghi cache |
| Runner thiếu `backend/env/.env.development`, và biến `DATABASE_URL` chỉ có ở job `db` | không ảnh hưởng: đã kiểm trên bản clone sạch, **không đặt `DATABASE_URL`**, `lint:check`, `typecheck`, `test`, `test:e2e`, `build` đều xanh (201 / 25) |
| Jest không tìm thấy test nào | jest thoát 1 mặc định (`test/jest*.js` không đặt `passWithNoTests`) nên job đỏ. Test bị `it.skip`/`.only` vẫn xanh: CI không chặn được, là việc của review (SKILL.md 4b) |
| Một file thử như `src/ci-probe.ts` có biến không dùng | chỉ `lint` đỏ: `tsconfig.json` không bật `noUnusedLocals`, eslint đặt `@typescript-eslint/no-unused-vars` là `error` |
| Một file `*.spec.ts` thêm vào `src/` có `expect(1 + 1).toBe(3)` | chỉ `unit` đỏ: `tsconfig.build.json` loại `**/*.spec.ts` khỏi `build`; `typecheck` dùng `tsconfig.json` và vẫn biên dịch được file đó |
| Job `db` lỗi vì Postgres chậm khởi động | health check chặn đến khi `pg_isready`; nếu vẫn lỗi thì job đỏ và dùng *Re-run failed jobs* |
| Ai đó đổi tên một job | check bắt buộc cũ (DBS-37) treo "Expected": quy tắc ghi trong CONTRIBUTING và comment đầu `ci.yml`: đổi tên job = đổi ruleset cùng lúc |
| Workflow khác (deploy của #5) | không dùng lại các tên `lint`, `typecheck`, `unit`, `e2e`, `db`, `build` cho job của nó, vì check bắt buộc khớp theo tên |

## 3. Kiến trúc

- **Vị trí:** `.github/workflows/ci.yml` (mới; xóa `.github/workflows/.gitkeep`). Không đụng code backend, không thêm dependency npm, không thêm biến môi trường của ứng dụng (`DATABASE_URL` ở đây chỉ là biến của job test, `temp-database.ts` đã đọc sẵn). Role `api`/`worker`: không áp dụng.
- **Hình dạng file** (khung đã chốt; nội dung thật ở §7):

```yaml
name: CI
on:
  pull_request:
  push:
    branches: [main]
permissions:
  contents: read
concurrency:
  # PR: một nhóm theo ref, lần mới đè lần cũ. push: nhóm riêng theo run_id, không bao giờ bị hủy.
  group: ci-${{ github.workflow }}-${{ github.event_name == 'pull_request' && github.ref || github.run_id }}
  cancel-in-progress: ${{ github.event_name == 'pull_request' }}
env:
  NODE_VERSION: "24"
defaults:
  run:
    working-directory: backend
jobs:
  lint:
    name: lint
    runs-on: ubuntu-24.04
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@<sha40>      # v7.0.1; persist-credentials: false
      - uses: actions/setup-node@<sha40>    # v7.1.0; node-version: ${{ env.NODE_VERSION }}, cache: npm, cache-dependency-path: backend/package-lock.json
      - run: npm ci
      - run: npm run lint:check
  # typecheck, unit, e2e, build: cùng khuôn, khác lệnh cuối
  # db: thêm services.postgres (postgres:17, health-cmd theo §2.3), bước "Kiểm Postgres" (superuser, UTC) và env.DATABASE_URL
```

- **Vì sao sáu job lặp lại bốn bước thay vì dùng composite action hay YAML anchor:** ít thứ chuyển động nhất; phiên bản Node nằm ở **một** chỗ (`env.NODE_VERSION`). Gom lại là refactor riêng nếu nhóm muốn.
- **Phiên bản action (chốt ở G2: ghim SHA):** G1 ghi "ghim theo tag chính (`@v4`)". Đã kiểm `git ls-remote`: cả hai action có tới `v7`, và một tag chính **di chuyển được** nên không phải là ghim. Cache npm ghi từ lần chạy trên `main` được mọi nhánh đọc, kể cả workflow deploy OIDC của #5 sau này; một tag bị tráo sẽ chạm tới đường deploy. Quyết định: ghim theo **SHA 40 ký tự kèm comment phiên bản**: `actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1`, `actions/setup-node@949feb2413d6458794dcd2491c4babbbce0c15c1 # v7.1.0` (SHA lấy bằng `git ls-remote` ngày 2026-10-19; hai tag này là tag nhẹ nên SHA là commit). Đã kiểm `action.yml` tại hai SHA: cả hai khai `using: node24`, runner `ubuntu-24.04` chạy được; bằng chứng cuối là lần chạy đầu tiên trên Actions (M-35-04, do chủ task chạy). `setup-node` v7 đổi cách xử lý `NODE_AUTH_TOKEN` và chuyển sang ESM; workflow này không dùng cả hai.
- **Dữ liệu và transaction:** không chạm bảng nào của ứng dụng; chỉ tạo và xóa database `dbs_test_*` trong service tạm. Không áp dụng `TransactionService`.
- **Sơ đồ:**

```mermaid
flowchart LR
    T["pull_request hoặc push main"] --> W["workflow CI"]
    W --> L["lint"]
    W --> TC["typecheck"]
    W --> U["unit"]
    W --> E["e2e"]
    W --> D["db"]
    W --> B["build"]
    PG[("service postgres 17")] --- D
    L --> R["checks trên PR: xanh hoặc đỏ"]
    TC --> R
    U --> R
    E --> R
    D --> R
    B --> R
```

- **An toàn:** `permissions: contents: read` (không ghi được vào repo); checkout `persist-credentials: false` (không cần đẩy gì); không `pull_request_target`; không secret; chỉ `actions/checkout` và `actions/setup-node`, ghim theo SHA. Không có bước nào tải script bên ngoài; không chèn dữ liệu sự kiện (tên nhánh, tiêu đề PR) vào lệnh `run:`, nên không có đường chèn script. Mật khẩu `postgres` của service là giá trị tạm trong runner, không phải secret.
- **Bàn giao (không nằm trong phạm vi task này, ghi ở §8 và BACKLOG):**
  - **DBS-37:** (a) tên `lint`, `build`… là tên chung, một check bắt buộc khớp theo tên với *mọi* app hoặc workflow: đặt nguồn mong đợi là "GitHub Actions"; (b) một check chỉ hiện trong ô chọn của ruleset sau khi đã chạy gần đây, nên phải có lần chạy của PR này trước; (c) nếu bật merge queue thì `ci.yml` cần thêm trigger `merge_group`, nếu không check treo "pending" trong hàng đợi.
  - **#5 (deploy, quét image):** không dùng lại sáu tên job của task này cho job của workflow khác.
- **Thay đổi cấp hệ thống (cùng PR):** [CONTRIBUTING](../../CONTRIBUTING.md) (mục đọc log CI và tên job), [README](../../README.md) (mục chuẩn bị mở PR), [backend/README](../../backend/README.md) (dòng 50 trỏ tới CI), [ci-cd concept brief](../components/ci-cd/01-concept-brief.md) (thêm job test), [testing.md](../../.claude/skills/dbs-delivering-task/references/testing.md) (xóa dòng "CI workflows … DBS-35" khỏi bảng chưa-xây), [BACKLOG](../BACKLOG.md) (xóa BL-001), [README feature](README.md) (thêm dòng DBS-35). Không đổi ADR, schema, event contract, `ErrorCode`, env của ứng dụng. Không có mục docs/03 nào phải sửa (13.3 nói về deploy).

## 4. Test cases tự động

Task này là cấu hình CI nên không có "unit test" của code. Bằng chứng gồm ba lớp: **tĩnh** (`actionlint` và kiểm khóa bằng lệnh), **tái hiện cục bộ** (sáu lệnh trên bản clone sạch, giống runner) và **trên Actions** (các lần chạy thật; lớp duy nhất chứng minh được cache, thời gian và tên check). Case lớp Actions chỉ "đạt" khi có link lần chạy thật.

| ID | Truy vết | Lớp | Given · When · Then | Mã lỗi |
|---|---|---|---|---|
| TC-35-01 | DoD #1 | tĩnh | Given `ci.yml` · When `actionlint` · Then thoát 0, không cảnh báo | n/a |
| TC-35-02 | DoD #1 | tĩnh | Given `ci.yml` · When kiểm khóa `on:` và `concurrency` · Then có `pull_request` và `push.branches == [main]`; **không** có `paths`, `paths-ignore`, `branches` dưới `pull_request`, và không có `pull_request_target`; `concurrency.group` chứa `github.run_id` cho nhánh `push` và `github.ref` cho `pull_request`; `cancel-in-progress` chỉ đúng khi `pull_request` | n/a |
| TC-35-03 | DoD #1 | tái hiện cục bộ | Given bản clone sạch, không `.env.development`, `DATABASE_URL` chỉ đặt cho `test:db` · When chạy sáu lệnh lint → typecheck → test → test:e2e → test:db → build, ở Windows (baseline) và trong container `node:24` Linux (M-35-02) · Then cả sáu thoát 0 với số đếm 201 / 25 / 49 | n/a |
| TC-35-04 | DoD #1 | Actions | Given Draft PR · When mở PR · Then đủ sáu check chạy và xanh, mỗi check chạy đúng một lệnh của §2.2 (đọc log) | n/a |
| TC-35-05 | DoD #1 | Actions | Given cùng PR · When đẩy hai commit rỗng cách nhau khoảng 10 giây · Then lần chạy của commit đầu hiện "Cancelled", lần của commit sau chạy hết và xanh. Phần `main` (hai merge liên tiếp không hủy nhau) **không thử được trước khi merge**: chứng minh bằng khóa nhóm ở TC-35-02, quan sát thật ở M-35-10 | n/a |
| TC-35-06 | DoD #2 | Actions | Given lần chạy đầu (cache miss) và lần sau (cache hit) · When xem log `setup-node` · Then lần đầu *npm cache is not found* rồi lưu cache, lần sau *Cache restored from key* | n/a |
| TC-35-07 | DoD #2 | Actions | Given hai lần chạy trên · When đọc tổng thời gian workflow · Then ≤ 10 phút cả hai lần | n/a |
| TC-35-08 | DoD #3 | tĩnh + Actions | Given `ci.yml` · When so `name:` với id và với danh sách check trên PR · Then đúng sáu tên `lint`, `typecheck`, `unit`, `e2e`, `db`, `build`, `name:` = id; danh sách trong CONTRIBUTING khớp | n/a |
| TC-35-09 | DoD #4 | Actions | Given PR có một vi phạm eslint cố ý · When CI chạy · Then `lint` đỏ, PR hiện ✗; log chỉ đúng file và dòng | n/a |
| TC-35-10 | DoD #4 | Actions | Given PR có một test unit cố ý sai · When CI chạy · Then `unit` đỏ; PR hiện ✗ | n/a |
| TC-35-11 | DoD #4 | Actions | Given hai lỗi cố ý đã revert · When CI chạy lại · Then cả sáu xanh | n/a |
| TC-35-12 | DoD #4 | tĩnh | Given CONTRIBUTING và README · When `check-doc-links.mjs` và đối chiếu danh sách job · Then 0 link hỏng; CONTRIBUTING có mục đọc log CI với đủ sáu tên job, cách chạy lại cục bộ, cách *Re-run failed jobs*, và dòng "không có check hoặc 'Expected' → gỡ xung đột với `main` rồi push" | n/a |
| TC-35-13 | DoD #5 | quy trình | PR merge vào `main`, lần chạy `push main` xanh; Dev khác review; bảng «Đối chiếu test case» trong PR | n/a |
| TC-35-14 | BL-001 | Actions | Given job `db` · When chạy · Then service Postgres khỏe (health check theo §2.3), bước `Kiểm Postgres` xác nhận role là superuser và timezone là `UTC`/`Etc/UTC` (sai thì job đỏ), jest báo 3 suite / 49 test (không test nào bị bỏ qua) | n/a |
| TC-35-15 | BL-001 | tái hiện cục bộ | Given `DATABASE_URL` trỏ vào cổng không có Postgres · When `npm run test:db` · Then thoát khác 0 (đỏ rõ ràng, không bỏ qua) | n/a |
| TC-35-16 | CONTRIBUTING §6, bảo mật | tĩnh | Given `ci.yml` · When kiểm · Then `permissions: contents: read` toàn workflow; không có `secrets.`; không có `${{ github.event` trong `run:`; mọi `uses:` thuộc `actions/` và ghim bằng SHA 40 ký tự (kèm comment phiên bản); `persist-credentials: false` ở mọi checkout | n/a |
| — | PR từ fork | không thử được | Chỉ bảo đảm bằng thiết kế (TC-35-02, TC-35-16); không có case Actions vì cần một tài khoản fork | n/a |

Bảng kiểm bảo mật ([testing.md](../../.claude/skills/dbs-delivering-task/references/testing.md)): chỉ dòng "không bí mật trong repo, image, log" áp dụng (TC-35-16); các dòng còn lại (role guard, ownership, idempotency, audit, DTO, SQL tham số hóa, TLS) **không áp dụng**: task không có endpoint, dữ liệu hay SQL.

## 5. Test thủ công

Điều kiện chạy: Docker Desktop bật; máy này có PostgreSQL native chiếm cổng 5432 nên dùng container tạm ở cổng 25432.

**Ai chạy bước nào (chốt ở G2):** agent chạy M-35-01, M-35-02, M-35-03 (cục bộ, không cần GitHub) và ghi vào `manual-test.txt`. **M-35-04 đến M-35-10 cần chạy thật trên GitHub Actions và do chủ task (người) tự chạy tay sau khi task xong**; agent không mở Draft PR, không đẩy commit thử. (Cập nhật sau bàn giao: chủ task mở PR #11 và đồng ý cho agent chạy M-35-05…09; xem §8, Lệch so với kế hoạch.) Trong §8 các bước đó ghi **chưa chạy (chủ task tự chạy)**, và các case lớp Actions ghi tương ứng; chủ task chấp nhận từng bước theo tên ở G4. Không bước nào được ghi "đạt" nếu chưa có lần chạy thật.

| Bước | Việc làm | Kết quả mong đợi |
|---|---|---|
| M-35-01 | Trong PowerShell, từ gốc repo: `docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint:1.7.12 -color` (trong Git Bash: thêm `MSYS_NO_PATHCONV=1` ở đầu lệnh, nếu không `-w /repo` bị đổi thành đường dẫn Windows) | thoát 0, không in gì (đường thành công, tĩnh); image ghim `1.7.12` để kết quả lặp lại được |
| M-35-02 | Tạo mạng Docker tạm; chạy `postgres:17` với đúng env và health check của service (§2.3) trên mạng đó; trong container `node:24` (Linux) cùng mạng: `git clone` repo chỉ đọc vào thư mục trong container, `cd backend && npm ci`, chạy `lint:check`, `typecheck`, `test`, `test:e2e`, `build` **không đặt `DATABASE_URL`**, rồi `DATABASE_URL=postgres://postgres:postgres@<tên container>:5432/banking npm run test:db`; chạy thêm bước `Kiểm Postgres` của §2.3 từ một container client tạm cùng mạng, đúng URL như CI: `docker run --rm --network <mạng> postgres:17 psql "postgres://postgres:postgres@<tên container pg>:5432/banking" -tAc "select rolsuper from pg_roles where rolname = current_user" -c "show timezone"` (container `node:24` không có `psql`; không dùng `docker exec` vào container Postgres vì nó đi qua Unix socket, không phải TCP như CI) | sáu lệnh thoát 0; 201 unit, 25 e2e, 49 db; `rolsuper = t`, timezone `Etc/UTC` (tái hiện cục bộ trên Linux, đường thành công) |
| M-35-03 | Trong clone đó: `DATABASE_URL=postgres://postgres:postgres@localhost:25999/banking npm run test:db` | thoát khác 0, 49 test đỏ với "Cannot reach PostgreSQL" (ca lỗi to rõ) |
| M-35-04 | Bạn mở Draft PR; xem tab Checks | đúng sáu check `lint`, `typecheck`, `unit`, `e2e`, `db`, `build`, tất cả xanh; ghi URL và thời gian (cache miss) |
| M-35-05 | Sau khi M-35-04 xanh, đẩy hai commit rỗng (`git commit --allow-empty`) cách nhau khoảng 10 giây | lần chạy của commit đầu hiện "Cancelled", lần của commit sau xanh; log `setup-node` có *Cache restored*; thời gian ≤ 10 phút (đường phục hồi / cache) |
| M-35-06 | Chạy cục bộ `lint:check`, `typecheck`, `test`, `test:e2e`, `build` trên file thử để chắc chỉ `lint:check` đỏ; đẩy commit thêm `src/ci-probe.ts` có biến không dùng; đọc log theo hướng dẫn trong CONTRIBUTING | `lint` đỏ, đúng file và dòng; năm job còn lại xanh; PR hiện ✗ |
| M-35-07 | Revert commit trên; đẩy | cả sáu xanh |
| M-35-08 | Chạy cục bộ `lint:check`, `typecheck`, `test`, `test:e2e`, `build` để chắc chỉ `test` đỏ (đúng một test) và file thử đúng chuẩn prettier/eslint; đẩy commit thêm `src/ci-probe.spec.ts` có `expect(1 + 1).toBe(3)` | `unit` đỏ, năm job còn lại xanh |
| M-35-09 | Revert; đẩy | cả sáu xanh; mọi file probe đã xóa, cây làm việc sạch |
| M-35-10 | (sau merge, bạn báo lại) lần chạy `push main`; nếu có hai PR merge sát nhau thì cả hai lần chạy phải còn nguyên | sáu check xanh trên commit merge, không lần nào "Cancelled"; chưa merge thì **chưa chạy (chờ merge)** |

Ảnh chụp dự kiến: trang Checks lúc xanh (M-35-04), lúc `lint` đỏ (M-35-06), lúc `unit` đỏ (M-35-08), lúc xanh lại (M-35-09), kết quả `actionlint` (M-35-01).

## 6. Domain review (AI)

**Reviewer:** subagent `general-purpose`, model Opus, 2026-10-19 · **Kết quả:** 12 phát hiện (blocking 1, should-fix 4, minor 7), verdict **REVISE** · [trả lời nguyên văn](screenshots/DBS-35/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | blocking | Lần chạy trên `main` không phải "không bao giờ bị hủy": `cancel-in-progress: false` chỉ giữ lần đang chạy, một lần đang *chờ* trong cùng nhóm bị lần mới đè; ba PR merge liền thì commit giữa mất kết quả xanh | **đã sửa** §2.1, §3, TC-35-02, TC-35-05, M-35-10: nhóm riêng theo `run_id` cho `push`, test tĩnh kiểm khóa nhóm. Đã kiểm lại ngữ nghĩa theo tài liệu GitHub mà reviewer trích |
| 2 | should-fix | Tái hiện cục bộ chạy trên Windows, đặt `DATABASE_URL` cho cả sáu lệnh nên không giống CI | **đã sửa**: chạy lại năm lệnh với `DATABASE_URL` không đặt (201 / 25, lint, typecheck, build xanh); M-35-02 chạy trong container `node:24` Linux; §1 ghi rõ baseline là Windows |
| 3 | should-fix | M-35-05 không làm được theo thứ tự (không còn lần chạy nào đang chạy) | **đã sửa**: hai commit rỗng cách nhau 10 giây |
| 4 | should-fix | Tag chính `@v7` không phải ghim; cache `main` đi vào đường deploy OIDC của #5 | **đã sửa đề xuất**: ghim SHA kèm comment phiên bản; SHA đã tra lại bằng `git ls-remote`; TC-35-16 kiểm SHA 40 ký tự; chờ bạn chốt (câu 1 của G2) vì lệch quyết định G1 |
| 5 | should-fix | `--health-cmd` thiếu `-h 127.0.0.1` và interval mặc định 30 giây | **đã sửa** §2.3 với chuỗi lệnh đầy đủ |
| 6 | minor | Không case nào kiểm `timezone=UTC` trên CI | **đã sửa**: bước `Kiểm Postgres` (superuser và UTC, sai thì đỏ), gộp vào TC-35-14 |
| 7 | minor | Xóa BL-001 trước khi có "xanh trên `main`" | **đã sửa kế hoạch**: vẫn xóa dòng ở PR này, §9 ghi việc đóng phụ thuộc lần chạy `push main` đầu tiên (M-35-10), dòng được trả lại nếu đỏ |
| 8 | minor | PR xung đột thì không có check, DBS-37 sẽ treo "Expected" | **đã sửa** §2.1, TC-35-12 (dòng trong CONTRIBUTING) |
| 9 | minor | §2.5 thiếu ca không-có-test / `it.skip`; câu "nếu typecheck cũng đỏ" thừa | **đã sửa** §2.5, bỏ câu thừa ở M-35-06, thêm bước chạy cục bộ trước khi đẩy file thử (M-35-06, M-35-08) |
| 10 | minor | Lệnh `actionlint` hỏng trong Git Bash (MSYS đổi đường dẫn); image không ghim | **đã sửa** M-35-01: PowerShell hoặc `MSYS_NO_PATHCONV=1`, image `1.7.12` |
| 11 | minor | Thiếu danh sách bàn giao cho DBS-37 và #5 | **chuyển sang §3 Bàn giao**; Phase 5 thêm dòng `BL-NNN` |
| 12 | minor | Dòng PR từ fork không có case, thiếu câu về chi phí | **đã sửa** §2.1 (không thử được, bảo đảm bằng thiết kế) và §4; repo công khai (đã kiểm bằng API GitHub) nên chi phí 0 |

Vì verdict là REVISE, mình chạy lại review cho các mục đã sửa (xem dòng dưới).

**Vòng 2** (reviewer mới, model Opus, 2026-10-19): 12 phát hiện vòng 1 đều *fixed correctly* (riêng #9 *incomplete*), thêm 4 phát hiện mới (should-fix 1, minor 3), **Verdict: APPROVE** · [trả lời nguyên văn](screenshots/DBS-35/domain-review.md) (phần "Vòng 2")

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| N1 | should-fix | M-35-02 không chạy được: container `node:24` không có `psql`; `docker exec` đi qua Unix socket | **đã sửa** M-35-02: container client `postgres:17` cùng mạng, đúng URL như CI |
| N2 | minor | Chuỗi log cache miss sai ("Cache not found") | **đã sửa** TC-35-06: *npm cache is not found* / *Cache restored from key* |
| N3 | minor | Câu hỏi runtime Node của v7 đã trả lời được (`using: node24`); cache chỉ lưu khi job xanh | **đã sửa** §3, §2.5 |
| N4 | minor | Bước kiểm cục bộ trước file thử chưa nêu đủ lệnh (#9 chưa trọn) | **đã sửa** M-35-06, M-35-08: năm lệnh, nêu lệnh duy nhất được phép đỏ |

**Quyết định ở G2 (2026-10-19):** «duyệt», không sửa. (1) Ghim action theo SHA 40 ký tự, theo đề xuất. (2) Test thủ công trên GitHub (M-35-04…10) do chủ task tự chạy sau khi task xong, không cần bổ sung gì thêm; agent chỉ chạy phần cục bộ M-35-01…03. Hệ quả: không Draft PR do agent mở, các bước và case lớp Actions là "chưa chạy (chủ task tự chạy)" khi bàn giao (chủ task chấp nhận từng cái ở G4). (3) BL-001 xóa ở PR này, §9 ghi việc đóng phụ thuộc lần chạy `push main` đầu tiên; thêm dòng bàn giao cho DBS-37 và #5.

## 7. Kế hoạch triển khai

Quy ước: lệnh tĩnh gọi tắt **`actionlint`** = `docker run --rm -v "${PWD}:/repo" -w /repo rhysd/actionlint:1.7.12 -color` (PowerShell), và **kiểm tĩnh** = một đoạn `node -e` đọc `ci.yml` bằng regex (repo không có thư viện YAML; không thêm dependency) kiểm TC-35-02, 08, 16. Đoạn lệnh đó được dán nguyên văn vào §8 để người review chạy lại; không thành file trong repo.

| Bước | File | Test viết trước | Kết quả đỏ (điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | không có file mới (chỉ chạy kiểm tra) | TC-35-01, 02, 08, 16: `actionlint` và kiểm tĩnh trên `.github/workflows/ci.yml` **chưa tồn tại** | `actionlint`: `could not read ".github/workflows/ci.yml": … no such file` (exit 3); kiểm tĩnh: `FAIL file: ENOENT` (exit 1) | `actionlint`; kiểm tĩnh | không |
| 2 | `.github/workflows/ci.yml` (mới, sáu job, SHA ghim theo §3); xóa `.github/workflows/.gitkeep` | như bước 1 | đỏ ở bước 1 → `actionlint` exit 0 và 14/14 PASS (đã thử trên bản sao bị hỏng: cả hai công cụ báo FAIL) | `actionlint` thoát 0; kiểm tĩnh in PASS cho từng điều kiện (khóa `on:`, nhóm `concurrency`, sáu tên job = id, `uses:` ghim SHA, `permissions`, không `secrets.`/`github.event` trong `run:`) | `ci: add GitHub Actions workflow with six parallel jobs` |
| 3 | không có file mới | TC-35-03 (Linux, M-35-02), TC-35-15 (M-35-03): sáu lệnh trong `node:24` + `postgres:17` trên mạng Docker tạm; bước `Kiểm Postgres` bằng `psql`; `test:db` với cổng sai | lần 1 đỏ: `npm ci` lỗi `Missing: @emnapi/core@1.11.3 from lock file` ở mọi job (lỗi nằm ở `package-lock.json` trên `main`, không ở `ci.yml`); gate phụ, «duyệt A», sửa bằng commit `6ab5d4f`; lần 2 xanh | các lệnh ở §5 M-35-02, M-35-03; output vào `manual-test.txt` | `fix(deps): regenerate package-lock.json so npm ci passes on npm 11.19` (`6ab5d4f`, lệch kế hoạch có duyệt) |
| 4 | `CONTRIBUTING.md` (mục mới "4b. Đọc kết quả CI": mở tab Checks, đọc log, chạy lại cục bộ theo bảng §2.2, *Re-run failed jobs*, danh sách sáu tên job, quy tắc không đổi tên job, PR xung đột thì không có check, bảng tên cho DBS-37); `README.md` (dòng chuẩn bị mở PR, trỏ tới mục mới); `backend/README.md` dòng 50 (trỏ tới CI) | TC-35-12: kiểm bằng `grep` rằng CONTRIBUTING có đủ sáu tên job, "Re-run failed jobs", "xung đột", và tên khớp `ci.yml` | `grep` trên CONTRIBUTING: `unit` 0, `build` 0, `Re-run failed jobs` 0, `xung đột` 0, `4b.` 0 | `grep` ở TC-35-12; `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `docs(ci): how to read CI results and the job names` |
| 5 | `docs/components/ci-cd/01-concept-brief.md` (thêm job test của CI); `.claude/skills/dbs-delivering-task/references/testing.md` (xóa dòng "CI workflows … DBS-35"); `docs/BACKLOG.md` (xóa BL-001; thêm dòng bàn giao cho DBS-37 và #5); `docs/features/README.md` (dòng DBS-35) | `check-doc-links.mjs` sạch; `grep BL-001 docs/BACKLOG.md` rỗng | `grep BL-001 docs/BACKLOG.md` còn một dòng; testing.md còn dòng DBS-35 | `check-doc-links.mjs`; `grep` | `docs(ci): sync concept brief, testing notes and backlog with CI` |
| 6 | feature doc §8–§9; `docs/features/screenshots/DBS-35/manual-test.txt` (dòng đầu là SHA commit cuối đổi `ci.yml`), ảnh chụp M-35-01…03 | Checklist G4 | — | `check-doc-links.mjs`; `git diff --stat main...HEAD` đối chiếu bảng này | `docs(features): DBS-35 results and evidence` |

**Quét giới hạn và DoD** (mỗi cái có một dòng kế hoạch hoặc nằm ngoài phạm vi): DoD #1 → bước 2, 3; DoD #2 (cache, ≤ 10 phút) → bước 2 cấu hình, chứng minh ở TC-35-06/07 **do chủ task chạy trên Actions**; DoD #3 → bước 2 (`name:` = id), bước 4 (danh sách tên); DoD #4 → bước 4 (tài liệu), M-35-06…09 do chủ task chạy; DoD #5 → quy trình (TC-35-13); BL-001 → bước 2, 3, 5; ADR-02 (timezone `UTC`) → bước 2 (`Kiểm Postgres`); dòng `testing.md` nhắc DBS-35 → bước 5; ô "CI xanh" trong `.github/pull_request_template.md` → giữ nguyên (đã đúng); bàn giao DBS-37 và #5 → bước 5. Ngoài phạm vi: bật required checks (DBS-37), deploy/quét (#5).

**Phần không làm được trong phiên của agent (cần bạn):** chạy `ci.yml` thật trên GitHub. Agent không đẩy lên GitHub và không mở Draft PR (G2). Hệ quả: khi bàn giao, `ci.yml` đã qua `actionlint` và chạy được sáu lệnh trong container Linux giống runner, nhưng **chưa có lần chạy nào trên Actions**: các case lớp Actions (TC-35-04…11, 14, phần Actions của TC-35-05…07) ghi "chưa chạy (chủ task tự chạy)". Nếu lần chạy đầu của bạn đỏ vì lý do riêng của Actions (ví dụ thiếu `psql`, SHA sai), bạn dán log, agent sửa `ci.yml` và việc đó ghi ở §8 là lệch kế hoạch có duyệt.

**Việc bạn cần làm trên GitHub** (không thuộc commit nào, agent không làm được): (1) *Settings → Actions → General*: Actions đang bật; nếu repo đặt "Allow select actions" thì cho phép `actions/checkout` và `actions/setup-node`; "Workflow permissions" để mặc định (workflow tự đặt `contents: read`); (2) đẩy nhánh và mở PR để thấy CI chạy (và để DBS-37 chọn được tên check sau lần chạy đầu); (3) tùy chọn: bật "Require approval for first-time contributors". Bật *required status checks* là DBS-37, không phải task này.

**Ảnh chụp:** M-35-01…03 là output terminal; mình chụp bằng cách mở file output trong trình duyệt (Chrome extension) nếu làm được, nếu không sẽ nêu từng ảnh thiếu ở G4. Ảnh trang Checks (M-35-04…09) do bạn chụp khi tự chạy.

**Rủi ro và cách lùi:**
- `ci.yml` chưa chạy thật trên Actions trước khi bàn giao (nêu trên). Giảm bằng `actionlint`, chạy sáu lệnh trong container Linux và dùng đúng image `postgres:17`, user `postgres`, URL như workflow.
- `psql` thiếu trên runner: bước `Kiểm Postgres` đỏ ngay lần chạy đầu và dễ đọc; cách sửa: dùng container `postgres:17` làm client qua `docker run` hoặc cài `postgresql-client`.
- SHA action sai hoặc bị gỡ: job đỏ ở bước checkout; SHA đã tra lại bằng `git ls-remote` ngày 2026-10-19.
- Việc lùi: xóa `ci.yml` (hoặc revert commit bước 2) là đủ; không có dữ liệu, migration hay phụ thuộc runtime nào bị ảnh hưởng. Nếu job nào đó đỏ một cách chưa rõ nguyên nhân mà không có lỗi thật ở backend, **không** làm xanh bằng cách bỏ job hay nới lệnh; báo ở §8.

**Quyết định ở G3 (2026-10-19):** «duyệt», không sửa. Câu 1: chấp nhận `ci.yml` chưa có lần chạy trên Actions khi bàn giao. Câu 2: thử chụp ảnh từ output bằng trình duyệt (đã làm bằng Chrome headless).

## 8. Kết quả

- **Lệnh kiểm tra lúc bàn giao** (backend không đổi sau commit `6ab5d4f`; chạy trong container `node:24` Linux, Node v24.22.0 / npm 11.19.1, `DATABASE_URL` **không đặt** cho năm lệnh đầu, đặt cho `test:db`; output thô ở [manual-test.txt](screenshots/DBS-35/manual-test.txt) phần LẦN 2):

```
npm run lint:check  -> exit 0
npm run typecheck   -> exit 0
npm run test        -> 19 suites, 201 tests passed, exit 0
npm run test:e2e    -> 4 suites, 25 tests passed, exit 0
npm run build       -> exit 0
npm run test:db     -> 3 suites, 49 tests passed, exit 0   (postgres:17, user postgres)
```

  Trên Windows (npm 11.6.2 / Node 24.11.1, bản clone sạch, lockfile mới): `npm ci` exit 0, `lint:check`, `typecheck`, `build` exit 0, `test` 201, `test:e2e` 25. `actionlint` 1.7.12: exit 0. Không có `.skip`, `.only` hay `.todo` trong phần task thêm (task không thêm test jest nào); số test bị bỏ qua: 0.
- **Kiểm tĩnh** (TC-35-02, 08, 16), chạy từ gốc repo bằng `node <file>`; mã nguồn đầy đủ ngay dưới, kết quả: 14/14 PASS, exit 0 (trên bản sao bị làm hỏng cố ý nó báo FAIL đúng điều kiện):

<details><summary>Mã kiểm tĩnh (dán nguyên văn)</summary>

```js
import fs from 'node:fs';
const file = '.github/workflows/ci.yml';
let t;
try { t = fs.readFileSync(file, 'utf8'); } catch (e) { console.log('FAIL file: ' + e.message); process.exit(1); }
const lines = t.split(/\r?\n/);
const results = [];
const check = (name, ok) => results.push([name, ok]);

// TC-35-02: triggers and concurrency
const onBlock = /^on:\n((?:[ ]{2,}.*\n|\n)+)/m.exec(t + '\n')?.[1] ?? '';
check('on: has pull_request', /^ {2}pull_request:/m.test(onBlock));
check('on: push.branches == [main]', /^ {2}push:\n {4}branches: \[main\]\s*$/m.test(onBlock));
check('no paths / paths-ignore / pull_request_target', !/^\s*(paths|paths-ignore):|pull_request_target/m.test(t));
check('pull_request has no branches filter', !/^ {2}pull_request:\n {4}\S/m.test(onBlock));
check('concurrency group uses run_id for push and ref for PR',
  /group:.*github\.event_name == 'pull_request' && github\.ref \|\| github\.run_id/.test(t));
check("cancel-in-progress only for pull_request",
  /cancel-in-progress: \$\{\{ github\.event_name == 'pull_request' \}\}/.test(t));

// TC-35-08: six stable job names, name == id
const expected = ['lint', 'typecheck', 'unit', 'e2e', 'db', 'build'];
const jobsAt = lines.findIndex((l) => l === 'jobs:');
const ids = []; const names = {};
let cur = null;
for (const l of lines.slice(jobsAt + 1)) {
  const id = /^ {2}([a-z0-9_-]+):\s*$/.exec(l);
  if (id) { cur = id[1]; ids.push(cur); continue; }
  const nm = /^ {4}name:\s*(\S+)\s*$/.exec(l);
  if (nm && cur) names[cur] = nm[1];
}
check('exactly the six job ids ' + expected.join(','), JSON.stringify(ids) === JSON.stringify(expected));
check('every job name: equals its id', expected.every((id) => names[id] === id));
check('every job has timeout-minutes: 10', (t.match(/^ {4}timeout-minutes: 10$/gm) ?? []).length === 6);

// TC-35-16: security
check('permissions: contents: read at top level', /^permissions:\n {2}contents: read\n/m.test(t));
check('no secrets.', !/secrets\./.test(t));
const runLines = lines.filter((l) => /^\s*-?\s*run:/.test(l));
check('no ${{ in run: lines', runLines.every((l) => !l.includes('${{')));
const uses = lines.filter((l) => /^\s*-?\s*uses:/.test(l));
check('every uses: is actions/*@<40-hex SHA> # vX.Y.Z',
  uses.length > 0 && uses.every((l) => /uses: actions\/[a-z-]+@[0-9a-f]{40} # v\d+\.\d+\.\d+\s*$/.test(l)));
const checkouts = lines.filter((l) => /uses: actions\/checkout@/.test(l)).length;
check('persist-credentials: false on every checkout',
  checkouts === 6 && (t.match(/persist-credentials: false/g) ?? []).length === checkouts);

let bad = 0;
for (const [n, ok] of results) { console.log((ok ? 'PASS ' : 'FAIL ') + n); if (!ok) bad++; }
process.exit(bad ? 1 : 0);
```

</details>

- **Đối chiếu test case** (chữ "đạt" chỉ dành cho case đã chạy đủ độ sâu của nó):

| ID | Chứng cứ | Đạt? |
|---|---|---|
| TC-35-01 | M-35-01: `actionlint` 1.7.12 thoát 0, in rỗng; và thoát 1 báo `"runs-on" section is missing` trên bản sao bị hỏng | đạt |
| TC-35-02 | kiểm tĩnh, 6 dòng đầu PASS (`on:`, không `paths`/`pull_request_target`, nhóm `concurrency`, `cancel-in-progress`) | đạt |
| TC-35-03 | Windows (baseline) và Linux `node:24` (M-35-02, lần 2): sáu lệnh exit 0, 201 / 25 / 49. Lần 1 đỏ vì `npm ci`, đã sửa bằng commit `6ab5d4f` (§8 Lệch kế hoạch) | đạt |
| TC-35-04 | [run #1](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/39256485215) trên PR #11 (Draft): đủ sáu check xanh; đã đọc log của cả sáu job: mỗi job chạy `npm ci` rồi đúng một lệnh (`lint:check`, `typecheck`, `npm test`, `test:e2e`, `test:db`, `build`) | đạt |
| TC-35-05 | phần PR: push hai commit rỗng cách nhau 10 giây → run #2 **Cancelled** sau 26 giây, [run #3](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/39257508505) xanh 1m 3s (ảnh 06). Phần `main` (hai merge liên tiếp không hủy nhau) chưa thể quan sát trước khi merge | đơn giản hóa (phần `main` chưa chạy, xem M-35-10) |
| TC-35-06 | run #1, job `lint`, log `setup-node`: `npm cache is not found` (miss); [run #3](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/39257508505), cùng bước: `Cache hit for: node-cache-Linux-x64-npm-…`, `Cache restored from key` (ảnh 07); bước Post của `setup-node` chỉ 0 giây (không lưu lại) | đạt |
| TC-35-07 | tổng thời gian workflow: run #1 (cache miss) **50 giây**, run #3 (cache hit) **1 phút 3 giây**, run #5 47 giây; đều ≤ 10 phút (Node 24.21.0 trên runner) | đạt |
| TC-35-08 | phần tĩnh đạt; trên PR #11 đúng sáu check `lint`, `typecheck`, `unit`, `e2e`, `db`, `build` (ảnh 08, 12), khớp `name:` trong `ci.yml` và bảng ở CONTRIBUTING 4b | đạt |
| TC-35-09 | [run #4](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/39257863694) (commit lint hỏng `0f0bf74`): chỉ `lint` đỏ, năm job còn lại xanh; log: `src/ci-probe.ts` `3:7 error 'unused' is assigned a value but never used … @typescript-eslint/no-unused-vars`, `1 problem`; PR hiện ✗ (ảnh 08, 09) | đạt |
| TC-35-10 | [run #6](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/39258326502) (commit test hỏng `14dff24`): chỉ `unit` đỏ, năm job còn lại xanh; log: `FAIL src/ci-probe.spec.ts`, `Expected: 3 / Received: 2`, `Tests: 1 failed, 349 passed, 350 total` (ảnh 10, 11) | đạt |
| TC-35-11 | sau revert lint (`dfd1705`) run #5 xanh 47 giây; sau revert test (`52aec98`) run #7 xanh cả sáu; diff của PR trở lại +768/−35, 17 file, không còn file `ci-probe*` (ảnh 06, 12) | đạt |
| TC-35-12 | `grep` thấy đủ sáu tên, "Re-run failed jobs", "xung đột", "Expected" trong CONTRIBUTING 4b; tên trong bảng khớp `ci.yml`; `check-doc-links.mjs`: 0 link hỏng | đạt |
| TC-35-13 | quy trình (merge, review, `push main` xanh) | chưa kiểm được (sau merge, xem BL-014) |
| TC-35-14 | job `db` trên Actions ([run #1](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/39256485215)): service `postgres:17` khỏe (`Initialize containers` 11 giây, các bước sau chạy), bước `Kiểm Postgres` in `rolsuper=t timezone=Etc/UTC`, `Test Suites: 3 passed`, `Tests: 49 passed` | đạt |
| TC-35-15 | M-35-03: cổng sai → 49 test đỏ, `Cannot reach PostgreSQL … ECONNREFUSED`, exit 1 | đạt |
| TC-35-16 | kiểm tĩnh (`permissions`, không `secrets.`, không `${{` trong `run:`, mọi `uses:` ghim SHA, `persist-credentials: false` ở cả sáu checkout) | đạt |

  Tổng: **14 đạt** (TC-35-01…04, 06…12, 14…16), 1 đơn giản hóa (TC-35-05: phần `main` chưa quan sát được), 1 quy trình chưa kiểm được (TC-35-13, sau merge; xem BL-014).
- **Test thủ công** (chạy trên commit `6ab5d4f`; output thô ở [manual-test.txt](screenshots/DBS-35/manual-test.txt)):

| Bước | Kết quả |
|---|---|
| M-35-01 | **đạt**: `docker run … rhysd/actionlint:1.7.12 -color` → `actionlint exit 0`, không in gì. Lần đầu (trước khi có `ci.yml`) thoát 3 `could not read ".github/workflows/ci.yml"` |
| M-35-02 | **đạt** (lần 2). Lần 1 trên `903daf1` **đỏ**: `npm ci` lỗi `Missing: @emnapi/core@1.11.3 from lock file` (mã nguồn lỗi ở `package-lock.json`, xem Lệch kế hoạch). Lần 2: postgres healthy sau 3 giây; `Kiểm Postgres` qua TCP: `rolsuper=t timezone=Etc/UTC`; `lint:check`, `typecheck`, `build` exit 0; `test` 201; `test:e2e` 25; `test:db` 49 |
| M-35-03 | **đạt**: `DATABASE_URL` trỏ cổng 25999 → `npm run test:db` exit 1, 49 test đỏ, `Cannot reach PostgreSQL at DATABASE_URL (connect ECONNREFUSED …:25999)` |
| M-35-04 | **đạt**: Draft PR #11, [run #1](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/39256485215) (commit `50c1029`): sáu check xanh, tổng 50 giây (lint 19s, typecheck 23s, unit 19s, e2e 20s, db 46s, build 26s); `setup-node` ghi `npm cache is not found`; `Kiểm Postgres`: `rolsuper=t timezone=Etc/UTC`; `test:db` 3 suite / 49 test (ảnh 05) |
| M-35-05 | **đạt**: hai commit rỗng `61c865f`, `9f4a307` cách nhau 10 giây → run #2 Cancelled (26 giây), [run #3](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/39257508505) xanh 1m 3s, `Cache hit for: node-cache-Linux-x64-npm-…`, `Cache restored from key` (ảnh 06, 07) |
| M-35-06 | **đạt**: sau khi chạy cục bộ năm lệnh (chỉ `lint:check` đỏ), đẩy `src/ci-probe.ts` → [run #4](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/39257863694): chỉ `lint` đỏ, log chỉ đúng `src/ci-probe.ts` dòng `3:7` và luật `@typescript-eslint/no-unused-vars` (ảnh 08, 09) |
| M-35-07 | **đạt**: `git revert` → run #5 xanh cả sáu, 47 giây (ảnh 06) |
| M-35-08 | **đạt**: sau khi chạy cục bộ năm lệnh (chỉ `test` đỏ), đẩy `src/ci-probe.spec.ts` → [run #6](https://github.com/Lawliet119/digital-banking-simulator/actions/runs/39258326502): chỉ `unit` đỏ, `Expected: 3 / Received: 2` (ảnh 10, 11) |
| M-35-09 | **đạt**: `git revert` → run #7 (commit `52aec98`) xanh cả sáu; PR trở lại +768/−35, 17 file (ảnh 12) |
| M-35-10 | **chưa chạy (chờ merge)**: lần chạy `push main` đầu tiên và việc hai merge liền nhau không hủy nhau |

- **Phạm vi so với §7** (`git diff --stat origin/main..HEAD`, 10 file; thêm feature doc và ảnh khi commit bước 6): `.github/workflows/ci.yml` (+155), `.github/workflows/.gitkeep` (xóa), `CONTRIBUTING.md`, `README.md`, `backend/README.md`, `docs/BACKLOG.md`, `docs/components/ci-cd/01-concept-brief.md`, `docs/features/README.md`, `.claude/skills/dbs-delivering-task/references/testing.md` đều có trong §7. **Một file ngoài kế hoạch: `backend/package-lock.json`** (xem dưới).
- **Ảnh chụp:** 01–04 từ output thật của `manual-test.txt` (render bằng Chrome headless); 05–12 chụp từ trang GitHub Actions và PR #11 bằng Claude in Chrome (JPEG):

![Lần 1 đỏ: npm ci lỗi trong container Linux](screenshots/DBS-35/01-lan1-npm-ci-do.png)

![actionlint thoát 0 và Kiểm Postgres](screenshots/DBS-35/02-actionlint-va-kiem-postgres.png)

![Sáu lệnh trong container Linux sau khi sửa lockfile](screenshots/DBS-35/03-sau-lenh-tren-linux.png)

![test:db với cổng sai: đỏ rõ ràng](screenshots/DBS-35/04-test-db-cong-sai-do.png)

![Run #1: sáu job xanh, 50 giây](screenshots/DBS-35/05-run1-sau-check-xanh.jpg)

![Các lần chạy: #2 Cancelled, #4 đỏ, #5 xanh](screenshots/DBS-35/06-danh-sach-run-huy-do-xanh.jpg)

![Cache hit ở run #3](screenshots/DBS-35/07-cache-hit-run3.jpg)

![PR #11: lint đỏ, năm check còn lại xanh](screenshots/DBS-35/08-pr-checks-lint-do.jpg)

![Log lint đỏ: ci-probe.ts dòng 3:7](screenshots/DBS-35/09-lint-log-do.jpg)

![PR #11: unit đỏ, năm check còn lại xanh](screenshots/DBS-35/10-pr-checks-unit-do.jpg)

![Log unit đỏ: Expected 3, Received 2](screenshots/DBS-35/11-unit-log-do.jpg)

![PR #11 sau hai lần revert: sáu check xanh](screenshots/DBS-35/12-pr-checks-xanh-cuoi.jpg)

  Ảnh 01 là output của script nên chỉ thấy `exit 127` sau lỗi; dòng lỗi gốc `Missing: @emnapi/core@1.11.3 from lock file` nằm ở phần "CHẨN ĐOÁN LẦN 1" cuối `manual-test.txt`.
- **Lệch so với kế hoạch:**
  1. **`backend/package-lock.json` (gate phụ, đã duyệt: «duyệt A»).** Chạy `ci.yml` trong container Linux phát hiện `npm ci` lỗi trên npm 11.19 (Node 24.22, bản mà `setup-node` với `"24"` cài): lockfile thiếu `@emnapi/core` và `@emnapi/runtime` mà `@napi-rs/wasm-runtime` (optional, dev) cần; npm 11.6 chấp nhận nên không ai thấy. Không sửa thì cả sáu job đỏ ngay lần chạy đầu. Commit `6ab5d4f` tạo lại lockfile (+28/−27 dòng: hai entry mới và bỏ cờ `"peer": true`, không đổi phiên bản gói nào); kiểm lại: `npm ci` exit 0 ở npm 11.6.2 (Windows) và 11.19.1 (Linux).
  2. **Agent đẩy commit thử lên PR (gate phụ, đã duyệt: «đồng ý»).** G2 giao M-35-04…10 cho chủ task tự chạy và agent không đẩy commit thử. Sau G4, chủ task mở PR #11 rồi đồng ý cho agent chạy M-35-05…09 qua `git push` và đọc kết quả bằng Claude in Chrome. Hậu quả: nhánh có thêm 6 commit thử và revert (`61c865f`, `9f4a307`, `0f0bf74`, `dfd1705`, `14dff24`, `52aec98`); squash merge sẽ gộp bỏ, cây làm việc cuối không còn file `ci-probe*`.
  3. Không có lệch nào khác: các bước 1, 2, 4, 5 làm đúng §7.
- **Bàn giao cho vai khác** (đã thêm vào [`docs/BACKLOG.md`](../BACKLOG.md)): **BL-012** (DBS-37: required checks, nguồn "GitHub Actions", cần lần chạy trước, `merge_group` nếu có merge queue); **BL-013** (#5: workflow deploy/quét đặt tên job khác, giữ ghim SHA); **BL-014** (chủ task DBS-35: bằng chứng trên Actions M-35-04…10 chưa có, và việc đóng thật của BL-001 phụ thuộc lần chạy `push main` đầu tiên).
- **Việc còn lại của chủ task trên GitHub:** chuyển PR sang Ready for review, nhờ một Dev khác review, merge (squash), rồi báo kết quả lần chạy `push main` đầu tiên (M-35-10; nếu hai PR merge sát nhau thì cả hai lần chạy phải còn nguyên) để đóng BL-014. Cài đặt Actions của repo đã ổn: Actions chạy được, hai action `actions/*` được phép.

## 9. Tài liệu đã cập nhật

- [CONTRIBUTING.md](../../CONTRIBUTING.md): mục mới 4b "Đọc kết quả CI trên GitHub Actions" (sáu job, lệnh chạy lại, cách đọc, quy tắc tên job); §4 "định nghĩa xong" có `test:db` và trỏ tới 4b.
- [README.md](../../README.md) và [backend/README.md](../../backend/README.md): lệnh trước khi mở PR có `test:db`, trỏ tới CONTRIBUTING 4b.
- [ci-cd concept brief](../components/ci-cd/01-concept-brief.md): thêm job test của CI, cập nhật dòng Status.
- [testing.md](../../.claude/skills/dbs-delivering-task/references/testing.md): xóa dòng "CI workflows … DBS-35" khỏi bảng "chưa xây".
- [docs/BACKLOG.md](../BACKLOG.md): **xóa BL-001** (CI đã có; việc đóng thật phụ thuộc lần chạy `push main` đầu tiên, theo dõi ở BL-014); **thêm BL-012, BL-013, BL-014**.
- [docs/features/README.md](README.md): thêm dòng DBS-35.
- Không đổi: ADR, schema, event contract, `ErrorCode`, biến môi trường của ứng dụng, docs/03. Các feature doc cũ (DBS-20, 21, 22) vẫn nhắc BL-001 như lịch sử, không sửa.
