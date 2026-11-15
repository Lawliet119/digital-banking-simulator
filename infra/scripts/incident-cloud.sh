#!/usr/bin/env bash
# DBS-184: chạy bốn kịch bản sự cố bất đồng bộ của docs/runbooks/async-incident-scenarios.md trên phiên cloud AWS dev.
# Thiết kế, ngưỡng và kết quả mong đợi: docs/features/DBS-184-cloud-incident-scenarios.md §2.
#
# Chạy trong container Linux `dbs-awscli` (aws v1, curl, python3, jq), từ gốc repo, theo từng pha:
#   latency <nhãn>   3 lệnh khởi động + 24 lệnh chuyển 1.000 VND customer2 -> customer3, p50/p95/p99 phía máy chủ
#   bad-messages     (b) hai message hỏng vào risk-events, đo DLQ/alarm/log, bỏ qua có ghi nhận (runbook DLQ 3c)
#   block            ép notification lỗi (constraint dbs183_block qua task dbs-migrate)
#   ac91             lệnh 44.000.000 customer1 -> customer3 (R3 + R6 = 65), in cờ của đúng transferId
#   dlq-wait         chờ message attempts_exhausted vào DLQ notification, alarm, log dead_letter
#   unblock          gỡ constraint, kiểm pg_constraint
#   resend           gửi lại tay từng eventId từ DLQ notification (không redrive, không purge)
#   verify-c         audit notification.sent của lệnh AC-9.1 và invariants.js
#   worker-off | d-traffic | outbox-wait | worker-on     (d) worker tắt rồi bật
#   final-check      trước destroy: không constraint, worker 1, 4 queue = 0, alarm DLQ OK
# Biến môi trường: API, CUST1_TOKEN, CUST2_TOKEN, CUST3_TOKEN, OP_TOKEN, AUD_TOKEN, ACC1, ACC2, ACC3 (CHECKING của customer1..3),
# STATE_DIR (mặc định ./.incident), CLUSTER (mặc định dbs-dev), AWS_PROFILE, AWS_DEFAULT_REGION.
# Token KHÔNG bao giờ được in; không dùng `set -x` hay `curl -v`; chỉ in MessageId và eventId của message SQS, không in body
# hay ReceiptHandle (file chứa chúng nằm ngoài repo, ~/dbs-ops/dlq/).
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TOOLS=(python3 "$HERE/ac-5-10-tools.py")
CLUSTER="${CLUSTER:-dbs-dev}"
LOG_GROUP="/dbs/dev/api"
STATE_DIR="${STATE_DIR:-./.incident}"
OPS_DIR="${HOME:-/root}/dbs-ops/dlq"

say() { printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)" "$*"; }
st() { mkdir -p "$STATE_DIR" && printf '%s' "$2" >"$STATE_DIR/$1"; }
ld() { cat "$STATE_DIR/$1" 2>/dev/null || true; }
safety_net() { # chạy khi die: gỡ constraint và bật worker nếu pha trước để lại
  if [ "$(ld blocked)" = "1" ]; then say "safety-net: gỡ constraint"; mig_db notification-unblock >/dev/null 2>&1 && st blocked 0; fi
  if [ "$(ld worker_off)" = "1" ]; then say "safety-net: bật worker"; aws ecs update-service --cluster "$CLUSTER" --service worker --desired-count 1 >/dev/null 2>&1 && st worker_off 0; fi
}
die() { say "LỖI: $*" >&2; safety_net; exit 1; }
need() { local v; for v in "$@"; do [ -n "${!v:-}" ] || die "thiếu biến môi trường $v"; done; }
epoch() { date -u -d "$1" +%s 2>/dev/null; }

net_config() { aws ecs describe-services --cluster "$CLUSTER" --services api --query 'services[0].networkConfiguration' --output json; }
mig_start() {
  local arn
  arn="$(aws ecs run-task --cluster "$CLUSTER" --task-definition dbs-migrate --launch-type FARGATE --count 1 \
    --started-by incident --network-configuration "$(net_config)" --overrides "file://$1" \
    --query 'tasks[0].taskArn' --output text)" || return 1
  [ -n "$arn" ] && [ "$arn" != "None" ] || return 1
  printf '%s' "${arn##*/}"
}
mig_wait() {
  aws ecs wait tasks-stopped --cluster "$CLUSTER" --tasks "$1" >/dev/null 2>&1 || true
  aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$1" --query 'tasks[0].containers[0].exitCode' --output text
}
mig_logs() { aws logs get-log-events --log-group-name "$LOG_GROUP" --log-stream-name "migrate/migrate/$1" --start-from-head --output json 2>/dev/null | jq -r '.events[].message'; }
mig_db() { # <mode>: chạy incident-db.js trong task dbs-migrate, in dòng log, trả exit code
  mkdir -p "$STATE_DIR"
  local f="$STATE_DIR/ov-$1.json" id code
  "${TOOLS[@]}" overrides --script "$HERE/incident-db.js" --mode "$1" >"$f" || return 1
  id="$(mig_start "$f")" || { say "run-task thất bại"; return 1; }
  code="$(mig_wait "$id")"
  sleep 6
  say "task $1 ($id) exitCode=$code"
  mig_logs "$id" | cut -c1-300
  [ "$code" = "0" ]
}
run_invariants() {
  mkdir -p "$STATE_DIR"
  local f="$STATE_DIR/ov-inv.json" id code
  "${TOOLS[@]}" overrides --command node dist/scripts/invariants/invariants.js >"$f" || return 1
  id="$(mig_start "$f")" || die "run-task invariants thất bại"
  code="$(mig_wait "$id")"
  sleep 6
  say "invariants task $id exitCode=$code (0 sạch)"
  mig_logs "$id" | tail -2 | cut -c1-300
  [ "$code" = "0" ]
}

# --- SQS và alarm ---
qurl() { aws sqs get-queue-url --queue-name "dbs-dev-$1" --query QueueUrl --output text; }
qcount() { # tên: in "visible/notvisible/delayed"
  aws sqs get-queue-attributes --queue-url "$(qurl "$1")" --attribute-names ApproximateNumberOfMessages ApproximateNumberOfMessagesNotVisible ApproximateNumberOfMessagesDelayed \
    --query 'Attributes.[ApproximateNumberOfMessages,ApproximateNumberOfMessagesNotVisible,ApproximateNumberOfMessagesDelayed]' --output text | tr '\t' '/'
}
alarm_state() { aws cloudwatch describe-alarms --alarm-names "$1" --query 'MetricAlarms[0].[StateValue,StateUpdatedTimestamp]' --output text | tr '\t' ' '; }
all_zero() { local q; for q in risk-events risk-events-dlq notification-events notification-events-dlq; do [ "$(qcount "$q")" = "0/0/0" ] || return 1; done; }
wait_clean() { # chờ bốn queue về 0 và hai alarm DLQ về OK (trần 15 phút)
  local i
  for i in $(seq 1 90); do
    if all_zero && [ "$(alarm_state dbs-dev-risk-dlq-not-empty | cut -d' ' -f1)" = "OK" ] && [ "$(alarm_state dbs-dev-notification-dlq-not-empty | cut -d' ' -f1)" = "OK" ]; then
      say "sạch: bốn queue 0/0/0, hai alarm DLQ OK"; return 0
    fi
    sleep 10
  done
  say "CHƯA sạch sau 15 phút: risk-dlq $(qcount risk-events-dlq), notif-dlq $(qcount notification-events-dlq), alarm risk $(alarm_state dbs-dev-risk-dlq-not-empty), notif $(alarm_state dbs-dev-notification-dlq-not-empty)"
  return 1
}
api_post() { # token path body key -> in "mã|correlationId|transferId"
  local hdr body code
  hdr="$(mktemp)"; body="$(mktemp)"
  code="$(curl -sk -m 30 -D "$hdr" -o "$body" -w '%{http_code}' -X POST "$API$2" -H "Authorization: Bearer $1" -H 'Content-Type: application/json' -H "Idempotency-Key: $4" -d "$3")"
  printf '%s|%s|%s' "$code" "$(grep -i '^x-correlation-id:' "$hdr" | head -1 | cut -d: -f2- | tr -d ' \r')" "$(jq -r '.transferId // empty' "$body" 2>/dev/null)"
  rm -f "$hdr" "$body"
}
uuid() { cat /proc/sys/kernel/random/uuid; }
transfer_body() { printf '{"fromAccountId":"%s","toAccountId":"%s","amount":"%s"}' "$1" "$2" "$3"; }
flag_of() { # transferId -> in cờ (điểm, mức, trạng thái), chờ tối đa 60 s
  local i out
  for i in $(seq 1 30); do
    out="$(curl -sk -m 10 "$API/v1/operator/fraud-flags/$1" -H "Authorization: Bearer $OP_TOKEN")"
    if printf '%s' "$out" | jq -e '.score' >/dev/null 2>&1; then printf '%s' "$out" | jq -c '{score, riskLevel, reviewStatus, ruleSetVersion}'; return 0; fi
    sleep 2
  done
  echo "không có cờ sau 60 s"; return 1
}
audit_count() { # correlationId action -> số dòng
  curl -sk -m 20 "$API/v1/audit/entries?correlationId=$1&action=$2" -H "Authorization: Bearer $AUD_TOKEN" | jq -r '.entries | length'
}

phase_latency() {
  need API CUST2_TOKEN ACC2 ACC3
  local label="${1:?nhãn}" i code t0 t1 res
  say "latency $label: 3 lệnh khởi động rồi 24 lệnh 1.000 VND customer2 -> customer3, 7 s một lệnh"
  : >"$STATE_DIR/curl-$label.txt" 2>/dev/null || { mkdir -p "$STATE_DIR"; : >"$STATE_DIR/curl-$label.txt"; }
  for i in $(seq 1 27); do
    [ "$i" = "4" ] && t0="$(date -u +%s%3N)"
    res="$(curl -sk -m 30 -o /dev/null -w '%{http_code} %{time_appconnect} %{time_starttransfer}' -X POST "$API/v1/transfers" -H "Authorization: Bearer $CUST2_TOKEN" \
      -H 'Content-Type: application/json' -H "Idempotency-Key: $(uuid)" -d "$(transfer_body "$ACC2" "$ACC3" 1000)")"
    [ "$i" -ge 4 ] && echo "$res" >>"$STATE_DIR/curl-$label.txt"
    code="${res%% *}"
    [ "$code" = "201" ] || say "lệnh $i: http=$code"
    sleep 7
  done
  t1="$(date -u +%s%3N)"
  sleep 8
  MSYS_NO_PATHCONV=1 aws logs filter-log-events --log-group-name "$LOG_GROUP" --start-time "$t0" --end-time "$t1" \
    --filter-pattern '{ $.req.method = "POST" && $.res.statusCode = 201 }' --output json |
    jq -r '.events[].message | fromjson | .responseTime' >"$STATE_DIR/server-$label.txt"
  python3 - "$STATE_DIR/server-$label.txt" "$STATE_DIR/curl-$label.txt" "$label" <<'PY'
import json, math, sys
def pct(v, p):
    v = sorted(v)
    return v[max(0, math.ceil(p * len(v)) - 1)]
server = [float(x) for x in open(sys.argv[1]).read().split()]
client = []
codes = {}
for line in open(sys.argv[2]):
    parts = line.split()
    if len(parts) == 3:
        codes[parts[0]] = codes.get(parts[0], 0) + 1
        client.append((float(parts[2]) - float(parts[1])) * 1000)
out = {"label": sys.argv[3], "serverSamples": len(server), "clientSamples": len(client), "httpCodes": codes}
for name, v in (("server", server), ("client", client)):
    if v:
        out[name] = {"p50_ms": round(pct(v, 0.5), 1), "p95_ms": round(pct(v, 0.95), 1), "p99_ms": round(pct(v, 0.99), 1), "max_ms": round(max(v), 1)}
print(json.dumps(out))
open(sys.argv[2].replace("curl-", "summary-").replace(".txt", ".json"), "w").write(json.dumps(out))
PY
}

phase_bad_messages() {
  need API
  mkdir -p "$OPS_DIR" "$STATE_DIR"
  local risk dlq t_send i n ts skip
  risk="$(qurl risk-events)"; dlq="$(qurl risk-events-dlq)"
  all_zero || die "queue chưa sạch trước (b)"
  t_send="$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  say "(b) gửi hai message hỏng vào risk-events lúc $t_send"
  say "message 1 (không phải JSON): MessageId $(aws sqs send-message --queue-url "$risk" --message-body '{not json' --query MessageId --output text)"
  say "message 2 (JSON hợp lệ, sai schema): MessageId $(aws sqs send-message --queue-url "$risk" --message-body '{"eventType":"TransferCompleted"}' --query MessageId --output text)"
  for i in $(seq 1 24); do
    n="$(aws sqs get-queue-attributes --queue-url "$dlq" --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)"
    [ "$n" -ge 2 ] 2>/dev/null && break
    sleep 5
  done
  say "DLQ risk sau $(( $(date -u +%s) - $(epoch "$t_send") )) s: $(qcount risk-events-dlq) (mong đợi 2/0/0); risk-events chính: $(qcount risk-events)"
  say "chờ alarm dbs-dev-risk-dlq-not-empty sang ALARM (tối đa 8 phút)"
  for i in $(seq 1 48); do
    [ "$(alarm_state dbs-dev-risk-dlq-not-empty | cut -d' ' -f1)" = "ALARM" ] && break
    sleep 10
  done
  say "alarm: $(alarm_state dbs-dev-risk-dlq-not-empty) ($(( $(date -u +%s) - $(epoch "$t_send") )) s kể từ lúc gửi)"
  say "log worker dead_letter từ lúc gửi (BL-364): chỉ in consumer, reason, issueCodes, eventId"
  MSYS_NO_PATHCONV=1 aws logs filter-log-events --log-group-name /dbs/dev/worker --start-time "$(( $(epoch "$t_send") * 1000 ))" --filter-pattern '"dead_letter"' --output json |
    jq -r '.events[].message | fromjson | {level, consumer, reason, issueCodes, eventId, receiveCount, messageId} | tostring' | cut -c1-300
  # bỏ qua có ghi nhận (runbook DLQ 3c): lưu body ra file ngoài repo rồi xóa theo handle; chỉ in MessageId
  ts="$(date -u +%Y%m%dT%H%M%S)"; skip="$OPS_DIR/skip-risk-events-dlq-$ts.jsonl"
  [ ! -e "$skip" ] || die "$skip đã có"
  for i in 1 2 3; do
    aws sqs receive-message --queue-url "$dlq" --max-number-of-messages 10 --wait-time-seconds 5 --visibility-timeout 120 --attribute-names All --message-attribute-names All --output json |
      jq -c '.Messages[]?' >"$STATE_DIR/batch.json"
    [ -s "$STATE_DIR/batch.json" ] || continue
    cat "$STATE_DIR/batch.json" >>"$skip"
    while IFS= read -r m; do
      say "bỏ qua message $(printf '%s' "$m" | jq -r .MessageId) (nhãn: không phải JSON hoặc sai schema)"
      aws sqs delete-message --queue-url "$dlq" --receipt-handle "$(printf '%s' "$m" | jq -r .ReceiptHandle)" || say "xóa thất bại"
    done <"$STATE_DIR/batch.json"
  done
  say "file bỏ qua (ngoài repo): $(wc -l <"$skip") dòng; DLQ risk sau xóa: $(qcount risk-events-dlq)"
  wait_clean
}

phase_block() {
  need API
  all_zero || die "queue chưa sạch trước khi ép lỗi"
  st blocked 1
  mig_db notification-block || die "notification-block thất bại"
  mig_db notification-check || die "notification-check thất bại"
}

phase_ac91() {
  need API CUST1_TOKEN OP_TOKEN ACC1 ACC3
  local r code c t
  r="$(api_post "$CUST1_TOKEN" /v1/transfers "$(transfer_body "$ACC1" "$ACC3" 44000000)" "$(uuid)")"
  code="${r%%|*}"; c="$(printf '%s' "$r" | cut -d'|' -f2)"; t="$(printf '%s' "$r" | cut -d'|' -f3)"
  say "lệnh AC-9.1 44.000.000: http=$code C=$c T=$t lúc $(date -u +%H:%M:%S)"
  st ac91_c "$c"; st ac91_t "$t"; st ac91_at "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  [ "$code" = "201" ] || die "lệnh AC-9.1 không 201"
  say "cờ của transferId $t: $(flag_of "$t")"
  say "DLQ risk: $(qcount risk-events-dlq) (mong đợi 0/0/0); audit notification.sent của C: $(audit_count "$c" notification.sent) dòng (mong đợi 0 khi lỗi còn)"
}

phase_dlq_wait() {
  need API
  local i n first="" t0
  t0="$(date -u +%s)"
  say "chờ message attempts_exhausted vào dbs-dev-notification-events-dlq (tối đa 8 phút)"
  for i in $(seq 1 48); do
    n="$(aws sqs get-queue-attributes --queue-url "$(qurl notification-events-dlq)" --attribute-names ApproximateNumberOfMessages --query Attributes.ApproximateNumberOfMessages --output text)"
    if [ "$n" -ge 1 ] 2>/dev/null && [ -z "$first" ]; then first="$(date -u +%s)"; say "message đầu tiên vào DLQ notification (số hiện $n)"; fi
    [ -n "$first" ] && [ $(( $(date -u +%s) - first )) -ge 60 ] && break
    sleep 10
  done
  say "DLQ notification: $(qcount notification-events-dlq); queue chính notification: $(qcount notification-events)"
  for i in $(seq 1 48); do
    [ "$(alarm_state dbs-dev-notification-dlq-not-empty | cut -d' ' -f1)" = "ALARM" ] && break
    sleep 10
  done
  say "alarm notification-dlq-not-empty: $(alarm_state dbs-dev-notification-dlq-not-empty) (đo từ lệnh AC-9.1: $(( $(date -u +%s) - $(epoch "$(ld ac91_at)") )) s)"
  say "log worker dead_letter attempts_exhausted (BL-364), 3 dòng đầu và tổng:"
  MSYS_NO_PATHCONV=1 aws logs filter-log-events --log-group-name /dbs/dev/worker --start-time "$(( $(epoch "$(ld ac91_at)") * 1000 ))" --filter-pattern '"dead_letter"' --output json |
    jq -r '[.events[].message | fromjson | select(.reason == "attempts_exhausted")] | "tổng \(length) dòng", (.[:3][] | {level, consumer, reason, eventId, receiveCount, messageId} | tostring)' | cut -c1-300
}

phase_unblock() {
  need API
  mig_db notification-unblock || die "notification-unblock thất bại"
  st blocked 0
  mig_db notification-check || die "notification-check thất bại"
}

phase_resend() {
  need API
  mkdir -p "$OPS_DIR" "$STATE_DIR"
  local dlq main ts out seen i m eid new
  dlq="$(qurl notification-events-dlq)"; main="$(qurl notification-events)"
  for i in $(seq 1 18); do [ "$(qcount notification-events)" = "0/0/0" ] && break; sleep 10; done
  say "queue chính notification: $(qcount notification-events) (phải 0/0/0 trước khi gửi lại)"
  [ "$(qcount notification-events)" = "0/0/0" ] || die "queue chính chưa cạn"
  ts="$(date -u +%Y%m%dT%H%M%S)"; out="$OPS_DIR/resend-notification-events-dlq-$ts.jsonl"; seen="$STATE_DIR/seen-eventids.txt"; : >"$seen"
  [ ! -e "$out" ] || die "$out đã có"
  local empty=0
  while [ "$empty" -lt 2 ]; do
    aws sqs receive-message --queue-url "$dlq" --max-number-of-messages 10 --wait-time-seconds 5 --visibility-timeout 300 --attribute-names All --message-attribute-names All --output json |
      jq -c '.Messages[]?' >"$STATE_DIR/batch.json"
    if [ ! -s "$STATE_DIR/batch.json" ]; then empty=$((empty + 1)); continue; fi
    empty=0
    cat "$STATE_DIR/batch.json" >>"$out"
    while IFS= read -r m; do
      eid="$(printf '%s' "$m" | jq -r '.Body | fromjson | .eventId')"
      if grep -qx "$eid" "$seen"; then
        say "eventId $eid: bản trùng trong DLQ (MessageId $(printf '%s' "$m" | jq -r .MessageId)), chỉ xóa"
      else
        printf '%s' "$m" | jq '.MessageAttributes // {}' >"$STATE_DIR/attrs.json"
        new="$(aws sqs send-message --queue-url "$main" --message-body "$(printf '%s' "$m" | jq -r .Body)" --message-attributes "file://$STATE_DIR/attrs.json" --query MessageId --output text)" || die "send-message thất bại (không xóa bản DLQ)"
        echo "$eid" >>"$seen"
        say "eventId $eid: gửi lại MessageId cũ $(printf '%s' "$m" | jq -r .MessageId) -> mới $new; thuộc tính: $(printf '%s' "$m" | jq -r '.MessageAttributes // {} | keys | join(",")')"
      fi
      aws sqs delete-message --queue-url "$dlq" --receipt-handle "$(printf '%s' "$m" | jq -r .ReceiptHandle)" || say "xóa bản DLQ thất bại"
    done <"$STATE_DIR/batch.json"
  done
  say "đã gửi lại $(wc -l <"$seen") eventId; file ghi nhận (ngoài repo): $(wc -l <"$out") dòng"
  wait_clean
}

phase_verify_c() {
  need API AUD_TOKEN
  local c
  c="$(ld ac91_c)"
  say "audit notification.sent của C sau khi gửi lại: $(audit_count "$c" notification.sent) dòng (mong đợi 1); fraud.flagged: $(audit_count "$c" fraud.flagged) dòng"
  run_invariants && say "invariants PASS" || say "invariants KHÔNG sạch"
}

phase_worker_off() {
  need API
  local task
  task="$(aws ecs list-tasks --cluster "$CLUSTER" --service-name worker --desired-status RUNNING --query 'taskArns[0]' --output text)"
  st worker_task "$task"
  st worker_off 1
  say "(d) tắt worker: task ${task##*/}"
  aws ecs update-service --cluster "$CLUSTER" --service worker --desired-count 0 --query 'service.desiredCount' --output text >/dev/null || die "update-service thất bại"
  st t_off "$(date -u +%Y-%m-%dT%H:%M:%S.%3NZ)"
  local i
  for i in $(seq 1 36); do
    [ "$(aws ecs describe-services --cluster "$CLUSTER" --services worker --query 'services[0].runningCount' --output text)" = "0" ] && break
    sleep 5
  done
  aws ecs describe-tasks --cluster "$CLUSTER" --tasks "$task" --query 'tasks[0].{stoppingAt:stoppingAt,executionStoppedAt:executionStoppedAt,stoppedAt:stoppedAt,exitCode:containers[0].exitCode}' --output json | sed -E 's/[0-9]{12}/<ACCOUNT_ID>/g'
  say "worker runningCount 0 lúc $(date -u +%H:%M:%S) (stop-task đặt lúc $(ld t_off))"
}

phase_d_traffic() {
  need API OP_TOKEN CUST1_TOKEN CUST2_TOKEN ACC1 ACC2 ACC3
  local r code c t
  r="$(api_post "$OP_TOKEN" /v1/operator/deposits "{\"toAccountId\":\"$ACC1\",\"amount\":\"40000000\"}" "$(uuid)")"
  say "nạp 40.000.000 cho customer1 khi worker tắt: http=${r%%|*}"
  r="$(api_post "$CUST1_TOKEN" /v1/transfers "$(transfer_body "$ACC1" "$ACC2" 43000000)" "$(uuid)")"
  code="${r%%|*}"; c="$(printf '%s' "$r" | cut -d'|' -f2)"; t="$(printf '%s' "$r" | cut -d'|' -f3)"
  say "lệnh 43.000.000 khi worker tắt: http=$code C=$c T=$t"
  st d_c "$c"; st d_t "$t"
  local i
  for i in 1 2; do
    r="$(api_post "$CUST2_TOKEN" /v1/transfers "$(transfer_body "$ACC2" "$ACC3" 1000)" "$(uuid)")"
    say "lệnh nhỏ $i khi worker tắt: http=${r%%|*} C=$(printf '%s' "$r" | cut -d'|' -f2)"
    st "d_small_$i" "$(printf '%s' "$r" | cut -d'|' -f2)"
  done
  say "cờ của T ngay bây giờ (mong đợi chưa có vì worker tắt): $(curl -sk -m 10 -o /dev/null -w '%{http_code}' "$API/v1/operator/fraud-flags/$t" -H "Authorization: Bearer $OP_TOKEN")"
}

phase_outbox_wait() {
  need API
  local i t0
  t0="$(epoch "$(ld t_off)")"
  say "chờ dbs-dev-outbox-age sang ALARM (trần 15 phút); worker dừng/stop-task lúc $(ld t_off)"
  for i in $(seq 1 90); do
    [ "$(alarm_state dbs-dev-outbox-age | cut -d' ' -f1)" = "ALARM" ] && break
    sleep 10
  done
  say "alarm outbox-age: $(alarm_state dbs-dev-outbox-age); đo $(( $(date -u +%s) - t0 )) s kể từ stop-task (chạm ALARM không muộn hơn thời điểm này)"
}

phase_worker_on() {
  need API OP_TOKEN AUD_TOKEN
  local t_on i t
  t="$(ld d_t)"
  t_on="$(date -u +%s)"
  aws ecs update-service --cluster "$CLUSTER" --service worker --desired-count 1 --query 'service.desiredCount' --output text >/dev/null || die "update-service thất bại"
  st worker_off 0
  say "(d) bật worker lúc $(date -u +%H:%M:%S)"
  for i in $(seq 1 60); do
    [ "$(aws ecs describe-services --cluster "$CLUSTER" --services worker --query 'services[0].runningCount' --output text)" = "1" ] && break
    sleep 5
  done
  say "worker running sau $(( $(date -u +%s) - t_on )) s"
  say "cờ của T: $(flag_of "$t") (sau $(( $(date -u +%s) - t_on )) s kể từ lúc bật)"
  say "audit của lệnh 43.000.000: fraud.flagged $(audit_count "$(ld d_c)" fraud.flagged) dòng (mong đợi 1), notification.sent $(audit_count "$(ld d_c)" notification.sent) dòng (mong đợi 1)"
  say "audit notification.sent của hai lệnh nhỏ: $(audit_count "$(ld d_small_1)" notification.sent) và $(audit_count "$(ld d_small_2)" notification.sent) (mong đợi 1 và 1)"
  say "chờ bốn queue 0 và alarm OK"
  wait_clean
  for i in $(seq 1 30); do [ "$(alarm_state dbs-dev-outbox-age | cut -d' ' -f1)" = "OK" ] && break; sleep 10; done
  say "alarm outbox-age: $(alarm_state dbs-dev-outbox-age)"
}

phase_final_check() {
  need API
  local bad=0 w
  mig_db notification-check | grep -q '"blocked":false' && say "notification: không còn constraint" || { say "CÒN constraint"; bad=1; }
  w="$(aws ecs describe-services --cluster "$CLUSTER" --services worker --query 'services[0].[desiredCount,runningCount]' --output text | tr '\t' '/')"
  say "worker desired/running: $w"; [ "$w" = "1/1" ] || bad=1
  all_zero && say "bốn queue 0/0/0" || { say "queue chưa 0: risk $(qcount risk-events) dlq $(qcount risk-events-dlq) notif $(qcount notification-events) dlq $(qcount notification-events-dlq)"; bad=1; }
  say "alarm: risk-dlq $(alarm_state dbs-dev-risk-dlq-not-empty), notification-dlq $(alarm_state dbs-dev-notification-dlq-not-empty), outbox-age $(alarm_state dbs-dev-outbox-age)"
  [ "$bad" = "0" ] && say "FINAL-CHECK ĐẠT: có thể destroy" || { say "FINAL-CHECK KHÔNG ĐẠT"; return 1; }
}

case "${1:-}" in
  latency) shift; phase_latency "$@" ;;
  bad-messages) phase_bad_messages ;;
  block) phase_block ;;
  ac91) phase_ac91 ;;
  dlq-wait) phase_dlq_wait ;;
  unblock) phase_unblock ;;
  resend) phase_resend ;;
  verify-c) phase_verify_c ;;
  worker-off) phase_worker_off ;;
  d-traffic) phase_d_traffic ;;
  outbox-wait) phase_outbox_wait ;;
  worker-on) phase_worker_on ;;
  final-check) phase_final_check ;;
  *) echo "dùng: $0 latency <nhãn>|bad-messages|block|ac91|dlq-wait|unblock|resend|verify-c|worker-off|d-traffic|outbox-wait|worker-on|final-check (xem đầu file)" >&2; exit 2 ;;
esac
