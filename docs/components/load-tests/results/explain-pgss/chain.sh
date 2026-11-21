#!/usr/bin/env bash
# DBS-173: chạy tuần tự các bài đo trên máy tải, đúng thứ tự của DBS-166 (baseline, hot-account, quiesce, duplicate, stress)
# rồi một lượt hot-account nữa (tài khoản nóng ≥ 40.000 dòng). Ghi dấu thời gian vào /opt/loadgen/logs/chain.log.
set -uo pipefail
R=/opt/loadgen/src/infra/scripts/loadgen-run.sh
LOG=/opt/loadgen/logs/chain.log
step() {
  echo "$(date -u +%FT%TZ) START $*" >> "$LOG"
  bash "$R" "$@" > "/opt/loadgen/logs/chain-$1-$(date -u +%H%M%S).out" 2>&1
  echo "$(date -u +%FT%TZ) END $* exit=$?" >> "$LOG"
}
step run baseline
step run hot-account
step quiesce
step run duplicate
step run stress
echo "$(date -u +%FT%TZ) HOT2-READY" >> "$LOG"
sleep 60
step run hot-account
echo "$(date -u +%FT%TZ) CHAIN-DONE" >> "$LOG"
