#!/usr/bin/env bash
# DBS-68: chạy migration (`migration:run`) như một task ECS Fargate chạy một lần, bằng image <repo>:<IMAGE_TAG>.
#
# Chạy bởi deploy.sh (trước update-service), hoặc tay (không cần `gh`):
#   IMAGE_TAG=<sha 40 ký tự> AWS_PROFILE=dbs-admin bash .github/scripts/migrate.sh
#
# Runner GitHub không với tới RDS (subnet riêng), nên task dùng subnet và SG của service `api`. Family riêng
# `dbs-migrate` (Terraform, session/ecs.tf): đăng ký revision mới chỉ đổi image, `run-task`, chờ STOPPED, đọc exitCode
# của container `migrate`. Thoát 0 chỉ khi container thoát 0; mọi lỗi khác thoát 1 và in 50 dòng log cuối.
set -euo pipefail

CLUSTER="${CLUSTER:-dbs-dev}"
SERVICE="${SERVICE:-api}"
FAMILY="${MIGRATE_FAMILY:-dbs-migrate}"
CONTAINER="migrate"
DEADLINE_SECONDS="${MIGRATE_DEADLINE_SECONDS:-600}"
STOP_WAIT_SECONDS="${MIGRATE_STOP_WAIT_SECONDS:-120}"
POLL_SECONDS="${POLL_SECONDS:-15}"
TAG="${IMAGE_TAG:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! [[ "$TAG" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::IMAGE_TAG phải là SHA đầy đủ 40 ký tự hex (không dùng latest), nhận được '${TAG}'" >&2
  exit 1
fi

TMP="$(mktemp -d)" # chỉ chứa JSON của task definition và phản hồi aws (không có giá trị bí mật)
trap 'rm -rf "$TMP"' EXIT

jget() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"; }
jjson() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps(eval(sys.argv[1])))' "$1"; }

# --- 1. Mạng của task = mạng của service api (SG này đã được RDS cho vào cổng 5432) ---
if [ -n "${SERVICE_JSON:-}" ] && [ -f "$SERVICE_JSON" ]; then
  cp "$SERVICE_JSON" "$TMP/svc.json"
else
  aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json >"$TMP/svc.json"
fi
if ! jjson '{"awsvpcConfiguration": {k: d["services"][0]["networkConfiguration"]["awsvpcConfiguration"][k] for k in ("subnets", "securityGroups", "assignPublicIp")}}' <"$TMP/svc.json" >"$TMP/net.json" 2>/dev/null; then
  echo "::error::Service $SERVICE không có cấu hình mạng awsvpc: stack session chưa dựng?" >&2
  exit 1
fi

# --- 2. Không chạy chồng: TypeORM không có khóa trên bảng migrations ---
running="$(aws ecs list-tasks --cluster "$CLUSTER" --family "$FAMILY" --desired-status RUNNING --output json | jget '" ".join(d["taskArns"])')"
if [ -n "$running" ]; then
  echo "::error::Đang có task migration chạy ($running); không chạy chồng. Chờ nó xong rồi chạy lại." >&2
  exit 1
fi

# --- 3. Task definition: revision ACTIVE mới nhất của family, chỉ đổi image container migrate ---
rc=0
aws ecs describe-task-definition --task-definition "$FAMILY" --include TAGS --output json >"$TMP/td.json" 2>"$TMP/err" || rc=$?
if [ "$rc" -ne 0 ]; then
  if grep -q 'Unable to describe task definition' "$TMP/err"; then
    echo "::error::Family $FAMILY chưa có revision ACTIVE: chạy terraform apply ở envs/dev/session (DBS-68)." >&2
  else
    cat "$TMP/err" >&2
  fi
  exit 1
fi
# DB_HOST hiện trong log lỗi của Postgres: che trước khi in bất cứ thứ gì từ task.
dbhost="$(jget '(lambda c: next((e["value"] for e in c.get("environment", []) if e["name"] == "DB_HOST"), ""))([c for c in d["taskDefinition"]["containerDefinitions"] if c["name"] == "migrate"][0])' <"$TMP/td.json")"
if [ -n "$dbhost" ]; then echo "::add-mask::$dbhost"; fi
log_group="$(jget '[c for c in d["taskDefinition"]["containerDefinitions"] if c["name"] == "migrate"][0]["logConfiguration"]["options"]["awslogs-group"]' <"$TMP/td.json")"
log_prefix="$(jget '[c for c in d["taskDefinition"]["containerDefinitions"] if c["name"] == "migrate"][0]["logConfiguration"]["options"]["awslogs-stream-prefix"]' <"$TMP/td.json")"
latest_arn="$(jget 'd["taskDefinition"]["taskDefinitionArn"]' <"$TMP/td.json")"
latest_image="$(jget '[c["image"] for c in d["taskDefinition"]["containerDefinitions"] if c["name"] == "migrate"][0]' <"$TMP/td.json")"
new_image="${latest_image%:*}:${TAG}"
if [ "$latest_image" = "$new_image" ]; then
  td_arn="$latest_arn"
  echo "Revision mới nhất ($latest_arn) đã dùng image này; không đăng ký lại."
else
  python3 "$HERE/render-task-definition.py" --container "$CONTAINER" --image "$new_image" <"$TMP/td.json" >"$TMP/new-td.json"
  td_arn="$(aws ecs register-task-definition --cli-input-json "file://$TMP/new-td.json" --output json | jget 'd["taskDefinition"]["taskDefinitionArn"]')"
  echo "Đã đăng ký $td_arn"
fi

# In log của task giữa ::group::, bọc bằng ::stop-commands:: để dòng log bắt đầu bằng `::` không thành lệnh của runner.
print_logs() {
  local task_id="$1" token
  token="$(python3 -c 'import secrets; print(secrets.token_hex(16))')"
  echo "::group::Log task migration (50 dòng cuối)"
  echo "::stop-commands::${token}"
  if aws logs get-log-events --log-group-name "$log_group" --log-stream-name "${log_prefix}/${CONTAINER}/${task_id}" \
    --limit 50 --output json >"$TMP/logs.json" 2>"$TMP/logs.err"; then
    python3 -c 'import json,sys; [print(m.rstrip("\n")[:2000]) for m in (e["message"] for e in json.load(sys.stdin)["events"])]' <"$TMP/logs.json"
  else
    echo "(không đọc được log của task)"
  fi
  echo "::${token}::"
  echo "::endgroup::"
}

# --- 4. run-task ---
aws ecs run-task --cluster "$CLUSTER" --task-definition "$td_arn" --launch-type FARGATE --count 1 \
  --started-by "migrate-${TAG:0:7}" --propagate-tags TASK_DEFINITION \
  --network-configuration "file://$TMP/net.json" --output json >"$TMP/run.json"
task_arn="$(jget 'd["tasks"][0]["taskArn"] if d["tasks"] else ""' <"$TMP/run.json")"
if [ -z "$task_arn" ]; then
  echo "::error::run-task không tạo được task migration:" >&2
  jget '"; ".join(f.get("reason", "?") + " " + f.get("detail", "") for f in d["failures"])' <"$TMP/run.json" >&2 || true
  exit 1
fi
task_id="${task_arn##*/}"
echo "Đã chạy task migration $task_id (image ${TAG:0:7})"

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
    jget '"; ".join(f.get("reason", "?") for f in d.get("failures", []))' <"$TMP/poll.json" >&2 2>/dev/null || true
  fi
}
while true; do
  poll
  if [ "$status" = "STOPPED" ]; then break; fi
  if [ "$errors" -ge 3 ]; then
    echo "::error::Không đọc được trạng thái task $task_id (3 lần liên tiếp); dừng task và thoát." >&2
    aws ecs stop-task --cluster "$CLUSTER" --task "$task_arn" --reason "migrate.sh: mất trạng thái" >/dev/null 2>&1 || true
    exit 1
  fi
  if [ "$(date +%s)" -ge "$deadline" ]; then
    timed_out=1
    echo "::error::Quá ${DEADLINE_SECONDS}s mà task migration $task_id chưa xong ($status): dừng task." >&2
    aws ecs stop-task --cluster "$CLUSTER" --task "$task_arn" --reason "migrate.sh: quá hạn" >/dev/null 2>&1 || true
    stop_deadline=$(( $(date +%s) + STOP_WAIT_SECONDS ))
    errors=0
    while true; do
      poll
      if [ "$status" = "STOPPED" ]; then break; fi
      if [ "$(date +%s)" -ge "$stop_deadline" ]; then
        echo "::error::Task $task_id chưa dừng sau ${STOP_WAIT_SECONDS}s; kiểm bằng tay trước khi chạy lại." >&2
        exit 1
      fi
      sleep "$POLL_SECONDS"
    done
    break
  fi
  sleep "$POLL_SECONDS"
done

# --- 6. Kết quả theo exitCode của container migrate ---
code="$(jget '(lambda c: "none" if not c or c[0].get("exitCode") is None else str(c[0]["exitCode"]))([x for x in d["tasks"][0]["containers"] if x["name"] == "migrate"])' <"$TMP/poll.json")"
if [ "$code" = "0" ]; then
  echo "Migration xong (task $task_id)."
  exit 0
fi
if [ "$timed_out" = "1" ]; then
  echo "::error::Migration quá hạn và bị dừng (exitCode $code)." >&2
else
  echo "::error::Migration thất bại (exitCode $code)." >&2
fi
jget 'd["tasks"][0].get("stoppedReason", "")' <"$TMP/poll.json" >&2 || true
print_logs "$task_id"
exit 1
