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
import http.cookiejar
import json
import os
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

PAGE_URL = "https://www.eso.lt/atjungimai-planiniai-neplaniniai"
URL = f"{PAGE_URL}/statdata"

# Say who we are and where to complain, rather than dressing up as Chrome.
# The endpoint answers this just as readily, so there is nothing to gain from
# the disguise and something to lose: a site operator who wants to rate-limit
# or contact us should be able to.
USER_AGENT = (
    "ESOanalizator/1.0 (+https://github.com/MaJI9IBaHbl4/EsoAnalizator) "
    "renka viesa atjungimu statistika kas 15 min."
)

# https://www.eso.lt/robots.txt asks for 10 seconds between requests. The
# normal path makes a single request per run, a quarter of an hour apart, so
# it is far inside that; the fallback below has to wait explicitly.
CRAWL_DELAY_SECONDS = 10

HTML_ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
JSON_ACCEPT = "application/json, text/plain, */*"

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


def build_opener() -> urllib.request.OpenerDirector:
    """An opener that keeps cookies, so the warm-up hand-off works."""
    return urllib.request.build_opener(
        urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar())
    )


def get(opener, url: str, accept: str, timeout: int) -> bytes:
    request = urllib.request.Request(
        url,
        headers={
            "User-Agent": USER_AGENT,
            "Accept": accept,
            "Accept-Language": "lt,en;q=0.9,en-US;q=0.8",
            "Accept-Encoding": "identity",
            "Referer": PAGE_URL,
            "X-Requested-With": "XMLHttpRequest",
            "Connection": "keep-alive",
        },
    )
    with opener.open(request, timeout=timeout) as response:
        return response.read()


def describe(error: Exception) -> str:
    """Include the response body on an HTTP error - a bare 403 says nothing."""
    if isinstance(error, urllib.error.HTTPError):
        try:
            body = error.read().decode("utf-8", "replace").strip()
        except Exception:  # pragma: no cover - body may already be consumed
            body = ""
        snippet = " ".join(body.split())[:300]
        return f"HTTP {error.code} {error.reason}" + (f" | body: {snippet}" if snippet else "")
    return str(error)


def fetch_once(url: str, timeout: int, warm_up: bool) -> dict:
    """One attempt. With `warm_up`, first load the page the endpoint belongs to,
    exactly as a browser does, for hosts that refuse a cold call."""
    opener = build_opener()
    if warm_up:
        get(opener, PAGE_URL, HTML_ACCEPT, timeout)
        time.sleep(CRAWL_DELAY_SECONDS)
    return json.loads(get(opener, url, JSON_ACCEPT, timeout).decode("utf-8"))


def fetch(url: str, attempts: int = 4, timeout: int = 30) -> dict:
    """GET the endpoint, retrying with exponential backoff on transient errors.

    The first attempt is the plain one: a single request per run, which is the
    lightest thing we can ask of the site. Only if that is refused do we repeat
    the browser's own sequence - page first, then the XHR - which costs an extra
    40 KB and a mandated pause, so it is a fallback and not the default.
    """
    last_error: Exception | None = None
    for attempt in range(1, attempts + 1):
        try:
            payload = fetch_once(url, timeout, warm_up=attempt > 1)
            break
        except (urllib.error.URLError, TimeoutError, ValueError, OSError) as error:
            last_error = error
            if attempt == attempts:
                raise RuntimeError(
                    f"{attempts} attempts failed: {describe(error)}"
                ) from error
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


# A run started by hand seconds after a scheduled one reads the very same
# numbers: the source refreshes every 15 minutes. Recording it again adds a
# row that says nothing and shows up in the table as a line of dashes.
REPEAT_WINDOW_SECONDS = 5 * 60


def read_csv(path: Path) -> list[dict]:
    with path.open(encoding="utf-8", newline="") as handle:
        return list(csv.DictReader(handle))


def last_recorded(data_dir: Path) -> dict | None:
    """The newest row already on disk, or None on a first run."""
    months = sorted(data_dir.glob("[0-9][0-9][0-9][0-9]-[0-9][0-9].csv"))
    for path in reversed(months):
        rows = read_csv(path)
        if rows:
            return rows[-1]
    return None


def repeats(previous: dict, row: dict) -> bool:
    """True when `row` is the same reading as `previous`, taken moments later.

    Only the rapid case counts. Two identical readings a quarter of an hour
    apart are two real measurements that happened to agree, and dropping one
    would erase the fact that the value held.
    """
    if any(str(previous.get(key, "")) != str(row[key]) for key in ("k", "c", "n", "p")):
        return False
    stamp = "%Y-%m-%dT%H:%M:%SZ"
    gap = datetime.strptime(row["ts_utc"], stamp) - datetime.strptime(previous["ts_utc"], stamp)
    return gap.total_seconds() < REPEAT_WINDOW_SECONDS


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
        "--lenient",
        action="store_true",
        help="warn and exit 0 when the fetch fails, instead of failing the run",
    )
    args = parser.parse_args()

    try:
        row = fetch(URL)
    except RuntimeError as error:
        # Failing loudly is the point: a green run that collected nothing is
        # worse than a red one, because the gap only shows up months later.
        level = "warning" if args.lenient else "error"
        print(f"::{level}::could not collect ESO statistics: {error}", file=sys.stderr)
        return 0 if args.lenient else 1

    row["ts_utc"] = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    summary = " ".join(f"{key}={row[key]}" for key in ("k", "c", "n", "p"))
    print(f"{row['ts_utc']}  {summary}  (server_ts={row['server_ts']})")

    if args.dry_run:
        print("dry run: nothing written")
        return 0

    previous = last_recorded(args.data_dir)
    if previous is not None and repeats(previous, row):
        print(f"identical to the reading at {previous['ts_utc']}; not recorded")
        return 0

    month_file = append_row(args.data_dir, row)
    rebuild_index(args.data_dir, row)
    print(f"appended to {month_file}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
