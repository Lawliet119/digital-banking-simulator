# <component> — Architecture

> **Status:** … (cùng định dạng dòng Status ở 01)

## 1. Cấu trúc
Bảng file/thư mục và trách nhiệm.

## 2. Dữ liệu
Bảng, kiểu, ràng buộc, index. Quy ước tiền: BIGINT / string.

## 3. Interface công khai
Hàm export qua `index.ts` (chữ ký), endpoint HTTP, event phát ra / nhận vào.

## 4. Luồng nội bộ
Sơ đồ tuần tự (Mermaid) cho mỗi luồng quan trọng; ghi rõ phần nào trong transaction.

## 5. Phụ thuộc
Gọi ai (đồng bộ / bất đồng bộ), ai gọi mình.

## 6. Phân quyền
Vai trò × endpoint; kiểm tra sở hữu.

## 7. Lỗi và sự cố
Mã lỗi (`ErrorCode`), hành vi khi dependency hỏng (Redis, DB, SQS), idempotency.
