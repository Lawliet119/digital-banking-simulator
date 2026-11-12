#!/usr/bin/env bash
# DBS-139: in access token Cognito (ra stdout, đúng một dòng) của tài khoản nhân viên demo.
#
# Dùng:  COGNITO_CLIENT_ID=<id> AWS_PROFILE=dbs-admin bash infra/scripts/demo-token.sh --role operator|auditor|admin
#   COGNITO_CLIENT_ID  mặc định lấy từ: terraform -chdir=infra/terraform/envs/dev/base output -raw cognito_client_id
#   SECRET_NAME        mặc định dbs/dev/demo-accounts (nguồn mật khẩu, do seed-cognito.sh ghi, DBS-54)
#
# Token sống 15 phút (DBS-54): lấy SAU khi hệ thống đã lên. Customer không có ở đây (tài khoản khách hàng demo
# trên cloud chưa có script, xem BACKLOG). Mật khẩu chỉ đi qua stdin (file:///dev/stdin), không bao giờ trên argv,
# không vào môi trường tiến trình con, không ghi tệp; không dùng set -x hay --debug.
# Thoát: 0 in token; 1 chưa seed, Cognito từ chối hoặc trả thử thách; 2 dùng sai.
set -euo pipefail

REGION="ap-southeast-1"
SECRET_NAME="${SECRET_NAME:-dbs/dev/demo-accounts}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

usage() { echo "Dùng: demo-token.sh --role operator|auditor|admin" >&2; exit 2; }

[ "$#" -eq 2 ] && [ "$1" = "--role" ] || usage
ROLE="$2"
case "$ROLE" in operator | auditor | admin) ;; *) usage ;; esac

CLIENT_ID="${COGNITO_CLIENT_ID:-}"
if [ -z "$CLIENT_ID" ] && command -v terraform >/dev/null 2>&1; then
  CLIENT_ID="$(terraform -chdir="$HERE/../terraform/envs/dev/base" output -raw cognito_client_id 2>/dev/null || true)"
fi
if [ -z "$CLIENT_ID" ]; then
  echo "Thiếu COGNITO_CLIENT_ID (terraform -chdir=infra/terraform/envs/dev/base output -raw cognito_client_id)." >&2
  exit 1
fi

if ! SECRET_DOC="$(aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --region "$REGION" \
  --query SecretString --output text 2>/dev/null)"; then
  echo "Không đọc được secret $SECRET_NAME: chưa seed? Chạy: bash infra/scripts/seed-cognito.sh" >&2
  exit 1
fi

# JSON {USERNAME, PASSWORD} dựng từ secret, đi vào stdin của aws qua --auth-parameters file:///dev/stdin
# (đo thật ở M-139-03: --cli-input-json file:///dev/stdin báo "Invalid JSON received"). Không tệp tạm.
if ! REQUEST="$(printf '%s' "$SECRET_DOC" | python3 -c '
import json, sys
role, client = sys.argv[1], sys.argv[2]
user = json.load(sys.stdin)["users"][role]
sys.stdout.write(json.dumps({"USERNAME": user["email"], "PASSWORD": user["password"]}))
' "$ROLE" "$CLIENT_ID" 2>/dev/null)"; then
  echo "Secret $SECRET_NAME chưa có tài khoản $ROLE. Chạy: bash infra/scripts/seed-cognito.sh" >&2
  exit 1
fi
unset SECRET_DOC

if ! TOKEN="$(printf '%s' "$REQUEST" | aws cognito-idp initiate-auth \
  --auth-flow USER_PASSWORD_AUTH --client-id "$CLIENT_ID" --auth-parameters file:///dev/stdin \
  --region "$REGION" --query AuthenticationResult.AccessToken --output text 2>/dev/null)"; then
  unset REQUEST
  echo "Cognito từ chối đăng nhập của $ROLE (sai mật khẩu hoặc tài khoản chưa seed): chạy lại seed-cognito.sh." >&2
  exit 1
fi
unset REQUEST

if ! [[ "$TOKEN" =~ ^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$ ]]; then
  echo "Cognito không trả access token (thử thách hoặc phản hồi lạ, ví dụ NEW_PASSWORD_REQUIRED): chạy lại seed-cognito.sh." >&2
  exit 1
fi
printf '%s\n' "$TOKEN"
