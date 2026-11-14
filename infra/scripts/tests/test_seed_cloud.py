#!/usr/bin/env python3
"""Test của infra/scripts/seed-cloud.sh (BL-252, TC-252-01..14) bằng `aws` giả; chỉ dùng thư viện chuẩn.

Chạy: python3 infra/scripts/tests/test_seed_cloud.py   (Linux: PATH tách bằng `:`, cần bash và python3)

`aws` giả đọc kịch bản từ $FAKE_STATE/scenario.json và ghi mỗi lời gọi (argv và nội dung các file `file://`
tại thời điểm gọi, vì script xóa thư mục tạm khi thoát) vào calls.jsonl. `demo-token.sh` được thay bằng một
script giả (DEMO_TOKEN_SCRIPT) in token theo vai trò.
"""
import json
import os
import pathlib
import subprocess
import tempfile
import unittest

HERE = pathlib.Path(__file__).resolve().parent
SCRIPT = HERE.parent / "seed-cloud.sh"

ACCOUNT = "123456789012"
REGION = "ap-southeast-1"
REPO = f"{ACCOUNT}.dkr.ecr.{REGION}.amazonaws.com/dbs-api"
API_SHA = "a" * 40
OLD_SHA = "0" * 40
SEED_OLD = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/dbs-seed:1"
SEED_NEW = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/dbs-seed:2"
API_TD = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task-definition/dbs-api:9"
TASK_ID = "0123456789abcdef0123456789abcdef"
TASK_ARN = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task/dbs-dev/{TASK_ID}"
API_TASK_1 = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task/dbs-dev/11111111111111111111111111111111"
API_TASK_2 = f"arn:aws:ecs:{REGION}:{ACCOUNT}:task/dbs-dev/22222222222222222222222222222222"
SG = "sg-0abc123def4567890"


def jwt(label):
    # JWT giả dựng từ ba đoạn rời để gitleaks (luật `jwt`) không báo dương tính giả trên chuỗi không phải bí mật.
    return ".".join(["eyJhbGciOiJSUzI1NiJ9", f"cGF5bG9hZC17{label}", "c2lnbmF0dXJl"])


TOKENS = {
    "DBS_OPERATOR_TOKEN": jwt("operator"),
    "DBS_CUSTOMER_1_TOKEN": jwt("customer1"),
    "DBS_CUSTOMER_2_TOKEN": jwt("customer2"),
    "DBS_CUSTOMER_3_TOKEN": jwt("customer3"),
}

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
counter_file = os.path.join(state, "counter.json")
counters = json.load(open(counter_file)) if os.path.exists(counter_file) else {}
n = counters.get(key, 0)
counters[key] = n + 1
json.dump(counters, open(counter_file, "w"))

def fail(code, message="fake"):
    sys.stderr.write(f"\naws: [ERROR]: An error occurred ({code}) when calling the {op} operation: {message}\n")
    sys.exit(254)

def val(flag):
    return argv[argv.index(flag) + 1]

err = scen.get("error")
if err and err["op"] == key and n < err.get("times", 10**9):
    fail(err["code"], err.get("message", "fake"))

if key == "ecs describe-services":
    print(json.dumps(scen["describe_services"]))
elif key == "ec2 describe-security-groups":
    print(scen.get("security_group", "None"))
elif key == "ecs list-tasks":
    if "--family" in argv:
        print(json.dumps({"taskArns": scen.get("running_seeds", [])}))
    else:
        print(json.dumps({"taskArns": scen.get("api_task_arns", [])}))
elif key == "ecs describe-tasks":
    if "--cluster" in argv and TASK_ARN_MARK in argv:
        seq = scen["describe_tasks"]
        print(json.dumps(seq[min(counters.get("poll", 0), len(seq) - 1)]))
        counters["poll"] = counters.get("poll", 0) + 1
        json.dump(counters, open(counter_file, "w"))
    else:
        print(json.dumps(scen["api_tasks"]))
elif key == "ecs describe-task-definition":
    if "dbs-seed" in argv:
        if scen.get("seed_family_missing"):
            fail("ClientException", "Unable to describe task definition.")
        print(json.dumps(scen["seed_task_definition_response"]))
    else:
        print(json.dumps(scen["api_task_definition_response"]))
elif key == "ecs register-task-definition":
    print(json.dumps({"taskDefinition": {"taskDefinitionArn": scen["register_arn"]}}))
elif key == "ecs run-task":
    print(json.dumps(scen["run_task"]))
elif key == "ecs stop-task":
    print(json.dumps({"task": {}}))
elif key == "logs get-log-events":
    if scen.get("log_stream_missing"):
        fail("ResourceNotFoundException")
    print(json.dumps({"events": [{"message": m + "\n"} for m in scen.get("log_events", [])]}))
else:
    fail("UnknownOperation")
'''.replace("TASK_ARN_MARK", repr(TASK_ARN))

FAKE_DEMO_TOKEN = r'''#!/usr/bin/env bash
# demo-token.sh giả: ghi vai trò đã hỏi và in token theo vai trò.
echo "$2" >>"$FAKE_STATE/minted.txt"
python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))[sys.argv[2]])' "$FAKE_STATE/role_tokens.json" "$2"
'''


def service(subnets=("subnet-a", "subnet-b"), assign="ENABLED", td=API_TD):
    return {"services": [{"serviceName": "api", "taskDefinition": td, "networkConfiguration": {
        "awsvpcConfiguration": {"subnets": list(subnets), "securityGroups": ["sg-api"], "assignPublicIp": assign}}}], "failures": []}


def api_task(arn, ip, status="RUNNING"):
    details = [{"name": "subnetId", "value": "subnet-a"}] + ([{"name": "privateIPv4Address", "value": ip}] if ip else [])
    return {"taskArn": arn, "lastStatus": status, "attachments": [{"type": "ElasticNetworkInterface", "details": details}]}


def seed_td(image):
    return {"taskDefinition": {
        "taskDefinitionArn": SEED_OLD, "family": "dbs-seed", "revision": 1, "status": "ACTIVE", "networkMode": "awsvpc",
        "requiresCompatibilities": ["FARGATE"], "cpu": "256", "memory": "512",
        "containerDefinitions": [{
            "name": "seed", "image": image, "essential": True,
            "command": ["node", "dist/scripts/seed-cloud.js", "--help"],
            "environment": [{"name": "NODE_ENV", "value": "production"}],
            "logConfiguration": {"logDriver": "awslogs", "options": {"awslogs-group": "/dbs/dev/api", "awslogs-stream-prefix": "seed"}}}]},
        "tags": [{"key": "project", "value": "dbs"}]}


def api_td(image):
    return {"taskDefinition": {"taskDefinitionArn": API_TD, "family": "dbs-api", "containerDefinitions": [
        {"name": "api", "image": image}, {"name": "sidecar", "image": "other:1"}]}}


def stopped(code, reason="Essential container in task exited", extra=()):
    containers = list(extra) + [{"name": "seed", **({} if code is None else {"exitCode": code})}]
    return {"tasks": [{"taskArn": TASK_ARN, "lastStatus": "STOPPED", "stoppedReason": reason, "containers": containers}], "failures": []}


def running(status="RUNNING"):
    return {"tasks": [{"taskArn": TASK_ARN, "lastStatus": status, "containers": [{"name": "seed"}]}], "failures": []}


class Env:
    def __init__(self, **scenario):
        self.tmp = tempfile.TemporaryDirectory()
        root = pathlib.Path(self.tmp.name)
        self.state = root / "state"
        self.state.mkdir()
        self.tmpdir = root / "tmp"  # TMPDIR của script: phải trống sau khi chạy (không để lại token trên đĩa)
        self.tmpdir.mkdir()
        bindir = root / "bin"
        bindir.mkdir()
        (bindir / "aws").write_text(FAKE_AWS)
        (bindir / "aws").chmod(0o755)
        self.demo_token = root / "demo-token.sh"
        self.demo_token.write_text(FAKE_DEMO_TOKEN)
        (self.state / "role_tokens.json").write_text(json.dumps({
            "operator": "MINTED-" + TOKENS["DBS_OPERATOR_TOKEN"], "customer1": "MINTED-" + TOKENS["DBS_CUSTOMER_1_TOKEN"],
            "customer2": "MINTED-" + TOKENS["DBS_CUSTOMER_2_TOKEN"], "customer3": "MINTED-" + TOKENS["DBS_CUSTOMER_3_TOKEN"]}))
        self.bindir = bindir
        base = {
            "describe_services": service(),
            "security_group": SG,
            "api_task_arns": [API_TASK_1, API_TASK_2],
            "api_tasks": {"tasks": [api_task(API_TASK_1, "10.0.1.23"), api_task(API_TASK_2, "10.0.2.44")], "failures": []},
            "api_task_definition_response": api_td(f"{REPO}:{API_SHA}"),
            "seed_task_definition_response": seed_td(f"{REPO}:{OLD_SHA}"),
            "register_arn": SEED_NEW,
            "run_task": {"tasks": [{"taskArn": TASK_ARN}], "failures": []},
            "describe_tasks": [stopped(0)],
            "log_events": ["SEED SUMMARY OK"],
        }
        base.update(scenario)
        (self.state / "scenario.json").write_text(json.dumps(base))

    def cleanup(self):
        self.tmp.cleanup()

    def run(self, args=(), tokens=True, **extra):
        env = {k: v for k, v in os.environ.items() if not k.startswith(("DBS_", "IMAGE_TAG", "AWS_", "SEED_"))}
        env.update({"PATH": f"{self.bindir}:{env['PATH']}", "FAKE_STATE": str(self.state), "TMPDIR": str(self.tmpdir),
                    "DEMO_TOKEN_SCRIPT": str(self.demo_token), "POLL_SECONDS": "0", "SEED_STOP_WAIT_SECONDS": "0",
                    "SEED_DEADLINE_SECONDS": "30"})
        if tokens is True:
            env.update(TOKENS)
        elif isinstance(tokens, dict):
            env.update(tokens)
        env.update(extra)
        return subprocess.run(["bash", str(SCRIPT), *args], capture_output=True, text=True, env=env)

    def calls(self):
        path = self.state / "calls.jsonl"
        return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []

    def ops(self):
        return [" ".join(c["argv"][:2]) for c in self.calls()]

    def call(self, name):
        return next(c for c in self.calls() if " ".join(c["argv"][:2]) == name)

    def minted(self):
        path = self.state / "minted.txt"
        return path.read_text().split() if path.exists() else []


class SeedCloud(unittest.TestCase):
    def make(self, **scenario):
        e = Env(**scenario)
        self.addCleanup(e.cleanup)
        return e

    def out(self, p):
        return p.stdout + p.stderr

    # TC-252-01
    def test_success_runs_seed_task_in_vpc_against_the_api_task_ip(self):
        e = self.make()
        p = self.run_ok(e)
        self.assertIn("Seed xong", p.stdout)
        self.assertIn("SEED SUMMARY OK", p.stdout)  # log của task được in cả khi thành công
        reg = e.call("ecs register-task-definition")["files"]["--cli-input-json"]
        self.assertEqual(reg["family"], "dbs-seed")
        self.assertEqual(reg["containerDefinitions"][0]["image"], f"{REPO}:{API_SHA}")  # image đang chạy của api
        run = e.call("ecs run-task")
        for arg in ("dbs-dev", SEED_NEW, "FARGATE", "seed-" + API_SHA[:7], "TASK_DEFINITION"):
            self.assertIn(arg, run["argv"])
        self.assertEqual(run["argv"][run["argv"].index("--count") + 1], "1")
        self.assertEqual(run["files"]["--network-configuration"], {"awsvpcConfiguration": {
            "subnets": ["subnet-a", "subnet-b"], "securityGroups": [SG], "assignPublicIp": "ENABLED"}})
        co = run["files"]["--overrides"]["containerOverrides"]
        self.assertEqual(len(co), 1)
        self.assertEqual(co[0]["name"], "seed")
        self.assertEqual(co[0]["command"], ["node", "dist/scripts/seed-cloud.js", "--auth", "cloud", "--url", "http://10.0.1.23:3000"])
        self.assertEqual({v["name"]: v["value"] for v in co[0]["environment"]}, TOKENS)
        stream = e.call("logs get-log-events")["argv"]
        self.assertIn(f"seed/seed/{TASK_ID}", stream)
        self.assertIn("/dbs/dev/api", stream)

    def run_ok(self, e, **kw):
        p = e.run(**kw)
        self.assertEqual(p.returncode, 0, self.out(p))
        return p

    # TC-252-02: không đi qua ALB và không tắt kiểm chứng chỉ
    def test_url_is_plain_http_private_ip_never_the_alb_and_no_tls_bypass(self):
        e = self.make()
        self.run_ok(e)
        text = json.dumps(e.calls())
        self.assertNotIn("elasticloadbalancing", text)
        self.assertNotIn("NODE_TLS_REJECT_UNAUTHORIZED", text)
        self.assertNotIn("https://", json.dumps(e.call("ecs run-task")["files"]["--overrides"]))

    # TC-252-03: token không lộ ra stdout/stderr/argv và không để lại trên đĩa
    def test_tokens_never_printed_in_argv_or_left_on_disk(self):
        e = self.make()
        p = self.run_ok(e)
        for token in TOKENS.values():
            self.assertNotIn(token, self.out(p))
            for c in e.calls():
                self.assertNotIn(token, json.dumps(c["argv"]))
        self.assertEqual(list(e.tmpdir.iterdir()), [], "thư mục tạm (có overrides chứa token) phải bị xóa")

    def test_failed_run_does_not_leave_tokens_on_disk_either(self):
        e = self.make(describe_tasks=[stopped(1)])
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertEqual(list(e.tmpdir.iterdir()), [])
        for token in TOKENS.values():
            self.assertNotIn(token, self.out(p))

    # TC-252-04: thiếu token thì lấy bằng demo-token.sh theo đúng vai trò
    def test_missing_tokens_are_minted_with_demo_token_per_role(self):
        e = self.make()
        self.run_ok(e, tokens=False)
        self.assertEqual(sorted(e.minted()), ["customer1", "customer2", "customer3", "operator"])
        env = {v["name"]: v["value"] for v in e.call("ecs run-task")["files"]["--overrides"]["containerOverrides"][0]["environment"]}
        self.assertEqual(env["DBS_OPERATOR_TOKEN"], "MINTED-" + TOKENS["DBS_OPERATOR_TOKEN"])
        self.assertEqual(env["DBS_CUSTOMER_3_TOKEN"], "MINTED-" + TOKENS["DBS_CUSTOMER_3_TOKEN"])

    def test_token_from_env_wins_and_only_the_missing_ones_are_minted(self):
        e = self.make()
        self.run_ok(e, tokens={"DBS_OPERATOR_TOKEN": TOKENS["DBS_OPERATOR_TOKEN"]})
        self.assertEqual(sorted(e.minted()), ["customer1", "customer2", "customer3"])
        env = {v["name"]: v["value"] for v in e.call("ecs run-task")["files"]["--overrides"]["containerOverrides"][0]["environment"]}
        self.assertEqual(env["DBS_OPERATOR_TOKEN"], TOKENS["DBS_OPERATOR_TOKEN"])

    def test_token_is_minted_right_before_run_task_after_register(self):
        e = self.make()
        self.run_ok(e, tokens=False)
        self.assertEqual(e.minted()[0], "operator")
        # demo-token.sh giả không gọi aws; thứ tự đủ nhờ: register-task-definition xảy ra, run-task là lệnh sau cùng trước poll
        ops = e.ops()
        self.assertLess(ops.index("ecs register-task-definition"), ops.index("ecs run-task"))

    def test_minting_failure_is_red_without_run_task(self):
        e = self.make()
        e.demo_token.write_text("#!/usr/bin/env bash\necho 'chưa seed' >&2\nexit 1\n")
        p = e.run(tokens=False)
        self.assertEqual(p.returncode, 1)
        self.assertIn("Không lấy được token", self.out(p))
        self.assertNotIn("ecs run-task", e.ops())

    def test_token_that_is_not_a_jwt_is_rejected_by_name_without_echoing_it(self):
        e = self.make()
        bad = "not-a-jwt-SECRETVALUE"
        p = e.run(tokens={"DBS_CUSTOMER_2_TOKEN": bad})
        self.assertEqual(p.returncode, 1)
        self.assertIn("DBS_CUSTOMER_2_TOKEN", self.out(p))
        self.assertNotIn(bad, self.out(p))
        self.assertNotIn("ecs run-task", e.ops())

    # TC-252-05: mạng
    def test_security_group_is_looked_up_by_name_or_taken_from_env(self):
        e = self.make()
        self.run_ok(e)
        argv = e.call("ec2 describe-security-groups")["argv"]
        self.assertIn("Name=group-name,Values=dbs-dev-seed", argv)
        e = self.make()
        self.run_ok(e, SEED_SECURITY_GROUP="sg-0feedface")
        self.assertNotIn("ec2 describe-security-groups", e.ops())
        self.assertEqual(e.call("ecs run-task")["files"]["--network-configuration"]["awsvpcConfiguration"]["securityGroups"], ["sg-0feedface"])

    def test_missing_security_group_points_to_base_apply(self):
        e = self.make(security_group="None")
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertIn("terraform apply", self.out(p))
        self.assertIn("envs/dev/base", self.out(p))
        self.assertNotIn("ecs run-task", e.ops())

    def test_assign_public_ip_follows_the_api_service(self):
        e = self.make(describe_services=service(assign="DISABLED"))
        self.run_ok(e)
        self.assertEqual(e.call("ecs run-task")["files"]["--network-configuration"]["awsvpcConfiguration"]["assignPublicIp"], "DISABLED")

    def test_service_without_awsvpc_network_is_red(self):
        e = self.make(describe_services={"services": [{"serviceName": "api", "taskDefinition": API_TD}], "failures": []})
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertIn("session chưa dựng", self.out(p))

    # TC-252-06: chọn task api
    def test_only_running_api_tasks_with_an_ip_are_used(self):
        tasks = {"tasks": [api_task(API_TASK_1, "10.0.9.9", status="PROVISIONING"), api_task(API_TASK_2, "10.0.2.44")], "failures": []}
        e = self.make(api_tasks=tasks)
        self.run_ok(e)
        cmd = e.call("ecs run-task")["files"]["--overrides"]["containerOverrides"][0]["command"]
        self.assertEqual(cmd[-1], "http://10.0.2.44:3000")

    def test_no_running_api_task_is_red(self):
        e = self.make(api_task_arns=[])
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertIn("không có task RUNNING", self.out(p))
        self.assertNotIn("ecs run-task", e.ops())

    def test_api_task_without_private_ip_is_red(self):
        e = self.make(api_tasks={"tasks": [api_task(API_TASK_1, None)], "failures": []})
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertIn("IP riêng", self.out(p))

    # TC-252-07: image
    def test_image_tag_env_overrides_the_running_api_image(self):
        e = self.make()
        self.run_ok(e, IMAGE_TAG="b" * 40)
        reg = e.call("ecs register-task-definition")["files"]["--cli-input-json"]
        self.assertEqual(reg["containerDefinitions"][0]["image"], f"{REPO}:{'b' * 40}")
        self.assertEqual(e.ops().count("ecs describe-task-definition"), 1)  # chỉ dbs-seed, không đọc image của api

    def test_non_sha_image_tag_is_rejected(self):
        for bad in ("latest", "abc123", "A" * 40):
            e = self.make()
            p = e.run(IMAGE_TAG=bad)
            self.assertEqual(p.returncode, 1, bad)
            self.assertIn("40 ký tự", self.out(p))
            self.assertNotIn("ecs register-task-definition", e.ops())

    def test_api_running_a_non_sha_image_is_rejected(self):
        e = self.make(api_task_definition_response=api_td(f"{REPO}:latest"))
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertIn("40 ký tự", self.out(p))

    def test_latest_revision_with_same_image_is_not_registered_again(self):
        e = self.make(seed_task_definition_response=seed_td(f"{REPO}:{API_SHA}"))
        p = self.run_ok(e)
        self.assertIn("không đăng ký lại", p.stdout)
        self.assertNotIn("ecs register-task-definition", e.ops())
        self.assertIn(SEED_OLD, e.call("ecs run-task")["argv"])

    def test_missing_seed_family_points_to_session_apply(self):
        e = self.make(seed_family_missing=True)
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertIn("terraform apply", self.out(p))
        self.assertIn("envs/dev/session", self.out(p))
        self.assertNotIn("ecs run-task", e.ops())

    # TC-252-08: không chạy chồng
    def test_running_seed_task_blocks_a_second_run(self):
        e = self.make(running_seeds=[TASK_ARN])
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertIn("không chạy chồng", self.out(p))
        self.assertNotIn("ecs run-task", e.ops())

    # TC-252-09: kết quả theo exitCode của container seed
    def test_nonzero_exit_is_red_and_prints_logs(self):
        e = self.make(describe_tasks=[stopped(1)], log_events=["SeedError: balance diverges"])
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertIn("Seed thất bại (exitCode 1)", self.out(p))
        self.assertIn("SeedError: balance diverges", p.stdout)

    def test_missing_exit_code_is_red_with_stopped_reason(self):
        e = self.make(describe_tasks=[stopped(None, "CannotPullContainerError")])
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertIn("CannotPullContainerError", self.out(p))

    def test_exit_code_is_read_from_the_container_named_seed(self):
        e = self.make(describe_tasks=[stopped(0, extra=[{"name": "sidecar", "exitCode": 1}])])
        self.run_ok(e)
        e = self.make(describe_tasks=[stopped(2, extra=[{"name": "sidecar", "exitCode": 0}])])
        self.assertEqual(e.run().returncode, 1)

    def test_unreadable_logs_do_not_change_the_result(self):
        e = self.make(log_stream_missing=True)
        p = self.run_ok(e)
        self.assertIn("không đọc được log", p.stdout)

    # TC-252-10: run-task / describe-tasks lỗi
    def test_run_task_failures_is_red_without_polling(self):
        e = self.make(run_task={"tasks": [], "failures": [{"reason": "RESOURCE:FARGATE", "detail": "no capacity"}]})
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertIn("RESOURCE:FARGATE", self.out(p))
        self.assertNotIn("ecs describe-tasks", e.ops()[e.ops().index("ecs run-task"):])

    def test_polls_until_stopped(self):
        e = self.make(describe_tasks=[running("PENDING"), running(), stopped(0)])
        self.run_ok(e)

    def test_describe_tasks_failures_stop_after_three_times(self):
        e = self.make(describe_tasks=[{"tasks": [], "failures": [{"arn": TASK_ARN, "reason": "MISSING"}]}])
        p = e.run()
        self.assertEqual(p.returncode, 1)
        self.assertIn("MISSING", self.out(p))
        self.assertIn("ecs stop-task", e.ops())

    def test_deadline_stops_the_task_and_is_red(self):
        e = self.make(describe_tasks=[running()])
        p = e.run(SEED_DEADLINE_SECONDS="0")
        self.assertEqual(p.returncode, 1)
        self.assertIn("Quá 0s", self.out(p))
        self.assertIn("ecs stop-task", e.ops())

    # TC-252-11: --dry-run không đổi gì
    def test_dry_run_prints_the_plan_and_changes_nothing(self):
        e = self.make()
        p = e.run(args=["--dry-run"], tokens=False)
        self.assertEqual(p.returncode, 0, self.out(p))
        self.assertIn("http://10.0.1.23:3000", p.stdout)
        self.assertIn(SG, p.stdout)
        self.assertIn(f"{REPO}:{API_SHA}", p.stdout)
        for op in ("ecs register-task-definition", "ecs run-task"):
            self.assertNotIn(op, e.ops())
        self.assertEqual(e.minted(), [], "--dry-run không lấy token")

    # TC-252-12
    def test_unknown_argument_is_usage_error(self):
        e = self.make()
        p = e.run(args=["--apply"])
        self.assertEqual(p.returncode, 2)
        self.assertEqual(e.calls(), [])

    # TC-252-13: tên cluster/family đúng, không dùng family migrate
    def test_uses_the_seed_family_not_the_migrate_family(self):
        e = self.make()
        self.run_ok(e)
        text = json.dumps(e.calls())
        self.assertIn("dbs-seed", text)
        self.assertNotIn("dbs-migrate", text)


if __name__ == "__main__":
    unittest.main()
