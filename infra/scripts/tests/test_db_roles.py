#!/usr/bin/env python3
"""Test của infra/scripts/db-roles.sh (BL-103, TC-103-10..) bằng `aws` giả; chỉ dùng thư viện chuẩn.

Chạy: python3 infra/scripts/tests/test_db_roles.py   (Linux: PATH tách bằng `:`, cần bash và python3)

`aws` giả đọc kịch bản từ $FAKE_STATE/scenario.json và ghi mỗi lời gọi (argv và nội dung các file `file://`
tại thời điểm gọi) vào calls.jsonl.
"""
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE.parent / "db-roles.sh"

ACCOUNT = "123456789012"
REGION = "ap-southeast-1"
REPO = f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/dbs-api"
OLD_SHA = "0" * 40
NEW_SHA = "b" * 40
TD_OLD = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/dbs-db-roles:1"
TD_NEW = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/dbs-db-roles:2"
TASK_ID = "0123456789abcdef0123456789abcdef"
TASK_ARN = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task/dbs-dev/{TASK_ID}"

FAKE_AWS = r'''#!/usr/bin/env python3
import json, os, sys
state = os.environ["FAKE_STATE"]
scen = json.load(open(os.path.join(state, "scenario.json")))
argv = sys.argv[1:]
record = {"argv": argv, "files": {}}
for i, a in enumerate(argv):
    if i + 1 < len(argv) and argv[i + 1].startswith("file://"):
        record["files"][a] = json.load(open(argv[i + 1][7:]))
with open(os.path.join(state, "calls.jsonl"), "a") as f:
    f.write(json.dumps(record) + "\n")
svc, op = argv[0], argv[1]
key = f"{svc} {op}"
counter_file = os.path.join(state, "counter.json")
counters = json.load(open(counter_file)) if os.path.exists(counter_file) else {}

def fail(code, message="fake"):
    sys.stderr.write(f"\naws: [ERROR]: An error occurred ({code}) when calling the {op} operation: {message}\n")
    sys.exit(254)

if key == "ecs describe-services":
    print(json.dumps(scen["describe_services"]))
elif key == "ecs list-tasks":
    print(json.dumps({"taskArns": scen.get("running", [])}))
elif key == "ecs describe-task-definition":
    if scen.get("family_missing"):
        fail("ClientException", "Unable to describe task definition.")
    print(json.dumps(scen["task_definition_response"]))
elif key == "ecs register-task-definition":
    print(json.dumps({"taskDefinition": {"taskDefinitionArn": scen["register_arn"]}}))
elif key == "ecs run-task":
    print(json.dumps(scen["run_task"]))
elif key == "ecs describe-tasks":
    seq = scen["describe_tasks"]
    n = counters.get("poll", 0)
    counters["poll"] = n + 1
    json.dump(counters, open(counter_file, "w"))
    print(json.dumps(seq[min(n, len(seq) - 1)]))
elif key == "ecs stop-task":
    print(json.dumps({"task": {}}))
elif key == "logs get-log-events":
    if scen.get("log_stream_missing"):
        fail("ResourceNotFoundException")
    print(json.dumps({"events": [{"message": m + "\n"} for m in scen.get("log_events", [])]}))
else:
    fail("UnknownOperation")
'''


def service():
    return {"services": [{"serviceName": "api", "networkConfiguration": {"awsvpcConfiguration": {
        "subnets": ["subnet-a", "subnet-b"], "securityGroups": ["sg-api"], "assignPublicIp": "ENABLED"}}}], "failures": []}


def roles_td(image):
    return {"taskDefinition": {
        "taskDefinitionArn": TD_OLD, "family": "dbs-db-roles", "revision": 1, "status": "ACTIVE", "networkMode": "awsvpc",
        "requiresCompatibilities": ["FARGATE"], "cpu": "256", "memory": "512",
        "containerDefinitions": [{
            "name": "db-roles", "image": image, "essential": True,
            "command": ["node", "dist/scripts/provision-db-roles.main.js"],
            "secrets": [{"name": "DB_PASSWORD", "valueFrom": "arn:aws:secretsmanager:x:y:secret:z:password::"}],
            "logConfiguration": {"logDriver": "awslogs", "options": {"awslogs-group": "/dbs/dev/api", "awslogs-stream-prefix": "db-roles"}}}]},
        "tags": [{"key": "project", "value": "dbs"}]}


def stopped(code, reason="Essential container in task exited"):
    containers = [{"name": "db-roles", **({} if code is None else {"exitCode": code})}]
    return {"tasks": [{"taskArn": TASK_ARN, "lastStatus": "STOPPED", "stoppedReason": reason, "containers": containers}], "failures": []}


def running(status="RUNNING"):
    return {"tasks": [{"taskArn": TASK_ARN, "lastStatus": status, "containers": [{"name": "db-roles"}]}], "failures": []}


class Env:
    def __init__(self, **scenario):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        self.state = root / "state"
        self.state.mkdir()
        self.tmpdir = root / "tmp"
        self.tmpdir.mkdir()
        bindir = root / "bin"
        bindir.mkdir()
        (bindir / "aws").write_text(FAKE_AWS)
        (bindir / "aws").chmod(0o755)
        self.bindir = bindir
        base = {
            "describe_services": service(),
            "task_definition_response": roles_td(f"{REPO}:{OLD_SHA}"),
            "register_arn": TD_NEW,
            "run_task": {"tasks": [{"taskArn": TASK_ARN}], "failures": []},
            "describe_tasks": [stopped(0)],
            "log_events": ["Đã đặt LOGIN và mật khẩu cho role dbs_api", "Đăng nhập thử bằng dbs_api: được"],
        }
        base.update(scenario)
        (self.state / "scenario.json").write_text(json.dumps(base))

    def cleanup(self):
        self.tmp.cleanup()

    def run(self, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("IMAGE_TAG", "AWS_", "DB_ROLES_"))}
        env.update({"PATH": f"{self.bindir}:{env['PATH']}", "FAKE_STATE": str(self.state), "TMPDIR": str(self.tmpdir),
                    "POLL_SECONDS": "0", "DB_ROLES_STOP_WAIT_SECONDS": "0", "DB_ROLES_DEADLINE_SECONDS": "30"})
        env.update(extra)
        return subprocess.run(["bash", str(SCRIPT)], env=env, capture_output=True, text=True, timeout=120)

    def calls(self):
        path = self.state / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def ops(self):
        return [" ".join(c["argv"][:2]) for c in self.calls()]


class DbRoles(unittest.TestCase):
    def make(self, **scenario):
        e = Env(**scenario)
        self.addCleanup(e.cleanup)
        return e

    def call(self, e, name):
        return next(c for c in e.calls() if " ".join(c["argv"][:2]) == name)

    # TC-103-10
    def test_success_runs_the_task_in_the_api_network_without_overrides(self):
        e = self.make()
        p = e.run()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("dbs_api, dbs_worker, dbs_migrator", p.stdout)
        run = self.call(e, "ecs run-task")
        self.assertEqual(run["files"]["--network-configuration"], {"awsvpcConfiguration": {
            "subnets": ["subnet-a", "subnet-b"], "securityGroups": ["sg-api"], "assignPublicIp": "ENABLED"}})
        self.assertNotIn("--overrides", run["argv"])  # mật khẩu không bao giờ đi qua containerOverrides
        self.assertIn(TD_OLD, run["argv"])
        self.assertNotIn("ecs register-task-definition", e.ops())  # mặc định dùng đúng image của revision mới nhất

    # TC-103-11
    def test_image_tag_registers_a_revision_that_only_changes_the_image(self):
        e = self.make()
        p = e.run(IMAGE_TAG=NEW_SHA)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        reg = self.call(e, "ecs register-task-definition")["files"]["--cli-input-json"]
        self.assertEqual(reg["family"], "dbs-db-roles")
        self.assertEqual(reg["containerDefinitions"][0]["image"], f"{REPO}:{NEW_SHA}")
        self.assertEqual(reg["containerDefinitions"][0]["command"], ["node", "dist/scripts/provision-db-roles.main.js"])
        self.assertEqual(reg["containerDefinitions"][0]["secrets"][0]["name"], "DB_PASSWORD")
        self.assertIn(TD_NEW, self.call(e, "ecs run-task")["argv"])

    # TC-103-12
    def test_nonzero_exit_is_red_and_prints_the_log(self):
        e = self.make(describe_tasks=[running(), stopped(1)], log_events=["password authentication failed for user dbs_master"])
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertIn("password authentication failed", p.stdout)
        self.assertIn("exitCode 1", p.stderr)

    def test_missing_exit_code_is_red(self):
        e = self.make(describe_tasks=[stopped(None, "CannotPullContainerError")])
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertIn("CannotPullContainerError", p.stderr)

    def test_run_task_failures_is_red_without_polling(self):
        e = self.make(run_task={"tasks": [], "failures": [{"reason": "RESOURCE:ENI", "detail": "no eni"}]})
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertIn("RESOURCE:ENI", p.stderr)
        self.assertNotIn("ecs describe-tasks", e.ops())

    def test_a_running_task_blocks_a_second_run(self):
        e = self.make(running=[TASK_ARN])
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertIn(TASK_ID, p.stderr)
        self.assertNotIn("ecs run-task", e.ops())

    def test_family_missing_points_to_terraform_apply(self):
        e = self.make(family_missing=True)
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertIn("terraform apply", p.stderr)
        self.assertNotIn("ecs run-task", e.ops())

    def test_bad_tags_are_rejected_before_run_task(self):
        for bad in ("latest", "abc123", "G" * 40):
            e = self.make()
            p = e.run(IMAGE_TAG=bad)
            self.assertEqual(p.returncode, 1)
            self.assertNotIn("ecs run-task", e.ops())

    def test_deadline_stops_the_task_and_is_red(self):
        e = self.make(describe_tasks=[running(), running(), stopped(137)])
        p = e.run(DB_ROLES_DEADLINE_SECONDS="0", DB_ROLES_STOP_WAIT_SECONDS="30")
        self.assertEqual(p.returncode, 1)
        self.assertIn("ecs stop-task", e.ops())
        self.assertIn("quá hạn", p.stderr)

    def test_log_stream_missing_is_not_a_second_failure(self):
        e = self.make(describe_tasks=[stopped(1)], log_stream_missing=True)
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertIn("không đọc được log", p.stdout)

    def test_script_never_passes_a_secret_on_the_command_line(self):
        e = self.make()
        e.run(IMAGE_TAG=NEW_SHA)
        for c in e.calls():
            self.assertFalse(any("password" in a.lower() and not a.startswith("--") and "secret" not in a.lower()
                                 for a in c["argv"]), c["argv"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
