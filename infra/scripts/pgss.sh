#!/usr/bin/env bash
# BL-420: bật, reset và chụp `pg_stat_statements` trên RDS của một phiên đo tải, bằng một task ECS Fargate chạy một lần
# TRONG VPC với credential master (family `dbs-db-roles`, Terraform session/db_roles.tf). Trước đây mỗi phiên đo (DBS-166,
# 173, 174...) tự viết lại đoạn này; script này là cách lặp lại được.
#
#   bash infra/scripts/pgss.sh enable              CREATE EXTENSION IF NOT EXISTS pg_stat_statements (lặp lại được, KHÔNG reset)
#   bash infra/scripts/pgss.sh reset               pg_stat_statements_reset(): xóa bộ đếm (mất mốc của delta đang đo)
#   bash infra/scripts/pgss.sh snapshot <file>     25 truy vấn có tổng thời gian chạy lớn nhất (không reset), ghi vào <file>
#
# Khi nào: `enable` rồi `reset` MỘT lần sau db-roles.sh và migrate.sh của phiên mới (RDS mới nên extension chưa có) và trước
# lượt đo đầu; `snapshot` sát đầu và cuối mỗi plateau cần số (mỗi lần ≈ 1 phút; một vòng ≈ 2,5 phút là đủ). Delta giữa hai
# ảnh chụp: python3 infra/scripts/pgss_delta.py <đầu> <cuối>.
#
# Không cấp quyền `pg_read_all_stats` cho `dbs_api` (các phiên trước có cấp): ảnh chụp do role master đọc, còn quyền đó
# cho role của ứng dụng đọc văn bản truy vấn của mọi role. Khác db-roles.sh: có `--overrides`, nhưng chỉ mang `command` của
# container và biến `Q64` (văn bản SQL cố định, không bí mật). Mật khẩu master vẫn chỉ đi bằng `secrets` của task
# definition, không vào tham số, log hay CloudTrail. Không in mật khẩu, không dùng set -x hay --debug.
#
# Mã thoát: 0 xong và file/log đầy đủ; 1 lỗi (task lỗi, quá hạn, log thiếu); 2 dùng sai. Không bao giờ ghi file chụp thiếu.
#
# Biến (tùy chọn): CLUSTER (dbs-dev), SERVICE (api; chỉ để lấy mạng), PGSS_FAMILY (dbs-db-roles),
# PGSS_DEADLINE_SECONDS (180, theo đồng hồ; quá hạn thì stop-task), POLL_SECONDS (5), LOG_RETRIES (5), RETRY_SECONDS (2).
# Cần python3 và aws trên PATH.
set -euo pipefail

usage() {
  echo "Usage: bash infra/scripts/pgss.sh enable | reset | snapshot <file>" >&2
  exit 2
}

cmd="${1:-}"
out=""
case "$cmd" in
  enable | reset) [ "$#" -eq 1 ] || usage ;;
  snapshot)
    [ "$#" -eq 2 ] || usage
    out="$2"
    ;;
  *) usage ;;
esac

CLUSTER="${CLUSTER:-dbs-dev}"
SERVICE="${SERVICE:-api}"
FAMILY="${PGSS_FAMILY:-dbs-db-roles}"
CONTAINER="db-roles"
DEADLINE_SECONDS="${PGSS_DEADLINE_SECONDS:-180}"
POLL_SECONDS="${POLL_SECONDS:-5}"
LOG_RETRIES="${LOG_RETRIES:-5}"
RETRY_SECONDS="${RETRY_SECONDS:-2}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TMP="$(mktemp -d)" # chỉ chứa JSON mạng, task definition, SQL và phản hồi aws (không có bí mật)
trap 'rm -rf "$TMP"' EXIT

jget() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"; }

# --- 1. SQL của lệnh con (mảng JSON) ---
python3 - "$cmd" "$TMP/queries.json" <<'PY'
import json, sys
cmd, path = sys.argv[1], sys.argv[2]
if cmd == "enable":
    queries = [
        "CREATE EXTENSION IF NOT EXISTS pg_stat_statements",
        "SELECT extname FROM pg_extension WHERE extname = 'pg_stat_statements'",
    ]
elif cmd == "reset":
    queries = ["SELECT pg_stat_statements_reset() AS reset_at"]
else:
    # One row per statement, at most 25 rows of at most 120 characters of text: the JSON line stays far below the
    # ~16 KB at which the awslogs driver splits a line in two events.
    queries = [
        "SELECT now() AS at, userid::regrole::text AS role, queryid, calls, "
        "round(total_exec_time::numeric,1) AS total_ms, round(mean_exec_time::numeric,3) AS mean_ms, "
        "round(stddev_exec_time::numeric,2) AS sd_ms, rows, shared_blks_hit AS hit, shared_blks_read AS rd, "
        "left(translate(query, chr(10), ' '), 120) AS q "
        "FROM pg_stat_statements WHERE dbid = (SELECT oid FROM pg_database WHERE datname = current_database()) "
        "ORDER BY total_exec_time DESC LIMIT 25"
    ]
json.dump(queries, open(path, "w"))
PY
n_queries="$(python3 -c 'import json,sys; print(len(json.load(open(sys.argv[1]))))' "$TMP/queries.json")"

# --- 2. Mạng của task = mạng của service api (SG này đã được RDS cho vào cổng 5432) ---
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json >"$TMP/svc.json"
if ! python3 -c 'import json,sys; d=json.load(sys.stdin); print(json.dumps({"awsvpcConfiguration": {k: d["services"][0]["networkConfiguration"]["awsvpcConfiguration"][k] for k in ("subnets", "securityGroups", "assignPublicIp")}}))' <"$TMP/svc.json" >"$TMP/net.json" 2>/dev/null; then
  echo "Service $SERVICE không có cấu hình mạng awsvpc: stack session chưa dựng?" >&2
  exit 1
fi

# --- 3. Task definition (revision ACTIVE mới nhất) chỉ để lấy log group và tiền tố stream ---
aws ecs describe-task-definition --task-definition "$FAMILY" --output json >"$TMP/td.json"
log_group="$(jget '[c for c in d["taskDefinition"]["containerDefinitions"] if c["name"] == "db-roles"][0]["logConfiguration"]["options"]["awslogs-group"]' <"$TMP/td.json")"
log_prefix="$(jget '[c for c in d["taskDefinition"]["containerDefinitions"] if c["name"] == "db-roles"][0]["logConfiguration"]["options"]["awslogs-stream-prefix"]' <"$TMP/td.json")"

# --- 4. run-task: ghi đè `command` (đoạn Node của pgss-runner.js) và biến Q64 (SQL, base64) ---
python3 - "$HERE/pgss-runner.js" "$TMP/queries.json" "$TMP/overrides.json" "$CONTAINER" <<'PY'
import base64, json, sys
runner = base64.b64encode(open(sys.argv[1], "rb").read()).decode()
queries = base64.b64encode(open(sys.argv[2], "rb").read()).decode()
command = ["node", "-e", "eval(Buffer.from('" + runner + "','base64').toString())"]
overrides = {"containerOverrides": [{"name": sys.argv[4], "command": command, "environment": [{"name": "Q64", "value": queries}]}]}
json.dump(overrides, open(sys.argv[3], "w"))
PY
aws ecs run-task --cluster "$CLUSTER" --task-definition "$FAMILY" --launch-type FARGATE --count 1 \
  --started-by "pgss-$cmd" --network-configuration "file://$TMP/net.json" --overrides "file://$TMP/overrides.json" \
  --output json >"$TMP/run.json"
task_arn="$(jget 'd["tasks"][0]["taskArn"] if d["tasks"] else ""' <"$TMP/run.json")"
if [ -z "$task_arn" ]; then
  echo "run-task không tạo được task:" >&2
  jget '"; ".join(f.get("reason", "?") + " " + f.get("detail", "") for f in d["failures"])' <"$TMP/run.json" >&2 || true
  exit 1
fi
task_id="${task_arn##*/}"

# --- 5. Chờ STOPPED theo đồng hồ; quá hạn thì dừng task (nó đang cầm credential master) ---
started_at="$(date +%s)"
exit_code=""
stopped_reason=""
while :; do
  aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task_id" --output json >"$TMP/tasks.json"
  status="$(jget 'd["tasks"][0]["lastStatus"] if d["tasks"] else "MISSING"' <"$TMP/tasks.json")"
  if [ "$status" = "MISSING" ]; then
    echo "describe-tasks không thấy task $task_id." >&2
    exit 1
  fi
  if [ "$status" = "STOPPED" ]; then
    exit_code="$(jget '([c.get("exitCode", "") for c in d["tasks"][0]["containers"] if c["name"] == "db-roles"] or [""])[0]' <"$TMP/tasks.json")"
    stopped_reason="$(jget 'd["tasks"][0].get("stoppedReason", "")' <"$TMP/tasks.json")"
    break
  fi
  if [ "$(($(date +%s) - started_at))" -ge "$DEADLINE_SECONDS" ]; then
    echo "Task $task_id chưa dừng sau ${DEADLINE_SECONDS}s (trạng thái $status): dừng task." >&2
    aws ecs stop-task --cluster "$CLUSTER" --task "$task_id" --reason "pgss.sh quá hạn" --output json >/dev/null || true
    exit 1
  fi
  sleep "$POLL_SECONDS"
done

# --- 6. Log của task. CloudWatch Logs ghi rồi đọc chưa nhất quán ngay: đọc lại đến khi đủ (một dòng `SQL> …` và một dòng
#        JSON cho mỗi câu, không có SQLERR hay FATAL) hoặc hết số lần; chỉ ghi file khi đủ và task thoát 0. ---
complete=0
for attempt in $(seq 1 "$LOG_RETRIES"); do
  if aws logs get-log-events --log-group-name "$log_group" --log-stream-name "${log_prefix}/${CONTAINER}/${task_id}" \
    --start-from-head --output json >"$TMP/logs.json" 2>"$TMP/logs.err"; then
    python3 -c 'import json,sys; sys.stdout.write("".join(e["message"] if e["message"].endswith("\n") else e["message"] + "\n" for e in json.load(sys.stdin)["events"]))' <"$TMP/logs.json" >"$TMP/task.out"
    if python3 - "$TMP/task.out" "$n_queries" <<'PY'
import json, sys
lines = open(sys.argv[1], encoding="utf8").read().splitlines()
expected = int(sys.argv[2])
if any(l.startswith(("SQLERR>", "FATAL")) for l in lines):
    sys.exit(4)  # the task reported an error: more reading will not change it
sql = [i for i, l in enumerate(lines) if l.startswith("SQL> ")]
if len(sql) != expected:
    sys.exit(3)
for i in sql:
    if i + 1 >= len(lines):
        sys.exit(3)
    try:
        json.loads(lines[i + 1])
    except ValueError:
        sys.exit(3)
PY
    then
      complete=1
      break
    else
      [ "$?" -eq 4 ] && break
    fi
  else
    : >"$TMP/task.out"
  fi
  [ "$attempt" -lt "$LOG_RETRIES" ] && sleep "$RETRY_SECONDS"
done

if [ "$exit_code" != "0" ]; then
  echo "Task $task_id thoát với mã '$exit_code' ($stopped_reason). Log:" >&2
  head -c 4000 "$TMP/task.out" >&2 || true
  exit 1
fi
if [ "$complete" -ne 1 ]; then
  echo "Log của task $task_id chưa đủ hoặc có lỗi SQL (đọc $LOG_RETRIES lần): không ghi kết quả. Log đọc được:" >&2
  head -c 4000 "$TMP/task.out" >&2 || true
  exit 1
fi
if [ "$cmd" = "snapshot" ]; then
  cp "$TMP/task.out" "$out"
  echo "Đã ghi $out (task $task_id)."
else
  cat "$TMP/task.out"
fi
