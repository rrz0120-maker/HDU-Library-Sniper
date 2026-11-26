"""SIMULATED: actual bundles, local TLS only, with ordered network trace comparison."""
import json
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "userscript-p62"))
import browser as suite
from server import Mock, ROOT, BASE, CATALOG, RANGE, BOOK, RECORD
from playwright.sync_api import sync_playwright, expect

def reject(message, result=None):
    data={"msg":message}
    if result is not None: data["result"]=result
    return {"CODE":"ParamError","DATA":data}

CASES=[
 ("seat",{"reply":reject("选择的座位无法预约，可能座位不可用或已经被其他人锁定或占用。","fail")},"SEAT_UNAVAILABLE","FAILED"),
 ("account",{"reply":reject("该账户无法预约")},"BUSINESS_REJECTED","FAILED"),
 ("accountLocked",{"reply":reject("该账户无法预约座位，账户已被锁定")},"BUSINESS_REJECTED","FAILED"),
 ("occupied",{"reply":reject("座位已被其他人占用")},"SEAT_UNAVAILABLE","FAILED"),
 ("unknownSeat",{"reply":reject("座位状态说明：占用信息暂不可用")},"RESPONSE_UNKNOWN","UNKNOWN"),
 ("parameter",{"reply":reject("参数错误")},"BUSINESS_REJECTED","FAILED"),
 ("opening",{"reply":reject("未到开放时间")},"NOT_OPEN","FAILED"),
 ("range",{"reply":reject("超出可预约座位时间范围")},"TIME_RANGE_INVALID","FAILED"),
 ("existing",{"reply":reject("已有预约")},"EXISTING","FAILED"),
 ("limit",{"reply":reject("请求过于频繁，请10分钟后再试")},"LIMITED","FAILED"),
 ("http429",{"status":429,"reply":None},"LIMITED","FAILED"),
 ("auth",{"status":401,"reply":{"CODE":"AUTH_REQUIRED"}},"AUTH_REQUIRED","FAILED"),
 ("authText",{"reply":reject("登录状态已失效")},"AUTH_REQUIRED","FAILED"),
 ("authCode",{"reply":{"CODE":"AUTH_REQUIRED"}},"AUTH_REQUIRED","FAILED"),
 ("http404",{"status":404,"reply":reject("座位不可用")},"HTTP_404","UNKNOWN"),
 ("http503",{"status":503},"HTTP_ERROR","UNKNOWN"),
 ("invalid",{"raw":b"<html>busy"},"INVALID_RESPONSE","UNKNOWN"),
 ("jsonNull",{"raw":b"null"},"RESPONSE_UNKNOWN","UNKNOWN"),
 ("empty",{"reply":{}},"RESPONSE_UNKNOWN","UNKNOWN"),
 ("codeOnly",{"reply":{"CODE":"ok"}},"RESPONSE_UNKNOWN","UNKNOWN"),
 ("unknownText",{"reply":reject("新消息 PRIVATE_TOKEN 王某")},"RESPONSE_UNKNOWN","UNKNOWN"),
 ("unknownCode",{"reply":{"CODE":"PRIVATE_TOKEN","DATA":{"result":"PRIVATE_TOKEN","msg":"PRIVATE_NAME"}}},"RESPONSE_UNKNOWN","UNKNOWN"),
 ("genericFail",{"reply":reject("新消息","fail")},"BUSINESS_REJECTED","FAILED"),
 ("network",{"disconnect":True},"NETWORK_ERROR","UNKNOWN"),
 ("timeout",{"write_delay":2},"TIMEOUT","UNKNOWN"),
 ("acceptedAbsent",{},"SERVER_SUCCESS","ACCEPTED"),
 ("verifyError",{"record_status":503},"SERVER_SUCCESS","ACCEPTED"),
 ("verified",{"auto_record":True},"SERVER_SUCCESS","SUCCESS"),
]
EXPECTED_LABELS={"FAILED":"业务明确拒绝","UNKNOWN":"结果待核实","ACCEPTED":"已受理，尚未核验成功","SUCCESS":"预约成功且记录已核验"}

def paired(browser,mock):
    measured=[]
    for name,config,reason,state in CASES:
        traces=[]
        for version in ["6.3","6.4"]:
            mock.files["p62"]=(ROOT/f"userscripts/HDU_Android_P{version}_Lite.user.js").read_bytes()
            settings={"auto_record":False,**config}
            with suite.case(browser,mock,**settings) as (ctx,s):
                p=suite.arm(suite.visit(ctx))
                # A second click during preparation/waiting cannot authorize a second write.
                suite.el(p,"#start").dispatch_event("click")
                if name=="timeout":
                    p.evaluate("""()=>{const original=setTimeout;window.setTimeout=(f,ms,...a)=>original(f,ms===30000?120:ms,...a);}""")
                suite.release(p)
                p.wait_for_function("""()=>{
                  const r=JSON.parse(sessionStorage.getItem('hdu-p62:last-report'));
                  return r?.attempts===1 && ['FAILED','UNKNOWN','ACCEPTED','SUCCESS'].includes(r.state)
                    && r.verification!=='CHECKING' && r.storageStatus==='SAVED';
                }""")
                r=suite.export(p)
                assert len(s.posts)==1 and s.posts[0]["valid"], name
                traces.append(list(s.requests))
                ledger=p.evaluate("JSON.parse(localStorage.getItem(sessionStorage.getItem('hdu-p62:last-store')))")
                saved=list(ledger["requests"].values())[0]
                if version=="6.4":
                    assert (r["reason"],r["state"])==(reason,state),(name,r)
                    assert saved["reason"]==reason and saved["state"]==state
                    expect(suite.el(p,"#state")).to_contain_text(EXPECTED_LABELS[state])
                    if name=="range":expect(suite.el(p,"#reason")).to_contain_text("超出允许预约时间范围")
                    if name=="invalid":assert r["missingFields"]["businessCode"]=="INVALID_RESPONSE"
                    if name=="empty":assert r["missingFields"]["businessCode"]=="ABSENT"
                    if name=="unknownCode":assert r["missingFields"]["businessCode"]=="REDACTED"
                    assert not any(secret in json.dumps(r) for secret in ["PRIVATE_TOKEN","PRIVATE_NAME","王某","fixture_session"])
                    assert r["classifierVersion"]=="p64.1"
                    # No second POST after reload/new tab for unresolved or accepted outcomes.
                    if state in ["UNKNOWN","ACCEPTED","SUCCESS"]:
                        p.reload()
                        suite.el(p,"summary").click()
                        suite.release(p,20000)
                        suite.el(p,"#start").click()
                        p.wait_for_function("!document.querySelector('#hdu-p62-host').shadowRoot.querySelector('#start').disabled")
                        assert len(s.posts)==1,(name,"repeated write")
                measured.append({"case":name,"version":version,"reason":r["reason"],"state":r["state"],"network":traces[-1],"posts":len(s.posts)})
        assert traces[0]==traces[1],(name,traces)
        print("PASS paired",name,flush=True)
    return measured

def history_storage(browser,mock):
    mock.files["p62"]=(ROOT/"userscripts/HDU_Android_P6.4_Lite.user.js").read_bytes()
    with suite.case(browser,mock,reply=reject("参数错误")) as (ctx,s):
        p=suite.visit(ctx)
        old=json.dumps([{"version":"6.3.0","runId":"old","reason":"NOT_OPEN","failureMessage":"超出可预约座位时间范围"}],ensure_ascii=False)
        p.evaluate("(s)=>localStorage.setItem('hdu-p63:history',s)",old)
        suite.arm(p)
        p.evaluate("""()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){
          if(k==='hdu-p64:history')throw Error('full');return set.call(this,k,v);};}""")
        suite.release(p)
        suite.result(p,state="FAILED",reason="BUSINESS_REJECTED",storageStatus="ERROR")
        expect(suite.el(p,"#reason")).to_contain_text("诊断存储异常")
        assert p.evaluate("localStorage.getItem('hdu-p63:history')")==old
        assert len(s.posts)==1
    with suite.case(browser,mock,disconnect=True,auto_record=False) as (ctx,s):
        p=suite.arm(suite.visit(ctx))
        p.evaluate("""()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){
          if(k.startsWith('hdu-p62:') && k.length>64 && v.includes('NETWORK_ERROR'))throw Error('receipt');
          return set.call(this,k,v);};}""")
        suite.release(p)
        suite.result(p,state="UNKNOWN",diagnosticStorageFailed=True)
        p.close()
        q=suite.visit(ctx,at=suite.OPEN+20000)
        suite.el(q,"#start").click()
        suite.result(q,state="UNKNOWN")
        assert len(s.posts)==1

def mixed_versions(browser,mock):
    old=(ROOT/"userscripts/HDU_Android_P6.3_Lite.user.js").read_bytes()
    new=(ROOT/"userscripts/HDU_Android_P6.4_Lite.user.js").read_bytes()
    mock.files.update(p62=old,p64=new)
    for scripts in [["p62","p64"],["p64","p62"]]:
        with suite.case(browser,mock,scripts=scripts) as (ctx,s):
            p=suite.arm(suite.visit(ctx))
            assert p.locator("#hdu-p62-host").count()==1
            suite.release(p)
            suite.result(p,state="SUCCESS")
            assert len(s.posts)==1
    mock.files["p62"]=new
    with suite.case(browser,mock,raw=b"<html>",auto_record=False) as (ctx,s):
        p=suite.arm(suite.visit(ctx))
        suite.release(p)
        suite.result(p,state="UNKNOWN",reason="INVALID_RESPONSE",storageStatus="SAVED")
        evidence=p.evaluate("localStorage.getItem('hdu-p64:history')")
        mock.files["p62"]=old
        p.reload()
        suite.el(p,"summary").click()
        suite.release(p,20000)
        suite.el(p,"#start").click()
        suite.result(p,state="UNKNOWN",attempts=1)
        assert len(s.posts)==1
        assert p.evaluate("localStorage.getItem('hdu-p64:history')")==evidence
    print("PASS mixed_versions (two loading orders and rollback pending)",flush=True)

if __name__=="__main__":
    engine=sys.argv[1]
    with Mock() as mock,sync_playwright() as pw:
        browser=suite.launch(pw,engine,mock)
        try:
            if "--compat-only" in sys.argv:
                mixed_versions(browser,mock)
                sys.exit(0)
            rows=paired(browser,mock)
            mock.files["p62"]=(ROOT/"userscripts/HDU_Android_P6.4_Lite.user.js").read_bytes()
            for fn in suite.TESTS:
                if fn.__name__ in ["replies","uncertain"]:continue  # Superseded by the paired receipt matrix above.
                fn(browser,mock)
                print("PASS regression",fn.__name__,flush=True)
            history_storage(browser,mock)
            print("PASS history_storage",flush=True)
            mixed_versions(browser,mock)
            destination=ROOT/"docs/evidence/p64"
            destination.mkdir(parents=True,exist_ok=True)
            (destination/f"{engine}-network.json").write_text(json.dumps({"kind":"SIMULATED","browser":browser.version,"rows":rows},ensure_ascii=False,indent=2)+"\n")
        finally:
            browser.close()
