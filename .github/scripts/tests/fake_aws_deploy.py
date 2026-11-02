#!/usr/bin/env python3
"""`aws` giả cho test của deploy.sh (DBS-38). Kịch bản ở $FAKE_STATE/scenario.json; mỗi lời gọi ghi vào calls.jsonl.

describe-services và describe-tasks trả lần lượt các phần tử của `describe_services` / `describe_tasks` (phần tử cuối
lặp lại). `error` có dạng {"op": "...", "code": "ClusterNotFoundException"} làm lệnh đó lỗi như AWS CLI v2 (mã thoát
254); tùy chọn `arg` (chuỗi phải có trong argv), `times` (chỉ lỗi trong N lần gọi đầu) và `message` (DBS-68).
"""
import json
import os
import sys

STATE_DIR = os.environ["FAKE_STATE"]
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
with open(os.path.join(STATE_DIR, "calls.jsonl"), "a") as f:
    f.write(json.dumps(record) + "\n")

counter_file = os.path.join(STATE_DIR, "counter.json")
counters = json.load(open(counter_file)) if os.path.exists(counter_file) else {}
n = counters.get(key, 0)
counters[key] = n + 1
json.dump(counters, open(counter_file, "w"))

err = SCEN.get("error")
if err and err["op"] == key and err.get("arg", "") in " ".join(argv) and n < err.get("times", 10**9):
    sys.stderr.write(f"\naws: [ERROR]: An error occurred ({err['code']}) when calling the {op} operation: {err.get('message', 'fake')}\n")
    sys.exit(254)

if key == "ecs describe-services":
    seq = SCEN["describe_services"]
    print(json.dumps(seq[min(n, len(seq) - 1)]))
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
