#!/usr/bin/env python3
"""Test của infra/scripts/pgss.sh và pgss_delta.py (BL-420, TC-420-01..) bằng `aws` giả; chỉ dùng thư viện chuẩn.

Chạy: python3 infra/scripts/tests/test_pgss.py   (Linux: PATH tách bằng `:`, cần bash và python3)

`aws` giả đọc kịch bản từ $FAKE_STATE/scenario.json và ghi mỗi lời gọi (argv và nội dung các file `file://` tại
thời điểm gọi) vào calls.jsonl.
"""
import base64
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE.parent / "pgss.sh"
RUNNER = HERE.parent / "pgss-runner.js"
DELTA = HERE.parent / "pgss_delta.py"

REGION = "ap-southeast-1"
TASK_ID = "0123456789abcdef0123456789abcdef"
TASK_ARN = f"arn:aws:ecs:{REGION}:123456789012:task/dbs-dev/{TASK_ID}"

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
if key == "ecs describe-services":
    print(json.dumps(scen["describe_services"]))
elif key == "ecs describe-task-definition":
    print(json.dumps(scen["task_definition_response"]))
elif key == "ecs run-task":
    print(json.dumps(scen["run_task"]))
elif key == "ecs describe-tasks":
    print(json.dumps(scen["describe_tasks"]))
elif key == "ecs stop-task":
    print(json.dumps({"task": {}}))
elif key == "logs get-log-events":
    print(json.dumps({"events": [{"message": m} for m in scen["log_lines"]]}))
else:
    sys.stderr.write(f"fake aws: unexpected call {key}\n")
    sys.exit(2)
'''

SERVICES = {
    "services": [
        {
            "networkConfiguration": {
                "awsvpcConfiguration": {
                    "subnets": ["subnet-a", "subnet-b"],
                    "securityGroups": ["sg-1"],
                    "assignPublicIp": "DISABLED",
                }
            }
        }
    ]
}
TASK_DEFINITION = {
    "taskDefinition": {
        "taskDefinitionArn": f"arn:aws:ecs:{REGION}:123456789012:task-definition/dbs-db-roles:3",
        "containerDefinitions": [
            {
                "name": "db-roles",
                "image": f"123456789012.dkr.ecr.{REGION}.amazonaws.com/dbs-api:{'a' * 40}",
                "logConfiguration": {
                    "options": {"awslogs-group": "/dbs/dev/api", "awslogs-stream-prefix": "db-roles"}
                },
            }
        ],
    }
}
ONE_QUERY_LOG = ["SQL> SELECT 1\n", '[{"x":1}]\n']
SNAPSHOT_LOG = ["SQL> SELECT now() AS at ...\n", '[{"at":"2026-11-22T00:00:00Z","calls":"3"}]\n']
ENABLE_LOG = [
    "SQL> CREATE EXTENSION IF NOT EXISTS pg_stat_statements\n",
    "[]\n",
    "SQL> SELECT extname FROM pg_extension WHERE ...\n",
    '[{"extname":"pg_stat_statements"}]\n',
]


def scenario(exit_code=0, lines=None, run_failure=False, status="STOPPED", no_task=False):
    tasks = (
        []
        if no_task
        else [
            {
                "lastStatus": status,
                "stoppedReason": "Essential container in task exited",
                "containers": [{"name": "db-roles", "exitCode": exit_code}],
            }
        ]
    )
    return {
        "describe_services": SERVICES,
        "task_definition_response": TASK_DEFINITION,
        "run_task": {"tasks": [], "failures": [{"reason": "RESOURCE:CPU"}]}
        if run_failure
        else {"tasks": [{"taskArn": TASK_ARN}], "failures": []},
        "describe_tasks": {"tasks": tasks},
        "log_lines": lines if lines is not None else ONE_QUERY_LOG,
    }


def row(queryid, calls, total_ms, hit, query="SELECT 1", role="dbs_api"):
    return {
        "at": "2026-11-22T00:00:00Z",
        "role": role,
        "queryid": str(queryid),
        "calls": str(calls),
        "total_ms": str(total_ms),
        "mean_ms": "0",
        "sd_ms": "0",
        "rows": "1",
        "hit": str(hit),
        "rd": "0",
        "q": query,
    }


class PgssScript(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        self.state = root / "state"
        self.state.mkdir()
        self.bin = root / "bin"
        self.bin.mkdir()
        aws = self.bin / "aws"
        aws.write_text(FAKE_AWS)
        aws.chmod(0o755)
        self.out = root / "snapshot.txt"

    def tearDown(self):
        self.tmp.cleanup()

    def run_script(self, *args, scen=None, **extra_env):
        (self.state / "scenario.json").write_text(json.dumps(scen or scenario()))
        env = {
            **os.environ,
            "PATH": f"{self.bin}{os.pathsep}{os.environ['PATH']}",
            "FAKE_STATE": str(self.state),
            "POLL_SECONDS": "0",
            "RETRY_SECONDS": "0",
            **extra_env,
        }
        return subprocess.run(["bash", str(SCRIPT), *args], env=env, capture_output=True, text=True, timeout=60)

    def calls(self):
        path = self.state / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def count(self, service, op):
        return sum(1 for c in self.calls() if c["argv"][:2] == [service, op])

    def run_task_call(self):
        return next(c for c in self.calls() if c["argv"][:2] == ["ecs", "run-task"])

    def queries_sent(self):
        """The SQL the script handed to the one-off task: Q64 of the overridden container."""
        overrides = next(v for k, v in self.run_task_call()["files"].items() if k == "--overrides")
        container = overrides["containerOverrides"][0]
        env = {e["name"]: e["value"] for e in container["environment"]}
        return json.loads(base64.b64decode(env["Q64"])), container

    def test_enable_creates_the_extension_and_neither_resets_nor_grants(self):
        """TC-420-01 enable: CREATE EXTENSION and the check; no reset (would drop a running delta), no GRANT to dbs_api."""
        r = self.run_script("enable", scen=scenario(lines=ENABLE_LOG))
        self.assertEqual(r.returncode, 0, r.stderr)
        queries, container = self.queries_sent()
        joined = "\n".join(queries)
        self.assertIn("CREATE EXTENSION IF NOT EXISTS pg_stat_statements", joined)
        self.assertNotIn("pg_stat_statements_reset", joined)
        self.assertNotIn("GRANT", joined.upper())  # the application role must not read the text of every role's queries
        run = self.run_task_call()["argv"]
        self.assertIn("dbs-db-roles", " ".join(run))  # the task definition of the master credential
        self.assertEqual(container["name"], "db-roles")
        # only the command and the (non-secret) SQL travel in the override; the secrets stay in the task definition
        self.assertEqual(set(container), {"name", "command", "environment"})
        self.assertEqual([e["name"] for e in container["environment"]], ["Q64"])
        self.assertNotIn("PASSWORD", json.dumps(container).upper())

    def test_reset_sends_only_the_reset(self):
        """TC-420-02 reset is its own command."""
        r = self.run_script("reset", scen=scenario(lines=ONE_QUERY_LOG))
        self.assertEqual(r.returncode, 0, r.stderr)
        queries, _ = self.queries_sent()
        self.assertEqual(len(queries), 1)
        self.assertIn("pg_stat_statements_reset()", queries[0])

    def test_snapshot_asks_for_the_top_statements_and_writes_the_task_output(self):
        """TC-420-03 snapshot: one bounded query on pg_stat_statements by total time; the file is what the task printed."""
        r = self.run_script("snapshot", str(self.out), scen=scenario(lines=SNAPSHOT_LOG))
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(self.out.read_text(), "".join(SNAPSHOT_LOG))
        queries, _ = self.queries_sent()
        self.assertEqual(len(queries), 1)
        self.assertIn("FROM pg_stat_statements", queries[0])
        self.assertIn("ORDER BY total_exec_time DESC LIMIT 25", queries[0])
        self.assertIn("left(translate(query, chr(10), ' '), 120)", queries[0])  # keeps the JSON line well under 16 KB
        self.assertNotIn("pg_stat_statements_reset", queries[0])  # reading never resets the counters

    def test_logs_are_read_from_the_stream_of_that_task(self):
        """TC-420-04 the log stream is <prefix>/<container>/<task id> of the task definition's log group."""
        self.run_script("reset")
        log_call = next(c for c in self.calls() if c["argv"][:2] == ["logs", "get-log-events"])
        argv = log_call["argv"]
        self.assertEqual(argv[argv.index("--log-group-name") + 1], "/dbs/dev/api")
        self.assertEqual(argv[argv.index("--log-stream-name") + 1], f"db-roles/db-roles/{TASK_ID}")

    def test_a_failed_task_fails_the_script_says_why_and_leaves_no_snapshot_file(self):
        """TC-420-05 exit code of the container is the exit code of the script; a half file would look like data."""
        r = self.run_script("snapshot", str(self.out), scen=scenario(exit_code=1))
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(self.out.exists())
        self.assertIn("Essential container in task exited", r.stderr)

    def test_a_log_that_is_not_complete_yet_is_read_again_then_refused(self):
        """TC-420-06 CloudWatch Logs is eventually consistent: an empty or short log is retried, never written as a snapshot."""
        r = self.run_script("snapshot", str(self.out), scen=scenario(lines=[]), LOG_RETRIES="3")
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(self.out.exists())
        self.assertIn("chưa đủ", r.stderr)
        self.assertEqual(self.count("logs", "get-log-events"), 3)
        (self.state / "calls.jsonl").unlink()
        r = self.run_script(
            "snapshot", str(self.out), scen=scenario(lines=["SQL> SELECT now() AS at ...\n"]), LOG_RETRIES="2"
        )  # the statement was logged but its rows have not arrived yet
        self.assertNotEqual(r.returncode, 0)
        self.assertFalse(self.out.exists())
        self.assertEqual(self.count("logs", "get-log-events"), 2)

    def test_an_sql_error_in_the_task_output_is_not_retried_and_not_written(self):
        """TC-420-07 SQLERR means the statement failed; reading again cannot fix it."""
        lines = ["SQL> CREATE EXTENSION x\n", "SQLERR> permission denied\n"]
        r = self.run_script("enable", scen=scenario(lines=lines), LOG_RETRIES="4")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.count("logs", "get-log-events"), 1)

    def test_a_task_that_does_not_stop_in_time_is_stopped(self):
        """TC-420-08 the task holds the master credential: past the deadline the script stops it."""
        r = self.run_script("reset", scen=scenario(status="RUNNING"), PGSS_DEADLINE_SECONDS="0")
        self.assertNotEqual(r.returncode, 0)
        self.assertEqual(self.count("ecs", "stop-task"), 1)

    def test_a_task_that_describe_tasks_cannot_find_is_an_error_not_a_traceback(self):
        """TC-420-09"""
        r = self.run_script("reset", scen=scenario(no_task=True))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("không thấy task", r.stderr)
        self.assertNotIn("Traceback", r.stderr)

    def test_run_task_without_a_task_is_an_error_with_the_reason(self):
        """TC-420-10 no capacity: the script says why and exits non-zero."""
        r = self.run_script("enable", scen=scenario(run_failure=True))
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("RESOURCE:CPU", r.stderr)

    def test_usage_errors_do_not_call_aws(self):
        """TC-420-11 unknown command, and snapshot without an output file."""
        for args in ([], ["frobnicate"], ["snapshot"], ["enable", "x"]):
            r = self.run_script(*args)
            self.assertEqual(r.returncode, 2, args)
            self.assertIn("Usage", r.stderr)
        self.assertEqual(self.calls(), [])

    def test_the_runner_has_no_secret_and_reads_the_task_environment(self):
        """TC-420-12 pgss-runner.js uses the DB_* variables the task definition injects and verifies TLS."""
        source = RUNNER.read_text()
        for name in ("DB_HOST", "DB_NAME", "DB_USER", "DB_PASSWORD", "DATABASE_SSL_CA_PATH", "Q64"):
            self.assertIn(f"process.env.{name}", source)
        self.assertIn("rejectUnauthorized: true", source)
        self.assertNotRegex(source, r"console\.log\([^)]*DB_PASSWORD")


class PgssDelta(unittest.TestCase):
    def delta(self, first, second):
        with tempfile.TemporaryDirectory() as tmp:
            paths = []
            for name, text in (("a.txt", first), ("b.txt", second)):
                path = pathlib.Path(tmp) / name
                path.write_text(text)
                paths.append(str(path))
            return subprocess.run(
                [sys.executable, str(DELTA), *paths], capture_output=True, text=True, timeout=30
            )

    def test_reads_the_file_pgss_sh_writes_and_subtracts_the_counters(self):
        """TC-420-13 `SQL> …` then one JSON line (what the script writes): calls, time and buffers in the interval."""
        a = ["SQL> SELECT ...\n", json.dumps([row(1, 100, 1000.0, 5000), row(2, 10, 5.0, 10)]) + "\n"]
        b = [
            "SQL> SELECT ...\n",
            json.dumps([row(1, 300, 3000.0, 11000), row(2, 10, 5.0, 10), row(3, 4, 40.0, 40, "SELECT 3")]) + "\n",
        ]
        r = self.delta("".join(a), "".join(b))
        self.assertEqual(r.returncode, 0, r.stderr)
        lines = r.stdout.splitlines()
        # query 1: +200 calls, +2000 ms (2.0 s, mean 10.00 ms), +6000 buffers (30.0 per call); query 3 is new; query 2 had no calls
        self.assertEqual(len(lines), 3)  # header, query 1, query 3
        self.assertEqual(lines[1].split()[:5], ["dbs_api", "200", "2.0", "10.00", "30.0"])
        self.assertTrue(any("SELECT 3" in line for line in lines))

    def test_still_reads_the_tab_separated_file_of_the_older_sessions(self):
        """TC-420-14 DBS-166/173 files: `aws ... --output text`, the JSON after a tab."""
        old = "[task x]\n0\tNone\nSQL> SELECT ...\t" + json.dumps([row(1, 100, 1000.0, 5000)]) + "\tSQL> next\t[]\n"
        new = "[task y]\n0\tNone\nSQL> SELECT ...\t" + json.dumps([row(1, 150, 1500.0, 7500)]) + "\tSQL> next\t[]\n"
        r = self.delta(old, new)
        self.assertEqual(r.returncode, 0, r.stderr)
        self.assertEqual(r.stdout.splitlines()[1].split()[:3], ["dbs_api", "50", "0.5"])

    def test_a_file_without_rows_is_an_error(self):
        """TC-420-15"""
        r = self.delta("nothing here\n", "nothing here\n")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("no pg_stat_statements rows", r.stderr)


if __name__ == "__main__":
    unittest.main()
