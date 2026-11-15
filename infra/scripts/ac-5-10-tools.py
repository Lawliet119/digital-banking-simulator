#!/usr/bin/env python3
"""Công cụ JSON cho kịch bản AC-5.10 (DBS-185); chỉ dùng thư viện chuẩn, chạy trong container `dbs-awscli`.

  overrides --mode slow-on|slow-off|watch|probe [--env K=V ...]   in JSON cho `aws ecs run-task --overrides`: chạy ac-5-10-db.js bằng
                                                `node -e` trong container `migrate` của task `dbs-migrate`
  overrides --command CMD [ARG ...]             như trên nhưng ghi đè lệnh khác (ví dụ invariants.js)
  evaluate --watch-log F --task-json F --container NAME --client-code C --client-has-correlation yes|no [--sleep-seconds N]
                                                kết luận «lần chạy hợp lệ» (§2 của DBS-185) từ nhật ký của `watch`, mô tả task
                                                api bị dừng và phản hồi của client; thoát 0 nếu hợp lệ, 3 nếu không
  taskdef --container NAME [--env K=V ...] [--stop-timeout N]
                                                đọc kết quả `aws ecs describe-task-definition` từ stdin, in đầu vào hợp
                                                lệ cho `aws ecs register-task-definition`: bỏ trường chỉ-đọc, chỉ đổi các
                                                biến môi trường và stopTimeout của container được chọn
"""
import argparse
import datetime
import json
import pathlib
import sys

HERE = pathlib.Path(__file__).resolve().parent
DB_JS = HERE / "ac-5-10-db.js"
OVERRIDES_LIMIT = 8192  # ECS: phần ghi đè của run-task tối đa 8 192 ký tự
CONTAINER = "migrate"

# Chỉ các trường này của task definition được đưa vào register-task-definition.
REGISTER_KEYS = (
    "family", "taskRoleArn", "executionRoleArn", "networkMode", "containerDefinitions", "volumes",
    "placementConstraints", "requiresCompatibilities", "cpu", "memory", "pidMode", "ipcMode",
    "proxyConfiguration", "inferenceAccelerators", "ephemeralStorage", "runtimePlatform",
)


def fail(msg):
    sys.stderr.write(f"ac-5-10-tools: {msg}\n")
    sys.exit(2)


def parse_env(pairs):
    out = []
    for p in pairs or []:
        if "=" not in p:
            fail(f"--env cần dạng NAME=VALUE: {p.split('=')[0]}")
        k, v = p.split("=", 1)
        out.append({"name": k, "value": v})
    return out


def inline_script():
    """Bỏ dòng chú thích đầy đủ và dòng trống để vừa giới hạn 8 KiB."""
    lines = [ln for ln in DB_JS.read_text(encoding="utf-8").splitlines() if ln.strip() and not ln.lstrip().startswith("//")]
    return "\n".join(lines)


def cmd_overrides(args):
    if bool(args.mode) == bool(args.command):
        fail("chọn đúng một trong --mode và --command")
    env = parse_env(args.env)
    if args.mode:
        if args.mode not in ("slow-on", "slow-off", "watch", "probe"):
            fail("--mode phải là slow-on, slow-off, watch hoặc probe")
        command = ["node", "-e", inline_script()]
        env = [{"name": "MODE", "value": args.mode}] + env
    else:
        command = args.command
    co = {"name": CONTAINER, "command": command}
    if env:
        co["environment"] = env
    text = json.dumps({"containerOverrides": [co]}, ensure_ascii=False, separators=(",", ":"))
    if len(text) > OVERRIDES_LIMIT:
        fail(f"phần ghi đè dài {len(text)} ký tự, quá giới hạn {OVERRIDES_LIMIT} của ECS")
    print(text)


def cmd_taskdef(args):
    try:
        doc = json.load(sys.stdin)
    except json.JSONDecodeError:
        fail("stdin không phải JSON của describe-task-definition")
    td = doc.get("taskDefinition", doc)
    out = {k: td[k] for k in REGISTER_KEYS if k in td}
    containers = json.loads(json.dumps(out.get("containerDefinitions", [])))
    target = next((c for c in containers if c.get("name") == args.container), None)
    if target is None:
        fail(f"không có container tên {args.container}")
    if args.stop_timeout is not None:
        if not 2 <= args.stop_timeout <= 120:
            fail("--stop-timeout phải từ 2 tới 120 giây")
        target["stopTimeout"] = args.stop_timeout
    env = {e["name"]: e["value"] for e in target.get("environment", [])}
    order = [e["name"] for e in target.get("environment", [])]
    for e in parse_env(args.env):
        if e["name"] not in env:
            order.append(e["name"])
        env[e["name"]] = e["value"]
    if order:
        target["environment"] = [{"name": n, "value": env[n]} for n in order]
    out["containerDefinitions"] = containers
    print(json.dumps(out, ensure_ascii=False))


def to_epoch(value):
    """AWS CLI v1 in số giây epoch, v2 in chuỗi ISO 8601; nhật ký của `hold` dùng ISO 8601 UTC."""
    if value is None:
        return None
    if isinstance(value, (int, float)):
        return float(value)
    return datetime.datetime.fromisoformat(str(value).replace("Z", "+00:00")).timestamp()


def cmd_evaluate(args):
    events = []
    for line in pathlib.Path(args.watch_log).read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line.startswith("{"):
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    ready = next((e for e in events if e.get("event") == "READY"), None)
    samples = [e for e in events if e.get("event") == "sample"]
    done = any(e.get("event") == "DONE" for e in events)
    task = json.loads(pathlib.Path(args.task_json).read_text(encoding="utf-8"))
    reasons = []
    out = {"inflightPid": None}
    if ready is None:
        reasons.append("NO_READY")
    required = ("idempotency_keys:RowExclusiveLock", "transfers:RowExclusiveLock", "ledger_entries:RowExclusiveLock")

    def mid(sample):  # backend giữa transaction = giữ đủ ba khóa; job dọn dẹp của worker chỉ giữ idempotency_keys
        return [b for b in sample.get("inflight", []) if all(n in b.get("locks", "") for n in required)]

    first = next((i for i, e in enumerate(samples) if mid(e)), None)
    if first is None:
        reasons.append("NOT_MID_TRANSACTION" if any(e.get("inflight") for e in samples) else "NO_INFLIGHT")
    elif ready is not None:
        w1 = to_epoch(samples[first]["t"])
        s0 = to_epoch(samples[first - 1]["t"]) if first > 0 else to_epoch(ready["t"])
        backend = mid(samples[first])[0]
        out.update({"inflightPid": backend["pid"], "locks": backend.get("locks", ""), "readyAt": ready["t"],
                    "W1": samples[first]["t"], "S0": samples[first - 1]["t"] if first > 0 else ready["t"]})
        if w1 - to_epoch(ready["t"]) > 30:
            reasons.append("W1_TOO_LATE")
        exec_stopped = to_epoch(task.get("executionStoppedAt"))
        out["executionStoppedAt"] = task.get("executionStoppedAt")
        out["killAfterS0Seconds"] = None if exec_stopped is None else round(exec_stopped - s0, 3)
        if exec_stopped is None or exec_stopped >= s0 + args.sleep_seconds - 10:
            reasons.append("KILL_TOO_LATE")
    if not done:
        reasons.append("NO_DONE")
    elif samples and mid(samples[-1]):
        reasons.append("ORPHAN_STILL_PRESENT")
    container = next((c for c in task.get("containers", []) if c.get("name") == args.container), {})
    out["exitCode"] = container.get("exitCode")
    if container.get("exitCode") != 137:
        reasons.append("EXIT_NOT_137")
    if args.client_code not in ("502", "503", "504", "000"):
        reasons.append("CLIENT_CODE")
    if args.client_has_correlation == "yes":
        reasons.append("CLIENT_HAS_CORRELATION")
    out.update({"valid": not reasons, "reasons": reasons, "clientCode": args.client_code})
    print(json.dumps(out, ensure_ascii=False))
    sys.exit(0 if not reasons else 3)


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    o = sub.add_parser("overrides")
    o.add_argument("--mode")
    o.add_argument("--env", action="append")
    o.add_argument("--command", nargs="+")
    o.set_defaults(fn=cmd_overrides)
    e = sub.add_parser("evaluate")
    e.add_argument("--watch-log", required=True)
    e.add_argument("--sleep-seconds", type=int, default=115)
    e.add_argument("--task-json", required=True)
    e.add_argument("--container", required=True)
    e.add_argument("--client-code", required=True)
    e.add_argument("--client-has-correlation", choices=("yes", "no"), required=True)
    e.set_defaults(fn=cmd_evaluate)
    t = sub.add_parser("taskdef")
    t.add_argument("--container", required=True)
    t.add_argument("--env", action="append")
    t.add_argument("--stop-timeout", type=int)
    t.set_defaults(fn=cmd_taskdef)
    args = ap.parse_args()
    args.fn(args)


if __name__ == "__main__":
    main()
