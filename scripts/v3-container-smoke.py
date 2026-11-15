#!/usr/bin/env python3
"""Container acceptance with synthetic identity and an internal-only network.

Never reads real credentials, never uses a production volume, never contacts HDU.
Requires Docker, Python 3.9+. Evidence survives failure; test resources are removed.
"""
import argparse
import base64
from datetime import datetime, timedelta
import json
import os
from pathlib import Path
import secrets
import sqlite3
import subprocess
import tempfile
import time
import urllib.error
import urllib.request
from zoneinfo import ZoneInfo

parser = argparse.ArgumentParser()
parser.add_argument("image")
parser.add_argument("--output", default="artifacts/p4")
args = parser.parse_args()
output = Path(args.output)
output.mkdir(parents=True, exist_ok=True)
suffix = secrets.token_hex(6)
container, network, volume = (f"hdu-v3-test-{suffix}-{kind}" for kind in ("app", "net", "data"))
key = base64.b64encode(secrets.token_bytes(32)).decode()
checks = []
report = {"image": args.image, "checks": checks, "productionAccess": False, "passed": False}
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def docker(*command, check=True):
    result = subprocess.run(["docker", *command], capture_output=True, text=True)
    if check and result.returncode:
        # Do not include docker run arguments: they contain an ephemeral test key.
        raise RuntimeError(f"Docker {command[0]} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def request(path, payload=None, expected=200):
    data = None if payload is None else json.dumps(payload).encode()
    req = urllib.request.Request(base + path, data=data, headers={"Content-Type": "application/json"})
    try:
        with opener.open(req, timeout=3) as response:
            assert response.status == expected
            return json.load(response)
    except urllib.error.HTTPError as error:
        assert error.code == expected, (path, error.code, expected)
        return json.load(error)


def start():
    global base
    docker("run", "-d", "--name", container, "--network", network,
           "--platform", "linux/amd64", "--read-only", "--cap-drop", "ALL",
           "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp:size=32m,mode=1777",
           "-p", "127.0.0.1::8000", "-v", f"{volume}:/var/lib/hdu-sniper",
           "-e", f"HDU_SNIPER_SECRET_KEY={key}", args.image)
    info = json.loads(docker("inspect", container))[0]
    binding = info["NetworkSettings"]["Ports"]["8000/tcp"][0]
    assert binding["HostIp"] == "127.0.0.1"
    base = "http://127.0.0.1:" + binding["HostPort"]
    wait_healthy()


def wait_healthy():
    for _ in range(60):
        try:
            assert request("/api/health") == {"status": "ok"}
            docker("exec", container, "/usr/local/bin/hdu-sniper-server", "--healthcheck")
            return
        except (OSError, RuntimeError):
            time.sleep(0.5)
    raise RuntimeError("container did not become healthy")


try:
    image = json.loads(docker("image", "inspect", args.image))[0]
    assert image["Architecture"] == "amd64" and image["Os"] == "linux"
    report["imageId"] = image["Id"]
    report["revision"] = image["Config"]["Labels"]["com.hdu-library-sniper.source-revision"]
    defaults = dict(value.split("=", 1) for value in image["Config"]["Env"] if "=" in value)
    assert defaults["HDU_STRICT_MODE"] == "1"
    assert defaults["HDU_STRICT_WRITES"] == "0"
    assert defaults["HDU_STRICT_VALIDATED"] == "0"
    checks.append("linux/amd64 image; strict mode on; real writes and validation default off")
    docker("network", "create", "--internal", network)
    assert json.loads(docker("network", "inspect", network))[0]["Internal"]
    docker("volume", "create", volume)
    start()
    assert request("/api/session")["authenticated"] is False
    request("/api/strict/status", expected=401)
    checks.append("empty-volume startup; HTTP /api/health; executable healthcheck; unauthenticated API rejected")
    docker("stop", container)
    with tempfile.TemporaryDirectory(prefix="hdu-v3-fixture-") as directory:
        database = Path(directory) / "hdu-sniper.sqlite"
        docker("cp", f"{container}:/var/lib/hdu-sniper/data/hdu-sniper.sqlite", str(database))
        with sqlite3.connect(database) as db:
            assert db.execute("SELECT count(*) FROM strict_tasks").fetchone()[0] == 0
            assert db.execute("SELECT value FROM meta WHERE key='strict_daily_uid'").fetchone() in (None, ("",))
            assert db.execute("SELECT value FROM meta WHERE key='auto_checkin_enabled'").fetchone() in (None, ("0",))
            checks.append("new SQLite: no tasks; daily booking and automatic check-in default off")
            now = datetime.now(ZoneInfo("Asia/Shanghai"))
            date = now.date() + timedelta(days=2)
            begin = datetime.combine(date, datetime.min.time(), tzinfo=now.tzinfo).replace(hour=8)
            opens = now.replace(hour=20, minute=0, second=0, microsecond=0)
            uid = "123456"
            task = {"key": f"{uid}:{date}:08:22", "uid": uid, "date": str(date),
                    "begin": int(begin.timestamp()), "opens": int(opens.timestamp()),
                    "state": "SUBMITTING_162", "message": "synthetic interrupted write intent",
                    "attempts": ["162"], "mapping": None, "updated_at": int(now.timestamp())}
            original = json.dumps(task, separators=(",", ":"), ensure_ascii=False)
            db.execute("INSERT INTO strict_tasks VALUES (?,?)", (task["key"], original))
            db.execute("INSERT INTO session(id,uid,name,cookies,updated_at) VALUES(1,?,?,?,?)",
                       (uid, "Synthetic acceptance identity", "[]", now.isoformat()))
            # A legacy enabled check-in flag must not activate strict-mode check-in.
            db.execute("INSERT OR REPLACE INTO meta VALUES('auto_checkin_enabled','1')")
            db.execute("INSERT INTO audit(event,payload,created_at) VALUES('acceptance_sentinel','{}',?)", (now.isoformat(),))
        docker("cp", str(database), f"{container}:/var/lib/hdu-sniper/data/hdu-sniper.sqlite")
    docker("start", container)
    wait_healthy()
    state = request("/api/strict/status")
    assert state["enabled"] and not state["writesAllowed"] and not state["daily"] and not state["validated"]
    assert request("/api/checkin")["enabled"] is False
    assert state["tasks"][0]["state"] == "SUBMITTING_162"
    request("/api/strict/daily", {"enabled": True}, expected=409)
    for _ in range(2):
        task_state = request("/api/strict/start", {})["tasks"]
        assert len(task_state) == 1 and task_state[0]["attempts"] == ["162"]
    checks.append("persisted write intent not replayed; duplicate starts reuse task; daily gate and legacy check-in suppression")
    docker("restart", container)
    wait_healthy()
    assert request("/api/strict/status")["tasks"][0]["state"] == "SUBMITTING_162"
    assert request("/api/strict/stop", {})["tasks"][0]["state"] == "UNKNOWN"
    docker("rm", "-f", container)
    start()
    restored = request("/api/strict/status")["tasks"]
    assert len(restored) == 1 and restored[0]["state"] == "UNKNOWN" and restored[0]["attempts"] == ["162"]
    assert any(event["event"] == "acceptance_sentinel" for event in request("/api/audit")["events"])
    checks.append("container restart and replacement preserve SQLite task, UNKNOWN protection and audit; manual takeover works")
    report["passed"] = True
except Exception as error:
    report["error"] = str(error)
    raise
finally:
    (output / "container.log").write_text(docker("logs", container, check=False))
    (output / "container-acceptance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    docker("rm", "-f", container, check=False)
    docker("volume", "rm", volume, check=False)
    docker("network", "rm", network, check=False)
print(json.dumps(report, ensure_ascii=False, indent=2))
