#!/usr/bin/env python3
"""Test của công cụ AC-5.10 (DBS-185, TC-185-03 và TC-185-06); chỉ dùng thư viện chuẩn.

Chạy: python3 infra/scripts/tests/test_ac_5_10.py

Không cần PostgreSQL hay AWS: phần chạy thật của ac-5-10-db.js (TC-185-01, 02) kiểm tay trên PostgreSQL 17 local
và ghi ở docs/features/screenshots/DBS-185/manual-test.txt.
"""
import copy
import datetime
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
        for mode in ("slow-on", "slow-off", "watch", "probe"):
            res = run_tools("overrides", "--mode", mode, "--env", "ACCOUNT_ID=0b8a3c1e-0000-4000-8000-000000000001",
                            "--env", "SLEEP_SECONDS=110")
            self.assertEqual(res.returncode, 0, res.stderr)
            data = json.loads(res.stdout)
            self.assertLessEqual(len(res.stdout.strip()), LIMIT)
            (co,) = data["containerOverrides"]
            self.assertEqual(co["name"], "migrate")
            self.assertEqual(co["command"][:2], ["node", "-e"])
            env = {e["name"]: e["value"] for e in co["environment"]}
            self.assertEqual(env["MODE"], mode)
            self.assertEqual(env["SLEEP_SECONDS"], "110")

    def test_command_override_for_invariants(self):
        res = run_tools("overrides", "--command", "node", "dist/scripts/invariants/invariants.js")
        self.assertEqual(res.returncode, 0, res.stderr)
        co = json.loads(res.stdout)["containerOverrides"][0]
        self.assertEqual(co["command"], ["node", "dist/scripts/invariants/invariants.js"])

    def test_too_large_is_refused(self):
        res = run_tools("overrides", "--mode", "hold", "--env", "X=" + "a" * 9000)
        self.assertNotEqual(res.returncode, 0)


BASE = 1794704400.0  # 2026-11-15T01:00:00Z
INFLIGHT = "accounts:RowShareLock,idempotency_keys:RowExclusiveLock,ledger_entries:RowExclusiveLock,transfers:RowExclusiveLock"


def iso(offset):
    return datetime.datetime.fromtimestamp(BASE + offset, datetime.timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


STRAY = {"pid": 777, "locks": "idempotency_keys:RowExclusiveLock"}  # ví dụ job dọn dẹp của worker


def watch_log(inflight_from=3, inflight_until=62, locks=INFLIGHT, done=True, samples=85, stray=False):
    """Nhật ký giả của `watch`: READY lúc t=0, mẫu mỗi 2 s; backend giữa transaction từ mẫu `inflight_from`."""
    lines = [{"t": iso(0), "event": "READY"}]
    for i in range(samples):
        present = i >= inflight_from and (inflight_until is None or i < inflight_until)
        inflight = ([{"pid": 4242, "locks": locks}] if present else []) + ([STRAY] if stray else [])
        lines.append({"t": iso(2 * (i + 1)), "event": "sample", "inflight": inflight})
    if done:
        lines.append({"t": iso(2 * samples + 0.5), "event": "DONE"})
    return "\n".join(json.dumps(x) for x in lines) + "\n"


def task_json(exit_code=137, exec_stopped=80):
    return json.dumps({"stoppingAt": iso(12), "executionStoppedAt": iso(exec_stopped), "stoppedAt": iso(exec_stopped + 24),
                       "stopCode": "UserInitiated", "containers": [{"name": "api", "exitCode": exit_code}]})


class EvaluateTest(unittest.TestCase):
    """Điều kiện «Lần chạy hợp lệ» của §2 (TC-185-07)."""

    def evaluate(self, watch, task, code="504", corr="no"):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            h, t = pathlib.Path(d, "watch.jsonl"), pathlib.Path(d, "task.json")
            h.write_text(watch, encoding="utf-8")
            t.write_text(task, encoding="utf-8")
            res = run_tools("evaluate", "--watch-log", str(h), "--task-json", str(t), "--container", "api",
                            "--client-code", code, "--client-has-correlation", corr, "--sleep-seconds", "115")
        return res, json.loads(res.stdout)

    def test_valid_run(self):
        res, out = self.evaluate(watch_log(), task_json())
        self.assertEqual(res.returncode, 0, res.stdout + res.stderr)
        self.assertTrue(out["valid"], out)
        self.assertEqual(out["reasons"], [])
        self.assertEqual(out["inflightPid"], 4242)

    def test_alb_errors_and_dropped_connection_are_valid(self):
        for code in ("502", "503", "504", "000"):
            res, out = self.evaluate(watch_log(), task_json(), code=code)
            self.assertEqual(res.returncode, 0, (code, out))

    def test_app_503_with_correlation_header_is_invalid(self):
        res, out = self.evaluate(watch_log(), task_json(), code="503", corr="yes")
        self.assertEqual(res.returncode, 3)
        self.assertEqual(out["reasons"], ["CLIENT_HAS_CORRELATION"])

    def test_201_is_invalid(self):
        res, out = self.evaluate(watch_log(), task_json(), code="201")
        self.assertIn("CLIENT_CODE", out["reasons"])

    def test_graceful_exit_is_invalid(self):
        res, out = self.evaluate(watch_log(), task_json(exit_code=143))
        self.assertEqual(res.returncode, 3)
        self.assertIn("EXIT_NOT_137", out["reasons"])

    def test_no_inflight_backend_is_invalid(self):
        res, out = self.evaluate(watch_log(inflight_from=999), task_json())
        self.assertEqual(res.returncode, 3)
        self.assertIn("NO_INFLIGHT", out["reasons"])

    def test_three_locks_required(self):
        for missing in ("idempotency_keys", "transfers", "ledger_entries"):
            locks = ",".join(x for x in INFLIGHT.split(",") if not x.startswith(missing + ":"))
            res, out = self.evaluate(watch_log(locks=locks), task_json())
            self.assertIn("NOT_MID_TRANSACTION", out["reasons"], missing)

    def test_late_first_sample_is_invalid(self):
        # mẫu thứ 17 = READY + 36 s
        res, out = self.evaluate(watch_log(inflight_from=17, inflight_until=70), task_json(exec_stopped=90))
        self.assertIn("W1_TOO_LATE", out["reasons"])

    def test_kill_when_sleep_nearly_over_is_invalid(self):
        # S0 = READY + 6 s; kill lúc READY + 112 >= S0 + 115 - 10
        res, out = self.evaluate(watch_log(), task_json(exec_stopped=112))
        self.assertIn("KILL_TOO_LATE", out["reasons"])

    def test_kill_just_in_time_is_valid(self):
        res, out = self.evaluate(watch_log(), task_json(exec_stopped=110))
        self.assertEqual(res.returncode, 0, out)

    def test_orphan_still_present_at_last_sample_is_invalid(self):
        res, out = self.evaluate(watch_log(inflight_until=None), task_json())
        self.assertIn("ORPHAN_STILL_PRESENT", out["reasons"])

    def test_watch_not_finished_is_invalid(self):
        res, out = self.evaluate(watch_log(done=False), task_json())
        self.assertIn("NO_DONE", out["reasons"])

    def test_stray_backend_holding_only_the_key_table_is_ignored(self):
        # job dọn dẹp idempotency_keys của worker hiện ở mọi mẫu: không được làm sai S0, W1 và điều kiện mẫu cuối
        res, out = self.evaluate(watch_log(stray=True), task_json())
        self.assertEqual(res.returncode, 0, out)
        self.assertEqual(out["inflightPid"], 4242)

    def test_only_a_stray_backend_is_not_mid_transaction(self):
        res, out = self.evaluate(watch_log(inflight_from=999, stray=True), task_json())
        self.assertIn("NOT_MID_TRANSACTION", out["reasons"])

    def test_epoch_timestamps_from_cli_v1(self):
        # AWS CLI v1 in số giây epoch
        task = json.dumps({"stoppingAt": BASE + 12, "executionStoppedAt": BASE + 80, "stoppedAt": BASE + 104,
                           "containers": [{"name": "api", "exitCode": 137}]})
        res, out = self.evaluate(watch_log(), task)
        self.assertEqual(res.returncode, 0, out)


class DbScriptStaticTest(unittest.TestCase):
    """TC-185-03: ac-5-10-db.js chỉ đọc, khóa DDL của đúng trigger tạm, không in mật khẩu."""

    ALLOWED_DDL = (
        r"CREATE\s+OR\s+REPLACE\s+FUNCTION\s+public\.dbs185_slow\(\)",
        r"CREATE\s+TRIGGER\s+dbs185_slow\s+BEFORE\s+INSERT\s+ON\s+public\.ledger_entries\s+FOR\s+EACH\s+STATEMENT\s+EXECUTE\s+FUNCTION\s+public\.dbs185_slow\(\)",
        r"DROP\s+TRIGGER\s+IF\s+EXISTS\s+dbs185_slow\s+ON\s+public\.ledger_entries",
        r"DROP\s+FUNCTION\s+IF\s+EXISTS\s+public\.dbs185_slow\(\)",
    )

    @classmethod
    def setUpClass(cls):
        cls.src = DB_JS.read_text(encoding="utf-8")
        cls.code = "\n".join(ln for ln in cls.src.splitlines() if not ln.lstrip().startswith("//"))

    def sql_strings(self):
        found = re.findall(r"""(['"`])((?:\\.|(?!\1).)*?)\1""", self.code, flags=re.S)
        heads = r"\s*(SELECT|BEGIN|ROLLBACK|WITH|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|SET|COPY|LOCK)\b"
        return [s for _, s in found if re.match(heads, s, flags=re.I)]

    def test_statements_are_reads_or_the_temporary_trigger(self):
        statements = self.sql_strings()
        self.assertGreaterEqual(len(statements), 6)
        for s in statements:
            head = re.match(r"\s*(\w+)", s).group(1).upper()
            if head in ("SELECT", "BEGIN", "ROLLBACK", "WITH"):
                continue
            self.assertTrue(any(re.match(p, s.strip(), flags=re.I) for p in self.ALLOWED_DDL), s)

    def test_no_writes_to_data(self):
        forbidden = re.compile(r"\b(INSERT|UPDATE|DELETE|ALTER|TRUNCATE|GRANT|REVOKE|COPY|LOCK)\b", re.I)
        for s in self.sql_strings():
            stripped = re.sub(r"BEFORE\s+INSERT\s+ON", "", s, flags=re.I)
            self.assertIsNone(forbidden.search(stripped), s)

    def test_probe_rolls_back_in_finally(self):
        probe = self.code[self.code.index("async function probe"):]
        self.assertRegex(probe, r"finally\s*\{[^}]*ROLLBACK")
        self.assertRegex(probe, r"BEGIN READ ONLY")

    def test_sleep_seconds_is_a_validated_number(self):
        self.assertRegex(self.code, r"Number\(env\.SLEEP_SECONDS")
        self.assertRegex(self.code, r"Number\.isInteger|isFinite")

    def test_password_never_logged(self):
        self.assertEqual(len(re.findall(r"DB_PASSWORD", self.code)), 1)
        for m in re.finditer(r"(console\.log|log)\(([^;]*)\)", self.code):
            self.assertNotRegex(m.group(2), r"password|DATABASE_URL|env\b", m.group(0))

    def test_size_for_inline(self):
        self.assertLessEqual(len(self.src.encode("utf-8")), 9000)

    def test_slow_off_waits_for_idle_ledger_and_has_lock_timeout(self):
        off = self.code[self.code.index("async function slowOff"):self.code.index("const WATCH_SQL")]
        self.assertRegex(off, r"lock_timeout")
        self.assertRegex(off, r"pg_locks")
        self.assertRegex(off, r"ledger_entries")
        self.assertRegex(off, r"triggerPresent|pg_trigger")

    def test_modes(self):
        for mode in ("slow-on", "slow-off", "watch", "probe"):
            self.assertIn(mode, self.code)


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
