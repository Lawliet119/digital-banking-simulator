# DBS-39 · Testcontainers: helper Postgres 17 chạy migration cho test

> **Status:** Plan approved (đợt sửa vòng 2 sau review xong, chờ G4; chuyển Implemented sau khi G4 được duyệt) · **Vai:** Dev · **Cặp đôi review:** Dev khác · **Nhánh:** `feat/DBS-39-testcontainers-postgres` · **PR:** — · **Cập nhật:** 2026-10-24

## 1. Bối cảnh

- **Task trên board:** Loại: Story, Tuần: 1, Deliverable/Demo: P4.
  - **Expect:** Test liên quan tới tiền chạy trên Postgres thật.
- **DoD:**
  1. devDependency testcontainers; `backend/test/support/postgres.container.ts` khởi tạo PostgreSQL 17 (timezone UTC) một lần mỗi lần chạy (globalSetup), chạy migration, cấp connection qua env, dọn khi xong
  2. Cách làm sạch dữ liệu giữa các test không phá bảng chỉ-thêm (truncate bằng role chủ bảng hoặc schema riêng) được ghi trong `backend/README`
  3. Test mẫu: chạy migration xong kiểm một ràng buộc (số dư khách âm bị từ chối) xanh ở local
  4. Docker không chạy thì test báo lỗi rõ ràng, không treo; khởi tạo container ≤ 60 giây
  5. PR đã merge vào main (CI xanh); Dev review; bảng «Đối chiếu test case» trong PR điền đủ
- **Phụ thuộc:**
  - `DBS-20` (Tuần 1): Done — Migration 1: `users`, `customers`, `accounts` và tài khoản `SYSTEM` funding đã có tại `src/database/migrations/1791763200000-CreateUsersCustomersAccounts.ts` (và `1791849600000-CreateTransfersLedgerIdempotency.ts`).
- **Đã có gì:**
  - `backend/test/support/temp-database.ts`: hàm `createTempDatabase()`, `migrate()`, `attempt()` cho phép tạo database ngẫu nhiên `dbs_test_<hex>` trên server `DATABASE_URL`.
  - `backend/test/jest-db.js`: Jest config cho `test/db/**/*.db-spec.ts`.
  - `backend/test/db/accounts-schema.db-spec.ts` & `ledger-schema.db-spec.ts`: test schema nhưng trước đây yêu cầu dev phải tự bật Docker Compose thủ công bên ngoài và export `DATABASE_URL`.
- **Ngoài phạm vi:**
  - Không thay đổi mã nguồn database migrations production.
  - Không sửa logic business hay mock DB trong `test:e2e` (e2e mock hiện có của DBS-18 giữ nguyên theo quy định).
- **Câu hỏi mở & Quyết định ở G1:**
  - *Quyết định:* Sử dụng `@testcontainers/postgresql` kết hợp Jest `globalSetup` và `globalTeardown` để khởi tạo 1 container duy nhất cho toàn bộ test run, sau đó mỗi test file tạo temp DB độc lập để tối ưu thời gian chạy.

### 1.1. Đợt sửa vòng 2 (sau review nhánh ở commit `b14691a`, 2026-10-24)

- **Nguồn:** review vòng 2 của người giữ repo trên `b14691a`. Vòng 1 (6 điểm chặn merge và tài liệu) đã được sửa trong `3e0b270` và `b14691a`; vòng 2 còn 5 điểm nhỏ.
- **Baseline trên `b14691a` (Docker Desktop bật, PostgreSQL 17 thật):** `lint:check` sạch · `typecheck` sạch · `npm test` 20 suite / 209 test xanh · `test:e2e` 4 suite / 25 test xanh · `test:db` 4 suite / 51 test xanh (lần 2). Lần chạy `test:db` đầu có `TC-21-11` (DBS-21, `created_at` so với `now()`) đỏ lệch ~1 giây rồi xanh khi chạy lại; nghi đồng hồ VM Docker vừa bật, chưa chứng minh. Đã sửa ở vòng 1 và còn đúng: spec nằm trong `jest-unit`, bỏ file env, README và doc khớp code.
- **Trạng thái so với `main`:** nhánh thiếu 2 commit của `main` (`#10`, `#11`). Thử merge chỉ xung đột `docs/BACKLOG.md` và `docs/features/README.md`; code không xung đột. `main` đã có `.github/workflows/ci.yml` cấp `DATABASE_URL` (Postgres 17 service), nên `globalSetup` đi nhánh `DATABASE_URL` có sẵn trong CI.
- **Phạm vi (G1 duyệt 2026-10-24):**
  1. Hạn tổng cho `start()` bao cả pull image; 60 giây vẫn là hạn cho Postgres sẵn sàng; `start()` bị bỏ dở thì dừng container (DoD #4).
  2. `globalSetup` là nơi duy nhất gán `DATABASE_URL`; `startPostgresContainer()` chỉ trả `{ databaseUrl }`, bỏ `container` và `stop()` không ai dùng (DoD #1).
  3. TC-39-04 ghi đúng mức: test handle giả chứng minh phần dọn dẹp, container thật dừng được chứng minh ở M-39-03.
  4. README nêu giới hạn của `BEGIN`/`ROLLBACK` (DoD #2).
  5. Test số dư âm (trùng DBS-20): giữ làm test khói, ghi rõ lý do (DoD #3).
  6. *(thêm sau domain review, **cần duyệt ở G2** vì ngoài danh sách G1)* Hạn riêng **15 giây** (`DOCKER_CHECK_TIMEOUT_MS`) cho bước kiểm tra Docker. Daemon nhận socket nhưng không trả lời (Docker Desktop đang khởi động) làm `assertDockerAvailable()` treo mà không hạn nào bao, trái DoD #4 "không treo" (TC-39-08).
- **Ngoài phạm vi:** merge hoặc rebase `main` vào nhánh; bộ chặn `DATABASE_URL` trỏ ra server không-local.
- **Bàn giao cho vai khác (vào `docs/BACKLOG.md` ở Phase 5):**

| Việc | Vai đề xuất | Bằng chứng | Điều kiện đóng |
|---|---|---|---|
| `TC-21-11` (`ledger-schema.db-spec.ts`) đỏ một lần, lệch ~1 giây giữa `created_at` và `now()`; nghi đồng hồ VM Docker, chưa chứng minh | Dev (DBS-21) | Lần chạy `test:db` đầu sau khi bật Docker Desktop ngày 2026-10-24; chạy lại xanh | Chạy `test:db` nhiều lần (kể cả ngay sau khi bật Docker) không còn đỏ, hoặc test dùng so sánh không phụ thuộc đồng hồ |
| CI trên `main` cấp `DATABASE_URL` (service `postgres:17`, không alpine), nên đường Testcontainers không chạy trong CI; DoD #5 "CI xanh" chỉ chứng minh test DB trên service, không chứng minh helper | #5 Platform & Ops (DBS-35) | `.github/workflows/ci.yml` job `db` trên `main` | Quyết định có thêm một job chạy `test:db` không có `DATABASE_URL` (đường Testcontainers) hay không |
| Vai superuser và role cho test | Dev (DBS-40, DBS-41) | `BL-001` | Theo task đó |
- **Quyết định ở G1 (2026-10-24):** hạn tổng **300 giây** · bỏ `container` và `stop()` khỏi `StartedPostgres` · không merge `main` vào nhánh · giữ test số dư âm và ghi lý do · commit nhỏ theo từng điểm, test viết trước.

## 2. Hành vi

### 2.1. Khởi động Container & Chạy Migration tự động (Global Setup)
- **Điều kiện:** Chạy lệnh `npm run test:db`.
- **Hành vi:**
  - Jest gọi `globalSetup` trong `backend/test/support/jest-global-setup.ts`.
  - `globalSetup` đã thấy `process.env.DATABASE_URL` (CI cấp Postgres service, hoặc dev tự export) thì dùng luôn, không khởi container.
  - Chưa có thì `startPostgresContainer()` kiểm tra Docker daemon (tối đa 15 giây, `DOCKER_CHECK_TIMEOUT_MS`) rồi khởi chạy container `postgres:17-alpine` với timezone `UTC` bằng flag `-c timezone=UTC` và biến môi trường `TZ=UTC`, và **chỉ trả** `{ databaseUrl }`; hàm này không đụng `process.env`.
  - `globalSetup` là nơi **duy nhất** gán `databaseUrl` vào `process.env.DATABASE_URL` trong tiến trình gốc của Jest; các test worker kế thừa biến này.
  - Mỗi test suite tự tạo cơ sở dữ liệu tạm thời riêng biệt (`createTempDatabase()`) và áp dụng migrations TypeORM (`migrate()`) độc lập trên database tạm đó.
  - Hai hạn thời gian, tách nhau:
    - **60 giây** (`STARTUP_TIMEOUT_MS`): Postgres trong container sẵn sàng, tính từ lúc container chạy (wait strategy của Testcontainers; thư viện không tính pull image vào đây). Đây là hạn của DoD #4.
    - **300 giây** (`OVERALL_START_TIMEOUT_MS`): cả `start()` gồm pull image Postgres, pull image Ryuk (`testcontainers/ryuk`, lần đầu) và tạo container. Quá hạn thì `globalSetup` ném lỗi: `[Testcontainers] PostgreSQL did not become ready within 300s (including the image pull of postgres:17-alpine). Check your network, or run `docker pull postgres:17-alpine` first and retry.`
  - Dọn container khi `globalSetup` ném lỗi (Jest không chạy `globalTeardown` trong trường hợp này, và `jest-cli` thoát ngay với mã 1):
    - **Đường chính là Ryuk** (reaper của Testcontainers, gắn nhãn phiên trước khi tạo container). Khi `TESTCONTAINERS_RYUK_DISABLED=true` thì không có đường này.
    - **Đường phụ**: `start()` bị bỏ dở vì quá hạn tổng mà sau đó vẫn hoàn tất thì container vừa tạo bị dừng ngay (`.then(c => c.stop()).catch(() => undefined)`, một lỗi `stop()` không làm rơi tiến trình). Đường này chỉ có cơ hội chạy khi tiến trình Jest còn sống.

### 2.2. Xử lý Fail-Fast khi Docker không chạy
- **Điều kiện:** Docker daemon không hoạt động hoặc không thể kết nối.
- **Hành vi:**
  - Bắt lỗi ngay trong `globalSetup` với thông điệp rõ ràng:
    `[Testcontainers] Docker is not running or unreachable. Please start Docker Desktop to run database tests.`
  - Ném ngoại lệ lập tức dừng test suite, không để Jest bị treo vô thời hạn (fail-fast trong vòng 5 giây khi daemon không có hoặc từ chối kết nối).
  - Daemon nhận socket nhưng không trả lời (Docker Desktop đang khởi động) thì bước kiểm tra bị cắt sau **15 giây** (`DOCKER_CHECK_TIMEOUT_MS`). Bước kiểm tra gọi `withTimeout(clientGetter(), DOCKER_CHECK_TIMEOUT_MS, 'Docker daemon did not respond within 15s')` bên trong `try` hiện có, nên lỗi cuối cùng là một thông điệp, bọc một lần: `[Testcontainers] Docker is not running or unreachable. Please start Docker Desktop to run database tests. Error details: Docker daemon did not respond within 15s`.

### 2.3. Cô lập và làm sạch dữ liệu (Data Isolation)
- **Quy tắc:**
  - Để đảm bảo tính toàn vẹn của bảng chỉ-thêm (`append-only ledger`) và sequence, các test suite không dùng lệnh `TRUNCATE` bừa bãi làm hỏng migration metadata hoặc schema constraints.
  - Sử dụng cơ chế `createTempDatabase()`: Mỗi test file khởi tạo một cơ sở dữ liệu tạm thời riêng (`dbs_test_<random_hex>`) từ PostgreSQL container dùng chung, chạy migration riêng cho DB đó, và xóa (`DROP DATABASE WITH (FORCE)`) khi suite hoàn tất (`afterAll`).
  - Ghi tài liệu chi tiết chiến lược này trong `backend/README.md`, kèm giới hạn: `BEGIN`/`ROLLBACK` giữa các test case chỉ đúng khi test dùng **một kết nối**. Test đồng thời (hai kết nối để thử khóa, `SELECT ... FOR UPDATE`) không thấy dữ liệu chưa commit của nhau, và `ROLLBACK` không dọn được dữ liệu đã commit ở kết nối khác; test loại đó dựa vào temp database riêng của spec.

### 2.4. Dọn dẹp tài nguyên (Global Teardown)
- **Điều kiện:** Toàn bộ test suite hoàn tất (hoặc fail).
- **Hành vi:**
  - Jest kích hoạt `globalTeardown` trong `backend/test/support/jest-global-teardown.ts`.
  - Gọi `stopPostgresContainer()`. Handle container chỉ nằm ở `globalThis.__POSTGRES_CONTAINER__` (bỏ biến module `activeContainer`).
  - Có handle (lần chạy này đã khởi container): dừng container, xóa handle và xóa `process.env.DATABASE_URL`, kể cả khi `stop()` ném lỗi.
  - Không có handle (`DATABASE_URL` đến từ ngoài: CI hoặc dev tự export): không làm gì và **không đụng** `process.env.DATABASE_URL`. Nhờ vậy mỗi lần chạy lại trong `--watch` vẫn dùng server ngoài, không lặng lẽ khởi container.
  - Đảm bảo container bị hủy bỏ hoàn toàn, không để rò rỉ tài nguyên trên máy host.

## 3. Kiến trúc

### 3.1. Vị trí & Files
- **Module:** Testing Infrastructure (`backend/test/`).
- **Files chính:**
  - `backend/test/support/postgres.container.ts`: Đóng gói logic Testcontainers, hàm `startPostgresContainer()` và `stopPostgresContainer()`, `withTimeout()`.
  - `backend/test/support/postgres.container.spec.ts`: Test đơn vị của helper (chạy trong `npm test`).
  - `backend/test/support/jest-global-setup.ts`: Hook `globalSetup` của Jest; nơi duy nhất gán `process.env.DATABASE_URL`.
  - `backend/test/support/jest-global.spec.ts`: Test đơn vị của `globalSetup` (mới ở đợt này).
  - `backend/test/support/jest-global-teardown.ts`: Hook `globalTeardown` của Jest.
  - `backend/test/jest-db.js`: Khai báo `globalSetup`, `globalTeardown`.
  - `backend/test/db/testcontainers-sample.db-spec.ts`: Test mẫu xác nhận ràng buộc số dư khách hàng không được âm.
  - `backend/README.md`: Hướng dẫn chạy test DB và giải thích chiến lược làm sạch dữ liệu.

### 3.2. Interface và chữ ký hàm
```typescript
// backend/test/support/postgres.container.ts
export const STARTUP_TIMEOUT_MS = 60_000; // Postgres sẵn sàng (wait strategy)
export const OVERALL_START_TIMEOUT_MS = 300_000; // cả start(), kể cả pull image
export const DOCKER_CHECK_TIMEOUT_MS = 15_000; // bước kiểm tra Docker daemon

export interface StartedPostgres {
  databaseUrl: string;
}

// Thuần: không đụng process.env. Handle container nằm ở globalThis.__POSTGRES_CONTAINER__ (duy nhất) cho teardown.
export async function startPostgresContainer(): Promise<StartedPostgres>;
export async function stopPostgresContainer(): Promise<void>;
export async function assertDockerAvailable(clientGetter?: () => Promise<unknown>): Promise<void>;
export function withTimeout<T>(work: Promise<T>, ms: number, message: string): Promise<T>;
```

`withTimeout` dùng `Promise.race` giữa `work` và một timer, và luôn `clearTimeout` ở `finally` để timer không giữ tiến trình Jest. `assertDockerAvailable` bọc việc gọi `clientGetter` trong `withTimeout(…, DOCKER_CHECK_TIMEOUT_MS, …)`. Trong `startPostgresContainer`, `start()` bị bỏ dở (quá hạn tổng) được gắn `.then(container => container.stop()).catch(() => undefined)` để container tạo muộn không bị bỏ rơi; chỉ gắn khi đã quá hạn, không gắn trong lần chạy bình thường. Handle trên `globalThis` chỉ được set sau khi `start()` hoàn tất **trong hạn**.

### 3.3. Sơ đồ Lifecycle

```mermaid
sequenceDiagram
    autonumber
    participant Jest as Jest CLI (npm run test:db)
    participant Setup as jest-global-setup
    participant TC as Testcontainers (Postgres 17)
    participant Worker as Jest Test Worker
    participant Teardown as jest-global-teardown

    Jest->>Setup: globalSetup()
    alt DATABASE_URL đã có (CI, dev tự export)
        Note over Setup: dùng luôn, không khởi container, không có handle
    else chưa có
        Setup->>TC: kiểm tra Docker (hạn 15s)
        Setup->>TC: startPostgresContainer(): postgres:17-alpine (TZ=UTC), hạn tổng 300s gồm pull image
        TC-->>Setup: Container Ready trong 60s (port mapped), trả { databaseUrl }
        Setup->>Worker: gán process.env.DATABASE_URL (duy nhất ở đây)
    end
    Jest->>Worker: Run *.db-spec.ts
    Worker->>TC: createTempDatabase() -> Run Migrations -> Test Queries -> drop()
    Worker-->>Jest: Test results
    Jest->>Teardown: globalTeardown()
    alt có handle trên globalThis
        Teardown->>TC: container.stop()
        TC-->>Teardown: Cleaned up (xóa handle và DATABASE_URL)
    else không có handle (DATABASE_URL từ ngoài)
        Note over Teardown: không làm gì, giữ nguyên DATABASE_URL
    end
```

## 4. Test cases tự động

| ID | Truy vết (DoD / AC) | Lớp | Given · When · Then | Mã lỗi / Kết quả mong đợi |
|---|---|---|---|---|
| TC-39-01 | DoD #1, #4 | db integration (+ unit ở TC-39-07) | Given Docker đang chạy · When `startPostgresContainer()` được gọi · Then container khởi động, timezone là UTC và trả về DATABASE_URL kết nối được. Cấu hình (`withStartupTimeout(60000)`, `TZ=UTC`, `-c timezone=UTC`, image `postgres:17-alpine`) được khẳng định ở TC-39-07; hạn 60 giây trên container thật được đo ở M-39-04 (khoảng cách giữa hai dòng log `Started container` và `Container is ready`) | Thành công, connection OK, `SHOW timezone` trả về `UTC` |
| TC-39-02 | DoD #3 | db constraint (test khói) | Given Postgres container đã khởi động và migrate DBS-20 xong · When thêm một tài khoản khách hàng (`CustomerAccount`) với số dư âm (`balance = -50000`) · Then PostgreSQL từ chối câu lệnh do vi phạm check constraint. Ràng buộc này DBS-20 (`accounts-schema.db-spec.ts`) đã kiểm; test này **cố ý trùng** vì DoD #3 đòi, và để chứng minh chuỗi Testcontainers → temp database → migration chạy được | Postgres error code `23514` (`accounts_balance_non_negative`) |
| TC-39-03 | DoD #4 | unit / harness | Given bộ lấy client Docker ném lỗi · When `assertDockerAvailable(getter)` chạy (trong `postgres.container.spec.ts`), và When `globalSetup` chạy với `getContainerRuntimeClient` giả bị reject và không có `DATABASE_URL` (trong `jest-global.spec.ts`) · Then cả hai ném lỗi rõ ràng chứa hướng dẫn bật Docker; ở `globalSetup`, `start()` của builder **không** được gọi | Error message chứa `Docker is not running` |
| TC-39-04 | DoD #1 | unit / harness (handle giả) | Mỗi test dọn `globalThis.__POSTGRES_CONTAINER__` và `process.env.DATABASE_URL` trong `afterEach`. Given handle giả `{ stop }` trên `globalThis` và `DATABASE_URL` đã set · When `stopPostgresContainer()` · Then `stop` được gọi đúng 1 lần, handle và `DATABASE_URL` bị xóa. Given `stop` ném lỗi · Then lỗi vẫn lan ra, nhưng handle và `DATABASE_URL` vẫn bị xóa. Given **không có handle** nhưng `DATABASE_URL` đã set (từ ngoài) · Then không ném lỗi và `DATABASE_URL` giữ nguyên | Thành công. Container **thật** dừng và không còn mồ côi: chứng minh ở M-39-03, không phải ở test này |
| TC-39-05 | DoD #2, #5 | Quy trình & Docs | Given yêu cầu tài liệu hoá · When dev đọc `backend/README.md` · Then có mục hướng dẫn data cleanup, nguyên tắc bảo vệ append-only ledger và giới hạn của `BEGIN`/`ROLLBACK` (chỉ một kết nối) | Quy trình |
| TC-39-06 | DoD #4 | unit / harness (fake timers, `jest.advanceTimersByTimeAsync`) | (a) Given `start()` của container giả không bao giờ hoàn tất · When `startPostgresContainer()` chạy và thời gian tiến 300 000 ms · Then reject với lỗi chứa `did not become ready within 300s` và `docker pull postgres:17-alpine`, handle `globalThis` không được set, `process.env.DATABASE_URL` không đổi. (b) Given `start()` hoàn tất **sau** hạn · Then `stop()` của container đó được gọi đúng 1 lần và handle vẫn không được set; `stop()` ném lỗi thì không có unhandled rejection. (c) Given `start()` hoàn tất **trong** hạn · Then `stop()` **không** được gọi, trả `{ databaseUrl }`, handle được set, và `jest.getTimerCount()` bằng 0 | Như từng ý |
| TC-39-07 | DoD #1, #4 | unit / harness (builder và `globalSetup` giả) | (a) Given `startPostgresContainer()` thành công · Then trả đúng `{ databaseUrl }` (không có `container`, `stop`), `process.env.DATABASE_URL` không đổi, và builder được gọi với image `postgres:17-alpine`, `withEnvironment({ TZ: 'UTC' })`, `withCommand(['postgres', '-c', 'timezone=UTC'])`, `withStartupTimeout(60000)`. (b) Given `globalSetup` mà `DATABASE_URL` chưa set (test tự `delete` trong `beforeEach`) · Then `start()` của builder được gọi đúng 1 lần và `process.env.DATABASE_URL` bằng URL trả về. (c) Given `DATABASE_URL` đã set (test tự set) · Then `start()` của builder không được gọi và biến giữ nguyên | Như từng ý |
| TC-39-08 | DoD #4 | unit / harness (fake timers) | Given bộ lấy client Docker không bao giờ resolve · When `assertDockerAvailable(getter)` chạy và thời gian tiến 15 000 ms · Then reject với lỗi khớp `/Docker is not running/` và `/within 15s/`, chỉ một tiền tố `[Testcontainers]`; getter resolve nhanh thì resolve và `jest.getTimerCount()` bằng 0 | Như trên |

**Mức mock cho các spec** (để các case ở trên làm được): `postgres.container.spec.ts` và `jest-global.spec.ts` cùng dùng `postgres.container` **thật** và chỉ mock hai thư viện: `jest.mock('testcontainers', () => ({ getContainerRuntimeClient: jest.fn() }))` và `jest.mock('@testcontainers/postgresql', …)` với builder chuỗi (`withEnvironment`, `withCommand`, `withStartupTimeout` trả về chính nó, `start` là `jest.fn()`). Nhờ vậy lời gọi `assertDockerAvailable` bên trong module vẫn bị chặn đúng chỗ, không cần `isolateModules`, và không test nào chạm Docker thật hay treo ở bước 15 giây. Mỗi spec tự set/xóa `process.env.DATABASE_URL` và `globalThis.__POSTGRES_CONTAINER__` trong `beforeEach` và `afterEach` (Jest base chỉ `clearMocks`, không reset biến môi trường).

## 5. Test thủ công

Kịch bản kiểm thử thủ công trực tiếp trên máy trạm:

| Bước | Việc làm (lệnh hoặc thao tác) | Kết quả mong đợi |
|---|---|---|
| M-39-01 | Bật Docker Desktop. Tại `backend/`, chạy `npm run test:db` | Testcontainer tự kéo image (nếu chưa có), khởi động Postgres 17, chạy toàn bộ test specs trong `test/db/`, tất cả test pass xanh (100%), container tự hủy khi xong. |
| M-39-02 | Tắt Docker Desktop (hoặc tạm dừng daemon; nếu máy đang chạy container dự án khác thì mô phỏng bằng `DOCKER_HOST=tcp://127.0.0.1:1`, làm Testcontainers không tới được daemon dù Docker thật vẫn chạy). Chạy `npm run test:db` | Jest dừng nhanh chóng (trong vòng 5s) và in thông báo lỗi rõ ràng yêu cầu bật Docker, không bị treo. |
| M-39-03 | Kiểm tra container còn sót lại bằng lệnh `docker ps` sau khi chạy xong | Không có container Postgres nào bị mồ côi (dangling/leaked). |
| M-39-04 | Pull lần đầu trong hạn tổng. Điều kiện đầu, kiểm từng cái: (1) `Remove-Item Env:DATABASE_URL -ErrorAction SilentlyContinue`, rồi `echo $env:DATABASE_URL` phải rỗng (nếu không, `globalSetup` bỏ qua container và không pull gì); (2) `docker compose down` ở thư mục gốc repo (service `postgres` của compose, container `dbs-postgres-1`, dùng đúng image này; `docker rmi` sẽ báo xung đột kể cả khi nó đã dừng); (3) `docker rmi postgres:17-alpine`, rồi `docker images postgres:17-alpine` phải rỗng. Sau đó tại `backend/` chạy `$env:DEBUG='testcontainers*'; $start = Get-Date; npm run test:db *> pull.log; (Get-Date) - $start` | Log `pull.log` có dòng pull image `postgres:17-alpine` (bằng chứng đã pull); `test:db` vẫn xanh (4 suite, 51 test); tổng thời gian (pull + khởi động + chạy test) < 300 giây; khoảng cách giữa dòng `Started container for image "postgres:17-alpine"` và dòng `Container is ready` **của cùng mã container** (không lấy dòng của container Ryuk) trong `pull.log` (đọc từ mốc thời gian của log) < 60 giây. Ghi cả hai số vào §8 |
| M-39-05 | Sau M-39-04 chạy `docker ps -a --filter label=org.testcontainers=true --filter ancestor=postgres:17-alpine` | Rỗng: không còn container Postgres nào do Testcontainers tạo (hai bộ lọc cùng áp dụng nên container compose không có nhãn, và container Ryuk khác image, đều không lẫn vào) |
| M-39-06 | `DATABASE_URL` từ ngoài trong **một tiến trình Jest chạy nhiều lượt** (chế độ watch chạy lại `globalSetup` và `globalTeardown` mỗi lượt). Cần một Postgres 17 đang chạy mà bạn biết mật khẩu: Postgres của `docker compose up -d` ở thư mục gốc repo nếu volume còn mật khẩu mặc định, hoặc một container tạm (`docker run -d -p 55433:5432 -e POSTGRES_USER=banking -e POSTGRES_PASSWORD=<mật khẩu> -e POSTGRES_DB=banking postgres:17-alpine`). Tại `backend/`: `$env:DATABASE_URL='postgres://banking:<mật khẩu>@localhost:<cổng>/banking'; $env:DEBUG='testcontainers*'; npm run test:db -- --watchAll`; chờ lượt 1 xong, kích lượt 2 bằng cách nhấn Enter, hoặc (shell không tương tác) `touch test/db/testcontainers-sample.db-spec.ts`; rồi dừng tiến trình | Cả hai lượt xanh và toàn bộ đầu ra của cả hai lượt không có dòng `Creating new Reaper` hay `Starting container` (không lượt nào khởi container). Nếu `stopPostgresContainer()` xóa `DATABASE_URL` khi không có handle thì lượt 2 sẽ khởi container và bước này đỏ |

Điều kiện chạy: Node >= 24, Docker Desktop (WSL2/Hyper-V).

Những gì không chạy tay được và cách phủ:
- Nhánh quá hạn tổng 300 giây (TC-39-06) và nhánh daemon không trả lời quá 15 giây (TC-39-08) không dựng được trên máy thật mà không thêm biến môi trường; chúng được phủ bằng test đơn vị với fake timers. M-39-04 chứng minh trường hợp pull thật vẫn nằm trong hạn.
- CI trên `main` cấp `DATABASE_URL` (service `postgres:17`), nên đường Testcontainers không chạy trong CI; chỉ M-39-01, M-39-04 trên máy dev chứng minh nó (M-39-06 chứng minh đường ngược lại, `DATABASE_URL` từ ngoài) (xem hàng bàn giao DBS-35 ở §1.1). DoD #5 "CI xanh" vì vậy chỉ phủ test DB trên service, không phủ helper.

## 6. Domain review (AI)

**Reviewer:** subagent / Senior Core Banking Reviewer, 2026-10-19 · **Kết quả:** 3 phát hiện (blocking 0, should-fix 2, minor 1), verdict `APPROVE` · [trả lời nguyên văn](screenshots/DBS-39/domain-review.md)

| # | Mức | Phát hiện | Xử lý |
|---|---|---|---|
| 1 | should-fix | Kiểm tra truyền biến môi trường sang test workers. | Jest tự động kế thừa `process.env.DATABASE_URL` từ `globalSetup` sang worker processes. Đã bỏ file tạm để tránh lộ thông tin và lỗi connection cũ. |
| 2 | should-fix | Cần đảm bảo server Postgres nhận cờ `-c timezone=UTC`. | Đã sửa §2.1: truyền cờ `-c timezone=UTC` vào command khởi động container. |
| 3 | minor | Nêu rõ tên check constraint `accounts_balance_non_negative` trong TC-39-02. | Đã ghi rõ tên constraint trong bảng test cases §4. |

### Đợt sửa vòng 2 (2026-10-24)

**Reviewer:** subagent Opus (effort medium), vòng 1 của đợt này · **Kết quả:** 11 phát hiện (blocking 0, should-fix 6, minor 5), `Verdict: REVISE` · [trả lời nguyên văn](screenshots/DBS-39/domain-review.md) (khối thứ hai)

| # | Mức | Phát hiện (tóm tắt) | Xử lý |
|---|---|---|---|
| 1 | should-fix | M-39-04 có thể xanh mà không pull gì: `DATABASE_URL` trong shell làm `globalSetup` bỏ qua container; `docker rmi` lỗi vì container compose `db` dùng cùng image; Jest không in việc pull; `--filter ancestor` lẫn container compose. | Đã sửa §5: thêm điều kiện đầu (xóa biến, `docker compose down`, `docker rmi`, `docker images` rỗng), bật `DEBUG=testcontainers*` và ghi `pull.log`, M-39-05 lọc theo nhãn `org.testcontainers=true`. Thêm M-39-06 cho đường `DATABASE_URL` từ ngoài. |
| 2 | should-fix | Bước kiểm tra Docker không có hạn: daemon nhận socket mà không trả lời làm `globalSetup` treo, trái DoD #4. | Đã sửa: hạn 15 giây `DOCKER_CHECK_TIMEOUT_MS` (§1.1 mục 6, §2.1, §2.2, §3.2, TC-39-08). Là mục ngoài danh sách G1, **hỏi ở G2**. |
| 3 | should-fix | `activeContainer` (biến module) và handle `globalThis` cùng tồn tại; TC-39-04 và TC-39-07 trong cùng spec phụ thuộc nhau. | Đã sửa §2.4, §3.2: bỏ `activeContainer`, `globalThis` là handle duy nhất; TC-39-04 dọn `globalThis` và `DATABASE_URL` trong `afterEach`. |
| 4 | should-fix | `stopPostgresContainer()` xóa `DATABASE_URL` cả khi URL đến từ ngoài; lần chạy lại trong `--watch` lặng lẽ khởi container. | Đã sửa §2.4, TC-39-04: chỉ xóa khi có handle; thêm case "không handle, `DATABASE_URL` từ ngoài, giữ nguyên"; thêm M-39-06. |
| 5 | should-fix | TC-39-06 thiếu: `stop()` không được gọi khi `start()` xong trong hạn; handle không set khi xong muộn; không có cách quan sát timer. | Đã sửa TC-39-06 (a)(b)(c): dùng `advanceTimersByTimeAsync` và `jest.getTimerCount()`. |
| 6 | should-fix | Không test nào khẳng định hạn 60 giây và UTC; CI không chạy đường Testcontainers. | Đã sửa TC-39-07(a): khẳng định `withStartupTimeout(60000)`, `TZ=UTC`, `-c timezone=UTC`, image. §5 và §1.1 nói rõ CI không phủ đường này, ghi bàn giao DBS-35. |
| 7 | minor | Chưa nêu pull Ryuk tính vào hạn 300 giây và Ryuk tắt thì không có đường dọn chính. | Đã sửa §2.1. |
| 8 | minor | `.then(stop, noop)` để rớt `stop()` bị từ chối; đường dọn thực tế chủ yếu là Ryuk. | Đã sửa §2.1, §3.2: `.then(c => c.stop()).catch(() => undefined)`, Ryuk là đường chính. |
| 9 | minor | TC-39-03 nói `globalSetup` nhưng test gọi thẳng `assertDockerAvailable`. | Đã sửa TC-39-03: thêm case `globalSetup` với Docker check bị reject. |
| 10 | minor | Sơ đồ luôn có `container.stop()` kể cả đường `DATABASE_URL` từ ngoài. | Đã sửa §3.3: thêm hai nhánh `alt`. |
| 11 | minor | Việc bàn giao (TC-21-11, DBS-35, DBS-40/41) chưa có chủ, bằng chứng; §8 còn câu "chưa có CI". | Đã sửa §1.1: bảng bàn giao. Câu cũ ở §8 sẽ sửa khi viết lại §8 (Phase 5). |

**Reviewer:** subagent Opus (effort medium), vòng 2 của đợt này (kiểm tra lại các sửa) · **Kết quả:** 6 phát hiện (blocking 0, should-fix 3, minor 3), `Verdict: REVISE` · [trả lời nguyên văn](screenshots/DBS-39/domain-review.md) (khối thứ ba)

| # | Mức | Phát hiện (tóm tắt) | Xử lý |
|---|---|---|---|
| 1 | should-fix | M-39-06 không bắt được lỗi nó sinh ra để bắt: mỗi `npm run test:db` là một tiến trình, nên xóa biến trong teardown không đổi biến ở PowerShell; lỗi chỉ lộ khi `globalSetup`/`globalTeardown` chạy lại trong cùng một tiến trình Jest (watch). | Đã sửa M-39-06: chạy `--watchAll`, hai lượt trong một tiến trình, kết quả mong đợi là đầu ra không có `Creating new Reaper` / `Starting container`; nêu rõ khi nào bước đỏ. |
| 2 | should-fix | Bộ lọc `label=org.testcontainers=true` cũng khớp container Ryuk (còn sống đến khi hết thời gian kết nối lại). | Đã sửa M-39-05: thêm `--filter ancestor=postgres:17-alpine`; hai bộ lọc cùng áp dụng. |
| 3 | should-fix | TC-39-01 nói đo hạn 60 giây ở M-39-01 và M-39-04 nhưng hai bước không đo. | Đã sửa M-39-04: đo khoảng cách giữa `Started container` và `Container is ready` trong `pull.log`, ghi vào §8; TC-39-01 trỏ vào M-39-04. |
| 4 | minor | Không thể mock `assertDockerAvailable` từ ngoài module; `startPostgresContainer` không có điểm tiêm; spec cần khôi phục `DATABASE_URL`. | Đã sửa §4: đoạn "Mức mock cho các spec" (mock `testcontainers` và `@testcontainers/postgresql`, dùng module thật), TC-39-03 và TC-39-07 tự set/xóa biến; case `globalSetup` khẳng định `start()` của builder không được gọi. |
| 5 | minor | Thông điệp 15 giây chưa viết ra; TC-39-08 kiểm chữ tiếng Việt trong thông điệp tiếng Anh; có thể lặp tiền tố. | Đã sửa §2.2: viết nguyên văn, bọc một lần bởi `catch` hiện có; TC-39-08 kiểm `/Docker is not running/` và `/within 15s/`. |
| 6 | minor | Service compose tên `postgres` (project `dbs`), không phải `db`; `Remove-Item Env:` báo lỗi khi biến chưa set. | Đã sửa M-39-04, §6: `postgres` / `dbs-postgres-1`, thêm `-ErrorAction SilentlyContinue`. Ghi chú: hàng tóm tắt ở §6 đợt này còn nhắc "container `db`" ở phát hiện 1 của vòng 1; đó là mô tả phát hiện gốc, giữ nguyên. |

**Chưa review lại các sửa của vòng 2 này** (xem câu hỏi ở G2). Cả hai vòng của đợt này không còn blocking; phát hiện đã dịch chuyển từ thiết kế sang cách mock và kịch bản test thủ công.

**Quyết định ở G2 (2026-10-24):** Duyệt thiết kế §1.1–§5. Không chạy vòng review thứ 3 (hai vòng không còn blocking; các sửa vòng 2 chủ yếu là chữ và sẽ lộ ra khi viết test). Duyệt mục thứ 6 ngoài danh sách G1: hạn 15 giây cho bước kiểm tra Docker. Đồng ý bàn giao 3 việc sang vai khác (`TC-21-11`, đường Testcontainers không chạy trong CI, vai superuser/role). Giữ Docker Desktop chạy đến hết Phase 4c.

## 7. Kế hoạch triển khai

Thứ tự: test viết trước → chạy thấy đỏ → code ít nhất để xanh → commit. Mọi lệnh chạy từ `backend/`. Cột "Kết quả đỏ" điền khi chạy (Phase 4). Mỗi commit kết thúc bằng dòng `Co-Authored-By` theo môi trường; không `--no-verify`; không push (người giữ repo tự push).

| Bước | File | Test viết trước | Kết quả đỏ (1 dòng, điền khi chạy) | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 | `test/support/postgres.container.ts`, `test/support/postgres.container.spec.ts` | TC-39-04 viết lại: handle giả trên `globalThis`, `afterEach` dọn `globalThis` và `DATABASE_URL`; thêm case `stop` ném lỗi vẫn dọn, case không handle thì giữ `DATABASE_URL` từ ngoài. Code: bỏ biến module `activeContainer`, chỉ xóa `DATABASE_URL` khi có handle | `Expected: "postgresql://ci:ci@db.example:5432/banking"` / `Received: undefined` (hàm xóa `DATABASE_URL` từ ngoài) | `npx jest --config ./test/jest-unit.js test/support/postgres.container.spec.ts` | `fix(test): stopPostgresContainer chỉ dọn DATABASE_URL khi có handle` |
| 2 | `test/support/postgres.container.ts`, `test/support/postgres.container.spec.ts` | TC-39-08 (fake timers: getter không resolve, tiến 15 000 ms, lỗi khớp `/Docker is not running/` và `/within 15s/`, một tiền tố, `getTimerCount() === 0`) và TC-39-03 phần `assertDockerAvailable`. Code: `DOCKER_CHECK_TIMEOUT_MS`, `withTimeout`, `assertDockerAvailable` dùng `withTimeout` | `TS2305: Module './postgres.container' has no exported member 'DOCKER_CHECK_TIMEOUT_MS'` | cùng lệnh bước 1 | `fix(test): giới hạn 15 giây cho bước kiểm tra Docker` |
| 3 | `test/support/postgres.container.ts`, `test/support/postgres.container.spec.ts` | Mock `testcontainers` và `@testcontainers/postgresql` (builder chuỗi) như §4. TC-39-06 (a)(b)(c) và TC-39-07(a): quá 300 000 ms reject đúng thông điệp, `start()` xong muộn thì `stop()` đúng 1 lần, xong trong hạn thì `stop()` không được gọi và `getTimerCount() === 0`, `startPostgresContainer()` trả đúng `{ databaseUrl }`, không đụng `process.env`, builder nhận `postgres:17-alpine`, `TZ=UTC`, `-c timezone=UTC`, `withStartupTimeout(60000)`. Code: `OVERALL_START_TIMEOUT_MS`, bao `start()` bằng `withTimeout`, `.then(c => c.stop()).catch(...)` chỉ khi quá hạn, bỏ `container`/`stop()` khỏi `StartedPostgres`, bỏ dòng gán `process.env` | `TS2305 ... no exported member 'OVERALL_START_TIMEOUT_MS'`; sau khi thêm riêng hằng số: 4 test đỏ, TC-39-07(a) `toStrictEqual` thừa `container`/`stop`, TC-39-06(a)(b)(b') `Exceeded timeout of 5000 ms` | cùng lệnh bước 1 | `fix(test): hạn tổng 300 giây cho khởi động container, helper thuần` |
| 4 | `test/support/jest-global-setup.ts`, `test/support/jest-global.spec.ts` (mới) | TC-39-03 (phần `globalSetup`: `getContainerRuntimeClient` giả bị reject, `start()` của builder không được gọi) và TC-39-07(b)(c) (đúng 1 lần `start()` khi chưa có `DATABASE_URL`, biến bằng URL trả về; có sẵn thì không gọi `start()`, biến giữ nguyên). Test này khóa hành vi ngay sau bước 3 nên có thể không đỏ tự nhiên: chứng minh đỏ bằng cách tạm bỏ dòng gán trong `globalSetup`, thấy đỏ, rồi hoàn lại. Code: `globalSetup` dùng kết quả `{ databaseUrl }`, bỏ comment "Also assign" | không đỏ tự nhiên (hành vi đã đúng sau bước 3); đột biến bỏ dòng gán: TC-39-07(b) `Expected: "postgres://test:test@localhost:55432/test"` / `Received: undefined` | `npx jest --config ./test/jest-unit.js test/support` | `test(db): khóa hành vi globalSetup gán DATABASE_URL một lần` |
| 5 | `backend/README.md` | TC-39-05 (quy trình, không có test tự động): kiểm bằng `grep` có đoạn giới hạn `BEGIN`/`ROLLBACK` (một kết nối) và không còn `TRUNCATE ... journal_entries` | không có (tài liệu) | `grep -n "một kết nối\|một connection" README.md` và `grep -n "journal_entries" README.md` (rỗng) | `docs(backend): nêu giới hạn BEGIN/ROLLBACK khi cô lập dữ liệu test` |
| 6 | `test/db/testcontainers-sample.db-spec.ts` | TC-39-02: không đổi hành vi, chỉ thêm comment nói test cố ý trùng DBS-20, là test khói cho chuỗi Testcontainers → temp database → migration (DoD #3). Không có test mới | không có (comment) | `npm run test:db -- test/db/testcontainers-sample.db-spec.ts` | `docs(test): ghi lý do test số dư âm của DBS-39 trùng DBS-20` |
| 7 | — | Chạy bộ kiểm tra tự động trên commit code cuối: `lint:check`, `typecheck`, `npm test` (kỳ vọng 21 suite: 20 hiện có + `jest-global.spec.ts`; số test ghi lại thật), `test:e2e` (4 suite, 25 test), `test:db` (4 suite, 51 test) | — | các lệnh trên | không có commit |
| 8 | `docs/features/screenshots/DBS-39/manual-test.txt` (và ảnh) | Chạy **toàn bộ** §5 (M-39-01…06) trên commit code cuối; dòng đầu là SHA của commit cuối đổi code; ghi output thô; chụp ảnh | — | M-39-01…06 | `docs(features): bằng chứng test thủ công DBS-39 đợt sửa vòng 2` |
| 9 | `docs/features/DBS-39-testcontainers-postgres.md`, `docs/BACKLOG.md`, `docs/features/README.md` | Viết §8, §9; thêm hàng `BL-NNN` cho 3 hàng bàn giao ở §1.1 (`TC-21-11`, đường Testcontainers không chạy trong CI, vai superuser/role) và sửa `BL-001` cho đúng (CI đã có trên `main`); chạy `check-doc-links.mjs` | — | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `docs(features): DBS-39 kết quả, bàn giao và backlog đợt sửa vòng 2` |

### Quét theo DoD và giới hạn nêu trong docs

| Nguồn | Hàng kế hoạch / ngoài phạm vi |
|---|---|
| DoD #1 (devDependency, `postgres.container.ts`, một lần mỗi lần chạy, cấp qua env, dọn khi xong) | Bước 1, 3, 4; bằng chứng thật M-39-01, M-39-03 |
| DoD #2 (README về làm sạch dữ liệu) | Bước 5 |
| DoD #3 (test mẫu số dư âm xanh) | Bước 6, 7 (`test:db`) |
| DoD #4 (Docker không chạy thì báo rõ, không treo; ≤ 60 giây) | Bước 2, 3; M-39-02, M-39-04 |
| DoD #5 (merge, CI xanh, Dev review, bảng đối chiếu) | Quy trình: người giữ repo tự push; bảng đối chiếu ở §8; hạn chế "CI không chạy đường Testcontainers" thành hàng bàn giao ở bước 9 |
| `backend/README.md` §5 (test DB trên Postgres thật) | Bước 5 |
| Giới hạn ghi ở §5 ("không chạy tay được") | TC-39-06, TC-39-08 phủ bằng fake timers (bước 2, 3) |
| Hàng `BL-001` ở `docs/BACKLOG.md` | Bước 9 |
| `TC-21-11`, vai superuser/role, merge `main` vào nhánh, bộ chặn `DATABASE_URL` không-local | Bàn giao (bước 9) hoặc ngoài phạm vi (§1.1) |

### Rủi ro và cách lùi

- **Rủi ro:** fake timers kết hợp `Promise.race` và mock builder dễ làm test treo hoặc rò timer. *Cách xử lý:* mock đủ ở hai thư viện như §4, dùng `jest.advanceTimersByTimeAsync`, kiểm `jest.getTimerCount() === 0` trong mỗi case, và chạy từng spec riêng trước khi chạy cả bộ.
- **Rủi ro:** M-39-04 làm mất image `postgres:17-alpine` cục bộ và cần mạng; M-39-06 dùng chế độ watch (tương tác). *Cách xử lý:* chạy sau cùng, ghi rõ trong `manual-test.txt`; bước nào không chạy được thì ghi **chưa chạy** kèm lý do, không ghi "đạt".
- **Rủi ro:** thêm `jest-global.spec.ts` làm số suite của `npm test` tăng; con số cũ trong doc (20) lệch. *Cách xử lý:* ghi số đo thật ở §8.
- **Cách lùi:** mỗi bước là một commit riêng; `git revert <sha>` từng bước. Bước 1–4 chỉ đổi file test hỗ trợ và `postgres.container.ts`, không đụng code production hay migration. Nếu hạn tổng gây lỗi trên máy khác, revert bước 3 đưa lại hành vi `b14691a`.

**Quyết định ở G3 (2026-10-24):** Duyệt kế hoạch 9 bước. Chấp nhận bước 4 chứng minh đỏ bằng cách tạm bỏ dòng gán; số suite `npm test` từ 20 lên 21 và ghi theo số đo thật; M-39-04 và M-39-06 chạy sau cùng, bước nào không chạy được thì ghi chưa chạy; mình commit từng bước, không push trước G4 (sau G4 mới push theo yêu cầu của người giữ repo).

## 8. Kết quả

### 8.1. Đợt sửa vòng 2 (2026-10-24)

- **Commit code và tài liệu của đợt này** (trên `b14691a`, chưa push): `400e3aa` bước 1 · `ee1beef` bước 2 · `0b9fca1` bước 3 · `b88c317` bước 4 · `8f903e4` bước 5 · `d8e264a` bước 6 (commit cuối đổi code) · hai commit docs thiết kế và kế hoạch (`6591087`, `eddcce1`), và các commit bằng chứng/kết quả ở cuối.
- **Lệnh kiểm tra** (trên `d8e264a`, Docker Desktop 27.3.1, không set `DATABASE_URL`):
  - `npm run lint:check`: sạch, 0 lỗi.
  - `npm run typecheck`: sạch, 0 lỗi.
  - `npm test`: **21 suite, 219 test** xanh (trước đợt này: 20 suite, 209 test; thêm `jest-global.spec.ts` (3 test) và 7 test trong `postgres.container.spec.ts`).
  - `npm run test:e2e`: 4 suite, 25 test xanh.
  - `npm run test:db`: 4 suite, 51 test xanh, 17,9 đến 19,7 giây trên PostgreSQL 17 Testcontainers.
  - Không có `.skip`, `.only`, `.todo` trong test của task (đã `grep`); số test bị bỏ qua: 0.
- **Kiểm đột biến** (test có thật sự bắt lỗi): bỏ `.catch(() => undefined)` ở nhánh dừng container muộn → TC-39-06(b) "failing late stop" đỏ; bỏ dòng gán `DATABASE_URL` trong `globalSetup` → TC-39-07(b) đỏ; đưa lại dòng `delete process.env.DATABASE_URL` khi không có handle → M-39-06 thấy lượt 2 khởi Ryuk và Postgres. Cả ba đã hoàn lại, không commit.

### 8.2. Đối chiếu test case

| ID | Test | Đạt? |
|---|---|---|
| TC-39-01 | `test/db/testcontainers-sample.db-spec.ts` › TC-39-01 UTC (`SHOW timezone`); `postgres.container.spec.ts` › TC-39-07(a) (image, `TZ=UTC`, `-c timezone=UTC`, `withStartupTimeout(60000)`); hạn 60 giây trên container thật đo ở M-39-04: Postgres sẵn sàng sau 1,24 giây | đạt |
| TC-39-02 | `test/db/testcontainers-sample.db-spec.ts` › TC-39-02 (code `23514`, `accounts_balance_non_negative`); không đổi hành vi, thêm comment lý do trùng DBS-20 | đạt |
| TC-39-03 | `postgres.container.spec.ts` › TC-39-03 (`assertDockerAvailable`, hai test); `jest-global.spec.ts` › TC-39-03 (`globalSetup` với Docker không tới được, `start()` không được gọi) | đạt |
| TC-39-04 | `postgres.container.spec.ts` › `stopPostgresContainer (TC-39-04)`: dừng đúng 1 lần và xóa handle + `DATABASE_URL`; `stop()` lỗi vẫn dọn và báo lỗi; không handle thì giữ `DATABASE_URL` từ ngoài. Dùng handle giả: container thật dừng được chứng minh ở M-39-03 | đạt (phần dọn dẹp) |
| TC-39-05 | `backend/README.md` › mục "Cách làm sạch và cô lập dữ liệu khi kiểm thử": thêm giới hạn "chỉ đúng khi test dùng một kết nối"; không còn `TRUNCATE`/`journal_entries` (`grep` rỗng) | đạt (quy trình) |
| TC-39-06 | `postgres.container.spec.ts` › TC-39-06(a) quá 300 giây reject đúng thông điệp; TC-39-06(b) container xong muộn bị dừng đúng 1 lần, và `stop()` lỗi không gây unhandled rejection; TC-39-06(c) xong trong hạn không `stop()` và `getTimerCount() === 0` | đạt |
| TC-39-07 | (a) `postgres.container.spec.ts` › TC-39-07(a); (b)(c) `jest-global.spec.ts` › TC-39-07(b), TC-39-07(c) | đạt |
| TC-39-08 | `postgres.container.spec.ts` › `assertDockerAvailable timeout (TC-39-08)` (hai test: cắt sau 15 giây, một tiền tố, không còn timer; trả lời nhanh thì không còn timer) | đạt |

Dòng "kết quả đỏ" của từng bước đã điền ở bảng §7. Riêng bước 4 không đỏ tự nhiên (hành vi đã đúng sau bước 3), đã chứng minh bằng đột biến như đã được duyệt ở G3.

### 8.3. Test thủ công

Chạy trên `d8e264a` (dòng đầu của [manual-test.txt](screenshots/DBS-39/manual-test.txt)); output đã lọc ANSI và rút gọn log DEBUG, mật khẩu của Postgres tạm đã ẩn.

| Bước | Kết quả |
|---|---|
| M-39-01 | **đạt**: `npm run test:db` khi Docker bật, không có `DATABASE_URL`: 4 suite, 51 test, 19,7 giây, container tự khởi động và tự hủy |
| M-39-02 | **đạt (mô phỏng)**: dùng `DOCKER_HOST=tcp://127.0.0.1:1` vì Docker Desktop đang chạy container của các dự án khác nên không tắt; Jest dừng sau 3,9 giây với thông báo bật Docker, không treo. **Chưa chạy với Docker Desktop thật sự tắt**: cần bạn chấp nhận mô phỏng này ở G4 |
| M-39-03 | **đạt**: sau M-39-01 và M-39-02 không còn container Testcontainers nào |
| M-39-04 | **đạt**: sau `docker compose down` và `docker rmi`, image được pull lại (17,2 giây), Postgres sẵn sàng sau 1,24 giây (hạn 60 giây), tổng 43,1 giây (hạn 300 giây), 4 suite / 51 test xanh |
| M-39-05 | **đạt**: không còn container Postgres nào (lọc theo nhãn và image); container Ryuk còn sống một lúc, đúng như §5 dự đoán |
| M-39-06 | **đạt** ở lần chạy thứ hai: hai lượt trong một tiến trình Jest, mỗi lượt 51/51, không có dòng `Starting container` / `Creating new Reaper`. Lần thử đầu dùng Postgres của compose bị hủy vì volume cũ có mật khẩu khác (lỗi môi trường, không phải lỗi code); đã thay bằng Postgres tạm và xóa sau khi xong. Với bản lỗi tạm đưa lại, lượt 2 khởi container, nên bước này phân biệt được hai bản |

- **Ảnh chụp màn hình:** không chụp. Output thô của cả sáu bước nằm ở `manual-test.txt`; cần bạn chấp nhận việc thiếu ảnh theo từng bước ở G4.

### 8.4. Lệch so với kế hoạch và so với thiết kế đã duyệt

- Phạm vi file khớp §7. Bước 5: lệnh `grep` chứng minh trong §7 dùng cụm "một kết nối" nhưng cụm này đã có ở dòng khác của README; bằng chứng thực tế là dòng "Giới hạn" mới ở mục cô lập dữ liệu (xem commit `8f903e4`).
- Ba chỗ của §5 được sửa chữ khi chạy thật (hành vi test không đổi, cần bạn biết vì §5 là thiết kế đã duyệt ở G2): M-39-02 thêm cách mô phỏng bằng `DOCKER_HOST` giả; M-39-04 yêu cầu lấy hai dòng log của **cùng mã container** (dòng `Container is ready` đầu tiên là của Ryuk); M-39-06 cho phép dùng Postgres tạm vì mật khẩu mặc định của compose không đảm bảo đúng với volume cũ, và kích lượt 2 bằng `touch` khi shell không tương tác. Đây là chỉnh sửa tài liệu, không đổi phạm vi code.
- Không có thay đổi nào ngoài danh sách file của §7 và không có test case bị bỏ.

### 8.5. Bàn giao cho vai khác

| ID | Việc | Vai đề xuất |
|---|---|---|
| `BL-015` | `TC-21-11` (DBS-21) đỏ một lần, lệch ~1 giây giữa `created_at` và `now()`, chạy lại xanh | Dev (DBS-21) |
| `BL-016` | CI trên `main` cấp `DATABASE_URL` nên đường Testcontainers không chạy trong CI; DoD #5 "CI xanh" chỉ phủ test DB trên service | #5 Platform & Ops (DBS-35) |
| `BL-017` | Test DB chạy bằng superuser (Testcontainers và service CI) nên chưa chứng minh quyền của role ứng dụng; liên quan `BL-005` | Dev (DBS-40, DBS-41) |

- **Lưu ý khi merge `main`:** `main` đã xóa hàng `BL-001` (DBS-35 làm xong CI) và đã dùng `BL-010` đến `BL-014`; vì vậy ba hàng trên lấy ID từ `BL-015`. Hàng `BL-001` trên nhánh này (có DBS-39 làm nguồn) sẽ xung đột với `main` khi merge; cách giải đúng là bỏ hàng đó như `main`.

## 9. Tài liệu đã cập nhật

- `backend/README.md`: nêu giới hạn của `BEGIN`/`ROLLBACK` (chỉ một kết nối) ở mục cô lập dữ liệu.
- `docs/BACKLOG.md`: thêm `BL-015`, `BL-016`, `BL-017`. Không xóa hàng nào (không hàng nào do task này giải quyết); `BL-001` giữ nguyên trên nhánh này vì `main` đã xử lý.
- `docs/features/DBS-39-testcontainers-postgres.md`: viết lại §1.1, §2–§8; thêm TC-39-06…08 và M-39-04…06.
- `docs/features/screenshots/DBS-39/domain-review.md`: thêm hai khối trả lời nguyên văn của reviewer (đợt sửa vòng 2).
- `docs/features/screenshots/DBS-39/manual-test.txt`: thay bằng bằng chứng của lần chạy trên `d8e264a`.
- `docs/features/README.md`: không đổi (hàng DBS-39 đã có).
