#!/usr/bin/env bash
# Chạy một lệnh trên máy tải qua SSM và in stdout/stderr. Dùng: ssm.sh '<lệnh>' [timeoutSeconds]
export AWS_PROFILE=dbs AWS_DEFAULT_REGION=ap-southeast-1 MSYS_NO_PATHCONV=1 PYTHONUTF8=1
INSTANCE="${INSTANCE:-i-06816aeb7cd84086d}"
CMD="$1"
TMO="${2:-120}"
SP='F:/tmp/claude/claude/b40605182e8b32f5/f51d1485-2744-499d-9ed7-465b3e3fa60b/scratchpad'
printf '{"commands":[%s]}' "$(printf '%s' "$CMD" | python -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" > "$SP/ssm-params.json"
ID=$(aws ssm send-command --instance-ids "$INSTANCE" --document-name AWS-RunShellScript \
  --parameters "file://$SP/ssm-params.json" --timeout-seconds "$TMO" --query Command.CommandId --output text)
for i in $(seq 1 $((TMO / 3 + 5))); do
  S=$(aws ssm get-command-invocation --command-id "$ID" --instance-id "$INSTANCE" --query Status --output text 2>/dev/null)
  case "$S" in Success|Failed|Cancelled|TimedOut) break ;; esac
  sleep 3
done
echo "[ssm status=$S id=$ID]"
aws ssm get-command-invocation --command-id "$ID" --instance-id "$INSTANCE" --query '[StandardOutputContent,StandardErrorContent]' --output text
