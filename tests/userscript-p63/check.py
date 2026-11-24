"""Exercise the built bundle through the P6.2 local TLS fixture."""
import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "userscript-p62"))
import browser as suite
from server import Mock, ROOT
from timing import sample
from playwright.sync_api import sync_playwright, expect

def history(browser, mock):
    for success in (True, False):
        with suite.case(browser, mock) as (ctx, state):
            if not success:
                state.reply = {"CODE":"ParamError","MESSAGE":"未到开放时间 PRIVATE_TOKEN 王某"}
            p = suite.arm(suite.visit(ctx))
            suite.release(p)
            r = suite.result(p, state="SUCCESS" if success else "FAILED", storageStatus="SAVED")
            p.wait_for_function("s=>JSON.parse(localStorage.getItem('hdu-p63:history'))[0].state===s", arg=r["state"])
            if success:
                state.record_status = 503
                suite.el(p,"#review").click()
                suite.result(p, state="SUCCESS", verification="ERROR", recordVerified=True)
                p.wait_for_function("JSON.parse(localStorage.getItem('hdu-p63:history'))[0].verification==='ERROR'")
            requests = list(state.requests)
            p.reload()
            suite.el(p,"summary").click()
            restored=suite.export(p)
            assert restored["runId"] == r["runId"] and restored["state"] == r["state"]
            p.close()
            q = suite.visit(ctx)
            suite.el(q,"#history").click()
            suite.el(q,"#copyHistory").click()
            row = json.loads(q.evaluate("window.copied"))
            assert row["runId"] == r["runId"] and row["storageStatus"] == "SAVED"
            assert row["state"] == r["state"] and row["dispatchAt"] == r["dispatchAt"]
            if not success:
                assert row["failureMessage"]=="未到开放时间" and "PRIVATE_TOKEN" not in str(row)
            assert state.requests == requests
    with suite.case(browser, mock, session=False) as (ctx,state):
        p = suite.visit(ctx)
        for n in range(32):
            suite.el(p,"#start").click()
            p.wait_for_function("n=>JSON.parse(localStorage.getItem('hdu-p63:history')||'[]')[0]?.runId!==n && JSON.parse(localStorage.getItem('hdu-p63:history')||'[]')[0]?.reason==='AUTH_REQUIRED'",arg=None if n==0 else last)
            last=p.evaluate("JSON.parse(localStorage.getItem('hdu-p63:history'))[0].runId")
            if n==0:first=last
        rows=p.evaluate("JSON.parse(localStorage.getItem('hdu-p63:history'))")
        assert len({r["runId"] for r in rows})==len(rows)==30 and first not in str(rows)
        assert not state.posts
    with suite.case(browser,mock) as (ctx,state):
        p=suite.arm(suite.visit(ctx))
        p.evaluate("""()=>{const set=Storage.prototype.setItem;Storage.prototype.setItem=function(k,v){
          if(k==='hdu-p63:history')throw Error();return set.call(this,k,v);};}""")
        suite.release(p)
        suite.result(p,state="SUCCESS",storageStatus="ERROR")
        expect(suite.el(p,"#reason")).to_contain_text("诊断存储异常")
        assert len(state.posts)==1

def stopped_and_pending(browser,mock):
    with suite.case(browser,mock,disconnect=True,auto_record=False) as (ctx,state):
        p=suite.arm(suite.visit(ctx))
        suite.el(p,"#stop").click()
        stopped=suite.result(p,reason="USER_STOPPED",storageStatus="SAVED")
        assert not state.posts
        suite.arm(p)
        suite.release(p)  # Advance simulated wall time by about a minute, with monotonic time intact.
        pending=suite.result(p,state="UNKNOWN",storageStatus="SAVED")
        assert pending["clockChangeMs"] > 50000 and pending["attempts"]==1
        rows=p.evaluate("JSON.parse(localStorage.getItem('hdu-p63:history'))")
        assert [r["runId"] for r in rows]==[pending["runId"],stopped["runId"]]
        assert rows[1]["reason"]=="USER_STOPPED"
        p.evaluate("localStorage.removeItem('hdu-p63:history')")
        p.reload()
        suite.el(p,"summary").click()
        suite.release(p,20000)
        suite.el(p,"#start").click()
        suite.result(p,state="UNKNOWN",reason="NETWORK_ERROR")
        assert len(state.posts)==1

if __name__ == "__main__":
    with Mock() as mock, sync_playwright() as pw:
        bundles = {v:(ROOT/f"userscripts/HDU_Android_P{v}_Lite.user.js").read_bytes() for v in ("6.2","6.3")}
        if "--bench" in sys.argv:
            browser = suite.launch(pw,"firefox",mock)
            rows=[]
            for block,count in [(0,12),(450,4),(1300,4)]:
                for i in range(count):
                    for v in (list(bundles) if i%2==0 else reversed(bundles)):
                        mock.files["p62"]=bundles[v]
                        row=sample(browser,mock,block)
                        rows.append(dict(row,version=v,blockMs=block,lagMs=row["dispatchMs"]-1350))
            (ROOT/"docs/evidence/p63/timing.json").write_text(json.dumps(dict(firefox=browser.version,rows=rows),indent=2)+"\n")
            browser.close()
        else:
            mock.files["p62"]=bundles["6.3"]
            browser=suite.launch(pw,sys.argv[1],mock)
            for test in [*suite.TESTS,history,stopped_and_pending]:
                test(browser,mock)
                print("PASS",test.__name__,flush=True)
            browser.close()
