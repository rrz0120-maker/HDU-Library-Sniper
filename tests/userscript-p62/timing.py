"""Real timers + installed userscript + native fetch + independent local TLS receiver."""
import argparse
import hashlib
import json
import math
import statistics
from datetime import datetime, timezone
from pathlib import Path
from playwright.sync_api import sync_playwright
from browser import OPEN, case, el, launch, result, visit
from server import BASE, BOOK, CATALOG, RANGE, RECORD, ROOT, Mock

LOADS={"foreground":0,"blocked_450ms":450,"blocked_1300ms":1300}

def sample(browser,mock,block):
    with case(browser,mock) as (context,state):
        p=visit(context)
        shift=p.evaluate("n=>setWall(n)",OPEN-850)
        el(p,"#offset").dispatch_event("input")
        el(p,"#start").click()
        r=result(p,state="WAITING")
        assert state.requests==[("GET",BASE),("GET",CATALOG),("GET",RANGE)]
        assert not state.posts and p.evaluate("!document.hidden")
        if block:
            p.evaluate("""([open,block])=>{
              setTimeout(()=>{
                window.blockStart=Date.now()-open;
                const end=performance.now()+block;
                while(performance.now()<end) {}
                window.blockEnd=Date.now()-open;
              },Math.max(0,open+1100-Date.now()));
            }""",[OPEN,block])
        r=result(p,state="SUCCESS")
        assert state.requests[-2:]==[("POST",BOOK),("GET",RECORD)]
        assert len(state.posts)==1 and state.posts[0]["valid"] and r["attempts"]==1
        received=round(state.posts[0]["received"]+shift-OPEN,1)
        assert received>=r["delayFrom20Ms"]-2
        start=r["requestStartAt"]
        return {
          "dispatchMs":r["delayFrom20Ms"],"httpMs":round(r["httpMs"],1),
          "browserRequestStartMs":round(datetime.fromisoformat(start).timestamp()*1000-OPEN,1) if start else None,
          "receiverMs":received,"clockChangeMs":r["clockChangeMs"],"inWindow":r["inWindow"],
          "blockStartMs":p.evaluate("window.blockStart??null"),"blockEndMs":p.evaluate("window.blockEnd??null"),
        }

def stats(rows,key):
    nums=sorted(r[key] for r in rows)
    hits=sum(800<=n<=2000 for n in nums)
    return {"hits":hits,"samples":len(nums),"percent":100*hits/len(nums),"min":nums[0],
      "median":statistics.median(nums),"p95":nums[math.ceil(len(nums)*.95)-1],"max":nums[-1]}

if __name__=="__main__":
    parser=argparse.ArgumentParser()
    parser.add_argument("--samples",type=int,default=12)
    parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args()
    if args.samples<1:parser.error("samples must be positive")
    report={"runAtUtc":datetime.now(timezone.utc).isoformat(),"targetOffsetMs":1350,"windowMs":[800,2000],
      "realLibraryWrites":0,"bundleSha256":hashlib.sha256((ROOT/"userscripts/HDU_Android_P6.2_Lite.user.js").read_bytes()).hexdigest(),
      "engines":{}}
    with Mock() as mock,sync_playwright() as pw:
        for name in ["chromium","firefox"]:
            browser=launch(pw,name,mock)
            engine=report["engines"][name]={"version":browser.version,"loads":{}}
            try:
                for load,block in LOADS.items():
                    rows=[sample(browser,mock,block) for _ in range(args.samples)]
                    engine["loads"][load]={"samples":rows,"dispatch":stats(rows,"dispatchMs"),"receiver":stats(rows,"receiverMs")}
                    print(name,load,engine["loads"][load]["dispatch"],flush=True)
            finally:browser.close()
    args.output.parent.mkdir(parents=True,exist_ok=True)
    args.output.write_text(json.dumps(report,ensure_ascii=False,indent=2)+"\n")
