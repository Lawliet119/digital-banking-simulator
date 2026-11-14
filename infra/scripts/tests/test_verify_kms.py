#!/usr/bin/env python3
"""Test của infra/scripts/verify-kms.sh (DBS-154, TC-154-09..11) bằng `aws` giả; chỉ dùng thư viện chuẩn.

Chạy: python3 infra/scripts/tests/test_verify_kms.py
"""
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE.parent / "verify-kms.sh"

CMK_ID = "11111111-2222-3333-4444-555555555555"
CMK_ARN = f"arn:aws:kms:ap-southeast-1:123456789012:key/{CMK_ID}"

FAKE_AWS = r'''#!/usr/bin/env python3
import json, os, sys
argv = sys.argv[1:]
with open(os.path.join(os.environ["FAKE_STATE"], "calls.jsonl"), "a") as f:
    f.write(json.dumps(argv) + "\n")
key = " ".join(argv[:2])
if key in [k for k in os.environ.get("FAKE_FAIL", "").split(",") if k]:
    sys.stderr.write("\naws: [ERROR]: An error occurred (AccessDenied) when calling the operation: fake\n")
    sys.exit(254)
fixture = json.load(open(os.environ["FAKE_FIXTURE"]))
out = fixture.get(key, "")
if isinstance(out, dict):
    # sqs get-queue-attributes theo --queue-url
    if "--queue-url" in argv:
        qurl = argv[argv.index("--queue-url") + 1]
        out = out.get(qurl, "")
    else:
        out = out.get(" ".join(argv[2:]), "")
sys.stdout.write(out)
'''

CHECK_NAMES = ["cmk", "rds", "elasticache", "sqs", "secrets"]


def all_ok_fixture():
    return {
        "kms describe-key": f"{CMK_ID}\t{CMK_ARN}\tEnabled\tCUSTOMER\n",
        "kms get-key-rotation-status": "True\n",
        "rds describe-db-instances": f"dbs-dev\tTrue\t{CMK_ARN}\n",
        "elasticache describe-replication-groups": f"dbs-dev\tTrue\t{CMK_ARN}\n",
        "sqs list-queues": (
            "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-dev-risk-events\t"
            "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-dev-risk-events-dlq\t"
            "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-dev-notification-events\t"
            "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-dev-notification-events-dlq\n"
        ),
        "sqs get-queue-attributes": {
            "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-dev-risk-events": f"{CMK_ARN}\tfalse\n",
            "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-dev-risk-events-dlq": f"{CMK_ARN}\tfalse\n",
            "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-dev-notification-events": f"{CMK_ARN}\tfalse\n",
            "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-dev-notification-events-dlq": f"{CMK_ARN}\tfalse\n",
        },
        "secretsmanager list-secrets": (
            f"dbs/dev/redis-auth\t{CMK_ARN}\n"
            f"dbs/dev/demo-accounts\t{CMK_ARN}\n"
            f"rds!db-abc-123\t{CMK_ARN}\n"
        ),
    }


class Env:
    def __init__(self, fixture=None, fail=""):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        self.state = root / "state"
        self.bin = root / "bin"
        self.state.mkdir()
        self.bin.mkdir()
        aws = self.bin / "aws"
        aws.write_text(FAKE_AWS)
        aws.chmod(0o755)
        (self.state / "fixture.json").write_text(json.dumps(fixture or {}))
        self.fail = fail

    def run(self, *args):
        env = dict(os.environ)
        env.update(
            PATH=f"{self.bin}:{env['PATH']}",
            FAKE_STATE=str(self.state),
            FAKE_FIXTURE=str(self.state / "fixture.json"),
            FAKE_FAIL=self.fail,
            AWS_PROFILE="",
        )
        return subprocess.run(["bash", str(SCRIPT), *args], env=env, capture_output=True, text=True)

    def calls(self):
        p = self.state / "calls.jsonl"
        if not p.exists():
            return []
        return [json.loads(line) for line in p.read_text().splitlines()]

    def close(self):
        self.tmp.cleanup()


def lines_by_name(stdout):
    out = {}
    for line in stdout.splitlines():
        parts = line.split(" ", 2)
        if parts[0] in ("OK", "FAIL", "BO-QUA", "LOI") and len(parts) >= 2:
            out[parts[1].rstrip(":")] = line
    return out


class VerifyKms(unittest.TestCase):
    def setUp(self):
        self.envs = []

    def tearDown(self):
        for e in self.envs:
            e.close()

    def env(self, *a, **k):
        e = Env(*a, **k)
        self.envs.append(e)
        return e

    # TC-154-09: tất cả dùng CMK -> thoát 0, mọi dòng OK
    def test_01_all_cmk_exit_0_all_ok(self):
        e = self.env(all_ok_fixture())
        r = e.run()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        by = lines_by_name(r.stdout)
        self.assertEqual(sorted(by), sorted(CHECK_NAMES), r.stdout)
        for name in CHECK_NAMES:
            self.assertTrue(by[name].startswith("OK "), by[name])

    # TC-154-10: từng loại sai -> FAIL đúng loại, thoát 1
    def test_02_each_mismatch_exits_1_with_right_fail(self):
        other_arn = "arn:aws:kms:ap-southeast-1:123456789012:key/99999999-9999-9999-9999-999999999999"
        cases = [
            ("cmk_disabled", "cmk", {"kms describe-key": f"{CMK_ID}\t{CMK_ARN}\tDisabled\tCUSTOMER\n"}),
            ("cmk_rotation_off", "cmk", {"kms get-key-rotation-status": "False\n"}),
            ("rds_other_key", "rds", {"rds describe-db-instances": f"dbs-dev\tTrue\t{other_arn}\n"}),
            ("elasticache_other_key", "elasticache", {"elasticache describe-replication-groups": f"dbs-dev\tTrue\t{other_arn}\n"}),
            ("sqs_sse_sqs", "sqs", {
                "sqs get-queue-attributes": {
                    **all_ok_fixture()["sqs get-queue-attributes"],
                    "https://sqs.ap-southeast-1.amazonaws.com/123456789012/dbs-dev-risk-events": "None\ttrue\n",
                },
            }),
            ("secret_empty_kms", "secrets", {
                "secretsmanager list-secrets": (
                    f"dbs/dev/redis-auth\t{CMK_ARN}\n"
                    "dbs/dev/demo-accounts\tNone\n"
                ),
            }),
        ]
        for label, expected_fail, override in cases:
            with self.subTest(label=label):
                fx = {**all_ok_fixture(), **override}
                e = self.env(fx)
                r = e.run()
                self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
                by = lines_by_name(r.stdout)
                self.assertTrue(by[expected_fail].startswith("FAIL "), by[expected_fail])

    # TC-154-11: session đã xóa (không RDS/Valkey) -> BO-QUA, thoát 0; lỗi quyền -> LOI, thoát 2; alias ở SQS -> OK; chỉ đọc
    def test_03_empty_session_skips_with_bo_qua_exit_0(self):
        fx = all_ok_fixture()
        fx["rds describe-db-instances"] = ""
        fx["elasticache describe-replication-groups"] = ""
        e = self.env(fx)
        r = e.run()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        by = lines_by_name(r.stdout)
        self.assertTrue(by["rds"].startswith("BO-QUA "), by["rds"])
        self.assertTrue(by["elasticache"].startswith("BO-QUA "), by["elasticache"])
        self.assertTrue(by["cmk"].startswith("OK "), by["cmk"])
        self.assertTrue(by["sqs"].startswith("OK "), by["sqs"])
        self.assertTrue(by["secrets"].startswith("OK "), by["secrets"])

    def test_04_sqs_alias_instead_of_arn_is_ok(self):
        fx = all_ok_fixture()
        fx["sqs get-queue-attributes"] = {
            k: "alias/dbs-dev\tfalse\n" for k in fx["sqs get-queue-attributes"]
        }
        e = self.env(fx)
        r = e.run()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertTrue(lines_by_name(r.stdout)["sqs"].startswith("OK "))

    def test_05_aws_error_exits_2_never_0(self):
        e = self.env(all_ok_fixture(), fail="secretsmanager list-secrets")
        r = e.run()
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        by = lines_by_name(r.stdout)
        self.assertTrue(by["secrets"].startswith("LOI "), by["secrets"])

    def test_06_read_only_and_region_pinned(self):
        e = self.env(all_ok_fixture())
        r = e.run()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        calls = e.calls()
        self.assertGreaterEqual(len(calls), 6)
        for c in calls:
            self.assertTrue(c[1].startswith(("describe-", "get-", "list-")), c)
            for bad in ("delete", "terminate", "release", "modify", "create", "put", "update", "run-", "stop", "start", "encrypt", "decrypt"):
                self.assertNotIn(bad, c[1], c)
            self.assertIn("--region", c, c)
            self.assertEqual(c[c.index("--region") + 1], "ap-southeast-1", c)


if __name__ == "__main__":
    unittest.main(verbosity=2)
