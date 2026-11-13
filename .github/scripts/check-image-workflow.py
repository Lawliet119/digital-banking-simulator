#!/usr/bin/env python3
"""Kiểm tĩnh .github/workflows/image.yml (DBS-36, TC-36-06..09), deploy.yml (DBS-38, TC-38-16, 17) và cổng quét
Trivy/gitleaks trong ci.yml, image.yml, run-trivy.sh, run-gitleaks.sh (DBS-155, TC-155-01..04).
Cần PyYAML; không cần mạng. Chạy trên mọi PR trong job `secret-scan` của ci.yml.

Chạy từ gốc repo: python3 .github/scripts/check-image-workflow.py
Test dùng CHECK_IMAGE_WORKFLOW_ROOT để trỏ vào một bản sao đã sửa.
"""
import os
import pathlib
import re
import shlex
import sys

import yaml

ROOT = pathlib.Path(os.environ.get("CHECK_IMAGE_WORKFLOW_ROOT") or pathlib.Path(__file__).resolve().parents[2])
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

# ---- DBS-155: cổng quét image và secret (H7) ----
CI = WORKFLOWS / "ci.yml"
SCRIPTS = ROOT / ".github" / "scripts"
CONTRACT = {"lint", "typecheck", "unit", "e2e", "db", "build"}
TOOL_IMAGE_RE = re.compile(r"^ghcr\.io/(aquasecurity/trivy|gitleaks/gitleaks):[^@\s]+@sha256:[0-9a-f]{64}$")


def code_text(text):
    """Bỏ dòng chỉ có comment để các chuỗi trong comment không đánh lừa kiểm tra."""
    return "\n".join(line for line in text.splitlines() if not line.lstrip().startswith("#"))


def logical_lines(text):
    """Gộp dòng nối bằng \\, bỏ comment; trả về danh sách danh sách token (shlex), ngoặc tách riêng."""
    joined = re.sub(r"\\\n", " ", text)
    out = []
    for raw in joined.splitlines():
        if not raw.strip() or raw.lstrip().startswith("#"):
            continue
        try:
            out.append(shlex.split(raw.replace("(", " ").replace(")", " "), comments=True, posix=True))
        except ValueError:
            out.append(raw.split())
    return out


def flag_value(tokens, flag):
    for i, t in enumerate(tokens):
        if t == flag and i + 1 < len(tokens):
            return tokens[i + 1]
    return None


def check_tool_image(where, value, needle):
    ok = isinstance(value, str) and TOOL_IMAGE_RE.match(value) and needle in value
    check(ok, f"{where}: image công cụ phải là ghcr.io/{needle}:<ver>@sha256:<64 hex> (ghim digest), đang là {value!r}")


def job_steps_text(job):
    return "\n".join(str(st.get("run", "")) for st in job.get("steps", []))


if CI.exists():
    ci_text = CI.read_text()
    ci = load(CI)
    check(ci.get("permissions") == {"contents": "read"}, "ci.yml: permissions mức workflow phải đúng {contents: read}")
    for line in ci_text.splitlines():
        m = re.search(r"uses:\s*(\S+)", line)
        if m and not re.search(r"@[0-9a-f]{40}$", m.group(1)):
            errors.append(f"ci.yml: action chưa ghim SHA 40 ký tự: {m.group(1)}")
    ci_jobs_all = ci.get("jobs", {})
    for key, needle, tool_env, timeout_max in (
        ("image-scan", "aquasecurity/trivy", "TRIVY_IMAGE", 15),
        ("secret-scan", "gitleaks/gitleaks", "GITLEAKS_IMAGE", 10),
    ):
        job = ci_jobs_all.get(key)
        if job is None:
            errors.append(f"ci.yml: thiếu job {key}")
            continue
        check(job.get("name", key) == key, f"ci.yml: job {key} phải có name: {key}")
        check(job.get("name", key) not in CONTRACT, f"ci.yml: job {key} trùng một trong sáu tên hợp đồng ({job.get('name', key)})")
        tmo = job.get("timeout-minutes")
        check(isinstance(tmo, int) and 0 < tmo <= timeout_max, f"ci.yml: job {key} phải có timeout-minutes ≤ {timeout_max}, đang là {tmo!r}")
        wd = ((job.get("defaults") or {}).get("run") or {}).get("working-directory")
        check(wd == ".", f"ci.yml: job {key} phải đặt defaults.run.working-directory: . (mặc định của ci.yml là backend), đang là {wd!r}")
        check("id-token" not in str(job.get("permissions", "")), f"ci.yml: job {key} không được xin id-token")
        check_tool_image(f"ci.yml job {key}", (job.get("env") or {}).get(tool_env), needle)
        steps = job.get("steps", [])
        checkout = next((st for st in steps if str(st.get("uses", "")).startswith("actions/checkout@")), None)
        if checkout is None:
            errors.append(f"ci.yml: job {key} thiếu bước actions/checkout")
        else:
            w = checkout.get("with") or {}
            check(w.get("persist-credentials") is False, f"ci.yml: job {key}: checkout phải có persist-credentials: false")
            if key == "secret-scan":
                check(w.get("fetch-depth") == 0, "ci.yml: job secret-scan: checkout phải có fetch-depth: 0 (quét cả lịch sử)")
        runs = job_steps_text(job)
        if key == "image-scan":
            check("run-trivy.sh" in runs, "ci.yml: job image-scan phải chạy run-trivy.sh")
        else:
            for script in ("check-image-workflow.py", "check-scan-exceptions.py", "run-gitleaks.sh"):
                check(script in runs, f"ci.yml: job secret-scan phải chạy {script}")

for sock_path in list(WORKFLOWS.glob("*.yml")) + [SCRIPTS / "run-trivy.sh", SCRIPTS / "run-gitleaks.sh"]:
    if sock_path.exists():
        check("docker.sock" not in code_text(sock_path.read_text()), f"{sock_path.name}: không được dùng docker.sock (container công cụ không có quyền root trên runner)")

if IMAGE.exists():
    steps = wf["jobs"].get("image-push", {}).get("steps", [])
    idx_trivy = next((i for i, st in enumerate(steps) if "run-trivy.sh" in str(st.get("run", ""))), None)
    idx_cred = next((i for i, st in enumerate(steps) if str(st.get("uses", "")).startswith("aws-actions/configure-aws-credentials@")), None)
    idx_push = next((i for i, st in enumerate(steps) if "docker push" in str(st.get("run", ""))), None)
    if idx_trivy is None:
        errors.append("image.yml: thiếu bước chạy run-trivy.sh")
    elif idx_cred is None or idx_push is None or not (idx_trivy < idx_cred < idx_push):
        errors.append("image.yml: bước run-trivy.sh phải đứng trước configure-aws-credentials và docker push")
    check_tool_image("image.yml job image-push", (wf["jobs"].get("image-push", {}).get("env") or {}).get("TRIVY_IMAGE"), "aquasecurity/trivy")

gitleaks_sh = SCRIPTS / "run-gitleaks.sh"
if not gitleaks_sh.exists():
    errors.append("thiếu .github/scripts/run-gitleaks.sh")
else:
    gl_text = gitleaks_sh.read_text()
    gl_code = code_text(gl_text)
    gl_lines = logical_lines(gl_text)
    gl_call = [t for t in gl_lines if "git" in t and "$SCAN_PATH" in t]
    gl_opts = [t for t in gl_lines if any(x.startswith("opts=") or x.startswith("opts+=") for x in t)]
    if not gl_call:
        errors.append('run-gitleaks.sh: không thấy lệnh `git "$SCAN_PATH"` của gitleaks')
    else:
        log_opts = [x for x in gl_call[0] if x.startswith("--log-opts")]
        check(log_opts == ["--log-opts=HEAD"], f'run-gitleaks.sh: lệnh gitleaks phải có đúng --log-opts="HEAD", đang là {log_opts}')
    flat = [x for t in gl_call + gl_opts for x in t]
    for flag in ("--no-color", "--redact"):
        check(any(x == flag or x.endswith("(" + flag) or x.endswith(flag) for x in flat), f"run-gitleaks.sh: thiếu {flag}")
    exit_codes = [flag_value(t, "--exit-code") for t in gl_call + gl_opts]
    exit_codes = [v for v in exit_codes if v is not None]
    check(bool(exit_codes) and all(v == "1" for v in exit_codes), "run-gitleaks.sh: phải có --exit-code 1")
    check("is-shallow-repository" in gl_code, "run-gitleaks.sh: thiếu kiểm repo nông (rev-parse --is-shallow-repository)")

trivy_sh = SCRIPTS / "run-trivy.sh"
if not trivy_sh.exists():
    errors.append("thiếu .github/scripts/run-trivy.sh")
else:
    tv_lines = logical_lines(trivy_sh.read_text())
    common = next((t for t in tv_lines if "docker" in t and "run" in t and "--input" in t), None)
    if common is None:
        errors.append("run-trivy.sh: không thấy lệnh docker run của lượt quét (--input)")
    else:
        for flag in ("--skip-db-update", "--skip-java-db-update", "--offline-scan", "--ignorefile"):
            check(flag in common, f"run-trivy.sh: lượt quét thiếu {flag}")
        check(flag_value(common, "--network") == "none", "run-trivy.sh: lượt quét phải chạy --network none")
    passes = [t[1:] for t in tv_lines if t and t[0] == "scan"]
    gate = next((p for p in passes if flag_value(p, "--scanners") == "vuln" and flag_value(p, "--exit-code") == "1"), None)
    check(gate is not None, "run-trivy.sh: thiếu lượt chặn lỗ hổng (--scanners vuln --exit-code 1)")
    if gate is not None:
        check(flag_value(gate, "--severity") == "HIGH,CRITICAL", "run-trivy.sh: lượt chặn phải có --severity HIGH,CRITICAL")
        check("--ignore-unfixed" in gate, "run-trivy.sh: lượt chặn phải có --ignore-unfixed")
    secret = next((p for p in passes if flag_value(p, "--scanners") == "secret"), None)
    check(secret is not None and flag_value(secret, "--exit-code") == "1", "run-trivy.sh: thiếu lượt chặn secret (--scanners secret --exit-code 1)")
    check(secret is None or "--severity" not in secret, "run-trivy.sh: lượt quét secret không được lọc theo --severity (mọi mức đều đỏ)")
    check(any(flag_value(p, "--exit-code") == "0" for p in passes), "run-trivy.sh: thiếu lượt chỉ in (--exit-code 0)")

if errors:
    print("FAIL:")
    for e in errors:
        print(" -", e)
    sys.exit(1)
print("OK")
