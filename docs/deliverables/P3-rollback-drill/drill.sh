#!/usr/bin/env bash
set -euo pipefail

# DBS-156: Automated rollback drill script (Phase A-E)
# Requires: AWS_PROFILE=dbs-admin, AWS_REGION=ap-southeast-1, ALB_URL,
#           OP_TOKEN, CUST1_TOKEN, CUST2_TOKEN, CUST1_ACCT, CUST2_ACCT

AWS_PROFILE="${AWS_PROFILE:-dbs-admin}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
CLUSTER="${CLUSTER:-dbs-dev}"
API_SVC="${API_SVC:-dbs-dev-api}"
WORKER_SVC="${WORKER_SVC:-dbs-dev-worker}"
ALB_URL="${ALB_URL:?ALB_URL is required (e.g. https://<alb-dns>)}"

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
epoch() { date +%s; }

echo "=== [Phase A] Baseline check at $(ts) ==="
aws ecs describe-services --cluster "$CLUSTER" --services "$API_SVC" "$WORKER_SVC" \
  --region "$AWS_REGION" --profile "$AWS_PROFILE" \
  --query 'services[*].{name:serviceName,td:taskDefinition,running:runningCount,desired:desiredCount}' --output table

API_GOOD_TD=$(aws ecs describe-services --cluster "$CLUSTER" --services "$API_SVC" \
  --region "$AWS_REGION" --profile "$AWS_PROFILE" --query 'services[0].taskDefinition' --output text | awk -F/ '{print $NF}')
WORKER_GOOD_TD=$(aws ecs describe-services --cluster "$CLUSTER" --services "$WORKER_SVC" \
  --region "$AWS_REGION" --profile "$AWS_PROFILE" --query 'services[0].taskDefinition' --output text | awk -F/ '{print $NF}')
echo "Good TDs: api=$API_GOOD_TD worker=$WORKER_GOOD_TD"

aws ecs list-task-definitions --family-prefix dbs-api --status ACTIVE --sort DESC \
  --region "$AWS_REGION" --profile "$AWS_PROFILE" --max-items 5 --output text
aws ecs list-task-definitions --family-prefix dbs-worker --status ACTIVE --sort DESC \
  --region "$AWS_REGION" --profile "$AWS_PROFILE" --max-items 5 --output text

echo "Health live: $(curl -sk -o /dev/null -w '%{http_code}' "$ALB_URL/health/live")"
echo "Health ready: $(curl -sk -o /dev/null -w '%{http_code}' "$ALB_URL/health/ready")"

echo "=== [Phase B] Register & deploy broken task definitions at $(ts) ==="
TMP_DIR=$(mktemp -d)
trap 'rm -rf "$TMP_DIR"' EXIT

aws ecs describe-task-definition --task-definition "$API_GOOD_TD" --include TAGS \
  --region "$AWS_REGION" --profile "$AWS_PROFILE" > "$TMP_DIR/api-good.json"
aws ecs describe-task-definition --task-definition "$WORKER_GOOD_TD" --include TAGS \
  --region "$AWS_REGION" --profile "$AWS_PROFILE" > "$TMP_DIR/worker-good.json"

python3 - "$TMP_DIR/api-good.json" "$TMP_DIR/api-bad.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
td = d["taskDefinition"]
for c in td["containerDefinitions"]:
    for e in c.get("environment", []):
        if e["name"] == "DB_HOST":
            e["value"] = "broken-db-host.invalid"
out = {k: td[k] for k in ["family", "taskRoleArn", "executionRoleArn", "networkMode", "containerDefinitions", "requiresCompatibilities", "cpu", "memory", "runtimePlatform"] if k in td}
if d.get("tags"): out["tags"] = d["tags"]
json.dump(out, open(sys.argv[2], "w"), indent=2)
PY

python3 - "$TMP_DIR/worker-good.json" "$TMP_DIR/worker-bad.json" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
td = d["taskDefinition"]
for c in td["containerDefinitions"]:
    for e in c.get("environment", []):
        if e["name"] == "DB_HOST":
            e["value"] = "broken-db-host.invalid"
out = {k: td[k] for k in ["family", "taskRoleArn", "executionRoleArn", "networkMode", "containerDefinitions", "requiresCompatibilities", "cpu", "memory", "runtimePlatform"] if k in td}
if d.get("tags"): out["tags"] = d["tags"]
json.dump(out, open(sys.argv[2], "w"), indent=2)
PY

API_BAD_TD=$(aws ecs register-task-definition --cli-input-json "file://$TMP_DIR/api-bad.json" \
  --region "$AWS_REGION" --profile "$AWS_PROFILE" --query 'taskDefinition.taskDefinitionArn' --output text | awk -F/ '{print $NF}')
WORKER_BAD_TD=$(aws ecs register-task-definition --cli-input-json "file://$TMP_DIR/worker-bad.json" \
  --region "$AWS_REGION" --profile "$AWS_PROFILE" --query 'taskDefinition.taskDefinitionArn' --output text | awk -F/ '{print $NF}')
echo "Bad TDs registered: api=$API_BAD_TD worker=$WORKER_BAD_TD"

T_BAD=$(epoch)
aws ecs update-service --cluster "$CLUSTER" --service "$API_SVC" --task-definition "$API_BAD_TD" --force-new-deployment --region "$AWS_REGION" --profile "$AWS_PROFILE" >/dev/null
aws ecs update-service --cluster "$CLUSTER" --service "$WORKER_SVC" --task-definition "$WORKER_BAD_TD" --force-new-deployment --region "$AWS_REGION" --profile "$AWS_PROFILE" >/dev/null

echo "Polling broken deploy (max 120s)..."
for i in $(seq 1 12); do
  sleep 10
  HC=$(curl -sk -o /dev/null -w '%{http_code}' "$ALB_URL/health/ready" || echo "000")
  echo "  +${i}0s health/ready=$HC"
  if [ "$HC" != "200" ] && [ "$i" -ge 4 ]; then
    break
  fi
done

echo "=== [Phase C] Rollback to $API_GOOD_TD and $WORKER_GOOD_TD ==="
T0=$(epoch)
echo "Rollback start t0=$T0 ($(ts))"
aws ecs update-service --cluster "$CLUSTER" --service "$API_SVC" --task-definition "$API_GOOD_TD" --force-new-deployment --region "$AWS_REGION" --profile "$AWS_PROFILE" >/dev/null
aws ecs update-service --cluster "$CLUSTER" --service "$WORKER_SVC" --task-definition "$WORKER_GOOD_TD" --force-new-deployment --region "$AWS_REGION" --profile "$AWS_PROFILE" >/dev/null

while true; do
  NOW=$(epoch)
  ELAPSED=$((NOW - T0))
  STATE=$(aws ecs describe-services --cluster "$CLUSTER" --services "$API_SVC" "$WORKER_SVC" \
    --region "$AWS_REGION" --profile "$AWS_PROFILE" \
    --query 'services[*].[serviceName,runningCount,desiredCount,deployments[0].rolloutState]' --output text)
  HC=$(curl -sk -o /dev/null -w '%{http_code}' "$ALB_URL/health/ready" || echo "000")
  echo "  +${ELAPSED}s health=$HC | $(echo "$STATE" | tr '\n' ' ')"
  if echo "$STATE" | awk 'BEGIN{ok=1} {if ($2 != $3 || $4 != "COMPLETED") ok=0} END{exit !ok}' && [ "$HC" = "200" ]; then
    T1=$(epoch)
    echo "Rollback COMPLETED in $((T1 - T0))s at $(ts)"
    break
  fi
  if [ "$ELAPSED" -ge 600 ]; then
    echo "ERROR: Rollback exceeded 600s!"
    exit 1
  fi
  sleep 5
done

echo "=== [Phase D] Post-rollback verification ==="
aws ecs describe-services --cluster "$CLUSTER" --services "$API_SVC" "$WORKER_SVC" \
  --region "$AWS_REGION" --profile "$AWS_PROFILE" \
  --query 'services[*].{name:serviceName,taskDefinition:taskDefinition,running:runningCount,desired:desiredCount,deployments:deployments[*].{status:status,rolloutState:rolloutState}}' --output table
echo "Health live: $(curl -sk -o /dev/null -w '%{http_code}' "$ALB_URL/health/live")"
echo "Health ready: $(curl -sk -o /dev/null -w '%{http_code}' "$ALB_URL/health/ready")"
