#!/usr/bin/env python3
"""Kiểm một lần trạng thái rollout của service worker (BL-188), không gọi AWS: chỉ đọc hai file JSON.

  check-worker-rollout.py --service describe-services.json --tasks describe-tasks.json [--expect <task definition ARN>]

`--tasks` là kết quả `aws ecs describe-tasks` của mọi task của service chưa dừng hẳn và mới dừng gần đây (RUNNING và
STOPPED từ `list-tasks`), hoặc `{"tasks": []}`. Điều kiện "không còn worker cũ":
  - `deployments` chỉ còn đúng một phần tử, PRIMARY, ở revision mong đợi (không còn deployment ACTIVE/INACTIVE cũ);
  - `runningCount == desiredCount` và `pendingCount == 0`; deployment PRIMARY `COMPLETED` khi desiredCount > 0;
  - mọi task có `lastStatus != STOPPED` (kể cả PENDING, DEACTIVATING, STOPPING: task đang dừng vẫn có thể đang xử lý
    message trong `stopTimeout`) đều dùng đúng revision mong đợi; số task RUNNING bằng desiredCount.
Revision mong đợi là `--expect`, hoặc revision của deployment PRIMARY nếu không truyền.

Thoát 0: đạt (in một dòng OK). 1: chưa đạt, đang chờ (mỗi lý do một dòng). 2: sai không chờ được (PRIMARY không phải
revision mong đợi, tức circuit breaker đã rollback hoặc rollout sai). 3: service không có hoặc không ACTIVE.
"""
import argparse
import json
import sys


def short(arn):
    return arn.rsplit("/", 1)[-1]


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--service", required=True)
    ap.add_argument("--tasks", required=True)
    ap.add_argument("--expect", default="")
    args = ap.parse_args()
    services = json.load(open(args.service))["services"]
    if not services or services[0].get("status") != "ACTIVE":
        print("service không có hoặc không ACTIVE")
        return 3
    svc = services[0]
    deployments = svc.get("deployments", [])
    primary = [d for d in deployments if d.get("status") == "PRIMARY"]
    if not primary:
        print("service không có deployment PRIMARY")
        return 2
    primary = primary[0]
    want = args.expect or primary["taskDefinition"]
    if primary["taskDefinition"] != want:
        print(f"deployment PRIMARY đang ở {primary['taskDefinition']}, không phải {want}: rollout đã bị rollback hoặc sai revision")
        return 2

    desired = svc.get("desiredCount", 0)
    running = svc.get("runningCount", 0)
    pending = svc.get("pendingCount", 0)
    reasons = []
    for d in deployments:
        if d is not primary:
            reasons.append(f"còn deployment {d.get('status')} ở {short(d['taskDefinition'])} "
                           f"(running {d.get('runningCount', '?')}, pending {d.get('pendingCount', '?')})")
    if running != desired or pending != 0:
        reasons.append(f"service runningCount {running}, pendingCount {pending}, desiredCount {desired}")
    if desired > 0 and primary.get("rolloutState") != "COMPLETED":
        reasons.append(f"deployment PRIMARY chưa COMPLETED ({primary.get('rolloutState')})")

    tasks = json.load(open(args.tasks)).get("tasks", [])
    alive = [t for t in tasks if t.get("lastStatus") != "STOPPED"]
    for t in alive:
        if t.get("taskDefinitionArn") != want:
            reasons.append(f"task {short(t['taskArn'])} ({t.get('lastStatus')}) vẫn ở {short(t.get('taskDefinitionArn', '?'))}")
    on_want = [t for t in alive if t.get("taskDefinitionArn") == want and t.get("lastStatus") == "RUNNING"]
    if len(on_want) != desired:
        reasons.append(f"có {len(on_want)} task RUNNING ở {short(want)}, cần {desired}")

    if reasons:
        print("\n".join(reasons))
        return 1
    print(f"OK: chỉ còn {short(want)}, {len(on_want)}/{desired} task RUNNING, không có deployment hay task cũ")
    return 0


if __name__ == "__main__":
    sys.exit(main())
