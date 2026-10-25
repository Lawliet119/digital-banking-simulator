#!/usr/bin/env python3
"""`aws` giả cho test của deploy.sh (DBS-38). Kịch bản ở $FAKE_STATE/scenario.json; mỗi lời gọi ghi vào calls.jsonl.

describe-services trả lần lượt các phần tử của `describe_services` (phần tử cuối lặp lại). `error` có dạng
{"op": "...", "code": "ClusterNotFoundException"} làm lệnh đó lỗi như AWS CLI v2 (mã thoát 254).
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
with open(os.path.join(STATE_DIR, "calls.jsonl"), "a") as f:
    f.write(json.dumps(record) + "\n")

err = SCEN.get("error")
if err and err["op"] == key:
    sys.stderr.write(f"\naws: [ERROR]: An error occurred ({err['code']}) when calling the {op} operation: fake\n")
    sys.exit(254)

counter_file = os.path.join(STATE_DIR, "counter.json")
counters = json.load(open(counter_file)) if os.path.exists(counter_file) else {}
n = counters.get(key, 0)
counters[key] = n + 1
json.dump(counters, open(counter_file, "w"))

if key == "ecs describe-services":
    seq = SCEN["describe_services"]
    print(json.dumps(seq[min(n, len(seq) - 1)]))
elif key == "ecr batch-get-image":
    count = SCEN.get("ecr_images", 1)
    print(json.dumps({"images": [{"imageId": {}}] * count, "failures": [] if count else [{"failureCode": "ImageNotFound"}]}))
elif key == "ecs describe-task-definition":
    print(json.dumps(SCEN["task_definition_response"]))
elif key == "ecs register-task-definition":
    print(json.dumps({"taskDefinition": {"taskDefinitionArn": SCEN["register_arn"]}}))
elif key == "ecs update-service":
    print(json.dumps({"service": {"serviceName": "api"}}))
elif key == "elbv2 describe-load-balancers":
    print(json.dumps({"LoadBalancers": [{"DNSName": SCEN.get("alb_dns", "alb.example.test")}]}))
else:
    sys.stderr.write(f"fake aws: unsupported {key}\n")
    sys.exit(2)
