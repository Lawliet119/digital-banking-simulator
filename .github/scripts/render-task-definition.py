#!/usr/bin/env python3
"""Dựng input của `aws ecs register-task-definition` từ phản hồi của
`aws ecs describe-task-definition --include TAGS` (đọc từ stdin), chỉ đổi image của container `api` (DBS-38).

  aws ecs describe-task-definition --task-definition dbs-api --include TAGS \\
    | python3 .github/scripts/render-task-definition.py --image <repo>:<sha40> > td.json

Dựng từ allowlist khóa (không phải danh sách xóa) để mọi trường chỉ-đọc, kể cả trường mới về sau, bị loại.
`tags` nằm ở GỐC phản hồi, cạnh `taskDefinition`. Lỗi thì in ra stderr, không in gì ra stdout, thoát khác 0.
"""
import argparse
import json
import re
import sys

ALLOWED = (
    "family", "taskRoleArn", "executionRoleArn", "networkMode", "containerDefinitions", "volumes",
    "placementConstraints", "requiresCompatibilities", "cpu", "memory", "pidMode", "ipcMode",
    "proxyConfiguration", "inferenceAccelerators", "ephemeralStorage", "runtimePlatform", "enableFaultInjection",
)
CONTAINER = "api"


def fail(message):
    print(f"render-task-definition: {message}", file=sys.stderr)
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True, help="<repo>:<sha 40 ký tự hex>")
    args = parser.parse_args()

    tag = args.image.rsplit(":", 1)[1] if ":" in args.image.rsplit("/", 1)[-1] else ""
    if not re.fullmatch(r"[0-9a-f]{40}", tag):
        fail(f"tag của image phải là SHA đầy đủ 40 ký tự hex (không dùng latest), nhận được {tag!r}")

    try:
        response = json.load(sys.stdin)
        definition = response["taskDefinition"]
    except (ValueError, KeyError, TypeError):
        fail("stdin phải là phản hồi JSON của describe-task-definition (có khóa taskDefinition)")

    out = {key: definition[key] for key in ALLOWED if key in definition}
    containers = out.get("containerDefinitions") or []
    if not any(c.get("name") == CONTAINER for c in containers):
        fail(f"task definition không có container tên {CONTAINER!r}")
    out["containerDefinitions"] = [
        dict(c, image=args.image) if c.get("name") == CONTAINER else c for c in containers
    ]
    if response.get("tags"):
        out["tags"] = response["tags"]
    json.dump(out, sys.stdout)


main()
