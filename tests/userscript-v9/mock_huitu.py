"""Loopback-only HTTPS fixture. CONNECT is terminated here; nothing is forwarded."""
import base64
import hashlib
import json
import socket
import ssl
import subprocess
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import parse_qs

ROOT = Path(__file__).resolve().parents[2]
HOST = "hdu.huitu.zhishulib.com"
ORIGIN = "https://" + HOST
BOOK = "/Seat/Index/bookSeats?LAB_JSON=1"
BASE = "/User/Center/baseInfo"
RECORD = "/Seat/Index/myBookingList?fromType=web&LAB_JSON=1"
CATALOG = "/Space/Category/list?LAB_JSON=1"
RANGE = "/Seat/Index/searchSeats?group=1&LAB_JSON=1"
SUCCESS = {"CODE": "ok", "DATA": {"result": "success", "msg": "预约成功"}}
CLOSED = {"CODE": "ParamError", "DATA": {"msg": "未到开放时间"}}
OCCUPIED = {"CODE": "ParamError", "MESSAGE": "选择的座位无法预约，可能座位不可用或已经被其他人锁定或占用"}
ROOM = "宋韵云图（四楼）"
UID = "876543219"  # synthetic
P731 = "1dfb5cf7448cce2616c18034adc37c1e0cb332db"


class Fixture:
    def __init__(self):
        self.events = []
        self.posts = []
        self.business = SUCCESS
        self.http = 200
        self.retry_after = None
        self.records = []
        self.auto_record = True
        self.read_status = 200
        self.uid = UID
        self.pause_book = 0
        self.pause_records = 0
        self.disconnect = False
        self.raw_body = None
        self.scripts = ["v9"]
        self.range_end = "2026-11-25"


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True

    def handle_error(self, request, address):
        import sys
        if not isinstance(sys.exception(), (BrokenPipeError, ConnectionResetError, ssl.SSLError)):
            super().handle_error(request, address)


class QuietHandler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass


class Mock:
    def __init__(self):
        self.fixture = Fixture()
        self.files = {
            "v9": (ROOT / "userscripts/HDU_iPad_V9_Lite.user.js").read_bytes(),
            "p611": (ROOT / "userscripts/hdu-p611-history-recovery.user.js").read_bytes(),
        }

    def load_p731(self):
        # A normal full clone has this commit. On a single-branch clone, fetch fix/ipad-p731-release-qa first.
        self.files["p731"] = subprocess.check_output(
            ["git", "show", P731 + ":userscripts/hdu-p731-ipad-performance.user.js"], cwd=ROOT)

    def __enter__(self):
        self.temp = tempfile.TemporaryDirectory()
        cert = Path(self.temp.name) / "test.pem"
        key = cert.with_name("test.key")
        subprocess.run(["openssl", "req", "-x509", "-nodes", "-newkey", "rsa:2048",
                        "-keyout", str(key), "-out", str(cert), "-days", "1",
                        "-subj", "/CN=" + HOST, "-addext", "subjectAltName=DNS:" + HOST],
                       check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert, key)
        mock = self

        class App(QuietHandler):
            def reply(self, code, data, kind="application/json", headers=None):
                if not isinstance(data, bytes):
                    data = json.dumps(data, ensure_ascii=False).encode()
                self.send_response(code)
                self.send_header("Content-Type", kind)
                self.send_header("Content-Length", str(len(data)))
                self.send_header("Cache-Control", "no-store")
                for name, value in (headers or {}).items():
                    self.send_header(name, value)
                self.end_headers()
                self.wfile.write(data)

            def do_GET(self):
                f = mock.fixture
                if self.path == "/":
                    scripts = "".join('<script defer src="/fixture/' + name + '.js"></script>' for name in f.scripts)
                    html = ("<!doctype html><meta charset=utf-8><meta name=viewport content='width=device-width'>"
                            "<title>Local reservation fixture</title><button id='official'>官网预约</button>"
                            "<script>window.originalFetch=window.fetch;official.onclick=()=>fetch('" + BOOK +
                            "',{method:'POST',body:'manual=1'});</script>" + scripts)
                    self.reply(200, html.encode(), "text/html; charset=utf-8",
                               {"Set-Cookie": "test_session=mock; Path=/; HttpOnly; Secure; SameSite=Lax"})
                elif self.path.startswith("/fixture/"):
                    name = Path(self.path).stem
                    self.reply(200, mock.files[name], "text/javascript")
                elif self.path == "/favicon.ico":
                    self.reply(204, b"")
                else:
                    f.events.append(("GET", self.path))
                    if self.path == BASE:
                        logged = f.uid and "test_session=mock" in self.headers.get("Cookie", "")
                        self.reply(200, {"CODE": "ok", "DATA": {"is_login": bool(logged), "uid": f.uid}})
                    elif self.path == RECORD:
                        time.sleep(f.pause_records)
                        self.reply(f.read_status, {"content": {"defaultItems": f.records}})
                    elif self.path == CATALOG:
                        self.reply(200, {"content": {"defaultItems": [{"name": "自习室", "link": RANGE}]}})
                    elif self.path == RANGE:
                        self.reply(200, {"data": {"range": {"advance_date": "2026-11-22",
                            "max_date": f.range_end, "minBeginTime": 7, "maxEndTime": 22,
                            "min_duration": 1, "max_duration": 15, "max_num": 4}}})
                    else:
                        self.reply(404, {"CODE": "NotFound"})

            def do_POST(self):
                arrived = time.time_ns() / 1e6
                f = mock.fixture
                f.events.append(("POST", self.path))
                params = parse_qs(self.rfile.read(int(self.headers.get("Content-Length", 0))).decode())
                if self.path != BOOK:
                    return self.reply(404, {"CODE": "NotFound"})
                if params == {"manual": ["1"]}:
                    f.posts.append({"manual": True})
                    return self.reply(200, SUCCESS)
                form = {k: v[0] for k, v in params.items()}
                keys = ["api_time", "beginTime", "duration", "is_recommend", "seatBookers[0]", "seats[0]"]
                source = "&".join(["post", BOOK, *(k + form.get(k, "") for k in keys)])
                expected = base64.b64encode(hashlib.md5(source.encode()).hexdigest().encode()).decode()
                valid = (set(keys) == set(form) and self.headers.get("Api-Token") == expected
                         and form["seatBookers[0]"] == f.uid and form["seats[0]"] == "62726"
                         and form["is_recommend"] == "0" and "test_session=mock" in self.headers.get("Cookie", "")
                         and self.headers.get_content_type() == "application/x-www-form-urlencoded")
                record = {"time": form.get("beginTime"), "duration": form.get("duration"), "status": "0",
                          "roomName": ROOM, "seatId": "62726", "seatNum": "162"}
                f.posts.append({"arrived": arrived, "valid": valid, "record": record, "apiTime": form.get("api_time")})
                time.sleep(f.pause_book)
                if not valid:
                    return self.reply(400, {"CODE": "ParamError", "MESSAGE": "模拟签名或表单不一致"})
                if f.auto_record and f.http == 200 and f.business == SUCCESS:
                    f.records = [record]
                if f.disconnect:
                    self.connection.shutdown(socket.SHUT_RDWR)
                    return
                headers = {"Retry-After": f.retry_after} if f.retry_after else None
                self.reply(f.http, f.raw_body if f.raw_body is not None else f.business, headers=headers)

        class Proxy(QuietHandler):
            def do_CONNECT(self):
                if self.path != HOST + ":443":
                    self.send_error(403)
                    return
                self.send_response(200, "Connection Established")
                self.end_headers()
                self.wfile.flush()
                with tls.wrap_socket(self.connection, server_side=True) as secure:
                    App(secure, self.client_address, self.server)

        self.server = LocalServer(("127.0.0.1", 0), Proxy)
        self.proxy = "http://127.0.0.1:" + str(self.server.server_port)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        return self

    def __exit__(self, *args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()
