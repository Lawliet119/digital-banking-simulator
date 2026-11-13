#!/usr/bin/env python3
"""Test của infra/scripts/demo-token.sh (DBS-139, TC-139-07..11, 15, 16) bằng `aws` giả; chỉ dùng thư viện chuẩn.

Chạy: python3 infra/scripts/tests/test_demo_token.py

`aws` giả ghi argv, stdin và môi trường của mọi lời gọi vào $FAKE_STATE/calls.jsonl.
FAKE_AUTH = ok | challenge | denied | badjwt;  FAKE_SECRET = ok | missing | norole.
"""
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE.parent / "demo-token.sh"

PASSWORD = "Kh0ng-Dung-That-Xyzzy-7391!"
# JWT giả (header, payload {"cognito:groups":["operator"]}, chữ ký "signature"), dựng từ ba đoạn rời để gitleaks
# (luật `jwt`) không báo dương tính giả trên một chuỗi không phải bí mật.
TOKEN = ".".join(["eyJhbGciOiJSUzI1NiJ9", "eyJjb2duaXRvOmdyb3VwcyI6WyJvcGVyYXRvciJdfQ", "c2lnbmF0dXJl"])
CLIENT = "7abcdefghijklmnopqrstuvwxy"

FAKE_AWS = r'''#!/usr/bin/env python3
import json, os, sys
argv = sys.argv[1:]
stdin = "" if sys.stdin.isatty() else sys.stdin.read()
with open(os.path.join(os.environ["FAKE_STATE"], "calls.jsonl"), "a") as f:
    f.write(json.dumps({"argv": argv, "stdin": stdin, "env": dict(os.environ)}) + "\n")
def err(code, op):
    sys.stderr.write(f"\naws: [ERROR]: An error occurred ({code}) when calling the {op} operation: fake\n")
    sys.exit(254)
svc, op = argv[0], argv[1]
if svc == "secretsmanager" and op == "get-secret-value":
    mode = os.environ.get("FAKE_SECRET", "ok")
    if mode == "missing":
        err("ResourceNotFoundException", "GetSecretValue")
    users = {"operator": {"email": "operator.demo@dbs.invalid", "password": os.environ["FAKE_PASSWORD"]},
             "auditor": {"email": "auditor.demo@dbs.invalid", "password": os.environ["FAKE_PASSWORD"]},
             "admin": {"email": "admin.demo@dbs.invalid", "password": os.environ["FAKE_PASSWORD"]}}
    if mode == "norole":
        users.pop("operator")
    sys.stdout.write(json.dumps({"users": users, "pending_signout": []}) + "\n")
elif svc == "cognito-idp" and op == "initiate-auth":
    # Hành vi thật của AWS CLI v2 (đo ở M-139-03): --cli-input-json file:///dev/stdin báo "Invalid JSON received";
    # chỉ --auth-parameters file:///dev/stdin (JSON {"USERNAME","PASSWORD"}) cùng --auth-flow và --client-id chạy được.
    if "--cli-input-json" in argv:
        err("ParamValidation", "InitiateAuth")
    need = {"--auth-flow": "USER_PASSWORD_AUTH", "--client-id": os.environ["COGNITO_CLIENT_ID"],
            "--auth-parameters": "file:///dev/stdin"}
    for k, v in need.items():
        if k not in argv or argv[argv.index(k) + 1] != v:
            err("ParamValidation", "InitiateAuth")
    ap = json.loads(stdin)
    if set(ap) != {"USERNAME", "PASSWORD"}:
        err("ParamValidation", "InitiateAuth")
    mode = os.environ.get("FAKE_AUTH", "ok")
    if mode == "denied":
        err("NotAuthorizedException", "InitiateAuth")
    if mode == "challenge":
        sys.stdout.write("None\n")
    elif mode == "badjwt":
        sys.stdout.write("abc\n")
    else:
        sys.stdout.write(os.environ["FAKE_TOKEN"] + "\n")
else:
    err("UnknownOperation", op)
'''


class Env:
    def __init__(self, **fake):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        self.state, self.bin, self.scratch = root / "state", root / "bin", root / "tmpdir"
        for d in (self.state, self.bin, self.scratch):
            d.mkdir()
        aws = self.bin / "aws"
        aws.write_text(FAKE_AWS)
        aws.chmod(0o755)
        self.fake = fake

    def run(self, *args, extra_env=None):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("COGNITO_", "SECRET_NAME", "AWS_"))}
        env.update(
            PATH=f"{self.bin}:{env['PATH']}",
            TMPDIR=str(self.scratch),
            FAKE_STATE=str(self.state),
            FAKE_PASSWORD=PASSWORD,
            FAKE_TOKEN=TOKEN,
            COGNITO_CLIENT_ID=CLIENT,
        )
        env.update({k.upper(): v for k, v in self.fake.items()})
        env.update(extra_env or {})
        return subprocess.run(["bash", str(SCRIPT), *args], env=env, capture_output=True, text=True, stdin=subprocess.DEVNULL, timeout=60)

    def calls(self):
        p = self.state / "calls.jsonl"
        return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []

    def close(self):
        self.tmp.cleanup()


class DemoToken(unittest.TestCase):
    def setUp(self):
        self.envs = []

    def tearDown(self):
        for e in self.envs:
            e.close()

    def env(self, **k):
        e = Env(**k)
        self.envs.append(e)
        return e

    def test_07_success_prints_only_token_and_pins_region(self):
        e = self.env()
        r = e.run("--role", "operator")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertEqual(r.stdout, TOKEN + "\n")
        self.assertNotIn(TOKEN, r.stderr)
        calls = e.calls()
        self.assertEqual([c["argv"][:2] for c in calls], [["secretsmanager", "get-secret-value"],
                                                          ["cognito-idp", "initiate-auth"]])
        for c in calls:
            a = c["argv"]
            self.assertEqual(a[a.index("--region") + 1], "ap-southeast-1")

    def test_08_password_never_on_argv_env_or_disk(self):
        e = self.env()
        r = e.run("--role", "admin")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        calls = e.calls()
        for c in calls:
            self.assertNotIn(PASSWORD, " ".join(c["argv"]))
            env_values = [v for k, v in c["env"].items() if k != "FAKE_PASSWORD"]
            self.assertFalse(any(PASSWORD in v for v in env_values), "mật khẩu lọt vào môi trường tiến trình con")
        # mật khẩu chỉ đi qua stdin của initiate-auth
        auth = [c for c in calls if c["argv"][:2] == ["cognito-idp", "initiate-auth"]][0]
        self.assertIn(PASSWORD, auth["stdin"])
        self.assertEqual(auth["argv"][auth["argv"].index("--auth-parameters") + 1], "file:///dev/stdin")
        self.assertNotIn("--cli-input-json", auth["argv"])
        self.assertNotIn(PASSWORD, r.stdout + r.stderr)
        self.assertEqual(list(e.scratch.iterdir()), [], "script để lại tệp tạm")

    def test_09_bad_role_exit_2_no_aws_call(self):
        for args in (["--role", "customer"], [], ["--role", ""], ["--role"], ["--vai", "admin"]):
            with self.subTest(args=args):
                e = self.env()
                r = e.run(*args)
                self.assertEqual(r.returncode, 2, r.stdout + r.stderr)
                self.assertEqual(r.stdout, "")
                self.assertEqual(e.calls(), [])

    def test_10_missing_secret_exit_1_hint_no_cognito_call(self):
        e = self.env(fake_secret="missing")
        r = e.run("--role", "operator")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual(r.stdout, "")
        self.assertIn("seed-cognito.sh", r.stderr)
        self.assertEqual([c["argv"][0] for c in e.calls()], ["secretsmanager"])

    def test_11_cognito_denied_exit_1_no_leak(self):
        e = self.env(fake_auth="denied")
        r = e.run("--role", "operator")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual(r.stdout, "")
        self.assertNotIn(PASSWORD, r.stderr)
        self.assertNotIn(TOKEN, r.stderr)

    def test_15_challenge_or_non_jwt_never_prints_token(self):
        for mode in ("challenge", "badjwt"):
            with self.subTest(mode=mode):
                e = self.env(fake_auth=mode)
                r = e.run("--role", "operator")
                self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
                self.assertEqual(r.stdout, "")  # không bao giờ in "None" hay chuỗi không phải JWT

    def test_16_secret_without_role_exit_1_hint_no_cognito_call(self):
        e = self.env(fake_secret="norole")
        r = e.run("--role", "operator")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertEqual(r.stdout, "")
        self.assertIn("seed-cognito.sh", r.stderr)
        self.assertEqual([c["argv"][0] for c in e.calls()], ["secretsmanager"])


if __name__ == "__main__":
    unittest.main()
