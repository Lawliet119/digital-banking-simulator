#!/usr/bin/env bash
# DBS-185: AC-5.10 trên cloud. Chuyển tiền đang nằm giữa transaction thì task api bị dừng cứng; gửi lại cùng
# Idempotency-Key phải ra đúng một giao dịch. Kịch bản, điều kiện «lần chạy hợp lệ» và kết quả mong đợi:
# docs/features/DBS-185-ac-5-10-kill-task-cloud.md §2 và docs/demos/demo-3-failure-recovery.md phần E.
#
# Chạy trong container Linux `dbs-awscli` (aws, curl, python3, jq), từ gốc repo, theo từng pha:
#   prepare   revision dbs-api tạm (khóa 30 s, statement 60 s, stopTimeout 2) và deregistration_delay 0
#   baseline  T0: probe + invariants trước khi kill
#   kill      T1-T4: bật trigger pg_sleep, theo dõi, gửi K, stop-task 5 s sau, gỡ trigger, đánh giá «lần chạy hợp lệ»
#   recover   T5-T9: probe, chờ task mới, gửi lại K hai lần, probe
#   verify    T10-T12: đối soát, invariants, audit theo C2, log
#   cleanup   trả service về revision gốc, deregistration_delay 30, deregister revision tạm
# Biến môi trường: API (https://<alb>), CUST_TOKEN (khách chuyển tiền), AUD_TOKEN (auditor, cho verify),
# FROM_ACCOUNT, TO_ACCOUNT, AMOUNT (mặc định 100000), STATE_DIR (mặc định ./.ac510), CLUSTER (mặc định dbs-dev),
# AWS_PROFILE và AWS_DEFAULT_REGION. Token KHÔNG bao giờ được in; không dùng `set -x` hay `curl -v`.
# Trigger tạm dbs185_slow làm MỌI lệnh ghi sổ cái ngủ 110 s trong lúc tồn tại: không bật khi người khác dùng phiên.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS=(python3 "$HERE/ac-5-10-tools.py")
CLUSTER="${CLUSTER:-dbs-dev}"
LOG_GROUP="/dbs/dev/api"
AMOUNT="${AMOUNT:-100000}"
STATE_DIR="${STATE_DIR:-./.ac510}"
SLEEP_SECONDS=110
WATCH_SECONDS=170

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$*"; }
die() { say "LỖI: $*" >&2; exit 1; }
need() { local v; for v in "$@"; do [ -n "${!v:-}" ] || die "thiếu biến môi trường $v"; done; }
st() { printf '%s' "$2" >"$STATE_DIR/$1"; }
ld() { cat "$STATE_DIR/$1" 2>/dev/null || true; }
epoch() { date -u -d "$1" +%s 2>/dev/null; }

mkdir -p "$STATE_DIR" 2>/dev/null || true

net_config() {
  aws ecs describe-services --cluster "$CLUSTER" --services api --query 'services[0].networkConfiguration' --output json
}

# mig_run <tên> <file overrides>: chạy task dbs-migrate, in task id
mig_start() {
  local arn
  arn="$(aws ecs run-task --cluster "$CLUSTER" --task-definition dbs-migrate --launch-type FARGATE --count 1 \
    --started-by ac-5-10 --network-configuration "$(net_config)" --overrides "file://$1" \
    --query 'tasks[0].taskArn' --output text)" || return 1
  [ -n "$arn" ] && [ "$arn" != "None" ] || return 1
  printf '%s' "${arn##*/}"
}
mig_logs() { # task id -> các dòng log (mỗi dòng một JSON)
  aws logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "migrate/migrate/$1" --start-from-head \
    --output json 2>/dev/null | jq -r '.events[].message'
}
mig_wait() { # task id -> chờ STOPPED, in exit code
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$1" >/dev/null 2>&1 || true
  aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$1" --query 'tasks[0].containers[0].exitCode' --output text
}
overrides_file() { # <tên> rồi các đối số của `tools overrides`
  local f="$STATE_DIR/ov-$1.json"
  shift
  "${TOOLS[@]}" overrides "$@" >"$f" || die "không dựng được overrides"
  printf '%s' "$f"
}
run_probe() { # in dòng probe cuối cùng; biến môi trường PROBE_* → env của task
  local envs=(--env "ACCOUNT_ID=$FROM_ACCOUNT" --env "TO_ACCOUNT_ID=$TO_ACCOUNT") f id
  [ -n "$(ld K)" ] && envs+=(--env "IDEM_KEY=$(ld K)")
  [ -n "$(ld inflight_pid)" ] && envs+=(--env "INFLIGHT_PID=$(ld inflight_pid)")
  f="$(overrides_file probe --mode probe "${envs[@]}")"
  id="$(mig_start "$f")" || die "run-task probe thất bại"
  local code
  code="$(mig_wait "$id")"
  sleep 5 # log tới CloudWatch chậm vài giây
  say "probe task $id exitCode=$code"
  mig_logs "$id" | grep '"event":"probe"' | tail -1 | tee "$STATE_DIR/last-probe.json"
  [ "$code" = "0" ] || die "probe thoát $code"
}
run_invariants() {
  local f id code
  f="$(overrides_file inv --command node dist/scripts/invariants/invariants.js)"
  id="$(mig_start "$f")" || die "run-task invariants thất bại"
  code="$(mig_wait "$id")"
  sleep 5
  say "invariants task $id exitCode=$code (0 sạch, 1 vi phạm, 2 không nhận là sạch)"
  mig_logs "$id" | tail -3 | cut -c1-600
  [ "$code" = "0" ]
}
health_code() { curl -sk -o /dev/null -m 5 -w '%{http_code}' "$API/health/ready" 2>/dev/null; }
transfer_body() {
  printf '{"fromAccountId":"%s","toAccountId":"%s","amount":"%s"}' "$FROM_ACCOUNT" "$TO_ACCOUNT" "$AMOUNT"
}
post_transfer() { # <file header> <file body> -> in http code
  curl -sk -m 90 -D "$1" -o "$2" -w '%{http_code}' -X POST "$API/v1/transfers" \
    -H "Authorization: Bearer $CUST_TOKEN" -H 'Content-Type: application/json' \
    -H "Idempotency-Key: $(ld K)" -d "$(transfer_body)"
}
header_value() { grep -i "^$2:" "$1" | head -1 | cut -d: -f2- | tr -d ' \r'; }
phase_prepare() {
  need API
  local td new
  td="$(aws ecs describe-services --cluster "$CLUSTER" --services api --query 'services[0].taskDefinition' --output text)"
  st original_td "$td"
  aws ecs describe-task-definition --task-definition "$td" --output json |
    "${TOOLS[@]}" taskdef --container api --env DATABASE_LOCK_TIMEOUT_MS=30000 --env DATABASE_STATEMENT_TIMEOUT_MS=60000 \
      --stop-timeout 2 >"$STATE_DIR/td.json" || die "taskdef thất bại"
  new="$(aws ecs register-task-definition --cli-input-json "file://$STATE_DIR/td.json" \
    --query 'taskDefinition.taskDefinitionArn' --output text)" || die "register-task-definition thất bại"
  st manual_td "$new"
  say "đã đăng ký revision tạm ${new##*/} (gốc ${td##*/})"
  aws ecs update-service --cluster "$CLUSTER" --service api --task-definition "$new" --query 'service.deployments[0].rolloutState' --output text >/dev/null || die "update-service thất bại"
  aws ecs wait services-stable --cluster "$CLUSTER" --services api || die "service api không ổn định"
  local tg
  tg="$(aws elbv2 describe-target-groups --names dbs-dev-api --query 'TargetGroups[0].TargetGroupArn' --output text)"
  st tg "$tg"
  aws elbv2 modify-target-group-attributes --target-group-arn "$tg" \
    --attributes Key=deregistration_delay.timeout_seconds,Value=0 >/dev/null || die "đặt deregistration_delay thất bại"
  say "deregistration_delay = $(aws elbv2 describe-target-group-attributes --target-group-arn "$tg" --query "Attributes[?Key=='deregistration_delay.timeout_seconds'].Value" --output text)"
  local i
  for i in $(seq 1 60); do [ "$(health_code)" = "200" ] && break; sleep 5; done
  [ "$(health_code)" = "200" ] || die "/health/ready không 200"
  say "api chạy revision tạm, /health/ready 200"
}

phase_baseline() {
  need API FROM_ACCOUNT TO_ACCOUNT
  st K ""
  st inflight_pid ""
  say "T0: probe và invariants trước khi kill"
  run_probe
  run_invariants || die "invariants không sạch trước khi kill"
}

run_db_task() { # <tên> <mode> [--env K=V ...]: chạy xong rồi in các dòng log; trả exit code của task
  local name="$1" f id code
  shift
  f="$(overrides_file "$name" --mode "$@")"
  id="$(mig_start "$f")" || die "run-task $name thất bại"
  code="$(mig_wait "$id")"
  sleep 8
  say "task $name ($id) exitCode=$code"
  mig_logs "$id" | cut -c1-300
  [ "$code" = "0" ]
}

phase_kill() {
  need API CUST_TOKEN FROM_ACCOUNT TO_ACCOUNT
  local k old_task watch_f watch_id ready_t line tries
  k="$(cat /proc/sys/kernel/random/uuid)"
  st K "$k"
  st inflight_pid ""
  old_task="$(aws ecs list-tasks --cluster "$CLUSTER" --service-name api --desired-status RUNNING --query 'taskArns' --output json | jq -r 'if length == 1 then .[0] else empty end')"
  [ -n "$old_task" ] || die "cần đúng một task api RUNNING"
  st old_task "$old_task"
  say "T1: bật trigger dbs185_slow (pg_sleep ${SLEEP_SECONDS}s); task api hiện tại ${old_task##*/}; K=$k"
  run_db_task slowon slow-on --env "SLEEP_SECONDS=$SLEEP_SECONDS" || die "slow-on thất bại"
  watch_f="$(overrides_file watch --mode watch --env "WATCH_SECONDS=$WATCH_SECONDS")"
  watch_id="$(mig_start "$watch_f")" || die "run-task watch thất bại"
  st watch_id "$watch_id"
  ready_t=""
  for tries in $(seq 1 60); do
    line="$(mig_logs "$watch_id" | grep '"event":"READY"' | head -1)"
    if [ -n "$line" ]; then ready_t="$(printf '%s' "$line" | jq -r .t)"; break; fi
    sleep 5
  done
  [ -n "$ready_t" ] || { run_db_task slowoff slow-off || true; die "không thấy READY sau 5 phút"; }
  say "READY lúc $ready_t (đồng hồ container)"
  # rào chắn thô (đồng hồ máy chạy lệnh so với đồng hồ container): chỉ để từ chối gửi muộn; kết luận do evaluate
  local age=$(( $(date -u +%s) - $(epoch "$ready_t") ))
  if [ "$age" -gt 15 ]; then run_db_task slowoff slow-off || true; die "READY đã $age s trước: quá hạn gửi K (≤ 15 s); đã gỡ trigger, chạy lại pha kill"; fi
  local t_send
  t_send="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  say "T2: gửi K (chạy nền), tuổi READY $age s"
  (post_transfer "$STATE_DIR/first.hdr" "$STATE_DIR/first.body" >"$STATE_DIR/first.code" 2>/dev/null) &
  local curl_pid=$!
  sleep 5
  local t_stop
  t_stop="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  aws ecs stop-task --cluster "$CLUSTER" --task "$old_task" --reason "DBS-185 AC-5.10: dung task giua transaction" \
    --query 'task.lastStatus' --output text >/dev/null || die "stop-task thất bại"
  st t_stop "$t_stop"
  say "T3: stop-task lúc $t_stop (K gửi lúc $t_send)"
  wait "$curl_pid" 2>/dev/null || true
  local code corr
  code="$(cat "$STATE_DIR/first.code" 2>/dev/null)"; [ -n "$code" ] || code="000"
  corr="no"; [ -n "$(header_value "$STATE_DIR/first.hdr" x-correlation-id 2>/dev/null)" ] && corr="yes"
  say "client lần đầu: http=$code, có X-Correlation-Id=$corr, thân=$(head -c 120 "$STATE_DIR/first.body" 2>/dev/null | tr '\n' ' ')"
  st client_code "$code"
  st client_corr "$corr"
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$old_task" || die "task api cũ chưa STOPPED"
  aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$old_task" --query 'tasks[0]' --output json >"$STATE_DIR/old-task.json"
  jq '{stoppingAt, executionStoppedAt, stoppedAt, stopCode, stoppedReason, exitCodes: [.containers[]|{name,exitCode}]}' "$STATE_DIR/old-task.json" |
    sed -E 's/[0-9]{12}/<ACCOUNT_ID>/g'
  say "T4: gỡ trigger (slow-off chờ tới khi backend mồ côi hết)"
  run_db_task slowoff slow-off || say "CẢNH BÁO: slow-off thoát khác 0, kiểm trigger bằng probe"
  say "chờ watch kết thúc"
  local wc
  wc="$(mig_wait "$watch_id")"
  sleep 8
  mig_logs "$watch_id" >"$STATE_DIR/watch.jsonl"
  say "watch exitCode=$wc; $(grep -c '"event":"sample"' "$STATE_DIR/watch.jsonl") mẫu; mẫu có backend giữa transaction (3 mẫu đầu):"
  grep '"event":"sample"' "$STATE_DIR/watch.jsonl" | grep -v '"inflight":\[\]' | head -3 | cut -c1-400
  say "mẫu cuối: $(grep '"event":"sample"' "$STATE_DIR/watch.jsonl" | tail -1 | cut -c1-200)"
  local verdict rc
  verdict="$("${TOOLS[@]}" evaluate --watch-log "$STATE_DIR/watch.jsonl" --task-json "$STATE_DIR/old-task.json" \
    --container api --client-code "$code" --client-has-correlation "$corr" --sleep-seconds "$SLEEP_SECONDS")"
  rc=$?
  say "đánh giá lần chạy: $verdict"
  st inflight_pid "$(printf '%s' "$verdict" | jq -r '.inflightPid // empty')"
  if [ "$rc" -eq 0 ]; then say "LẦN CHẠY HỢP LỆ"; else say "LẦN CHẠY KHÔNG HỢP LỆ: ghi nguyên văn, chạy lại pha kill với K mới"; return 3; fi
}

phase_recover() {
  need API CUST_TOKEN FROM_ACCOUNT TO_ACCOUNT
  [ -n "$(ld K)" ] || die "chưa có K: chạy pha kill trước"
  say "T5: probe sau kill (K=$(ld K), inflight pid=$(ld inflight_pid))"
  run_probe
  local i t0 now elapsed
  t0="$(epoch "$(ld t_stop)")"
  say "T6: chờ task api mới và /health/ready 200 qua ALB"
  for i in $(seq 1 120); do [ "$(health_code)" = "200" ] && break; sleep 2; done
  [ "$(health_code)" = "200" ] || die "/health/ready không 200 sau 4 phút"
  now="$(date -u +%s)"; elapsed=$(( now - t0 ))
  say "/health/ready 200 sau ${elapsed} s kể từ stop-task"
  st ready_seconds "$elapsed"
  local new_task
  new_task="$(aws ecs list-tasks --cluster "$CLUSTER" --service-name api --desired-status RUNNING --query 'taskArns[0]' --output text)"
  aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$new_task" --query 'tasks[0].{lastStatus:lastStatus,createdAt:createdAt,startedAt:startedAt}' --output json |
    sed -E 's/[0-9]{12}/<ACCOUNT_ID>/g'
  say "T7: gửi lại K lần 1"
  local c2 c3 code2 code3
  code2="$(post_transfer "$STATE_DIR/retry1.hdr" "$STATE_DIR/retry1.body")"
  c2="$(header_value "$STATE_DIR/retry1.hdr" x-correlation-id)"
  say "retry 1: http=$code2 C2=$c2 thân=$(cat "$STATE_DIR/retry1.body")"
  st C2 "$c2"
  say "T8: gửi lại K lần 2 (replay)"
  code3="$(post_transfer "$STATE_DIR/retry2.hdr" "$STATE_DIR/retry2.body")"
  c3="$(header_value "$STATE_DIR/retry2.hdr" x-correlation-id)"
  say "retry 2: http=$code3 C3=$c3 thân=$(cat "$STATE_DIR/retry2.body")"
  st C3 "$c3"
  st retry_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  say "T9: probe sau khi gửi lại"
  st inflight_pid ""
  run_probe
  [ "$code2" = "201" ] && [ "$code3" = "201" ] || die "lần gửi lại không 201 (code2=$code2, code3=$code3)"
}

phase_verify() {
  need API AUD_TOKEN FROM_ACCOUNT TO_ACCOUNT
  local c2 retry_at i ok
  c2="$(ld C2)"; retry_at="$(ld retry_at)"
  say "T10: chờ reconciliation_runs có dòng started_at sau ${retry_at} (tối đa ~10 phút)"
  ok=""
  for i in $(seq 1 10); do
    run_probe >/dev/null
    ok="$(jq -r --arg after "$retry_at" '[.reconciliation[] | select(.started_at > $after)] | last // empty | "\(.status) mismatched=\(.mismatched_accounts) debit=\(.total_debit) credit=\(.total_credit) balance=\(.total_balance) started=\(.started_at)"' "$STATE_DIR/last-probe.json")"
    [ -n "$ok" ] && break
    sleep 45
  done
  say "đối soát sau lần gửi lại: ${ok:-CHƯA CÓ DÒNG MỚI}"
  jq -c '.reconciliation' "$STATE_DIR/last-probe.json"
  say "T11: invariants.js (DBS-69)"
  run_invariants && say "invariants PASS" || say "invariants KHÔNG sạch"
  say "T12: audit theo C2 (auditor)"
  curl -sk -m 20 "$API/v1/audit/entries?correlationId=$c2" -H "Authorization: Bearer $AUD_TOKEN" | jq -c '.items // . | if type == "array" then map({action, outcome, correlationId, target}) else . end' 2>/dev/null | cut -c1-600
  say "log api có C2:"
  MSYS_NO_PATHCONV=1 aws logs filter-log-events --log-group-name "$LOG_GROUP" --filter-pattern "\"$c2\"" --output json |
    jq -r '.events[] | "\(.logStreamName) \(.message)"' | cut -c1-400 | sed -E 's/[0-9]{12}/<ACCOUNT_ID>/g'
  local old_id
  old_id="$(ld old_task)"; old_id="${old_id##*/}"
  say "log của task api cũ ($old_id) từ lúc gửi K tới sau kill (không dòng nào nghĩa là ALB không cắt kết nối trước kill):"
  MSYS_NO_PATHCONV=1 aws logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "api/api/$old_id" \
    --start-from-head --output json 2>/dev/null | jq -r '.events[-5:][] | .message' | cut -c1-400
}

phase_cleanup() {
  local orig manual tg
  orig="$(ld original_td)"; manual="$(ld manual_td)"; tg="$(ld tg)"
  if [ -n "$orig" ]; then
    aws ecs update-service --cluster "$CLUSTER" --service api --task-definition "$orig" --query 'service.deployments[0].rolloutState' --output text >/dev/null && say "service api về ${orig##*/}"
  fi
  if [ -n "$tg" ]; then
    aws elbv2 modify-target-group-attributes --target-group-arn "$tg" --attributes Key=deregistration_delay.timeout_seconds,Value=30 >/dev/null && say "deregistration_delay về 30"
  fi
  if [ -n "$manual" ]; then
    aws ecs deregister-task-definition --task-definition "$manual" --query 'taskDefinition.status' --output text && say "đã deregister revision tạm ${manual##*/}"
    aws ecs delete-task-definitions --task-definitions "$manual" --query 'failures' --output text 2>/dev/null || true
  fi
}

case "${1:-}" in
  prepare) phase_prepare ;;
  baseline) phase_baseline ;;
  kill) phase_kill ;;
  recover) phase_recover ;;
  verify) phase_verify ;;
  cleanup) phase_cleanup ;;
  *) echo "dùng: $0 prepare|baseline|kill|recover|verify|cleanup (xem đầu file)" >&2; exit 2 ;;
esac
