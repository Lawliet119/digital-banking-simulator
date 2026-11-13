#!/usr/bin/env bash
# Quét một image đã build bằng Trivy, không dùng docker.sock (DBS-155, feature doc H1 và H3).
# Dùng chung cho ci.yml (job image-scan) và image.yml (trước khi có credential AWS).
#
# Cách dùng, từ gốc repo:  TRIVY_IMAGE=ghcr.io/aquasecurity/trivy:<ver>@sha256:<digest> bash .github/scripts/run-trivy.sh <image:tag>
#
# Container Trivy chỉ thấy: thư mục cache DB, file tar của image và .trivyignore.yaml (chỉ đọc). Không socket,
# không biến môi trường của job. Ba lượt quét chạy --network none; chỉ lượt tải DB có mạng và không thấy image.
#   (a) lỗ hổng HIGH/CRITICAL đã có bản sửa, ngoài ngoại lệ còn hạn: đỏ
#   (b) secret ở mọi mức trong các lớp của image: đỏ
#   (c) HIGH/CRITICAL kể cả chưa có bản sửa: chỉ in
set -euo pipefail

: "${TRIVY_IMAGE:?cần TRIVY_IMAGE (image Trivy ghim digest)}"
IMAGE_REF="${1:?cần tên image:tag để quét}"
DB_REPOSITORY="${TRIVY_DB_REPOSITORY:-mirror.gcr.io/aquasec/trivy-db:2,ghcr.io/aquasecurity/trivy-db:2}"
WORK="${RUNNER_TEMP:-$(mktemp -d)}/trivy"
mkdir -p "$WORK/cache"

# Thiếu file thì `docker run -v` tạo thư mục rỗng và Trivy báo lỗi khó hiểu: dừng sớm.
test -f .trivyignore.yaml

docker save -o "$WORK/img.tar" "$IMAGE_REF"
docker run --rm -v "$WORK/cache:/cache" "$TRIVY_IMAGE" image --cache-dir /cache --download-db-only --db-repository "$DB_REPOSITORY"

scan() {
  docker run --rm --network none -v "$WORK/cache:/cache" -v "$WORK/img.tar:/scan/img.tar:ro" -v "$PWD/.trivyignore.yaml:/scan/.trivyignore.yaml:ro" "$TRIVY_IMAGE" image --cache-dir /cache --skip-db-update --skip-java-db-update --offline-scan --input /scan/img.tar --ignorefile /scan/.trivyignore.yaml "$@"
}

rc=0
scan --scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1 || rc=1
scan --scanners secret --exit-code 1 || rc=1
scan --scanners vuln --severity HIGH,CRITICAL --exit-code 0 || echo "::warning::lượt in HIGH/CRITICAL chưa có bản sửa gặp lỗi"
exit "$rc"
