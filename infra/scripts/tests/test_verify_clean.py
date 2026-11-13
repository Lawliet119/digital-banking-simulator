#!/usr/bin/env python3
"""Test của infra/scripts/verify-clean.sh (DBS-139, TC-139-01..06, 13, 14) bằng `aws` giả; chỉ dùng thư viện chuẩn.

Chạy: python3 infra/scripts/tests/test_verify_clean.py

`aws` giả đọc $FAKE_FIXTURE (JSON: "<dịch vụ> <lệnh>" -> văn bản stdout, như `--output text`), ghi argv mọi lời gọi
vào $FAKE_STATE/calls.jsonl và lỗi (mã 254, AccessDenied) với các khóa trong $FAKE_FAIL (phân tách bằng dấu phẩy).
"""
import json
import os
import pathlib
import subprocess
import sys
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE.parent / "verify-clean.sh"

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
if isinstance(out, dict):  # ecs describe-services / list-tasks theo cluster hoặc service: khóa mở rộng
    out = out.get(" ".join(argv[2:]), "")
sys.stdout.write(out)
'''

CHECK_NAMES = [
    "nat-gateway", "load-balancer", "rds", "rds-snapshot-manual", "elasticache", "ecs", "elastic-ip",
    "eni-available", "waf-regional", "vpc-endpoint-ec2", "rds-automated-backup", "elasticache-snapshot", "ebs",
]

# Mỗi loại: (khóa fixture, nội dung, chuỗi phải xuất hiện trong dòng FAIL của loại đó)
LEFTOVERS = {
    "nat-gateway": ("ec2 describe-nat-gateways", "nat-0abc123", "nat-0abc123"),
    "load-balancer": ("elbv2 describe-load-balancers", "dbs-dev", "dbs-dev"),
    "rds": ("rds describe-db-instances", "dbs-dev", "dbs-dev"),
    "rds-snapshot-manual": ("rds describe-db-snapshots", "dbs-dev-final", "dbs-dev-final"),
    "elasticache": ("elasticache describe-replication-groups", "dbs-dev", "dbs-dev"),
    "elastic-ip": ("ec2 describe-addresses", "eipalloc-0abc", "eipalloc-0abc"),
    "eni-available": ("ec2 describe-network-interfaces", "eni-0def456", "eni-0def456"),
    "waf-regional": ("wafv2 list-web-acls", "dbs-dev-acl", "dbs-dev-acl"),
    "vpc-endpoint-ec2": ("ec2 describe-vpc-endpoints", "vpce-0123", "vpce-0123"),
    "rds-automated-backup": ("rds describe-db-instance-automated-backups", "dbs-dev", "dbs-dev"),
    "elasticache-snapshot": ("elasticache describe-snapshots", "dbs-dev-snap", "dbs-dev-snap"),
    "ebs": ("ec2 describe-volumes", "vol-0aaa", "vol-0aaa"),
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
        if parts[0] in ("OK", "FAIL", "LOI") and len(parts) >= 2:
            out[parts[1].rstrip(":")] = line
    return out


class VerifyClean(unittest.TestCase):
    def setUp(self):
        self.envs = []

    def tearDown(self):
        for e in self.envs:
            e.close()

    def env(self, *a, **k):
        e = Env(*a, **k)
        self.envs.append(e)
        return e

    def test_01_all_clean_exit_0_with_13_ok(self):
        # cluster ECS rỗng (miễn phí) không phải FAIL
        e = self.env({"ecs list-clusters": "arn:aws:ecs:ap-southeast-1:000000000000:cluster/dbs-dev\n"})
        r = e.run()
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        by = lines_by_name(r.stdout)
        self.assertEqual(sorted(by), sorted(CHECK_NAMES), r.stdout)
        for name in CHECK_NAMES:
            self.assertTrue(by[name].startswith("OK "), by[name])
        self.assertNotIn("000000000000", r.stdout)  # không lộ số tài khoản

    def test_02_each_leftover_exit_1_and_names_the_id(self):
        for name, (key, value, needle) in LEFTOVERS.items():
            with self.subTest(name=name):
                e = self.env({key: value + "\n"})
                r = e.run()
                self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
                by = lines_by_name(r.stdout)
                self.assertTrue(by[name].startswith("FAIL "), by[name])
                self.assertIn(needle, by[name])
                others = [n for n in CHECK_NAMES if n != name]
                self.assertTrue(all(by[n].startswith("OK ") for n in others), r.stdout)

    def test_02b_ecs_service_and_task_leftovers(self):
        cl = "arn:aws:ecs:ap-southeast-1:000000000000:cluster/dbs-dev"
        base = {"ecs list-clusters": cl + "\n"}
        # service desiredCount>0 -> FAIL
        e = self.env({**base, "ecs list-services": "arn:aws:ecs:x:0:service/dbs-dev/api\n",
                      "ecs describe-services": "api\n"})
        r = e.run()
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("api", lines_by_name(r.stdout)["ecs"])
        self.assertTrue(lines_by_name(r.stdout)["ecs"].startswith("FAIL "))
        # task đang chạy, không có service -> FAIL
        e = self.env({**base, "ecs list-tasks": "arn:aws:ecs:x:0:task/dbs-dev/0123456789abcdef\n"})
        r = e.run()
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertTrue(lines_by_name(r.stdout)["ecs"].startswith("FAIL "))
        self.assertNotIn("000000000000", r.stdout)

    def test_05_service_desired_zero_is_not_a_failure(self):
        # có service nhưng bộ lọc desiredCount>0 trả rỗng, và không task: OK
        e = self.env({"ecs list-clusters": "arn:aws:ecs:x:0:cluster/dbs-dev\n",
                      "ecs list-services": "arn:aws:ecs:x:0:service/dbs-dev/api\n"})
        r = e.run()
        self.assertEqual(r.returncode, 0, r.stdout)
        self.assertTrue(lines_by_name(r.stdout)["ecs"].startswith("OK "))
        # lọc ở phía máy chủ: describe-services phải mang bộ lọc desiredCount
        desc = [c for c in e.calls() if c[:2] == ["ecs", "describe-services"]]
        self.assertTrue(desc and "desiredCount" in " ".join(desc[0]), desc)

    def test_06_in_use_eni_is_not_an_orphan(self):
        # ENI in-use không được trả về vì bộ lọc status=available được gửi cho máy chủ
        e = self.env({})
        r = e.run()
        self.assertEqual(r.returncode, 0)
        enis = [c for c in e.calls() if c[:2] == ["ec2", "describe-network-interfaces"]]
        self.assertTrue(enis)
        joined = " ".join(enis[0])
        self.assertIn("status", joined)
        self.assertIn("available", joined)

    def test_03_aws_error_exit_2_never_0(self):
        e = self.env({}, fail="ec2 describe-addresses")
        r = e.run()
        self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
        by = lines_by_name(r.stdout)
        self.assertTrue(by["elastic-ip"].startswith("LOI "), by["elastic-ip"])
        others = [n for n in CHECK_NAMES if n != "elastic-ip"]
        self.assertTrue(all(by[n].startswith("OK ") for n in others), r.stdout)  # loại khác vẫn chạy

    def test_13_fail_and_error_together_exit_1_with_both_lines(self):
        e = self.env({"rds describe-db-instances": "dbs-dev\n"}, fail="ec2 describe-addresses")
        r = e.run()
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        by = lines_by_name(r.stdout)
        self.assertTrue(by["rds"].startswith("FAIL "))
        self.assertTrue(by["elastic-ip"].startswith("LOI "))

    def test_04_read_only_and_region_pinned(self):
        fixture = {k: v + "\n" for k, (k2, v, _n) in LEFTOVERS.items() for k in [k2]}
        e = self.env({**fixture, "ecs list-clusters": "arn:aws:ecs:x:0:cluster/dbs-dev\n",
                      "ecs list-services": "arn:aws:ecs:x:0:service/dbs-dev/api\n"})
        e.run()
        calls = e.calls()
        self.assertGreaterEqual(len(calls), 13)
        for c in calls:
            self.assertTrue(c[1].startswith(("describe-", "list-")), c)
            for bad in ("delete", "terminate", "release", "modify", "create", "put", "update", "run-", "stop", "start"):
                self.assertNotIn(bad, c[1], c)
            self.assertIn("--region", c, c)
            self.assertEqual(c[c.index("--region") + 1], "ap-southeast-1", c)

    def test_14_extra_leftover_kinds_and_stopped_instance(self):
        e = self.env({"ec2 describe-instances": "i-0stopped\n"})
        r = e.run()
        self.assertEqual(r.returncode, 1, r.stdout)
        self.assertIn("i-0stopped", lines_by_name(r.stdout)["vpc-endpoint-ec2"])
        inst = [c for c in e.calls() if c[:2] == ["ec2", "describe-instances"]]
        self.assertIn("stopped", " ".join(inst[0]))  # bộ lọc gồm cả instance đã dừng (volume vẫn tính tiền)


if __name__ == "__main__":
    unittest.main()
