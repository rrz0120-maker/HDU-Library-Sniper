import argparse
import json
import os
from contextlib import contextmanager
from datetime import datetime

from playwright.sync_api import expect, sync_playwright
from server import BASE, BOOK, CATALOG, ORIGIN, RANGE, RECORD, UID, Mock, State

OPEN = int(datetime.fromisoformat("2026-11-22T20:00:00+08:00").timestamp()*1000)
INIT = """
const wall = Date.now.bind(Date);
window.setWall = n => {
  window.timeShift = n-wall();
  Date.now = () => wall()+window.timeShift;
  window.dispatchEvent(new Event('pageshow'));
  return window.timeShift;
};
window.setHidden = hidden => {
  Object.defineProperty(document,'hidden',{configurable:true,value:hidden});
  document.dispatchEvent(new Event('visibilitychange'));
};
Object.defineProperty(navigator,'clipboard',{configurable:true,value:{
  writeText:async text=>{window.copied=text;}
}});
"""
def el(p, name):
    return p.locator("#hdu-p62-host").locator(name)

def visit(context, at=OPEN-60000):
    p=context.new_page()
    p.goto(ORIGIN)
    el(p,"summary").click()
    p.evaluate("n=>setWall(n)",at)
    el(p,"#offset").dispatch_event("input")
    return p

def result(p, **fields):
    p.wait_for_function("""fields=>{
      const r=JSON.parse(sessionStorage.getItem('hdu-p62:last-report'));
      return r && Object.entries(fields).every(([k,v])=>r[k]===v);
    }""",arg=fields)
    return p.evaluate("JSON.parse(sessionStorage.getItem('hdu-p62:last-report'))")

def export(p):
    el(p,"#copy").click()
    return json.loads(p.evaluate("window.copied"))

def arm(p):
    el(p,"#start").click()
    result(p,state="WAITING")
    return p

def release(p, offset=1350):
    p.evaluate("n=>setWall(n)",OPEN+offset)
    el(p,"#offset").dispatch_event("input")

@contextmanager
def case(browser,mock,**settings):
    mock.state=state=State()
    for k,v in settings.items():setattr(state,k,v)
    context=browser.new_context(ignore_https_errors=True,viewport={"width":412,"height":860},
      has_touch=True,timezone_id="America/Los_Angeles")
    context.add_init_script(INIT)
    errors=[]
    context.on("page",lambda page:page.on("pageerror",lambda e:errors.append(str(e))))
    context.set_default_timeout(6500)
    try:
        yield context,state
        assert not errors,errors
    finally:
        context.close()

def direct_success(browser,mock):
    with case(browser,mock,write_delay=.15,record_delay=.3) as (ctx,s):
        p=arm(visit(ctx))
        assert s.requests==[("GET",BASE),("GET",CATALOG),("GET",RANGE)] and not s.posts
        # After preparation all preflight endpoints fail. They must never be revisited before POST.
        s.range_status=500
        release(p)
        result(p,state="SENDING")
        result(p,state="ACCEPTED",accepted=True)
        r=result(p,state="SUCCESS",recordVerified=True)
        assert r["inWindow"] and r["attempts"]==1 and r["httpMs"]>=140
        assert s.posts[0]["valid"] and s.posts[0]["record"]["duration"]=="50400"
        assert s.requests==[("GET",BASE),("GET",CATALOG),("GET",RANGE),("POST",BOOK),("GET",RECORD)]
        el(p,"#review").click()
        expect(el(p,"#start")).to_be_enabled()
        el(p,"#start").click()
        result(p,state="SUCCESS")
        assert len(s.posts)==1

def exact_boundary(browser,mock):
    for storage_delay in [0,125]:
        with case(browser,mock) as (ctx,s):
            p=visit(ctx)
            p.evaluate("""([open,delay])=>{
              let current=open-60000;
              Date.now=()=>current;
              window.advance=n=>{current=n;window.dispatchEvent(new Event('pageshow'));};
              const set=Storage.prototype.setItem, request=window.fetch;
              Storage.prototype.setItem=function(k,v) {
                if(/^hdu-p62:[a-f0-9]{64}$/.test(k) && v.includes('"attempts":null')) current+=delay;
                return set.call(this,k,v);
              };
              window.fetch=function(url,opts) {
                if(String(url).includes('/bookSeats')) window.handoffAt=Date.now();
                return request.call(this,url,opts);
              };
            }""",[OPEN,storage_delay])
            arm(p)
            p.evaluate("n=>advance(n)",OPEN+1349)
            assert not s.posts
            p.evaluate("n=>advance(n)",OPEN+1350)
            r=result(p,state="SUCCESS")
            assert r["delayFrom20Ms"]==1350+storage_delay
            assert int(datetime.fromisoformat(r["dispatchAt"]).timestamp()*1000)==p.evaluate("handoffAt")

def custom_hours_and_preflight(browser,mock):
    with case(browser,mock,session=False) as (ctx,s):
        p=visit(ctx)
        el(p,"#start").click()
        result(p,state="IDLE",reason="AUTH_REQUIRED",attempts=0)
        s.session=True
        s.max_duration=13
        el(p,"#start").click()
        result(p,state="IDLE",reason="TIME_NOT_ALLOWED",attempts=0)
        assert not s.posts
        el(p,"#startHour").select_option("9")
        el(p,"#offset").fill("800")
        arm(p)
        release(p,800)
        r=result(p,state="SUCCESS")
        assert r["startHour"]==9 and r["offsetMs"]==800
        assert s.posts[0]["record"]["duration"]=="46800"

def replies(browser,mock):
    cases=[
      (200,{"CODE":"ParamError","DATA":{"msg":"未到开放时间"}},"NOT_OPEN"),
      (200,{"CODE":"ParamError","MESSAGE":"座位不可用，已被占用"},"SEAT_UNAVAILABLE"),
      (200,{"CODE":"1","DATA":{"msg":"请求过于频繁，请10分钟后再试"}},"LIMITED"),
      (429,{"CODE":"LIMITED"},"LIMITED"),
      (401,{"ui_type":"com.Redirect"},"AUTH_REQUIRED"),
      (404,{"CODE":"NotFound"},"HTTP_404"),
      (200,{"CODE":"ParamError","MESSAGE":"其他原因 "+UID+" PRIVATE_TOKEN"},"BUSINESS_REJECTED"),
    ]
    for status,body,reason in cases:
        with case(browser,mock,status=status,reply=body,retry_after="901") as (ctx,s):
            p=arm(visit(ctx))
            release(p)
            r=result(p,reason=reason,attempts=1,businessCode=body.get("CODE"))
            assert r["state"]==("UNKNOWN" if reason=="HTTP_404" else "FAILED")
            assert r["httpStatus"]==status and r["businessCode"]==body.get("CODE")
            text=body.get("DATA",{}).get("msg") or body.get("MESSAGE")
            if text:expect(el(p,"#reason")).to_contain_text(text)
            assert len(s.posts)==1 and ("GET",RECORD) not in s.requests
            assert reason not in ["OPEN_RANGE_UNCONFIRMED"]
            if reason=="BUSINESS_REJECTED":
                log=json.dumps(export(p))
                for secret in [UID,"PRIVATE_TOKEN","PRIVATE_NAME","Api-Token","fixture_session"]:
                    assert secret not in log
            if reason=="LIMITED":
                p.reload()
                el(p,"summary").click()
                release(p,700000)
                el(p,"#startHour").select_option("9")
                el(p,"#start").click()
                result(p,state="IDLE",reason="LIMITED",attempts=0)
                assert len(s.posts)==1

def visibility_and_restart(browser,mock):
    with case(browser,mock) as (ctx,s):
        p=visit(ctx)
        p.evaluate("""()=>{
          localStorage.setItem('hdu-p60-control:2026-11-22:stop','1');
          localStorage.setItem('hdu-p60:probe:2026-11-24:08:00-22:00:stop','1');
        }""")
        arm(p)
        p.evaluate("setHidden(true)")
        p.evaluate("document.dispatchEvent(new Event('freeze'))")
        p.evaluate("window.dispatchEvent(new Event('pagehide'))")
        p.evaluate("setHidden(false)")
        result(p,state="WAITING",attempts=0)
        el(p,"#stop").click()
        result(p,state="IDLE",reason="USER_STOPPED",attempts=0)
        arm(p)
        p.reload()
        el(p,"summary").click()
        p.evaluate("n=>setWall(n)",OPEN-60000)
        el(p,"#offset").dispatch_event("input")
        assert export(p)["attempts"]==0 and not s.posts
        arm(p)
        p.evaluate("setHidden(true)")
        release(p,1300)
        assert not s.posts
        p.evaluate("setHidden(false)")
        r=result(p,state="SUCCESS")
        assert r["hiddenDuringWait"] and r["inWindow"] and len(s.posts)==1

def suspended_late(browser,mock):
    for offset in [8200,86400000]:
        with case(browser,mock) as (ctx,s):
            p=arm(visit(ctx))
            p.evaluate("setHidden(true)")
            release(p,offset)
            assert not s.posts
            p.evaluate("setHidden(false)")
            if offset<86400000:
                r=result(p,state="SUCCESS")
                assert r["inWindow"] is False and r["delayFrom20Ms"]>=offset
                expect(el(p,"#reason")).to_contain_text("已超出准点窗口")
            else:
                result(p,state="IDLE",reason="DAY_EXPIRED",attempts=0)
                assert not s.posts

def refresh_after_send(browser,mock):
    with case(browser,mock,write_delay=1,auto_record=False) as (ctx,s):
        p=arm(visit(ctx))
        release(p)
        result(p,state="SENDING")
        p.reload()
        el(p,"summary").click()
        release(p,20000)
        el(p,"#start").click()
        r=result(p,state="UNKNOWN",attempts=1)
        assert r["dispatchAt"] and len(s.posts)==1
        el(p,"#review").click()
        result(p,verification="ABSENT")
        assert len(s.posts)==1

def uncertain(browser,mock):
    for setup,expected in [({"disconnect":True},"NETWORK_ERROR"),({"raw":b"<html>busy"},"RESPONSE_UNKNOWN"),
                           ({"status":504},"HTTP_ERROR")]:
        with case(browser,mock,auto_record=False,**setup) as (ctx,s):
            p=arm(visit(ctx))
            release(p)
            result(p,state="UNKNOWN",reason=expected)
            release(p,20000)
            el(p,"#start").click()
            result(p,state="UNKNOWN",reason=expected)
            el(p,"#review").click()
            result(p,verification="ABSENT")
            s.records=[s.posts[0]["record"]]
            el(p,"#review").click()
            result(p,state="SUCCESS",recordVerified=True,reason=expected)
            assert len(s.posts)==1

def timeout(browser,mock):
    with case(browser,mock,write_delay=2,auto_record=False) as (ctx,s):
        p=arm(visit(ctx))
        p.evaluate("""()=>{
          const set=window.setTimeout;
          window.setTimeout=function(fn,delay,...args) {
            return set(fn,delay===30000?120:delay,...args);
          };
        }""")
        release(p)
        r=result(p,state="UNKNOWN",reason="TIMEOUT")
        assert r["attempts"]==1 and len(s.posts)==1
        el(p,"#review").click()
        result(p,verification="ABSENT")

def two_tabs(browser,mock):
    with case(browser,mock) as (ctx,s):
        a=arm(visit(ctx))
        b=visit(ctx)
        el(b,"#start").click()
        result(b,state="IDLE",reason="ACTIVE_TAB",attempts=0)
        a.bring_to_front()
        release(a)
        result(a,state="SUCCESS")
        b.bring_to_front()
        el(b,"#start").click()
        result(b,state="SUCCESS")
        assert len(s.posts)==1

def verification(browser,mock):
    with case(browser,mock,record_status=503,auto_record=False) as (ctx,s):
        p=arm(visit(ctx))
        release(p)
        result(p,state="ACCEPTED",accepted=True,verification="ERROR")
        s.record_status=200
        target=s.posts[0]["record"]
        s.records=[dict(target,status="3"),dict(target,seatNum="161"),dict(target,duration=3600)]
        el(p,"#review").click()
        result(p,verification="ABSENT",accepted=True)
        s.uid="999991"
        el(p,"#review").click()
        expect(el(p,"#reason")).to_contain_text("当前登录账号")
        s.uid=UID
        s.records=[target]
        el(p,"#review").click()
        result(p,state="SUCCESS",recordVerified=True)

def optional_diagnostics(browser,mock):
    with case(browser,mock) as (ctx,s):
        p=visit(ctx)
        p.evaluate("""()=>{
          const get=Storage.prototype.getItem,set=Storage.prototype.setItem;
          Storage.prototype.getItem=function(k){if(this===sessionStorage)throw Error();return get.call(this,k);};
          Storage.prototype.setItem=function(k,v){if(this===sessionStorage)throw Error();return set.call(this,k,v);};
        }""")
        el(p,"#start").click()
        expect(el(p,"#state")).to_have_text("等待20:00")
        release(p)
        expect(el(p,"#state")).to_have_text("预约成功且记录已核验")
        assert export(p)["attempts"]==1 and len(s.posts)==1
        p.evaluate("()=>{navigator.clipboard.writeText=async()=>{throw Error()};}")
        el(p,"#copy").click()
        expect(el(p,"#log")).to_be_visible()
        assert json.loads(el(p,"#log").input_value())["recordVerified"]

def synchronous_failure(browser,mock):
    with case(browser,mock) as (ctx,s):
        p=arm(visit(ctx))
        p.evaluate("""()=>{
          const request=fetch;
          window.fetch=(url,opts)=>{
            if(String(url).includes('/bookSeats')) {window.fetch=request;throw TypeError();}
            return request(url,opts);
          };
        }""")
        release(p)
        result(p,state="IDLE",attempts=0)
        assert not s.posts
        el(p,"#start").click()
        result(p,state="SUCCESS")
        assert len(s.posts)==1

def old_scripts(browser,mock):
    for old in ["p60","p611"]:
        for scripts in [[old,"p62"],["p62",old]]:
            with case(browser,mock,scripts=scripts) as (ctx,s):
                p=visit(ctx)
                mounted=p.evaluate("!!document.getElementById('hdu-p60-host')?.shadowRoot")
                if scripts[0]==old:
                    assert mounted
                    expect(el(p,"#start")).to_be_disabled()
                    expect(el(p,"#reason")).to_contain_text("检测到旧版")
                else:
                    assert not mounted
                    p.add_script_tag(content=mock.files["p62"].decode())
                    assert p.locator("#hdu-p62-host").count()==1
                    arm(p)
                    release(p)
                    result(p,state="SUCCESS")
                    assert len(s.posts)==1
                assert p.evaluate("window.fetch===window.originalFetch")
                before=len(s.posts)
                with p.expect_response(lambda r:r.url.endswith(BOOK)):
                    p.locator("#official").click()
                assert s.posts[before:]==[{"manual":True}]

def layout(browser,mock):
    with case(browser,mock) as (ctx,s):
        p=visit(ctx)
        for width,height in [(412,860),(860,412),(320,568)]:
            p.set_viewport_size({"width":width,"height":height})
            box=el(p,"details").bounding_box()
            assert box["x"]>=0 and box["y"]>=0 and box["x"]+box["width"]<=width+1
            assert box["y"]+box["height"]<=height+1
        el(p,"summary").click()
        expect(el(p,"#start")).to_be_hidden()

def crash_intent(browser,mock):
    with case(browser,mock,disconnect=True,auto_record=False) as (ctx,s):
        p=arm(visit(ctx))
        release(p)
        result(p,state="UNKNOWN",attempts=1)
        p.evaluate("""()=>{
          const name=sessionStorage.getItem('hdu-p62:last-store');
          const ledger=JSON.parse(localStorage.getItem(name));
          const report=Object.values(ledger.requests)[0];
          Object.assign(report,{state:'UNKNOWN',reason:'PENDING',attempts:null,dispatchAt:null});
          localStorage.setItem(name,JSON.stringify(ledger));
          sessionStorage.setItem('hdu-p62:last-report',JSON.stringify({...report,state:'WAITING',attempts:0}));
        }""")
        p.reload()
        el(p,"summary").click()
        r=export(p)
        assert r["attempts"] is None and r["dispatchAt"] is None and r["state"]=="UNKNOWN"
        release(p,20000)
        el(p,"#start").click()
        result(p,state="UNKNOWN",reason="PENDING",attempts=None)
        assert len(s.posts)==1

def cancelled_record(browser,mock):
    with case(browser,mock) as (ctx,s):
        p=arm(visit(ctx))
        release(p)
        result(p,state="SUCCESS")
        s.records=[]
        el(p,"#review").click()
        result(p,verification="ABSENT",recordVerified=False)
        release(p,30000)
        el(p,"#start").click()
        result(p,state="SUCCESS")
        assert len(s.posts)==2

TESTS=[direct_success,exact_boundary,custom_hours_and_preflight,replies,visibility_and_restart,
       suspended_late,refresh_after_send,uncertain,timeout,two_tabs,verification,optional_diagnostics,
       synchronous_failure,old_scripts,layout,crash_intent,cancelled_record]

def launch(pw,name,mock):
    args={"proxy":{"server":mock.proxy}}
    if name=="chromium" and os.environ.get("CHROMIUM_PATH"):args["executable_path"]=os.environ["CHROMIUM_PATH"]
    return getattr(pw,name).launch(**args)

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--engine",choices=["chromium","firefox","both"],default="both")
    parser.add_argument("--case",choices=[f.__name__ for f in TESTS])
    args=parser.parse_args()
    with Mock() as mock,sync_playwright() as pw:
        for name in ["chromium","firefox"] if args.engine=="both" else [args.engine]:
            browser=launch(pw,name,mock)
            print(name,browser.version,flush=True)
            try:
                for fn in TESTS:
                    if args.case and args.case!=fn.__name__:continue
                    fn(browser,mock)
                    print("PASS",name,fn.__name__,flush=True)
            finally:browser.close()
