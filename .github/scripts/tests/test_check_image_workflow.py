#!/usr/bin/env python3
"""Test kiểm tĩnh cổng quét của .github/scripts/check-image-workflow.py (DBS-155, TC-155-01..04).

Chạy: python3 .github/scripts/tests/test_check_image_workflow.py
Cần PyYAML. Mỗi ca copy các file thật vào thư mục tạm, sửa một chỗ, chạy script với
CHECK_IMAGE_WORKFLOW_ROOT trỏ vào đó: cây thật phải `OK`, mỗi chỗ sửa phải `FAIL` (mã thoát 1).
"""
import os
import pathlib
import shutil
import subprocess
import sys
import tempfile
import unittest

REAL = pathlib.Path(__file__).resolve().parents[3]
SCRIPT = REAL / ".github" / "scripts" / "check-image-workflow.py"
COPY = [
    ".github/workflows/ci.yml",
    ".github/workflows/image.yml",
    ".github/workflows/deploy.yml",
    ".github/scripts/run-gitleaks.sh",
    ".github/scripts/run-trivy.sh",
    "infra/terraform/envs/dev/session/ecs.tf",
    "infra/terraform/envs/dev/session/worker.tf",
]
TRIVY_DIGEST = "sha256:790fd66d1697395d8693d1acaa1ea702406a20f109b6fc7bac8db623eca6c06c"


class Tree:
    """Bản sao có thể sửa của các file mà script kiểm đọc."""

    def __init__(self):
        self.dir = pathlib.Path(tempfile.mkdtemp())
        for rel in COPY:
            dst = self.dir / rel
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copy(REAL / rel, dst)

    def edit(self, rel, old, new, count=1):
        path = self.dir / rel
        text = path.read_text(encoding="utf-8")
        assert text.count(old) >= 1, f"fixture hỏng: không thấy {old!r} trong {rel}"
        path.write_text(text.replace(old, new) if count == 0 else text.replace(old, new, count), encoding="utf-8")

    def run(self):
        env = {**os.environ, "CHECK_IMAGE_WORKFLOW_ROOT": str(self.dir)}
        proc = subprocess.run([sys.executable, str(SCRIPT)], capture_output=True, text=True, env=env)
        return proc.returncode, proc.stdout + proc.stderr

    def cleanup(self):
        shutil.rmtree(self.dir, ignore_errors=True)


class ScanGates(unittest.TestCase):
    def tree(self):
        t = Tree()
        self.addCleanup(t.cleanup)
        return t

    def assertRed(self, t, *needles):
        code, out = t.run()
        self.assertEqual(code, 1, out)
        self.assertIn("FAIL", out)
        for n in needles:
            self.assertIn(n, out)

    # TC-155-01…03: cây thật
    def test_real_tree_passes(self):
        code, out = self.tree().run()
        self.assertEqual(code, 0, out)
        self.assertIn("OK", out)

    # TC-248-10: service worker phải có ignore_changes (deploy.sh lăn worker, BL-248)
    def test_worker_service_without_ignore_changes(self):
        t = self.tree()
        t.edit("infra/terraform/envs/dev/session/worker.tf", "ignore_changes = [task_definition]", "ignore_changes = [desired_count]")
        self.assertRed(t, "worker.tf")

    # TC-245-04: kiểm cosign của image Trivy (BL-245)
    def test_ci_without_cosign_installer(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", "sigstore/cosign-installer@756fe2d284c7292c4e9b62c8a28f1e5629c59532", "actions/setup-node@" + "a" * 40)
        self.assertRed(t, "ci.yml job image-scan", "cosign-installer")

    def test_image_cosign_installer_unpinned_or_after_trivy(self):
        t = self.tree()
        t.edit(".github/workflows/image.yml", "sigstore/cosign-installer@756fe2d284c7292c4e9b62c8a28f1e5629c59532", "sigstore/cosign-installer@v4")
        self.assertRed(t, "image.yml job image-push", "cosign-installer")

    def test_run_trivy_without_cosign_verify(self):
        t = self.tree()
        t.edit(".github/scripts/run-trivy.sh", "cosign verify", "cosign version", count=0)
        self.assertRed(t, "cosign verify")

    def test_skip_cosign_variable_in_workflow_is_rejected(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", "      TRIVY_IMAGE:", "      TRIVY_SKIP_COSIGN: '1'\n      TRIVY_IMAGE:")
        self.assertRed(t, "TRIVY_SKIP_COSIGN")

    # TC-155-04: ci.yml
    def test_job_image_scan_missing(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", "  image-scan:\n    name: image-scan\n", "  image-scan-x:\n    name: image-scan-x\n")
        self.assertRed(t, "image-scan")

    def test_job_secret_scan_missing(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", "  secret-scan:\n    name: secret-scan\n", "  secret-scan-x:\n    name: secret-scan-x\n")
        self.assertRed(t, "secret-scan")

    def test_job_name_collides_with_contract(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", "    name: image-scan\n", "    name: build\n")
        self.assertRed(t, "build")

    def test_missing_working_directory(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", "    timeout-minutes: 15\n    defaults:\n      run:\n        working-directory: .\n", "    timeout-minutes: 15\n")
        self.assertRed(t, "working-directory")

    def test_missing_timeout(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", "    timeout-minutes: 10\n    defaults:", "    defaults:")
        self.assertRed(t, "timeout-minutes")

    def test_id_token_requested(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", "  secret-scan:\n    name: secret-scan\n", "  secret-scan:\n    name: secret-scan\n    permissions:\n      id-token: write\n")
        self.assertRed(t, "id-token")

    def test_checkout_keeps_credentials(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", "          fetch-depth: 0\n          persist-credentials: false\n", "          fetch-depth: 0\n          persist-credentials: true\n")
        self.assertRed(t, "persist-credentials")

    def test_secret_scan_not_full_history(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", "          fetch-depth: 0\n", "")
        self.assertRed(t, "fetch-depth")

    def test_tool_image_pinned_by_tag_only(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", "ghcr.io/aquasecurity/trivy:0.76.1@" + TRIVY_DIGEST, "ghcr.io/aquasecurity/trivy:0.76.1")
        self.assertRed(t, "digest")

    def test_tool_image_from_docker_hub(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", "ghcr.io/gitleaks/gitleaks:v8.30.1@", "zricethezav/gitleaks:v8.30.1@")
        self.assertRed(t, "ghcr.io")

    def test_action_not_pinned_to_sha(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", "      - run: npm run build\n", "      - run: npm run build\n      - uses: actions/checkout@v4\n")
        self.assertRed(t, "ghim")

    def test_secret_scan_does_not_run_static_check(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", '          "$RUNNER_TEMP/venv/bin/python" .github/scripts/check-image-workflow.py\n', "")
        self.assertRed(t, "check-image-workflow.py")

    def test_secret_scan_does_not_run_exception_check(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", '          "$RUNNER_TEMP/venv/bin/python" .github/scripts/check-scan-exceptions.py\n', "")
        self.assertRed(t, "check-scan-exceptions.py")

    def test_secret_scan_does_not_run_gitleaks(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", "          bash .github/scripts/run-gitleaks.sh\n", "          true\n")
        self.assertRed(t, "run-gitleaks.sh")

    def test_image_scan_does_not_run_trivy(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", "        run: bash .github/scripts/run-trivy.sh dbs-api:scan\n", "        run: true\n")
        self.assertRed(t, "run-trivy.sh")

    def test_docker_sock_in_workflow(self):
        t = self.tree()
        t.edit(".github/workflows/ci.yml", "        run: docker build --provenance=false --sbom=false -t dbs-api:scan backend\n",
               "        run: docker run -v /var/run/docker.sock:/var/run/docker.sock x\n")
        self.assertRed(t, "docker.sock")

    # TC-155-04: run-gitleaks.sh
    def test_gitleaks_without_no_color(self):
        t = self.tree()
        t.edit(".github/scripts/run-gitleaks.sh", "--no-color ", "")
        self.assertRed(t, "--no-color")

    def test_gitleaks_without_redact(self):
        t = self.tree()
        t.edit(".github/scripts/run-gitleaks.sh", "--redact ", "")
        self.assertRed(t, "--redact")

    def test_gitleaks_exit_code_zero(self):
        t = self.tree()
        t.edit(".github/scripts/run-gitleaks.sh", "--exit-code 1", "--exit-code 0")
        self.assertRed(t, "--exit-code")

    def test_gitleaks_log_opts_missing(self):
        t = self.tree()
        t.edit(".github/scripts/run-gitleaks.sh", ' --log-opts="HEAD"', "")
        self.assertRed(t, "--log-opts")

    def test_gitleaks_log_opts_head_minus_3(self):
        t = self.tree()
        t.edit(".github/scripts/run-gitleaks.sh", '--log-opts="HEAD"', '--log-opts="HEAD~3"')
        self.assertRed(t, "--log-opts")

    def test_gitleaks_log_opts_origin_main(self):
        t = self.tree()
        t.edit(".github/scripts/run-gitleaks.sh", '--log-opts="HEAD"', '--log-opts="origin/main"')
        self.assertRed(t, "--log-opts")

    def test_gitleaks_log_opts_correct_only_in_comment(self):
        t = self.tree()
        t.edit(".github/scripts/run-gitleaks.sh", 'git "$SCAN_PATH" --log-opts="HEAD"',
               '# dùng --log-opts="HEAD"\n"${runner[@]}" git "$SCAN_PATH" --log-opts="origin/main"', count=1)
        # dòng chạy thật vẫn còn một bản `"${runner[@]}" git ...` đứng trước nên xóa bản gốc để chỉ còn lệnh sai
        path = t.dir / ".github/scripts/run-gitleaks.sh"
        text = path.read_text(encoding="utf-8")
        text = text.replace('"${runner[@]}" # dùng', "# dùng", 1)
        path.write_text(text, encoding="utf-8")
        self.assertRed(t, "--log-opts")

    # TC-155-04: run-trivy.sh
    def test_trivy_without_ignore_unfixed(self):
        t = self.tree()
        t.edit(".github/scripts/run-trivy.sh", " --ignore-unfixed", "")
        self.assertRed(t, "--ignore-unfixed")

    def test_trivy_gate_exit_code_zero(self):
        t = self.tree()
        t.edit(".github/scripts/run-trivy.sh", "--severity HIGH,CRITICAL --ignore-unfixed --exit-code 1", "--severity HIGH,CRITICAL --ignore-unfixed --exit-code 0")
        self.assertRed(t, "--exit-code")

    def test_trivy_secret_pass_filtered_by_severity(self):
        t = self.tree()
        t.edit(".github/scripts/run-trivy.sh", "--scanners secret --exit-code 1", "--scanners secret --severity HIGH,CRITICAL --exit-code 1")
        self.assertRed(t, "secret")

    def test_trivy_secret_pass_missing(self):
        t = self.tree()
        t.edit(".github/scripts/run-trivy.sh", "scan --scanners secret --exit-code 1 || rc=1\n", "")
        self.assertRed(t, "secret")

    def test_trivy_with_network(self):
        t = self.tree()
        t.edit(".github/scripts/run-trivy.sh", "--network none ", "")
        self.assertRed(t, "--network none")

    def test_trivy_without_java_db_skip(self):
        t = self.tree()
        t.edit(".github/scripts/run-trivy.sh", " --skip-java-db-update", "")
        self.assertRed(t, "--skip-java-db-update")

    def test_trivy_without_ignorefile(self):
        t = self.tree()
        t.edit(".github/scripts/run-trivy.sh", " --ignorefile /scan/.trivyignore.yaml", "")
        self.assertRed(t, "--ignorefile")

    def test_trivy_without_offline_scan(self):
        t = self.tree()
        t.edit(".github/scripts/run-trivy.sh", " --offline-scan", "")
        self.assertRed(t, "--offline-scan")

    def test_trivy_script_mounts_docker_sock(self):
        t = self.tree()
        t.edit(".github/scripts/run-trivy.sh", "docker run --rm --network none ", "docker run --rm --network none -v /var/run/docker.sock:/var/run/docker.sock ")
        self.assertRed(t, "docker.sock")

    # TC-155-03: image.yml, thứ tự bước
    def test_trivy_after_aws_credentials(self):
        t = self.tree()
        path = t.dir / ".github/workflows/image.yml"
        text = path.read_text(encoding="utf-8")
        trivy = '      - name: Trivy chặn lỗ hổng và secret\n        run: bash .github/scripts/run-trivy.sh "dbs-api:$IMAGE_TAG"\n\n'
        self.assertIn(trivy, text)
        text = text.replace(trivy, "")
        marker = "      - id: ecr\n"
        text = text.replace(marker, trivy + marker, 1)
        path.write_text(text, encoding="utf-8")
        self.assertRed(t, "configure-aws-credentials")

    def test_trivy_after_push(self):
        t = self.tree()
        path = t.dir / ".github/workflows/image.yml"
        text = path.read_text(encoding="utf-8")
        trivy = '      - name: Trivy chặn lỗ hổng và secret\n        run: bash .github/scripts/run-trivy.sh "dbs-api:$IMAGE_TAG"\n\n'
        text = text.replace(trivy, "")
        marker = "      # Scan on push chạy ở phía ECR"
        text = text.replace(marker, trivy + marker, 1)
        path.write_text(text, encoding="utf-8")
        self.assertRed(t, "configure-aws-credentials")

    def test_image_workflow_without_trivy_step(self):
        t = self.tree()
        t.edit(".github/workflows/image.yml", '        run: bash .github/scripts/run-trivy.sh "dbs-api:$IMAGE_TAG"\n', "        run: true\n")
        self.assertRed(t, "run-trivy.sh")

    def test_image_workflow_trivy_image_not_pinned(self):
        t = self.tree()
        t.edit(".github/workflows/image.yml", "ghcr.io/aquasecurity/trivy:0.76.1@" + TRIVY_DIGEST, "ghcr.io/aquasecurity/trivy:0.76.1")
        self.assertRed(t, "digest")


if __name__ == "__main__":
    unittest.main(verbosity=2)
