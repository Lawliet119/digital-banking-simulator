# Video demo giữa kỳ

> **Status:** Chưa quay (đang chờ người thật; [DBS-140](../features/DBS-140-midterm-demo-video-prep.md), BL-390) · **Owner:** Dev · **Kịch bản:** [demo-midterm-recording.md](../demos/demo-midterm-recording.md) · **Cập nhật:** 2026-11-15

Chỗ lưu **link** video demo giữa kỳ và thông tin để người xem biết video quay trên bản nào. Không đưa file video vào git; chỉ link.

## Bản quay

| Mục | Giá trị |
|---|---|
| Link video | **chưa có** |
| Quyền xem | _điền sau khi tải lên (giảng viên và nhóm)_ |
| Ngày quay | _chưa quay_ |
| Commit đã quay (`git rev-parse HEAD`) | _chưa quay_ |
| Môi trường | _local (compose) hoặc cloud (ghi ngày phiên)_ |
| Người nói / người gõ | _chưa quay_ |
| Thời lượng thực | _mm:ss; yêu cầu 15–20 phút_ |

## Kiểm sau khi quay (tick khi đã xem lại video)

- [ ] 15–20 phút, chạy trọn bước 1–9 theo [lệnh](../demos/demo-midterm-end-to-end.md) và [kịch bản quay](../demos/demo-midterm-recording.md), một lần quay liền, không dừng ghi hay cắt ghép
- [ ] Có tiếng giải thích, nghe rõ; mỗi bước nêu vì sao trước khi gõ lệnh
- [ ] Không lộ token, mật khẩu, access key, id tài khoản AWS ở bất kỳ khung hình nào
- [ ] Dừng ở `C` (mã truy vết) ở bước 4 và dùng lại đúng `C` ở bước 8; bước 8 có bấm giờ
- [ ] Bước 6 cho thấy thân phản hồi của khách không có trường về cờ; bước 9 cho thấy hai `403` và dòng `access.denied`
- [ ] Link ở bảng trên mở được bằng tài khoản không phải của người tải lên
- [ ] Cổng ra tuần 5 «video demo toàn luồng» đã báo techlead (agent không sửa board)

## Giới hạn

- Chưa có lần quay thật: mọi dòng ở trên là mẫu chờ điền. Việc này là BL-390 trong [BACKLOG](../BACKLOG.md); xóa dòng đó khi bảng trên đã điền và checklist đã tick.
