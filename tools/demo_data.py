#!/usr/bin/env python3
"""Build a throwaway copy of the dashboard filled with generated snapshots.

The real history grows 96 rows a day, so it takes months before you can see how
the charts behave over a long range. This fakes that history: storms of varying
size and length over a diurnal rhythm, at the same 15-minute step the collector
writes.

    python tools/demo_data.py                 # build .demo/ and print how to open it
    python tools/demo_data.py --serve         # build it and serve on :8000
    python tools/demo_data.py --days 365      # a year of history

The output goes to .demo/ (gitignored). Nothing here ever touches docs/data/ -
generated numbers must never end up in the real series.
"""

from __future__ import annotations

import argparse
import csv
import json
import math
import random
import shutil
from datetime import datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
FIELDS = ["ts_utc", "k", "c", "n", "p", "server_ts"]


def generate(days: int, seed: int) -> list[dict]:
    random.seed(seed)
    now = datetime.now(timezone.utc).replace(second=0, microsecond=0)
    now = now.replace(minute=(now.minute // 15) * 15)
    samples = days * 96

    # Each storm is (centre day, width in days, peak multiplier).
    storms = [
        (random.uniform(2, days - 2), random.uniform(0.4, 2.2), random.uniform(3, 14))
        for _ in range(max(1, days // 8))
    ]

    rows = []
    for i in range(samples):
        moment = now - timedelta(minutes=15 * (samples - 1 - i))
        day = days - (samples - 1 - i) / 96

        burst = 1.0
        for centre, width, amplitude in storms:
            burst += amplitude * math.exp(-(((day - centre) / width) ** 2))

        hour = moment.hour + moment.minute / 60
        diurnal = 1 + 0.30 * math.sin((hour - 7) / 24 * 2 * math.pi)
        base = 700 * burst * diurnal

        rows.append({
            "ts_utc": moment.strftime("%Y-%m-%dT%H:%M:%SZ"),
            "k": max(0, int(base * 0.55 + random.gauss(0, base * 0.04))),
            "c": max(0, int(base * 0.20 + random.gauss(0, base * 0.03))),
            "n": max(0, int(base * 4.6 + random.gauss(0, base * 0.30))),
            "p": 0 if random.random() < 0.78 else int(abs(random.gauss(1500, 1100))),
            "server_ts": int(moment.timestamp()),
        })
    return rows


def build(out_dir: Path, rows: list[dict]) -> None:
    if out_dir.exists():
        shutil.rmtree(out_dir)
    data_dir = out_dir / "data"
    data_dir.mkdir(parents=True)

    for name in ("index.html", "style.css"):
        shutil.copy(DOCS / name, out_dir / name)
    shutil.copytree(DOCS / "js", out_dir / "js")

    months: dict[str, list[dict]] = {}
    for row in rows:
        months.setdefault(row["ts_utc"][:7], []).append(row)

    index = {
        "source": "DEMO - generated, not real",
        "labels": {},
        "generated_at": rows[-1]["ts_utc"],
        "total_rows": len(rows),
        "months": [],
    }
    for month, month_rows in sorted(months.items()):
        path = data_dir / f"{month}.csv"
        with path.open("w", encoding="utf-8", newline="\n") as handle:
            writer = csv.DictWriter(handle, fieldnames=FIELDS, lineterminator="\n")
            writer.writeheader()
            writer.writerows(month_rows)
        index["months"].append({
            "file": path.name,
            "rows": len(month_rows),
            "first": month_rows[0]["ts_utc"],
            "last": month_rows[-1]["ts_utc"],
        })

    for name, payload in (("index.json", index), ("latest.json", rows[-1])):
        with (data_dir / name).open("w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=92, help="how much history to fake")
    parser.add_argument("--seed", type=int, default=7, help="same seed, same data")
    parser.add_argument("--out", type=Path, default=ROOT / ".demo")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--serve", action="store_true", help="serve the result right away")
    args = parser.parse_args()

    rows = generate(args.days, args.seed)
    build(args.out, rows)
    peak = max(row["n"] for row in rows)
    print(f"{len(rows)} snapshots over {args.days} days in {args.out} (peak n={peak})")

    if not args.serve:
        print(f"open it with:  python -m http.server -d {args.out} {args.port}")
        return

    import http.server
    import socketserver

    handler = lambda *a, **kw: http.server.SimpleHTTPRequestHandler(
        *a, directory=str(args.out), **kw
    )
    with socketserver.TCPServer(("127.0.0.1", args.port), handler) as server:
        print(f"http://127.0.0.1:{args.port}/  (Ctrl+C to stop)")
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")


if __name__ == "__main__":
    main()
