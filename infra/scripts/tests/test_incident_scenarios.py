#!/usr/bin/env python3
"""Test của công cụ kịch bản sự cố trên cloud (DBS-184, TC-184-01); chỉ dùng thư viện chuẩn.

Chạy: python3 infra/scripts/tests/test_incident_scenarios.py

Phần chạy thật của incident-db.js (TC-184-02) kiểm tay trên PostgreSQL 17 local, raw ở
docs/features/screenshots/DBS-184/manual-test.txt.
"""
import json
import pathlib
import re
import shutil
import subprocess
import sys
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPTS = HERE.parent
DB_JS = SCRIPTS / "incident-db.js"
SH = SCRIPTS / "incident-cloud.sh"
TOOLS = SCRIPTS / "ac-5-10-tools.py"
LIMIT = 8192


def run_tools(*args):
    return subprocess.run([sys.executable, str(TOOLS), *args], capture_output=True, text=True, encoding="utf-8", check=False)


class OverridesScriptTest(unittest.TestCase):
    def test_overrides_for_incident_script(self):
        for mode in ("notification-block", "notification-unblock", "notification-check"):
            res = run_tools("overrides", "--script", str(DB_JS), "--mode", mode)
            self.assertEqual(res.returncode, 0, res.stderr)
            self.assertLessEqual(len(res.stdout.strip()), LIMIT)
            co = json.loads(res.stdout)["containerOverrides"][0]
            self.assertEqual(co["name"], "migrate")
            self.assertEqual(co["command"][:2], ["node", "-e"])
            self.assertIn("dbs183_block", co["command"][2])
            self.assertEqual({e["name"]: e["value"] for e in co["environment"]}["MODE"], mode)

    def test_default_script_still_refuses_unknown_mode(self):
        res = run_tools("overrides", "--mode", "notification-block")
        self.assertNotEqual(res.returncode, 0)

    def test_script_with_unknown_mode_is_allowed_only_with_script(self):
        res = run_tools("overrides", "--script", str(DB_JS), "--mode", "bogus")
        self.assertNotEqual(res.returncode, 0)


class DbScriptStaticTest(unittest.TestCase):
    ALLOWED_DDL = (
        r"ALTER\s+TABLE\s+public\.notification_log\s+ADD\s+CONSTRAINT\s+dbs183_block\s+CHECK\s*\(false\)\s+NOT\s+VALID",
        r"ALTER\s+TABLE\s+public\.notification_log\s+DROP\s+CONSTRAINT\s+IF\s+EXISTS\s+dbs183_block",
    )

    @classmethod
    def setUpClass(cls):
        cls.src = DB_JS.read_text(encoding="utf-8")
        cls.code = "\n".join(ln for ln in cls.src.splitlines() if not ln.lstrip().startswith("//"))

    def sql_strings(self):
        found = re.findall(r"""(['"`])((?:\\.|(?!\1).)*?)\1""", self.code, flags=re.S)
        heads = r"\s*(SELECT|BEGIN|ROLLBACK|WITH|INSERT|UPDATE|DELETE|ALTER|DROP|CREATE|TRUNCATE|GRANT|SET|COPY|LOCK)\b"
        return [s for _, s in found if re.match(heads, s, flags=re.I)]

    def test_statements_are_reads_or_the_two_ddl(self):
        statements = self.sql_strings()
        self.assertGreaterEqual(len(statements), 4)
        for s in statements:
            head = re.match(r"\s*(\w+)", s).group(1).upper()
            if head in ("SELECT", "BEGIN", "ROLLBACK", "WITH"):
                continue
            self.assertTrue(any(re.match(p, s.strip(), flags=re.I) for p in self.ALLOWED_DDL), s)

    def test_no_data_writes(self):
        forbidden = re.compile(r"\b(INSERT|UPDATE|DELETE|TRUNCATE|GRANT|REVOKE|COPY|LOCK)\b", re.I)
        for s in self.sql_strings():
            self.assertIsNone(forbidden.search(s), s)

    def test_password_never_logged(self):
        self.assertEqual(len(re.findall(r"DB_PASSWORD", self.code)), 1)
        for m in re.finditer(r"(console\.log|log)\(([^;]*)\)", self.code):
            self.assertNotRegex(m.group(2), r"password|DATABASE_URL|env\b", m.group(0))

    def test_modes_and_size(self):
        for mode in ("notification-block", "notification-unblock", "notification-check"):
            self.assertIn(mode, self.code)
        self.assertLessEqual(len(self.src.encode("utf-8")), 7000)

    def test_check_reads_pg_constraint(self):
        self.assertRegex(self.code, r"pg_constraint")


class ShellScriptTest(unittest.TestCase):
    def test_syntax(self):
        bash = shutil.which("bash")
        if not bash:
            self.skipTest("không có bash")
        res = subprocess.run([bash, "-n", str(SH)], capture_output=True, text=True, encoding="utf-8", errors="replace", check=False)
        self.assertEqual(res.returncode, 0, res.stderr)

    def test_missing_env_is_refused_and_no_token_echo(self):
        bash = shutil.which("bash")
        if not bash:
            self.skipTest("không có bash")
        res = subprocess.run(
            [bash, str(SH), "latency", "L0"], capture_output=True, text=True, encoding="utf-8", errors="replace", check=False,
            env={"PATH": "/usr/bin:/bin", "CUST1_TOKEN": "eyJ-not-a-real-token"},
        )
        self.assertNotEqual(res.returncode, 0)
        self.assertNotIn("eyJ-not-a-real-token", res.stdout + res.stderr)

    def test_never_echoes_tokens_or_traces(self):
        src = "\n".join(ln for ln in SH.read_text(encoding="utf-8").splitlines() if not ln.lstrip().startswith("#"))
        self.assertIsNone(re.search(r"\bset\s+-[a-z]*x", src), "set -x")
        self.assertIsNone(re.search(r"curl[^\n]*\s-v\b", src), "curl -v")
        for var in ("CUST1_TOKEN", "CUST2_TOKEN", "CUST3_TOKEN", "OP_TOKEN", "AUD_TOKEN"):
            for line in src.splitlines():
                if re.search(r"\b(echo|printf)\b", line):
                    self.assertNotRegex(line, r"\$\{?%s\b(?!:\+|:-|\})" % var, line)

    def test_never_purges_or_redrives(self):
        src = SH.read_text(encoding="utf-8")
        for bad in ("purge-queue", "start-message-move-task"):
            self.assertNotIn(bad, src)


if __name__ == "__main__":
    unittest.main(verbosity=2)
