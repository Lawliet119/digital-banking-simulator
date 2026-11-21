#!/usr/bin/env python3
"""Delta của hai ảnh chụp `pg_stat_statements` (BL-420): thời gian và số buffer mỗi lần gọi trong khoảng giữa hai ảnh.

Dùng: python3 infra/scripts/pgss_delta.py <ảnh đầu> <ảnh cuối>

Đọc hai định dạng: file của `pgss.sh snapshot` (dòng `SQL> …` rồi một dòng JSON) và file cũ của các phiên DBS-166/173
(`aws … --output text`, JSON nằm sau một ký tự tab). In mỗi câu lệnh có thêm lần gọi trong khoảng, sắp theo thời gian giảm dần.
Chỉ dùng thư viện chuẩn.
"""
import json
import re
import sys


def load(path):
    text = open(path, encoding="utf8").read()
    rows = None
    # New format: the first line that is a JSON array of rows, after the `SQL>` line.
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("[{") and line.endswith("}]"):
            rows = json.loads(line)
            break
    if rows is None:
        # Old format: tab-separated, the JSON follows a tab and ends before the next `SQL>`.
        match = re.search(r"\t(\[\{.*\}\])\t?", text, re.S)
        if match:
            rows = json.loads(match.group(1).split("\tSQL>")[0])
    if rows is None:
        raise SystemExit(f"{path}: no pg_stat_statements rows found")
    return {r["queryid"]: r for r in rows}


def main(argv):
    if len(argv) != 3:
        raise SystemExit("Usage: pgss_delta.py <first snapshot> <last snapshot>")
    first, last = load(argv[1]), load(argv[2])
    out = []
    for queryid, row in last.items():
        before = first.get(queryid)
        calls = int(row["calls"]) - (int(before["calls"]) if before else 0)
        total = float(row["total_ms"]) - (float(before["total_ms"]) if before else 0.0)
        hit = int(row["hit"]) - (int(before["hit"]) if before else 0)
        if calls <= 0:
            continue
        out.append((total, row["role"], calls, total, hit, " ".join(row["q"].split())[:70]))
    out.sort(reverse=True)
    print(f"{'role':11} {'calls':>7} {'delta_s':>8} {'mean_ms':>8} {'buf/call':>9}  query")
    for _, role, calls, total, hit, query in out:
        print(f"{role:11} {calls:>7} {total / 1000:>8.1f} {total / calls:>8.2f} {hit / calls:>9.1f}  {query}")


if __name__ == "__main__":
    main(sys.argv)
