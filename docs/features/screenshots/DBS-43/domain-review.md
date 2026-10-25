# DBS-43 domain review (independent subagent, 2026-10-25)

| Mức | Phát hiện | Cách xử lý |
|---|---|---|
| Blocking | Chưa có consumer chạy thật trong `backend/src/modules/index.ts`; DBS-43 chưa thể chứng minh tích hợp message → consumer bằng runtime. | Cung cấp hàm bao callback xử lý message, test nó; ghi phần tích hợp consumer thật vào backlog và PR. |
| Should-fix | Event contract bắt buộc `correlationId`, nhưng DoD yêu cầu sinh ID nếu message thiếu. | Tạo context trước khi validate; vẫn từ chối message sai schema, không sửa payload. |
| Should-fix | `APP_ROLE=both` mặc định log `role=api`. | Trong callback worker, gắn `role=worker` và kiểm bằng test. |
| Should-fix | Test cần chứng minh context của service con và hai request thực sự chồng lấp. | Dùng HTTP e2e với barrier bất đồng bộ, kiểm header và log JSON của từng request. |

**Verdict: REVISE** cho phương án tuyên bố hoàn tất toàn bộ DoD khi chưa có consumer thật.
