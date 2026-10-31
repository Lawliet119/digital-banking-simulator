#!/usr/bin/env python3
"""Kiểm tĩnh .github/workflows/image.yml (DBS-36, TC-36-06..09) và deploy.yml (DBS-38, TC-38-16, 17).
Cần PyYAML; không cần mạng.

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


# ---- DBS-38: deploy.yml (spec riêng) và ignore_changes của service api ----
DEPLOY = WORKFLOWS / "deploy.yml"
ECS_TF = ROOT / "infra" / "terraform" / "envs" / "dev" / "session" / "ecs.tf"
REQUIRED_IF = [
    "github.event_name == 'workflow_dispatch'",
    "github.event.workflow_run.conclusion == 'success'",
    "github.event.workflow_run.head_branch == 'main'",
    "github.event.workflow_run.head_repository.full_name == github.repository",
    "github.event.workflow_run.event == 'push'",
    "github.event.workflow_run.event == 'workflow_dispatch'",
    "vars.AWS_DEPLOY_ROLE_ARN != ''",
]


def deploy_errors(text, ci_job_names):
    """Trả về danh sách lỗi của nội dung deploy.yml; dùng cho file thật và fixture âm."""
    out = []
    wf = yaml.safe_load(text)
    if True in wf and "on" not in wf:
        wf["on"] = wf.pop(True)
    trig = wf.get("on", {})
    if set(trig) != {"workflow_run", "workflow_dispatch"}:
        out.append(f"deploy.yml: trigger phải là workflow_run và workflow_dispatch, đang là {sorted(trig)}")
    wr = trig.get("workflow_run", {}) if isinstance(trig, dict) else {}
    if wr.get("workflows") != ["Image"] or wr.get("branches") != ["main"] or wr.get("types") != ["completed"]:
        out.append("deploy.yml: workflow_run phải đúng workflows [Image], branches [main], types [completed]")
    jobs = wf.get("jobs", {})
    if list(jobs) != ["deploy"]:
        out.append(f"deploy.yml: chỉ một job tên deploy, đang là {list(jobs)}")
    for key, job in jobs.items():
        if job.get("name", key) in ci_job_names:
            out.append(f"deploy.yml: tên job {key} trùng hợp đồng của ci.yml")
    if wf.get("permissions") != {"contents": "read"}:
        out.append("deploy.yml: permissions mức workflow phải đúng {contents: read}")
    job = jobs.get("deploy", {})
    if job.get("permissions") != {"contents": "read", "id-token": "write"}:
        out.append("deploy.yml: permissions mức job phải đúng {contents: read, id-token: write}")
    cond = str(job.get("if", ""))
    for needle in REQUIRED_IF:
        if needle not in cond:
            out.append(f"deploy.yml: thiếu điều kiện trong if: {needle}")
    if "secrets." in text:
        out.append("deploy.yml: không được dùng secrets.*")
    if "aws-access-key-id" in text or "aws-secret-access-key" in text:
        out.append("deploy.yml: không dùng access key")
    for step in job.get("steps", []):
        if "${{ github.event" in str(step.get("run", "")):
            out.append("deploy.yml: không đưa ${{ github.event... }} thẳng vào run:, đi qua env:")
        if "actions/cache" in str(step.get("uses", "")) or "cache" in (step.get("with") or {}):
            out.append("deploy.yml: không dùng cache (trust dùng chung với role ghi)")
    for line in text.splitlines():
        m = re.search(r"uses:\s*(\S+)", line)
        if m and not re.search(r"@[0-9a-f]{40}$", m.group(1)):
            out.append(f"deploy.yml: action chưa ghim SHA 40 ký tự: {m.group(1)}")
    return out


if DEPLOY.exists():
    errors.extend(deploy_errors(DEPLOY.read_text(), ci_jobs))
    # Fixture âm: bỏ từng điều kiện / thêm vi phạm thì bộ kiểm phải đỏ.
    base = DEPLOY.read_text()
    negatives = [("thiếu head_branch", base.replace("github.event.workflow_run.head_branch == 'main'", "true")),
                 ("thiếu cùng repo", base.replace("github.event.workflow_run.head_repository.full_name == github.repository", "true")),
                 ("thêm secrets", base + "\n# ${{ secrets.X }}\n"),
                 ("action không ghim", base + "\n      - uses: actions/checkout@v4\n")]
    for name, bad in negatives:
        try:
            if not deploy_errors(bad, ci_jobs):
                errors.append(f"fixture âm '{name}' không bị bắt")
        except yaml.YAMLError:
            pass  # YAML hỏng cũng là đỏ
else:
    errors.append("thiếu .github/workflows/deploy.yml")
for path in WORKFLOWS.glob("*.yml"):
    if path not in (IMAGE, DEPLOY):
        check("id-token" not in path.read_text(), f"{path.name}: chỉ image.yml và deploy.yml được xin id-token")
check("ignore_changes" in ECS_TF.read_text() and "task_definition" in ECS_TF.read_text().split("ignore_changes")[1].split("]")[0],
      "session/ecs.tf: service api phải có lifecycle ignore_changes = [task_definition]")

if errors:
    print("FAIL:")
    for e in errors:
        print(" -", e)
    sys.exit(1)
print("OK")
