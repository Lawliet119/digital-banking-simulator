Chứng chỉ thử nghiệm cho `pg-ssl.spec.ts` (DBS-67), tạo bằng openssl, hạn 100 năm, **không dùng ở bất kỳ nơi nào khác**.
`ca.pem` ký `server.pem`; `other-ca.pem` là CA không liên quan (dùng để chứng minh CA sai bị từ chối).
Khóa của CA đã xóa; muốn tạo lại thì tạo bộ mới.
