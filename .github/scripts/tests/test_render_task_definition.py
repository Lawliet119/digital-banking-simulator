#!/usr/bin/env python3
"""Test của .github/scripts/render-task-definition.py (DBS-38, TC-38-01..03); chỉ dùng thư viện chuẩn.

Chạy: python3 .github/scripts/tests/test_render_task_definition.py
"""
import json
import pathlib
import subprocess
import sys
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "render-task-definition.py"
REPO = "123456789012.dkr.ecr.ap-southeast-1.amazonaws.com/dbs-api"
OLD = "1" * 40
NEW = "2" * 40

# Đúng dạng phản hồi của `aws ecs describe-task-definition --include TAGS`: tags nằm ở gốc, cạnh taskDefinition.
RESPONSE = {
    "taskDefinition": {
        "taskDefinitionArn": "arn:aws:ecs:ap-southeast-1:123456789012:task-definition/dbs-api:7",
        "family": "dbs-api",
        "revision": 7,
        "status": "ACTIVE",
        "registeredAt": "2026-10-26T10:00:00+00:00",
        "registeredBy": "arn:aws:iam::123456789012:user/x",
        "deregisteredAt": None,
        "compatibilities": ["EC2", "FARGATE"],
        "requiresAttributes": [{"name": "ecs.capability.execution-role-awslogs"}],
        "taskRoleArn": "arn:aws:iam::123456789012:role/dbs-dev-api-task",
        "executionRoleArn": "arn:aws:iam::123456789012:role/dbs-dev-api-execution",
        "networkMode": "awsvpc",
        "requiresCompatibilities": ["FARGATE"],
        "cpu": "512",
        "memory": "1024",
        "runtimePlatform": {"cpuArchitecture": "X86_64", "operatingSystemFamily": "LINUX"},
        "volumes": [],
        "placementConstraints": [],
        "someFutureReadOnlyField": "x",
        "containerDefinitions": [
            {
                "name": "api",
                "image": f"{REPO}:{OLD}",
                "essential": True,
                "portMappings": [{"containerPort": 3000, "protocol": "tcp"}],
                "environment": [{"name": "APP_ROLE", "value": "api"}],
                "secrets": [{"name": "PGPASSWORD", "valueFrom": "arn:aws:secretsmanager:ap-southeast-1:123456789012:secret:x:password::"}],
                "logConfiguration": {"logDriver": "awslogs", "options": {"awslogs-group": "/dbs/dev/api"}},
            },
            {"name": "sidecar", "image": "public.ecr.aws/x/y:1", "essential": False},
        ],
    },
    "tags": [{"key": "project", "value": "dbs"}, {"key": "env", "value": "dev"}],
}


def run(response, image):
    return subprocess.run([sys.executable, str(SCRIPT), "--image", image],
                          input=json.dumps(response), capture_output=True, text=True)


class Render(unittest.TestCase):
    # TC-38-01: chỉ khóa trong allowlist, mọi trường chỉ-đọc và trường lạ bị loại
    def test_only_allowlisted_keys(self):
        p = run(RESPONSE, f"{REPO}:{NEW}")
        self.assertEqual(p.returncode, 0, p.stderr)
        out = json.loads(p.stdout)
        for gone in ("taskDefinitionArn", "revision", "status", "registeredAt", "registeredBy", "deregisteredAt",
                     "compatibilities", "requiresAttributes", "someFutureReadOnlyField"):
            self.assertNotIn(gone, out)
        for kept in ("family", "taskRoleArn", "executionRoleArn", "networkMode", "requiresCompatibilities",
                     "cpu", "memory", "runtimePlatform", "volumes", "placementConstraints", "containerDefinitions"):
            self.assertIn(kept, out)
        self.assertEqual(out["family"], "dbs-api")

    # TC-38-02: chỉ image của container api đổi; mọi thứ khác và tags (ở gốc phản hồi) giữ nguyên
    def test_only_api_image_changes(self):
        out = json.loads(run(RESPONSE, f"{REPO}:{NEW}").stdout)
        api, side = out["containerDefinitions"]
        self.assertEqual(api["image"], f"{REPO}:{NEW}")
        self.assertEqual(api["environment"], RESPONSE["taskDefinition"]["containerDefinitions"][0]["environment"])
        self.assertEqual(api["secrets"], RESPONSE["taskDefinition"]["containerDefinitions"][0]["secrets"])
        self.assertEqual(api["logConfiguration"], RESPONSE["taskDefinition"]["containerDefinitions"][0]["logConfiguration"])
        self.assertEqual(side, RESPONSE["taskDefinition"]["containerDefinitions"][1])
        self.assertEqual(out["tags"], RESPONSE["tags"])

    def test_empty_tags_are_omitted(self):
        resp = dict(RESPONSE, tags=[])
        self.assertNotIn("tags", json.loads(run(resp, f"{REPO}:{NEW}").stdout))

    # TC-38-03: lỗi thì không in gì ra stdout
    def assert_rejected(self, response, image):
        p = run(response, image)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(p.stdout, "")
        self.assertTrue(p.stderr.strip())

    def test_rejects_missing_api_container(self):
        resp = json.loads(json.dumps(RESPONSE))
        resp["taskDefinition"]["containerDefinitions"][0]["name"] = "web"
        self.assert_rejected(resp, f"{REPO}:{NEW}")

    def test_rejects_latest_and_bad_tags(self):
        for bad in ("latest", "abc123", "G" * 40, ""):
            self.assert_rejected(RESPONSE, f"{REPO}:{bad}")
        self.assert_rejected(RESPONSE, REPO)

    def test_rejects_garbage_input(self):
        p = subprocess.run([sys.executable, str(SCRIPT), "--image", f"{REPO}:{NEW}"], input="not json",
                           capture_output=True, text=True)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(p.stdout, "")

    # TC-68-10: --container chọn container được đổi image (family dbs-migrate)
    def test_container_option_changes_only_that_container(self):
        resp = json.loads(json.dumps(RESPONSE))
        resp["taskDefinition"]["containerDefinitions"] = [
            {"name": "migrate", "image": f"{REPO}:{OLD}", "essential": True, "command": ["node", "x", "migration:run"]}]
        p = subprocess.run([sys.executable, str(SCRIPT), "--image", f"{REPO}:{NEW}", "--container", "migrate"],
                           input=json.dumps(resp), capture_output=True, text=True)
        self.assertEqual(p.returncode, 0, p.stderr)
        c = json.loads(p.stdout)["containerDefinitions"][0]
        self.assertEqual((c["image"], c["command"]), (f"{REPO}:{NEW}", ["node", "x", "migration:run"]))

    def test_container_option_unknown_name_is_rejected(self):
        p = subprocess.run([sys.executable, str(SCRIPT), "--image", f"{REPO}:{NEW}", "--container", "migrate"],
                           input=json.dumps(RESPONSE), capture_output=True, text=True)
        self.assertNotEqual(p.returncode, 0)
        self.assertEqual(p.stdout, "")

    def test_default_container_is_still_api(self):
        p = subprocess.run([sys.executable, str(SCRIPT), "--image", f"{REPO}:{NEW}"],
                           input=json.dumps(RESPONSE), capture_output=True, text=True)
        self.assertEqual(json.loads(p.stdout)["containerDefinitions"][0]["image"], f"{REPO}:{NEW}")


if __name__ == "__main__":
    unittest.main(verbosity=2)
