#!/usr/bin/env bash
# BL-188: bảo đảm KHÔNG còn task worker revision cũ trước khi bật phiên bản luật mới (UC-12).
#
# Chạy bởi deploy.sh ngay sau khi rollout worker COMPLETED, và chạy tay trước khi POST /v1/admin/risk-config/versions
# (docs/runbooks/risk-config-rollout.md):
#   AWS_PROFILE=dbs-admin bash .github/scripts/verify-worker-rollout.sh
#   EXPECT_TASK_DEFINITION=arn:aws:ecs:...:task-definition/dbs-worker:12 bash .github/scripts/verify-worker-rollout.sh
#
# Vì sao không dừng ở `rolloutState = COMPLETED`: nó chỉ nói deployment PRIMARY đã đủ task; deployment cũ có thể còn
# trong `deployments` và task cũ còn ở STOPPING (stopTimeout 60 s, vẫn xử lý message). Worker cũ đọc cấu hình bằng code
# cũ (key Redis cũ, bộ kiểm tham số cũ), nên phiên bản luật mới có thể làm nó từ chối mọi sự kiện hoặc dùng bản cũ lâu
# hơn 60 s (BUG-20261109-risk-config-freshness §2). Script poll `describe-services` + `list-tasks` (RUNNING và STOPPED) +
# `describe-tasks` tới khi: một deployment PRIMARY duy nhất ở revision mong đợi, runningCount = desiredCount, và mọi task
# chưa STOPPED dùng đúng revision đó (điều kiện chi tiết ở check-worker-rollout.py).
#
# Biến: CLUSTER (dbs-dev), WORKER_SERVICE (worker), EXPECT_TASK_DEFINITION (mặc định: revision của deployment PRIMARY),
# VERIFY_DEADLINE_SECONDS (300), POLL_SECONDS (10). Thoát 0 khi đạt (hoặc service không ACTIVE: không có worker nào
# chạy, in cảnh báo); 1 khi quá hạn hoặc PRIMARY không phải revision mong đợi.
set -euo pipefail

CLUSTER="${CLUSTER:-dbs-dev}"
WORKER_SERVICE="${WORKER_SERVICE:-worker}"
EXPECT_TASK_DEFINITION="${EXPECT_TASK_DEFINITION:-}"
VERIFY_DEADLINE_SECONDS="${VERIFY_DEADLINE_SECONDS:-300}"
POLL_SECONDS="${POLL_SECONDS:-10}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

jget() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"; }

deadline=$(( $(date +%s) + VERIFY_DEADLINE_SECONDS ))
while true; do
  aws ecs describe-services --cluster "$CLUSTER" --services "$WORKER_SERVICE" --output json >"$TMP/svc.json"
  if [ "$(jget '"yes" if d["services"] and d["services"][0]["status"] == "ACTIVE" else "no"' <"$TMP/svc.json")" != "yes" ]; then
    echo "::warning::Service $WORKER_SERVICE không có hoặc không ACTIVE: không có task worker nào chạy, không có gì để kiểm." >&2
    exit 0
  fi
  # RUNNING lấy các task đang chạy hoặc khởi động; STOPPED lấy task đã có lệnh dừng (kể cả đang STOPPING, và task vừa dừng).
  aws ecs list-tasks --cluster "$CLUSTER" --service-name "$WORKER_SERVICE" --desired-status RUNNING --output json >"$TMP/running.json"
  aws ecs list-tasks --cluster "$CLUSTER" --service-name "$WORKER_SERVICE" --desired-status STOPPED --output json >"$TMP/stopped.json"
  # describe-tasks nhận tối đa 100 task; RUNNING đứng trước nên luôn nằm trong 100 đầu.
  arns="$(python3 -c '
import json, sys
seen = []
for path in sys.argv[1:]:
    for arn in json.load(open(path)).get("taskArns", []):
        if arn not in seen:
            seen.append(arn)
print(" ".join(seen[:100]))
' "$TMP/running.json" "$TMP/stopped.json")"
  if [ -n "$arns" ]; then
    # shellcheck disable=SC2086 # $arns là danh sách ARN cách nhau bằng dấu cách
    aws ecs describe-tasks --cluster "$CLUSTER" --tasks $arns --output json >"$TMP/tasks.json"
  else
    echo '{"tasks": []}' >"$TMP/tasks.json"
  fi

  rc=0
  python3 "$HERE/check-worker-rollout.py" --service "$TMP/svc.json" --tasks "$TMP/tasks.json" \
    ${EXPECT_TASK_DEFINITION:+--expect "$EXPECT_TASK_DEFINITION"} >"$TMP/out" || rc=$?
  case "$rc" in
    0)
      cat "$TMP/out"
      exit 0
      ;;
    2)
      echo "::error::$(cat "$TMP/out")" >&2
      jget '"\n".join(e["message"] for e in d["services"][0]["events"][:5])' <"$TMP/svc.json" >&2 || true
      exit 1
      ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::Quá ${VERIFY_DEADLINE_SECONDS}s mà vẫn còn worker revision cũ hoặc rollout chưa ổn định:" >&2
    cat "$TMP/out" >&2
    exit 1
  fi
  echo "Chờ worker cũ dừng hẳn: $(tr '\n' ';' <"$TMP/out")"
  sleep "$POLL_SECONDS"
done
