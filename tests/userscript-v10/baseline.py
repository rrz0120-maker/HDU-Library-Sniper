"""Reproduce gaps in the immutable V9 install file, on loopback WebKit."""
import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "userscript-v9"))
from browser import case, launch, visit, start, wait_report, exported, field, set_time, OPEN, Mock, sync_playwright
from mock_huitu import OCCUPIED

with Mock() as mock, sync_playwright() as pw:
    b = launch(pw.webkit, mock)
    with case(b, mock, business=OCCUPIED) as (ctx, f):
        p = visit(ctx)
        start(p)
        wait_report(p, result="SEAT_UNAVAILABLE")
        p.reload()
        field(p, "summary").click()
        assert exported(p)["result"] == "SEAT_UNAVAILABLE"
        p.close()
        q = visit(ctx)
        assert exported(q)["result"] == "IDLE"
        assert len(f.posts) == 1
        print("V9: ordinary reload retained refusal; new same-origin tab lost it")
    with case(b, mock, http=404, business={"CODE":"NotFound"}) as (ctx, f):
        p = visit(ctx)
        start(p)
        wait_report(p, state="failed", result="HTTP_404")
        assert field(p, "#review").is_disabled()
        print("V9: HTTP 404 classified terminal; record review disabled")
    with case(b, mock, http=504) as (ctx, f):
        p=visit(ctx)
        start(p)
        wait_report(p,state="unknown")
        set_time(p,OPEN+120000)
        field(p,"#from").select_option("8")
        start(p)
        wait_report(p,state="unknown",start=8)
        assert len(f.posts)==2
        print("V9: an overlapping pending slot allowed another write after the pacing interval")
    with case(b, mock) as (ctx, f):
        p=visit(ctx)
        start(p)
        prior=wait_report(p,state="verified",verification="matched")
        f.read_status=503
        field(p,"#review").click()
        latest=wait_report(p,state="accepted",verification="error")
        assert latest["verifiedAt"]==prior["verifiedAt"] and len(f.posts)==1
        print("V9: read failure demoted previously verified state while retaining verifiedAt")
    b.close()
