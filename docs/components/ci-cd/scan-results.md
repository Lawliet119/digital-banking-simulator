# ci-cd: kết quả quét image và secret

> **Status:** Draft · **Owner:** #5 Platform & Ops · **Verified against code:** một phần: gitleaks và Trivy (`fs` trên lockfile) đã chạy local; Trivy trên image, các lần chạy trên GitHub Actions và Draft PR thử chưa chạy · **Cập nhật:** 2026-11-12

Nguồn kết quả quét cho bản nộp P3 ([deliverables](../../deliverables/README.md)). Thiết kế và quyết định: [DBS-155](../../features/DBS-155-ci-image-secret-scan.md). Bằng chứng chạy thật (link run, ảnh) thêm vào đây khi có; mục chưa chạy ghi rõ "chưa chạy".

## Cổng quét

| Cổng | Công cụ (ghim) | Nơi chạy | Đỏ khi |
|---|---|---|---|
| `image-scan` | Trivy 0.76.1, image `ghcr.io/aquasecurity/trivy` ghim digest `sha256:790fd66d…c06c` | [`ci.yml`](../../../.github/workflows/ci.yml), mọi PR và push `main`; cờ ở [`run-trivy.sh`](../../../.github/scripts/run-trivy.sh) | lỗ hổng HIGH/CRITICAL đã có bản sửa (ngoài ngoại lệ còn hạn), hoặc secret ở mọi mức trong các lớp của image |
| `image-push` (bước Trivy) | như trên | [`image.yml`](../../../.github/workflows/image.yml), trước khi lấy credential AWS | như trên: không push, `Deploy` không chạy |
| `secret-scan` | gitleaks 8.30.1, image `ghcr.io/gitleaks/gitleaks` ghim digest `sha256:c00b6bd0…bb7f` | [`ci.yml`](../../../.github/workflows/ci.yml); cờ ở [`run-gitleaks.sh`](../../../.github/scripts/run-gitleaks.sh) | mọi phát hiện trên lịch sử tới `HEAD`, kể cả secret đã revert; repo nông; quét dưới 90% số commit |

`secret-scan` cũng chạy [`check-image-workflow.py`](../../../.github/scripts/check-image-workflow.py) (kiểm tĩnh cờ, digest, thứ tự bước) và [`check-scan-exceptions.py`](../../../.github/scripts/check-scan-exceptions.py) (ngoại lệ có lý do và hạn) trên mọi PR. Hai job mới chỉ chặn merge khi chủ repo thêm vào ruleset của `main` (BL-035, BL-012).

## Ngoại lệ

Ba file ở gốc repo, mỗi mục có lý do và hạn xem lại tối đa 90 ngày; hạn qua thì CI đỏ có chủ ý cho tới khi #5 xem lại và gia hạn bằng PR.

| File | Nội dung hiện có |
|---|---|
| [`.trivyignore.yaml`](../../../.trivyignore.yaml) | rỗng (`vulnerabilities: []`, `secrets: []`) |
| [`.gitleaks.toml`](../../../.gitleaks.toml) | 2 allowlist: khóa thử TLS `server.key` (đúng một đường dẫn, hạn 2027-02-09); Idempotency-Key dạng UUID trong `manual-test*.txt` của screenshots (hạn 2027-01-25) |
| [`.gitleaksignore`](../../../.gitleaksignore) | 8 fingerprint: 3 id container Valkey ở DBS-40 (hạn 2027-01-18), 5 giá trị thử trong spec (hạn 2027-01-04 đến 2027-01-11) |

## Kết quả đã chạy

Máy chạy: Linux, không có Docker. Binary chính thức tải về và kiểm checksum theo file của release (chi tiết ở [feature doc §8](../../features/DBS-155-ci-image-secret-scan.md#8-kết-quả)).

| Phép quét | Lệnh | Kết quả |
|---|---|---|
| gitleaks, mặc định, trước khi có cấu hình | `gitleaks git --log-opts="HEAD" --redact` (137 commit) | 122 phát hiện: 1 `private-key` (`server.key`), 121 `generic-api-key` (113 UUID Idempotency-Key, 3 id container Docker, 5 giá trị thử trong spec) |
| gitleaks, với cấu hình ở trên | `bash .github/scripts/run-gitleaks.sh` | 0 phát hiện, thoát 0 |
| Trivy `fs` trên `backend/package-lock.json`, trước khi sửa | `--scanners vuln --severity HIGH,CRITICAL --ignore-unfixed` | HIGH 3 có bản sửa (`body-parser` 2.3.0, `joi` 18.2.9, `multer` 2.4.0), MEDIUM 4, CRITICAL 0 |
| `npm audit --omit=dev`, trước khi sửa | | 10 lỗ hổng: 4 high, 6 moderate |
| `npm audit --omit=dev`, sau khi nâng lockfile | | 5 moderate, 0 high, 0 critical |

Chưa chạy: Trivy trên image thật (gói Alpine, `npm` đi kèm image `node`, secret trong các lớp), các lần chạy `image-scan` và `secret-scan` trên GitHub, Draft PR thử có dependency lỗi và secret giả (cần người dùng duyệt đẩy lên GitHub), `image.yml` thật (thiếu biến `AWS_ROLE_ARN`, BL-034).
