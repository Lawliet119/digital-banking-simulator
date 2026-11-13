#!/usr/bin/env python3
"""Test của .github/scripts/check-scan-exceptions.py (DBS-155, TC-155-06, 07).

Chạy: python3 .github/scripts/tests/test_check_scan_exceptions.py
Dùng thư viện chuẩn và PyYAML (cùng bản ghim với image.yml). Mỗi ca dựng ba file ngoại lệ trong thư mục tạm,
chạy script với --root và --today cố định, rồi đọc mã thoát và nội dung báo lỗi.
"""
import pathlib
import subprocess
import sys
import tempfile
import unittest

SCRIPT = pathlib.Path(__file__).resolve().parents[1] / "check-scan-exceptions.py"
TODAY = "2026-11-12"
OK_DATE = "2027-01-20"      # trong 90 ngày
PAST_DATE = "2026-11-11"    # hôm qua
FAR_DATE = "2027-02-11"     # hôm nay + 91 ngày
UUID_RE = r"[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}"
SHA = "a" * 40

TRIVY_OK = f"""\
vulnerabilities:
  - id: CVE-2099-00001
    paths: ["usr/local/lib/node_modules/npm/package.json"]
    statement: "Lý do cụ thể, #5 chấp nhận"
    expired_at: {OK_DATE}
secrets:
  - id: private-key
    paths: ["app/node_modules/x/test/fixture.key"]
    statement: "Khóa thử của package"
    expired_at: {OK_DATE}
"""
TRIVY_EMPTY = "vulnerabilities: []\nsecrets: []\n"

GITLEAKS_OK = f"""\
[extend]
useDefault = true

[[allowlists]]
description = "Khóa thử TLS, CA đã hủy khóa. Hạn xem lại: {OK_DATE}"
paths = ['''^backend/test/support/tls-fixtures/server\\.key$''']

[[allowlists]]
description = "Idempotency-Key trong log test thủ công. Hạn xem lại: {OK_DATE}"
targetRules = ["generic-api-key"]
condition = "AND"
regexTarget = "match"
regexes = ['''(?i)^"?(idempotency-?key|idem_key|key)"?\\s*[:=]\\s*"?{UUID_RE}["\\s]*$''']
paths = ['''^docs/features/screenshots/DBS-[0-9]+/manual-test[a-z-]*\\.txt$''']
"""

IGNORE_OK = f"""\
# Id container Valkey, không phải bí mật. Hạn xem lại: {OK_DATE}
{SHA}:docs/features/screenshots/DBS-40/manual-test.txt:generic-api-key:15
{SHA}:docs/features/screenshots/DBS-40/manual-test.txt:generic-api-key:30
# Giá trị thử trong spec. Hạn xem lại: {OK_DATE}
{SHA}:backend/src/config/compose-redis-url.spec.ts:generic-api-key:6
"""


def run(trivy=TRIVY_EMPTY, gitleaks=GITLEAKS_OK, ignore=IGNORE_OK):
    """Trả về (mã thoát, stdout+stderr). None nghĩa là không tạo file đó."""
    with tempfile.TemporaryDirectory() as tmp:
        root = pathlib.Path(tmp)
        for name, body in ((".trivyignore.yaml", trivy), (".gitleaks.toml", gitleaks), (".gitleaksignore", ignore)):
            if body is not None:
                (root / name).write_text(body, encoding="utf-8")
        proc = subprocess.run(
            [sys.executable, str(SCRIPT), "--root", str(root), "--today", TODAY],
            capture_output=True, text=True,
        )
        return proc.returncode, proc.stdout + proc.stderr


class CheckScanExceptions(unittest.TestCase):
    def assertFails(self, result, *needles):
        code, out = result
        self.assertEqual(code, 1, out)
        for n in needles:
            self.assertIn(n, out)

    # TC-155-06: đường thành công
    def test_valid_files_pass(self):
        code, out = run(trivy=TRIVY_OK)
        self.assertEqual(code, 0, out)

    def test_empty_trivyignore_and_no_gitleaksignore_pass(self):
        code, out = run(trivy=TRIVY_EMPTY, ignore=None)
        self.assertEqual(code, 0, out)

    # TC-155-07: Trivy
    def test_missing_trivyignore_fails(self):
        self.assertFails(run(trivy=None), ".trivyignore.yaml")

    def test_trivy_entry_missing_statement_fails(self):
        bad = TRIVY_OK.replace('    statement: "Lý do cụ thể, #5 chấp nhận"\n', "")
        self.assertFails(run(trivy=bad), "CVE-2099-00001", "statement")

    def test_trivy_secrets_entry_missing_statement_fails(self):
        bad = TRIVY_OK.replace('    statement: "Khóa thử của package"\n', "")
        self.assertFails(run(trivy=bad), "private-key", "statement")

    def test_trivy_entry_missing_expired_at_fails(self):
        bad = TRIVY_OK.replace(f"    expired_at: {OK_DATE}\n", "", 1)
        self.assertFails(run(trivy=bad), "CVE-2099-00001", "expired_at")

    def test_trivy_expired_fails(self):
        bad = TRIVY_OK.replace(OK_DATE, PAST_DATE, 1)
        self.assertFails(run(trivy=bad), "CVE-2099-00001", "hết hạn")

    def test_trivy_beyond_90_days_fails(self):
        bad = TRIVY_OK.replace(OK_DATE, FAR_DATE, 1)
        self.assertFails(run(trivy=bad), "CVE-2099-00001", "90 ngày")

    def test_trivy_exactly_90_days_passes(self):
        ok = TRIVY_OK.replace(OK_DATE, "2027-02-10")
        code, out = run(trivy=ok)
        self.assertEqual(code, 0, out)

    # TC-155-07: gitleaks.toml
    def test_gitleaks_description_without_date_fails(self):
        bad = GITLEAKS_OK.replace(f" Hạn xem lại: {OK_DATE}", "", 1)
        self.assertFails(run(gitleaks=bad), "Hạn xem lại")

    def test_gitleaks_description_missing_fails(self):
        bad = GITLEAKS_OK.replace(f'description = "Khóa thử TLS, CA đã hủy khóa. Hạn xem lại: {OK_DATE}"\n', "")
        self.assertFails(run(gitleaks=bad), "description")

    def test_gitleaks_date_expired_fails(self):
        bad = GITLEAKS_OK.replace(OK_DATE, PAST_DATE, 1)
        self.assertFails(run(gitleaks=bad), "hết hạn")

    def test_gitleaks_date_beyond_90_days_fails(self):
        bad = GITLEAKS_OK.replace(OK_DATE, FAR_DATE, 1)
        self.assertFails(run(gitleaks=bad), "90 ngày")

    def test_path_not_anchored_fails(self):
        bad = GITLEAKS_OK.replace("^backend/test/support/tls-fixtures/server\\.key$", "backend/test/support/tls-fixtures/server\\.key")
        self.assertFails(run(gitleaks=bad), "neo")

    def test_path_directory_fails(self):
        bad = GITLEAKS_OK.replace("^backend/test/support/tls-fixtures/server\\.key$", "^backend/test/support/tls-fixtures/")
        self.assertFails(run(gitleaks=bad), "neo")

    def test_wildcard_path_alone_fails(self):
        bad = GITLEAKS_OK + f"""
[[allowlists]]
description = "Quá rộng. Hạn xem lại: {OK_DATE}"
paths = ['''^docs/.+$''']
"""
        self.assertFails(run(gitleaks=bad), "ký tự đại diện")

    def test_match_all_path_alone_fails(self):
        bad = GITLEAKS_OK + f"""
[[allowlists]]
description = "Quá rộng. Hạn xem lại: {OK_DATE}"
paths = ['''^.+$''']
"""
        self.assertFails(run(gitleaks=bad), "ký tự đại diện")

    def test_wildcard_path_with_rule_regex_and_passes(self):
        # allowlist thứ hai của GITLEAKS_OK đã là ca này (targetRules, regexes, condition AND)
        code, out = run()
        self.assertEqual(code, 0, out)

    def test_wildcard_path_with_condition_or_fails(self):
        bad = GITLEAKS_OK.replace('condition = "AND"', 'condition = "OR"')
        self.assertFails(run(gitleaks=bad), "ký tự đại diện")

    def test_wildcard_path_without_regexes_fails(self):
        bad = GITLEAKS_OK.replace('targetRules = ["generic-api-key"]\n', "")
        self.assertFails(run(gitleaks=bad), "ký tự đại diện")

    def test_escaped_dot_is_literal(self):
        # server\.key là literal: không bị coi là ký tự đại diện
        only_literal = f"""[extend]
useDefault = true

[[allowlists]]
description = "Khóa thử. Hạn xem lại: {OK_DATE}"
paths = ['''^backend/test/support/tls-fixtures/server\\.key$''']
"""
        code, out = run(gitleaks=only_literal)
        self.assertEqual(code, 0, out)

    # TC-155-07: .gitleaksignore
    def test_fingerprint_without_comment_fails(self):
        bad = f"{SHA}:backend/x.spec.ts:generic-api-key:6\n"
        self.assertFails(run(ignore=bad), "backend/x.spec.ts", "lý do")

    def test_fingerprint_comment_without_date_fails(self):
        bad = f"# Chỉ có lý do\n{SHA}:backend/x.spec.ts:generic-api-key:6\n"
        self.assertFails(run(ignore=bad), "Hạn xem lại")

    def test_fingerprint_comment_expired_fails(self):
        bad = f"# Lý do. Hạn xem lại: {PAST_DATE}\n{SHA}:backend/x.spec.ts:generic-api-key:6\n"
        self.assertFails(run(ignore=bad), "hết hạn")

    def test_fingerprint_comment_beyond_90_days_fails(self):
        bad = f"# Lý do. Hạn xem lại: {FAR_DATE}\n{SHA}:backend/x.spec.ts:generic-api-key:6\n"
        self.assertFails(run(ignore=bad), "90 ngày")

    def test_blank_line_breaks_comment_group(self):
        bad = f"# Lý do. Hạn xem lại: {OK_DATE}\n{SHA}:backend/a.spec.ts:generic-api-key:6\n\n{SHA}:backend/b.spec.ts:generic-api-key:7\n"
        self.assertFails(run(ignore=bad), "backend/b.spec.ts")

    def test_fingerprint_bad_format_fails(self):
        bad = f"# Lý do. Hạn xem lại: {OK_DATE}\nnot-a-fingerprint\n"
        self.assertFails(run(ignore=bad), "not-a-fingerprint", "định dạng")

    def test_error_report_names_every_bad_entry(self):
        bad = TRIVY_OK.replace(OK_DATE, PAST_DATE)
        code, out = run(trivy=bad)
        self.assertEqual(code, 1)
        self.assertIn("CVE-2099-00001", out)
        self.assertIn("private-key", out)


if __name__ == "__main__":
    unittest.main(verbosity=2)
