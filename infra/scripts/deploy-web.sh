#!/usr/bin/env bash
# Giao diện v2: build frontend, đẩy lên bucket web, ghi /config.json (user pool), xóa cache CloudFront.
# Cần stack session đã apply với web_enabled = true (infra/terraform/envs/dev/session/web.tf) và stack base.
#
# Dùng:  AWS_PROFILE=dbs bash infra/scripts/deploy-web.sh [--dry-run] [--skip-build]
#   --dry-run     chỉ in kế hoạch, không gọi AWS (vẫn đọc output Terraform)
#   --skip-build  dùng frontend/dist có sẵn (vẫn kiểm bản build không chứa đăng nhập local)
#
# File trong assets/ có hash trong tên: cache một năm. index.html và config.json: no-cache, để bản mới
# có hiệu lực ngay. Không đẩy source map (*.map).
set -euo pipefail

DRY_RUN=0
SKIP_BUILD=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --skip-build) SKIP_BUILD=1 ;;
    *) echo "Tham số lạ: $arg" >&2; exit 2 ;;
  esac
done

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
TF="${TF:-terraform}"
SESSION="$ROOT/infra/terraform/envs/dev/session"
BASE="$ROOT/infra/terraform/envs/dev/base"

output() { "$TF" -chdir="$1" output -raw "$2" 2>/dev/null || true; }

BUCKET="$(output "$SESSION" web_bucket)"
DISTRIBUTION="$(output "$SESSION" web_distribution_id)"
URL="$(output "$SESSION" web_url)"
POOL_ID="$(output "$BASE" cognito_user_pool_id)"
CLIENT_ID="$(output "$BASE" cognito_client_id)"
REGION="${AWS_REGION:-ap-southeast-1}"

if [ -z "$BUCKET" ] || [ "$BUCKET" = "null" ] || [ -z "$DISTRIBUTION" ] || [ "$DISTRIBUTION" = "null" ]; then
  echo "Stack session chưa bật web (web_enabled = true) hoặc chưa apply: không có web_bucket / web_distribution_id." >&2
  exit 1
fi
if [ -z "$POOL_ID" ] || [ -z "$CLIENT_ID" ]; then
  echo "Không đọc được cognito_user_pool_id / cognito_client_id từ stack base." >&2
  exit 1
fi
case "$POOL_ID" in
  "$REGION"_*) ;;
  *) echo "User pool $POOL_ID không thuộc vùng $REGION (đặt AWS_REGION)." >&2; exit 1 ;;
esac

CONFIG="$(printf '{"region":"%s","userPoolId":"%s","userPoolClientId":"%s"}' "$REGION" "$POOL_ID" "$CLIENT_ID")"

echo "Bucket:       $BUCKET"
echo "Distribution: $DISTRIBUTION"
echo "Địa chỉ:      $URL"
echo "config.json:  $CONFIG"

cd "$ROOT/frontend"
if [ "$SKIP_BUILD" -eq 0 ]; then
  npm ci --no-audit --no-fund
  npm run build
fi
npm run --silent check:dist
[ -f dist/index.html ] || { echo "Thiếu frontend/dist/index.html: chạy lại không có --skip-build." >&2; exit 1; }

if [ "$DRY_RUN" -eq 1 ]; then
  echo "--dry-run: dừng trước khi đẩy lên S3."
  exit 0
fi

aws s3 sync dist/assets "s3://$BUCKET/assets" --exclude "*.map" \
  --cache-control "public,max-age=31536000,immutable" --only-show-errors
aws s3 sync dist "s3://$BUCKET" --exclude "assets/*" --exclude "*.map" --exclude "config.json" \
  --cache-control "no-cache" --only-show-errors
printf '%s' "$CONFIG" | aws s3 cp - "s3://$BUCKET/config.json" \
  --content-type application/json --cache-control "no-cache" --only-show-errors
# Bản cũ: file không còn trong dist (trừ config.json) bị xóa sau khi bản mới đã lên.
aws s3 sync dist "s3://$BUCKET" --delete --exclude "*.map" --exclude "config.json" --only-show-errors

aws cloudfront create-invalidation --distribution-id "$DISTRIBUTION" --paths "/*" \
  --query 'Invalidation.Id' --output text

echo "Xong: $URL"
