#!/usr/bin/env python3
"""Test của .gitleaks.toml, .gitleaksignore và .github/scripts/run-gitleaks.sh (DBS-155, TC-155-08, 10, 11, 12, 14, 16, 17).

Cần binary gitleaks 8.30.1 (cùng bản workflow ghim): đặt GITLEAKS_BIN=<đường dẫn tuyệt đối>.
Không có GITLEAKS_BIN thì mọi ca bị bỏ qua và in lý do (CI chạy chính gitleaks qua job secret-scan, không qua file này).

Chạy: GITLEAKS_BIN=/abs/path/gitleaks python3 .github/scripts/tests/test_gitleaks_config.py
Mọi repo thử nằm trong thư mục tạm; không đụng repo thật ngoài ca đọc lịch sử thật (chỉ đọc).
"""
import json
import os
import pathlib
import re
import secrets
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid

ROOT = pathlib.Path(__file__).resolve().parents[3]
SCRIPT = ROOT / ".github" / "scripts" / "run-gitleaks.sh"
GL = os.environ.get("GITLEAKS_BIN", "")
ENV = {
    **os.environ,
    "GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@t", "GIT_COMMITTER_NAME": "t", "GIT_COMMITTER_EMAIL": "t@t",
}
SERVER_KEY = ROOT / "backend" / "test" / "support" / "tls-fixtures" / "server.key"
MANUAL = "docs/features/screenshots/DBS-999/manual-test.txt"


def git(repo, *args):
    return subprocess.run(["git", "-C", str(repo), *args], capture_output=True, text=True, env=ENV, check=True).stdout


def new_repo(base):
    repo = pathlib.Path(base) / f"r{secrets.token_hex(3)}"
    repo.mkdir()
    git(repo, "init", "-q", "-b", "main")
    return repo


def commit_file(repo, rel, content, message="c"):
    path = repo / rel
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")
    git(repo, "add", "-f", rel)
    git(repo, "commit", "-qm", message)


def run_script(repo, config=True, **extra):
    """Chạy run-gitleaks.sh đúng như workflow (GITLEAKS_RUN là binary thay cho docker run)."""
    log = pathlib.Path(tempfile.mkdtemp()) / "gitleaks.log"
    env = {
        **ENV,
        "GITLEAKS_RUN": GL,
        "REPO_DIR": str(repo),
        "SCAN_PATH": str(repo),
        "CONFIG": str(ROOT / ".gitleaks.toml") if config else "",
        "IGNORE": str(ROOT / ".gitleaksignore") if config else "",
        "LOG": str(log),
        **extra,
    }
    proc = subprocess.run(["bash", str(SCRIPT)], capture_output=True, text=True, env=env, cwd=str(repo))
    return proc.returncode, proc.stdout + proc.stderr


def default_findings(repo):
    out = pathlib.Path(tempfile.mkdtemp()) / "r.json"
    subprocess.run([GL, "git", str(repo), "--no-banner", "--no-color", "--redact", "--exit-code", "0",
                    "--report-format", "json", "--report-path", str(out)], capture_output=True, env=ENV)
    return json.loads(out.read_text())


def visible_uuid(base):
    """UUID mà luật mặc định thấy ở mọi dạng dòng cần thử (bộ lọc entropy ẩn một số UUID)."""
    shapes = ["X-Api-Key: {u}", '{{"client-secret-key": "{u}"}}', "private.key={u}", "api_key={u}", "key={u}"]
    for _ in range(80):
        u = str(uuid.uuid4())
        repo = new_repo(base)
        for i, s in enumerate(shapes):
            (repo / f"f{i}.txt").write_text(s.format(u=u) + "\n")
        git(repo, "add", "-A")
        git(repo, "commit", "-qm", "p")
        if len(default_findings(repo)) == len(shapes):
            return u
    raise RuntimeError("không tìm được UUID mà luật mặc định thấy được")


@unittest.skipUnless(GL and os.path.isfile(GL), "bỏ qua: đặt GITLEAKS_BIN tới binary gitleaks 8.30.1")
class GitleaksConfig(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tmp = tempfile.mkdtemp()
        cls.uuid = visible_uuid(cls.tmp)
        cls.hex64 = secrets.token_hex(32)

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.tmp, ignore_errors=True)

    def repo_with_base(self):
        repo = new_repo(self.tmp)
        commit_file(repo, "ok.txt", "ok\n", "base")
        return repo

    # TC-155-12 (một phần), TC-155-08: lịch sử thật sạch, server.key không bị báo
    def test_real_history_is_clean(self):
        code, out = run_script(ROOT)
        self.assertEqual(code, 0, out)

    # TC-155-08: cấu hình có đúng hai allowlist, đúng dạng
    def test_config_has_two_allowlists(self):
        import tomllib
        data = tomllib.loads((ROOT / ".gitleaks.toml").read_text(encoding="utf-8"))
        lists = data["allowlists"]
        self.assertEqual(len(lists), 2)
        self.assertEqual(lists[0]["paths"], ["^backend/test/support/tls-fixtures/server\\.key$"])
        self.assertNotIn("targetRules", lists[0])
        self.assertEqual(lists[1]["targetRules"], ["generic-api-key"])
        self.assertEqual(lists[1]["condition"], "AND")
        self.assertEqual(lists[1]["regexTarget"], "match")
        self.assertIn("[0-9a-f]{8}-[0-9a-f]{4}", lists[1]["regexes"][0])
        self.assertTrue(lists[1]["regexes"][0].startswith("(?i)^"))

    # TC-155-10, TC-155-11
    def test_fake_secret_is_red_and_revert_stays_red(self):
        repo = self.repo_with_base()
        subprocess.run(["openssl", "genpkey", "-algorithm", "ed25519", "-out", str(repo / "tmp-fake.key")], check=True, capture_output=True)
        pem = (repo / "tmp-fake.key").read_text()
        (repo / "tmp-fake.key").unlink()
        commit_file(repo, "tmp/fake.key", pem, "fake secret")
        code, out = run_script(repo)
        self.assertEqual(code, 1, out)
        self.assertIn("REDACTED", out)
        self.assertNotIn(pem.splitlines()[1], out)  # không lộ thân khóa
        git(repo, "revert", "--no-edit", "HEAD")
        code, out = run_script(repo)
        self.assertEqual(code, 1, out)

    # TC-155-14 (a): bản sao server.key ở chỗ khác
    def test_server_key_copy_elsewhere_is_red(self):
        repo = self.repo_with_base()
        commit_file(repo, "backend/test/support/server-copy.key", SERVER_KEY.read_text())
        code, out = run_script(repo)
        self.assertEqual(code, 1, out)

    def test_server_key_at_its_allowlisted_path_is_green(self):
        repo = self.repo_with_base()
        commit_file(repo, "backend/test/support/tls-fixtures/server.key", SERVER_KEY.read_text())
        code, out = run_script(repo)
        self.assertEqual(code, 0, out)

    # TC-155-14 (b)…(h)
    def assert_line(self, rel, line, expect_code):
        repo = self.repo_with_base()
        commit_file(repo, rel, line + "\n")
        code, out = run_script(repo)
        self.assertEqual(code, expect_code, f"{rel!r} {line!r}\n{out}")

    def test_hex64_secret_in_manual_test_is_red(self):
        self.assert_line(MANUAL, f'secret = "{self.hex64}"', 1)

    def test_api_key_uuid_in_md_is_red(self):
        self.assert_line("docs/features/screenshots/DBS-999/notes.md", f'api_key = "{self.uuid}"', 1)

    def test_new_idempotency_key_forms_are_green(self):
        self.assert_line(MANUAL, f"POST /v1/transfers key={self.uuid} -> 201", 0)
        self.assert_line(MANUAL, f'{{"idempotencyKey":"{self.uuid}"}}', 0)
        self.assert_line(MANUAL, f'{{"key":"{self.uuid}"}}', 0)

    def test_header_and_other_key_names_are_red(self):
        self.assert_line(MANUAL, f"X-Api-Key: {self.uuid}", 1)
        self.assert_line(MANUAL, f'{{"client-secret-key": "{self.uuid}"}}', 1)
        self.assert_line(MANUAL, f"private.key={self.uuid}", 1)
        self.assert_line(MANUAL, f"api_key={self.uuid}", 1)

    def test_nested_key_is_known_residual(self):
        # TC-155-14 (h): khóa lồng được bỏ qua, ghi ở §1 câu 13 "hệ quả còn lại"
        self.assert_line(MANUAL, f'{{"secret":{{"key":"{self.uuid}"}}}}', 0)

    # TC-155-16: nhánh khác có secret, HEAD sạch
    def test_secret_on_other_branch_does_not_fail_head(self):
        repo = self.repo_with_base()
        git(repo, "switch", "-qc", "leak")
        commit_file(repo, "k.pem", SERVER_KEY.read_text(), "leak")
        git(repo, "switch", "-q", "main")
        commit_file(repo, "ok2.txt", "ok2\n", "main2")
        code, out = run_script(repo)
        self.assertEqual(code, 0, out)

    # TC-155-17: chặn xanh giả
    def test_shallow_clone_is_red(self):
        src = self.repo_with_base()
        commit_file(src, "b.txt", "b\n")
        dst = pathlib.Path(self.tmp) / f"shallow{secrets.token_hex(2)}"
        subprocess.run(["git", "clone", "-q", "--depth", "1", f"file://{src}", str(dst)], check=True, capture_output=True, env=ENV)
        code, out = run_script(dst)
        self.assertEqual(code, 1, out)
        self.assertIn("nông", out)

    def test_empty_commit_only_is_red(self):
        repo = new_repo(self.tmp)
        git(repo, "commit", "-q", "--allow-empty", "-m", "only-empty")
        code, out = run_script(repo)
        self.assertEqual(code, 1, out)

    def test_history_with_mode_only_and_rename_only_commits_stays_green(self):
        repo = self.repo_with_base()
        for i in range(40):
            commit_file(repo, f"f{i}.txt", f"{i}\n")
        commit_file(repo, "x.sh", "#!/bin/sh\n")
        git(repo, "update-index", "--chmod=+x", "x.sh")
        git(repo, "commit", "-qm", "mode-only")
        git(repo, "mv", "f0.txt", "g0.txt")
        git(repo, "commit", "-qm", "rename-only")
        git(repo, "commit", "-q", "--allow-empty", "-m", "empty")
        code, out = run_script(repo)
        self.assertEqual(code, 0, out)

    def test_merge_commit_history_stays_green(self):
        repo = self.repo_with_base()
        for i in range(40):
            commit_file(repo, f"f{i}.txt", f"{i}\n")
        git(repo, "switch", "-qc", "side")
        commit_file(repo, "s.txt", "s\n")
        git(repo, "switch", "-q", "main")
        commit_file(repo, "m.txt", "m\n")
        git(repo, "merge", "-q", "--no-ff", "side", "-m", "merge")
        code, out = run_script(repo)
        self.assertEqual(code, 0, out)

    def test_script_requires_log_opts_head_and_no_color(self):
        text = SCRIPT.read_text(encoding="utf-8")
        for needle in ('--log-opts="HEAD"', "--no-color", "--redact", "--exit-code 1", "is-shallow-repository"):
            self.assertIn(needle, text)


if __name__ == "__main__":
    if not GL:
        print("GITLEAKS_BIN chưa đặt: các ca sẽ bị bỏ qua", file=sys.stderr)
    unittest.main(verbosity=2)
