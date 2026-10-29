Chứng chỉ thử nghiệm cho `src/database/pg-ssl.tls.spec.ts` (DBS-67), tạo bằng openssl, hạn 100 năm, **không dùng ở bất kỳ nơi nào khác**.
`ca.pem` ký `server.pem`; `other-ca.pem` là CA không liên quan (dùng để chứng minh CA sai bị từ chối).
`server.key` chỉ là khóa của chứng chỉ `CN=localhost` (SAN `localhost`, `127.0.0.1`) do `ca.pem` ký; không tin cậy CA này ở đâu ngoài test.
Khóa của CA đã xóa; muốn tạo lại thì tạo bộ mới.
Bốn file được commit có chủ đích: `.gitignore` mở đúng từng tên file, CONTRIBUTING §6 ghi ngoại lệ; `test/support/tls-fixtures.spec.ts` kiểm cả hai chiều.
