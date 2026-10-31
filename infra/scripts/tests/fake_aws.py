#!/usr/bin/env python3
"""`aws` giả cho test của seed-cognito.sh (DBS-54). Giữ trạng thái trong $FAKE_STATE/state.json.

Ghi mỗi lời gọi (argv và stdin, nguyên byte) vào $FAKE_STATE/calls.jsonl. Tiêm lỗi bằng
FAKE_AWS_FAIL_ON=<lệnh>:<lần gọi thứ n> (đếm từ 1). Lỗi in đúng định dạng của AWS CLI v2 và thoát mã 254.
FAKE_SECRET_NO_VALUE=1: secret tồn tại nhưng chưa có phiên bản AWSCURRENT.
FAKE_GET_SECRET_ERROR=<mã lỗi>: get-secret-value luôn lỗi với mã đó (ví dụ AccessDeniedException).
"""
import base64
import json
import os
import sys

STATE_DIR = os.environ["FAKE_STATE"]
STATE = os.path.join(STATE_DIR, "state.json")
CALLS = os.path.join(STATE_DIR, "calls.jsonl")
STDIN_MARK = "file:///dev/stdin"


def load():
    if os.path.exists(STATE):
        with open(STATE) as f:
            return json.load(f)
    return {"secret": None, "users": {}, "counts": {}, "signouts": []}


def save(st):
    with open(STATE, "w") as f:
        json.dump(st, f)


def fail(code, op, msg="fake"):
    sys.stderr.write(f"\naws: [ERROR]: An error occurred ({code}) when calling the {op} operation: {msg}\n")
    sys.exit(254)


def parse(argv):
    opts, flags, pos = {}, set(), []
    i = 0
    while i < len(argv):
        a = argv[i]
        if a.startswith("--"):
            vals = []
            j = i + 1
            while j < len(argv) and not argv[j].startswith("--"):
                vals.append(argv[j])
                j += 1
            if vals:
                opts[a[2:]] = vals
            else:
                flags.add(a[2:])
            i = j
        else:
            pos.append(a)
            i += 1
    return opts, flags, pos


def main():
    argv = sys.argv[1:]
    service, op, rest = argv[0], argv[1], argv[2:]
    opts, flags, _ = parse(rest)
    stdin_bytes = None
    if any(STDIN_MARK in v for v in opts.values()):
        stdin_bytes = sys.stdin.buffer.read()
    with open(CALLS, "a") as f:
        f.write(json.dumps({
            "argv": argv,
            "stdin": base64.b64encode(stdin_bytes).decode() if stdin_bytes is not None else None,
        }) + "\n")

    st = load()
    n = st["counts"].get(op, 0) + 1
    st["counts"][op] = n
    fail_on = os.environ.get("FAKE_AWS_FAIL_ON", "")
    if fail_on == f"{op}:{n}":
        save(st)
        fail("InternalErrorException", op)

    def stdin_text():
        return stdin_bytes.decode()

    def user():
        return opts["username"][0]

    if service == "secretsmanager":
        if op == "get-secret-value":
            if os.environ.get("FAKE_GET_SECRET_ERROR"):
                fail(os.environ["FAKE_GET_SECRET_ERROR"], op)
            if st["secret"] is None or os.environ.get("FAKE_SECRET_NO_VALUE") == "1":
                fail("ResourceNotFoundException", op, "Secrets Manager can't find the specified secret.")
            print(st["secret"]["value"])
        elif op == "describe-secret":
            if st["secret"] is None and os.environ.get("FAKE_SECRET_NO_VALUE") != "1":
                fail("ResourceNotFoundException", op)
            print(json.dumps({"Name": "x"}))
        elif op == "create-secret":
            if st["secret"] is not None or os.environ.get("FAKE_SECRET_NO_VALUE") == "1":
                fail("ResourceExistsException", op, "already exists")
            st["secret"] = {"value": stdin_text(), "tags": opts.get("tags", [])}
        elif op == "put-secret-value":
            if st["secret"] is None:
                fail("ResourceNotFoundException", op)
            st["secret"]["value"] = stdin_text()
        else:
            fail("UnknownOperation", op)
    elif service == "cognito-idp":
        users = st["users"]
        if op == "admin-get-user":
            if user() not in users:
                fail("UserNotFoundException", op, "User does not exist.")
            print(json.dumps({"Username": user()}))
        elif op == "admin-create-user":
            if user() in users:
                fail("UsernameExistsException", op)
            users[user()] = {"password": None, "status": "FORCE_CHANGE_PASSWORD", "groups": [], "verified": False,
                             "message_action": (opts.get("message-action") or [None])[0]}
        elif op == "admin-set-user-password":
            if user() not in users:
                fail("UserNotFoundException", op)
            users[user()]["password"] = stdin_text()
            if "permanent" in flags:
                users[user()]["status"] = "CONFIRMED"
        elif op == "admin-add-user-to-group":
            if user() not in users:
                fail("UserNotFoundException", op)
            g = opts["group-name"][0]
            if g not in users[user()]["groups"]:
                users[user()]["groups"].append(g)
        elif op == "admin-remove-user-from-group":
            g = opts["group-name"][0]
            users[user()]["groups"] = [x for x in users[user()]["groups"] if x != g]
        elif op == "admin-list-groups-for-user":
            print("\t".join(users[user()]["groups"]))
        elif op == "admin-update-user-attributes":
            attrs = " ".join(opts.get("user-attributes", []))
            if "email_verified,Value=true" in attrs:
                users[user()]["verified"] = True
        elif op == "admin-user-global-sign-out":
            st["signouts"].append(user())
        else:
            fail("UnknownOperation", op)
    else:
        fail("UnknownService", op)
    save(st)


main()
