#!/usr/bin/env bash
# DBS-166: chạy TRÊN máy tải (qua SSM Run Command), sau loadgen-bootstrap.sh. Lệnh con:
#
#   prepare                    tạo fixture một lần (seed qua API + nạp bù CHECKING lên 50 triệu bằng deposit API; BL-213:
#                              một DB, một đợt đo). Chỉ lệnh này tải token từ S3 (operator tạo được tiền) và xóa chúng ngay
#                              sau khi xong, cả trên máy lẫn trong bucket.
#   quiesce                    đợi hệ thống lặng: hai lần đếm bảng transfers cách nhau 30 giây phải bằng nhau (chạy trước
#                              `duplicate`, vì postflight của nó so delta chính xác toàn bảng)
#   run <kịch bản> [--smoke]   chạy `node load-tests/run.cjs` (luôn kèm checker bất biến DBS-69), rút gọn raw.json bằng
#                              aggregate-raw.cjs, nén raw, ghi exit.json và run.log cạnh kết quả, đẩy tất cả lên S3
#
# Cấu hình ở /opt/loadgen/run.env (người vận hành ghi: BUCKET, BASE_URL, DB_HOST, TOKENS_S3_KEY, tùy chọn API_URL_2). Mật khẩu
# DB lấy từ secret của role dbs_api bằng instance role, đi vào biến môi trường của tiến trình con, không vào argv hay log.
# `run` không dùng NODE_TLS_REJECT_UNAUTHORIZED: chỉ `prepare` (fetch qua ALB có chứng chỉ tự ký CN dbs-dev.local, BL-252)
# tắt kiểm chứng chỉ HTTP; TLS tới RDS luôn xác minh bằng CA bundle (pg đặt rejectUnauthorized tường minh).
set -euo pipefail

HOME_DIR=/opt/loadgen
export PATH="$HOME_DIR/node/bin:$HOME_DIR/k6:$PATH"
# shellcheck disable=SC1091
source "$HOME_DIR/run.env"
: "${BUCKET:?}" "${BASE_URL:?}" "${DB_HOST:?}" "${TOKENS_S3_KEY:?}"

secret_json="$(aws secretsmanager get-secret-value --secret-id dbs/dev/db-api --region ap-southeast-1 --query SecretString --output text)"
db_user="$(printf '%s' "$secret_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).username))')"
db_pass="$(printf '%s' "$secret_json" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(encodeURIComponent(JSON.parse(s).password)))')"
unset secret_json
export DATABASE_URL="postgres://${db_user}:${db_pass}@${DB_HOST}:5432/dbs"
export DATABASE_SSL=true
export DATABASE_SSL_CA_PATH="$HOME_DIR/rds-ca.pem"
export NODE_ENV=staging
export LOAD_DEDICATED=1
export BASE_URL
export LOAD_FIXTURE="$HOME_DIR/results/fixture.json"
export K6_BIN="$HOME_DIR/k6/k6"
export K6_INSECURE_SKIP_TLS_VERIFY=true # ALB dev dùng chứng chỉ tự ký; chỉ k6 bỏ kiểm tra, ghi trong báo cáo
if [ -n "${API_URL_2:-}" ]; then export API_URL_2; fi

cd "$HOME_DIR/src"

case "${1:-}" in
  prepare)
    if [ -s "$LOAD_FIXTURE" ]; then
      aws s3 rm "s3://$BUCKET/$TOKENS_S3_KEY" --only-show-errors || true
      echo "fixture đã có: $LOAD_FIXTURE (BL-213: không seed lại trên DB đã đo)"
      exit 0
    fi
    export LOAD_TOKENS_FILE="$HOME_DIR/tokens.json"
    aws s3 cp "s3://$BUCKET/$TOKENS_S3_KEY" "$LOAD_TOKENS_FILE" --only-show-errors
    chmod 600 "$LOAD_TOKENS_FILE"
    status=0
    (cd backend && NODE_TLS_REJECT_UNAUTHORIZED=0 node -r ts-node/register -r tsconfig-paths/register ../load-tests/prepare.cjs) || status=$?
    shred -u "$LOAD_TOKENS_FILE" 2>/dev/null || rm -f "$LOAD_TOKENS_FILE"
    aws s3 rm "s3://$BUCKET/$TOKENS_S3_KEY" --only-show-errors
    echo "prepare exit=$status (token đã xóa khỏi máy và bucket)"
    exit "$status"
    ;;
  quiesce)
    count() {
      (cd backend && node -e '
        const { Client } = require("pg");
        const c = new Client({ connectionString: process.env.DATABASE_URL, ssl: { rejectUnauthorized: true, ca: require("fs").readFileSync(process.env.DATABASE_SSL_CA_PATH, "utf8") } });
        c.connect().then(() => c.query("SELECT count(*)::text AS n FROM transfers")).then((r) => { console.log(r.rows[0].n); return c.end(); }).catch((e) => { console.error(e.message); process.exit(2); });
      ')
    }
    a="$(count)"; sleep 30; b="$(count)"
    echo "transfers: $a -> $b"
    [ "$a" = "$b" ] || { echo "hệ thống chưa lặng (còn ghi vào transfers)" >&2; exit 1; }
    ;;
  run)
    scenario="${2:?kịch bản}"
    shift 2
    started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    log="$(mktemp)"
    set +e
    node load-tests/run.cjs "$scenario" "$@" 2>&1 | tee "$log"
    code=${PIPESTATUS[0]}
    set -e
    # Thư mục kết quả lấy từ dòng `results=` của run.cjs (không đoán theo thời gian: thư mục cũ của cùng bài sẽ bị ghi đè).
    latest="$(grep -o 'results=[^ ;]*' "$log" | tail -1 | cut -d= -f2- || true)"
    if [ -z "$latest" ] || [ ! -d "$latest" ]; then
      echo "run.cjs không tạo thư mục kết quả (lỗi cấu hình); exit=$code" >&2
      exit "${code:-1}"
    fi
    inv="$(grep -o 'invariantExit=[0-9]*' "$log" | tail -1 | cut -d= -f2 || true)"
    cp "$log" "$latest/run.log"
    # DBS-167: mốc sự cố và mẫu health do redis-fault.sh schedule ghi trong lúc chạy; chép cạnh kết quả rồi dọn để lượt sau không lẫn.
    for f in fault-events.jsonl health.jsonl; do
      if [ -s "$HOME_DIR/fault/$f" ]; then mv "$HOME_DIR/fault/$f" "$latest/$f"; fi
    done
    agg=0
    if [ -s "$latest/raw.json" ]; then
      node load-tests/aggregate-raw.cjs "$latest" || agg=$?
      sha256sum "$latest/raw.json" | cut -d' ' -f1 > "$latest/raw.json.sha256"
      stat -c %s "$latest/raw.json" > "$latest/raw.json.size"
      gzip -f "$latest/raw.json"
    fi
    # DBS-174: độ trễ giao dịch → quyết định và → cờ theo plateau và cho cả lượt, đo bằng SQL sau khi đợi worker xử lý nốt (tối đa
    # 120 giây); hot-account, duplicate, rate-limit không có plateau nên chỉ có cửa sổ cả lượt. Mã 1 là còn giao dịch chưa có quyết định (tồn đọng): ghi vào exit.json, không làm
    # đỏ lượt (phán quyết tải nằm ở runExit và aggregate.json), nhưng báo cáo phải nêu.
    flag=null # null = công cụ không chạy (thiếu aggregate.json); 0 = đo xong hoặc lượt rỗng; 1 = tồn đọng; 2 = không đo được
    if [ -s "$latest/aggregate.json" ]; then
      flag=0
      node load-tests/flag-latency.cjs "$latest" || flag=$?
    fi
    # DBS-167: FAULT_MODE=slow|down|none (và tùy chọn FAULT_NOISE=<ms> từ lượt đối chứng) thì tính thống kê theo cửa sổ ngay tại chỗ.
    if [ -n "${FAULT_MODE:-}" ] && [ -s "$latest/requests.csv.gz" ]; then
      node load-tests/window-stats.cjs "$latest" --mode "$FAULT_MODE" ${FAULT_NOISE:+--noise "$FAULT_NOISE"} || true
    fi
    # runExit giữ mã lỗi của k6 khi k6 đỏ; invariantExit là mã của checker (0 chỉ khi có báo cáo PASS). Cả hai là bằng chứng của BL-127.
    printf '{"scenario":"%s","startedAt":"%s","finishedAt":"%s","runExit":%s,"invariantExit":%s,"aggregateExit":%s,"flagLatencyExit":%s}\n' \
      "$scenario" "$started" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$code" "${inv:-null}" "$agg" "$flag" > "$latest/exit.json"
    cat "$latest/exit.json"
    # Luôn đẩy kết quả lên bucket, kể cả khi bước rút gọn lỗi (raw.json.gz vẫn nằm trong thư mục).
    aws s3 sync "$latest" "s3://$BUCKET/results/$(basename "$latest")" --only-show-errors
    echo "uploaded s3://$BUCKET/results/$(basename "$latest")"
    if [ "$code" -eq 0 ] && [ "$agg" -ne 0 ]; then code=$agg; fi
    exit "$code"
    ;;
  *)
    echo "Dùng: loadgen-run.sh prepare | quiesce | run <scenario> [--smoke]" >&2
    exit 2
    ;;
esac
