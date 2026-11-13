#!/usr/bin/env python3
"""Kiểm ba file ngoại lệ của cổng quét (DBS-155, docs/features/DBS-155-ci-image-secret-scan.md H4):
.trivyignore.yaml, .gitleaks.toml, .gitleaksignore. Mỗi ngoại lệ phải có lý do và hạn xem lại,
hạn không được qua và không quá hôm nay + 90 ngày. Hạn qua là cố ý đỏ: #5 xem lại rồi gia hạn bằng PR.

Cần PyYAML (ghim ở workflow); tomllib có sẵn từ Python 3.11. Không cần mạng.

Chạy từ gốc repo: python3 .github/scripts/check-scan-exceptions.py
Tùy chọn cho test: --root <thư mục> --today YYYY-MM-DD
"""
import argparse
import datetime
import pathlib
import re
import sys
import tomllib

import yaml

MAX_DAYS = 90
DATE_RE = re.compile(r"Hạn xem lại:\s*(\d{4}-\d{2}-\d{2})")
FINGERPRINT_RE = re.compile(r"^[0-9a-f]{40}:[^:\s]+:[A-Za-z0-9_.-]+:\d+$")
WILDCARD_RE = re.compile(r"[.*+?\[({|]")


def parse_args():
    ap = argparse.ArgumentParser()
    ap.add_argument("--root", default=str(pathlib.Path(__file__).resolve().parents[2]))
    ap.add_argument("--today", default=None, help="YYYY-MM-DD (UTC), mặc định hôm nay")
    return ap.parse_args()


def check_date(label, value, today, errors):
    """value là datetime.date hoặc chuỗi YYYY-MM-DD; thêm lỗi nếu hết hạn hoặc quá 90 ngày."""
    if isinstance(value, datetime.datetime):
        value = value.date()
    if isinstance(value, str):
        try:
            value = datetime.date.fromisoformat(value)
        except ValueError:
            errors.append(f"{label}: ngày không hợp lệ: {value!r}")
            return
    if not isinstance(value, datetime.date):
        errors.append(f"{label}: hạn xem lại không phải ngày: {value!r}")
        return
    if value < today:
        errors.append(f"{label}: hết hạn {value} (hôm nay {today}); xem lại lý do rồi gia hạn bằng PR")
    elif value > today + datetime.timedelta(days=MAX_DAYS):
        errors.append(f"{label}: hạn {value} quá {MAX_DAYS} ngày kể từ hôm nay ({today})")


def check_trivy(path, today, errors):
    if not path.is_file():
        errors.append(f"{path.name}: thiếu file (phải có, tối thiểu 'vulnerabilities: []'; thiếu thì docker -v tạo thư mục rỗng)")
        return
    try:
        data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except yaml.YAMLError as exc:
        errors.append(f"{path.name}: YAML hỏng: {exc}")
        return
    if not isinstance(data, dict):
        errors.append(f"{path.name}: gốc phải là mapping")
        return
    for section in ("vulnerabilities", "secrets"):
        entries = data.get(section) or []
        if not isinstance(entries, list):
            errors.append(f"{path.name}: '{section}' phải là danh sách")
            continue
        for i, entry in enumerate(entries):
            name = entry.get("id") if isinstance(entry, dict) else None
            label = f"{path.name} {section}[{i}] {name or '?'}"
            if not isinstance(entry, dict) or not name:
                errors.append(f"{label}: thiếu id")
                continue
            if not str(entry.get("statement") or "").strip():
                errors.append(f"{label}: thiếu statement (lý do)")
            if "expired_at" not in entry or entry["expired_at"] is None:
                errors.append(f"{label}: thiếu expired_at (hạn xem lại)")
            else:
                check_date(label, entry["expired_at"], today, errors)


def path_problems(pattern, allowlist):
    """Trả về danh sách lỗi cho một mục paths của allowlist gitleaks."""
    out = []
    if not (pattern.startswith("^") and pattern.endswith("$")):
        out.append(f"path {pattern!r} chưa neo ^…$ (không allowlist theo chuỗi con hay cả thư mục)")
        return out
    body = pattern[1:-1]
    literal_stripped = re.sub(r"\\.", "", body)  # bỏ các ký tự đã escape: \. là literal
    if WILDCARD_RE.search(literal_stripped):
        guarded = (
            allowlist.get("targetRules")
            and allowlist.get("regexes")
            and str(allowlist.get("condition", "")).upper() == "AND"
        )
        if not guarded:
            out.append(
                f"path {pattern!r} có ký tự đại diện nhưng allowlist không có targetRules + regexes + condition = \"AND\""
                " (path rộng chỉ được khi có luật và regex ràng buộc)"
            )
    return out


def check_gitleaks_toml(path, today, errors):
    if not path.is_file():
        errors.append(f"{path.name}: thiếu file")
        return
    try:
        data = tomllib.loads(path.read_text(encoding="utf-8"))
    except tomllib.TOMLDecodeError as exc:
        errors.append(f"{path.name}: TOML hỏng: {exc}")
        return
    lists = list(data.get("allowlists", []))
    if isinstance(data.get("allowlist"), dict):
        lists.append(data["allowlist"])
    for i, al in enumerate(lists):
        label = f"{path.name} allowlists[{i}]"
        desc = al.get("description")
        if not desc or not str(desc).strip():
            errors.append(f"{label}: thiếu description (lý do)")
        else:
            m = DATE_RE.search(str(desc))
            if not m:
                errors.append(f"{label}: description thiếu 'Hạn xem lại: YYYY-MM-DD'")
            else:
                check_date(label, m.group(1), today, errors)
        for pattern in al.get("paths", []):
            for problem in path_problems(pattern, al):
                errors.append(f"{label}: {problem}")


def check_gitleaksignore(path, today, errors):
    if not path.is_file():
        return  # không bắt buộc
    comment_ok = False  # nhóm fingerprint liền nhau dùng chung dòng # ngay trên
    comment_text = ""
    for n, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), start=1):
        line = raw.strip()
        label = f"{path.name}:{n}"
        if not line:
            comment_ok, comment_text = False, ""
            continue
        if line.startswith("#"):
            comment_text = line
            m = DATE_RE.search(line)
            comment_ok = bool(m)
            if m:
                check_date(label, m.group(1), today, errors)
            continue
        if not FINGERPRINT_RE.match(line):
            errors.append(f"{label}: sai định dạng fingerprint (commit:file:rule:line): {line}")
            continue
        if not comment_text:
            errors.append(f"{label}: fingerprint {line.split(':')[1]} thiếu dòng # lý do ngay trên")
        elif not comment_ok:
            errors.append(f"{label}: dòng # lý do của {line.split(':')[1]} thiếu 'Hạn xem lại: YYYY-MM-DD'")


def main():
    args = parse_args()
    root = pathlib.Path(args.root)
    today = datetime.date.fromisoformat(args.today) if args.today else datetime.datetime.now(datetime.timezone.utc).date()
    errors = []
    check_trivy(root / ".trivyignore.yaml", today, errors)
    check_gitleaks_toml(root / ".gitleaks.toml", today, errors)
    check_gitleaksignore(root / ".gitleaksignore", today, errors)
    if errors:
        print("FAIL:")
        for e in errors:
            print(" -", e)
        return 1
    print("OK")
    return 0


if __name__ == "__main__":
    sys.exit(main())
