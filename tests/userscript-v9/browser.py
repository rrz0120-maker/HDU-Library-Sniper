"""Exercise the installed IIFE with actual HTTPS requests to a loopback fixture."""
import argparse
import json
import os
from contextlib import contextmanager
from datetime import datetime

from playwright.sync_api import expect, sync_playwright

from mock_huitu import BASE, BOOK, CATALOG, CLOSED, OCCUPIED, ORIGIN, RANGE, RECORD, SUCCESS, UID, Fixture, Mock

OPEN = int(datetime.fromisoformat("2026-11-22T20:00:00+08:00").timestamp() * 1000)
LAST = "hdu-v9:last"
HOST = "#hdu-ipad-v9-lite"
INIT = """
const realNow = Date.now.bind(Date);
window.setWall = value => {
  window.testShift = value - realNow();
  Date.now = () => realNow() + window.testShift;
  return window.testShift;
};
Object.defineProperty(navigator, 'clipboard', {configurable:true, value:{
  writeText: async text => { window.copiedDiagnostic = text; }
}});
"""


def field(page, selector):
    return page.locator(HOST).locator(selector)


def set_time(page, wall):
    shift = page.evaluate("n => setWall(n)", wall)
    field(page, "#mode").dispatch_event("input")
    return shift


def visit(context, mode="now", at=OPEN + 60000):
    page = context.new_page()
    page.goto(ORIGIN)
    field(page, "summary").click()
    set_time(page, at)
    field(page, "#mode").select_option(mode)
    return page


def start(page):
    field(page, "#start").click()


def exported(page):
    field(page, "#copy").click()
    return json.loads(page.evaluate("window.copiedDiagnostic"))


def wait_report(page, **fields):
    page.wait_for_function(
        """expected => {
          const r = JSON.parse(sessionStorage.getItem('hdu-v9:last'));
          return r && Object.entries(expected).every(([k,v]) => r[k] === v);
        }""", arg=fields)
    return page.evaluate("JSON.parse(sessionStorage.getItem('hdu-v9:last'))")


@contextmanager
def case(browser, mock, scripts=("v9",), **fixture):
    mock.fixture = f = Fixture()
    f.scripts = list(scripts)
    for k, v in fixture.items():
        setattr(f, k, v)
    context = browser.new_context(ignore_https_errors=True, viewport={"width": 820, "height": 1180},
                                  is_mobile=True, has_touch=True, timezone_id="America/Los_Angeles")
    context.set_default_timeout(6500)
    context.add_init_script(INIT)
    errors = []
    context.on("page", lambda page: page.on("pageerror", lambda e: errors.append(str(e))))
    try:
        yield context, f
        assert not errors, errors
    finally:
        context.close()


def success(browser, mock):
    with case(browser, mock, pause_book=.14, pause_records=.3) as (context, f):
        p = visit(context)
        start(p)
        wait_report(p, state="sending")
        wait_report(p, state="accepted")
        r = wait_report(p, state="verified")
        assert f.events == [("GET", BASE), ("POST", BOOK), ("GET", RECORD)]
        assert len(f.posts) == 1 and f.posts[0]["valid"]
        assert r["start"] == 9 and r["end"] == 22 and r["sends"] == 1 and r["httpMs"] >= 100
        assert r["businessCode"] == "ok" and r["businessResult"] == "success" and r["verification"] == "matched"
        field(p, "#review").click()
        expect(field(p, "#start")).to_be_enabled()
        start(p)  # Already present on the official list.
        wait_report(p, state="verified")
        assert len(f.posts) == 1
        # Cancellation at the official site makes the same legitimate slot usable again.
        f.records.clear()
        set_time(p, OPEN + 90000)
        start(p)
        wait_report(p, state="verified")
        assert len(f.posts) == 2
        assert f.posts[-1]["record"]["duration"] == "46800"


def business_replies(browser, mock):
    cases = [(CLOSED, 200, "NOT_OPEN"), (OCCUPIED, 200, "SEAT_UNAVAILABLE"),
             ({"CODE": "1", "MESSAGE": "请求太频繁了"}, 200, "LIMITED"),
             ({"CODE": "LIMITED"}, 429, "LIMITED"), ({"ui_type": "com.Redirect"}, 401, "AUTH_REQUIRED"),
             ({"CODE": "ParamError", "DATA": {"msg": "仅限本校读者 " + UID + " test-private-token"},
               "MESSAGE": "其他"}, 200, "BUSINESS_REJECTED")]
    for business, http, result in cases:
        with case(browser, mock, business=business, http=http, retry_after="901") as (context, f):
            p = visit(context)
            start(p)
            r = wait_report(p, state="failed", result=result)
            assert r["httpStatus"] == http and r["sends"] == 1
            message = business.get("DATA", {}).get("msg") or business.get("MESSAGE")
            if message:
                expect(field(p, "#feedback")).to_contain_text(message)
            if result == "BUSINESS_REJECTED":
                raw = json.dumps(exported(p), ensure_ascii=False)
                for secret in (UID, "test-private-token", "Api-Token", "test_session", "Cookie"):
                    assert secret not in raw
            if result == "LIMITED":
                p.reload()
                field(p, "summary").click()
                set_time(p, OPEN + 700000)
                field(p, "#mode").select_option("now")
                field(p, "#from").select_option("8")
                start(p)
                wait_report(p, state="idle", result="LIMITED", sends=0)
            assert len(f.posts) == 1 and all(path != RECORD for _, path in f.events)


def supplement(browser, mock):
    with case(browser, mock, business=CLOSED, range_end="2026-11-24") as (context, f):
        p = visit(context)
        start(p)
        wait_report(p, result="NOT_OPEN")
        start(p)
        wait_report(p, result="PACING")
        assert len(f.posts) == 1 and ("GET", CATALOG) not in f.events
        set_time(p, OPEN + 95000)
        start(p)
        wait_report(p, result="OPEN_NOT_CONFIRMED", sends=0)
        assert f.events[-2:] == [("GET", CATALOG), ("GET", RANGE)] and len(f.posts) == 1
        f.range_end = "2026-11-25"
        start(p)
        wait_report(p, state="failed", result="NOT_OPEN")
        assert len(f.posts) == 2
        set_time(p, OPEN + 120000)
        start(p)
        wait_report(p, result="NO_SUPPLEMENT", sends=0)
        assert len(f.posts) == 2


def uncertain_results(browser, mock):
    for setup, reason in [({"disconnect": True}, "NETWORK_ERROR"), ({"raw_body": b"<html>busy"}, "RESPONSE_UNKNOWN"),
                          ({"http": 504}, "HTTP_UNCERTAIN")]:
        with case(browser, mock, auto_record=False, **setup) as (context, f):
            p = visit(context)
            start(p)
            r = wait_report(p, state="unknown", result=reason)
            assert r["sends"] == 1 and len(f.posts) == 1
            p.reload()
            field(p, "summary").click()
            set_time(p, OPEN + 120000)
            field(p, "#mode").select_option("now")
            start(p)
            wait_report(p, state="unknown", result=reason)
            field(p, "#review").click()
            wait_report(p, verification="absent")
            f.records = [f.posts[0]["record"]]
            field(p, "#review").click()
            wait_report(p, state="verified", verification="matched", result=reason)
            assert len(f.posts) == 1


def verification_errors(browser, mock):
    with case(browser, mock, auto_record=False, read_status=503) as (context, f):
        p = visit(context)
        start(p)
        wait_report(p, state="accepted", verification="error", result="SERVER_SUCCESS")
        f.read_status = 200
        target = f.posts[0]["record"]
        f.records = [dict(target, status="3"), dict(target, seatNum="161"), dict(target, duration=3600)]
        field(p, "#review").click()
        wait_report(p, state="accepted", verification="absent")
        f.uid = "9999991"
        field(p, "#review").click()
        expect(field(p, "#feedback")).to_contain_text("当前登录账号没有这笔请求")
        f.uid = UID
        f.records = [target]
        field(p, "#review").click()
        wait_report(p, state="verified", verification="matched")
        assert len(f.posts) == 1


def stop_visibility(browser, mock):
    with case(browser, mock) as (context, f):
        p = visit(context, mode="scheduled", at=OPEN - 60000)
        p.evaluate("""() => {
          localStorage.setItem('hdu-p60-control:2026-11-22:stop','1');
          localStorage.setItem('hdu-p71-control:2026-11-22:stop','1');
          Object.defineProperty(document,'hidden',{configurable:true,get:()=>window.testHidden === true});
          window.hideForTest = hidden => { window.testHidden = hidden; document.dispatchEvent(new Event('visibilitychange')); };
        }""")
        start(p)
        wait_report(p, state="waiting")
        p.evaluate("hideForTest(true)")
        p.evaluate("hideForTest(false)")
        field(p, "#stop").click()
        wait_report(p, state="idle", sends=0, result="STOPPED")
        start(p)
        wait_report(p, state="waiting")
        p.reload()
        field(p, "summary").click()
        assert not f.posts
        assert exported(p)["sends"] == 0
        set_time(p, OPEN - 60000)
        field(p, "#from").select_option("8")
        start(p)
        wait_report(p, state="waiting")
        p.evaluate("""open => {
          Object.defineProperty(document,'hidden',{configurable:true,value:true});
          document.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('blur'));
          setWall(open+1100);
        }""", OPEN)
        assert not f.posts
        p.evaluate("""() => {
          Object.defineProperty(document,'hidden',{configurable:true,value:false});
          document.dispatchEvent(new Event('visibilitychange'));
        }""")
        r = wait_report(p, state="verified")
        assert r["hiddenDuringWait"] and r["inWindow"] and f.posts[0]["record"]["duration"] == "50400"
        assert len(f.posts) == 1


def suspension(browser, mock):
    for delay in (8200, 86400000):
        with case(browser, mock) as (context, f):
            p = visit(context, mode="scheduled", at=OPEN - 60000)
            start(p)
            wait_report(p, state="waiting")
            p.evaluate("""n => {
              Object.defineProperty(document,'hidden',{configurable:true,value:true});
              document.dispatchEvent(new Event('visibilitychange'));
              setWall(n);
              Object.defineProperty(document,'hidden',{configurable:true,value:false});
              window.dispatchEvent(new Event('pageshow'));
            }""", OPEN + delay)
            if delay < 86400000:
                r = wait_report(p, state="verified")
                assert r["inWindow"] is False and r["delayFrom20Ms"] >= delay
                expect(field(p, "#feedback")).to_contain_text("超出准点窗口")
            else:
                wait_report(p, result="MISSED_DAY", sends=0)
                assert not f.posts


def pending_refresh(browser, mock):
    with case(browser, mock, pause_book=1.3) as (context, f):
        p = visit(context)
        start(p)
        wait_report(p, state="sending")
        p.reload()
        field(p, "summary").click()
        set_time(p, OPEN + 120000)
        field(p, "#mode").select_option("now")
        start(p)
        r = wait_report(p, state="unknown")
        assert r["sends"] == 1 and r["dispatchAt"] and len(f.posts) == 1
        field(p, "#review").click()
        expect(field(p, "#start")).to_be_enabled()
        assert len(f.posts) == 1


def concurrent_tabs(browser, mock):
    with case(browser, mock, pause_book=.8) as (context, f):
        a = visit(context)
        b = visit(context)
        a.bring_to_front()
        start(a)
        wait_report(a, state="sending")
        b.bring_to_front()
        start(b)
        wait_report(b, state="idle", result="ACTIVE_TAB", sends=0)
        wait_report(a, state="verified")
        start(b)
        wait_report(b, state="verified")
        assert len(f.posts) == 1


def preflight_and_storage(browser, mock):
    with case(browser, mock, uid=None) as (context, f):
        p = visit(context)
        start(p)
        wait_report(p, result="AUTH_REQUIRED", sends=0)
        f.uid = UID
        p.evaluate("""() => {
          const get = Storage.prototype.getItem, set = Storage.prototype.setItem;
          Storage.prototype.getItem = function(k) { if (this === sessionStorage) throw Error(); return get.call(this,k); };
          Storage.prototype.setItem = function(k,v) { if(this === sessionStorage) throw Error(); return set.call(this,k,v); };
        }""")
        start(p)
        expect(field(p, "#status")).to_have_text("预约成功且记录已核验")
        assert exported(p)["sends"] == 1 and len(f.posts) == 1
        p.evaluate("() => { navigator.clipboard.writeText = async () => {throw Error()}; }")
        field(p, "#copy").click()
        expect(field(p, "#log")).to_be_visible()
        assert json.loads(field(p, "#log").input_value())["verification"] == "matched"

    with case(browser, mock) as (context, f):
        p = visit(context)
        p.evaluate("""() => {
          const real = window.fetch;
          window.fetch = function(url, opts) {
            if (String(url).includes('/bookSeats')) {window.fetch=real;throw new TypeError('fixture');}
            return real.call(this,url,opts);
          };
        }""")
        start(p)
        wait_report(p, state="idle", result="LOCAL_ERROR", sends=0)
        assert not f.posts
        start(p)
        wait_report(p, state="verified")
        assert len(f.posts) == 1


def coexistence(browser, mock):
    for old, old_host in [("p611", "hdu-p60-host"), ("p731", "hdu-p71-host")]:
        for order in [(old, "v9"), ("v9", old)]:
            with case(browser, mock, scripts=order) as (context, f):
                p = visit(context)
                legacy_panel = p.evaluate("id => !!document.getElementById(id)?.shadowRoot", old_host)
                if order[0] == old:
                    assert legacy_panel
                    expect(field(p, "#start")).to_be_disabled()
                    expect(field(p, "#feedback")).to_contain_text("停用旧版")
                else:
                    assert not legacy_panel
                    p.add_script_tag(content=mock.files["v9"].decode())
                    assert p.locator(HOST).count() == 1
                    start(p)
                    wait_report(p, state="verified")
                    assert len(f.posts) == 1
                assert p.evaluate("window.fetch === window.originalFetch")
                before = len(f.posts)
                with p.expect_response(lambda r: r.url.endswith(BOOK)):
                    p.locator("#official").click()
                assert f.posts[before:] == [{"manual": True}]


def layout(browser, mock):
    with case(browser, mock) as (context, _):
        p = visit(context)
        for width, height in [(820,1180), (1180,820), (375,650)]:
            p.set_viewport_size({"width": width, "height": height})
            rect = field(p, "details").bounding_box()
            assert -.5 <= rect["x"] and -.5 <= rect["y"] and rect["x"]+rect["width"] <= width+1
            assert rect["y"]+rect["height"] <= height+1
            expect(field(p, "#start")).to_be_enabled()
        field(p, "summary").click()
        expect(field(p, "#mode")).to_be_hidden()

def dispatch_boundary(browser, mock):
    for marker_delay in (0, 145):
        with case(browser, mock) as (context, f):
            p = visit(context, mode="scheduled", at=OPEN - 60000)
            p.evaluate("""([open, delay]) => {
              let wall = open - 60000;
              Date.now = () => wall;
              window.advanceTo = n => {wall = n; window.dispatchEvent(new Event('pageshow'));};
              const set = Storage.prototype.setItem, fetchImpl = window.fetch;
              Storage.prototype.setItem = function(k,v) {
                if (/^hdu-v9:[a-f0-9]{64}$/.test(k) && v.includes('"sends":null')) wall += delay;
                return set.call(this,k,v);
              };
              window.fetch = function(url,opts) {
                if (String(url).includes('/bookSeats')) window.actualHandoff = Date.now();
                return fetchImpl.call(this,url,opts);
              };
            }""", [OPEN, marker_delay])
            start(p)
            wait_report(p, state="waiting")
            p.evaluate("n => advanceTo(n)", OPEN + 1199)
            assert not f.posts
            p.evaluate("n => advanceTo(n)", OPEN + 1200)
            r = wait_report(p, state="verified")
            assert r["delayFrom20Ms"] == 1200 + marker_delay and r["inWindow"]
            assert round(datetime.fromisoformat(r["dispatchAt"]).timestamp()*1000) == p.evaluate("actualHandoff")
            assert f.events == [("GET", BASE), ("POST", BOOK), ("GET", RECORD)]


def crash_gap(browser, mock):
    with case(browser, mock, disconnect=True, auto_record=False) as (context, f):
        p = visit(context)
        start(p)
        wait_report(p, state="unknown")
        # Recreate a write-ahead marker with no proof the fetch call returned before process loss.
        p.evaluate("""() => {
          const id = sessionStorage.getItem('hdu-v9:last-guard');
          const data = JSON.parse(localStorage.getItem(id));
          const row = Object.values(data.slots)[0];
          Object.assign(row.report,{state:'unknown', result:'PENDING', dispatchAt:null, sends:null});
          localStorage.setItem(id,JSON.stringify(data));
          sessionStorage.setItem('hdu-v9:last',JSON.stringify({...row.report,state:'waiting',result:'WAITING',sends:0}));
        }""")
        p.reload()
        field(p, "summary").click()
        r = exported(p)
        assert r["sends"] is None and r["dispatchAt"] is None and r["result"] == "PENDING"
        set_time(p, OPEN + 150000)
        field(p, "#mode").select_option("now")
        start(p)
        wait_report(p, result="PENDING", sends=None)
        assert len(f.posts) == 1


TESTS = [success, business_replies, supplement, uncertain_results, verification_errors, stop_visibility,
         suspension, pending_refresh, concurrent_tabs, preflight_and_storage, coexistence, layout,
         dispatch_boundary, crash_gap]


def launch(browser_type, mock):
    kw = {"proxy": {"server": mock.proxy}}
    if browser_type.name == "chromium" and os.environ.get("CHROMIUM_PATH"):
        kw["executable_path"] = os.environ["CHROMIUM_PATH"]
    return browser_type.launch(**kw)


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine", choices=["chromium", "webkit", "both"], default="both")
    parser.add_argument("--case", choices=[fn.__name__ for fn in TESTS])
    args = parser.parse_args()
    with Mock() as mock, sync_playwright() as pw:
        if not args.case or args.case == "coexistence":
            mock.load_p731()
        for name in (["chromium", "webkit"] if args.engine == "both" else [args.engine]):
            browser = launch(getattr(pw, name), mock)
            print(name, browser.version, flush=True)
            try:
                for fn in TESTS:
                    if not args.case or args.case == fn.__name__:
                        fn(browser, mock)
                        print("PASS", name, fn.__name__, flush=True)
            finally:
                browser.close()
