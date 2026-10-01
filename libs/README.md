# libs

Thư viện dùng chung giữa `apps/api` và `apps/worker`.

| Thư viện | Nội dung |
|---|---|
| `shared` | Shared kernel: `Money` (bigint, đồng), `CorrelationId`, lỗi chuẩn (`problem+json`), cấu hình |
| `audit` | Ghi nhật ký kiểm toán **trong transaction của module gọi** |
| `events` | Định nghĩa event contract (`TransferCompleted`, …) và bảng định tuyến queue |

Không đặt logic nghiệp vụ của một module cụ thể vào đây.
