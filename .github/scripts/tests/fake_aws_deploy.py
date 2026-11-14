#!/usr/bin/env python3
"""`aws` giả cho test của deploy.sh (DBS-38). Kịch bản ở $FAKE_STATE/scenario.json; mỗi lời gọi ghi vào calls.jsonl.

describe-services và describe-tasks trả lần lượt các phần tử của `describe_services` / `describe_tasks` (phần tử cuối
lặp lại). `error` có dạng {"op": "...", "code": "ClusterNotFoundException"} làm lệnh đó lỗi như AWS CLI v2 (mã thoát
254); tùy chọn `arg` (chuỗi phải có trong argv), `times` (chỉ lỗi trong N lần gọi đầu) và `message` (DBS-68).
BL-248: service/family `worker` có kịch bản riêng: `describe_services_worker`, `worker_task_definition_response`,
`register_arn_worker` (cùng quy tắc "phần tử cuối lặp lại").
BL-188: `list-tasks --service-name worker` trả `list_tasks_worker[<RUNNING|STOPPED>]` (dãy các danh sách ARN, theo số lần gọi
của từng trạng thái) và `describe-tasks` của task `task/dbs-dev/worker...` trả `describe_tasks_worker` (dãy kết quả). Mặc định
mô phỏng ECS khỏe: một task RUNNING ở revision hiện hành của service worker (revision của lần `update-service worker` cuối,
nếu chưa có thì revision của service lúc đầu).
"""
import json
import os
import sys

STATE_DIR = os.environ["FAKE_STATE"]
WORKER_TASK = "arn:aws:ecs:ap-southeast-1:123456789012:task/dbs-dev/worker0000000000000000000000000001"
SCEN = json.load(open(os.path.join(STATE_DIR, "scenario.json")))
argv = sys.argv[1:]
service, op = argv[0], argv[1]
key = f"{service} {op}"

record = {"argv": argv, "stdin": None, "input_json": None}
for i, a in enumerate(argv):
    if a == "--cli-input-json" and argv[i + 1].startswith("file://"):
        path = argv[i + 1][7:]
        if path == "/dev/stdin":
            record["stdin"] = sys.stdin.read()
            record["input_json"] = json.loads(record["stdin"])
        else:
            record["input_json"] = json.load(open(path))
for i, a in enumerate(argv):
    if a == "--network-configuration" and argv[i + 1].startswith("file://"):
        record["network_json"] = json.load(open(argv[i + 1][7:]))
worker = ("worker" in argv or "dbs-worker" in argv or (record["input_json"] or {}).get("family") == "dbs-worker"
          or any(a.startswith("arn:") and "task/dbs-dev/worker" in a for a in argv))
if worker:
    key += " worker"  # bộ đếm và kịch bản riêng của worker (BL-248)
with open(os.path.join(STATE_DIR, "calls.jsonl"), "a") as f:
    f.write(json.dumps(record) + "\n")

counter_file = os.path.join(STATE_DIR, "counter.json")
counters = json.load(open(counter_file)) if os.path.exists(counter_file) else {}
n = counters.get(key, 0)
counters[key] = n + 1
json.dump(counters, open(counter_file, "w"))

err = SCEN.get("error")
if err and err["op"] == key.replace(" worker", "") and err.get("worker", False) == worker and err.get("arg", "") in " ".join(argv) and n < err.get("times", 10**9):
    sys.stderr.write(f"\naws: [ERROR]: An error occurred ({err['code']}) when calling the {op} operation: {err.get('message', 'fake')}\n")
    sys.exit(254)

if key == "ecs describe-services":
    seq = SCEN["describe_services"]
    print(json.dumps(seq[min(n, len(seq) - 1)]))
elif key == "ecs describe-services worker":
    seq = SCEN["describe_services_worker"]
    print(json.dumps(seq[min(n, len(seq) - 1)]))
elif key == "ecs describe-task-definition worker":
    print(json.dumps(SCEN["worker_task_definition_response"]))
elif key == "ecs register-task-definition worker":
    print(json.dumps({"taskDefinition": {"taskDefinitionArn": SCEN["register_arn_worker"]}}))
elif key == "ecs update-service worker":
    print(json.dumps({"service": {"serviceName": "worker"}}))
elif key == "ecs list-tasks worker":
    status = argv[argv.index("--desired-status") + 1]
    status_key = f"list-tasks worker {status}"
    m = counters.get(status_key, 0)
    counters[status_key] = m + 1
    json.dump(counters, open(counter_file, "w"))
    defaults = {"RUNNING": [[WORKER_TASK]], "STOPPED": [[]]}
    seq = SCEN.get("list_tasks_worker", {}).get(status, defaults[status])
    print(json.dumps({"taskArns": seq[min(m, len(seq) - 1)]}))
elif key == "ecs describe-tasks worker":
    if "describe_tasks_worker" in SCEN:
        seq = SCEN["describe_tasks_worker"]
        print(json.dumps(seq[min(n, len(seq) - 1)]))
    else:
        td = SCEN["describe_services_worker"][0]["services"][0]["taskDefinition"]
        for line in open(os.path.join(STATE_DIR, "calls.jsonl")):
            c = json.loads(line)
            if c["argv"][:2] == ["ecs", "update-service"] and "worker" in c["argv"]:
                td = c["argv"][c["argv"].index("--task-definition") + 1]
        print(json.dumps({"tasks": [{"taskArn": WORKER_TASK, "lastStatus": "RUNNING", "taskDefinitionArn": td}], "failures": []}))
elif key == "ecr batch-get-image":
    count = SCEN.get("ecr_images", 1)
    print(json.dumps({"images": [{"imageId": {}}] * count, "failures": [] if count else [{"failureCode": "ImageNotFound"}]}))
elif key == "ecs describe-task-definition":
    migrate = "dbs-migrate" in argv
    print(json.dumps(SCEN["migrate_task_definition_response"] if migrate else SCEN["task_definition_response"]))
elif key == "ecs register-task-definition":
    migrate = (record["input_json"] or {}).get("family") == "dbs-migrate"
    print(json.dumps({"taskDefinition": {"taskDefinitionArn": SCEN["register_arn_migrate"] if migrate else SCEN["register_arn"]}}))
elif key == "ecs list-tasks":
    print(json.dumps({"taskArns": SCEN.get("running_migrations", [])}))
elif key == "ecs run-task":
    print(json.dumps(SCEN["run_task"]))
elif key == "ecs describe-tasks":
    seq = SCEN["describe_tasks"]
    print(json.dumps(seq[min(n, len(seq) - 1)]))
elif key == "ecs stop-task":
    print(json.dumps({"task": {}}))
elif key == "logs get-log-events":
    if SCEN.get("log_stream_missing"):
        sys.stderr.write("\naws: [ERROR]: An error occurred (ResourceNotFoundException) when calling the GetLogEvents operation: fake\n")
        sys.exit(254)
    print(json.dumps({"events": [{"message": m} for m in SCEN.get("log_events", [])]}))
elif key == "ecs update-service":
    print(json.dumps({"service": {"serviceName": "api"}}))
elif key == "elbv2 describe-load-balancers":
    print(json.dumps({"LoadBalancers": [{"DNSName": SCEN.get("alb_dns", "alb.example.test")}]}))
else:
    sys.stderr.write(f"fake aws: unsupported {key}\n")
    sys.exit(2)
