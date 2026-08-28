#!/usr/bin/env python3
"""Snapshot collector for ESO (Energijos skirstymo operatorius) outage statistics.

Reads the JSON endpoint that backs the counters on
https://www.eso.lt/atjungimai-planiniai-neplaniniai and appends one row per run
to a monthly CSV under docs/data/.

The endpoint answers with:

    {"success": true, "message": null,
     "data": {"k": {"total": 3382},   # klientu pranesimu skaicius
              "c": {"total": 1289},   # sutrikimu skaicius
              "n": {"total": 31405},  # del sutrikimu atjungtu klientu skaicius
              "p": {"total": 0}},     # del planiniu darbu atjungtu klientu skaicius
     "timestamp": 1787902517}

Note on `timestamp`: it is a server-side cache stamp, not a data-freshness
marker -- it was observed unchanged across four minutes while the counters
themselves moved. It is stored for reference, never used for de-duplication.
The authoritative time for a sample is `ts_utc`, written by this script.

Stdlib only: no pip install step in CI.
"""

from __future__ import annotations

import argparse
import csv
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

URL = "https://www.eso.lt/atjungimai-planiniai-neplaniniai/statdata"

USER_AGENT = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36"
)

# CSV column order. Keys map to the endpoint's single-letter buckets.
FIELDS = ["ts_utc", "k", "c", "n", "p", "server_ts"]

# Human-readable meaning of each bucket, mirrored in the dashboard.
LABELS = {
    "k": "Klientu pranesimu skaicius",
    "c": "Sutrikimu skaicius",
    "n": "Del sutrikimu atjungtu klientu skaicius",
    "p": "Del planiniu darbu atjungtu klientu skaicius",
}

DEFAULT_DATA_DIR = Path(__file__).resolve().parent.parent / "docs" / "data"


def fetch(url: str, attempts: int = 4, timeout: int = 30) -> dict:
    """GET the endpoint, retrying with exponential backoff on transient errors."""
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        request = urllib.request.Request(
            url,
            headers={
                "User-Agent": USER_AGENT,
                "Accept": "application/json, text/plain, */*",
                "Accept-Language": "lt,en;q=0.8",
                "Referer": "https://www.eso.lt/atjungimai-planiniai-neplaniniai",
            },
        )
        try:
            with urllib.request.urlopen(request, timeout=timeout) as response:
                payload = json.loads(response.read().decode("utf-8"))
            break
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
            last_error = error
            if attempt == attempts:
                raise RuntimeError(f"{attempts} attempts failed: {error}") from error
            time.sleep(2 ** attempt)
    else:  # pragma: no cover - loop always breaks or raises
        raise RuntimeError(str(last_error))

    if not payload.get("success"):
        raise RuntimeError(f"endpoint reported failure: {payload.get('message')!r}")

    data = payload.get("data") or {}
    missing = [key for key in ("k", "c", "n", "p") if key not in data]
    if missing:
        raise RuntimeError(f"payload is missing buckets {missing}: {payload!r}")

    row = {"server_ts": payload.get("timestamp", "")}
    for key in ("k", "c", "n", "p"):
        total = data[key].get("total")
        if total is None:
            raise RuntimeError(f"bucket {key!r} has no total: {data[key]!r}")
        row[key] = int(total)
    return row


def append_row(data_dir: Path, row: dict) -> Path:
    """Append one sample to the CSV for its UTC month, creating it if needed."""
    month_file = data_dir / f"{row['ts_utc'][:7]}.csv"
    is_new = not month_file.exists()
    data_dir.mkdir(parents=True, exist_ok=True)
    with month_file.open("a", encoding="utf-8", newline="") as handle:
        writer = csv.DictWriter(handle, fieldnames=FIELDS, lineterminator="\n")
        if is_new:
            writer.writeheader()
        writer.writerow({field: row[field] for field in FIELDS})
    return month_file


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def rebuild_index(data_dir: Path, latest: dict) -> None:
    """Regenerate index.json + latest.json, the two files the dashboard reads first."""
    months = []
    for path in sorted(data_dir.glob("[0-9][0-9][0-9][0-9]-[0-9][0-9].csv")):
        rows = read_csv(path)
        if not rows:
            continue
        months.append(
            {
                "file": path.name,
                "rows": len(rows),
                "first": rows[0]["ts_utc"],
                "last": rows[-1]["ts_utc"],
            }
        )

    index = {
        "source": URL,
        "labels": LABELS,
        "generated_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "total_rows": sum(month["rows"] for month in months),
        "months": months,
    }
    write_json(data_dir / "index.json", index)
    write_json(data_dir / "latest.json", latest)


def write_json(path: Path, payload: dict) -> None:
    # newline="\n" so a Windows run produces the same bytes as the Linux CI run.
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(payload, ensure_ascii=False, indent=2) + "\n")


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--data-dir",
        type=Path,
        default=Path(os.environ.get("ESO_DATA_DIR", DEFAULT_DATA_DIR)),
        help="directory holding the monthly CSVs (default: docs/data)",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="fetch and print the sample without writing anything",
    )
    parser.add_argument(
        "--strict",
        action="store_true",
        help="exit non-zero when the fetch fails (default: warn and exit 0)",
    )
    args = parser.parse_args()

    try:
        row = fetch(URL)
    except RuntimeError as error:
        message = f"could not collect ESO statistics: {error}"
        print(f"::warning::{message}", file=sys.stderr)
        return 1 if args.strict else 0

    row["ts_utc"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    summary = " ".join(f"{key}={row[key]}" for key in ("k", "c", "n", "p"))
    print(f"{row['ts_utc']}  {summary}  (server_ts={row['server_ts']})")

    if args.dry_run:
        print("dry run: nothing written")
        return 0

    month_file = append_row(args.data_dir, row)
    rebuild_index(args.data_dir, row)
    print(f"appended to {month_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
