#!/usr/bin/env python3
"""Test của công cụ AC-5.10 (DBS-185, TC-185-03 và TC-185-06); chỉ dùng thư viện chuẩn.

Chạy: python3 infra/scripts/tests/test_ac_5_10.py

Không cần PostgreSQL hay AWS: phần chạy thật của ac-5-10-db.js (TC-185-01, 02) kiểm tay trên PostgreSQL 17 local
và ghi ở docs/features/screenshots/DBS-185/manual-test.txt.
"""
import copy
import json
import pathlib
import re
import shutil
import subprocess
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPTS = HERE.parent
DB_JS = SCRIPTS / "ac-5-10-db.js"
TOOLS = SCRIPTS / "ac-5-10-tools.py"
KILL_SH = SCRIPTS / "ac-5-10-kill.sh"

LIMIT = 8192  # ECS: phần ghi đè của run-task tối đa 8 192 ký tự


def run_tools(*args, stdin=None):
    return subprocess.run(
        [sys.executable, str(TOOLS), *args], input=stdin, capture_output=True, text=True, check=False
    )


def sample_taskdef():
    """Hình dạng đúng của `aws ecs describe-task-definition` (đủ trường chỉ-đọc)."""
    return {
        "taskDefinition": {
            "taskDefinitionArn": "arn:aws:ecs:ap-southeast-1:123456789012:task-definition/dbs-api:7",
            "family": "dbs-api",
            "revision": 7,
            "status": "ACTIVE",
            "registeredAt": "2026-11-15T01:00:00+00:00",
            "registeredBy": "arn:aws:iam::123456789012:user/dev1",
            "compatibilities": ["EC2", "FARGATE"],
            "requiresAttributes": [{"name": "com.amazonaws.ecs.capability.docker-remote-api.1.18"}],
            "taskRoleArn": "arn:aws:iam::123456789012:role/dbs-dev-task",
            "executionRoleArn": "arn:aws:iam::123456789012:role/dbs-dev-execution",
            "networkMode": "awsvpc",
            "requiresCompatibilities": ["FARGATE"],
            "cpu": "512",
            "memory": "1024",
            "runtimePlatform": {"operatingSystemFamily": "LINUX", "cpuArchitecture": "X86_64"},
            "volumes": [],
            "placementConstraints": [],
            "containerDefinitions": [
                {
                    "name": "api",
                    "image": "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/dbs-api:" + "a" * 40,
                    "essential": True,
                    "portMappings": [{"containerPort": 3000, "protocol": "tcp"}],
                    "environment": [
                        {"name": "NODE_ENV", "value": "staging"},
                        {"name": "DATABASE_LOCK_TIMEOUT_MS", "value": "2000"},
                    ],
                    "secrets": [{"name": "DB_USER", "valueFrom": "arn:aws:secretsmanager:x:y:secret:z:username::"}],
                    "mountPoints": [],
                    "volumesFrom": [],
                    "systemControls": [],
                }
            ],
        },
        "tags": [{"key": "project", "value": "dbs"}],
    }


class TaskdefTest(unittest.TestCase):
    """TC-185-06."""

    def convert(self, src=None, extra=()):
        src = src or sample_taskdef()
        res = run_tools(
            "taskdef", "--container", "api", "--env", "DATABASE_LOCK_TIMEOUT_MS=30000",
            "--env", "DATABASE_STATEMENT_TIMEOUT_MS=60000", "--stop-timeout", "2", *extra,
            stdin=json.dumps(src),
        )
        self.assertEqual(res.returncode, 0, res.stderr)
        return json.loads(res.stdout)

    def test_read_only_fields_removed(self):
        out = self.convert()
        for key in ("taskDefinitionArn", "revision", "status", "requiresAttributes", "compatibilities",
                    "registeredAt", "registeredBy", "deregisteredAt"):
            self.assertNotIn(key, out)

    def test_only_two_env_and_stop_timeout_differ(self):
        src = sample_taskdef()
        out = self.convert(src)
        before = copy.deepcopy(src["taskDefinition"])
        # cùng mọi trường còn lại
        for key in ("family", "taskRoleArn", "executionRoleArn", "networkMode", "requiresCompatibilities", "cpu",
                    "memory", "runtimePlatform", "volumes", "placementConstraints"):
            self.assertEqual(out[key], before[key], key)
        c_in, c_out = before["containerDefinitions"][0], out["containerDefinitions"][0]
        env_in = {e["name"]: e["value"] for e in c_in["environment"]}
        env_out = {e["name"]: e["value"] for e in c_out["environment"]}
        self.assertEqual(env_out["DATABASE_LOCK_TIMEOUT_MS"], "30000")
        self.assertEqual(env_out["DATABASE_STATEMENT_TIMEOUT_MS"], "60000")
        self.assertEqual(env_out["NODE_ENV"], env_in["NODE_ENV"])
        self.assertEqual(set(env_out) - set(env_in), {"DATABASE_STATEMENT_TIMEOUT_MS"})
        self.assertEqual(c_out["stopTimeout"], 2)
        for key in c_in:
            if key not in ("environment",):
                self.assertEqual(c_out[key], c_in[key], key)
        # đầu vào không bị sửa
        self.assertEqual(src["taskDefinition"], before)

    def test_tags_are_not_carried_into_register_input(self):
        out = self.convert()
        self.assertNotIn("tags", out)

    def test_other_container_untouched(self):
        src = sample_taskdef()
        other = copy.deepcopy(src["taskDefinition"]["containerDefinitions"][0])
        other["name"] = "sidecar"
        src["taskDefinition"]["containerDefinitions"].append(other)
        out = self.convert(src)
        self.assertEqual(out["containerDefinitions"][1], other)

    def test_unknown_container_is_an_error(self):
        res = run_tools("taskdef", "--container", "nope", "--stop-timeout", "2", stdin=json.dumps(sample_taskdef()))
        self.assertNotEqual(res.returncode, 0)
        self.assertIn("nope", res.stderr)

    def test_stop_timeout_range(self):
        res = run_tools("taskdef", "--container", "api", "--stop-timeout", "1", stdin=json.dumps(sample_taskdef()))
        self.assertNotEqual(res.returncode, 0)


class OverridesTest(unittest.TestCase):
    """TC-185-03 (kích thước, JSON hợp lệ)."""

    def test_overrides_json_valid_and_small(self):
        for mode in ("hold", "probe"):
            res = run_tools("overrides", "--mode", mode, "--env", "ACCOUNT_ID=0b8a3c1e-0000-4000-8000-000000000001",
                            "--env", "HOLD_SECONDS=60")
            self.assertEqual(res.returncode, 0, res.stderr)
            data = json.loads(res.stdout)
            self.assertLessEqual(len(res.stdout.strip()), LIMIT)
            (co,) = data["containerOverrides"]
            self.assertEqual(co["name"], "migrate")
            self.assertEqual(co["command"][:2], ["node", "-e"])
            env = {e["name"]: e["value"] for e in co["environment"]}
            self.assertEqual(env["MODE"], mode)
            self.assertEqual(env["HOLD_SECONDS"], "60")

    def test_command_override_for_invariants(self):
        res = run_tools("overrides", "--command", "node", "dist/scripts/invariants/invariants.js")
        self.assertEqual(res.returncode, 0, res.stderr)
        co = json.loads(res.stdout)["containerOverrides"][0]
        self.assertEqual(co["command"], ["node", "dist/scripts/invariants/invariants.js"])

    def test_too_large_is_refused(self):
        res = run_tools("overrides", "--mode", "hold", "--env", "X=" + "a" * 9000)
        self.assertNotEqual(res.returncode, 0)


def hold_log(waiter_from=3, locks="accounts:RowShareLock,idempotency_keys:RowExclusiveLock", release=True, samples=30, waiter_until=None):
    """Nhật ký giả của `hold`: LOCKED lúc t=0, mẫu mỗi 2 s; waiter xuất hiện từ mẫu `waiter_from`."""
    lines = [{"t": "2026-11-15T01:00:00.000Z", "event": "LOCKED", "holderXid": "761", "holderPid": 192}]
    for i in range(samples):
        sec = 2 * (i + 1)
        present = i >= waiter_from and (waiter_until is None or i < waiter_until)
        lines.append({"t": "2026-11-15T01:%02d:%02d.000Z" % (sec // 60, sec % 60), "event": "sample",
                      "waiters": [{"pid": 4242, "locks": locks}] if present else []})
    if release:
        lines.append({"t": "2026-11-15T01:01:00.500Z", "event": "RELEASED"})
    return "\n".join(json.dumps(x) for x in lines) + "\n"


def task_json(exit_code=137, exec_stopped="2026-11-15T01:00:16.000Z"):
    return json.dumps({"stoppingAt": "2026-11-15T01:00:12.000Z", "executionStoppedAt": exec_stopped,
                       "stoppedAt": "2026-11-15T01:00:40.000Z", "stopCode": "UserInitiated",
                       "containers": [{"name": "api", "exitCode": exit_code}]})


class EvaluateTest(unittest.TestCase):
    """Điều kiện «Lần chạy hợp lệ» của §2 (domain review vòng 2, 3)."""

    def evaluate(self, hold, task, code="502", corr="no", tmp=None):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            h, t = pathlib.Path(d, "hold.jsonl"), pathlib.Path(d, "task.json")
            h.write_text(hold, encoding="utf-8")
            t.write_text(task, encoding="utf-8")
            res = run_tools("evaluate", "--hold-log", str(h), "--task-json", str(t), "--container", "api",
                            "--client-code", code, "--client-has-correlation", corr)
        return res, json.loads(res.stdout)

    def test_valid_run(self):
        res, out = self.evaluate(hold_log(waiter_from=3, waiter_until=15), task_json())
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertTrue(out["valid"], out)
        self.assertEqual(out["reasons"], [])
        self.assertEqual(out["waiterPid"], 4242)

    def test_dropped_connection_is_valid_too(self):
        res, out = self.evaluate(hold_log(waiter_from=3, waiter_until=15), task_json(), code="000")
        self.assertEqual(res.returncode, 0, out)

    def test_app_503_is_invalid(self):
        res, out = self.evaluate(hold_log(waiter_from=3, waiter_until=15), task_json(), code="503", corr="yes")
        self.assertEqual(res.returncode, 3)
        self.assertIn("CLIENT_CODE", out["reasons"])
        self.assertIn("CLIENT_HAS_CORRELATION", out["reasons"])

    def test_graceful_exit_is_invalid(self):
        res, out = self.evaluate(hold_log(waiter_from=3, waiter_until=15), task_json(exit_code=143))
        self.assertEqual(res.returncode, 3)
        self.assertIn("EXIT_NOT_137", out["reasons"])

    def test_no_waiter_is_invalid(self):
        res, out = self.evaluate(hold_log(waiter_from=99), task_json())
        self.assertEqual(res.returncode, 3)
        self.assertIn("NO_WAITER", out["reasons"])

    def test_claimkey_lock_required(self):
        res, out = self.evaluate(hold_log(waiter_from=3, waiter_until=15, locks="accounts:RowShareLock"), task_json())
        self.assertIn("NO_CLAIMKEY_LOCK", out["reasons"])

    def test_late_waiter_is_invalid(self):
        # mẫu thứ 12 = LOCKED + 26 s
        res, out = self.evaluate(hold_log(waiter_from=12, waiter_until=24), task_json(exec_stopped="2026-11-15T01:00:40.000Z"))
        self.assertIn("W1_TOO_LATE", out["reasons"])

    def test_kill_after_lock_timeout_window_is_invalid(self):
        # waiter từ mẫu 3 (S0 = LOCKED + 6 s); kill lúc LOCKED + 40 s >= S0 + 25
        res, out = self.evaluate(hold_log(waiter_from=3, waiter_until=15), task_json(exec_stopped="2026-11-15T01:00:40.000Z"))
        self.assertIn("KILL_TOO_LATE", out["reasons"])

    def test_orphan_still_waiting_at_last_sample_is_invalid(self):
        res, out = self.evaluate(hold_log(waiter_from=3, waiter_until=None), task_json())
        self.assertIn("ORPHAN_STILL_WAITING", out["reasons"])

    def test_missing_release_is_invalid(self):
        res, out = self.evaluate(hold_log(waiter_from=3, waiter_until=15, release=False), task_json())
        self.assertIn("NO_RELEASED", out["reasons"])

    def test_epoch_timestamps_from_cli_v1(self):
        # AWS CLI v1 in số giây epoch
        task = json.dumps({"stoppingAt": 1794704412.0, "executionStoppedAt": 1794704416.5, "stoppedAt": 1794704440.0,
                           "containers": [{"name": "api", "exitCode": 137}]})
        hold = hold_log(waiter_from=3, waiter_until=15).replace("2026-11-15T01:00", "2026-11-15T01:00")
        # LOCKED = 2026-11-15T01:00:00Z = 1794704400
        res, out = self.evaluate(hold, task)
        self.assertEqual(res.returncode, 0, out)


class DbScriptStaticTest(unittest.TestCase):
    """TC-185-03: ac-5-10-db.js chỉ đọc và khóa, không ghi, không in mật khẩu."""

    @classmethod
    def setUpClass(cls):
        cls.src = DB_JS.read_text(encoding="utf-8")

    def sql_strings(self):
        # mọi chuỗi trong dấu nháy đơn, nháy kép hoặc backtick trông giống câu lệnh SQL
        found = re.findall(r"""(['"`])((?:\\.|(?!\1).)*?)\1""", self.src, flags=re.S)
        return [s for _, s in found if re.match(r"\s*(SELECT|BEGIN|ROLLBACK|WITH|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|SET|COPY|LOCK)\b", s, flags=re.I)]

    def test_only_select_begin_rollback(self):
        statements = self.sql_strings()
        self.assertGreaterEqual(len(statements), 4)
        for s in statements:
            head = re.match(r"\s*(\w+)", s).group(1).upper()
            self.assertIn(head, {"SELECT", "BEGIN", "ROLLBACK", "WITH"}, s)
        forbidden = re.compile(r"\b(INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|REVOKE|COPY|LOCK)\b", re.I)
        for s in statements:
            self.assertIsNone(forbidden.search(re.sub(r"FOR\s+UPDATE", "", s, flags=re.I)), s)

    def test_rollback_in_finally(self):
        self.assertRegex(self.src, r"finally\s*\{[^}]*ROLLBACK")

    def test_no_read_only_transaction(self):
        # PostgreSQL từ chối SELECT FOR UPDATE trong transaction READ ONLY (domain review vòng 2)
        hold = self.src[self.src.index("async function hold"):self.src.index("async function probe")]
        self.assertNotRegex(hold, r"READ\s+ONLY")

    def test_password_never_logged(self):
        code = "\n".join(ln for ln in self.src.splitlines() if not ln.lstrip().startswith("//"))
        self.assertEqual(len(re.findall(r"DB_PASSWORD", code)), 1)
        for m in re.finditer(r"(console\.log|log)\(([^;]*)\)", code):
            self.assertNotRegex(m.group(2), r"password|DATABASE_URL|env\b", m.group(0))

    def test_size_for_inline(self):
        self.assertLessEqual(len(self.src.encode("utf-8")), 9000)


class KillScriptTest(unittest.TestCase):
    """TC-185-03: cú pháp bash và từ chối khi thiếu biến môi trường mà không in bí mật."""

    def test_syntax(self):
        bash = shutil.which("bash")
        if not bash:
            self.skipTest("không có bash")
        res = subprocess.run([bash, "-n", str(KILL_SH)], capture_output=True, text=True, check=False)
        self.assertEqual(res.returncode, 0, res.stderr)

    def test_missing_env_is_refused(self):
        bash = shutil.which("bash")
        if not bash:
            self.skipTest("không có bash")
        res = subprocess.run(
            [bash, str(KILL_SH), "kill"], capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
            env={"PATH": "/usr/bin:/bin", "CUST_TOKEN": "eyJ-not-a-real-token"},
        )
        self.assertNotEqual(res.returncode, 0)
        self.assertNotIn("eyJ-not-a-real-token", res.stdout + res.stderr)

    def test_never_echoes_tokens(self):
        src = "\n".join(ln for ln in KILL_SH.read_text(encoding="utf-8").splitlines() if not ln.lstrip().startswith("#"))
        self.assertIsNone(re.search(r"\bset\s+-[a-z]*x", src), "set -x")
        self.assertIsNone(re.search(r"curl[^\n]*\s-v\b", src), "curl -v")
        for var in ("CUST_TOKEN", "AUD_TOKEN"):
            for line in src.splitlines():
                if re.search(r"\b(echo|printf)\b", line):
                    self.assertNotRegex(line, r"\$\{?%s\b(?!:\+|:-|\})" % var, line)


if __name__ == "__main__":
    unittest.main(verbosity=2)
