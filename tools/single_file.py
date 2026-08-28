#!/usr/bin/env python3
"""Bundle the dashboard into one self-contained HTML file with demo data baked in.

Useful for sending the dashboard to someone who cannot reach GitHub Pages, and
for publishing a preview that shows how it looks with months of history.

    python tools/single_file.py                  # writes demo.html in the repo root
    python tools/single_file.py --days 365 --out year.html

The output is pure ASCII on purpose. A single file gets opened straight from
disk or embedded in a host page that owns <head>, and in neither case can it
count on a charset declaration - so nothing outside ASCII is left in it.
"""

from __future__ import annotations

import argparse
import csv
import io
import json
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "docs"
sys.path.insert(0, str(Path(__file__).resolve().parent))

from demo_data import FIELDS, generate  # noqa: E402

SCRIPTS = ["core.js", "agg.js", "viz.js", "overview.js", "detail.js", "main.js"]

BANNER = """  <div class="demo-note" role="note">
    <span class="demo-note__tag">DEMONSTRACIJA</span>
    <span>Duomenys <b>sugeneruoti</b>, ne tikri &mdash; {days} dienos po {rows}
    nuskaitymus, kad matytusi, kaip skydelis atrodo su keliu menesiu istorija.
    Tikrieji duomenys &mdash;
    <a href="https://maji9ibahbl4.github.io/EsoAnalizator/">skydelyje</a>.</span>
  </div>
"""

# The notice borrows the dashboard's own tokens rather than introducing a palette.
EXTRA_CSS = """
/* ---- demo notice (not part of the real dashboard) ---- */
.demo-note {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 8px 12px;
  margin-bottom: 18px;
  padding: 11px 14px;
  border: 1px solid var(--border);
  border-left: 3px solid var(--series-p);
  border-radius: var(--radius);
  background: var(--surface);
  font-size: 13px;
  color: var(--text-secondary);
  line-height: 1.45;
}
.demo-note__tag {
  flex: none;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  color: var(--series-p);
}
.demo-note b { color: var(--text-primary); font-weight: 600; }
.demo-note a { color: inherit; }
"""

SHIM = r"""
/* Serves the embedded snapshot in place of the network, so the dashboard's own
   loading path runs unchanged - same parser, same charts, same code. */
(() => {
  const DEMO = __DEMO__;
  const passthrough = window.fetch ? window.fetch.bind(window) : null;
  window.fetch = (input, init) => {
    const url = String(input);
    if (url.includes("data/index.json")) {
      return Promise.resolve(new Response(JSON.stringify(DEMO.index),
        { headers: { "Content-Type": "application/json" } }));
    }
    const csv = url.match(/data\/(\d{4}-\d{2}\.csv)/);
    if (csv && DEMO.files[csv[1]]) {
      return Promise.resolve(new Response(DEMO.files[csv[1]],
        { headers: { "Content-Type": "text/csv" } }));
    }
    return passthrough ? passthrough(input, init) : Promise.reject(new Error("offline"));
  };
  // Open on the full history: months of data are what this page exists to show.
  if (!location.hash) location.hash = "#tab=detail&range=0";
})();
"""


def as_payload(rows: list[dict]) -> dict:
    """The same shape the collector writes, but held in memory."""
    months: dict[str, list[dict]] = {}
    for row in rows:
        months.setdefault(row["ts_utc"][:7], []).append(row)

    files = {}
    index = {"source": "demo", "labels": {}, "generated_at": rows[-1]["ts_utc"],
             "total_rows": len(rows), "months": []}
    for month, month_rows in sorted(months.items()):
        buffer = io.StringIO()
        writer = csv.DictWriter(buffer, fieldnames=FIELDS, lineterminator="\n")
        writer.writeheader()
        writer.writerows(month_rows)
        files[f"{month}.csv"] = buffer.getvalue()
        index["months"].append({
            "file": f"{month}.csv", "rows": len(month_rows),
            "first": month_rows[0]["ts_utc"], "last": month_rows[-1]["ts_utc"],
        })
    return {"index": index, "files": files}


def js_ascii(source: str) -> str:
    r"""Escape every non-ASCII char as \uXXXX - valid inside strings and comments."""
    return "".join(c if ord(c) < 128 else "\\u%04x" % ord(c) for c in source)


def html_ascii(source: str) -> str:
    return source.encode("ascii", "xmlcharrefreplace").decode("ascii")


def build(days: int, seed: int) -> str:
    rows = generate(days, seed)
    payload = as_payload(rows)

    html = (DOCS / "index.html").read_text(encoding="utf-8")
    css = (DOCS / "style.css").read_text(encoding="utf-8")

    body = re.search(r"<body>\s*(.*?)\s*<script src=", html, re.S).group(1)
    body = body.replace(
        '<div class="masthead">',
        BANNER.format(days=days, rows=f"{len(rows):,}".replace(",", "&nbsp;"))
        + '\n  <div class="masthead">',
        1,
    )

    shim = SHIM.replace("__DEMO__", json.dumps(payload, ensure_ascii=True))
    scripts = [js_ascii(shim)]
    scripts += [js_ascii((DOCS / "js" / name).read_text(encoding="utf-8")) for name in SCRIPTS]

    out = (
        "<title>ESO analizatorius demo</title>\n"
        "<style>\n" + html_ascii(css) + EXTRA_CSS + "</style>\n\n"
        + html_ascii(body) + "\n\n"
        + "\n".join(f"<script>\n{block}\n</script>" for block in scripts) + "\n"
    )
    assert all(ord(c) < 128 for c in out), "output is not pure ASCII"
    return out


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--days", type=int, default=92)
    parser.add_argument("--seed", type=int, default=7)
    parser.add_argument("--out", type=Path, default=ROOT / "demo.html")
    args = parser.parse_args()

    out = build(args.days, args.seed)
    args.out.write_text(out, encoding="ascii")
    print(f"{args.out}: {len(out)} bytes, pure ASCII, {args.days} days of demo data")


if __name__ == "__main__":
    main()
