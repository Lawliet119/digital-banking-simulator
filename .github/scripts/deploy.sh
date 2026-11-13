#!/usr/bin/env bash
# DBS-38: cập nhật service `api` trên ECS lên image <repo>:<IMAGE_TAG> và kiểm sống qua ALB; BL-248: rồi lăn service `worker`.
#
# Chạy bởi .github/workflows/deploy.yml, hoặc tay (không cần `gh`):
#   IMAGE_TAG=<sha 40 ký tự> AWS_PROFILE=dbs-admin bash .github/scripts/deploy.sh
#
# Thứ tự: (kiểm đầu main) → service có tồn tại và có task? → tag có trên ECR? → render task definition từ
# revision ACTIVE mới nhất của family (chỉ đổi image) → đăng ký → update-service → poll deployment PRIMARY
# → curl /health/live và /health/ready qua ALB. Migration (DBS-68) chạy giữa "đăng ký" và "update-service":
# migrate.sh lỗi thì dừng, service vẫn ở bản cũ. Không dùng `aws ecs wait services-stable`: nó chỉ chờ 10 phút
# và vẫn "đạt" sau khi circuit breaker đã rollback về bản cũ.
#
# BL-248 (worker): thứ tự migrate → api → health api → worker. Worker cuối cùng vì (1) api lỗi thì dừng, worker và api
# cùng ở bản cũ (nhất quán); (2) migration đã chạy xong, worker dùng schema mới; (3) worker lăn 0%/100% (DBS-121) nên có
# khoảng trống xử lý ngắn, để sau khi api đã xác nhận khỏe. Worker dùng chung image `dbs-api:<SHA>` (ADR-13) với family
# `dbs-worker`, container `worker`. `desiredCount` = 0 (mặc định của stack): vẫn đăng ký revision và update-service để
# lần bật sau dùng image mới, nhưng không chờ. Service worker không ACTIVE (stack cũ chưa có) thì cảnh báo và bỏ qua.
# `DEPLOY_WORKER=0` tắt bước này. Chờ bằng poll `describe-services` như api (không dùng `aws ecs wait`).
set -euo pipefail

CLUSTER="${CLUSTER:-dbs-dev}"
SERVICE="${SERVICE:-api}"
FAMILY="${FAMILY:-dbs-api}"
REPOSITORY="${REPOSITORY:-dbs-api}"
LB_NAME="${LB_NAME:-dbs-dev}"
EVENT="${GITHUB_EVENT_NAME:-manual}"
DEADLINE_SECONDS="${DEADLINE_SECONDS:-1200}"
POLL_SECONDS="${POLL_SECONDS:-15}"
HEALTH_RETRIES="${HEALTH_RETRIES:-8}"
HEALTH_WAIT="${HEALTH_WAIT:-15}"
WORKER_SERVICE="${WORKER_SERVICE:-worker}"
WORKER_FAMILY="${WORKER_FAMILY:-dbs-worker}"
WORKER_CONTAINER="worker"
DEPLOY_WORKER="${DEPLOY_WORKER:-1}"
TAG="${IMAGE_TAG:-}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! [[ "$TAG" =~ ^[0-9a-f]{40}$ ]]; then
  echo "::error::IMAGE_TAG phải là SHA đầy đủ 40 ký tự hex (không dùng latest), nhận được '${TAG}'" >&2
  exit 1
fi

TMP="$(mktemp -d)" # chỉ chứa JSON của task definition (không có giá trị bí mật) và stderr của aws
trap 'rm -rf "$TMP"' EXIT

# Các hàm đọc JSON qua stdin (python chỉ nhận dữ liệu qua stdin, argv chỉ chứa tên trường).
jget() { python3 -c 'import json,sys; d=json.load(sys.stdin); print(eval(sys.argv[1]))' "$1"; }

# --- 1. Chỉ deploy commit đang là đầu main (Image có thể kết thúc sai thứ tự) ---
if [ "${CHECK_MAIN_HEAD:-0}" = "1" ]; then
  head="$(gh api "repos/${GITHUB_REPOSITORY}/commits/main" --jq .sha)"
  if [ "$head" != "$TAG" ]; then
    echo "Đã có commit mới hơn trên main (${head:0:7}); bỏ qua deploy ${TAG:0:7}."
    exit 0
  fi
fi

# --- 2. Service có tồn tại và có task? ---
rc=0
aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json >"$TMP/svc.json" 2>"$TMP/err" || rc=$?
if [ "$rc" -ne 0 ]; then
  if grep -q 'ClusterNotFoundException' "$TMP/err"; then
    echo "Cluster $CLUSTER không tồn tại (stack session đã destroy): runtime không có, bỏ qua."
    exit 0
  fi
  cat "$TMP/err" >&2
  exit 1
fi
state="$(jget '(lambda s: "NONE" if not s else s[0]["status"] + " " + str(s[0]["desiredCount"]))(d["services"])' <"$TMP/svc.json")"
case "$state" in
  NONE | INACTIVE* | DRAINING*)
    echo "Service $SERVICE không có hoặc không ACTIVE ($state): runtime stack không tồn tại, bỏ qua."
    exit 0
    ;;
esac
if [ "${state##* }" = "0" ]; then
  echo "::warning::Service $SERVICE có desiredCount = 0: không có task, không kiểm health."
  exit 0
fi

# --- 3. Tag có trên ECR? (batch-get-image luôn thoát 0, lỗi nằm trong failures: đếm images) ---
found="$(aws ecr batch-get-image --repository-name "$REPOSITORY" --image-ids imageTag="$TAG" --output json | jget 'len(d["images"])')"
if [ "$found" = "0" ]; then
  if [ "$EVENT" = "workflow_dispatch" ]; then
    echo "::error::Tag ${TAG:0:7} chưa có trên ECR (workflow Image chưa đẩy được?)." >&2
    exit 1
  fi
  echo "::warning::Tag ${TAG:0:7} chưa có trên ECR; bỏ qua deploy."
  exit 0
fi

# --- 4. Task definition: revision ACTIVE mới nhất của family, chỉ đổi image ---
aws ecs describe-task-definition --task-definition "$FAMILY" --include TAGS --output json >"$TMP/td.json"
latest_arn="$(jget 'd["taskDefinition"]["taskDefinitionArn"]' <"$TMP/td.json")"
latest_image="$(jget '[c["image"] for c in d["taskDefinition"]["containerDefinitions"] if c["name"] == "api"][0]' <"$TMP/td.json")"
new_image="${latest_image%:*}:${TAG}"
if [ "$latest_image" = "$new_image" ]; then
  new_arn="$latest_arn"
  echo "Revision mới nhất ($latest_arn) đã dùng image này; không đăng ký lại."
else
  python3 "$HERE/render-task-definition.py" --image "$new_image" <"$TMP/td.json" >"$TMP/new-td.json"
  new_arn="$(aws ecs register-task-definition --cli-input-json "file://$TMP/new-td.json" --output json | jget 'd["taskDefinition"]["taskDefinitionArn"]')"
  echo "Đã đăng ký $new_arn"
fi

# --- 4b. Migration (DBS-68): task ECS chạy một lần với cùng image; lỗi thì dừng trước update-service ---
SERVICE_JSON="$TMP/svc.json" IMAGE_TAG="$TAG" bash "$HERE/migrate.sh"

# --- 5. Cập nhật service (nếu chưa dùng revision đó) ---
current_arn="$(jget 'd["services"][0]["taskDefinition"]' <"$TMP/svc.json")"
if [ "$current_arn" != "$new_arn" ]; then
  aws ecs update-service --cluster "$CLUSTER" --service "$SERVICE" --task-definition "$new_arn" --output json >/dev/null
fi

# Poll deployment PRIMARY của một service: phải ở revision mới, COMPLETED và runningCount >= desired.
# Dùng cho api (bước 6) và worker (bước 8).
wait_rollout() {
  local svc="$1" want_arn="$2" desired="$3" line primary_arn rest rollout running
  local deadline=$(( $(date +%s) + DEADLINE_SECONDS ))
  while true; do
    aws ecs describe-services --cluster "$CLUSTER" --services "$svc" --output json >"$TMP/poll.json"
    line="$(jget '(lambda p: p["taskDefinition"] + " " + str(p.get("runningCount", '"$desired"')) + " " + p["rolloutState"])([x for x in d["services"][0]["deployments"] if x["status"] == "PRIMARY"][0])' <"$TMP/poll.json")"
    primary_arn="${line%% *}"
    rollout="${line##* }"
    rest="${line#* }"
    running="${rest%% *}"
    if [ "$primary_arn" != "$want_arn" ]; then
      echo "::error::Deployment PRIMARY của $svc đang ở $primary_arn, không phải $want_arn: circuit breaker đã rollback về bản cũ." >&2
      jget '"\n".join(e["message"] for e in d["services"][0]["events"][:5])' <"$TMP/poll.json" >&2 || true
      exit 1
    fi
    case "$rollout" in
      COMPLETED)
        if [ "$running" -ge "$desired" ]; then break; fi
        ;;
      FAILED)
        echo "::error::Rollout của $svc ($want_arn) FAILED." >&2
        jget '"\n".join(e["message"] for e in d["services"][0]["events"][:5])' <"$TMP/poll.json" >&2 || true
        exit 1
        ;;
    esac
    if [ "$(date +%s)" -ge "$deadline" ]; then
      echo "::error::Quá ${DEADLINE_SECONDS}s mà rollout của $svc ($want_arn) chưa COMPLETED với runningCount >= $desired ($rollout, running $running)." >&2
      jget '"\n".join(e["message"] for e in d["services"][0]["events"][:5])' <"$TMP/poll.json" >&2 || true
      exit 1
    fi
    sleep "$POLL_SECONDS"
  done
  echo "Rollout COMPLETED: $want_arn (runningCount $running/$desired)"
}

# --- 6. Poll deployment PRIMARY của api ---
wait_rollout "$SERVICE" "$new_arn" "$(jget 'd["services"][0]["desiredCount"]' <"$TMP/svc.json")"

# --- 7. Kiểm sống qua ALB (chứng chỉ self-signed của dev: -k) ---
alb="$(aws elbv2 describe-load-balancers --names "$LB_NAME" --output json | jget 'd["LoadBalancers"][0]["DNSName"]')"
for path in live ready; do
  ok=0
  for i in $(seq 1 "$HEALTH_RETRIES"); do
    code="$(curl -sk -o /dev/null -w '%{http_code}' --max-time 10 "https://${alb}/health/${path}" || true)"
    if [ "$code" = "200" ]; then ok=1; break; fi
    echo "health/${path}: ${code} (lần ${i}/${HEALTH_RETRIES})"
    sleep "$HEALTH_WAIT"
  done
  if [ "$ok" != "1" ]; then
    echo "::error::/health/${path} không trả 200." >&2
    exit 1
  fi
  echo "health/${path}: 200"
done

# --- 8. Worker (BL-248): cùng image, family dbs-worker; chỉ chạy sau khi api đã COMPLETED và khỏe ---
deploy_worker() {
  local rc=0 wstate wdesired wcurrent w_latest_arn w_latest_image w_new_image w_new_arn
  aws ecs describe-services --cluster "$CLUSTER" --services "$WORKER_SERVICE" --output json >"$TMP/wsvc.json" 2>"$TMP/err" || rc=$?
  if [ "$rc" -ne 0 ]; then
    cat "$TMP/err" >&2
    exit 1
  fi
  wstate="$(jget '(lambda s: "NONE" if not s else s[0]["status"] + " " + str(s[0]["desiredCount"]))(d["services"])' <"$TMP/wsvc.json")"
  case "$wstate" in
    NONE | INACTIVE* | DRAINING*)
      echo "::warning::Service $WORKER_SERVICE không có hoặc không ACTIVE ($wstate): bỏ qua worker (api đã deploy xong)."
      return 0
      ;;
  esac
  wdesired="${wstate##* }"

  rc=0
  aws ecs describe-task-definition --task-definition "$WORKER_FAMILY" --include TAGS --output json >"$TMP/wtd.json" 2>"$TMP/err" || rc=$?
  if [ "$rc" -ne 0 ]; then
    if grep -q 'Unable to describe task definition' "$TMP/err"; then
      echo "::error::Family $WORKER_FAMILY chưa có revision ACTIVE: chạy terraform apply ở envs/dev/session (DBS-121)." >&2
    else
      cat "$TMP/err" >&2
    fi
    exit 1
  fi
  w_latest_arn="$(jget 'd["taskDefinition"]["taskDefinitionArn"]' <"$TMP/wtd.json")"
  if ! w_latest_image="$(jget '[c["image"] for c in d["taskDefinition"]["containerDefinitions"] if c["name"] == "'"$WORKER_CONTAINER"'"][0]' <"$TMP/wtd.json" 2>/dev/null)"; then
    echo "::error::Task definition $WORKER_FAMILY không có container $WORKER_CONTAINER." >&2
    exit 1
  fi
  w_new_image="${w_latest_image%:*}:${TAG}"
  if [ "$w_latest_image" = "$w_new_image" ]; then
    w_new_arn="$w_latest_arn"
    echo "Revision mới nhất của $WORKER_FAMILY ($w_latest_arn) đã dùng image này; không đăng ký lại."
  else
    python3 "$HERE/render-task-definition.py" --container "$WORKER_CONTAINER" --image "$w_new_image" <"$TMP/wtd.json" >"$TMP/new-wtd.json"
    w_new_arn="$(aws ecs register-task-definition --cli-input-json "file://$TMP/new-wtd.json" --output json | jget 'd["taskDefinition"]["taskDefinitionArn"]')"
    echo "Đã đăng ký $w_new_arn"
  fi

  wcurrent="$(jget 'd["services"][0]["taskDefinition"]' <"$TMP/wsvc.json")"
  if [ "$wcurrent" != "$w_new_arn" ]; then
    aws ecs update-service --cluster "$CLUSTER" --service "$WORKER_SERVICE" --task-definition "$w_new_arn" --output json >/dev/null
  fi
  if [ "$wdesired" = "0" ]; then
    echo "::warning::Service $WORKER_SERVICE có desiredCount = 0: đã trỏ về $w_new_arn, không có task nên không chờ rollout."
    return 0
  fi
  wait_rollout "$WORKER_SERVICE" "$w_new_arn" "$wdesired"
}
if [ "$DEPLOY_WORKER" = "1" ]; then
  deploy_worker
fi
echo "Deploy ${TAG:0:7} xong."
