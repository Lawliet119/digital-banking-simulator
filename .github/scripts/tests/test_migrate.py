#!/usr/bin/env python3
"""Test của .github/scripts/migrate.sh (DBS-68, TC-68-01..07, 09, 16) bằng `aws` giả; chỉ dùng thư viện chuẩn.

Chạy: python3 .github/scripts/tests/test_migrate.py
"""
import json
import pathlib
import unittest

from test_deploy import ARN_NEW, ARN_OLD, NEW, OLD, REPO, Env, service, td_response

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "migrate.sh"
ACCOUNT = "123456789012"
M_OLD = f"arn:aws:ecs:ap-southeast-1:{ACCOUNT}:task-definition/dbs-migrate:3"
M_NEW = f"arn:aws:ecs:ap-southeast-1:{ACCOUNT}:task-definition/dbs-migrate:4"
TASK_ID = "0123456789abcdef0123456789abcdef"
TASK_ARN = f"arn:aws:ecs:ap-southeast-1:{ACCOUNT}:task/dbs-dev/{TASK_ID}"
DB_HOST = "dbs-dev.abc.ap-southeast-1.rds.amazonaws.com"


def migrate_td(image):
    return {"taskDefinition": {
        "taskDefinitionArn": M_OLD, "family": "dbs-migrate", "revision": 3, "status": "ACTIVE", "networkMode": "awsvpc",
        "requiresCompatibilities": ["FARGATE"], "cpu": "256", "memory": "512",
        "containerDefinitions": [{
            "name": "migrate", "image": image, "essential": True,
            "command": ["node", "./node_modules/typeorm/cli.js", "-d", "dist/database/data-source.js", "migration:run"],
            "environment": [{"name": "DB_HOST", "value": DB_HOST}],
            "logConfiguration": {"logDriver": "awslogs", "options": {"awslogs-group": "/dbs/dev/api", "awslogs-stream-prefix": "migrate"}}}]},
        "tags": [{"key": "project", "value": "dbs"}]}


def stopped(code, reason="Essential container in task exited", extra_containers=()):
    containers = list(extra_containers) + [{"name": "migrate", **({} if code is None else {"exitCode": code})}]
    return {"tasks": [{"taskArn": TASK_ARN, "lastStatus": "STOPPED", "stoppedReason": reason, "containers": containers}], "failures": []}


def running(status="RUNNING"):
    return {"tasks": [{"taskArn": TASK_ARN, "lastStatus": status, "containers": [{"name": "migrate"}]}], "failures": []}


class Migrate(unittest.TestCase):
    def make(self, **scenario):
        base = {"migrate_task_definition_response": migrate_td(f"{REPO}:{OLD}"), "register_arn_migrate": M_NEW,
                "run_task": {"tasks": [{"taskArn": TASK_ARN}], "failures": []}, "describe_tasks": [stopped(0)]}
        base.update(scenario)
        e = Env(**base)
        self.addCleanup(e.cleanup)
        return e

    def run_script(self, e, **extra):
        env = {"MIGRATE_DEADLINE_SECONDS": "30", "MIGRATE_STOP_WAIT_SECONDS": "0"}
        env.update(extra)
        return e.run(script=SCRIPT, **env)

    def call(self, e, name):
        return next(c for c in e.calls() if " ".join(c["argv"][:2]) == name)

    # TC-68-01
    def test_success_registers_new_image_and_runs_task_with_service_network(self):
        e = self.make()
        p = self.run_script(e)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertIn("Migration xong", p.stdout)
        reg = self.call(e, "ecs register-task-definition")["input_json"]
        self.assertEqual(reg["family"], "dbs-migrate")
        self.assertEqual(reg["containerDefinitions"][0]["image"], f"{REPO}:{NEW}")
        self.assertEqual(reg["containerDefinitions"][0]["command"][-1], "migration:run")
        run = self.call(e, "ecs run-task")["argv"]
        for arg in ("dbs-dev", M_NEW, "FARGATE", "migrate-" + NEW[:7], "TASK_DEFINITION"):
            self.assertIn(arg, run)
        self.assertEqual(run[run.index("--count") + 1], "1")
        self.assertEqual(self.call(e, "ecs run-task")["network_json"], {"awsvpcConfiguration": {
            "subnets": ["subnet-a", "subnet-b"], "securityGroups": ["sg-api"], "assignPublicIp": "ENABLED"}})
        self.assertIn("ecs describe-services", e.ops())  # chạy tay: tự đọc service

    # TC-68-02
    def test_nonzero_exit_is_red_and_prints_logs(self):
        e = self.make(describe_tasks=[stopped(1)], log_events=["QueryFailedError: relation exists"])
        p = self.run_script(e)
        self.assertEqual(p.returncode, 1)
        self.assertIn("thất bại (exitCode 1)", p.stdout + p.stderr)
        self.assertIn("QueryFailedError: relation exists", p.stdout)
        stream = self.call(e, "logs get-log-events")["argv"]
        self.assertIn(f"migrate/migrate/{TASK_ID}", stream)
        self.assertIn("/dbs/dev/api", stream)

    # TC-68-03
    def test_missing_exit_code_is_red_and_reads_the_migrate_container(self):
        e = self.make(describe_tasks=[stopped(None, "CannotPullContainerError")])
        p = self.run_script(e)
        self.assertEqual(p.returncode, 1)
        self.assertIn("CannotPullContainerError", p.stdout + p.stderr)

    def test_exit_code_is_read_from_the_container_named_migrate(self):
        sidecar = {"name": "sidecar", "exitCode": 1}
        e = self.make(describe_tasks=[stopped(0, extra_containers=[sidecar])])
        self.assertEqual(self.run_script(e).returncode, 0)
        e = self.make(describe_tasks=[stopped(2, extra_containers=[{"name": "sidecar", "exitCode": 0}])])
        self.assertEqual(self.run_script(e).returncode, 1)

    # TC-68-04
    def test_run_task_failures_is_red_without_polling(self):
        e = self.make(run_task={"tasks": [], "failures": [{"reason": "RESOURCE:FARGATE", "detail": "no capacity"}]})
        p = self.run_script(e)
        self.assertEqual(p.returncode, 1)
        self.assertIn("RESOURCE:FARGATE", p.stdout + p.stderr)
        self.assertNotIn("ecs describe-tasks", e.ops())

    def test_describe_tasks_failures_stop_after_three_times(self):
        e = self.make(describe_tasks=[{"tasks": [], "failures": [{"arn": TASK_ARN, "reason": "MISSING"}]}])
        p = self.run_script(e)
        self.assertEqual(p.returncode, 1)
        self.assertEqual(e.ops().count("ecs describe-tasks"), 3)
        self.assertIn("MISSING", p.stdout + p.stderr)
        self.assertIn("ecs stop-task", e.ops())

    def test_transient_describe_error_recovers(self):
        e = self.make(error={"op": "ecs describe-tasks", "code": "ThrottlingException", "times": 1})
        p = self.run_script(e)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)

    def test_three_describe_errors_in_a_row_are_red(self):
        e = self.make(error={"op": "ecs describe-tasks", "code": "ThrottlingException", "times": 3})
        self.assertEqual(self.run_script(e).returncode, 1)

    # TC-68-05
    def test_deadline_stops_the_task_and_is_red_with_timeout_message(self):
        e = self.make(describe_tasks=[running("PENDING"), running(), stopped(137, "Stopped by migrate.sh")])
        p = self.run_script(e, MIGRATE_DEADLINE_SECONDS="0", MIGRATE_STOP_WAIT_SECONDS="30")
        self.assertEqual(p.returncode, 1)
        self.assertIn("ecs stop-task", e.ops())
        self.assertIn("quá hạn", p.stdout + p.stderr)
        self.assertNotIn("thất bại", p.stdout + p.stderr)

    def test_stop_task_error_does_not_hide_a_successful_exit(self):
        e = self.make(describe_tasks=[running(), stopped(0)],
                      error={"op": "ecs stop-task", "code": "InvalidParameterException", "message": "task already stopped"})
        p = self.run_script(e, MIGRATE_DEADLINE_SECONDS="0", MIGRATE_STOP_WAIT_SECONDS="30")
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)

    def test_task_that_never_stops_after_stop_task_is_red(self):
        e = self.make(describe_tasks=[running()])
        p = self.run_script(e, MIGRATE_DEADLINE_SECONDS="0", MIGRATE_STOP_WAIT_SECONDS="0")
        self.assertEqual(p.returncode, 1)
        self.assertIn("chưa dừng", p.stdout + p.stderr)

    # TC-68-06
    def test_family_missing_points_to_terraform_apply(self):
        e = self.make(error={"op": "ecs describe-task-definition", "code": "ClientException", "arg": "dbs-migrate",
                             "message": "Unable to describe task definition."})
        p = self.run_script(e)
        self.assertEqual(p.returncode, 1)
        self.assertIn("terraform apply", p.stdout + p.stderr)
        self.assertNotIn("ecs run-task", e.ops())

    def test_access_denied_is_passed_through_not_called_missing(self):
        e = self.make(error={"op": "ecs describe-task-definition", "code": "AccessDeniedException", "arg": "dbs-migrate",
                             "message": "not authorized to perform ecs:DescribeTaskDefinition"})
        p = self.run_script(e)
        self.assertEqual(p.returncode, 1)
        self.assertIn("AccessDeniedException", p.stdout + p.stderr)
        self.assertNotIn("terraform apply", p.stdout + p.stderr)

    def test_running_migration_blocks_a_second_run(self):
        e = self.make(running_migrations=[TASK_ARN])
        p = self.run_script(e)
        self.assertEqual(p.returncode, 1)
        self.assertIn(TASK_ID, p.stdout + p.stderr)
        self.assertNotIn("ecs run-task", e.ops())

    # TC-68-07
    def test_run_twice_second_time_does_not_register_again(self):
        e = self.make()
        self.assertEqual(self.run_script(e).returncode, 0)
        e2 = self.make(migrate_task_definition_response=migrate_td(f"{REPO}:{NEW}"))
        p = self.run_script(e2)
        self.assertEqual(p.returncode, 0, p.stdout + p.stderr)
        self.assertNotIn("ecs register-task-definition", e2.ops())
        self.assertIn("ecs run-task", e2.ops())
        self.assertIn(M_OLD, self.call(e2, "ecs run-task")["argv"])

    # TC-68-09
    def test_bad_tags_rejected_before_aws(self):
        for bad in ("", "latest", "abc123", "G" * 40):
            e = self.make()
            self.assertNotEqual(self.run_script(e, tag=bad).returncode, 0)
            self.assertEqual(e.calls(), [])

    # TC-68-16
    def test_hostile_log_lines_cannot_become_workflow_commands(self):
        long_line = "x" * 5000
        e = self.make(describe_tasks=[stopped(1)],
                      log_events=["::set-output name=a::b", "::error::fake", "::stop-commands::x", long_line, "bình thường"])
        p = self.run_script(e)
        self.assertEqual(p.returncode, 1)
        lines = p.stdout.splitlines()
        start = next(i for i, l in enumerate(lines) if l.startswith("::stop-commands::"))
        token = lines[start].split("::")[2]
        end = lines.index(f"::{token}::")
        self.assertGreater(len(token), 16)
        inside = lines[start + 1:end]
        self.assertIn("::set-output name=a::b", inside)  # nằm trong vùng đã vô hiệu lệnh
        self.assertTrue(all(len(l) <= 2000 for l in inside))
        self.assertEqual(lines[start - 1].split("::")[1], "group")
        self.assertEqual(lines[end + 1], "::endgroup::")
        self.assertFalse(any(l.startswith("::") for l in lines[:start] if "set-output" in l or "fake" in l))

    def test_db_host_is_masked_before_any_task_output(self):
        e = self.make(describe_tasks=[stopped(1)], log_events=[f"connect ECONNREFUSED {DB_HOST}:5432"])
        p = self.run_script(e)
        lines = p.stdout.splitlines()
        self.assertIn(f"::add-mask::{DB_HOST}", lines)
        self.assertLess(lines.index(f"::add-mask::{DB_HOST}"), next(i for i, l in enumerate(lines) if "ECONNREFUSED" in l))

    def test_missing_log_stream_is_not_a_second_failure(self):
        e = self.make(describe_tasks=[stopped(1)], log_stream_missing=True)
        p = self.run_script(e)
        self.assertEqual(p.returncode, 1)
        self.assertIn("không đọc được log", p.stdout)


if __name__ == "__main__":
    unittest.main(verbosity=2)
