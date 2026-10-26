#!/usr/bin/env python3
"""Test của .github/scripts/deploy.sh (DBS-38, TC-38-04..13) bằng `aws`, `curl` và `gh` giả; chỉ dùng thư viện chuẩn.

Chạy: python3 .github/scripts/tests/test_deploy.py
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE.parent / "deploy.sh"
FAKE_AWS = HERE / "fake_aws_deploy.py"
REPO = "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/dbs-api"
OLD, NEW = "1" * 40, "2" * 40
ARN_OLD = "arn:aws:ecs:ap-southeast-1:123456789012:task-definition/dbs-api:7"
ARN_NEW = "arn:aws:ecs:ap-southeast-1:123456789012:task-definition/dbs-api:8"


def td_response(image, with_secrets=True):
    c = {"name": "api", "image": image, "essential": True, "environment": [{"name": "APP_ROLE", "value": "api"}]}
    if with_secrets:
        c["secrets"] = [{"name": "PGPASSWORD", "valueFrom": "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:x:password::"}]
    return {"taskDefinition": {"taskDefinitionArn": ARN_OLD, "family": "dbs-api", "revision": 7, "status": "ACTIVE",
                               "networkMode": "awsvpc", "requiresCompatibilities": ["FARGATE"], "cpu": "512",
                               "memory": "1024", "containerDefinitions": [c]},
            "tags": [{"key": "project", "value": "dbs"}]}


def service(td=ARN_OLD, desired=1, status="ACTIVE", deployments=None, events=None):
    return {"services": [{"serviceName": "api", "status": status, "desiredCount": desired, "taskDefinition": td,
                          "networkConfiguration": {"awsvpcConfiguration": {
                              "subnets": ["subnet-a", "subnet-b"], "securityGroups": ["sg-api"], "assignPublicIp": "ENABLED"}},
                          "deployments": deployments or [{"status": "PRIMARY", "taskDefinition": td, "rolloutState": "COMPLETED"}],
                          "events": [{"message": m} for m in (events or [])]}], "failures": []}


def deployment(td, state):
    return [{"status": "PRIMARY", "taskDefinition": td, "rolloutState": state}]


class Env:
    def __init__(self, **scenario):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        self.state, self.bin = root / "state", root / "bin"
        self.state.mkdir()
        self.bin.mkdir()
        base = {"describe_services": [service()], "ecr_images": 1, "task_definition_response": td_response(f"{REPO}:{OLD}"),
                "register_arn": ARN_NEW}
        base.update(scenario)
        (self.state / "scenario.json").write_text(json.dumps(base))
        self.write("aws", f'#!/bin/sh\nexec "{sys.executable}" "{FAKE_AWS}" "$@"\n')
        self.write("curl", f"""#!/bin/sh
url=""; for a in "$@"; do case "$a" in https://*) url="$a";; esac; done
echo "$url" >> "{self.state}/curl.log"
case "$url" in *live) name=live;; *) name=ready;; esac
seq="$(printenv FAKE_CURL_$name)"; seq="${{seq:-200}}"
n=$(cat "{self.state}/curl.$name" 2>/dev/null || echo 0); echo $((n+1)) > "{self.state}/curl.$name"
echo "$seq" | tr ',' '\\n' | sed -n "$((n+1))p" | grep . || echo "$seq" | tr ',' '\\n' | tail -1
""")
        self.write("gh", f"""#!/bin/sh
echo "$@" >> "{self.state}/gh.log"
echo "${{FAKE_MAIN_HEAD:-}}"
""")

    def write(self, name, text):
        p = self.bin / name
        p.write_text(text)
        p.chmod(0o755)

    def run(self, tag=NEW, script=SCRIPT, **extra):
        env = {"PATH": f"{self.bin}:/usr/bin:/bin", "FAKE_STATE": str(self.state), "HOME": self.tmp.name,
               "IMAGE_TAG": tag, "POLL_SECONDS": "0", "HEALTH_WAIT": "0", "HEALTH_RETRIES": "3",
               "DEADLINE_SECONDS": "5", "GITHUB_EVENT_NAME": "workflow_run"}
        env.update(extra)
        return subprocess.run(["bash", str(script)], env=env, capture_output=True, text=True)

    def calls(self):
        p = self.state / "calls.jsonl"
        return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []

    def ops(self):
        return [" ".join(c["argv"][:2]) for c in self.calls()]

    def curls(self):
        p = self.state / "curl.log"
        return p.read_text().split() if p.exists() else []

    def cleanup(self):
        self.tmp.cleanup()


class Deploy(unittest.TestCase):
    def make(self, **scenario):
        e = Env(**scenario)
        self.addCleanup(e.cleanup)
        return e

    # TC-38-04: đường bình thường
    def test_happy_path_order_and_exit_zero(self):
        e = self.make(describe_services=[service(), service(ARN_NEW, deployments=deployment(ARN_NEW, "IN_PROGRESS")),
                                         service(ARN_NEW, deployments=deployment(ARN_NEW, "COMPLETED"))])
        p = e.run()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        ops = e.ops()
        order = ["ecs describe-services", "ecr batch-get-image", "ecs describe-task-definition",
                 "ecs register-task-definition", "ecs update-service", "ecs describe-services",
                 "elbv2 describe-load-balancers"]
        pos = -1
        for op in order:
            pos = ops.index(op, pos + 1)
        reg = next(c for c in e.calls() if c["argv"][1] == "register-task-definition")
        self.assertEqual(reg["input_json"]["containerDefinitions"][0]["image"], f"{REPO}:{NEW}")
        self.assertEqual([u.rsplit("/", 1)[1] for u in e.curls()[:2]], ["live", "ready"])
        upd = next(c for c in e.calls() if c["argv"][1] == "update-service")
        self.assertIn(ARN_NEW, upd["argv"])

    # TC-38-05: không có runtime
    def test_missing_runtime_is_skipped(self):
        for scenario in (
            {"error": {"op": "ecs describe-services", "code": "ClusterNotFoundException"}},
            {"describe_services": [{"services": [], "failures": [{"arn": "x", "reason": "MISSING"}]}]},
            {"describe_services": [service(status="INACTIVE")]},
        ):
            e = self.make(**scenario)
            p = e.run()
            self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
            self.assertNotIn("ecs register-task-definition", e.ops())
            self.assertNotIn("ecs update-service", e.ops())
            self.assertIn("bỏ qua", p.stdout + p.stderr)

    def test_other_describe_error_fails(self):
        e = self.make(error={"op": "ecs describe-services", "code": "AccessDeniedException"})
        self.assertNotEqual(e.run().returncode, 0)

    # TC-38-06
    def test_desired_count_zero_warns_and_exits_zero(self):
        e = self.make(describe_services=[service(desired=0)])
        p = e.run()
        self.assertEqual(p.returncode, 0)
        self.assertIn("::warning::", p.stdout + p.stderr)
        self.assertNotIn("ecs register-task-definition", e.ops())
        self.assertEqual(e.curls(), [])

    # TC-38-07: batch-get-image luôn thoát 0, lỗi nằm trong failures
    def test_missing_image_workflow_run_warns(self):
        e = self.make(ecr_images=0)
        p = e.run()
        self.assertEqual(p.returncode, 0)
        self.assertIn("::warning::", p.stdout + p.stderr)
        self.assertNotIn("ecs register-task-definition", e.ops())

    def test_missing_image_workflow_dispatch_fails(self):
        e = self.make(ecr_images=0)
        p = e.run(GITHUB_EVENT_NAME="workflow_dispatch")
        self.assertNotEqual(p.returncode, 0)
        self.assertNotIn("ecs register-task-definition", e.ops())

    # TC-38-08: idempotent
    def test_latest_revision_already_has_image(self):
        e = self.make(task_definition_response=td_response(f"{REPO}:{NEW}"),
                      describe_services=[service(ARN_OLD), service(ARN_OLD),
                                         service(ARN_OLD, deployments=deployment(ARN_OLD, "COMPLETED"))])
        # revision ACTIVE mới nhất (ARN_OLD trong fixture) đã dùng NEW: không đăng ký lại
        p = e.run()
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertNotIn("ecs register-task-definition", e.ops())
        self.assertEqual(len(e.curls()), 2)

    # TC-38-09: circuit breaker, FAILED, hết hạn
    def test_rollback_to_old_revision_is_red(self):
        e = self.make(describe_services=[service(), service(ARN_NEW, deployments=deployment(ARN_NEW, "IN_PROGRESS")),
                                         service(ARN_OLD, deployments=deployment(ARN_OLD, "COMPLETED"), events=["rolled back", "task failed"])])
        p = e.run()
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(e.curls(), [])
        self.assertIn("rolled back", p.stdout + p.stderr)

    def test_failed_rollout_is_red(self):
        e = self.make(describe_services=[service(), service(ARN_NEW, deployments=deployment(ARN_NEW, "FAILED"), events=["boom"])])
        p = e.run()
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(e.curls(), [])

    def test_deadline_is_red(self):
        e = self.make(describe_services=[service(), service(ARN_NEW, deployments=deployment(ARN_NEW, "IN_PROGRESS"), events=["still going"])])
        p = e.run(DEADLINE_SECONDS="1", POLL_SECONDS="1")
        self.assertNotEqual(p.returncode, 0)
        self.assertIn("still going", p.stdout + p.stderr)

    # TC-38-10: health
    def test_ready_stays_503_is_red(self):
        e = self.make(describe_services=[service(), service(ARN_NEW, deployments=deployment(ARN_NEW, "COMPLETED"))])
        self.assertNotEqual(e.run(FAKE_CURL_ready="503").returncode, 0)

    def test_ready_recovers_after_retry(self):
        e = self.make(describe_services=[service(), service(ARN_NEW, deployments=deployment(ARN_NEW, "COMPLETED"))])
        p = e.run(FAKE_CURL_ready="503,200")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)

    # TC-38-11: tag xấu bị từ chối trước mọi lời gọi aws
    def test_bad_tags_rejected_before_aws(self):
        for bad in ("", "latest", "abc123", "G" * 40):
            e = self.make()
            p = e.run(tag=bad)
            self.assertNotEqual(p.returncode, 0)
            self.assertEqual(e.calls(), [])

    # TC-38-12: chỉ kiểm đầu main khi CHECK_MAIN_HEAD=1
    def test_stale_commit_is_skipped_when_checking_main_head(self):
        e = self.make()
        p = e.run(CHECK_MAIN_HEAD="1", GITHUB_REPOSITORY="Lawliet119/digital-banking-simulator", FAKE_MAIN_HEAD="3" * 40)
        self.assertEqual(p.returncode, 0)
        self.assertIn("commit mới hơn", p.stdout + p.stderr)
        self.assertNotIn("ecs register-task-definition", e.ops())

    def test_current_head_proceeds(self):
        e = self.make(describe_services=[service(), service(ARN_NEW, deployments=deployment(ARN_NEW, "COMPLETED"))])
        p = e.run(CHECK_MAIN_HEAD="1", GITHUB_REPOSITORY="Lawliet119/digital-banking-simulator", FAKE_MAIN_HEAD=NEW)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("ecs register-task-definition", e.ops())

    def test_manual_run_never_calls_gh(self):
        e = self.make(describe_services=[service(), service(ARN_NEW, deployments=deployment(ARN_NEW, "COMPLETED"))])
        self.assertEqual(e.run().returncode, 0)
        self.assertFalse((e.state / "gh.log").exists())

    # TC-38-13: secrets của family mới nhất không bị đè
    def test_secrets_of_latest_family_revision_are_kept(self):
        e = self.make(task_definition_response=td_response(f"{REPO}:{OLD}", with_secrets=True),
                      describe_services=[service(), service(ARN_NEW, deployments=deployment(ARN_NEW, "COMPLETED"))])
        self.assertEqual(e.run().returncode, 0)
        reg = next(c for c in e.calls() if c["argv"][1] == "register-task-definition")
        self.assertIn("secrets", reg["input_json"]["containerDefinitions"][0])
        dt = next(c for c in e.calls() if c["argv"][1] == "describe-task-definition")
        self.assertIn("dbs-api", dt["argv"])  # family, không phải revision của service
        self.assertNotIn(ARN_OLD, dt["argv"])


if __name__ == "__main__":
    unittest.main(verbosity=2)
