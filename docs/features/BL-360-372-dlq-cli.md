# BL-360 + BL-372 · CLI DLQ: file quarantine không ghi đè, lệnh `dlq:resend`

> **Status:** Implemented (sau G4) · **Vai:** Dev (chủ outbox/messaging) · **Cặp đôi review:** Dev khác · **Nhánh:** `feat/BL-360-372-dlq-cli` · **PR:** [#215](https://github.com/Lawliet119/digital-banking-simulator/pull/215) · **Cập nhật:** 2026-11-20

## 1. Bối cảnh

- **Task trên board:** không có. Hai dòng `docs/BACKLOG.md` (mục Dev) mà các task trên board đã giao hết (DBS-171, 172, 185 đã merge ở #139, #140, #200; DBS-141 là việc quy trình): **BL-360** (từ [DBS-164](DBS-164-dlq-runbook-dev-trial.md) §6) và **BL-372** (từ [DBS-183](DBS-183-async-incident-scenarios.md) §2, §8). **Mã task:** không có mã board và đây không phải bug, nên dùng `BL-360-372` thay cho `DBS-<n>`; mã case là `TC-BL-NN` và `M-BL-NN`.
- **Đóng khi (chép nguyên văn từ BACKLOG):**
  1. BL-360: «CLI mở file chế độ exclusive (`wx`), thoát 2 và không xóa gì nếu file đã có, tạo thư mục cha; có test mới trong `dlq-age-check.spec.ts`».
  2. BL-372: «Có lệnh `dlq:resend` (hoặc mở rộng `dlq:age-check`) có test; runbook trỏ tới nó». Nội dung dòng: gửi lại an toàn message DLQ kèm `OriginalSentTimestamp` (copy body và thuộc tính, xóa bản DLQ theo handle, ghi `eventId`).
- **Phụ thuộc:** [BL-210](../runbooks/dlq-redrive.md) (`dlq:age-check`, `OriginalSentTimestamp` trong `libs/sqs`) có trên `main`; ElasticMQ trong `docker-compose.yml` cho test dịch vụ.
- **Đã có gì:** `backend/src/scripts/dlq-age-check.ts` (quét DLQ, `DlqPort`, `awsDlqPort`, `ageOf`); `libs/sqs/sqs.client.ts` (`ORIGINAL_SENT_TIMESTAMP`, `originalSentTimestampOf`); pha `resend` bằng bash ở `infra/scripts/incident-cloud.sh` (đã chạy thật trên AWS 2026-11-15, 28 `eventId`, không có test tự động); `dlq-age-check.spec.ts` (14 test), `test/services/dlq-age-check.services-spec.ts` (ElasticMQ).
- **Thực trạng được kiểm bằng cách chạy code:** `writeFileSync(path, text, { mode: 0o600 })` ở `runDlqAgeCheckCli` mặc định flag `w`: ghi đè file có sẵn và báo lỗi `ENOENT` nếu thư mục cha chưa có (xem §3).
- **Baseline (2026-11-20, `main` 2b4b5b5, Node 24.22.2):** `npm run typecheck` sạch; `dlq-age-check.spec.ts` 14/14; `eslint` sạch trên hai file `dlq-age-check*`; full `lint:check` và `npm test` ghi ở §8 (đã chạy lúc bắt đầu). Không chạy `test:e2e` ở máy này: CI chạy; task không chạm API hay DB.
- **Ngoài phạm vi:**
  - Đổi `infra/scripts/incident-cloud.sh` sang gọi `dlq:resend` (không có phiên ECS để kiểm; ghi BL mới ở §8).
  - `.gitignore` cho `*.jsonl`/`*.tsv` (BL-361, vai Platform); runbook chỉ đưa file ra ngoài repo.
  - Redrive thật bằng `start-message-move-task` (BL-051, đã chạy ở DBS-164).
  - Chạy trên SQS AWS thật (không có phiên): chỉ ElasticMQ.
- **Câu hỏi mở:**
  1. Lệnh mới tách riêng hay mở rộng `dlq:age-check`? Đề xuất: tách `dlq:resend` (một lệnh một việc: `age-check` chỉ đọc và xóa quá hạn, `resend` ghi vào queue chính), dùng chung `DlqPort`, `ageOf` và đoạn ghi file.
  2. `dlq:resend` mặc định gửi lại hết hay phải chọn? Đề xuất: bắt buộc chọn rõ (`--event-id <uuid>` lặp lại, hoặc `--all`); runbook 3c có loại message "bỏ qua có ghi nhận" không được tự động quay lại queue.
  3. Message quá 6 ngày hoặc không có `eventId` UUID có được gửi lại không? Đề xuất: không bao giờ (quy tắc dedup 7 ngày của `processed_events`; message không có `eventId` là loại hỏng của runbook 3b); chúng ở lại DLQ và được liệt kê trong báo cáo.
- **Quyết định ở G1 (agent tự quyết):** xem cuối tài liệu này, mục «Quyết định ở G1».

### Quyết định ở G1

1. **Chọn việc (agent tự quyết).** `fetch-task.mjs --next Dev` trả DBS-141, 171, 172, 185. DBS-171, 172, 185 đã có trên `main` (#139, #140, #200; board chưa cập nhật); DBS-141 là việc quy trình (issue board, giao vai) mà agent không được sửa. Còn lại là các dòng mục Dev của BACKLOG; chọn BL-360 + BL-372 vì cùng một CLI, thuần code có test, không cần cloud hay người.
2. **Mã task (agent tự quyết).** `BL-360-372` thay cho `DBS-<n>`; không dùng `BUG-YYYYMMDD` vì BL-372 là tính năng.
3. **Câu hỏi 1, 2, 3 ở trên:** theo đề xuất của từng câu.
4. **Tái hiện BL-360 (chạy CLI thật, port giả, ghi file thật):** lần chạy 1 lưu body `m1` và xóa nó; lần chạy 2 cùng tên file lưu `m2` và **ghi đè**, file còn 1 dòng, body `m1` mất trong khi đã bị xóa khỏi SQS; thư mục cha chưa có thì thoát 2 chỉ với «dlq-age-check failed: Error». Output: `scratchpad/repro-bl360-before.txt`.

## 2. Hành vi

### 2.1 BL-360: `dlq:age-check --delete-stale --quarantine-file <path>`

| # | Điều kiện | Kết quả |
|---|---|---|
| A1 | File `<path>` chưa có, thư mục cha có hoặc chưa có | thư mục cha được tạo; file tạo mới bằng cờ `wx` (mode `0o600`, thư mục `0o700`, chỉ có hiệu lực trên POSIX) và chứa body các message quá hạn; sau đó mới xóa khỏi SQS (hành vi cũ giữ nguyên) |
| A2 | File `<path>` đã có **và** có message quá hạn | thoát **2**; stderr: `dlq-age-check failed: FileExistsError` kèm một câu cố định («chọn tên file mới»); **không xóa gì**, mọi message trả lại hàng đợi (đường `saveStale` ném lỗi của `runDlqAgeCheck`); file cũ không bị sửa |
| A3 | File `<path>` đã có nhưng **không** có message quá hạn | không chạm file, thoát 0 hoặc 1 như trước |
| A4 | Không tạo được file hoặc thư mục (quyền, thư mục cha là một file, ổ đầy) | thoát 2, không xóa gì (cùng đường A2) |
| A5 | Đường dẫn bắt đầu bằng `~` (shell không mở rộng, ví dụ Git Bash với `--quarantine-file=~/x`) hoặc nằm trong một cây git (có `.git` ở thư mục tổ tiên) | thoát 2 **trước khi** nhận message nào (review #7: `mkdir` đệ quy không được tạo `backend/~/…` trong repo công khai); chỉ kiểm khi dùng bộ ghi file mặc định |

### 2.2 BL-372: `npm run --silent dlq:resend -- --from-dlq <url> --to-queue <url> --record-file <path> (--all | --event-id <uuid>…) [--endpoint-url <url>]`

Gửi lại message hợp lệ từ DLQ về queue chính **sau khi nguyên nhân đã sửa**, theo mục 3d mới của `dlq-redrive.md`. Không thay `start-message-move-task` (redrive hàng loạt, mục 4): lệnh này gửi từng message có chọn lọc, giữ tuổi gốc, và ghi lại.

| # | Điều kiện | Kết quả |
|---|---|---|
| B1 | Bắt buộc `--from-dlq`, `--to-queue`, `--record-file` và đúng một trong `--all` hoặc `--event-id` (lặp được; mỗi giá trị là UUID, chuẩn hóa chữ thường, bỏ trùng). Hạn tuổi cố định 6 ngày. `--from-dlq` ≠ `--to-queue`. `--record-file` theo A5 | sai bất kỳ điều nào: thoát 2, không đọc queue, không tạo file |
| B2 | Trước khi nhận message nào, đọc thuộc tính của hai queue (`GetQueueAttributes`): (a) hai queue tồn tại; (b) **queue đích rỗng**: `ApproximateNumberOfMessages`, `…NotVisible`, `…Delayed` đều 0 (điều kiện của bash `phase_resend` đã chạy thật trên AWS; message gửi lại ở tuổi gần 6 ngày phải được xử lý ngay, không chờ sau hàng đợi: queue chính giữ 4 ngày, `processed_events` ≥ 7 ngày); (c) nếu queue đích có `RedrivePolicy`, `deadLetterTargetArn` phải bằng `QueueArn` của `--from-dlq` (chống gửi nhầm DLQ risk sang `notification-events`; queue đích không có `RedrivePolicy` thì không kiểm được và được qua) | sai (a), (b) hoặc (c): thoát 2, **không chạm DLQ** (không ẩn message), không tạo file |
| B3 | `--record-file` đã có | thoát 2 trước khi nhận message nào (file tạo bằng `wx` sau B2) |
| B4 | Quét DLQ đủ như `dlq:age-check` (visibility 1800 s, giữ handle mới nhất của mỗi `MessageId`); quét không xong trong số vòng cho phép | không gửi gì, trả hết message về queue, thoát 2 |
| B5 | Phân loại từng message, theo thứ tự. (1) body không có `eventId` UUID → `no_event_id`. (2) `--event-id` có mặt và `eventId` không nằm trong đó → `not_selected` (kể cả khi message sai contract hay quá hạn). (3) body không qua `validateEvent` của `@common/events` (thiếu trường, `eventType` lạ, UUID hoa; đúng các loại «không redrive» của runbook mục 2b) → `invalid_event`. (4) **bất kỳ** bản nào của `eventId` (kể cả bản sai contract) có tuổi gốc > 6 ngày hoặc không có thời điểm gửi (`ageOf`; dấu `processed_events` có thể đã hết, gửi bản mới có thể áp hiệu ứng lần hai) → cả nhóm `stale` | `skipped` (không gửi, không xóa, trả lại DLQ). Mã thoát xem B10 |
| B6 | Mỗi `eventId` đủ điều kiện: bản có thời điểm gửi gốc sớm nhất là bản đại diện | (i) ghi dòng `sending`; (ii) `SendMessage` vào `--to-queue` với **body nguyên văn** và các thuộc tính của bản DLQ (chỉ `DataType`, `StringValue`, `BinaryValue`), `OriginalSentTimestamp` (kiểu `Number`) **ghi đè** bằng thời điểm gửi gốc (giá trị sẵn có; message do SQS tự chuyển lấy từ `SentTimestamp`), để tuổi không đặt lại về 0; (iii) ghi dòng `resent`; (iv) xóa bản đại diện theo handle mới nhất; (v) **chỉ sau (iv) thành công** mới xóa các bản trùng khác (ghi `duplicate_deleted`). Gửi lỗi (vượt 10 thuộc tính, queue lỗi): không xóa bản nào của `eventId`, trả lại cả nhóm, ghi `failed` bước `send`, các `eventId` khác vẫn xử lý |
| B7 | **Bất biến sau khi một `eventId` đã gửi thành công** (review #1 lượt 2): không bản nào của nó được trả lại DLQ; bản xóa được thì xóa, bản không xóa được thì **ẩn** tới hết visibility 1800 s, để một lượt chạy lại ngay không thấy và không gửi lần hai. Áp cho: xóa bản đại diện lỗi (dòng `resent_delete_failed`, `failed` bước `delete`; các bản trùng không bị xóa và cũng ẩn); xóa một bản trùng lỗi (`failed` bước `delete`, các bản trùng khác vẫn xóa); ghi dòng `resent` lỗi (B8) | như mô tả |
| B8 | Ghi file ghi nhận lỗi (ổ đầy) | dừng ngay: không gửi tiếp, trả lại phần chưa xử lý (trừ các bản theo B7), `failed` bước `record`, báo cáo vẫn được in, thoát 2. Dòng `sending` ghi **trước** khi gửi nên một message đã gửi luôn có dấu vết; nếu chính dòng `sending` hỏng thì chưa gửi gì |
| B9 | Ngân sách thời gian: handle chỉ sống 1800 s từ lúc nhận | quá 1500 s kể từ lúc bắt đầu quét: dừng gửi, trả lại phần chưa xử lý, `stoppedEarly: true`, thoát 2 |
| B10 | Kết quả | JSON ra stdout: `scanned`, `resent`, `duplicatesDeleted`, `skipped[]` (`messageId`, `eventId?`, `reason`), `notFound[]` (id đã chọn mà không message nào mang), `failed[]` (`messageId`, `eventId?`, `step`: `send`, `delete`, `release`, `record`; `error`: **tên** lỗi, không bao giờ nội dung vì có URL queue và id tài khoản), `complete`, `stoppedEarly`. **Không bao giờ có body.** Thoát **2** nếu `complete` sai, `stoppedEarly`, hoặc `failed` không rỗng, hoặc lỗi chung; thoát **1** nếu còn message `stale` hoặc `invalid_event`, hoặc `no_event_id` **chỉ khi dùng `--all`**, hoặc `notFound` không rỗng; ngược lại **0**. Với `--event-id`, mã thoát chỉ xét các `eventId` đã chọn (message không có `eventId` không thuộc event nào được chọn); `--all` coi mọi message còn lại là chặn redrive mù |
| B11 | File ghi nhận (`wx`, mode `0o600`, JSON lines, thêm từng dòng ngay sau mỗi thao tác) | mỗi dòng: `action` (`sending`, `resent`, `duplicate_deleted`, `resent_delete_failed`), `eventId`, `dlqMessageId`, `newMessageId?`, `originalSentTimestamp`, `at` (ISO). Không có body, không có handle |
| B12 | «Mỗi `eventId` chỉ gửi lại một lần» **giữa các lượt chạy** (runbook mục 5) | lệnh không nhớ lượt trước (ngoài phạm vi, §8): runbook 3d bắt buộc đối chiếu các file ghi nhận cũ và dùng `--event-id` (không dùng `--all`) khi có file cũ cho queue đó |

Ví dụ báo cáo (`--all`, 4 message: một hợp lệ, một quá hạn, một không phải JSON, một sai schema):

```json
{
  "scanned": 4,
  "resent": 1,
  "duplicatesDeleted": 0,
  "skipped": [
    { "messageId": "m-old", "eventId": "9d0c…", "reason": "stale" },
    { "messageId": "m-bad", "reason": "no_event_id" },
    { "messageId": "m-schema", "eventId": "5c1d…", "reason": "invalid_event" }
  ],
  "notFound": [],
  "failed": [],
  "complete": true,
  "stoppedEarly": false
}
```

(thoát 1). Dòng ghi nhận: `{"action":"resent","eventId":"2f6c…","dlqMessageId":"m1","newMessageId":"m9","originalSentTimestamp":1763640000000,"at":"2026-11-20T09:00:00.000Z"}`.

## 3. Kiến trúc

- **Vị trí:** `backend/src/scripts/` (công cụ vận hành chạy bằng `ts-node`, không thuộc `api` hay `worker`). File: `dlq-age-check.ts` (sửa), `dlq-resend.ts` và `dlq-resend.main.ts` (mới), `dlq-files.ts` (mới), `package.json` (script `dlq:resend`).
- **Nguyên nhân gốc BL-360 (đã tái hiện, G1):** mặc định `writeFile` của CLI là `writeFileSync(path, text, { mode: 0o600 })`, cờ `w` ghi đè và không tạo thư mục.
- **Interface dùng lại (chữ ký thật):** `DlqPort { receive(); visibleCount(); delete(m); release(m) }`, `awsDlqPort(client, queueUrl)`, `ageOf(message, now)`, `DEFAULT_MAX_AGE_DAYS`, `EVENT_ID`, `originalSentTimestampOf`, `ORIGINAL_SENT_TIMESTAMP`, `validateEvent(payload)` của `@common/events`. Refactor nhỏ đã làm: `drainDlq(port, maxRounds)` (tách khỏi `runDlqAgeCheck`), export `eventIdOf` và `EVENT_ID`.
- **Interface mới:**
  - `dlq-files.ts`: `FileExistsError` (đổi tên từ `QuarantineFileExistsError`, review #14), `UnsafeFilePathError`, `assertSafeOutputPath(path)` (A5), `createExclusiveFile(path, text?)` (`assertSafeOutputPath`, `mkdirSync(dirname, { recursive: true, mode: 0o700 })`, `openSync(path, 'wx', 0o600)`; `EEXIST` đổi thành `FileExistsError`), `appendLine(path, line)`.
  - `dlq-resend.ts`: `SendPort { send(body, attributes): Promise<string> }`; `QueueInfo { queued: number; arn?: string; deadLetterTargetArn?: string }`; `awsSendPort`, `awsInspect(client)`; `runDlqResend(dlq, to, options): Promise<ResendReport>` với `options { now, select, record, maxRounds?, budgetMs?, clock? }`; `runDlqResendCli(argv, io)` với `io { stdout, stderr, env, now, port?, sendPort?, inspect? }` (ba cái cuối chỉ để test).
- **Người gọi của symbol bị đổi (grep):** `eventIdOf` và `EVENT_ID` chỉ dùng trong `dlq-age-check.ts` và `dlq-resend.ts`; `runDlqAgeCheckCli` do `dlq-age-check.main.ts`, `dlq-age-check.spec.ts` và `test/services/dlq-age-check.services-spec.ts` gọi (chữ ký giữ nguyên, chỉ đổi mặc định `writeFile`); `QuarantineFileExistsError` mới có trong nhánh này nên đổi tên không có người gọi ngoài.
- **Dữ liệu:** không chạm bảng nào, không migration. Chỉ SQS (hai queue) và file cục bộ.
- **Ranh giới transaction:** không có (không dùng DB). Thứ tự an toàn: **ghi `sending` → gửi → ghi `resent` → xóa** (một message luôn nằm trong ít nhất một queue và luôn có dấu vết); **lưu trước, xóa sau** ở `age-check`.
- **Tiền và dedup:** không đổi quy tắc tiền (CONTRIBUTING §5). Lệnh không bỏ qua `processed_events`; nó chỉ cam kết không gửi message có bản nào quá 6 ngày (cửa sổ dedup ≥ 7 ngày, database-design §10), không gửi message sai contract, và chỉ gửi vào queue đích đang rỗng.

```mermaid
sequenceDiagram
  participant Op as Người vận hành
  participant CLI as dlq:resend
  participant D as DLQ
  participant Q as Queue chính
  Op->>CLI: --from-dlq --to-queue --record-file (--all | --event-id)
  CLI->>Q: GetQueueAttributes (rỗng? RedrivePolicy khớp DLQ?)
  CLI->>D: GetQueueAttributes (tồn tại, QueueArn)
  CLI->>CLI: tạo record-file (wx)
  CLI->>D: nhận hết (visibility 1800 s)
  loop mỗi eventId hợp lệ, được chọn, mọi bản ≤ 6 ngày
    CLI->>CLI: ghi "sending"
    CLI->>Q: SendMessage(body, thuộc tính + OriginalSentTimestamp)
    CLI->>CLI: ghi "resent"
    CLI->>D: DeleteMessage(bản đại diện), rồi các bản trùng
  end
  CLI->>D: trả lại phần còn lại (visibility 0)
  CLI-->>Op: báo cáo JSON (không body); thoát 0, 1 hoặc 2
```

- **Thay đổi cấp hệ thống:** không có ADR hay contract nào đổi. Cập nhật tài liệu vận hành (§9), kể cả các dòng của `dlq-redrive.md` sẽ sai sau PR (xem §9) và cần Owner runbook (Platform & Ops) review.

## 4. Test cases tự động

Tên file spec: **A** = `src/scripts/dlq-age-check.spec.ts`, **R** = `src/scripts/dlq-resend.spec.ts`, **S** = `test/services/dlq-resend.services-spec.ts`.

| ID | Truy vết | Lớp · file | Given · When · Then | Kết quả mong đợi |
|---|---|---|---|---|
| TC-BL-01 | BL-360 «exclusive» | unit (fs thật) · A | file đã có nội dung A; `createExclusiveFile` lần hai | ném `FileExistsError`; nội dung vẫn là A |
| TC-BL-02 | BL-360 «tạo thư mục cha» | unit (fs thật) · A | đường dẫn có hai cấp thư mục chưa có | file tạo được, nội dung đúng |
| TC-BL-03 | BL-360 «thoát 2, không xóa gì» | unit (CLI, fs thật) · A | `--delete-stale` lần hai cùng tên file, có message quá hạn | thoát 2; không xóa; mọi message được release; stderr có `FileExistsError`; file cũ không đổi |
| TC-BL-04 | BL-360 (A3) | unit · A | file đã có, không message nào quá hạn | thoát 0, file không đổi |
| TC-BL-24 | BL-360 (A5) | unit · A | `--quarantine-file=~/x.jsonl`; đường dẫn tương đối trong cây repo; mặc định bộ ghi file | thoát 2 trước khi nhận message nào (`receives` = 0); không tạo thư mục |
| TC-BL-25 | BL-360 (A4) | unit (fs thật) · A | thư mục cha là một file thường | thoát 2; không xóa; message được release |
| TC-BL-05 | BL-372 B6 | unit · R | message hợp lệ 2 ngày, thuộc tính `String` | gửi body nguyên văn + thuộc tính + `OriginalSentTimestamp`; thứ tự `sending`, `send`, `resent`, `delete` |
| TC-BL-06 | B6 | unit · R | không có thuộc tính, chỉ `SentTimestamp` | thuộc tính gửi đi = `SentTimestamp` |
| TC-BL-07 | B6 | unit · R | thuộc tính cũ hơn `SentTimestamp` | giữ giá trị cũ |
| TC-BL-35 | B6 (kiểu thuộc tính) | unit · R | thuộc tính `Number`, `Binary`, `String.custom` | `DataType` và giá trị được chuyển nguyên |
| TC-BL-08 | B5 (4) | unit · R | 7 ngày tuổi; không thời điểm gửi; `OriginalSentTimestamp` sai định dạng, không có `SentTimestamp` | không gửi, không xóa, `stale`; thoát 1 |
| TC-BL-21 | B5 (4) | unit · R | cùng `eventId`: bản 8 ngày + bản 2 ngày | không gửi bản nào, không xóa bản nào, cả nhóm `stale` |
| TC-BL-38 | B5 (4) (review #4 lượt 3) | unit · R | một bản 8 ngày sai contract + một bản 2 ngày hợp lệ cùng `eventId` | không gửi, không xóa; bản hợp lệ `stale`, bản sai `invalid_event` |
| TC-BL-09 | B5 (1) | unit · R | body không phải JSON; JSON thiếu `eventId`; `eventId` không phải UUID | `no_event_id`; thoát 1 |
| TC-BL-28 | B5 (3) | unit · R | UUID hợp lệ nhưng thiếu trường bắt buộc; `eventType` lạ; UUID viết hoa | `invalid_event`, không gửi, không xóa; thoát 1 |
| TC-BL-10 | B6 | unit · R | ba bản cùng `eventId` hợp lệ | gửi 1 (bản gốc sớm nhất, `OriginalSentTimestamp` = min); xóa bản đại diện rồi hai bản trùng; ghi nhận `sending`, `resent`, `duplicate_deleted` ×2 |
| TC-BL-11 | B6 (review #1) | unit · R | ba bản cùng `eventId`, gửi lỗi | **0 bản bị xóa**, cả 3 được release; `failed` có `step: 'send'`; eventId khác vẫn gửi |
| TC-BL-12 | B7 | unit · R | xóa bản đại diện lỗi sau khi gửi (có một bản trùng) | dòng `resent_delete_failed`; cả bản đại diện lẫn bản trùng **không** được release và bản trùng không bị xóa; `failed` `delete` |
| TC-BL-37 | B7 (review #1 lượt 2) | unit · R | ba bản cùng `eventId`, xóa bản trùng thứ nhất lỗi | các bản còn lại vẫn xóa; bản lỗi ẩn (không release); `failed` `delete` |
| TC-BL-29 | B8 (review #5) | unit · R | `record` ném lỗi ở dòng `sending` của message 2; ở dòng `resent` | không gửi message 2 (dòng `sending` hỏng), phần còn lại release; ở dòng `resent` hỏng: message đã gửi và bản trùng không bị release và không bị xóa; `failed` bước `record`; thoát 2 |
| TC-BL-13 | B5 (2), B10 | unit · R | `--event-id` chọn một trong hai; thêm id không có | chỉ message chọn gửi; kia `not_selected` và release; `notFound`; thoát 1 |
| TC-BL-23 | B1 | unit · R | `--event-id` HOA và lặp hai lần | một lần gửi, `notFound` rỗng |
| TC-BL-30 | B4 (review #10b) | unit · R | một `MessageId` nhận hai lần với handle khác nhau | gửi một lần; xóa bằng handle **mới nhất** |
| TC-BL-14 | B4 | unit · R | queue không bao giờ cạn trong số vòng | không gửi gì; `complete` false; mọi message đã thấy được release; thoát 2 |
| TC-BL-32 | B10 (review #10h) | unit · R | `release` lỗi cho một message | `failed` có `step: 'release'`; thoát 2 |
| TC-BL-33 | B9 (review #13) | unit · R | đồng hồ nhảy quá 1500 s sau message đầu | dừng gửi; phần còn lại release; `stoppedEarly`; thoát 2 |
| TC-BL-22 | B6 | unit · R | 10 thuộc tính qua; 11 bị SQS giả từ chối | 10: gửi đủ; 11: `failed` `send`, không xóa. Trường rỗng (`StringListValues`) không chuyển sang |
| TC-BL-15 | B1 | unit · R | thiếu tham số bắt buộc; cả `--all` và `--event-id`; không có cả hai; `--event-id` không phải UUID; hai URL bằng nhau; `--record-file` có `~` hoặc trong repo; tùy chọn lạ | thoát 2; `receives` = 0; không gửi, không xóa |
| TC-BL-26 | B2 (b) (review #2) | unit · R | queue đích còn 1 message (hiện, ẩn hoặc hoãn) | thoát 2; DLQ không bị chạm (`receives` = 0); không tạo file |
| TC-BL-27 | B2 (a), (c) (review #8) | unit · R | queue không tồn tại; `RedrivePolicy` của đích trỏ DLQ khác; đích không có `RedrivePolicy` | không tồn tại hoặc lệch: thoát 2, không chạm DLQ; không có chính sách: tiếp tục |
| TC-BL-31 | B3 | unit · R | `--record-file` đã có | thoát 2 trước khi nhận; file cũ không đổi |
| TC-BL-16 | B10, B11 | unit · R | chạy TC-BL-05 và TC-BL-10 qua CLI | báo cáo, stderr và file ghi nhận không chứa body, `ReceiptHandle`, nội dung lỗi SDK; có đủ trường; `failed` chỉ có tên lỗi |
| TC-BL-34 | B10 | unit · R | mã thoát | `--all`: 0 khi mọi message đã gửi; 1 khi còn `stale`, `invalid_event` hoặc `no_event_id`. `--event-id`: 0 khi mọi `eventId` chọn đã gửi dù DLQ còn message không có `eventId`; 1 khi `eventId` chọn quá hạn hoặc `notFound`. 2 khi `failed` |
| TC-BL-17 | BL-372 «có test» (giao thức SQS, ElasticMQ) · S | `SqsClient.processBatch` đưa vào DLQ ba message: một `TransferCompleted` hợp lệ (dùng `TRANSFER_SAMPLE`), một hợp lệ nhưng 7 ngày, một `{eventId}` không đủ trường; chạy CLI thật `--all` (cả `inspect` thật) | queue chính nhận đúng body, thuộc tính, `OriginalSentTimestamp` gốc; `skipped` có `stale` và `invalid_event`; **ba thuộc tính DLQ + nhận lại**: còn đúng hai message đó (bản đã xóa không hiện lại, không có message ẩn); thoát 1 |
| TC-BL-18 | BL-372 (chuỗi tuổi) · S | message bị dead-letter lần hai sau khi gửi lại | `OriginalSentTimestamp` vẫn là lần gửi gốc |
| TC-BL-36 | B6 (SDK) · S | thuộc tính `Binary` qua `SendMessage` thật | `BinaryValue` còn nguyên ở queue chính |
| TC-BL-19 | BL-372 «runbook trỏ tới» | quy trình | `grep` | `dlq-redrive.md` (mục 3d) và `async-incident-scenarios.md` nêu `dlq:resend`; các dòng runbook sai đã sửa; `check-doc-links.mjs` sạch |
| TC-BL-20 | Đóng BL | quy trình | PR merge, CI xanh, Dev review, bảng «Đối chiếu test case» điền | (sau G4) |

## 5. Test thủ công

Điều kiện: `docker compose up -d elasticmq` (cổng 9324); Node 24; từ `backend/`; `AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_REGION=us-east-1 SQS_ENDPOINT=http://localhost:9324`. Không cần AWS CLI. Driver `backend/test/manual/dlq-cli.manual.ts` (đi kèm PR) có `seed`, `add-stale <dlq>`, `counts <queue>`, `peek <queue>`, `fill <queue>`, `drain <queue>`; `seed` tạo thêm `otherDlq` và đặt `RedrivePolicy` của queue chính trỏ DLQ chính; nạp message tổng hợp có body hợp lệ (`TRANSFER_SAMPLE` của `test/support/event-samples`) bằng `SqsClient` và `SendMessageCommand` (không ghi tiền, không dùng DB). Thư mục ghi file: `$HOME/dbs-ops/dlq-bl` (ngoài repo, A5). Trạng thái DLQ ghi sau mỗi bước để kiểm.

`seed` đặt trong DLQ 5 message: **A** hai bản (2 ngày và 3 ngày), **B** một bản (không thuộc tính), **OLD** 7 ngày, **JUNK** `{not json`. Các `eventId` do `seed` in ra. Queue chính rỗng.

| Bước | Việc làm | Kết quả mong đợi · DLQ sau bước |
|---|---|---|
| M-BL-01 | `seed`; `counts <dlq>` và `counts <main>` | DLQ 5, chính 0 |
| M-BL-02 | (trước khi sửa, trên `main` cũ hoặc `git stash`: tái hiện BL-360, ghi ở `scratchpad/repro-bl360-before.txt`, đã có ở G1) | đã ghi |
| M-BL-03 | `dlq:age-check --queue-url <dlq> --delete-stale --quarantine-file $HOME/dbs-ops/dlq-bl/sub/q.jsonl` | thoát 0; thư mục `sub/` được tạo; file 1 dòng (OLD); DLQ 4 (A×2, B, JUNK) |
| M-BL-04 | `add-stale <dlq>`; lại lệnh M-BL-03 cùng tên file | thoát **2**, stderr `FileExistsError`; **không xóa**; file vẫn 1 dòng; DLQ 5 (thêm STALE-2) |
| M-BL-05 | lại M-BL-03 với `--quarantine-file=~/dbs-ops/q2.jsonl` (không dấu cách) | thoát 2 trước khi quét (A5); DLQ vẫn 5 |
| M-BL-06 | `dlq:resend` thiếu `--event-id/--all`; rồi `--event-id abc`; rồi `--from-dlq` = `--to-queue` | thoát 2; DLQ vẫn 5, `NotVisible` 0 |
| M-BL-07 | lỗi/phục hồi: `--to-queue` sai tên (queue không tồn tại) | thoát 2 ngay, DLQ không đổi và không bị ẩn (`NotVisible` 0) |
| M-BL-07b | cặp queue sai: `dlq:resend --from-dlq <otherDlq> --to-queue <main> --record-file $HOME/dbs-ops/dlq-bl/x.jsonl --all` (queue chính dead-letter tới DLQ khác) | thoát 2 với stderr «dead-letters to another queue» (B2 (c)); cả hai DLQ không đổi và không bị ẩn; `x.jsonl` không được tạo. Nếu ElasticMQ không trả `RedrivePolicy` thì ghi «(c) chỉ kiểm bằng fake TC-BL-27» và bước này **chưa chạy** |
| M-BL-08 | queue đích không rỗng: `fill <main>` rồi `dlq:resend … --all` | thoát 2 (B2 (b)), DLQ không đổi và không bị ẩn; sau `drain <main>` thì chạy tiếp được |
| M-BL-09 | `dlq:resend --from-dlq <dlq> --to-queue <main> --record-file $HOME/dbs-ops/dlq-bl/r1.jsonl --event-id <A>` | thoát **0** (với `--event-id` chỉ xét `eventId` chọn; JUNK không thuộc event nào); queue chính 1 message (A) với body, `correlationId` và `OriginalSentTimestamp` = 3 ngày (bản sớm nhất); DLQ còn B, STALE-2, JUNK (cả hai bản A đã xóa); file ghi nhận: `sending`, `resent`, `duplicate_deleted` |
| M-BL-10 | `peek <main>` | body A trùng byte-for-byte bản nạp; thuộc tính đủ |
| M-BL-11 | `drain <main>` rồi chạy lại cùng `--record-file r1.jsonl` | thoát 2 với stderr `FileExistsError` (B3, không phải vì queue không rỗng); DLQ không đổi, `NotVisible` 0 |
| M-BL-12 | `dlq:resend … --record-file r2.jsonl --all` (queue chính đã rỗng) | `B` được gửi; STALE-2 `stale`, JUNK `no_event_id`; thoát **1**; DLQ còn STALE-2 và JUNK; chính 1 (B) |

Consumer thật không chạy ở đây: lệnh chỉ chuyển message; xử lý trùng đã có TC của DBS-125 và BL-210. Lưu ý: ElasticMQ không thay AWS (runbook «Nâng image ElasticMQ»); phần AWS thật **chưa chạy** (BL mới ở §8).

## 6. Domain review (AI)

**Reviewer:** subagent (model `fable`, đọc-chỉ), ba lượt, 2026-11-20. Trước đó agent tự review một lượt ([domain-review-self.md](screenshots/BL-360-372/domain-review-self.md), 10 phát hiện, đã sửa) vì lần gửi subagent đầu bị dừng giữa chừng. · **Lượt 1:** 15 phát hiện (blocking 2, should-fix 9, minor 4), REVISE · [nguyên văn](screenshots/BL-360-372/domain-review.md). **Lượt 2** (sau khi sửa): 7 phát hiện (should-fix 4, minor 3), REVISE. **Lượt 3:** 4 phát hiện minor, **Verdict: APPROVE**; cả bốn đã sửa (lượt 2 và 3 được trả qua tin nhắn, không có file riêng; nội dung tóm lược ở bảng dưới).

| # | Mức | Phát hiện (lượt 1 trừ khi ghi) | Xử lý |
|---|---|---|---|
| 1 | blocking | B5 và B9 không ghép: gửi lỗi mà bản trùng vẫn bị xóa | đã sửa: bản trùng chỉ xóa sau khi bản đại diện đã gửi và xóa (B6); gửi lỗi thì trả lại cả nhóm; TC-BL-11 |
| 2 | blocking | mất điều kiện queue chính 0/0/0 và quy tắc 24 giờ | đã sửa: B2 (b) kiểm trước khi nhận; quy tắc 24 giờ sau gửi vào runbook 3d; TC-BL-26 |
| 3 | should-fix | `--all` gửi cả message sai contract/UUID hoa | đã sửa: B5 (3) `validateEvent`, `invalid_event`; TC-BL-28 |
| 4 | should-fix | bản cùng `eventId`, tuổi khác nhau | đã sửa: B5 (4) một bản quá hạn chặn cả nhóm; TC-BL-21, 38 |
| 5 | should-fix | ghi nhận sau khi gửi; ghi lỗi | đã sửa: dòng `sending` trước khi gửi, ghi lỗi dừng chạy (B6, B8); TC-BL-29 |
| 6 | should-fix | «mỗi `eventId` một lần» giữa các lượt chạy | không làm `--exclude-record` (ngoài «Đóng khi»; reviewer đồng ý): B12 là quy tắc runbook 3d, thêm BL mới (§8) |
| 7 | should-fix | `mkdir` đệ quy tạo `backend/~/…` trong repo công khai | đã sửa: A5, `assertSafeOutputPath`; TC-BL-24, TC-BL-15 |
| 8 | should-fix | không kiểm cặp queue | đã sửa: B1 khác URL, B2 (c) `RedrivePolicy`; TC-BL-15, 27; M-BL-07b |
| 9 | should-fix | kịch bản thủ công tự mâu thuẫn | đã viết lại §5 và driver (`add-stale`, `fill`, `drain`, `peek`, `counts`) |
| 10 | should-fix | thiếu test (MessageId nhận hai lần, 10/11 thuộc tính, Binary, A4, release lỗi...) | đã thêm TC-BL-22, 25, 30, 32, 33, 35, 36, 37, 38 |
| 11 | should-fix | nhãn «SQS thật», đường bash còn song song | nhãn «giao thức SQS (ElasticMQ)»; TC-BL-17 kiểm ba thuộc tính; BL mới cho `incident-cloud.sh` và chạy AWS thật (§8) |
| 12–15 | minor | `failed[]`, ngân sách thời gian, tên file spec/tên lỗi, dòng runbook sai | đã sửa: B9, B10, §4 cột «file», `FileExistsError`; dòng runbook ở §9 và Owner runbook review |
| L2-1 | should-fix | sau khi gửi, bản trùng bị release làm lượt chạy lại gửi lần hai | đã sửa: bất biến B7; TC-BL-12, 29, 37 |
| L2-2…7 | should-fix, minor | mã thoát M-BL-09 mâu thuẫn; M-BL-11; body test dịch vụ không hợp lệ; `failed.step` `record`; plan sweep; driver | đã sửa (B10; §5; `TRANSFER_SAMPLE`; B10; §7; driver) |
| L3-1…4 | should-fix, minor | M-BL-07b thiếu `--record-file`; nhãn B5; câu §7; tuổi nhỏ nhất tính trên mọi bản | đã sửa, kèm TC-BL-38 và commit `beb7e5c` |

### Quyết định ở G2 (agent tự quyết, ghi lại sau review)

1. **Chấp nhận kiểm queue đích rỗng (đổi quyết định lúc tự review):** lúc tự review tôi bỏ kiểm này vì cho rằng chỉ thuộc kịch bản sự cố; reviewer chỉ ra bằng chứng (bash đã chạy thật, queue chính giữ 4 ngày, `processed_events` ≥ 7 ngày) nên đổi.
2. **Quy tắc tuổi theo `eventId` bảo thủ hơn bash** (có thể từ chối thứ bash sẽ gửi): người vận hành dọn bằng `dlq:age-check --delete-stale` rồi chạy lại.
3. **Không làm `--exclude-record`:** thay bằng B12 và BL mới.
4. **Reviewer là subagent ở ba lượt cuối;** lượt tự review đầu được giữ làm tham chiếu.

## 7. Kế hoạch triển khai

Mọi bước: viết test trước, chạy đỏ, viết code tối thiểu, chạy xanh, commit. Lệnh chạy từ `backend/` với Node 24 (`export PATH="$APPDATA/fnm/node-versions/v24.22.2/installation:$PATH"`). Lệnh chung: `npx jest --config ./test/jest-unit.js <file>`.

**Trạng thái (cập nhật sau review lần 1):** bước 1–6 đã làm và commit theo thiết kế bản 1 (bản gửi-trước-xóa-sau cơ bản). Review độc lập yêu cầu thêm hành vi; các bước 7–10 dưới đây là phần bổ sung, làm theo thứ tự test-trước. Đây là rời kế hoạch G3 nên được ghi ở §8 («Lệch so với kế hoạch») và G3 duyệt lại bằng bản này.

| Bước | File | Test viết trước | Kết quả đỏ | Lệnh chứng minh | Commit |
|---|---|---|---|---|---|
| 1 ✔ | `dlq-files.ts`, `dlq-age-check.spec.ts` | TC-BL-01, 02 | đã chạy: `Cannot find module './dlq-files'` | `npx jest --config ./test/jest-unit.js src/scripts/dlq-age-check.spec.ts` | f3fce09 |
| 2 ✔ | `dlq-age-check.ts`, spec | TC-BL-03, 04 | đã chạy: lần chạy 1 thoát 2 vì thư mục `sub/` chưa có | cùng | fa5dcc3 |
| 3 ✔ | `dlq-age-check.ts` (`drainDlq`, `eventIdOf`) | refactor, 18 test hiện có xanh | không áp dụng | cùng | 70d7e0c |
| 4 ✔ | `dlq-resend.ts`, `dlq-resend.spec.ts` (bản 1: TC-BL-05..16, 21..23) | đã chạy: `Cannot find module './dlq-resend'`; kiểm đột biến: `some`→`every` làm TC-BL-21 đỏ, xóa-trước-gửi làm 7 test đỏ | | `npx jest --config ./test/jest-unit.js src/scripts/dlq-resend.spec.ts` | 7719064 |
| 5 ✔ | `dlq-resend.main.ts`, `package.json` | `dlq:resend --help` thoát 0; không đối số thoát 2 | | `npm run --silent dlq:resend -- --help` | 6ef3a6b |
| 6 ✔ | `test/services/dlq-resend.services-spec.ts` | TC-BL-17, 18 (code đã có nên không có bước đỏ; đã chạy 2/2) | | `npm run test:services -- --runInBand --runTestsByPath test/services/dlq-resend.services-spec.ts` | 4f122c6 |
| 7 ✔ | `dlq-files.ts` (`FileExistsError`, `assertSafeOutputPath`), `dlq-age-check.ts` (A5), `dlq-age-check.spec.ts` | TC-BL-24, TC-BL-25 (viết trước; đổi tên TC-BL-01) | chạy trước khi sửa mặc định: `TC-BL-24` được đột biến (bỏ kiểm tra sớm) cho đỏ: `released` không rỗng | `npx jest --config ./test/jest-unit.js src/scripts/dlq-age-check.spec.ts` | b2f8d34 |
| 8 ✔ | `dlq-resend.ts`, `dlq-resend.spec.ts` (viết lại, 26 test) | TC-BL-05..16, 21..23, 26..35, 37 | đã chạy: lỗi biên dịch (`QueueInfo` chưa có, `SendPort` đổi); đột biến: bỏ ẩn-sau-gửi làm 6 test đỏ, bỏ kiểm queue rỗng 1, bỏ `validateEvent` 1, bỏ dòng `sending` 5 | `npx jest --config ./test/jest-unit.js src/scripts/dlq-resend.spec.ts` | 499bc56 |
| 9 ✔ | `test/services/dlq-resend.services-spec.ts` (body hợp lệ `TRANSFER_SAMPLE`; `inspect` thật) | TC-BL-17 (mạnh hơn: ba thuộc tính, nhận lại, `invalid_event`), TC-BL-36 | đã chạy: 1 đỏ (kỳ vọng số dòng ghi nhận cũ) rồi sửa; code đã có nên không có đỏ vì thiếu hành vi | `npm run test:services -- --runInBand --runTestsByPath test/services/dlq-resend.services-spec.ts` | 1f577e7 |
| 10 ✔ | `test/manual/dlq-cli.manual.ts` (`seed`, `add-stale`, `counts`, `peek`, `fill`, `drain`; queue chính có `RedrivePolicy`) | M-BL-01..12 ở Phase 4c | không áp dụng | xem §5 | 9d5abaf |
| 11 | `docs/runbooks/dlq-redrive.md` (sửa dòng 112–113, 156, 206; thêm mục 3d), `async-incident-scenarios.md`, `backend/src/scripts/README.md`, `docs/features/README.md`, `docs/BACKLOG.md`, feature doc §8–§9, ảnh | TC-BL-19 (grep + `check-doc-links.mjs`) | (điền) | `node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs` | `docs: dlq:resend và quarantine exclusive (BL-360, BL-372)` |

**Quét kế hoạch (plan sweep):** «Đóng khi» BL-360: `wx` (TC-01), thoát 2 và không xóa (TC-03, 25), tạo thư mục cha (TC-02), test trong `dlq-age-check.spec.ts` (TC-01..04, 24, 25). BL-372: copy body và thuộc tính (TC-05, 22, 35, 36), `OriginalSentTimestamp` (TC-05..07, 18), xóa theo handle (TC-05, 10, 30), ghi `eventId` (TC-16, 29), có test (bước 4, 8, 9), runbook trỏ tới (bước 11, TC-19). Hạn chế ở `dlq-redrive.md`: mục 2b (loại không redrive ⇒ TC-28), mục 5 (mỗi `eventId` một lần ⇒ B12 và runbook 3d; «queue chính về 0 trong 24 giờ» **sau** `dlq:resend` ⇒ dòng mới ở mục 3d của runbook, bước 11, còn TC-26 chỉ là kiểm **trước** khi gửi), mục 3c (file ngoài repo ⇒ TC-24), `Quyền` (có `GetQueueAttributes` trên queue chính: kiểm ở bước 11). Ngoài phạm vi, thành BL mới: `--exclude-record` (B12), `incident-cloud.sh` dùng `dlq:resend`, chạy `dlq:resend` trên AWS thật; BL-361 giữ nguyên.

**Rủi ro và cách lùi:**
- Refactor `drainDlq` (bước 3): 18 test hiện có là lưới; lùi bằng `git revert`.
- Gửi lại sai message: mọi thao tác chỉ chạy khi người vận hành chọn `--all` hoặc `--event-id`, queue đích rỗng và cặp queue khớp; gửi-trước-xóa-sau. Không migration, không dữ liệu: lùi PR là xóa file.
- ElasticMQ không trả `RedrivePolicy` đúng như AWS: kiểm (c) chỉ áp khi có thuộc tính; TC-BL-27 dùng fake, M-BL-07b kiểm trên ElasticMQ thật.
- `validateEvent` kéo thêm phụ thuộc `@common/events` vào script: đã nằm trong `backend/src`, không thêm gói ngoài.

**Quyết định ở G3 (agent tự quyết):** (1) thêm bước 7–11 theo review độc lập (rời kế hoạch G3 cũ, ghi ở §8); (2) không làm `--exclude-record` (B12): ngoài «Đóng khi», thay bằng quy tắc runbook và BL mới.

## 8. Kết quả

- **Lệnh kiểm tra** (2026-11-20, Node 24.22.2, từ `backend/`, sau commit code cuối `b7c6604`):

```text
npm run lint:check                      → sạch (eslint, 0 lỗi)
npm run typecheck                       → sạch (tsc --noEmit)
npx prettier --check src/scripts/dlq-*.ts test/services/dlq-resend.services-spec.ts test/manual/dlq-cli.manual.ts → sạch
npm test (toàn bộ unit)                 → 139 suite, 2371 test đạt (baseline lúc bắt đầu: 138 suite, 2338 test)
npx jest --config ./test/jest-unit.js src/scripts/dlq   → 2 suite, 47 test (dlq-age-check.spec 20, dlq-resend.spec 27)
npm run test:services -- --runInBand --runTestsByPath test/services/dlq-age-check.services-spec.ts test/services/dlq-resend.services-spec.ts → 2 suite, 7 test đạt (dlq-age-check 4, dlq-resend 3), ElasticMQ thật qua testcontainers
node .claude/skills/dbs-delivering-task/scripts/check-doc-links.mjs → 484 file, 0 liên kết hỏng
```

  `test:e2e` không chạy ở máy này: task không chạm API, DB hay module nào mà e2e dùng; CI chạy. Không có `.skip`, `.only`, `.todo` trong test của task (0 test bị bỏ qua).

- **Đối chiếu test case** (A = `src/scripts/dlq-age-check.spec.ts`, R = `src/scripts/dlq-resend.spec.ts`, S = `test/services/dlq-resend.services-spec.ts`):

| ID | Test | Đạt? |
|---|---|---|
| TC-BL-01, 02 | A › «BL-360 quarantine file is created exclusively» › TC-BL-01, TC-BL-02 | đạt |
| TC-BL-03, 04 | A › «BL-360 dlq-age-check never overwrites the quarantine file» › TC-BL-03, TC-BL-04 | đạt |
| TC-BL-24, 25 | A › cùng nhóm › TC-BL-24, TC-BL-25 (TC-BL-24 đã kiểm bằng đột biến: bỏ kiểm tra sớm thì đỏ) | đạt |
| TC-BL-05, 06, 07, 35 | R › «dlq:resend (library)» › cùng tên | đạt |
| TC-BL-08, 09, 21, 28, 38 | R › library › cùng tên | đạt (TC-BL-21 đột biến `some`→`every` đỏ; TC-BL-38 đột biến đỏ) |
| TC-BL-10, 11, 12, 37, 29, 30 | R › library › cùng tên | đạt (đột biến «bỏ ẩn sau khi gửi» làm 6 test đỏ; «bỏ dòng `sending`» làm 5 test đỏ) |
| TC-BL-13, 23, 14, 32, 33, 22 | R › library › cùng tên | đạt |
| TC-BL-15, 31, 26, 27, 16, 34 | R › «dlq:resend (command)» › cùng tên | đạt (đột biến «bỏ kiểm queue rỗng» và «bỏ `validateEvent`» đỏ) |
| TC-BL-17, 18, 36 | S › «BL-372 dlq:resend on ElasticMQ» › cùng tên | đạt trên giao thức SQS qua ElasticMQ; **không** phải SQS AWS (BL-399) |
| TC-BL-19 | `grep` + `check-doc-links.mjs` (§9) | đạt |
| TC-BL-20 | PR merge, CI xanh, Dev review, bảng đối chiếu trong PR | chưa làm (sau khi mở PR) |

  Đơn giản hóa: không có. `QuarantineFileExistsError` → `FileExistsError` (review). TC-BL-33 dùng đồng hồ giả (không chờ 1500 s thật).

- **Test thủ công** (chạy trên ElasticMQ thật của `docker compose`, commit code cuối `b7c6604`, output thô: [manual-test.txt](screenshots/BL-360-372/manual-test.txt); trước khi sửa BL-360: [repro-bl360-before.txt](screenshots/BL-360-372/repro-bl360-before.txt)). Lần chạy đầu phát hiện lỗi của **driver** (`peek` nhận 5 lần nên vượt `maxReceiveCount` của `RedrivePolicy` và ElasticMQ đẩy message A về DLQ): đã sửa driver và chạy lại **toàn bộ** các bước.

| Bước | Kết quả |
|---|---|
| M-BL-01 | **đạt**: DLQ 5, queue chính 0 |
| M-BL-02 | **đạt** (bản «trước khi sửa»): ghi đè và mất body `m1`, đã có ở G1 và `repro-bl360-before.txt` |
| M-BL-03 | **đạt**: thoát 0; thư mục `sub/` tạo mới; file 1 dòng; DLQ 4 |
| M-BL-04 | **đạt**: thoát 2, `FileExistsError`, file vẫn 1 dòng, DLQ 5 (không xóa gì) |
| M-BL-05 | **đạt**: thoát 2, `UnsafeFilePathError`; DLQ 5; không có thư mục `~` trong `backend/` |
| M-BL-06 | **đạt**: ba lần thoát 2; DLQ 5 |
| M-BL-07 | **đạt**: `QueueDoesNotExist`, thoát 2; DLQ 5, không ẩn |
| M-BL-07b | **đạt**: ElasticMQ trả `RedrivePolicy`; thoát 2 «dead-letters to another queue»; hai DLQ không đổi; `x.jsonl` không tồn tại |
| M-BL-08 | **đạt**: thoát 2 «destination queue is not empty»; DLQ 5; `drain` rồi chạy tiếp được |
| M-BL-09 | **đạt**: thoát 0; DLQ 3 (B, STALE-2, JUNK), queue chính 1 (A); file ghi nhận `sending`, `resent`, `duplicate_deleted` với `originalSentTimestamp` của bản sớm nhất |
| M-BL-10 | **đạt**: body A khớp bản nạp; `correlationId` và `OriginalSentTimestamp` còn nguyên |
| M-BL-11 | **đạt**: thoát 2 `FileExistsError`; DLQ vẫn 3, không bị ẩn |
| M-BL-12 | **đạt**: thoát 1; B được gửi; STALE-2 `stale`, JUNK `no_event_id`; DLQ 2, queue chính 1 |

  Seed SQL: không có (không dùng DB). Phần AWS thật: **chưa chạy** (BL-399).

- **Phạm vi so với §7:** `git diff --stat origin/main...HEAD` (trước commit tài liệu): `package.json`, `dlq-age-check.ts` và spec, `dlq-files.ts`, `dlq-resend.ts` + spec + `main`, `test/manual/dlq-cli.manual.ts`, `test/services/dlq-resend.services-spec.ts` đều nằm trong §7 (bước 1–10); bước 11 là các file docs ở §9.
- **Ảnh chụp:** không có PNG. Task chỉ chạy CLI trong terminal, output thô đã lưu đầy đủ ở `manual-test.txt` (đã thay `$HOME` bằng `~` và rút gọn URL queue; không có token, header `Authorization`, id tài khoản AWS hay ARN thật) và `repro-bl360-before.txt`. Ảnh PNG thiếu; nêu trong tin nhắn G4 và mô tả PR.
- **Lệch so với kế hoạch (đã ghi trước khi làm):** (1) §7 ban đầu có 8 bước; sau review độc lập thêm bước 7–11 và viết lại bước 4, 9 (quyết định ở §6 và §7). (2) Thiết kế đầu bỏ kiểm «queue chính 0/0/0»; review chứng minh cần, nên đã thêm (quyết định ở §6). (3) `resend` bỏ `--max-age-days`. (4) Đổi tên `QuarantineFileExistsError` → `FileExistsError`. (5) Reviewer lượt đầu bị dừng; đã tự review rồi dùng subagent cho ba lượt tiếp (§6).
- **Bàn giao cho vai khác:** **BL-399** (Platform & Ops và Dev messaging): chạy `dlq:resend` trên SQS AWS thật và đổi pha `resend` của `incident-cloud.sh` sang CLI. **BL-400** (Dev messaging): nhớ lượt chạy trước / `--exclude-record` (review #6). BL-361 (`.gitignore`) giữ nguyên. **Owner runbook (Platform & Ops) cần review** các dòng đã sửa của `docs/runbooks/dlq-redrive.md`: header, bước 4 của tóm tắt, mục «Quyền», 3a (đã bỏ «CLI không tự tạo thư mục» và «CLI GHI ĐÈ»), mục 3d mới, «Lần chạy thật» (gửi lại bằng `dlq:resend`). Đã xóa BL-360 và BL-372 khỏi BACKLOG (task này đã xử lý).

## 9. Tài liệu đã cập nhật

- `docs/runbooks/dlq-redrive.md`: header (ngày, BL), bước 4 của bản tóm tắt, mục «Quyền» (queue chính), mục 3a (tạo thư mục cha, file đã có thì thoát 2, từ chối `~`/cây git), mục 3d mới (`dlq:resend`), «Lần chạy thật» (gửi lại bằng `dlq:resend`).
- `docs/runbooks/async-incident-scenarios.md`: kịch bản (a) «Dọn để chạy lại» và dòng giới hạn cuối (CLI `dlq:resend`, bash vẫn còn, BL-399).
- `backend/src/scripts/README.md`: hàng `dlq:resend` và ghi chú file mới của `dlq:age-check`.
- `docs/features/README.md`: hàng BL-360 + BL-372.
- `docs/BACKLOG.md`: xóa **BL-360**, **BL-372**; thêm **BL-399** (Platform & Ops), **BL-400** (Dev).
- Không đổi ADR, `database-design.md`, `event-contract.md` hay docs/03.
