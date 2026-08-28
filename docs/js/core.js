/* Shared foundation: constants, formatting, local-time helpers and the data
   store. Loaded first; everything else hangs off window.ESO. */

window.ESO = window.ESO || {};

(function (ESO) {
  "use strict";

  const TZ = "Europe/Vilnius";

  /* Colour follows the entity, never its rank or its position in a filter:
     `n` stays blue whichever chart, tab or range it appears in. Slots 1-4 of
     the validated categorical order. */
  const SERIES = {
    n: { name: "Atjungti dėl sutrikimų", short: "Atjungti (sutrikimai)", color: "var(--series-n)" },
    p: { name: "Atjungti dėl planinių darbų", short: "Atjungti (planiniai)", color: "var(--series-p)" },
    k: { name: "Klientų pranešimai", short: "Klientų pranešimai", color: "var(--series-k)" },
    c: { name: "Sutrikimai", short: "Sutrikimai", color: "var(--series-c)" },
  };

  // Reading order across the whole app: headline metric first.
  const METRICS = ["n", "c", "k", "p"];

  const RANGE_LABELS = {
    24: "24 val.",
    168: "7 dienas",
    720: "30 dienų",
    2160: "90 dienų",
    0: "visą laiką",
  };

  const MAX_POINTS = 2000; // beyond this a line is stride-sampled for rendering

  const numberFmt = new Intl.NumberFormat("lt-LT");
  const decimalFmt = new Intl.NumberFormat("lt-LT", { maximumFractionDigits: 1 });
  const timeFmt = new Intl.DateTimeFormat("lt-LT", {
    timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const clockFmt = new Intl.DateTimeFormat("lt-LT", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit",
  });
  const dateFmt = new Intl.DateTimeFormat("lt-LT", {
    timeZone: TZ, day: "2-digit", month: "2-digit",
  });
  const monthFmt = new Intl.DateTimeFormat("lt-LT", {
    timeZone: TZ, year: "numeric", month: "2-digit",
  });

  /** "15 min." / "3 val." / "2 d." - the coarsest unit that still reads right. */
  function duration(ms) {
    const minutes = Math.max(1, Math.round(ms / 60000));
    if (minutes < 60) return `${minutes} min.`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} val.`;
    return `${Math.round(hours / 24)} d.`;
  }

  function ago(ms) {
    if (ms < 60000) return "ką tik";
    return `prieš ${duration(ms)}`;
  }

  /* ---------------- local time ----------------

     Buckets must break on Vilnius midnight, not UTC midnight, or every "day"
     is shifted two or three hours and the hour-of-day heatmap is simply wrong.
     Asking Intl for the parts of every sample is far too slow for tens of
     thousands of rows, so the zone offset is resolved once per hour - it only
     ever changes at a DST boundary. */

  const partsFmt = new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ,
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
    hourCycle: "h23",
  });

  const offsetCache = new Map();

  function offsetAt(time) {
    const hourKey = Math.floor(time / 3600000);
    let offset = offsetCache.get(hourKey);
    if (offset === undefined) {
      const parts = {};
      for (const part of partsFmt.formatToParts(new Date(time))) parts[part.type] = part.value;
      const asUtc = Date.UTC(
        Number(parts.year), Number(parts.month) - 1, Number(parts.day),
        Number(parts.hour), Number(parts.minute), Number(parts.second),
      );
      offset = asUtc - Math.floor(time / 1000) * 1000;
      offsetCache.set(hourKey, offset);
    }
    return offset;
  }

  /** A Date whose UTC getters read as Vilnius wall-clock values. */
  function localDate(time) {
    return new Date(time + offsetAt(time));
  }

  /** Turn a Vilnius wall-clock instant back into a real timestamp. */
  function fromLocal(localMs) {
    // One correction pass is enough: the guess is at most an hour out.
    const guess = localMs - offsetAt(localMs);
    return localMs - offsetAt(guess);
  }

  const WEEKDAYS = ["Pirmad.", "Antrad.", "Trečiad.", "Ketvirt.", "Penktad.", "Šeštad.", "Sekmad."];

  /** Monday = 0, matching how the week is read in Lithuania. */
  function weekdayIndex(time) {
    return (localDate(time).getUTCDay() + 6) % 7;
  }

  function hourOfDay(time) {
    return localDate(time).getUTCHours();
  }

  /* ---------------- data store ---------------- */

  const state = {
    index: null,
    rows: [],            // every row loaded so far, ascending by time
    loadedFiles: new Set(),
    hours: 24,           // selected period, shared by both tabs
    tab: "overview",
    tableOpen: false,
    hoverIndex: null,
  };

  async function loadIndex() {
    const response = await fetch(`data/index.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`index.json: HTTP ${response.status}`);
    return response.json();
  }

  /* An empty cell is a counter that was never recorded - not a zero. The
     hand-collected history that predates the collector carries no
     planned-outage column, and reading that as zero would invent a
     measurement nobody took. */
  const value = (raw) => (raw === undefined || raw === "" ? null : Number(raw));

  const fmtValue = (v) => (v === null ? "–" : numberFmt.format(v));

  function parseCsv(text) {
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) return [];
    const header = lines[0].split(",");
    const rows = [];
    for (let i = 1; i < lines.length; i += 1) {
      const parts = lines[i].split(",");
      if (parts.length < header.length) continue;
      const row = {};
      header.forEach((name, j) => { row[name] = parts[j]; });
      const time = Date.parse(row.ts_utc);
      if (Number.isNaN(time)) continue;
      rows.push({
        t: time,
        k: value(row.k), c: value(row.c),
        n: value(row.n), p: value(row.p),
      });
    }
    return rows;
  }

  /** Months whose [first, last] window overlaps the selected range. */
  function monthsForRange(index, hours) {
    if (!hours) return index.months;
    const cutoff = Date.now() - hours * 3600 * 1000;
    const wanted = index.months.filter((month) => Date.parse(month.last) >= cutoff);
    // Keep one month of lead-in so a range that starts mid-gap still has context.
    const firstWanted = index.months.indexOf(wanted[0]);
    if (firstWanted > 0) wanted.unshift(index.months[firstWanted - 1]);
    return wanted.length ? wanted : index.months.slice(-1);
  }

  function monthFile(time) {
    return `${new Date(time).toISOString().slice(0, 7)}.csv`;
  }

  async function ensureMonths(months) {
    const pending = months.filter((month) => {
      // The current month keeps growing, so its cache key is its own last stamp.
      const token = `${month.file}@${month.last}`;
      if (state.loadedFiles.has(token)) return false;
      state.loadedFiles.add(token);
      return true;
    });
    if (!pending.length) return;

    const loaded = await Promise.all(pending.map(async (month) => {
      const response = await fetch(`data/${month.file}?v=${encodeURIComponent(month.last)}`);
      if (!response.ok) throw new Error(`${month.file}: HTTP ${response.status}`);
      return { file: month.file, rows: parseCsv(await response.text()) };
    }));

    // A re-fetched month replaces its earlier copy rather than duplicating it.
    const replaced = new Set(loaded.map((entry) => entry.file));
    const kept = state.rows.filter((row) => !replaced.has(monthFile(row.t)));
    state.rows = kept
      .concat(loaded.flatMap((entry) => entry.rows))
      .sort((a, b) => a.t - b.t);
  }

  function rangeStart() {
    return state.hours ? Date.now() - state.hours * 3600 * 1000 : -Infinity;
  }

  function rowsInRange() {
    if (!state.hours) return state.rows;
    const cutoff = rangeStart();
    return state.rows.filter((row) => row.t >= cutoff);
  }

  /** Rows of the period immediately before the selected one, same length. */
  function rowsInPreviousRange() {
    if (!state.hours) return [];
    const span = state.hours * 3600 * 1000;
    const start = Date.now() - 2 * span;
    const end = Date.now() - span;
    return state.rows.filter((row) => row.t >= start && row.t < end);
  }

  function decimate(rows) {
    if (rows.length <= MAX_POINTS) return rows;
    const stride = Math.ceil(rows.length / MAX_POINTS);
    const out = rows.filter((_, i) => i % stride === 0);
    if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
    return out;
  }

  ESO.core = {
    TZ, SERIES, METRICS, RANGE_LABELS, MAX_POINTS, WEEKDAYS,
    numberFmt, decimalFmt, timeFmt, clockFmt, dateFmt, monthFmt,
    duration, ago,
    localDate, fromLocal, weekdayIndex, hourOfDay,
    fmtValue,
    state, loadIndex, parseCsv, monthsForRange, ensureMonths,
    rangeStart, rowsInRange, rowsInPreviousRange, decimate,
    el: (id) => document.getElementById(id),
  };
})(window.ESO);
