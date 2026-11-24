from harness import install, v9
from playwright.sync_api import sync_playwright
import sys

with v9.Mock() as mock,sync_playwright() as pw:
    install(mock,10)
    mock.load_p731()
    wait=v9.wait_report
    def wait_v10(page,**fields):
        if fields.get("state")=="idle" and fields.get("result"):
            fields["state"]="ended"
        return wait(page,**fields)
    v9.wait_report=wait_v10
    for name in sys.argv[1:] or ["webkit","chromium"]:
        b=v9.launch(getattr(pw,name),mock)
        for fn in v9.TESTS:
            fn(b,mock)
            print("PASS",name,fn.__name__,flush=True)
        b.close()
