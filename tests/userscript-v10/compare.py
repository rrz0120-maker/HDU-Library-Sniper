"""Paired release artifacts, same native WebKit, loopback network and wall clock."""
import hashlib
import json
import math
import statistics
from datetime import datetime
from harness import install, v9, V10
from mock_huitu import BASE, BOOK, RECORD, ROOT
from playwright.sync_api import sync_playwright

def sample(browser, mock, version, block):
    install(mock, version)
    with v9.case(browser, mock) as (ctx, f):
        ctx.add_init_script("""window.archiveWrites = [];
        const get = Storage.prototype.getItem, put = Storage.prototype.setItem;
        let begin;
        Storage.prototype.getItem = function(k) {
          if(k.startsWith('hdu-v10:history:')) begin=performance.now();
          return get.call(this,k);
        };
        Storage.prototype.setItem = function(k,v) {
          if (!k.startsWith('hdu-v10:history:')) return put.call(this,k,v);
          const start=begin; const r=put.call(this,k,v);
          archiveWrites.push(performance.now()-start); return r;
        }""")
        p = v9.visit(ctx, mode="scheduled", at=v9.OPEN-60000)
        shift = v9.set_time(p, v9.OPEN-650)
        v9.start(p)
        v9.wait_report(p,state="waiting")
        if block:
            p.evaluate("""([open,block])=>setTimeout(()=>{
                window.beg=Date.now()-open; const end=performance.now()+block;
                while(performance.now()<end){} window.end=Date.now()-open;
              },Math.max(0,open+1000-Date.now()))""",[v9.OPEN,block])
        r = v9.wait_report(p,state="verified")
        assert f.events == [("GET",BASE),("POST",BOOK),("GET",RECORD)]
        assert len(f.posts)==1 and f.posts[0]["valid"] and r["sends"]==1
        dispatch=r["delayFrom20Ms"]
        rt=r["requestStartAt"]
        return dict(version=version,blockMs=block,dispatchMs=dispatch,lagMs=dispatch-1200,
                    fetchToRequestMs=round(datetime.fromisoformat(rt).timestamp()*1000)-v9.OPEN-dispatch if rt else None,
                    receiverMs=round(f.posts[0]["arrived"]+shift-v9.OPEN,1),httpMs=r["httpMs"],
                    archiveSaveMs=p.evaluate("archiveWrites.reduce((a,b)=>a+b,0)"),
                    archiveWrites=p.evaluate("archiveWrites.length"),postCount=len(f.posts),preGetCount=1,
                    blockBounds=p.evaluate("[window.beg??null,window.end??null]"))

def summary(rows,key):
    vs=sorted(r[key] for r in rows if r[key] is not None)
    return [statistics.median(vs),vs[math.ceil(.95*len(vs))-1],vs[-1]] if vs else None

if __name__=="__main__":
    with v9.Mock() as mock,sync_playwright() as pw:
        b=v9.launch(pw.webkit,mock)
        out={"webkit":b.version,"sha256":{str(i):hashlib.sha256(p.read_bytes()).hexdigest()
             for i,p in [(9,ROOT/"userscripts/HDU_iPad_V9_Lite.user.js"),(10,V10)]},"rows":[],"summary":[]}
        for block,n in [(0,12),(450,3),(1300,3)]:
            for i in range(n):
                for version in ((9,10) if i%2==0 else (10,9)):
                    out["rows"].append(sample(b,mock,version,block))
            for version in (9,10):
                rows=[r for r in out["rows"] if r["blockMs"]==block and r["version"]==version]
                s=dict(version=version,blockMs=block,n=n,hits=sum(800<=r["dispatchMs"]<=2000 for r in rows),
                       **{k:summary(rows,k) for k in ["lagMs","fetchToRequestMs","httpMs","archiveSaveMs"]})
                print(s,flush=True)
                out["summary"].append(s)
        b.close()
        (ROOT/"docs/evidence/v10/timing.json").write_text(json.dumps(out,indent=2)+"\n")
