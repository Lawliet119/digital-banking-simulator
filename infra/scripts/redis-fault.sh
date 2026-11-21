#!/usr/bin/env bash
# DBS-167, DBS-186: tắt, làm chậm hoặc flush Redis (ElastiCache Valkey) của stack `session` TỪ MÁY TẢI (chạy qua SSM). Cơ chế:
#   tắt   = luật NACL «deny tcp 6379» (ingress, số 50 và 51) từ CIDR của các public subnet vào hai private subnet của Valkey, ở NACL
#           `dbs-dev-private-fault` do stack envs/dev/loadgen dựng (redis_fault_enabled=true). NACL không giữ trạng thái nên cắt cả
#           kết nối đang mở (SG thì không) và không đụng `base`. `destroy` loadgen gỡ NACL nên luật deny sót cũng hết.
#   chậm  = xung `CLIENT PAUSE <P> ALL` (load-tests/redis-fault.cjs), tự hết hạn.
#   flush = `FLUSHALL SYNC` (cùng công cụ).
#
#   redis-fault.sh status                 thoát 0 nếu KHÔNG có luật 50/51; thoát 1 nếu còn (từ chối bắt đầu lượt mới)
#   redis-fault.sh down                   thêm luật 50 và 51, ghi sự kiện `down`
#   redis-fault.sh restore                xóa luật 50 và 51 (bỏ qua NotFound; chạy lại được), ghi sự kiện `restore`
#   redis-fault.sh slow <giây> <P> <chu kỳ>     một bậc xung (DBS-186, thử công cụ)
#   redis-fault.sh flush                  FLUSHALL SYNC
#   redis-fault.sh schedule slow|down|none      đợi k6 chạy; ghi health.jsonl mỗi giây; ở +300 s tiêm sự cố 300 s (slow: 150 s nhẹ
#                                         P=100 ms rồi 150 s nặng P=180 ms, chu kỳ 200 ms; down: 300 s); luôn khôi phục
#
# Cấu hình ở $LOADGEN_HOME/run.env (mặc định /opt/loadgen): REDIS_HOST, REDIS_FAULT_NACL_ID, REDIS_FAULT_DENY_CIDRS (phân cách
# bằng dấu phẩy), REDIS_AUTH_SECRET_ID, BASE_URL. Token Redis đọc bằng instance role, chỉ nằm trong biến môi trường của tiến
# trình con (không argv, không log, không file). Sự kiện và mẫu health ghi vào $FAULT_DIR (mặc định $LOADGEN_HOME/fault);
# loadgen-run.sh chép chúng cạnh kết quả của lượt `run` kế tiếp.
set -euo pipefail

LOADGEN_HOME="${LOADGEN_HOME:-/opt/loadgen}"
export PATH="$LOADGEN_HOME/node/bin:$PATH"
# shellcheck disable=SC1091
[ -f "$LOADGEN_HOME/run.env" ] && source "$LOADGEN_HOME/run.env"
FAULT_DIR="${FAULT_DIR:-$LOADGEN_HOME/fault}"
EVENTS="$FAULT_DIR/fault-events.jsonl"
HEALTH="$FAULT_DIR/health.jsonl"
SRC="${REDIS_FAULT_SRC:-$LOADGEN_HOME/src}"
NOW_MS() { date +%s%3N; }

need() { for v in "$@"; do [ -n "${!v:-}" ] || { echo "thiếu $v (run.env)" >&2; exit 2; }; done; }

event() { # event <action> <mode>
  mkdir -p "$FAULT_DIR"
  printf '{"epoch_ms":%s,"action":"%s","mode":"%s"}\n' "$(NOW_MS)" "$1" "$2" >> "$EVENTS"
}

deny_rules_present() {
  local n
  n="$(aws ec2 describe-network-acls --network-acl-ids "$REDIS_FAULT_NACL_ID" \
    --query 'NetworkAcls[0].Entries[?RuleNumber==`50` || RuleNumber==`51`] | length(@)' --output text)"
  [ "${n:-0}" != "0" ] && [ "${n:-0}" != "None" ]
}

cmd_status() {
  need REDIS_FAULT_NACL_ID
  if deny_rules_present; then
    echo "luật deny 50/51 còn trên $REDIS_FAULT_NACL_ID: chạy redis-fault.sh restore trước" >&2
    return 1
  fi
  echo "sạch: không có luật deny 50/51"
}

cmd_down() {
  need REDIS_FAULT_NACL_ID REDIS_FAULT_DENY_CIDRS
  local i=0 cidr
  local -a cidrs
  IFS=',' read -r -a cidrs <<< "$REDIS_FAULT_DENY_CIDRS"
  for cidr in "${cidrs[@]}"; do
    aws ec2 create-network-acl-entry --network-acl-id "$REDIS_FAULT_NACL_ID" --ingress --rule-number "$((50 + i))" \
      --protocol 6 --port-range From=6379,To=6379 --cidr-block "$cidr" --rule-action deny
    i=$((i + 1))
  done
  event down down
  echo "đã chặn 6379 từ ${REDIS_FAULT_DENY_CIDRS}"
}

cmd_restore() {
  need REDIS_FAULT_NACL_ID
  local n err
  for n in 50 51; do
    if ! err="$(aws ec2 delete-network-acl-entry --network-acl-id "$REDIS_FAULT_NACL_ID" --ingress --rule-number "$n" 2>&1)"; then
      case "$err" in
        *InvalidNetworkAclEntry.NotFound*) ;; # đã xóa rồi: chạy lại được
        *) echo "$err" >&2; return 1 ;;
      esac
    fi
  done
  event restore down
  echo "đã gỡ luật deny 50/51"
}

with_token() { # with_token <lệnh...>: token chỉ nằm trong môi trường của tiến trình con
  need REDIS_HOST REDIS_AUTH_SECRET_ID
  local token
  token="$(aws secretsmanager get-secret-value --secret-id "$REDIS_AUTH_SECRET_ID" --query SecretString --output text)"
  REDIS_AUTH_TOKEN="$token" "$@"
}

cmd_slow() {
  mkdir -p "$FAULT_DIR"
  with_token node "$SRC/load-tests/redis-fault.cjs" slow "$1" "$2" "$3" --events "$EVENTS"
}

cmd_flush() {
  mkdir -p "$FAULT_DIR"
  with_token node "$SRC/load-tests/redis-fault.cjs" flush --events "$EVENTS"
}

sample_health() { # sample_health <pid của k6>: mỗi giây một dòng, dừng khi k6 thoát
  local pid="$1" body code redis
  while kill -0 "$pid" 2>/dev/null; do
    body="$(curl -sk -m 3 -w '\n%{http_code}' "$BASE_URL/health/ready" || true)"
    code="$(printf '%s' "$body" | tail -n1)"
    redis="$(printf '%s' "$body" | grep -o '"redis":"[a-z]*"' | head -1 | cut -d'"' -f4 || true)"
    printf '{"epoch_ms":%s,"code":%s,"redis":"%s"}\n' "$(NOW_MS)" "${code:-0}" "${redis:-unknown}" >> "$HEALTH"
    sleep 1
  done
}

cmd_schedule() {
  local mode="${1:?slow|down|none}" pid waited=0 elapsed
  case "$mode" in slow | down | none) ;; *) echo "mode không hợp lệ: $mode" >&2; return 2 ;; esac
  need BASE_URL
  [ "$mode" = none ] || cmd_status
  mkdir -p "$FAULT_DIR"
  rm -f "$EVENTS" "$HEALTH"
  # k6 do `loadgen-run.sh run redis-fault` khởi chạy; đợi tối đa 10 phút
  until pid="$(pgrep -o -x k6 || true)" && [ -n "$pid" ]; do
    waited=$((waited + 2))
    [ "$waited" -le 600 ] || { echo "k6 không chạy sau 10 phút" >&2; return 1; }
    sleep 2
  done
  event k6_seen "$mode"
  sample_health "$pid" &
  local sampler=$!
  elapsed="$(ps -o etimes= -p "$pid" | tr -d ' ')"
  [ "${elapsed:-0}" -ge 300 ] || sleep $((300 - ${elapsed:-0}))
  case "$mode" in
    slow)
      with_token node "$SRC/load-tests/redis-fault.cjs" slow-stepped 150 150 100 180 200 --events "$EVENTS"
      ;;
    down)
      # tự khôi phục: trap, và một timer systemd độc lập với tiến trình này
      trap 'cmd_restore || true' EXIT INT TERM
      systemd-run --quiet --unit="redis-fault-deadman-$$" --on-active=360s /bin/bash "$SRC/infra/scripts/redis-fault.sh" restore \
        || echo "cảnh báo: không có systemd-run, chỉ còn trap và destroy loadgen" >&2
      cmd_down
      sleep 300
      cmd_restore
      trap - EXIT INT TERM
      systemctl stop "redis-fault-deadman-$$.timer" 2>/dev/null || true
      ;;
    none) ;;
  esac
  wait "$sampler" || true
  echo "schedule $mode xong: $EVENTS, $HEALTH"
}

case "${1:-}" in
  status) cmd_status ;;
  down) cmd_down ;;
  restore) cmd_restore ;;
  slow) shift; cmd_slow "${1:?giây}" "${2:?P ms}" "${3:?chu kỳ ms}" ;;
  flush) cmd_flush ;;
  schedule) shift; cmd_schedule "${1:-}" ;;
  *)
    echo "Dùng: redis-fault.sh status | down | restore | slow <giây> <P> <chu kỳ> | flush | schedule slow|down|none" >&2
    exit 2
    ;;
esac
