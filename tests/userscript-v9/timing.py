"""Measure real browser timers, fetch hand-off, and loopback TLS receiver arrival."""
import argparse
import hashlib
import json
import math
import statistics
from datetime import datetime, timezone
from pathlib import Path

from playwright.sync_api import sync_playwright
from browser import OPEN, case, launch, set_time, start, visit, wait_report
from mock_huitu import BASE, BOOK, RECORD, ROOT, Mock

# A busy main-thread callback starts at release + 1000 ms, before the +1200 ms target.
LOADS = {"foreground": 0, "blocked_450ms": 450, "blocked_1300ms": 1300}


def one(browser, mock, duration):
    with case(browser, mock) as (context, f):
        page = visit(context, mode="scheduled", at=OPEN - 60000)
        shift = set_time(page, OPEN - 650)
        assert page.evaluate("!document.hidden")
        start(page)
        wait_report(page, state="waiting")
        if duration:
            page.evaluate("""([open, duration]) => {
              setTimeout(() => {
                window.blockStarted = Date.now() - open;
                const stop = performance.now() + duration;
                while (performance.now() < stop) {}
                window.blockEnded = Date.now() - open;
              }, Math.max(0, open + 1000 - Date.now()));
            }""", [OPEN, duration])
        r = wait_report(page, state="verified")
        assert f.events == [("GET", BASE), ("POST", BOOK), ("GET", RECORD)]
        assert r["sends"] == 1 and len(f.posts) == 1 and f.posts[0]["valid"]
        independent = round(f.posts[0]["arrived"] + shift - OPEN, 1)
        dispatch = r["delayFrom20Ms"]
        assert independent >= dispatch - 2, (independent, dispatch)
        actual = r["requestStartAt"]
        return {
            "dispatchMs": dispatch,
            "browserRequestStartMs": round(datetime.fromisoformat(actual).timestamp() * 1000) - OPEN if actual else None,
            "loopbackReceiveMs": independent, "httpMs": r["httpMs"],
            "blockStartMs": page.evaluate("window.blockStarted ?? null"),
            "blockEndMs": page.evaluate("window.blockEnded ?? null"),
        }


def stats(rows, key):
    values = sorted(r[key] for r in rows)
    hits = sum(800 <= n <= 2000 for n in values)
    return {"hits": hits, "n": len(values), "percent": round(hits * 100 / len(values), 1),
            "min": min(values), "median": statistics.median(values),
            "p95": values[math.ceil(.95 * len(values)) - 1], "max": max(values)}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--samples", type=int, default=12)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    if args.samples < 1:
        parser.error("--samples must be positive")
    report = {
        "runAtUtc": datetime.now(timezone.utc).isoformat(),
        "bundleSha256": hashlib.sha256((ROOT / "userscripts/HDU_iPad_V9_Lite.user.js").read_bytes()).hexdigest(),
        "plannedOffsetMs": 1200, "windowMs": [800, 2000], "realLibraryWrites": 0, "engines": {},
    }
    with Mock() as mock, sync_playwright() as pw:
        for name in ("chromium", "webkit"):
            browser = launch(getattr(pw, name), mock)
            engine = report["engines"][name] = {"version": browser.version, "loads": {}}
            try:
                for load, duration in LOADS.items():
                    rows = [one(browser, mock, duration) for _ in range(args.samples)]
                    engine["loads"][load] = {"samples": rows, "dispatch": stats(rows, "dispatchMs"),
                                             "receiver": stats(rows, "loopbackReceiveMs")}
                    print(name, load, engine["loads"][load]["dispatch"], flush=True)
            finally:
                browser.close()
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n")
