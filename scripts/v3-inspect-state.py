#!/usr/bin/env python3
"""Read a STOPPED-container SQLite copy; no network, writes, credentials or UID output."""
import argparse
from datetime import datetime, timedelta
import json
from pathlib import Path
import sqlite3
from zoneinfo import ZoneInfo

parser = argparse.ArgumentParser()
parser.add_argument("database", help="SQLite copy made after stopping the container")
args = parser.parse_args()
path = Path(args.database).resolve(strict=True)
zone = ZoneInfo("Asia/Shanghai")
with sqlite3.connect(path.as_uri() + "?mode=ro", uri=True) as db:
    db.execute("PRAGMA query_only=ON")
    tasks = []
    for (document,) in db.execute("SELECT document FROM strict_tasks ORDER BY task_key DESC LIMIT 10"):
        row = json.loads(document)
        mapping = row.get("mapping") or {}
        ids = mapping.get("ids") or []
        begin = datetime.fromtimestamp(row["begin"], zone)
        tasks.append({
            "date": row["date"], "state": row["state"], "attempts": row["attempts"],
            "begin": begin.isoformat(), "end": (begin + timedelta(hours=14)).isoformat(),
            "opens": datetime.fromtimestamp(row["opens"], zone).isoformat(),
            "room": mapping.get("room_name"), "floorId": mapping.get("floor_id"),
            "seatIds": dict(zip(("162", "157"), ids)),
            "mappingRecordedAt": mapping.get("verified_at"),
        })
    print(json.dumps({"readOnlySnapshot": True, "tasks": tasks,
                      "note": "Stored evidence only; this does not validate live identity, current seat availability, or cache integrity."}, ensure_ascii=False, indent=2))
