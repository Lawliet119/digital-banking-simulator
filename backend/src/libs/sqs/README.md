# SQS adapter (DBS-77)

Import `SqsModule` ở module relay/consumer, inject `SqsClient` từ `@libs/sqs`. Module đăng ký
`sqsConfig` có sẵn: `AWS_REGION`, `SQS_ENDPOINT` (tùy chọn), `SQS_RISK_QUEUE_URL`,
`SQS_NOTIFICATION_QUEUE_URL`. Truyền queue URL đã cấu hình vào từng method; adapter không tự tạo
queue. Compose local dùng ElasticMQ và credential AWS giả; cloud không đặt endpoint, dùng provider
chain chuẩn của SDK (ECS task role). Không có credential nào gắn cứng trong runtime code.

```ts
await sqs.send(queueUrl, JSON.stringify(event), { correlationId: event.correlationId });
const results = await sqs.processBatch(queueUrl, dlqUrl, async (body, message) => {
  // Kiểm body (unknown), dựng correlation context, commit hiệu ứng + processed_events.
  await consumer.handle(body, message);
});
// Soi kết quả failed để đo lường/backoff. Không log body message hay receipt.
```

- `send(queue, body, attributes?)`: gửi body dạng string thô; attribute kiểu String. Lỗi SDK ném nguyên lên caller.
- `receive(queue, options?)`: trả message thô, **không xóa**; mặc định wait 20s, batch 10,
  visibility 30s. Biên hợp lệ: wait 0–20, batch 1–10, visibility 0–43200 (số nguyên).
  `abortSignal` (BL-209) hủy long poll đang chờ: SDK bỏ request và `receive` từ chối với `AbortError` ngay, không đợi hết 20 s. Phía queue request có thể còn sống một lúc và nhận mất message kế tiếp: message đó ẩn tới hết visibility timeout rồi giao lại với số lần nhận tăng thêm 1 (không mất message). Người gọi (`ConsumerBase`) hủy khi tắt máy và coi lỗi hủy là bình thường; `processBatch` chuyển `abortSignal` cho `receive` và lỗi hủy lan lên như mọi lỗi `receive`.
- `changeVisibility(queue, message, seconds)` (DBS-102): ẩn message đã nhận thêm `seconds` (0–43200) để làm backoff trước lần giao lại.
- `acknowledge(queue, message)`: xóa theo receipt handle, chỉ gọi sau khi caller đã commit xử lý.
- `processBatch(queue, dlqUrl, handler, options?)`: nhận một batch, các handler chạy song song.
  `await` từng callback trước khi xóa message đó. Kết quả: acknowledged/dead-lettered/failed.
  Handler hoặc delete lỗi thì message đó không bị xóa, không chặn các message khác hoàn tất.
  JSON hỏng, hoặc handler ném `PoisonMessageError` (message không bao giờ thành công, DBS-101), được chuyển nguyên sang DLQ trước khi xóa nguồn; nếu gửi DLQ lỗi thì giữ nguyên
  nguồn. Bản sao mang thuộc tính `OriginalSentTimestamp` (BL-210, `Number`, epoch ms): `SentTimestamp` của lần nhận (`receive` xin thêm thuộc tính hệ thống này), hoặc giá trị nhỏ hơn nếu message đã mang thuộc tính hợp lệ (đã qua DLQ và replay), vì `SendMessage` làm DLQ tính tuổi lại từ lúc chuyển. Thuộc tính sai định dạng bị bỏ qua. Công cụ `dlq:age-check` dùng nó để từ chối replay message quá 6 ngày. Nếu gửi DLQ thành công nhưng xóa nguồn sau đó lỗi, kết quả vẫn là dead-lettered (không
  phải failed) — nguồn vẫn còn hiển thị và có thể bị chuyển DLQ lại lần nữa khi redeliver, DLQ
  consumer phải chịu được việc đó. Thiếu body/receipt thì trả failed. Lỗi `receive` lan nguyên lên.
- `onApplicationShutdown()`: giải phóng socket SDK. Cố ý không dùng `onModuleDestroy` (BL-249): Nest chạy mọi `onModuleDestroy`, rồi mọi `beforeApplicationShutdown`, rồi mọi `onApplicationShutdown`; relay và consumer dừng vòng lặp (chờ lô đang chạy) ở `beforeApplicationShutdown`, nên SDK chỉ bị hủy sau khi lệnh gửi/xóa đang dở đã xong. Test gọi `onApplicationShutdown()` để dọn client.

Caller tự chịu trách nhiệm: polling chỉ chạy ở worker, dừng loop có kiểm soát, dedup, kiểm schema
sự kiện, chính sách `UNKNOWN_EVENT_TYPE`, chuyển DLQ ngay khi sai schema, và gia hạn visibility khi
xử lý quá 30 giây. Callback phải commit xong rồi mới resolve; không resolve khi rollback. Batch có
thể ngắn/rỗng. Gửi DLQ và xóa nguồn là hai thao tác riêng: vẫn có thể trùng lặp, consumer cần tự
idempotent. Không gọi SQS trong transaction tiền. Giới hạn kích thước payload thuộc việc kiểm của
relay (BL-123); adapter này dùng giới hạn của SDK/dịch vụ, không tự cắt payload.

Kiểm: `npm run test:services -- --runInBand --runTestsByPath test/services/sqs-adapter.services-spec.ts`.
Thủ công: chạy Compose ElasticMQ, `npm run build`, rồi `node scripts/manual-dbs77.cjs`. Driver dùng
queue local tạm, tự dọn ở `finally`. Không chạm tới queue AWS thật.
