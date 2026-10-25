#!/usr/bin/env python3
"""Test của infra/scripts/seed-cognito.sh (DBS-54, TC-54-08..14) bằng `aws` giả; chỉ dùng thư viện chuẩn.

Chạy: python3 infra/scripts/tests/test_seed_cognito.py
"""
import base64
import json
import os
import pathlib
import re
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE.parent / "seed-cognito.sh"
FAKE_AWS = HERE / "fake_aws.py"
USERS = {  # nhóm -> (username, email)
    "operator": "operator.demo@dbs.invalid",
    "auditor": "auditor.demo@dbs.invalid",
    "admin": "admin.demo@dbs.invalid",
}
POOL = "ap-southeast-1_ABCDEFGHI"


class Env:
    """Một thư mục trạng thái riêng, một PATH có `aws` giả và `python3` bọc để ghi argv."""

    def __init__(self):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        self.state = root / "state"
        self.bin = root / "bin"
        self.scratch = root / "tmpdir"  # TMPDIR của script: phải rỗng sau khi chạy
        for d in (self.state, self.bin, self.scratch):
            d.mkdir()
        aws = self.bin / "aws"
        aws.write_text(f'#!/bin/sh\nexec "{sys.executable}" "{FAKE_AWS}" "$@"\n')
        aws.chmod(0o755)
        py = self.bin / "python3"
        py.write_text(
            '#!/bin/sh\n'
            f'printf \'%s\\n\' "$*" >> "{self.state}/python-argv.log"\n'
            f'exec "{sys.executable}" "$@"\n'
        )
        py.chmod(0o755)

    def run(self, *args, fail_on=None, extra=None, pool=POOL):
        env = {
            "PATH": f"{self.bin}:/usr/bin:/bin",
            "FAKE_STATE": str(self.state),
            "TMPDIR": str(self.scratch),
            "HOME": self.tmp.name,
            "AWS_PROFILE": "dbs-admin",
        }
        if pool:
            env["COGNITO_USER_POOL_ID"] = pool
        if fail_on:
            env["FAKE_AWS_FAIL_ON"] = fail_on
        env.update(extra or {})
        p = subprocess.run(["bash", str(SCRIPT), *args], env=env, capture_output=True, text=True)
        return p

    def state_json(self):
        p = self.state / "state.json"
        return json.loads(p.read_text()) if p.exists() else {"secret": None, "users": {}, "signouts": []}

    def calls(self):
        p = self.state / "calls.jsonl"
        if not p.exists():
            return []
        out = []
        for line in p.read_text().splitlines():
            c = json.loads(line)
            c["stdin_bytes"] = base64.b64decode(c["stdin"]) if c["stdin"] is not None else None
            out.append(c)
        return out

    def ops(self):
        return [c["argv"][1] for c in self.calls()]

    def secret(self):
        s = self.state_json()["secret"]
        return json.loads(s["value"]) if s else None

    def passwords(self):
        return [u["password"] for u in self.secret()["users"].values()]

    def cleanup(self):
        self.tmp.cleanup()


class SeedCognito(unittest.TestCase):
    def setUp(self):
        self.e = Env()
        self.addCleanup(self.e.cleanup)

    # TC-54-08: secret trước, rồi tạo user, đặt mật khẩu, gán nhóm
    def test_first_run_orders_secret_before_users(self):
        p = self.e.run()
        self.assertEqual(p.returncode, 0, p.stderr)
        ops = self.e.ops()
        self.assertEqual(ops.count("create-secret"), 1)
        self.assertLess(ops.index("create-secret"), ops.index("admin-create-user"))
        create = next(c for c in self.e.calls() if c["argv"][1] == "create-secret")
        joined = " ".join(create["argv"])
        for tag in ("project", "env", "owner"):
            self.assertIn(f"Key={tag}", joined)
        self.assertEqual(self.e.state_json()["secret"]["tags"][0:1][0] != "", True)
        st = self.e.state_json()["users"]
        self.assertEqual(set(st), set(USERS.values()))
        for group, email in USERS.items():
            u = st[email]
            self.assertEqual(u["groups"], [group])
            self.assertEqual(u["status"], "CONFIRMED")
            self.assertTrue(u["verified"])
            self.assertEqual(u["message_action"], "SUPPRESS")
        for c in self.e.calls():
            if c["argv"][1] == "admin-set-user-password":
                self.assertIn("--permanent", c["argv"])

    # TC-54-09: mật khẩu không nằm trên argv, không ở stdout/stderr, không có \n cuối, không tệp tạm
    def test_passwords_never_leak(self):
        p = self.e.run()
        self.assertEqual(p.returncode, 0, p.stderr)
        pws = self.e.passwords()
        self.assertEqual(len(set(pws)), 3)
        for pw in pws:
            self.assertGreaterEqual(len(pw), 24)
            self.assertIsNone(re.search(r"\s", pw))
            self.assertTrue(re.search(r"[A-Z]", pw) and re.search(r"[a-z]", pw) and re.search(r"[0-9]", pw))
            self.assertTrue(re.search(r"[-_.!@#%^*+]", pw))
            self.assertNotIn(pw, p.stdout)
            self.assertNotIn(pw, p.stderr)
            for c in self.e.calls():
                self.assertNotIn(pw, " ".join(c["argv"]))
            pyargv = (self.e.state / "python-argv.log")
            if pyargv.exists():
                self.assertNotIn(pw, pyargv.read_text())
        for c in self.e.calls():
            self.assertNotIn("--debug", c["argv"])
            if c["argv"][1] == "admin-set-user-password":
                self.assertIn("file:///dev/stdin", c["argv"])
                self.assertFalse(c["stdin_bytes"].endswith(b"\n"))
                self.assertIn(c["stdin_bytes"].decode(), pws)
        self.assertEqual(list(self.e.scratch.iterdir()), [], "script đã để lại tệp tạm")

    # TC-54-10: chạy lần hai không đổi gì
    def test_second_run_is_idempotent(self):
        self.assertEqual(self.e.run().returncode, 0)
        before_secret = self.e.state_json()["secret"]["value"]
        before_ops = len(self.e.calls())
        p = self.e.run()
        self.assertEqual(p.returncode, 0, p.stderr)
        new_ops = [c["argv"][1] for c in self.e.calls()[before_ops:]]
        self.assertNotIn("create-secret", new_ops)
        self.assertNotIn("put-secret-value", new_ops)
        self.assertNotIn("admin-create-user", new_ops)
        self.assertNotIn("admin-user-global-sign-out", new_ops)
        self.assertEqual(self.e.state_json()["secret"]["value"], before_secret)
        for u in self.e.state_json()["users"].values():
            self.assertIn(u["password"], self.e.passwords())

    # TC-54-11: lỗi giữa chừng rồi chạy lại không mất mật khẩu nào
    def test_failure_midway_then_rerun(self):
        p = self.e.run(fail_on="admin-set-user-password:2")
        self.assertNotEqual(p.returncode, 0)
        stored = self.e.secret()
        self.assertEqual(set(stored["users"]), set(USERS))  # secret đã đủ ba mật khẩu trước khi tạo user
        p = self.e.run()
        self.assertEqual(p.returncode, 0, p.stderr)
        for group, email in USERS.items():
            self.assertEqual(self.e.state_json()["users"][email]["password"], self.e.secret()["users"][group]["password"])

    # TC-54-12: rotate ghi secret trước, rồi đặt mật khẩu, rồi sign-out
    def test_rotate_order_and_signout(self):
        self.assertEqual(self.e.run().returncode, 0)
        old = self.e.passwords()
        mark = len(self.e.calls())
        p = self.e.run("--rotate")
        self.assertEqual(p.returncode, 0, p.stderr)
        ops = [c["argv"][1] for c in self.e.calls()[mark:]]
        self.assertLess(ops.index("put-secret-value"), ops.index("admin-set-user-password"))
        self.assertLess(ops.index("admin-set-user-password"), ops.index("admin-user-global-sign-out"))
        self.assertEqual(sorted(self.e.state_json()["signouts"]), sorted(USERS.values()))
        self.assertTrue(set(self.e.passwords()).isdisjoint(old))
        for group, email in USERS.items():
            self.assertEqual(self.e.state_json()["users"][email]["password"], self.e.secret()["users"][group]["password"])

    def test_rotate_failure_then_plain_rerun_signs_out_remaining(self):
        self.assertEqual(self.e.run().returncode, 0)
        p = self.e.run("--rotate", fail_on="admin-set-user-password:5")  # lần gọi thứ 2 của lần rotate
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.e.run().returncode, 0)
        for group, email in USERS.items():
            self.assertEqual(self.e.state_json()["users"][email]["password"], self.e.secret()["users"][group]["password"])
        self.assertEqual(sorted(set(self.e.state_json()["signouts"])), sorted(USERS.values()))
        self.assertEqual(self.e.secret().get("pending_signout", []), [])

    # TC-54-12b: lỗi đọc secret khác ResourceNotFound thì không đụng Cognito; thiếu AWSCURRENT thì không lặp vô hạn
    def test_access_denied_stops_before_cognito(self):
        p = self.e.run(extra={"FAKE_GET_SECRET_ERROR": "AccessDeniedException"})
        self.assertNotEqual(p.returncode, 0)
        self.assertFalse([o for o in self.e.ops() if o.startswith("admin-")])
        self.assertNotIn("create-secret", self.e.ops())

    def test_secret_without_current_version_does_not_loop(self):
        p = self.e.run(extra={"FAKE_SECRET_NO_VALUE": "1"})
        self.assertNotEqual(p.returncode, 0)
        self.assertLessEqual(self.e.ops().count("create-secret"), 3)
        self.assertFalse([o for o in self.e.ops() if o.startswith("admin-")])

    def test_existing_user_extra_group_removed(self):
        (self.e.state / "state.json").write_text(json.dumps({
            "secret": None, "counts": {}, "signouts": [],
            "users": {"operator.demo@dbs.invalid": {"password": "old", "status": "CONFIRMED", "groups": ["customer", "admin"],
                                                   "verified": False, "message_action": None}},
        }))
        p = self.e.run()
        self.assertEqual(p.returncode, 0, p.stderr)
        u = self.e.state_json()["users"]["operator.demo@dbs.invalid"]
        self.assertEqual(u["groups"], ["operator"])
        self.assertTrue(u["verified"])
        self.assertEqual(u["password"], self.e.secret()["users"]["operator"]["password"])

    # TC-54-13
    def test_dry_run_calls_nothing(self):
        p = self.e.run("--dry-run")
        self.assertEqual(p.returncode, 0, p.stderr)
        self.assertEqual(self.e.calls(), [])
        self.assertIn("dry-run", (p.stdout + p.stderr).lower())

    def test_missing_pool_id_fails(self):
        p = self.e.run(pool=None)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(self.e.calls(), [])
        self.assertIn("COGNITO_USER_POOL_ID", p.stderr)


class StaticChecks(unittest.TestCase):
    # TC-54-14: không bí mật viết thẳng trong script, test và doc của task
    def test_no_hardcoded_secrets(self):
        files = [SCRIPT, pathlib.Path(__file__), HERE / "fake_aws.py",
                 HERE.parents[1] / "docs" / "features" / "DBS-54-terraform-cognito.md"]
        patterns = [
            re.compile(r"(?i)(password|passwd|secret)\w*\s*[=:]\s*['\"](?!\$|dbs/|arn:|FAKE-PW-)[^'\"\s]{6,}"),
            re.compile(r"--password\s+['\"]?(?!file://|\$)[^\s'\"]+"),
            re.compile(r"AKIA[0-9A-Z]{16}"),
            re.compile(r"eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}"),
        ]
        hits = []
        for f in files:
            if not f.exists():
                continue
            for n, line in enumerate(f.read_text().splitlines(), 1):
                if any(p.search(line) for p in patterns):
                    hits.append(f"{f.name}:{n}: {line.strip()[:100]}")
        self.assertEqual(hits, [])


if __name__ == "__main__":
    unittest.main(verbosity=2)
