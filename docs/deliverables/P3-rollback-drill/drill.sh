#!/usr/bin/env bash
# DBS-156: kịch bản diễn tập rollback ECS Fargate (api + worker) về task definition cũ, đo thời gian và kiểm một giao
# dịch mẫu sau rollback. Quy trình vận hành thật nằm ở docs/runbooks/rollback.md; file này là kịch bản ĐÃ CHẠY để lấy
# số đo, không phải công cụ vận hành.
#
# YÊU CẦU: Linux (hoặc container Linux `dbs-awscli`: Debian, python:3.12 + awscli 1.x + curl + jq; dựng bằng
# `docker build` ở docs/demos/demo-midterm-end-to-end.md, mục «Chuẩn bị Linux»). Script dùng python3 (dựng task
# definition lỗi, đọc JSON), curl >= 7.55 (`-H @file`), aws CLI, awk, sed. Git Bash trên Windows KHÔNG đủ (không có
# python3, và demo-token.sh cần file:///dev/stdin). Từ gốc repo, trong container:
#   MSYS_NO_PATHCONV=1 docker run --rm -t -e AWS_PROFILE -e AWS_DEFAULT_REGION=ap-southeast-1 -e ALB_URL \
#     -e COGNITO_CLIENT_ID -e API_SVC=api -e WORKER_SVC=worker -v "$PWD:/repo" -v "$HOME/.aws:/root/.aws:ro" \
#     -w /repo dbs-awscli bash docs/deliverables/P3-rollback-drill/drill.sh
# Ghi bản phát lại được: bọc bằng `script -q -e -T drill.timing -c "bash drill.sh" drill.typescript`, xem lại bằng
# `scriptreplay -t drill.timing drill.typescript`.
#
# Biến môi trường:
#   ALB_URL           bắt buộc, https://<alb-dns> (chứng chỉ tự ký nên curl -k, chỉ ở dev)
#   AWS_PROFILE       profile trong nhóm dbs-admin (README Terraform ghi `dbs-admin`; trên máy dùng `dbs`)
#   AWS_REGION        mặc định ap-southeast-1
#   CLUSTER, API_SVC, WORKER_SVC   mặc định dbs-dev, api, worker (tên SERVICE trong Terraform, không có tiền tố dbs-dev-)
#   COGNITO_CLIENT_ID cần cho demo-token.sh (tự lấy token operator, customer1, customer2, lấy lại ở Phase D vì sống 15 phút)
#   OP_TOKEN, CUST1_TOKEN, CUST2_TOKEN   thay cho demo-token.sh khi đặt AUTO_TOKEN=0 (token chỉ đi qua biến, không in)
#   CUST1_ACCT, CUST2_ACCT   id tài khoản gửi và nhận; bỏ trống thì lấy tài khoản ACTIVE đầu tiên của customer1, customer2
#   (filter-log-events trả theo trang: mọi phép đếm log cộng số của từng trang)
#   RUN_INVARIANTS    1 (mặc định) chạy invariants.js bằng task `dbs-migrate` ở cuối; 0 để bỏ
# Mọi dòng in ra đã thay id tài khoản AWS bằng <ACCOUNT_ID> và DNS ALB bằng <ALB_DNS>. Không dùng set -x hay curl -v.
set -uo pipefail

AWS_PROFILE="${AWS_PROFILE:-dbs-admin}"
AWS_REGION="${AWS_REGION:-ap-southeast-1}"
export AWS_PROFILE AWS_DEFAULT_REGION="$AWS_REGION" AWS_PAGER=""
CLUSTER="${CLUSTER:-dbs-dev}"
API_SVC="${API_SVC:-api}"
WORKER_SVC="${WORKER_SVC:-worker}"
ALB_URL="${ALB_URL:?ALB_URL là bắt buộc (vd https://<alb-dns>)}"
AUTO_TOKEN="${AUTO_TOKEN:-1}"
RUN_INVARIANTS="${RUN_INVARIANTS:-1}"
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
RUN="$(date -u +%m%d%H%M%S)"
DRILL_FAILS=0

for tool in aws curl python3 awk sed; do
  command -v "$tool" >/dev/null 2>&1 || { echo "Thiếu $tool: chạy trong Linux hoặc container dbs-awscli" >&2; exit 2; }
done

ACCT="$(aws sts get-caller-identity --query Account --output text)" || { echo "Không gọi được AWS (profile/credential)" >&2; exit 2; }
ALB_HOST="${ALB_URL#*://}"
ALB_HOST="${ALB_HOST%%/*}"
# Lọc mọi dòng ra màn hình/log: không bao giờ lộ id tài khoản hay DNS ALB (kể cả trong ARN, lỗi AWS, URL hàng đợi)
redact() { sed -u -e "s/$ACCT/<ACCOUNT_ID>/g" -e "s/$ALB_HOST/<ALB_DNS>/g"; }

ts() { date -u +"%Y-%m-%dT%H:%M:%SZ"; }
epoch() { date +%s; }
say() { printf '%s\n' "$*"; }
tdname() { awk -F/ '{print $NF}'; }
health() { curl -sk -m 5 -o /dev/null -w '%{http_code}' "$ALB_URL/health/$1" || true; }

TMP_DIR="$(mktemp -d)"
chmod 700 "$TMP_DIR"
trap 'rm -rf "$TMP_DIR"' EXIT
RESP="$TMP_DIR/resp.json"

# ---- gọi API: header Authorization nằm trong file chế độ 600 (curl -H @file), không có trên argv hay màn hình ----
set_token() { # <role: op|c1|c2> <token>
  ( umask 077; printf 'Authorization: Bearer %s\n' "$2" >"$TMP_DIR/h-$1" )
}
load_tokens() {
  if [ "$AUTO_TOKEN" = "1" ]; then
    : "${COGNITO_CLIENT_ID:?COGNITO_CLIENT_ID là bắt buộc khi AUTO_TOKEN=1}"
    local pair tok
    for pair in op:operator c1:customer1 c2:customer2; do
      tok="$(bash "$REPO/infra/scripts/demo-token.sh" --role "${pair#*:}")" || return 1
      [ -n "$tok" ] || return 1
      set_token "${pair%%:*}" "$tok"
    done
  else
    set_token op "${OP_TOKEN:?thiếu OP_TOKEN}"
    set_token c1 "${CUST1_TOKEN:?thiếu CUST1_TOKEN}"
    set_token c2 "${CUST2_TOKEN:?thiếu CUST2_TOKEN}"
  fi
  say "Đã lấy token operator, customer1, customer2 (không in)"
}
call() { # <role> <METHOD> <path> [Idempotency-Key] [json-body]: in mã HTTP, body ở $RESP
  local role="$1" method="$2" path="$3" key="${4:-}" body="${5:-}"
  local args=(-sk -m 40 -o "$RESP" -w '%{http_code}' -X "$method" -H "@$TMP_DIR/h-$role")
  [ -n "$key" ] && args+=(-H "Idempotency-Key: $key")
  [ -n "$body" ] && args+=(-H 'Content-Type: application/json' -d "$body")
  curl "${args[@]}" "$ALB_URL$path" || true
}
jget() { # <file> <khóa.khóa>
  python3 - "$1" "$2" <<'PY'
import json, sys
try:
    d = json.load(open(sys.argv[1]))
    for k in sys.argv[2].split("."):
        d = d[k]
    print(d)
except Exception:
    print("")
PY
}
balance_of() { # <role> <account-id>: in số dư (chuỗi số VND) hoặc ERR...
  local code
  code="$(call "$1" GET /v1/accounts)"
  [ "$code" = "200" ] || { echo "ERR$code"; return; }
  python3 - "$RESP" "$2" <<'PY'
import json, sys
for a in json.load(open(sys.argv[1])):
    if a["id"] == sys.argv[2]:
        print(a["balance"])
        break
else:
    print("ERRNOACCOUNT")
PY
}
first_active_account() { # <role>
  local code
  code="$(call "$1" GET /v1/accounts)"
  [ "$code" = "200" ] || { echo ""; return; }
  python3 - "$RESP" <<'PY'
import json, sys
for a in json.load(open(sys.argv[1])):
    if a.get("status") == "ACTIVE":
        print(a["id"])
        break
PY
}
check() { # <mô tả> <mong đợi> <thực tế>
  if [ "$2" = "$3" ]; then say "  PASS  $1 (= $3)"; else say "  FAIL  $1: mong đợi '$2', thực tế '$3'"; DRILL_FAILS=$((DRILL_FAILS + 1)); fi
}
# deposit và transfer KHÔNG chạy trong $(...) để biến toàn cục còn nguyên: LAST_CODE, DEP_*, TR_*
deposit() { # <key> <to> <amount>
  LAST_CODE="$(call op POST /v1/operator/deposits "$1" "{\"toAccountId\":\"$2\",\"amount\":\"$3\"}")"
  DEP_ID="$(jget "$RESP" transferId)"; DEP_STATUS="$(jget "$RESP" status)"
}
transfer() { # <key> <from> <to> <amount>
  LAST_CODE="$(call c1 POST /v1/transfers "$1" "{\"fromAccountId\":\"$2\",\"toAccountId\":\"$3\",\"amount\":\"$4\"}")"
  TR_ID="$(jget "$RESP" transferId)"; TR_STATUS="$(jget "$RESP" status)"
}

svc_state() { # <service> -> "running desired rolloutState taskDefinition" của deployment PRIMARY
  aws ecs describe-services --cluster "$CLUSTER" --services "$1" \
    --query "services[0].[runningCount,desiredCount,deployments[?status=='PRIMARY']|[0].rolloutState,deployments[?status=='PRIMARY']|[0].taskDefinition]" \
    --output text | tdname_last
}
tdname_last() { awk '{n=split($4,p,"/"); print $1, $2, $3, p[n]}'; }
bad_failed() { # <service> <bad-td> -> failedTasks của deployment trỏ bản lỗi (0 nếu chưa có)
  local n
  n="$(aws ecs describe-services --cluster "$CLUSTER" --services "$1" --output text \
    --query "services[0].deployments[?ends_with(taskDefinition, '/$2')]|[0].failedTasks")"
  case "$n" in ''|None) echo 0 ;; *) echo "$n" ;; esac
}
bad_stop_reason() { # <service> <bad-td> -> stoppedReason và exitCode của một task bản lỗi đã dừng
  local ids out
  ids="$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$1" --desired-status STOPPED --query 'taskArns' --output text)"
  if [ -z "$ids" ] || [ "$ids" = "None" ]; then echo "(chưa có task dừng)"; return; fi
  # shellcheck disable=SC2086
  out="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks $ids --output text \
    --query "tasks[?ends_with(taskDefinitionArn, '/$2')]|[0].[stoppedReason,containers[0].exitCode]")"
  echo "$out" | tr '\t' ' ' | cut -c1-220
}
deploy_summary() { # <service> -> từng deployment: status/rolloutState/failedTasks/revision
  aws ecs describe-services --cluster "$CLUSTER" --services "$1" --output text \
    --query 'services[0].deployments[*].[status,rolloutState,failedTasks,taskDefinition]' |
    awk '{n=split($4,p,"/"); printf "%s/%s/failed=%s/%s; ", $1, $2, $3, p[n]}'
}
upd() { # <service> <task-definition>: update-service, ghi FAIL nếu AWS từ chối
  if aws ecs update-service --cluster "$CLUSTER" --service "$1" --task-definition "$2" --force-new-deployment >/dev/null; then
    return 0
  fi
  say "  FAIL  update-service $1 -> $2 bị từ chối"; DRILL_FAILS=$((DRILL_FAILS + 1)); return 1
}
on_exit() { # chạy MỘT lần khi main thoát giữa chừng: đưa hai service về bản tốt, hủy đăng ký bản lỗi
  # Gỡ trap ngay (không chạy lại), bỏ qua SIGPIPE (Ctrl-C giết luôn sed ở đầu kia ống), làm lệnh aws TRƯỚC khi in.
  trap - EXIT INT TERM; trap '' PIPE
  local msg=""
  if [ "${ROLLED_BACK:-1}" = 0 ]; then
    aws ecs update-service --cluster "$CLUSTER" --service "$API_SVC" --task-definition "$API_GOOD_TD" --force-new-deployment >/dev/null 2>&1
    aws ecs update-service --cluster "$CLUSTER" --service "$WORKER_SVC" --task-definition "$WORKER_GOOD_TD" --force-new-deployment >/dev/null 2>&1
    msg="đã đưa $API_SVC về $API_GOOD_TD và $WORKER_SVC về $WORKER_GOOD_TD; "
    ROLLED_BACK=1
  fi
  if [ "${BAD_DEREG:-1}" = 0 ]; then
    aws ecs deregister-task-definition --task-definition "$API_BAD_TD" >/dev/null 2>&1
    aws ecs deregister-task-definition --task-definition "$WORKER_BAD_TD" >/dev/null 2>&1
    msg="${msg}đã hủy đăng ký $API_BAD_TD, $WORKER_BAD_TD"
    BAD_DEREG=1
  fi
  # In ra fd 3 (stderr gốc, mở trước ống) để thông báo vẫn tới được khi sed đã chết; chỉ có tên revision, không bí mật.
  [ -n "$msg" ] && printf '!!! Script dừng giữa chừng: %s\n' "$msg" >&3 2>/dev/null
  return 0
}

make_bad_td() { # <file describe-task-definition> <file ra>: cùng image, chỉ DB_HOST sai
  python3 - "$1" "$2" <<'PY'
import json, sys
d = json.load(open(sys.argv[1]))
td = d["taskDefinition"]
for c in td["containerDefinitions"]:
    for e in c.get("environment", []):
        if e["name"] == "DB_HOST":
            e["value"] = "broken-db-host.invalid"
keys = ["family", "taskRoleArn", "executionRoleArn", "networkMode", "containerDefinitions",
        "requiresCompatibilities", "cpu", "memory", "runtimePlatform"]
out = {k: td[k] for k in keys if k in td}
if d.get("tags"):
    out["tags"] = d["tags"]
json.dump(out, open(sys.argv[2], "w"), indent=2)
PY
}

main() {
  say "=== DBS-156 diễn tập rollback, chạy $RUN, cluster $CLUSTER, api=$API_SVC worker=$WORKER_SVC ==="

  say "=== [Phase A] Nền tốt và giao dịch TRƯỚC khi deploy lỗi, $(ts) ==="
  aws ecs describe-services --cluster "$CLUSTER" --services "$API_SVC" "$WORKER_SVC" \
    --query 'services[*].{name:serviceName,running:runningCount,desired:desiredCount,state:deployments[?status==`PRIMARY`]|[0].rolloutState}' --output table
  API_GOOD_TD="$(aws ecs describe-services --cluster "$CLUSTER" --services "$API_SVC" --query 'services[0].taskDefinition' --output text | tdname)"
  WORKER_GOOD_TD="$(aws ecs describe-services --cluster "$CLUSTER" --services "$WORKER_SVC" --query 'services[0].taskDefinition' --output text | tdname)"
  say "Task definition tốt: api=$API_GOOD_TD worker=$WORKER_GOOD_TD"
  say "Revision ACTIVE của dbs-api:    $(aws ecs list-task-definitions --family-prefix dbs-api --status ACTIVE --sort DESC --max-items 5 --query 'taskDefinitionArns' --output text | sed 's#arn:aws:ecs:[^/]*/##g')"
  say "Revision ACTIVE của dbs-worker: $(aws ecs list-task-definitions --family-prefix dbs-worker --status ACTIVE --sort DESC --max-items 5 --query 'taskDefinitionArns' --output text | sed 's#arn:aws:ecs:[^/]*/##g')"
  say "Health live: $(health live)"
  say "Health ready: $(health ready)"

  load_tokens || { say "Không lấy được token"; return 2; }
  CUST1_ACCT="${CUST1_ACCT:-$(first_active_account c1)}"
  CUST2_ACCT="${CUST2_ACCT:-$(first_active_account c2)}"
  [ -n "$CUST1_ACCT" ] && [ -n "$CUST2_ACCT" ] || { say "Không tìm thấy tài khoản ACTIVE của customer1/customer2 (đã chạy seed-cloud.sh chưa?)"; return 2; }
  say "Tài khoản: customer1=$CUST1_ACCT customer2=$CUST2_ACCT"

  C1_START="$(balance_of c1 "$CUST1_ACCT")"; C2_START="$(balance_of c2 "$CUST2_ACCT")"
  say "Số dư đầu (customer1, customer2): $C1_START, $C2_START"
  K_DEP1="drill156-$RUN-dep1"; K_TR1="drill156-$RUN-tr1"
  say "Nạp 5.000.000 vào customer1 (Idempotency-Key $K_DEP1):"
  deposit "$K_DEP1" "$CUST1_ACCT" 5000000
  check "nạp 5.000.000 trả 201" 201 "$LAST_CODE"
  check "nạp trạng thái COMPLETED" COMPLETED "$DEP_STATUS"
  say "Chuyển 1.000.000 customer1 -> customer2 (Idempotency-Key $K_TR1):"
  transfer "$K_TR1" "$CUST1_ACCT" "$CUST2_ACCT" 1000000
  check "chuyển 1.000.000 trả 201" 201 "$LAST_CODE"
  check "chuyển trạng thái COMPLETED" COMPLETED "$TR_STATUS"
  TR1_ID="$TR_ID"
  say "transferId trước sự cố: $TR1_ID"
  C1_PRE="$(balance_of c1 "$CUST1_ACCT")"; C2_PRE="$(balance_of c2 "$CUST2_ACCT")"
  say "Số dư TRƯỚC sự cố (customer1, customer2): $C1_PRE, $C2_PRE"
  check "số dư customer1 = đầu + 5.000.000 - 1.000.000" "$((C1_START + 4000000))" "$C1_PRE"
  check "số dư customer2 = đầu + 1.000.000" "$((C2_START + 1000000))" "$C2_PRE"

  say "=== [Phase B] Đăng ký và deploy task definition lỗi (DB_HOST sai), $(ts) ==="
  aws ecs describe-task-definition --task-definition "$API_GOOD_TD" --include TAGS >"$TMP_DIR/api-good.json"
  aws ecs describe-task-definition --task-definition "$WORKER_GOOD_TD" --include TAGS >"$TMP_DIR/worker-good.json"
  make_bad_td "$TMP_DIR/api-good.json" "$TMP_DIR/api-bad.json"
  make_bad_td "$TMP_DIR/worker-good.json" "$TMP_DIR/worker-bad.json"
  API_BAD_TD="$(aws ecs register-task-definition --cli-input-json "file://$TMP_DIR/api-bad.json" --query 'taskDefinition.taskDefinitionArn' --output text | tdname)"
  WORKER_BAD_TD="$(aws ecs register-task-definition --cli-input-json "file://$TMP_DIR/worker-bad.json" --query 'taskDefinition.taskDefinitionArn' --output text | tdname)"
  say "Đã đăng ký bản lỗi: api=$API_BAD_TD worker=$WORKER_BAD_TD (chỉ khác DB_HOST=broken-db-host.invalid)"
  ROLLED_BACK=0; BAD_DEREG=0
  trap on_exit EXIT
  trap 'on_exit; exit 130' INT TERM
  T_BAD="$(epoch)"
  upd "$API_SVC" "$API_BAD_TD" || return 2
  upd "$WORKER_SVC" "$WORKER_BAD_TD" || return 2
  say "Deploy lỗi bắt đầu lúc $(ts); chờ MỖI service có ít nhất một task của bản lỗi dừng vì lỗi (failedTasks >= 1), tối đa 300 giây"
  say "(503 của /health/ready một mình KHÔNG chứng minh bản lỗi hỏng: api chạy 1 task với minimumHealthyPercent 0 nên deploy tốt cũng có khoảng 503)"
  BROKEN_SEEN=0; T_DOWN=""; API_FAILED=0; WORKER_FAILED=0
  while [ $(( $(epoch) - T_BAD )) -lt 300 ]; do
    sleep 10
    HC="$(health ready)"
    API_FAILED="$(bad_failed "$API_SVC" "$API_BAD_TD")"; WORKER_FAILED="$(bad_failed "$WORKER_SVC" "$WORKER_BAD_TD")"
    say "  +$(( $(epoch) - T_BAD ))s health/ready=$HC | api $(svc_state "$API_SVC") failed(bản lỗi)=$API_FAILED | worker $(svc_state "$WORKER_SVC") failed(bản lỗi)=$WORKER_FAILED"
    [ -z "$T_DOWN" ] && [ "$HC" != "200" ] && T_DOWN="$(epoch)"
    if [ "$API_FAILED" -ge 1 ] && [ "$WORKER_FAILED" -ge 1 ]; then BROKEN_SEEN=1; break; fi
  done
  say "  Task bản lỗi đã dừng (api): $(bad_stop_reason "$API_SVC" "$API_BAD_TD")"
  say "  Task bản lỗi đã dừng (worker): $(bad_stop_reason "$WORKER_SVC" "$WORKER_BAD_TD")"
  say "  Deployment lúc t0: api [$(deploy_summary "$API_SVC")] worker [$(deploy_summary "$WORKER_SVC")]"
  if [ "$BROKEN_SEEN" = 1 ]; then
    say "  PASS  cả hai bản lỗi thật sự hỏng trước khi rollback (api failedTasks=$API_FAILED, worker failedTasks=$WORKER_FAILED)"
  else
    say "  FAIL  sau 300 giây chưa thấy task bản lỗi dừng vì lỗi ở cả hai service"; DRILL_FAILS=$((DRILL_FAILS + 1))
  fi
  check "PRIMARY của api vẫn là bản lỗi lúc t0 (circuit breaker chưa tự rollback)" "$API_BAD_TD" "$(svc_state "$API_SVC" | awk '{print $4}')"
  check "PRIMARY của worker vẫn là bản lỗi lúc t0 (circuit breaker chưa tự rollback)" "$WORKER_BAD_TD" "$(svc_state "$WORKER_SVC" | awk '{print $4}')"

  say "=== [Phase C] Rollback về $API_GOOD_TD và $WORKER_GOOD_TD ==="
  T0="$(epoch)"
  say "Rollback bắt đầu t0=$T0 ($(ts))"
  upd "$API_SVC" "$API_GOOD_TD" && upd "$WORKER_SVC" "$WORKER_GOOD_TD" && ROLLED_BACK=1
  T_HEALTH=""; T_API=""; T_WORKER=""; T_TOTAL=""
  while true; do
    ELAPSED=$(( $(epoch) - T0 ))
    A="$(svc_state "$API_SVC")"; W="$(svc_state "$WORKER_SVC")"
    HC="$(health ready)"
    say "  +${ELAPSED}s health=$HC | api $A | worker $W"
    [ -z "$T_HEALTH" ] && [ "$HC" = "200" ] && T_HEALTH="$ELAPSED"
    [ -z "$T_API" ] && [ "$A" = "1 1 COMPLETED $API_GOOD_TD" ] && T_API="$ELAPSED"
    [ -z "$T_WORKER" ] && [ "$W" = "1 1 COMPLETED $WORKER_GOOD_TD" ] && T_WORKER="$ELAPSED"
    if [ -n "$T_API" ] && [ -n "$T_WORKER" ] && [ "$HC" = "200" ]; then T_TOTAL="$ELAPSED"; break; fi
    if [ "$ELAPSED" -ge 600 ]; then say "LỖI: rollback vượt 600 giây"; DRILL_FAILS=$((DRILL_FAILS + 1)); T_TOTAL="$ELAPSED"; break; fi
    sleep 5
  done
  say "Rollback XONG lúc $(ts): /health/ready 200 sau ${T_HEALTH:-?}s, api COMPLETED sau ${T_API:-?}s, worker COMPLETED sau ${T_WORKER:-?}s, tổng ${T_TOTAL}s"
  [ -n "$T_DOWN" ] && [ -n "$T_HEALTH" ] && say "Mất phục vụ ước tính (health khác 200): từ $((T_DOWN - T_BAD))s sau deploy lỗi tới $((T0 + T_HEALTH - T_BAD))s, khoảng $((T0 + T_HEALTH - T_DOWN))s (api 1 task, BL-234)"
  [ "$T_TOTAL" -le 600 ] && say "  PASS  tổng ${T_TOTAL}s <= 600s" || { say "  FAIL  tổng ${T_TOTAL}s > 600s"; DRILL_FAILS=$((DRILL_FAILS + 1)); }

  say "=== [Phase D] Kiểm sau rollback, $(ts) ==="
  aws ecs describe-services --cluster "$CLUSTER" --services "$API_SVC" "$WORKER_SVC" \
    --query 'services[*].{name:serviceName,running:runningCount,desired:desiredCount,deployments:deployments[*].{status:status,rolloutState:rolloutState}}' --output json | tr -d '\n ' ; echo
  say "TD hiện tại: api=$(svc_state "$API_SVC" | awk '{print $4}') worker=$(svc_state "$WORKER_SVC" | awk '{print $4}')"
  check "health live" 200 "$(health live)"
  check "health ready" 200 "$(health ready)"
  for g in api worker; do
    svc="$API_SVC"; [ "$g" = worker ] && svc="$WORKER_SVC"
    tid="$(aws ecs list-tasks --cluster "$CLUSTER" --service-name "$svc" --desired-status RUNNING --query 'taskArns[0]' --output text)"; tid="${tid##*/}"
    if [ -z "$tid" ] || [ "$tid" = "None" ]; then check "có task RUNNING của $g sau rollback" có "không"; continue; fi
    eval "TID_$g=\$tid"
    n_stream="$(aws logs describe-log-streams --log-group-name "/dbs/dev/$g" --log-stream-name-prefix "$g/$g/$tid" --query 'length(logStreams)' --output text)"
    check "luồng log $g/$g/<task tốt> tồn tại (để phép đếm bên dưới có nghĩa)" 1 "$n_stream"
    n_fail="$(aws logs filter-log-events --log-group-name "/dbs/dev/$g" --log-stream-names "$g/$g/$tid" --start-time $((T0 * 1000)) --filter-pattern '"Application startup failed"' --query 'length(events)' --output text | awk '{n += $1} END {print n + 0}')"
    check "log của task tốt $g/$g/<task> từ t0 không có 'Application startup failed'" 0 "$n_fail"
  done
  n_w="$(aws logs filter-log-events --log-group-name /dbs/dev/worker --log-stream-names "worker/worker/$TID_worker" --start-time $((T0 * 1000)) --filter-pattern '"Worker started"' --query 'length(events)' --output text | awk '{n += $1} END {print n + 0}')"
  [ "${n_w:-0}" -ge 1 ] && check "log worker từ t0 có 'Worker started'" ok ok || check "log worker từ t0 có 'Worker started'" ok "không có ($n_w)"
  n_a="$(aws logs filter-log-events --log-group-name /dbs/dev/api --log-stream-names "api/api/${TID_api:-none}" --start-time $((T0 * 1000)) --filter-pattern '"HTTP listener started"' --query 'length(events)' --output text | awk '{n += $1} END {print n + 0}')"
  [ "${n_a:-0}" -ge 1 ] && check "log api từ t0 có 'HTTP listener started'" ok ok || check "log api từ t0 có 'HTTP listener started'" ok "không có ($n_a)"
  for q in risk notification; do
    for suffix in events events-dlq; do
      url="$(aws sqs get-queue-url --queue-name "dbs-dev-$q-$suffix" --query QueueUrl --output text)"
      say "  SQS dbs-dev-$q-$suffix: $(aws sqs get-queue-attributes --queue-url "$url" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible ApproximateNumberOfMessagesDelayed --query 'Attributes' --output json | tr -d '\n ')"
    done
  done

  say "--- Giao dịch mẫu sau rollback (token lấy lại vì sống 15 phút) ---"
  load_tokens || { say "Không lấy được token"; return 2; }
  C1_POST="$(balance_of c1 "$CUST1_ACCT")"; C2_POST="$(balance_of c2 "$CUST2_ACCT")"
  say "(a) Số dư sau rollback (customer1, customer2): $C1_POST, $C2_POST"
  check "(a) customer1 còn nguyên số dư trước sự cố" "$C1_PRE" "$C1_POST"
  check "(a) customer2 còn nguyên số dư trước sự cố" "$C2_PRE" "$C2_POST"
  say "(b) Replay đúng lệnh chuyển trước sự cố (Idempotency-Key $K_TR1, cùng body):"
  transfer "$K_TR1" "$CUST1_ACCT" "$CUST2_ACCT" 1000000
  check "(b) replay trả 201" 201 "$LAST_CODE"
  check "(b) replay cùng transferId với lần đầu" "$TR1_ID" "$TR_ID"
  check "(b) replay trạng thái COMPLETED" COMPLETED "$TR_STATUS"
  check "(b) replay không chuyển lần hai (customer1)" "$C1_PRE" "$(balance_of c1 "$CUST1_ACCT")"
  check "(b) replay không chuyển lần hai (customer2)" "$C2_PRE" "$(balance_of c2 "$CUST2_ACCT")"
  K_DEP2="drill156-$RUN-dep2"; K_TR2="drill156-$RUN-tr2"
  say "(c) Nạp mới 2.000.000 và chuyển mới 500.000:"
  deposit "$K_DEP2" "$CUST1_ACCT" 2000000
  check "(c) nạp mới trả 201" 201 "$LAST_CODE"
  check "(c) nạp mới COMPLETED" COMPLETED "$DEP_STATUS"
  transfer "$K_TR2" "$CUST1_ACCT" "$CUST2_ACCT" 500000
  check "(c) chuyển mới trả 201" 201 "$LAST_CODE"
  check "(c) chuyển mới COMPLETED" COMPLETED "$TR_STATUS"
  [ "$TR_ID" != "$TR1_ID" ] && check "(c) chuyển mới có transferId khác lần trước" ok ok || check "(c) chuyển mới có transferId khác lần trước" khác "trùng"
  C1_END="$(balance_of c1 "$CUST1_ACCT")"; C2_END="$(balance_of c2 "$CUST2_ACCT")"
  say "Số dư cuối (customer1, customer2): $C1_END, $C2_END"
  check "(c) customer1 = trước sự cố + 2.000.000 - 500.000" "$((C1_PRE + 1500000))" "$C1_END"
  check "(c) customer2 = trước sự cố + 500.000" "$((C2_PRE + 500000))" "$C2_END"

  say "=== [Phase E] Dọn bản lỗi và kiểm từ chối revision INACTIVE, $(ts) ==="
  if aws ecs deregister-task-definition --task-definition "$API_BAD_TD" --query 'taskDefinition.status' --output text >/dev/null &&
     aws ecs deregister-task-definition --task-definition "$WORKER_BAD_TD" --query 'taskDefinition.status' --output text >/dev/null; then
    BAD_DEREG=1
  else
    say "  FAIL  hủy đăng ký bản lỗi thất bại"; DRILL_FAILS=$((DRILL_FAILS + 1))
  fi
  say "Đã hủy đăng ký $API_BAD_TD và $WORKER_BAD_TD: $(aws ecs describe-task-definition --task-definition "$API_BAD_TD" --query 'taskDefinition.status' --output text), $(aws ecs describe-task-definition --task-definition "$WORKER_BAD_TD" --query 'taskDefinition.status' --output text)"
  REJECT_MSG="$(aws ecs update-service --cluster "$CLUSTER" --service "$API_SVC" --task-definition "$API_BAD_TD" 2>&1 >/dev/null | tr '\n' ' ' | cut -c1-300)"
  if [ -n "$REJECT_MSG" ]; then say "  PASS  AWS từ chối update-service về revision INACTIVE: $REJECT_MSG"; else say "  FAIL  AWS không từ chối revision INACTIVE"; DRILL_FAILS=$((DRILL_FAILS + 1)); fi
  CUR="$(svc_state "$API_SVC" | awk '{print $4}')"
  check "service api vẫn ở $API_GOOD_TD sau lần bị từ chối" "$API_GOOD_TD" "$CUR"
  if [ "$CUR" != "$API_GOOD_TD" ]; then say "  api bị đẩy sang $CUR: đưa lại về $API_GOOD_TD"; upd "$API_SVC" "$API_GOOD_TD"; fi

  if [ "$RUN_INVARIANTS" = "1" ]; then
    say "=== [Phase F] Bất biến sổ cái (invariants.js trong task dbs-migrate), $(ts) ==="
    python3 "$REPO/infra/scripts/ac-5-10-tools.py" overrides --command node dist/scripts/invariants/invariants.js >"$TMP_DIR/ov-inv.json"
    NET="$(aws ecs describe-services --cluster "$CLUSTER" --services "$API_SVC" --query 'services[0].networkConfiguration' --output json)"
    INV_ARN="$(aws ecs run-task --cluster "$CLUSTER" --task-definition dbs-migrate --launch-type FARGATE --count 1 --started-by drill-156 \
      --network-configuration "$NET" --overrides "file://$TMP_DIR/ov-inv.json" --query 'tasks[0].taskArn' --output text)"
    INV_ID="${INV_ARN##*/}"
    aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$INV_ID" >/dev/null 2>&1 || true
    INV_CODE="$(aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$INV_ID" --query 'tasks[0].containers[0].exitCode' --output text)"
    sleep 5
    aws logs get-log-events --log-group-name /dbs/dev/api --log-stream-name "migrate/migrate/$INV_ID" --start-from-head \
      --query 'events[-3:].message' --output text | cut -c1-400
    check "invariants.js thoát 0 (0 sạch, 1 vi phạm, 2 không kết luận)" 0 "$INV_CODE"
  fi

  say "=== TỔNG KẾT $(ts): $([ "$DRILL_FAILS" -eq 0 ] && echo 'TẤT CẢ ĐẠT' || echo "$DRILL_FAILS kiểm tra KHÔNG đạt"); rollback tổng ${T_TOTAL}s (ngưỡng 600s) ==="
  [ "$DRILL_FAILS" -eq 0 ]
}

exec 3>&2
main 2>&1 | (trap '' INT; redact)
exit "${PIPESTATUS[0]}"
