#!/usr/bin/env bash
# BL-252: seed dữ liệu demo lên môi trường dev bằng một task ECS Fargate chạy một lần TRONG VPC, không đi qua ALB.
#
# Vì sao: ALB dev dùng chứng chỉ tự ký (CN dbs-dev.local) nên Node từ chối TLS, và không có cách tin cậy nó mà không
# tắt kiểm chứng chỉ. Task trong VPC gọi thẳng một task api qua HTTP cổng 3000 (ALB cũng nói HTTP với task, nên không
# mất lớp mã hóa nào). Seed vẫn chỉ nói chuyện qua API (BL-213: chạy lại an toàn).
#
# Dùng (cần session đang chạy, một image đã có dist/scripts/seed-cloud.js, tài khoản demo đã seed-cognito.sh):
#   AWS_PROFILE=dbs-admin bash infra/scripts/seed-cloud.sh [--dry-run]
#
# Biến (tùy chọn):
#   IMAGE_TAG                         SHA 40 ký tự; mặc định đúng image đang chạy của service api
#   DBS_OPERATOR_TOKEN, DBS_CUSTOMER_{1,2,3}_TOKEN
#                                     token có sẵn; thiếu thì lấy mới bằng infra/scripts/demo-token.sh (tài khoản
#                                     operator và customer1..3 trong secret dbs/dev/demo-accounts)
#   SEED_SECURITY_GROUP               mặc định tra SG theo tên dbs-dev-seed (base/seed_task.tf)
#   CLUSTER (dbs-dev), SERVICE (api), SEED_FAMILY (dbs-seed), SEED_DEADLINE_SECONDS (300), POLL_SECONDS (5)
#
# Luồng: đọc mạng của service api, tìm IP riêng của một task api đang RUNNING, đăng ký revision dbs-seed (chỉ đổi
# image), run-task với SG dbs-dev-seed, ghi đè `command` (--url http://<ip>:3000) và `environment` (token), chờ
# STOPPED, đọc exitCode của container `seed`, in log của task (bản tóm tắt seed). Thoát 0 chỉ khi container thoát 0.
#
# Token và an toàn: token Cognito sống 15 phút, lấy ngay trước run-task và đi vào task bằng `containerOverrides` (file
# JSON trong thư mục tạm 0700, xóa khi thoát; không nằm trên argv, không in ra). Hệ quả cần biết: ECS lưu overrides
# nên token hiện trong `ecs describe-tasks` (khoảng một giờ sau khi task dừng), trong lịch sử `RunTask` của CloudTrail
# và trên console ECS cho ai có quyền đọc ECS; chúng hết hạn sau 15 phút. Chọn cách này thay vì để task tự đăng nhập
# vì cách kia đòi task role đọc secret `dbs/dev/demo-accounts` (mật khẩu bền của mọi tài khoản demo, kể cả admin).
# Không dùng set -x hay --debug.
set -euo pipefail

CLUSTER="${CLUSTER:-dbs-dev}"
SERVICE="${SERVICE:-api}"
FAMILY="${SEED_FAMILY:-dbs-seed}"
CONTAINER="seed"
SEED_SG_NAME="dbs-dev-seed"
API_PORT=3000
DEADLINE_SECONDS="${SEED_DEADLINE_SECONDS:-300}"
STOP_WAIT_SECONDS="${SEED_STOP_WAIT_SECONDS:-120}"
POLL_SECONDS="${POLL_SECONDS:-5}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDER="${RENDER_TASK_DEFINITION:-$HERE/../../.github/scripts/render-task-definition.py}"
DEMO_TOKEN="${DEMO_TOKEN_SCRIPT:-$HERE/demo-token.sh}"
JWT_RE='^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$'

DRY_RUN=0
case "${1:-}" in
  "") ;;
  --dry-run) DRY_RUN=1 ;;
  *) echo "Dùng: seed-cloud.sh [--dry-run]" >&2; exit 2 ;;
esac

umask 077
TMP="$(mktemp -d)" # chứa JSON overrides có token: 0700, luôn xóa khi thoát
trap 'rm -rf "$TMP"' EXIT

jget() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"; }
jjson() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(eval(sys.argv[1])))' "$1"; }

# --- 1. Service api: mạng (subnet, IP công cộng để kéo ECR/ghi log, không NAT) và task definition đang chạy ---
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json >"$TMP/svc.json"
if ! SUBNETS="$(jjson 'd["services"][0]["networkConfiguration"]["awsvpcConfiguration"]["subnets"]' <"$TMP/svc.json" 2>/dev/null)"; then
  echo "Service $SERVICE không có cấu hình mạng awsvpc: stack session chưa dựng?" >&2
  exit 1
fi
ASSIGN_IP="$(jget 'd["services"][0]["networkConfiguration"]["awsvpcConfiguration"]["assignPublicIp"]' <"$TMP/svc.json")"
SERVICE_TD="$(jget 'd["services"][0]["taskDefinition"]' <"$TMP/svc.json")"

# --- 2. SG của task seed (không ingress; được phép vào cổng 3000 của task api) ---
SG="${SEED_SECURITY_GROUP:-}"
if [ -z "$SG" ]; then
  SG="$(aws ec2 describe-security-groups --filters "Name=group-name,Values=$SEED_SG_NAME" \
    --query 'SecurityGroups[0].GroupId' --output text)"
fi
if ! [[ "$SG" =~ ^sg-[0-9a-f]+$ ]]; then
  echo "Không thấy security group $SEED_SG_NAME: chạy terraform apply ở envs/dev/base (BL-252)." >&2
  exit 1
fi

# --- 3. IP riêng của một task api đang RUNNING (gọi thẳng, không qua ALB) ---
aws ecs list-tasks --cluster "$CLUSTER" --service-name "$SERVICE" --desired-status RUNNING --output json >"$TMP/api-tasks.json"
api_arns="$(jget '" ".join(d["taskArns"])' <"$TMP/api-tasks.json")"
if [ -z "$api_arns" ]; then
  echo "Service $SERVICE không có task RUNNING: dựng session và chờ api lên rồi chạy lại." >&2
  exit 1
fi
# shellcheck disable=SC2086 # tách ARN theo khoảng trắng là chủ ý
aws ecs describe-tasks --cluster "$CLUSTER" --tasks $api_arns --output json >"$TMP/api-desc.json"
API_IP="$(jget '(lambda ips: ips[0] if ips else "")([x["value"] for t in d["tasks"] if t.get("lastStatus") == "RUNNING" for a in t.get("attachments", []) if a.get("type") == "ElasticNetworkInterface" for x in a.get("details", []) if x["name"] == "privateIPv4Address"])' <"$TMP/api-desc.json")"
if ! [[ "$API_IP" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]]; then
  echo "Không đọc được IP riêng của task $SERVICE đang RUNNING." >&2
  exit 1
fi
API_URL="http://${API_IP}:${API_PORT}"

# --- 4. Image: mặc định đúng image đang chạy của service api ---
TAG="${IMAGE_TAG:-}"
if [ -z "$TAG" ]; then
  aws ecs describe-task-definition --task-definition "$SERVICE_TD" --output json >"$TMP/api-td.json"
  api_image="$(jget '[c["image"] for c in d["taskDefinition"]["containerDefinitions"] if c["name"] == "api"][0]' <"$TMP/api-td.json")"
  TAG="${api_image##*:}"
fi
if ! [[ "$TAG" =~ ^[0-9a-f]{40}$ ]]; then
  echo "IMAGE_TAG phải là SHA đầy đủ 40 ký tự hex (không dùng latest), nhận được '${TAG}'" >&2
  exit 1
fi

# --- 5. Không chạy chồng ---
running="$(aws ecs list-tasks --cluster "$CLUSTER" --family "$FAMILY" --desired-status RUNNING --output json | jget '" ".join(d["taskArns"])')"
if [ -n "$running" ]; then
  echo "Đang có task seed chạy ($running); không chạy chồng. Chờ nó xong rồi chạy lại." >&2
  exit 1
fi

# --- 6. Task definition: revision ACTIVE mới nhất của family, chỉ đổi image container seed ---
rc=0
aws ecs describe-task-definition --task-definition "$FAMILY" --include TAGS --output json >"$TMP/td.json" 2>"$TMP/err" || rc=$?
if [ "$rc" -ne 0 ]; then
  if grep -q 'Unable to describe task definition' "$TMP/err"; then
    echo "Family $FAMILY chưa có revision ACTIVE: chạy terraform apply ở envs/dev/session (BL-252)." >&2
  else
    cat "$TMP/err" >&2
  fi
  exit 1
fi
log_group="$(jget '[c for c in d["taskDefinition"]["containerDefinitions"] if c["name"] == "seed"][0]["logConfiguration"]["options"]["awslogs-group"]' <"$TMP/td.json")"
log_prefix="$(jget '[c for c in d["taskDefinition"]["containerDefinitions"] if c["name"] == "seed"][0]["logConfiguration"]["options"]["awslogs-stream-prefix"]' <"$TMP/td.json")"
latest_arn="$(jget 'd["taskDefinition"]["taskDefinitionArn"]' <"$TMP/td.json")"
latest_image="$(jget '[c["image"] for c in d["taskDefinition"]["containerDefinitions"] if c["name"] == "seed"][0]' <"$TMP/td.json")"
new_image="${latest_image%:*}:${TAG}"

if [ "$DRY_RUN" = "1" ]; then
  echo "Kế hoạch (--dry-run, không đăng ký và không chạy gì):"
  echo "  cluster      $CLUSTER"
  echo "  api          $API_URL (task RUNNING của service $SERVICE)"
  echo "  image        $new_image"
  echo "  subnets      $SUBNETS (assignPublicIp $ASSIGN_IP)"
  echo "  security grp $SG ($SEED_SG_NAME)"
  echo "  lệnh         node dist/scripts/seed-cloud.js --auth cloud --url $API_URL"
  exit 0
fi

if [ "$latest_image" = "$new_image" ]; then
  td_arn="$latest_arn"
  echo "Revision mới nhất ($latest_arn) đã dùng image này; không đăng ký lại."
else
  python3 "$RENDER" --container "$CONTAINER" --image "$new_image" <"$TMP/td.json" >"$TMP/new-td.json"
  td_arn="$(aws ecs register-task-definition --cli-input-json "file://$TMP/new-td.json" --output json | jget 'd["taskDefinition"]["taskDefinitionArn"]')"
  echo "Đã đăng ký $td_arn"
fi

# --- 7. Token: lấy NGAY trước run-task (sống 15 phút) ---
mint() { # mint <biến> <vai trò demo-token.sh>
  local var="$1" role="$2" value
  value="${!var:-}"
  if [ -z "$value" ]; then
    if ! value="$(bash "$DEMO_TOKEN" --role "$role")"; then
      echo "Không lấy được token $role bằng demo-token.sh (xem thông báo ở trên)." >&2
      exit 1
    fi
  fi
  if ! [[ "$value" =~ $JWT_RE ]]; then
    echo "$var không phải một JWT (ba đoạn base64url cách nhau bằng dấu chấm)." >&2
    exit 1
  fi
  printf -v "$var" '%s' "$value"
  export "${var?}"
}
mint DBS_OPERATOR_TOKEN operator
mint DBS_CUSTOMER_1_TOKEN customer1
mint DBS_CUSTOMER_2_TOKEN customer2
mint DBS_CUSTOMER_3_TOKEN customer3

# JSON mạng và overrides dựng trong python; token đọc từ môi trường của tiến trình con, không qua argv.
python3 - "$SUBNETS" "$SG" "$ASSIGN_IP" "$API_URL" "$TMP" <<'PY'
import json, os, sys
subnets, sg, assign, url, tmp = json.loads(sys.argv[1]), sys.argv[2], sys.argv[3], sys.argv[4], sys.argv[5]
with open(os.path.join(tmp, "net.json"), "w") as f:
    json.dump({"awsvpcConfiguration": {"subnets": subnets, "securityGroups": [sg], "assignPublicIp": assign}}, f)
names = ("DBS_OPERATOR_TOKEN", "DBS_CUSTOMER_1_TOKEN", "DBS_CUSTOMER_2_TOKEN", "DBS_CUSTOMER_3_TOKEN")
overrides = {"containerOverrides": [{
    "name": "seed",
    "command": ["node", "dist/scripts/seed-cloud.js", "--auth", "cloud", "--url", url],
    "environment": [{"name": n, "value": os.environ[n]} for n in names],
}]}
with open(os.path.join(tmp, "overrides.json"), "w") as f:
    json.dump(overrides, f)
PY
unset DBS_OPERATOR_TOKEN DBS_CUSTOMER_1_TOKEN DBS_CUSTOMER_2_TOKEN DBS_CUSTOMER_3_TOKEN

# In log của task (bản tóm tắt seed, hoặc lỗi).
print_logs() {
  local task_id="$1"
  echo "--- Log task seed (100 dòng cuối) ---"
  if aws logs get-log-events --log-group-name "$log_group" --log-stream-name "${log_prefix}/${CONTAINER}/${task_id}" \
    --limit 100 --output json >"$TMP/logs.json" 2>"$TMP/logs.err"; then
    python3 -c 'import json,sys; [print(m.rstrip("\n")[:2000]) for m in (e["message"] for e in json.load(sys.stdin)["events"])]' <"$TMP/logs.json"
  else
    echo "(không đọc được log của task)"
  fi
  echo "--- hết log ---"
}

# --- 8. run-task. Không in phản hồi (nó chứa overrides, tức token). ---
aws ecs run-task --cluster "$CLUSTER" --task-definition "$td_arn" --launch-type FARGATE --count 1 \
  --started-by "seed-${TAG:0:7}" --propagate-tags TASK_DEFINITION \
  --network-configuration "file://$TMP/net.json" --overrides "file://$TMP/overrides.json" --output json >"$TMP/run.json"
task_arn="$(jget 'd["tasks"][0]["taskArn"] if d["tasks"] else ""' <"$TMP/run.json")"
if [ -z "$task_arn" ]; then
  echo "run-task không tạo được task seed:" >&2
  jget '"; ".join(f.get("reason", "?") + " " + f.get("detail", "") for f in d["failures"])' <"$TMP/run.json" >&2 || true
  exit 1
fi
rm -f "$TMP/overrides.json" "$TMP/run.json" # token không cần ở lại trên đĩa nữa
task_id="${task_arn##*/}"
echo "Đã chạy task seed $task_id (image ${TAG:0:7}) tới $API_URL"

# --- 9. Chờ STOPPED. describe-tasks có thể trả 200 kèm failures (task MISSING): coi là lỗi, tối đa 3 lần liên tiếp ---
deadline=$(( $(date +%s) + DEADLINE_SECONDS ))
errors=0
timed_out=0
poll() {
  if aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_arn" --output json >"$TMP/poll.json" 2>"$TMP/poll.err" &&
    [ "$(jget 'len(d["tasks"])' <"$TMP/poll.json")" = "1" ]; then
    errors=0
    status="$(jget 'd["tasks"][0]["lastStatus"]' <"$TMP/poll.json")"
  else
    errors=$((errors + 1))
    status="UNKNOWN"
    cat "$TMP/poll.err" >&2 2>/dev/null || true
    jget '"; ".join(f.get("reason", "?") for f in d.get("failures", []))' <"$TMP/poll.json" >&2 2>/dev/null || true
  fi
}
while true; do
  poll
  if [ "$status" = "STOPPED" ]; then break; fi
  if [ "$errors" -ge 3 ]; then
    echo "Không đọc được trạng thái task $task_id (3 lần liên tiếp); dừng task và thoát." >&2
    aws ecs stop-task --cluster "$CLUSTER" --task "$task_arn" --reason "seed-cloud.sh: mất trạng thái" >/dev/null 2>&1 || true
    exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    timed_out=1
    echo "Quá ${DEADLINE_SECONDS}s mà task seed $task_id chưa xong ($status): dừng task." >&2
    aws ecs stop-task --cluster "$CLUSTER" --task "$task_arn" --reason "seed-cloud.sh: quá hạn" >/dev/null 2>&1 || true
    stop_deadline=$(( $(date +%s) + STOP_WAIT_SECONDS ))
    errors=0
    while true; do
      poll
      if [ "$status" = "STOPPED" ]; then break; fi
      if [ "$(date +%s)" -ge "$stop_deadline" ]; then
        echo "Task $task_id chưa dừng sau ${STOP_WAIT_SECONDS}s; kiểm bằng tay trước khi chạy lại." >&2
        exit 1
      fi
      sleep "$POLL_SECONDS"
    done
    break
  fi
  sleep "$POLL_SECONDS"
done

# --- 10. Kết quả theo exitCode của container seed ---
code="$(jget '(lambda c: "none" if not c or c[0].get("exitCode") is None else str(c[0]["exitCode"]))([x for x in d["tasks"][0]["containers"] if x["name"] == "seed"])' <"$TMP/poll.json")"
print_logs "$task_id"
if [ "$code" = "0" ]; then
  echo "Seed xong (task $task_id)."
  exit 0
fi
if [ "$timed_out" = "1" ]; then
  echo "Seed quá hạn và bị dừng (exitCode $code)." >&2
else
  echo "Seed thất bại (exitCode $code)." >&2
fi
jget 'd["tasks"][0].get("stoppedReason", "")' <"$TMP/poll.json" >&2 || true
exit 1
