#!/usr/bin/env bash
# DBS-139: chứng minh không còn tài nguyên TÍNH TIỀN sau `terraform destroy` của stack session.
# CHỈ ĐỌC: chỉ gọi `aws <dịch vụ> describe-*` / `list-*`, luôn kèm --region; không có lựa chọn ghi hay xóa.
#
# Quét cả tài khoản (cố ý: ENI và EIP mồ côi thường không mang tag; tag listing KHÔNG là bằng chứng, platform.md).
# Không đụng phần giữ lại: VPC, ECR, KMS, Cognito, SQS, secret, log group, cluster ECS rỗng.
#
# Dùng:  AWS_PROFILE=dbs-admin bash infra/scripts/verify-clean.sh
# Thoát: 0 sạch cả 13 loại; 1 còn ít nhất một thứ tính tiền (dù loại khác không kiểm được: dòng cuối nêu cả hai);
#        2 không loại nào còn lại nhưng có loại không kiểm được (thiếu quyền, hết hạn credential): KHÔNG kết luận sạch.
# ENI `available` hoặc bản sao lưu RDS `deleting` ngay sau destroy là tạm thời: đợi vài phút rồi chạy lại.
# Đang bật stack thì loại rds-automated-backup cũng báo FAIL (instance sống có bản sao lưu tự động): không phải lỗi.
set -uo pipefail

REGION="ap-southeast-1"
FAILS=()
ERRS=()

# aws chỉ đọc; in stdout dạng text. Tham số đầu là dịch vụ, thứ hai là lệnh describe-* hoặc list-*.
ro() {
  case "$2" in
    describe-* | list-*) ;;
    *) echo "verify-clean: từ chối lệnh không phải đọc: $1 $2" >&2; return 99 ;;
  esac
  aws "$@" --region "$REGION" --output text
}

# gom stdout thành danh sách id trên một dòng; bỏ chuỗi "None" và dòng trống
ids() { tr '\t\n' '  ' | sed -e 's/\bNone\b//g' -e 's/  */ /g' -e 's/^ //' -e 's/ $//'; }
# lấy phần tên cuối của ARN (không lộ số tài khoản)
short() { tr ' ' '\n' | sed 's|.*/||' | sed '/^$/d' | tr '\n' ' ' | sed 's/ $//'; }

report() { # tên, id còn lại (rỗng = sạch)
  if [ -n "$2" ]; then
    echo "FAIL $1: $2"
    FAILS+=("$1")
  else
    echo "OK $1"
  fi
}

check() { # tên, rồi các lệnh ro (mỗi lệnh phân cách bằng '--')
  local name="$1"; shift
  local acc="" part cmd=() rc=0
  local args=("$@" "--")
  for a in "${args[@]}"; do
    if [ "$a" = "--" ]; then
      [ "${#cmd[@]}" -eq 0 ] && continue
      if ! part="$(ro "${cmd[@]}" 2>/dev/null)"; then
        echo "LOI $name: không kiểm được (${cmd[0]} ${cmd[1]})"
        ERRS+=("$name")
        return 0
      fi
      acc="$acc $part"
      cmd=()
    else
      cmd+=("$a")
    fi
  done
  report "$name" "$(printf '%s' "$acc" | ids)"
}

check nat-gateway \
  ec2 describe-nat-gateways --filter "Name=state,Values=pending,available,deleting" --query 'NatGateways[].NatGatewayId'
check load-balancer \
  elbv2 describe-load-balancers --query 'LoadBalancers[].LoadBalancerName'
check rds \
  rds describe-db-instances --query 'DBInstances[].DBInstanceIdentifier' -- \
  rds describe-db-clusters --query 'DBClusters[].DBClusterIdentifier'
check rds-snapshot-manual \
  rds describe-db-snapshots --snapshot-type manual --query 'DBSnapshots[].DBSnapshotIdentifier'
check elasticache \
  elasticache describe-replication-groups --query 'ReplicationGroups[].ReplicationGroupId' -- \
  elasticache describe-cache-clusters --query 'CacheClusters[].CacheClusterId'

# ECS: cluster rỗng miễn phí. FAIL khi có service desiredCount > 0 (hoặc đang chạy) hoặc task đang chạy.
ecs_check() {
  local clusters c svcs left="" out
  if ! clusters="$(ro ecs list-clusters --query 'clusterArns[]' 2>/dev/null)"; then
    echo "LOI ecs: không kiểm được (ecs list-clusters)"; ERRS+=("ecs"); return 0
  fi
  for c in $clusters; do
    [ "$c" = "None" ] && continue
    local cname="${c##*/}"
    if ! svcs="$(ro ecs list-services --cluster "$cname" --query 'serviceArns[]' 2>/dev/null)"; then
      echo "LOI ecs: không kiểm được (ecs list-services)"; ERRS+=("ecs"); return 0
    fi
    svcs="$(printf '%s' "$svcs" | sed 's/\bNone\b//g' | tr '\t' ' ' | xargs)"
    if [ -n "$svcs" ]; then
      # shellcheck disable=SC2086
      if ! out="$(ro ecs describe-services --cluster "$cname" --services $svcs \
          --query 'services[?desiredCount>`0` || runningCount>`0`].serviceName' 2>/dev/null)"; then
        echo "LOI ecs: không kiểm được (ecs describe-services)"; ERRS+=("ecs"); return 0
      fi
      for s in $(printf '%s' "$out" | ids); do left="$left service:$cname/$s"; done
    fi
    if ! out="$(ro ecs list-tasks --cluster "$cname" --desired-status RUNNING --query 'taskArns[]' 2>/dev/null)"; then
      echo "LOI ecs: không kiểm được (ecs list-tasks)"; ERRS+=("ecs"); return 0
    fi
    for t in $(printf '%s' "$out" | ids | short); do left="$left task:$cname/$t"; done
  done
  report ecs "$(printf '%s' "$left" | sed 's/^ //')"
}
ecs_check

check elastic-ip \
  ec2 describe-addresses --query 'Addresses[].AllocationId'
check eni-available \
  ec2 describe-network-interfaces --filters "Name=status,Values=available" --query 'NetworkInterfaces[].NetworkInterfaceId'
check waf-regional \
  wafv2 list-web-acls --scope REGIONAL --query 'WebACLs[].Name'
check vpc-endpoint-ec2 \
  ec2 describe-vpc-endpoints --filters "Name=vpc-endpoint-type,Values=Interface" --query 'VpcEndpoints[].VpcEndpointId' -- \
  ec2 describe-instances --filters "Name=instance-state-name,Values=pending,running,stopping,stopped" \
  --query 'Reservations[].Instances[].InstanceId'
check rds-automated-backup \
  rds describe-db-instance-automated-backups --query 'DBInstanceAutomatedBackups[].DBInstanceIdentifier'
check elasticache-snapshot \
  elasticache describe-snapshots --query 'Snapshots[].SnapshotName'
check ebs \
  ec2 describe-volumes --query 'Volumes[].VolumeId' -- \
  ec2 describe-snapshots --owner-ids self --query 'Snapshots[].SnapshotId'

if [ "${#FAILS[@]}" -gt 0 ]; then
  echo "KET LUAN: còn tài nguyên tính tiền ở: ${FAILS[*]}"
  [ "${#ERRS[@]}" -gt 0 ] && echo "KET LUAN: không kiểm được: ${ERRS[*]}"
  exit 1
fi
if [ "${#ERRS[@]}" -gt 0 ]; then
  echo "KET LUAN: KHÔNG kết luận sạch, không kiểm được: ${ERRS[*]}"
  exit 2
fi
echo "KET LUAN: sạch (13 loại)"
exit 0
