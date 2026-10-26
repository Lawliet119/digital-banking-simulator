#!/usr/bin/env bash
# DBS-38: cập nhật service `api` trên ECS lên image <repo>:<IMAGE_TAG> và kiểm sống qua ALB.
#
# Chạy bởi .github/workflows/deploy.yml, hoặc tay (không cần `gh`):
#   IMAGE_TAG=<sha 40 ký tự> AWS_PROFILE=dbs-admin bash .github/scripts/deploy.sh
#
# Thứ tự: (kiểm đầu main) → service có tồn tại và có task? → tag có trên ECR? → render task definition từ
# revision ACTIVE mới nhất của family (chỉ đổi image) → đăng ký → update-service → poll deployment PRIMARY
# → curl /health/live và /health/ready qua ALB. Migration (DBS-68) chạy giữa "đăng ký" và "update-service":
# migrate.sh lỗi thì dừng, service vẫn ở bản cũ. Không dùng `aws ecs wait services-stable`: nó chỉ chờ 10 phút
# và vẫn "đạt" sau khi circuit breaker đã rollback về bản cũ.
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

# --- 6. Poll deployment PRIMARY: phải ở revision mới và COMPLETED ---
deadline=$(( $(date +%s) + DEADLINE_SECONDS ))
while true; do
  aws ecs describe-services --cluster "$CLUSTER" --services "$SERVICE" --output json >"$TMP/poll.json"
  line="$(jget '(lambda p: p["taskDefinition"] + " " + p["rolloutState"])([x for x in d["services"][0]["deployments"] if x["status"] == "PRIMARY"][0])' <"$TMP/poll.json")"
  primary_arn="${line% *}"
  rollout="${line##* }"
  if [ "$primary_arn" != "$new_arn" ]; then
    echo "::error::Deployment PRIMARY đang ở $primary_arn, không phải $new_arn: circuit breaker đã rollback về bản cũ." >&2
    jget '"\n".join(e["message"] for e in d["services"][0]["events"][:5])' <"$TMP/poll.json" >&2 || true
    exit 1
  fi
  case "$rollout" in
    COMPLETED) break ;;
    FAILED)
      echo "::error::Rollout của $new_arn FAILED." >&2
      jget '"\n".join(e["message"] for e in d["services"][0]["events"][:5])' <"$TMP/poll.json" >&2 || true
      exit 1
      ;;
  esac
  if [ "$(date +%s)" -ge "$deadline" ]; then
    echo "::error::Quá ${DEADLINE_SECONDS}s mà rollout của $new_arn chưa COMPLETED ($rollout)." >&2
    jget '"\n".join(e["message"] for e in d["services"][0]["events"][:5])' <"$TMP/poll.json" >&2 || true
    exit 1
  fi
  sleep "$POLL_SECONDS"
done
echo "Rollout COMPLETED: $new_arn"

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
echo "Deploy ${TAG:0:7} xong."
