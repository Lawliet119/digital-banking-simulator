#!/usr/bin/env bash
# BL-103: đặt LOGIN và mật khẩu cho ba role DB (dbs_api, dbs_worker, dbs_migrator) bằng credential master, qua một task
# ECS Fargate chạy một lần TRONG VPC (family `dbs-db-roles`, Terraform session/db_roles.tf). Chạy tay bằng quyền admin,
# KHÔNG nằm trong pipeline deploy: pipeline không được phép chạy task đọc secret master.
#
# Khi nào chạy (idempotent, chạy lại bao nhiêu lần cũng được):
#   - một lần mỗi database MỚI, SAU `terraform apply` của session và TRƯỚC migrate.sh đầu tiên (dbs_migrator cần login,
#     CREATE trên schema public và trên database trước khi có bảng nào);
#   - sau khi tăng `db_role_password_version` (mật khẩu mới trong Secrets Manager chưa vào DB), rồi khởi động lại
#     task api và worker.
#   - Database đã được migrate bằng master từ trước BL-103: chạy lại script này cũng đưa quyền sở hữu bảng, view, hàm
#     của schema public sang dbs_migrator.
#
# Dùng (cần session đang chạy và một image đã có dist/scripts/provision-db-roles.main.js):
#   AWS_PROFILE=dbs-admin bash infra/scripts/db-roles.sh
#
# Biến (tùy chọn):
#   IMAGE_TAG   SHA 40 ký tự; mặc định đúng image của revision ACTIVE mới nhất của family dbs-db-roles
#   CLUSTER (dbs-dev), SERVICE (api; chỉ để lấy mạng), DB_ROLES_FAMILY (dbs-db-roles),
#   DB_ROLES_DEADLINE_SECONDS (300), DB_ROLES_STOP_WAIT_SECONDS (120), POLL_SECONDS (5)
#
# Luồng: đọc mạng của service api (SG này đã được RDS cho vào cổng 5432), nếu IMAGE_TAG khác thì đăng ký revision mới chỉ
# đổi image, run-task KHÔNG ghi đè gì (mật khẩu chỉ đi bằng `secrets` của task definition, không qua containerOverrides
# nên không hiện trong describe-tasks hay CloudTrail), chờ STOPPED, đọc exitCode của container `db-roles`, in log của
# task (tên role, không mật khẩu). Thoát 0 chỉ khi container thoát 0. Không dùng set -x hay --debug.
set -euo pipefail

CLUSTER="${CLUSTER:-dbs-dev}"
SERVICE="${SERVICE:-api}"
FAMILY="${DB_ROLES_FAMILY:-dbs-db-roles}"
CONTAINER="db-roles"
DEADLINE_SECONDS="${DB_ROLES_DEADLINE_SECONDS:-300}"
STOP_WAIT_SECONDS="${DB_ROLES_STOP_WAIT_SECONDS:-120}"
POLL_SECONDS="${POLL_SECONDS:-5}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
RENDER="${RENDER_TASK_DEFINITION:-$HERE/../../.github/scripts/render-task-definition.py}"

TMP="$(mktemp -d)" # chỉ chứa JSON của task definition và phản hồi aws (không có giá trị bí mật)
trap 'rm -rf "$TMP"' EXIT

jget() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"; }
jjson() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(eval(sys.argv[1])))' "$1"; }

# --- 1. Mạng của task = mạng của service api ---
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json >"$TMP/svc.json"
if ! jjson '{"awsvpcConfiguration": {k: d["services"][0]["networkConfiguration"]["awsvpcConfiguration"][k] for k in ("subnets", "securityGroups", "assignPublicIp")}}' <"$TMP/svc.json" >"$TMP/net.json" 2>/dev/null; then
  echo "Service $SERVICE không có cấu hình mạng awsvpc: stack session chưa dựng?" >&2
  exit 1
fi

# --- 2. Không chạy chồng ---
running="$(aws ecs list-tasks --cluster "$CLUSTER" --family "$FAMILY" --desired-status RUNNING --output json | jget '" ".join(d["taskArns"])')"
if [ -n "$running" ]; then
  echo "Đang có task db-roles chạy ($running); không chạy chồng. Chờ nó xong rồi chạy lại." >&2
  exit 1
fi

# --- 3. Task definition: revision ACTIVE mới nhất của family; IMAGE_TAG (nếu có) chỉ đổi image container db-roles ---
rc=0
aws ecs describe-task-definition --task-definition "$FAMILY" --include TAGS --output json >"$TMP/td.json" 2>"$TMP/err" || rc=$?
if [ "$rc" -ne 0 ]; then
  if grep -q 'Unable to describe task definition' "$TMP/err"; then
    echo "Family $FAMILY chưa có revision ACTIVE: chạy terraform apply ở envs/dev/session (BL-103)." >&2
  else
    cat "$TMP/err" >&2
  fi
  exit 1
fi
log_group="$(jget '[c for c in d["taskDefinition"]["containerDefinitions"] if c["name"] == "db-roles"][0]["logConfiguration"]["options"]["awslogs-group"]' <"$TMP/td.json")"
log_prefix="$(jget '[c for c in d["taskDefinition"]["containerDefinitions"] if c["name"] == "db-roles"][0]["logConfiguration"]["options"]["awslogs-stream-prefix"]' <"$TMP/td.json")"
latest_arn="$(jget 'd["taskDefinition"]["taskDefinitionArn"]' <"$TMP/td.json")"
latest_image="$(jget '[c["image"] for c in d["taskDefinition"]["containerDefinitions"] if c["name"] == "db-roles"][0]' <"$TMP/td.json")"
TAG="${IMAGE_TAG:-${latest_image##*:}}"
if ! [[ "$TAG" =~ ^[0-9a-f]{40}$ ]]; then
  echo "IMAGE_TAG phải là SHA đầy đủ 40 ký tự hex (không dùng latest), nhận được '${TAG}'" >&2
  exit 1
fi
new_image="${latest_image%:*}:${TAG}"
if [ "$latest_image" = "$new_image" ]; then
  td_arn="$latest_arn"
  echo "Revision mới nhất ($latest_arn) đã dùng image này; không đăng ký lại."
else
  python3 "$RENDER" --container "$CONTAINER" --image "$new_image" <"$TMP/td.json" >"$TMP/new-td.json"
  td_arn="$(aws ecs register-task-definition --cli-input-json "file://$TMP/new-td.json" --output json | jget 'd["taskDefinition"]["taskDefinitionArn"]')"
  echo "Đã đăng ký $td_arn"
fi

# In log của task (tên role và kết quả đăng nhập thử, hoặc lỗi; script không in mật khẩu).
print_logs() {
  local task_id="$1"
  echo "--- Log task db-roles (50 dòng cuối) ---"
  if aws logs get-log-events --log-group-name "$log_group" --log-stream-name "${log_prefix}/${CONTAINER}/${task_id}" \
    --limit 50 --output json >"$TMP/logs.json" 2>"$TMP/logs.err"; then
    python3 -c 'import json,sys; [print(m.rstrip("\n")[:2000]) for m in (e["message"] for e in json.load(sys.stdin)["events"])]' <"$TMP/logs.json"
  else
    echo "(không đọc được log của task)"
  fi
  echo "--- hết log ---"
}

# --- 4. run-task: không --overrides ---
aws ecs run-task --cluster "$CLUSTER" --task-definition "$td_arn" --launch-type FARGATE --count 1 \
  --started-by "db-roles-${TAG:0:7}" --propagate-tags TASK_DEFINITION \
  --network-configuration "file://$TMP/net.json" --output json >"$TMP/run.json"
task_arn="$(jget 'd["tasks"][0]["taskArn"] if d["tasks"] else ""' <"$TMP/run.json")"
if [ -z "$task_arn" ]; then
  echo "run-task không tạo được task db-roles:" >&2
  jget '"; ".join(f.get("reason", "?") + " " + f.get("detail", "") for f in d["failures"])' <"$TMP/run.json" >&2 || true
  exit 1
fi
task_id="${task_arn##*/}"
echo "Đã chạy task db-roles $task_id (image ${TAG:0:7})"

# --- 5. Chờ STOPPED. describe-tasks có thể trả 200 kèm failures (task MISSING): coi là lỗi, tối đa 3 lần liên tiếp ---
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
  fi
}
while true; do
  poll
  if [ "$status" = "STOPPED" ]; then break; fi
  if [ "$errors" -ge 3 ]; then
    echo "Không đọc được trạng thái task $task_id (3 lần liên tiếp); dừng task và thoát." >&2
    aws ecs stop-task --cluster "$CLUSTER" --task "$task_arn" --reason "db-roles.sh: mất trạng thái" >/dev/null 2>&1 || true
    exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    timed_out=1
    echo "Quá ${DEADLINE_SECONDS}s mà task db-roles $task_id chưa xong ($status): dừng task." >&2
    aws ecs stop-task --cluster "$CLUSTER" --task "$task_arn" --reason "db-roles.sh: quá hạn" >/dev/null 2>&1 || true
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

# --- 6. Kết quả theo exitCode của container db-roles ---
code="$(jget '(lambda c: "none" if not c or c[0].get("exitCode") is None else str(c[0]["exitCode"]))([x for x in d["tasks"][0]["containers"] if x["name"] == "db-roles"])' <"$TMP/poll.json")"
print_logs "$task_id"
if [ "$code" = "0" ]; then
  echo "Đã đặt LOGIN và mật khẩu cho dbs_api, dbs_worker, dbs_migrator (task $task_id)."
  exit 0
fi
if [ "$timed_out" = "1" ]; then
  echo "Tạo role DB quá hạn và bị dừng (exitCode $code)." >&2
else
  echo "Tạo role DB thất bại (exitCode $code)." >&2
fi
jget 'd["tasks"][0].get("stoppedReason", "")' <"$TMP/poll.json" >&2 || true
exit 1
