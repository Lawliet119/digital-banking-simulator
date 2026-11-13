#!/usr/bin/env python3
"""Test luồng của .github/scripts/run-trivy.sh với `docker` giả (DBS-155, TC-155-02, 09, 15 phần luồng).

Chạy: python3 .github/scripts/tests/test_run_trivy.py
Không cần Docker hay Trivy thật: một script `docker` giả ghi lại từng lệnh và trả mã thoát theo biến FAKE_FAIL
(save, download, gate, secret, info). Chứng minh thứ tự lệnh, cờ cách ly và cách gộp mã thoát; KHÔNG chứng minh
Trivy thật phát hiện gì (phần đó chỉ chạy được trên CI hoặc khi có Trivy).
"""
import os
import pathlib
import shutil
import stat
import subprocess
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "run-trivy.sh"
IMAGE = "ghcr.io/aquasecurity/trivy:0.76.1@sha256:" + "a" * 64

FAKE_DOCKER = r"""#!/usr/bin/env bash
echo "$*" >> "$FAKE_LOG"
case "$1" in
  save) [[ ",$FAKE_FAIL," == *,save,* ]] && exit 1; : > "$3"; exit 0 ;;
esac
if [[ "$*" == *--download-db-only* ]]; then [[ ",$FAKE_FAIL," == *,download,* ]] && exit 1; exit 0; fi
if [[ "$*" == *"--scanners secret"* ]]; then [[ ",$FAKE_FAIL," == *,secret,* ]] && exit 1; exit 0; fi
if [[ "$*" == *"--ignore-unfixed"* ]]; then [[ ",$FAKE_FAIL," == *,gate,* ]] && exit 1; exit 0; fi
if [[ "$*" == *"--scanners vuln"* ]]; then [[ ",$FAKE_FAIL," == *,info,* ]] && exit 1; exit 0; fi
exit 0
"""


def run(fail="", ignorefile=True):
    work = pathlib.Path(tempfile.mkdtemp())
    bindir = work / "bin"
    bindir.mkdir()
    fake = bindir / "docker"
    fake.write_text(FAKE_DOCKER)
    fake.chmod(fake.stat().st_mode | stat.S_IEXEC)
    cwd = work / "repo"
    cwd.mkdir()
    if ignorefile:
        (cwd / ".trivyignore.yaml").write_text("vulnerabilities: []\nsecrets: []\n")
    log = work / "docker.log"
    env = {
        **os.environ,
        "PATH": f"{bindir}:{os.environ['PATH']}",
        "FAKE_LOG": str(log),
        "FAKE_FAIL": fail,
        "TRIVY_IMAGE": IMAGE,
        "RUNNER_TEMP": str(work / "tmp"),
    }
    proc = subprocess.run(["bash", str(SCRIPT), "dbs-api:test"], capture_output=True, text=True, env=env, cwd=str(cwd))
    calls = log.read_text().splitlines() if log.exists() else []
    shutil.rmtree(work, ignore_errors=True)
    return proc.returncode, proc.stdout + proc.stderr, calls


class RunTrivy(unittest.TestCase):
    def test_all_clean_runs_save_download_and_three_scans(self):
        code, out, calls = run()
        self.assertEqual(code, 0, out)
        self.assertEqual(len(calls), 5, calls)
        self.assertTrue(calls[0].startswith("save -o "))
        self.assertIn("--download-db-only", calls[1])
        self.assertIn("--scanners vuln --severity HIGH,CRITICAL --ignore-unfixed --exit-code 1", calls[2])
        self.assertIn("--scanners secret --exit-code 1", calls[3])
        self.assertIn("--scanners vuln --severity HIGH,CRITICAL --exit-code 0", calls[4])

    def test_scans_are_isolated_from_network_and_socket(self):
        _, _, calls = run()
        for call in calls[2:]:
            self.assertIn("--network none", call)
            self.assertIn("--skip-db-update", call)
            self.assertIn("--skip-java-db-update", call)
            self.assertIn("--offline-scan", call)
            self.assertIn("--input /scan/img.tar", call)
            self.assertIn("--ignorefile /scan/.trivyignore.yaml", call)
            self.assertIn("img.tar:/scan/img.tar:ro", call)
            self.assertIn(".trivyignore.yaml:/scan/.trivyignore.yaml:ro", call)
        everything = "\n".join(calls)
        self.assertNotIn("docker.sock", everything)
        self.assertNotIn(" -e ", everything)           # không truyền biến môi trường của job vào container
        self.assertNotIn("--env", everything)
        self.assertIn(IMAGE, calls[2])                  # đúng image ghim digest

    def test_only_the_download_step_has_network(self):
        _, _, calls = run()
        self.assertNotIn("--network none", calls[1])

    def test_gate_failure_is_red_but_secret_pass_still_runs(self):
        code, out, calls = run(fail="gate")
        self.assertEqual(code, 1, out)
        self.assertTrue(any("--scanners secret" in c for c in calls), calls)

    def test_secret_failure_is_red(self):
        code, out, _ = run(fail="secret")
        self.assertEqual(code, 1, out)

    def test_both_failures_are_red(self):
        code, out, _ = run(fail="gate,secret")
        self.assertEqual(code, 1, out)

    def test_info_pass_failure_only_warns(self):
        code, out, _ = run(fail="info")
        self.assertEqual(code, 0, out)
        self.assertIn("::warning::", out)

    def test_download_failure_is_red_and_no_scan_runs(self):
        code, out, calls = run(fail="download")
        self.assertNotEqual(code, 0, out)
        self.assertFalse(any("--network none" in c for c in calls), calls)

    def test_save_failure_is_red(self):
        code, out, calls = run(fail="save")
        self.assertNotEqual(code, 0, out)
        self.assertEqual(len(calls), 1)

    def test_missing_ignorefile_stops_before_docker(self):
        code, out, calls = run(ignorefile=False)
        self.assertNotEqual(code, 0, out)
        self.assertEqual(calls, [])

    def test_missing_trivy_image_variable_stops(self):
        proc = subprocess.run(["bash", str(SCRIPT), "x"], capture_output=True, text=True,
                              env={k: v for k, v in os.environ.items() if k != "TRIVY_IMAGE"})
        self.assertNotEqual(proc.returncode, 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
