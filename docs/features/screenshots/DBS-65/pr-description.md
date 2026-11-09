## Thay đổi gì

Thêm nghiệm thu tuần2 qua HTTP/JWT thật: hai khách tự tạo hồ sơ và mở tài khoản, operator nạp1tr, A chuyển300k cho B, list/detail trả700k/300k; đối chiếu bút toán kép, audit, outbox và năm bất biến trên PostgreSQL/Valkey thật. Có8case cho replay, actor-scoped key trên cùng endpoint, REJECTED đúngAC-5.2, ownership404, role403, input400/401 và exact2^53+1. Thêm driver local và đưa suite vào bước Testcontainers hiện có.

Task: DBS-65
Feature doc: docs/features/DBS-65-money-flow-e2e.md

G1–G4 đã được người dùng duyệt. Cloud M07 và CI negativecontrol M10 chưa chạy; báo cáo checks GitHub xem trạng thái PR hiện tại. AI-assisted: Codex.

## Loại thay đổi

- [ ] Tính năng mới
- [ ] Sửa lỗi
- [x] Hạ tầng / CI
- [x] Tài liệu / ADR (tài liệu, không đổi ADR)
- [x] Test

## Liên quan tới

UC1–5;BR01/02/03/04/05/07/09/10;FR-ID-04;FR-ACC-02;NFR-COR-02;AC-5.1/5.2/5.3/5.5/5.8. Không nhận coverage AC concurrency/midnight/kill từ suite này. Role-denial audit thiếu giữBL-132, không giả audit để pass.

## Đối chiếu test case

| DoD / AC | Test | Khớp? |
|---|---|---|
| DoD1,AC5.1 |TC-65-01 |Đạt toàn chuỗi bằng HTTP,2transfer/4ledger/2event,audit từng correlation |
| Replay AC5.3/5.5 |TC-65-02 |Đạt deposit+transfer replay,khác body422,không nhân đôi |
| BR07 scope user |TC-65-03 |Đạt hai customer/cùngendpoint/cùngkey,hai kết quả/replay riêng |
| AC5.2,REJECTED replay |TC-65-04 |Đạt fixture A100k gửi300k,REJECTED+audit/key đã commit |
| AC5.8,FR-ID04 |TC-65-05 |Đạt foreign/missing/hostile404 và DENIED riêng;không money effects |
| BR04/10 vai trò |TC-65-06 |Đạt403;role-denial audit cònBL-132 |
| BR01,exactmoney |TC-65-07 |Đạt2^53+1 quaAPI/DB/event/GET,không Number |
| Auth/input |TC-65-08 |Đạt401/400 đúng mã,không money effects |
| DoD2 CI Testcontainers |TC-65-CI,M08/M09 |Cấu hình đã thêm;local3suite13/13,cleanclone8/8,Dockerunavailableexit1;GitHubM10chưa chạyBL-199 |
| DoD3 cloud |M07 |Chưa chạyBL-198;không suy từlocal |
| DoD4 review/CI/merge |Quy trình |Chưa cóPR/Dev review/merge/CIHEAD trênGitHub,BL-199 |

## Kiểm tra

- [x] Docker Compose local đã khởi động; driver/suite dùng container/DB riêng
- [x] Có test; logic tiền trên PostgreSQL thật, Valkey và JWT/guards thật
- [ ] CI GitHub xanh (chưa chạy,BL-199)
- [x] Không có secret trong source/evidence; transcript che tên và không inJWT/credential
- [ ] Feature doc qua đủ4gate (đãG1–G3,chờG4)
- [x] Manual localM01–06 đạt trên codeSHA dff4013d9ca1c07840b58d2a429d4c635353f0f3;cleancloneM08,DockerM09đạt
- [ ] CloudM07/ảnh04-cloud.png vàGitHubM10/ảnh03-ci.png (chưa chạy)
- [x] Docs/index/backlog cập nhật,không đổiADR/schema/env/dependency/production helpers

Local validation: lint/typecheck/buildexit0;1135unit,153e2e,732DB,0failed/skip. Local CI-selected3suite13/13,checkoutclean8/8;invariantsPASS0violation. Manual driver+teeexit0. Không có actionlint cài sẵn;chưa chạy. Mermaid renderđạt;linkcheck vàdiff kiểm trong verification.txt.

## Ghi chú cho người review

Diff vượt400dòng do8case integration và driver oracle riêng cho một kịch bản nghiệm thu, cộng tài liệu gate và raw evidence bắt buộc; không ghép tính năng production khác. Bảng TC và phần snapshot kiểm tiền/audit/outbox tách audit đọc có chủ đích. Xem BL-198–186 và BL-132 trước khi chuyểnDone.

Một lần nativecrashNode24.15.0 chưa có nguyên nhân;portable24.22.2 vượt toàn bộsuite.Không coi rerunxanh là đã giải thíchcrash. Local negativecontrol thay sai expected700001 đã làmTC01đỏ,finallykhôi phục;đó không phảiCIred→greenGitHub. Sharedapi-design mới lệchretention/auditaction so vớiADR/code được bàn giaoBL-201.
