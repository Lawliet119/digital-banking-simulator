#!/usr/bin/env bash
# Chạy gitleaks trên lịch sử tới HEAD và chặn kết quả xanh giả (DBS-155, feature doc H2).
#
# Biến môi trường:
#   GITLEAKS_RUN  lệnh chạy gitleaks: `docker run ... <image@digest>` trong workflow, đường dẫn binary khi thử local
#   SCAN_PATH     đường dẫn repo như gitleaks nhìn thấy (/repo trong container)
#   REPO_DIR      đường dẫn repo trên máy chạy script (mặc định thư mục hiện tại), dùng cho các lệnh git
#   CONFIG, IGNORE  đường dẫn .gitleaks.toml và .gitleaksignore như gitleaks nhìn thấy (rỗng thì không dùng)
#   LOG           file ghi log gitleaks
#
# Đỏ khi: gitleaks báo phát hiện; repo nông; gitleaks không quét commit nào; gitleaks quét dưới 90% số commit
# không phải merge tới HEAD. Không so bằng số commit: gitleaks không đếm commit chỉ đổi mode, chỉ đổi tên,
# rỗng hay chỉ xóa file.
set -euo pipefail

: "${GITLEAKS_RUN:?cần GITLEAKS_RUN}" "${SCAN_PATH:?cần SCAN_PATH}" "${LOG:?cần LOG}"
REPO_DIR="${REPO_DIR:-$PWD}"

read -r -a runner <<<"$GITLEAKS_RUN"
opts=(--no-color --no-banner --redact --exit-code 1 --verbose)
if [ -n "${CONFIG:-}" ]; then opts+=(--config "$CONFIG"); fi
if [ -n "${IGNORE:-}" ]; then opts+=(--gitleaks-ignore-path "$IGNORE"); fi

set +e
"${runner[@]}" git "$SCAN_PATH" --log-opts="HEAD" "${opts[@]}" 2>&1 | tee "$LOG"
rc=${PIPESTATUS[0]}
set -e

fail=0
if [ "$(git -C "$REPO_DIR" rev-parse --is-shallow-repository)" != "false" ]; then
  echo "LỖI: repo nông (cần checkout fetch-depth: 0), kết quả quét không đáng tin" >&2
  fail=1
fi
scanned="$(sed -n 's/.* \([0-9][0-9]*\) commits scanned.*/\1/p' "$LOG" | tail -n 1)"
total="$(git -C "$REPO_DIR" rev-list --count --no-merges HEAD)"
min=$(( (total * 9 + 9) / 10 ))
if [ -z "$scanned" ] || [ "$scanned" -lt 1 ]; then
  echo "LỖI: gitleaks không quét commit nào (mount sai, safe.directory hoặc lỗi công cụ)" >&2
  fail=1
elif [ "$scanned" -lt "$min" ]; then
  echo "LỖI: gitleaks chỉ quét $scanned commit, cần ít nhất $min (90% của $total commit không phải merge)" >&2
  fail=1
fi
echo "gitleaks: rc=$rc, đã quét ${scanned:-0} commit, repo có $total commit không phải merge, ngưỡng tối thiểu $min"

if [ "$rc" -ne 0 ]; then exit "$rc"; fi
exit "$fail"
