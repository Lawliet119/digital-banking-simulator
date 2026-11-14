#!/usr/bin/env bash
# DBS-154: kiểm tra tài nguyên dev đang dùng đúng CMK `alias/dbs-dev` và CMK bật xoay khóa.
# CHỈ ĐỌC: chỉ gọi `aws <dịch vụ> describe-*` / `get-*` / `list-*`, luôn kèm --region; không ghi hay sửa.
#
# Dùng:  AWS_PROFILE=dbs-admin bash infra/scripts/verify-kms.sh
# Thoát: 0 mọi thứ đang có đều dùng CMK (loại không có tài nguyên in BO-QUA);
#        1 có ít nhất một tài nguyên dùng khóa khác hoặc CMK tắt/tắt xoay;
#        2 không có FAIL nhưng có loại không kiểm được (thiếu quyền, hết hạn credential).
set -uo pipefail

REGION="ap-southeast-1"
KMS_ALIAS="alias/dbs-dev"
FAILS=()
ERRS=()

ro() {
  case "$2" in
    describe-* | get-* | list-*) ;;
    *) echo "verify-kms: từ chối lệnh không phải đọc: $1 $2" >&2; return 99 ;;
  esac
  aws "$@" --region "$REGION" --output text
}

matches_cmk() {
  local val="$1"
  [ -z "$val" ] || [ "$val" = "None" ] && return 1
  if [ -n "$CMK_ARN" ] && [ "$val" = "$CMK_ARN" ]; then return 0; fi
  if [ -n "$CMK_ID" ] && [ "$val" = "$CMK_ID" ]; then return 0; fi
  if [ "$val" = "$KMS_ALIAS" ]; then return 0; fi
  return 1
}

lower() {
  printf '%s' "$1" | tr '[:upper:]' '[:lower:]'
}

CMK_ID=""
CMK_ARN=""

check_cmk() {
  local meta rot state manager
  if ! meta="$(ro kms describe-key --key-id "$KMS_ALIAS" --query 'KeyMetadata.[KeyId,Arn,KeyState,KeyManager]' 2>/dev/null)"; then
    echo "LOI cmk: không kiểm được (kms describe-key)"
    ERRS+=("cmk")
    return 0
  fi
  if ! rot="$(ro kms get-key-rotation-status --key-id "$KMS_ALIAS" --query 'KeyRotationEnabled' 2>/dev/null)"; then
    echo "LOI cmk: không kiểm được (kms get-key-rotation-status)"
    ERRS+=("cmk")
    return 0
  fi

  IFS=$'\t' read -r CMK_ID CMK_ARN state manager <<< "$(printf '%s' "$meta" | head -n 1)"
  rot="$(printf '%s' "$rot" | head -n 1 | tr -d '[:space:]')"

  local bad=()
  [ "$state" != "Enabled" ] && bad+=("state=$state")
  [ "$manager" != "CUSTOMER" ] && bad+=("manager=$manager")
  [ "$(lower "$rot")" != "true" ] && bad+=("rotation=$rot")

  if [ "${#bad[@]}" -gt 0 ]; then
    echo "FAIL cmk: $KMS_ALIAS (${bad[*]})"
    FAILS+=("cmk")
  else
    echo "OK cmk: $KMS_ALIAS (Enabled, CUSTOMER, rotation=true)"
  fi
}

check_rds() {
  local out count=0 bad=()
  if ! out="$(ro rds describe-db-instances --query 'DBInstances[].[DBInstanceIdentifier,StorageEncrypted,KmsKeyId]' 2>/dev/null)"; then
    echo "LOI rds: không kiểm được (rds describe-db-instances)"
    ERRS+=("rds")
    return 0
  fi
  while IFS=$'\t' read -r id enc key; do
    [ -z "$id" ] || [ "$id" = "None" ] && continue
    case "$id" in
      dbs-*) ;;
      *) continue ;;
    esac
    count=$((count + 1))
    if [ "$(lower "$enc")" != "true" ] || ! matches_cmk "$key"; then
      bad+=("$id(encrypted=$enc,kms=$key)")
    fi
  done <<< "$out"

  if [ "$count" -eq 0 ]; then
    echo "BO-QUA rds: không có instance dbs-*"
  elif [ "${#bad[@]}" -gt 0 ]; then
    echo "FAIL rds: ${bad[*]}"
    FAILS+=("rds")
  else
    echo "OK rds: $count instance dùng CMK"
  fi
}

check_elasticache() {
  local out count=0 bad=()
  if ! out="$(ro elasticache describe-replication-groups --query 'ReplicationGroups[].[ReplicationGroupId,AtRestEncryptionEnabled,KmsKeyId]' 2>/dev/null)"; then
    echo "LOI elasticache: không kiểm được (elasticache describe-replication-groups)"
    ERRS+=("elasticache")
    return 0
  fi
  while IFS=$'\t' read -r id enc key; do
    [ -z "$id" ] || [ "$id" = "None" ] && continue
    case "$id" in
      dbs-*) ;;
      *) continue ;;
    esac
    count=$((count + 1))
    if [ "$(lower "$enc")" != "true" ] || ! matches_cmk "$key"; then
      bad+=("$id(encrypted=$enc,kms=$key)")
    fi
  done <<< "$out"

  if [ "$count" -eq 0 ]; then
    echo "BO-QUA elasticache: không có replication group dbs-*"
  elif [ "${#bad[@]}" -gt 0 ]; then
    echo "FAIL elasticache: ${bad[*]}"
    FAILS+=("elasticache")
  else
    echo "OK elasticache: $count nhóm dùng CMK"
  fi
}

check_sqs() {
  local urls q qname attrs kms sse count=0 bad=()
  if ! urls="$(ro sqs list-queues --queue-name-prefix dbs-dev- --query 'QueueUrls[]' 2>/dev/null)"; then
    echo "LOI sqs: không kiểm được (sqs list-queues)"
    ERRS+=("sqs")
    return 0
  fi
  for q in $(printf '%s' "$urls" | tr '\t\n' '  '); do
    [ -z "$q" ] || [ "$q" = "None" ] && continue
    count=$((count + 1))
    qname="${q##*/}"
    if ! attrs="$(ro sqs get-queue-attributes --queue-url "$q" --attribute-names KmsMasterKeyId SqsManagedSseEnabled --query 'Attributes.[KmsMasterKeyId,SqsManagedSseEnabled]' 2>/dev/null)"; then
      echo "LOI sqs: không kiểm được (sqs get-queue-attributes $qname)"
      ERRS+=("sqs")
      return 0
    fi
    IFS=$'\t' read -r kms sse <<< "$(printf '%s' "$attrs" | head -n 1)"
    if [ "$(lower "$sse")" = "true" ] || ! matches_cmk "$kms"; then
      bad+=("$qname(kms=$kms,sse_sqs=$sse)")
    fi
  done

  if [ "$count" -eq 0 ]; then
    echo "BO-QUA sqs: không có queue dbs-dev-*"
  elif [ "${#bad[@]}" -gt 0 ]; then
    echo "FAIL sqs: ${bad[*]}"
    FAILS+=("sqs")
  else
    echo "OK sqs: $count queue dùng CMK"
  fi
}

check_secrets() {
  local out count=0 bad=()
  if ! out="$(ro secretsmanager list-secrets --query 'SecretList[].[Name,KmsKeyId]' 2>/dev/null)"; then
    echo "LOI secrets: không kiểm được (secretsmanager list-secrets)"
    ERRS+=("secrets")
    return 0
  fi
  while IFS=$'\t' read -r name key; do
    [ -z "$name" ] || [ "$name" = "None" ] && continue
    case "$name" in
      dbs/* | rds!db-*) ;;
      *) continue ;;
    esac
    count=$((count + 1))
    if ! matches_cmk "$key"; then
      bad+=("$name(kms=${key:-None})")
    fi
  done <<< "$out"

  if [ "$count" -eq 0 ]; then
    echo "BO-QUA secrets: không có secret dbs/* hoặc rds!db-*"
  elif [ "${#bad[@]}" -gt 0 ]; then
    echo "FAIL secrets: ${bad[*]}"
    FAILS+=("secrets")
  else
    echo "OK secrets: $count secret dùng CMK"
  fi
}

check_cmk
check_rds
check_elasticache
check_sqs
check_secrets

if [ "${#FAILS[@]}" -gt 0 ]; then
  echo "KET LUAN: chưa dùng đúng CMK ở: ${FAILS[*]}"
  [ "${#ERRS[@]}" -gt 0 ] && echo "KET LUAN: không kiểm được: ${ERRS[*]}"
  exit 1
fi
if [ "${#ERRS[@]}" -gt 0 ]; then
  echo "KET LUAN: KHÔNG kết luận đạt, không kiểm được: ${ERRS[*]}"
  exit 2
fi
echo "KET LUAN: đạt (mọi tài nguyên đang có đều dùng CMK)"
exit 0
