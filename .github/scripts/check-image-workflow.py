#!/usr/bin/env python3
"""Kiểm tĩnh .github/workflows/image.yml (DBS-36, TC-36-06..09). Cần PyYAML; không cần mạng.

Chạy từ gốc repo: python3 .github/scripts/check-image-workflow.py
"""
import pathlib
import re
import sys

import yaml

ROOT = pathlib.Path(__file__).resolve().parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"
IMAGE = WORKFLOWS / "image.yml"
errors = []


def check(ok, message):
    if not ok:
        errors.append(message)


def load(path):
    # PyYAML (YAML 1.1) đọc khóa `on` thành True.
    data = yaml.safe_load(path.read_text())
    if True in data and "on" not in data:
        data["on"] = data.pop(True)
    return data


if not IMAGE.exists():
    print("FAIL: thiếu .github/workflows/image.yml")
    sys.exit(1)

text = IMAGE.read_text()
wf = load(IMAGE)
ci_jobs = set(load(WORKFLOWS / "ci.yml")["jobs"])

# TC-36-06: trigger
triggers = wf["on"]
check(set(triggers) == {"push", "workflow_dispatch"}, f"trigger phải là push và workflow_dispatch, đang là {sorted(triggers)}")
check(triggers.get("push", {}).get("branches") == ["main"], "push phải giới hạn branches: [main]")
check("pull_request" not in text, "không được có pull_request/pull_request_target")

# TC-36-07: tên job, quyền
jobs = wf["jobs"]
check(list(jobs) == ["image-push"], f"chỉ một job tên image-push, đang là {list(jobs)}")
for key, job in jobs.items():
    check(job.get("name", key) not in ci_jobs, f"tên job {job.get('name', key)} trùng hợp đồng của ci.yml")
check(wf.get("permissions") == {"contents": "read"}, "permissions mức workflow phải đúng {contents: read}")
job = jobs.get("image-push", {})
check(job.get("permissions", {}).get("id-token") == "write", "job image-push phải xin id-token: write")
check(job.get("permissions", {}).get("contents") == "read", "job image-push phải có contents: read")
for path in WORKFLOWS.glob("*.yml"):
    if path != IMAGE:
        check("id-token" not in path.read_text(), f"{path.name}: chỉ image.yml được xin id-token")

# TC-36-08: tag
check("${{ github.sha }}" in text, "tag phải là ${{ github.sha }}")
check(not re.search(r"latest", text, re.IGNORECASE), "không được có chuỗi latest")
check("length(images)" in text, "bước bỏ qua phải đọc length(images) của batch-get-image")
check("--provenance=false" in text and "--sbom=false" in text, "docker build phải có --provenance=false --sbom=false")

# TC-36-09: không access key, mọi action ghim SHA
check("secrets." not in text, "workflow không được dùng secrets.*")
check("aws-access-key-id" not in text and "aws-secret-access-key" not in text, "không dùng access key")
for line in text.splitlines():
    m = re.search(r"uses:\s*(\S+)", line)
    if m and not re.search(r"@[0-9a-f]{40}$", m.group(1)):
        errors.append(f"action chưa ghim SHA 40 ký tự: {m.group(1)}")

if errors:
    print("FAIL:")
    for e in errors:
        print(" -", e)
    sys.exit(1)
print("OK")
