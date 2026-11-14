#!/usr/bin/env python3
"""Offline smoke: empty temporary data, random key, loopback only, writes disabled."""
import base64
import os
from pathlib import Path
import secrets
import socket
import subprocess
import tempfile
import time
import urllib.request

root = Path(__file__).resolve().parent.parent
binary = root / "target/debug/hdu-sniper-server"
with tempfile.TemporaryDirectory(prefix="hdu-v3-smoke-") as directory:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        port = sock.getsockname()[1]
    env = {
        **os.environ,
        "HDU_SNIPER_HOME": directory,
        "HDU_WEB_HOST": "127.0.0.1",
        "HDU_WEB_PORT": str(port),
        "HDU_STRICT_MODE": "1",
        "HDU_STRICT_WRITES": "0",
        "HDU_STRICT_VALIDATED": "0",
        "HDU_SNIPER_SECRET_KEY": base64.b64encode(secrets.token_bytes(32)).decode(),
    }
    # No inherited proxy should affect loopback health checks.
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    process = subprocess.Popen([str(binary)], cwd=root, env=env,
                               stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    try:
        for attempt in range(50):
            try:
                with opener.open(f"http://127.0.0.1:{port}/api/health", timeout=1) as response:
                    assert response.status == 200
                break
            except OSError:
                time.sleep(0.1)
        else:
            raise RuntimeError("server did not become healthy")
        subprocess.run([str(binary), "--healthcheck"], env=env, check=True)
        with opener.open(f"http://127.0.0.1:{port}/plans", timeout=2) as response:
            assert response.status == 200 and b"<html" in response.read()
        print("PASS: startup, HTTP health, binary healthcheck, SPA deep link; no library traffic")
    finally:
        process.terminate()
        process.wait(timeout=5)
