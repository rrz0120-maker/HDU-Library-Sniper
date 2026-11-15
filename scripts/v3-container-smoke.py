#!/usr/bin/env python3
"""Container acceptance with synthetic identity and a network namespace with no external access.

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
container, volume = (f"hdu-v3-test-{suffix}-{kind}" for kind in ("app", "data"))
probe_image = "python:3.13-alpine"
key = base64.b64encode(secrets.token_bytes(32)).decode()
checks = []
report = {"image": args.image, "checks": checks, "productionAccess": False, "passed": False}
PROBE = r"""
import json, sys, urllib.request, urllib.error
payload = None if sys.argv[2] == "null" else sys.argv[2].encode()
req = urllib.request.Request("http://127.0.0.1:8000" + sys.argv[1], data=payload,
                             headers={"Content-Type": "application/json"})
opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
try:
    with opener.open(req, timeout=3) as r:
        print(json.dumps({"status": r.status, "body": json.load(r)}))
except urllib.error.HTTPError as e:
    print(json.dumps({"status": e.code, "body": json.load(e)}))
"""


def docker(*command, check=True):
    result = subprocess.run(["docker", *command], capture_output=True, text=True)
    if check and result.returncode:
        # Do not include docker run arguments: they contain an ephemeral test key.
        raise RuntimeError(f"Docker {command[0]} failed: {result.stderr.strip()}")
    return result.stdout.strip()


def request(path, payload=None, expected=200):
    raw = docker("run", "--rm", "--network", f"container:{container}",
                 probe_image, "python", "-c", PROBE, path, json.dumps(payload))
    result = json.loads(raw)
    assert result["status"] == expected, (path, result["status"], expected)
    return result["body"]


def start():
    docker("run", "-d", "--name", container, "--network", "none",
           "--platform", "linux/amd64", "--read-only", "--cap-drop", "ALL",
           "--security-opt", "no-new-privileges:true", "--tmpfs", "/tmp:size=32m,mode=1777",
           "-v", f"{volume}:/var/lib/hdu-sniper",
           "-e", f"HDU_SNIPER_SECRET_KEY={key}", args.image)
    info = json.loads(docker("inspect", container))[0]
    assert info["HostConfig"]["NetworkMode"] == "none"
    assert not info["HostConfig"].get("PortBindings")
    wait_healthy()


def wait_healthy():
    for _ in range(60):
        try:
            docker("exec", container, "/usr/local/bin/hdu-sniper-server", "--healthcheck")
            assert request("/api/health") == {"status": "ok"}
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
    docker("pull", probe_image)  # Tool image only; all probes share the isolated app namespace.
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
        # sqlite3's context manager commits but does NOT close. Flush the fixture
        # WAL before copying its main file; otherwise the synthetic session is lost.
        db.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        db.close()
        with sqlite3.connect(database.as_uri() + "?mode=ro", uri=True) as verify:
            assert verify.execute("SELECT uid FROM session WHERE id=1").fetchone() == (uid,)
            assert verify.execute("SELECT document FROM strict_tasks").fetchone() == (original,)
        verify.close()
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
    logs = subprocess.run(["docker", "logs", container], capture_output=True, text=True)
    (output / "container.log").write_text(logs.stdout + logs.stderr)
    (output / "container-state.json").write_text(docker("inspect", "--format", "{{json .State}}", container, check=False))
    (output / "container-acceptance.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
    docker("rm", "-f", container, check=False)
    docker("volume", "rm", volume, check=False)
print(json.dumps(report, ensure_ascii=False, indent=2))
