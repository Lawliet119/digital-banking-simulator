#!/usr/bin/env bash
# Quét một image đã build bằng Trivy, không dùng docker.sock (DBS-155, feature doc H1 và H3).
# Dùng chung cho ci.yml (job image-scan) và image.yml (trước khi có credential AWS).
#
# Cách dùng, từ gốc repo:  TRIVY_IMAGE=ghcr.io/aquasecurity/trivy:<ver>@sha256:<digest> bash .github/scripts/run-trivy.sh <image:tag>
#
# BL-245: trước khi chạy image Trivy, `cosign verify` chữ ký keyless của nó (Sigstore, OIDC của GitHub Actions):
# chứng chỉ phải do workflow release của aquasecurity/trivy ở đúng tag của image (identity chốt theo phiên bản),
# issuer là token.actions.githubusercontent.com. Cần `cosign` trong PATH (workflow cài bằng sigstore/cosign-installer
# ghim SHA). Chạy tay không có cosign: TRIVY_SKIP_COSIGN=1 (cảnh báo; check-image-workflow.py cấm biến này trong workflow).
#
# Container Trivy chỉ thấy: thư mục cache DB, file tar của image và .trivyignore.yaml (chỉ đọc). Không socket,
# không biến môi trường của job. Ba lượt quét chạy --network none; chỉ lượt tải DB có mạng và không thấy image.
#   (a) lỗ hổng HIGH/CRITICAL đã có bản sửa, ngoài ngoại lệ còn hạn: đỏ
#   (b) secret ở mọi mức trong các lớp của image: đỏ
#   (c) HIGH/CRITICAL kể cả chưa có bản sửa: chỉ in
set -euo pipefail

: "${TRIVY_IMAGE:?cần TRIVY_IMAGE (image Trivy ghim digest)}"
IMAGE_REF="${1:?cần tên image:tag để quét}"

# --- Kiểm chữ ký image Trivy (BL-245): dừng trước mọi lệnh docker nếu sai ---
if [ "${TRIVY_SKIP_COSIGN:-0}" = "1" ]; then
  echo "::warning::TRIVY_SKIP_COSIGN=1: bỏ qua kiểm chữ ký cosign của image Trivy (chỉ dùng khi chạy tay)."
else
  if ! [[ "$TRIVY_IMAGE" =~ ^ghcr\.io/aquasecurity/trivy:([0-9]+\.[0-9]+\.[0-9]+)@sha256:[0-9a-f]{64}$ ]]; then
    echo "::error::TRIVY_IMAGE phải có dạng ghcr.io/aquasecurity/trivy:<x.y.z>@sha256:<64 hex>, nhận được '${TRIVY_IMAGE}'" >&2
    exit 1
  fi
  trivy_version="${BASH_REMATCH[1]}"
  # Dấu chấm viết [.] cho khỏi lẫn với dấu gạch chéo ngược của shell.
  identity_re="^https://github[.]com/aquasecurity/trivy/[.]github/workflows/[A-Za-z0-9._-]+[.]ya?ml@refs/tags/v${trivy_version//./[.]}\$"
  command -v cosign >/dev/null || { echo "::error::Không có cosign trong PATH để kiểm chữ ký image Trivy (workflow: bước sigstore/cosign-installer)." >&2; exit 1; }
  cosign verify "$TRIVY_IMAGE" \
    --certificate-identity-regexp "$identity_re" \
    --certificate-oidc-issuer "https://token.actions.githubusercontent.com" >/dev/null
  echo "cosign: chữ ký image Trivy ${trivy_version} hợp lệ (workflow release của aquasecurity/trivy)."
fi
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
