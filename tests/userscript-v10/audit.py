"""Regression cases using the released install file; mock TLS terminates every connection."""
import json
import sys
from harness import v9, install
from mock_huitu import CLOSED, OCCUPIED, SUCCESS, UID, ORIGIN, BOOK
from playwright.sync_api import expect, sync_playwright

def snapshot(p):
    v9.field(p,"#history").click()
    r=json.loads(v9.field(p,"#snapshot").input_value())
    v9.field(p,"#copyHistory").click()
    assert json.loads(p.evaluate("window.copiedDiagnostic"))==r
    return r

def replies_and_restore(b,mock):
    cases=[("SERVER_SUCCESS",{"business":SUCCESS},True),
           ("NOT_OPEN",{"business":CLOSED},False),
           ("SEAT_UNAVAILABLE",{"business":OCCUPIED,"pause_book":2.2},False),
           ("EXISTING",{"business":{"CODE":"ParamError","DATA":{"msg":"已有预约 "+UID}}},False),
           ("HTTP_404",{"http":404,"business":{"CODE":"NotFound"}},None),
           ("RESPONSE_UNKNOWN",{"raw_body":b'{"CODE":"ok",'},None),
           ("NETWORK_ERROR",{"disconnect":True},None),
           ("TIMEOUT",{"pause_book":31},None)]
    for result,setup,accepted in cases:
        with v9.case(b,mock,**setup) as (ctx,f):
            p=v9.visit(ctx)
            if result=="TIMEOUT":
                ctx.set_default_timeout(37000)
                p.set_default_timeout(37000)
            v9.start(p)
            cur=v9.wait_report(p,result=result,state="verified" if accepted else "unknown" if accepted is None else "failed")
            assert cur["accepted"] is accepted and cur["recordVerified"]==bool(accepted)
            assert cur["prepareStartedAt"] and cur["preparedAt"] and cur["dispatchAt"]
            assert cur["sends"]==cur["attempts"]==len(f.posts)==1 and f.posts[0]["valid"]
            assert cur["storageStatus"]=="SAVED" and cur["version"]=="10.0.0"
            if result=="SEAT_UNAVAILABLE": assert cur["httpMs"]>=2100 and cur["failureMessage"]
            if result=="EXISTING": assert cur["failureMessage"]=="已有预约"
            if result not in ("RESPONSE_UNKNOWN","NETWORK_ERROR","TIMEOUT"): assert cur["businessAt"]
            calls=list(f.events)
            p.reload()
            v9.field(p,"summary").click()
            assert v9.exported(p)==cur
            assert snapshot(p)==cur
            p.close()
            p=v9.visit(ctx)
            assert v9.exported(p)==cur and snapshot(p)==cur and calls==f.events
            assert UID not in json.dumps(cur)
            if result=="HTTP_404":
                # Clear history via the UI, attempt overlap with a different start hour.
                p.once("dialog",lambda d:d.accept())
                v9.field(p,"#clearHistory").click()
                assert v9.field(p,"#runs").locator("option").count()==0
                v9.set_time(p,v9.OPEN+120000)
                v9.field(p,"#from").select_option("8")
                v9.start(p)
                v9.wait_report(p,result="DUPLICATE",sends=0)
                assert len(f.posts)==1
            elif result=="SERVER_SUCCESS":
                p.evaluate("""()=>Object.keys(localStorage).filter(k=>/^hdu-v9:[a-f0-9]{64}$/.test(k)).forEach(k=>localStorage.removeItem(k))""")
                p.reload()
                v9.field(p,"summary").click()
                assert snapshot(p)==cur and f.events==calls
            print("PASS restore",result,flush=True)

def platform(b,mock):
    for name,script in [
        ("no Web Lock","Object.defineProperty(navigator,'locks',{value:undefined})"),
        ("lock rejection","navigator.locks.request=()=>Promise.reject(Error('denied'))"),
        ("resource timing missing","performance.getEntriesByName=undefined"),
        ("history quota","""const orig=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){
           if(k.startsWith('hdu-v10:history:'))throw new DOMException('quota','QuotaExceededError');return orig.call(this,k,v)}"""),
        ("intent quota","""const orig=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){
           if(/^hdu-v9:[a-f0-9]{64}$/.test(k))throw Error('quota');return orig.call(this,k,v)}""")]:
        with v9.case(b,mock) as (ctx,f):
            p=v9.visit(ctx)
            p.evaluate("()=>{"+script+"}")
            v9.start(p)
            if name.startswith(("no Web","lock rejection","intent quota")):
                v9.wait_report(p,result="GUARD_UNAVAILABLE" if name=="intent quota" else "LOCK_UNAVAILABLE",sends=0)
                assert not f.posts
            else:
                r=v9.wait_report(p,state="verified")
                if name=="resource timing missing": assert all(r[k] is None for k in ("requestStartAt","responseWaitMs","responseDownloadMs"))
                else:
                    expect(v9.field(p,"#storage")).to_contain_text("复制诊断")
                    assert r["storageStatus"]=="ERROR"
                assert len(f.posts)==1
        print("PASS",name,flush=True)
    with v9.case(b,mock,pause_records=5.5) as (ctx,f):
        p=v9.visit(ctx)
        v9.start(p)
        r=v9.wait_report(p,result="SERVER_SUCCESS",verification="timeout")
        assert r["accepted"] and not r["recordVerified"] and len(f.posts)==1
        f.pause_records=0
        v9.field(p,"#review").click()
        v9.wait_report(p,state="verified")
        f.read_status=404
        v9.field(p,"#review").click()
        r=v9.wait_report(p,verification="http404")
        assert r["recordVerified"] and r["verifiedAt"] and r["state"]=="verified"
        assert len(f.posts)==1
        print("PASS read timeout, then match, then 404",flush=True)
    with v9.case(b,mock) as (ctx,f):
        p=v9.visit(ctx,mode="scheduled",at=v9.OPEN-60000)
        v9.start(p)
        v9.wait_report(p,state="waiting")
        p.evaluate("n=>{document.dispatchEvent(new Event('freeze'));setWall(n)}",v9.OPEN+9000)
        assert not f.posts
        p.evaluate("document.dispatchEvent(new Event('resume'))")
        r=v9.wait_report(p,state="verified")
        assert r["clockChangeMs"]>60000 and r["scheduleLagMs"]>7000 and r["hiddenDuringWait"] and not r["inWindow"]
        print("PASS simulated freeze and forward clock jump",flush=True)
    with v9.case(b,mock,scripts=("baseline","v9")) as (ctx,f):
        p=v9.visit(ctx)
        expect(v9.field(p,"#start")).to_be_disabled()
        assert not f.posts
    with v9.case(b,mock,scripts=("v9","baseline")) as (ctx,f):
        p=v9.visit(ctx)
        assert p.evaluate("!document.getElementById('hdu-ipad-v9-lite').shadowRoot")
        v9.start(p)
        v9.wait_report(p,state="verified")
        assert len(f.posts)==1
    print("PASS V9/V10 both load orders",flush=True)

def lifecycle_and_migration(b,mock):
    with v9.case(b,mock,uid=None) as (ctx,f):
        p=v9.visit(ctx)
        ids=[]
        for _ in range(32):
            v9.start(p)
            r=v9.wait_report(p,result="AUTH_REQUIRED")
            ids.append(r["runId"])
        latest=snapshot(p)
        options=v9.field(p,"#runs").locator("option").evaluate_all("opts=>opts.map(o=>o.value)")
        assert options==ids[-30:][::-1] and latest["runId"]==ids[-1] and len(set(ids))==32 and not f.posts
    print("PASS latest 30 of 32 independent tasks",flush=True)
    with v9.case(b,mock) as (ctx,f):
        p=v9.visit(ctx,mode="scheduled",at=v9.OPEN-60000)
        v9.start(p)
        v9.wait_report(p,state="waiting")
        p.evaluate("t=>{setWall(t);window.dispatchEvent(new Event('pageshow'))}",v9.OPEN-120000)
        assert not f.posts
        v9.field(p,"#stop").click()
        r=v9.wait_report(p,state="ended",result="STOPPED")
        p.close()
        q=v9.visit(ctx)
        assert snapshot(q)==r and not f.posts
    print("PASS backward clock, stopped task restored on reopen",flush=True)
    with v9.case(b,mock,http=504) as (ctx,f):
        install(mock,9)
        p=v9.visit(ctx)
        v9.start(p)
        v9.wait_report(p,state="unknown")
        p.close()
        install(mock,10)
        q=v9.visit(ctx,at=v9.OPEN+120000)
        v9.start(q)
        v9.wait_report(q,result="HTTP_UNCERTAIN")
        assert len(f.posts)==1
    print("PASS V9 pending receipt survives V10 install",flush=True)
    with v9.case(b,mock,http=404) as (ctx,f):
        p=v9.visit(ctx)
        v9.start(p)
        v9.wait_report(p,result="HTTP_404")
        p.close()
        install(mock,9)
        q=v9.visit(ctx,at=v9.OPEN+120000)
        v9.start(q)
        v9.wait_report(q,state="unknown")
        assert len(f.posts)==1
        install(mock,10)
    print("PASS rollback respects V10 pending intent",flush=True)

def stale_tab_review(b,mock):
    with v9.case(b,mock,auto_record=False) as (ctx,f):
        a=v9.visit(ctx)
        v9.start(a)
        v9.wait_report(a,state="accepted",verification="absent")
        stale=v9.visit(ctx)
        assert v9.exported(stale)["state"]=="accepted"
        a.bring_to_front()
        f.records=[f.posts[0]["record"]]
        v9.field(a,"#review").click()
        verified=v9.wait_report(a,state="verified")
        stale.bring_to_front()
        f.uid=None
        v9.field(stale,"#review").click()
        v9.wait_report(stale,verification="auth")
        assert snapshot(stale)==verified and len(f.posts)==1
    print("PASS stale-tab login failure preserves other tab's later verified receipt",flush=True)

if __name__=="__main__":
    with v9.Mock() as mock,sync_playwright() as pw:
        install(mock,10)
        b=v9.launch(pw.webkit,mock)
        for fn in [platform,replies_and_restore,lifecycle_and_migration,stale_tab_review]:
            if not sys.argv[1:] or fn.__name__ in sys.argv[1:]: fn(b,mock)
        b.close()
