#!/usr/bin/env bash
# DBS-54: tạo tài khoản nhân viên demo (operator, auditor, admin) trong Cognito.
#
# Secrets Manager (dbs/dev/demo-accounts) là NGUỒN SỰ THẬT của mật khẩu: mật khẩu được ghi vào secret
# TRƯỚC khi đặt cho user, nên lỗi giữa chừng không làm mất mật khẩu nào; chạy lại là đủ.
# Mật khẩu không bao giờ nằm trên argv (cả aws lẫn python3): chỉ đi qua stdin (file:///dev/stdin).
# Không dùng set -x, --debug hay tệp tạm.
#
# Dùng:  COGNITO_USER_POOL_ID=<id> bash infra/scripts/seed-cognito.sh [--dry-run] [--rotate]
#   COGNITO_USER_POOL_ID  lấy bằng: terraform -chdir=infra/terraform/envs/dev/base output -raw cognito_user_pool_id
#   SECRET_NAME           mặc định dbs/dev/demo-accounts
#   --rotate              sinh mật khẩu mới cho cả ba, đặt lại và sign-out phiên cũ
#   --dry-run             chỉ in kế hoạch, không gọi AWS
set -euo pipefail

SECRET_NAME="${SECRET_NAME:-dbs/dev/demo-accounts}"
ROTATE=0
DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --rotate) ROTATE=1 ;;
    --dry-run) DRY_RUN=1 ;;
    *) echo "Tham số lạ: $arg" >&2; exit 2 ;;
  esac
done

# vai trò = nhóm Cognito = khóa trong secret; email dùng đuôi .invalid (không bao giờ gửi được thư)
ROLES=(operator auditor admin)
email_of() { printf '%s.demo@dbs.invalid' "$1"; }

if [ -z "${COGNITO_USER_POOL_ID:-}" ]; then
  echo "Thiếu COGNITO_USER_POOL_ID (terraform -chdir=infra/terraform/envs/dev/base output -raw cognito_user_pool_id)" >&2
  exit 2
fi

if [ "$DRY_RUN" = 1 ]; then
  echo "[dry-run] pool: $COGNITO_USER_POOL_ID, secret: $SECRET_NAME, rotate: $ROTATE"
  echo "[dry-run] 1. đọc secret; thiếu thì sinh mật khẩu và ghi secret TRƯỚC (create-secret có tag project/env/owner)"
  for r in "${ROLES[@]}"; do
    echo "[dry-run] 2. $(email_of "$r"): tạo user (--message-action SUPPRESS) nếu chưa có, đặt mật khẩu từ secret (--permanent), nhóm = $r, email_verified = true"
  done
  [ "$ROTATE" = 1 ] && echo "[dry-run] 3. rotate: mật khẩu mới ghi secret trước, rồi sign-out cả ba"
  echo "[dry-run] không gọi AWS, không in mật khẩu"
  exit 0
fi

ERR="$(mktemp -d)" || exit 1 # chỉ chứa stderr của aws (không có mật khẩu), xóa khi thoát
trap 'rm -rf "$ERR"' EXIT
ROLES_CSV="${ROLES[*]}"

# --- python chỉ nhận bí mật qua stdin; argv chỉ chứa tên vai trò (không bao giờ bí mật) ---
doc_missing_roles() { # in các vai trò chưa có trong secret, cách nhau bằng dấu cách
  python3 -c '
import json, sys
have = json.load(sys.stdin).get("users", {})
print(" ".join(r for r in sys.argv[1:] if r not in have), end="")
' "${ROLES[@]}"
}

doc_pending() { # in các vai trò còn chờ sign-out
  python3 -c '
import json, sys
print(" ".join(json.load(sys.stdin).get("pending_signout", [])), end="")
'
}

# Dựng JSON secret: python đọc json hiện có từ stdin, sinh mật khẩu cho các vai trò chỉ định.
build_doc() { # stdin: json hiện có hoặc rỗng; $1: vai trò cần mật khẩu mới; $2: vai trò pending sign-out (hoặc "-")
  python3 -c '
import json, secrets, sys
raw = sys.stdin.read()
doc = json.loads(raw) if raw.strip() else {}
doc.setdefault("users", {})
fresh = sys.argv[1].split()
pending = [] if sys.argv[2] == "-" else sys.argv[2].split()
sets = ["ABCDEFGHJKLMNPQRSTUVWXYZ", "abcdefghijkmnopqrstuvwxyz", "23456789", "-_.!@#%^*+"]
def pw():
    chars = [secrets.choice(s) for s in sets]
    allc = "".join(sets)
    chars += [secrets.choice(allc) for _ in range(24 - len(chars))]
    secrets.SystemRandom().shuffle(chars)
    return "".join(chars)
for role in fresh:
    doc["users"][role] = {"email": role + ".demo@dbs.invalid", "password": pw()}
if pending:
    doc["pending_signout"] = sorted(set(doc.get("pending_signout", [])) | set(pending))
sys.stdout.write(json.dumps(doc))
' "$1" "$2"
}

# --- Secrets Manager ---
SECRET_DOC=""
read_secret() { # đặt SECRET_DOC; trả 0 nếu có, 3 nếu chưa có; lỗi khác thì thoát
  local out rc=0
  out="$(aws secretsmanager get-secret-value --secret-id "$SECRET_NAME" --query SecretString --output text 2>"$ERR/get")" || rc=$?
  if [ "$rc" -eq 0 ]; then SECRET_DOC="$out"; return 0; fi
  if grep -q 'ResourceNotFoundException' "$ERR/get"; then return 3; fi
  echo "Không đọc được secret $SECRET_NAME (không phải 'chưa có'):" >&2
  cat "$ERR/get" >&2
  exit 1
}

write_secret() { # stdin: json; $1: put | create
  if [ "$1" = create ]; then
    aws secretsmanager create-secret --name "$SECRET_NAME" \
      --description "Mat khau tai khoan nhan vien demo (DBS-54)" \
      --tags Key=project,Value=dbs Key=env,Value=dev Key=owner,Value=platform \
      --secret-string file:///dev/stdin >/dev/null 2>"$ERR/write"
  else
    aws secretsmanager put-secret-value --secret-id "$SECRET_NAME" \
      --secret-string file:///dev/stdin >/dev/null 2>"$ERR/write"
  fi
}

attempt=0
while true; do
  rc=0; read_secret || rc=$?
  [ "$rc" -eq 0 ] && break
  # chưa có: ghi secret mới với mật khẩu cho cả ba, TRƯỚC khi đụng Cognito
  wrc=0
  printf '' | build_doc "${ROLES[*]}" - | write_secret create || wrc=$?
  if [ "$wrc" -eq 0 ]; then continue; fi
  if grep -q 'ResourceExistsException' "$ERR/write"; then
    attempt=$((attempt + 1))
    if [ "$attempt" -ge 3 ]; then
      echo "Secret $SECRET_NAME đã tồn tại nhưng không đọc được giá trị (thiếu phiên bản AWSCURRENT?). Ghi giá trị bằng tay hoặc xóa secret rồi chạy lại." >&2
      exit 1
    fi
    continue
  fi
  echo "Không tạo được secret:" >&2; cat "$ERR/write" >&2; exit 1
done

# bổ sung vai trò còn thiếu trong secret
missing="$(printf '%s' "$SECRET_DOC" | doc_missing_roles)"
if [ -n "$missing" ] || [ "$ROTATE" = 1 ]; then
  if [ "$ROTATE" = 1 ]; then fresh="${ROLES[*]}"; pend="${ROLES[*]}"; else fresh="$missing"; pend="-"; fi
  printf '%s' "$SECRET_DOC" | build_doc "$fresh" "$pend" | write_secret put || { cat "$ERR/write" >&2; exit 1; }
  read_secret || { echo "Không đọc lại được secret sau khi ghi" >&2; exit 1; }
fi

# --- Cognito: đặt user đúng theo secret (luôn đọc lại AWSCURRENT, không dùng bản trong bộ nhớ) ---
for role in "${ROLES[@]}"; do
  email="$(email_of "$role")"
  rc=0
  aws cognito-idp admin-get-user --user-pool-id "$COGNITO_USER_POOL_ID" --username "$email" >/dev/null 2>"$ERR/user" || rc=$?
  if [ "$rc" -ne 0 ]; then
    if ! grep -q 'UserNotFoundException' "$ERR/user"; then cat "$ERR/user" >&2; exit 1; fi
    aws cognito-idp admin-create-user --user-pool-id "$COGNITO_USER_POOL_ID" --username "$email" \
      --message-action SUPPRESS \
      --user-attributes "Name=email,Value=$email" "Name=email_verified,Value=true" >/dev/null
  fi
  printf '%s' "$SECRET_DOC" | python3 -c '
import json, sys
sys.stdout.write(json.load(sys.stdin)["users"][sys.argv[1]]["password"])
' "$role" |
    aws cognito-idp admin-set-user-password --user-pool-id "$COGNITO_USER_POOL_ID" --username "$email" \
      --password file:///dev/stdin --permanent
  aws cognito-idp admin-update-user-attributes --user-pool-id "$COGNITO_USER_POOL_ID" --username "$email" \
    --user-attributes Name=email_verified,Value=true
  # đúng một nhóm: gỡ nhóm thừa rồi gán nhóm đúng
  for g in $(aws cognito-idp admin-list-groups-for-user --user-pool-id "$COGNITO_USER_POOL_ID" --username "$email" \
    --query 'Groups[].GroupName' --output text); do
    if [ "$g" != "$role" ]; then
      aws cognito-idp admin-remove-user-from-group --user-pool-id "$COGNITO_USER_POOL_ID" --username "$email" --group-name "$g"
    fi
  done
  aws cognito-idp admin-add-user-to-group --user-pool-id "$COGNITO_USER_POOL_ID" --username "$email" --group-name "$role"
  echo "OK: $role ($email)"
done

# --- sign-out các phiên cũ còn chờ (rotate đang dở hoặc vừa rotate), rồi xóa cờ ---
pending="$(printf '%s' "$SECRET_DOC" | doc_pending)"
if [ -n "$pending" ]; then
  for role in $pending; do
    aws cognito-idp admin-user-global-sign-out --user-pool-id "$COGNITO_USER_POOL_ID" --username "$(email_of "$role")"
  done
  printf '%s' "$SECRET_DOC" | python3 -c '
import json, sys
d = json.load(sys.stdin)
d.pop("pending_signout", None)
sys.stdout.write(json.dumps(d))
' | write_secret put || { cat "$ERR/write" >&2; exit 1; }
  echo "Đã sign-out phiên cũ của: $pending"
fi
echo "Xong. Mật khẩu ở Secrets Manager: $SECRET_NAME"
