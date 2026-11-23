"""Local TLS fixture. Its proxy terminates only the HDU hostname and never forwards traffic."""
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
ORIGIN = "https://hdu.huitu.zhishulib.com"
BASE = "/User/Center/baseInfo"
BOOK = "/Seat/Index/bookSeats?LAB_JSON=1"
RECORD = "/Seat/Index/myBookingList?fromType=web&LAB_JSON=1"
CATALOG = "/Space/Category/list?LAB_JSON=1"
RANGE = "/Seat/Index/searchSeats?group=1&LAB_JSON=1"
SUCCESS = {"CODE": "ok", "DATA": {"result": "success", "msg": "预约成功"}}
UID = "1234567890"
ROOM = "宋韵云图（四楼）"

class State:
    def __init__(self):
        self.requests = []
        self.posts = []
        self.reply = SUCCESS
        self.status = 200
        self.session = True
        self.uid = UID
        self.records = []
        self.auto_record = True
        self.range_status = 200
        self.max_duration = 15
        self.max_date = "2026-11-24"
        self.record_status = 200
        self.record_delay = 0
        self.write_delay = 0
        self.disconnect = False
        self.raw = None
        self.retry_after = None
        self.scripts = ["p62"]


class LocalServer(ThreadingHTTPServer):
    daemon_threads = True
    def handle_error(self, request, address):
        import sys
        if not isinstance(sys.exception(), (BrokenPipeError, ConnectionResetError, ssl.SSLError)):
            super().handle_error(request, address)

class Quiet(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

class Mock:
    def __init__(self):
        self.state = State()
        self.files = {name: (ROOT / path).read_bytes() for name, path in {
            "p62": "userscripts/HDU_Android_P6.2_Lite.user.js",
            "p60": "userscripts/hdu-p60-lite.user.js",
            "p611": "userscripts/hdu-p611-history-recovery.user.js",
        }.items()}

    def __enter__(self):
        self.temp = tempfile.TemporaryDirectory()
        key = Path(self.temp.name) / "key.pem"
        cert = key.with_name("cert.pem")
        subprocess.run(["openssl", "req", "-x509", "-nodes", "-newkey", "rsa:2048", "-keyout", str(key),
                        "-out", str(cert), "-days", "1", "-subj", "/CN=hdu.huitu.zhishulib.com",
                        "-addext", "subjectAltName=DNS:hdu.huitu.zhishulib.com"],
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)
        tls = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
        tls.load_cert_chain(cert, key)
        mock = self
        class App(Quiet):
            def reply(self, status, body, mime="application/json", extra=None):
                if not isinstance(body, bytes):
                    body = json.dumps(body, ensure_ascii=False).encode()
                self.send_response(status)
                self.send_header("Content-Type", mime)
                self.send_header("Content-Length", str(len(body)))
                self.send_header("Cache-Control", "no-store")
                for k,v in (extra or {}).items():
                    self.send_header(k,v)
                self.end_headers()
                self.wfile.write(body)

            def do_GET(self):
                state = mock.state
                if self.path == "/":
                    scripts = "".join('<script defer src="/fixture/'+name+'.js"></script>' for name in state.scripts)
                    html = '<!doctype html><meta charset=utf-8><meta name=viewport content="width=device-width,initial-scale=1"><title>P62 Local Fixture</title>'
                    html += '<button id="official">官网预约</button><script>window.originalFetch=window.fetch;'
                    html += "official.onclick=()=>fetch('"+BOOK+"',{method:'POST',body:'manual=1'});</script>"+scripts
                    return self.reply(200,html.encode(),"text/html",{"Set-Cookie":"fixture_session=1; Path=/; Secure; HttpOnly; SameSite=Lax"})
                if self.path.startswith("/fixture/"):
                    return self.reply(200,mock.files[Path(self.path).stem],"text/javascript")
                if self.path == "/favicon.ico":
                    return self.reply(204,b"")
                state.requests.append(("GET",self.path))
                if self.path == BASE:
                    session = state.session and "fixture_session=1" in self.headers.get("Cookie","")
                    self.reply(200,{"CODE":"ok","DATA":{"is_login":session,"uid":state.uid,"uname":"PRIVATE_NAME"}})
                elif self.path == CATALOG:
                    self.reply(200,{"content":{"defaultItems":[{"name":"自习室","link":{"url":RANGE}}]}})
                elif self.path == RANGE:
                    self.reply(state.range_status,{"data":{"range":{
                        "advance_date":"2026-11-22","max_date":state.max_date,"minBeginTime":7,"maxEndTime":22,
                        "min_duration":1,"max_duration":state.max_duration,"max_num":4}}})
                elif self.path == RECORD:
                    time.sleep(state.record_delay)
                    self.reply(state.record_status,{"content":{"defaultItems":state.records}})
                else:
                    self.reply(404,{"CODE":"NotFound"})

            def do_POST(self):
                received = time.time_ns()/1e6
                state = mock.state
                state.requests.append(("POST",self.path))
                raw = self.rfile.read(int(self.headers.get("Content-Length",0))).decode()
                if raw == "manual=1":
                    state.posts.append({"manual":True})
                    return self.reply(200,SUCCESS)
                if self.path != BOOK:
                    return self.reply(404,{"CODE":"NotFound"})
                form = {k:v[0] for k,v in parse_qs(raw).items()}
                keys = ["api_time","beginTime","duration","is_recommend","seatBookers[0]","seats[0]"]
                source = "&".join(["post",BOOK,*(k+form.get(k,"") for k in keys)])
                token = base64.b64encode(hashlib.md5(source.encode()).hexdigest().encode()).decode()
                valid = (list(form) == ["beginTime","duration","is_recommend","api_time","seats[0]","seatBookers[0]"]
                         and self.headers.get("Api-Token")==token and form.get("seats[0]")=="62726"
                         and form.get("seatBookers[0]")==state.uid and form.get("is_recommend")=="0"
                         and self.headers.get_content_type()=="application/x-www-form-urlencoded"
                         and "fixture_session=1" in self.headers.get("Cookie",""))
                record = dict(status="0",roomName=ROOM,seatNum="162",seatId="62726",time=form.get("beginTime"),duration=form.get("duration"))
                state.posts.append({"received":received,"valid":valid,"record":record,"apiTime":form.get("api_time")})
                time.sleep(state.write_delay)
                if not valid:
                    return self.reply(400,{"CODE":"ParamError","MESSAGE":"模拟表单校验失败"})
                if state.status==200 and state.reply==SUCCESS and state.auto_record:
                    state.records = [record]
                if state.disconnect:
                    self.connection.shutdown(socket.SHUT_RDWR)
                    return
                extra = {"Retry-After":state.retry_after} if state.retry_after else None
                self.reply(state.status,state.raw if state.raw is not None else state.reply,extra=extra)

        class Proxy(Quiet):
            def do_CONNECT(self):
                if self.path != "hdu.huitu.zhishulib.com:443":
                    return self.send_error(403)
                self.send_response(200,"Connection established")
                self.end_headers()
                self.wfile.flush()
                with tls.wrap_socket(self.connection,server_side=True) as connection:
                    App(connection,self.client_address,self.server)
        self.server = LocalServer(("127.0.0.1",0),Proxy)
        self.proxy = "http://127.0.0.1:"+str(self.server.server_port)
        self.thread = threading.Thread(target=self.server.serve_forever,daemon=True)
        self.thread.start()
        return self

    def __exit__(self,*args):
        self.server.shutdown()
        self.server.server_close()
        self.thread.join()
        self.temp.cleanup()
