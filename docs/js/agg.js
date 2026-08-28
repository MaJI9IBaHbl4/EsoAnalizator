/* Bucketing and aggregation.

   One rule shapes everything here: the counters are a *state* (how many
   customers are off right now), not a stream of events. Adding them up is
   meaningless - 96 daily snapshots summed is not "outages per day" - so the
   aggregations on offer are average, peak, minimum and last, never a sum. */

(function (ESO) {
  "use strict";

  const { localDate, fromLocal, weekdayIndex, hourOfDay, WEEKDAYS,
          dateFmt, monthFmt, clockFmt, numberFmt, decimalFmt } = ESO.core;

  const HOUR = 3600 * 1000;
  const DAY = 24 * HOUR;

  const GRANULARITIES = {
    raw: { label: "Nuskaitymai", step: 15 * 60 * 1000 },
    hour: { label: "Valanda", step: HOUR },
    day: { label: "Diena", step: DAY },
    week: { label: "Savaitė", step: 7 * DAY },
    month: { label: "Mėnuo", step: 30 * DAY },
  };

  const AGGREGATIONS = {
    avg: { label: "Vidurkis", apply: (values) => values.reduce((a, b) => a + b, 0) / values.length },
    max: { label: "Maksimumas", apply: (values) => Math.max(...values) },
    min: { label: "Minimumas", apply: (values) => Math.min(...values) },
    last: { label: "Paskutinis", apply: (values) => values[values.length - 1] },
  };

  /** Granularity that keeps a range readable: never thousands of buckets. */
  function autoGranularity(spanMs) {
    if (spanMs <= 2 * DAY) return "raw";
    if (spanMs <= 14 * DAY) return "hour";
    if (spanMs <= 120 * DAY) return "day";
    if (spanMs <= 2 * 365 * DAY) return "week";
    return "month";
  }

  /** Start of the bucket `time` falls in, on Vilnius wall-clock boundaries. */
  function bucketStart(time, granularity) {
    if (granularity === "raw") return time;
    const local = localDate(time);
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth();
    const day = local.getUTCDate();

    let localMs;
    switch (granularity) {
      case "hour":
        localMs = Date.UTC(year, month, day, local.getUTCHours());
        break;
      case "day":
        localMs = Date.UTC(year, month, day);
        break;
      case "week":
        // Monday, the way the week is read in Lithuania.
        localMs = Date.UTC(year, month, day) - weekdayIndex(time) * DAY;
        break;
      case "month":
        localMs = Date.UTC(year, month, 1);
        break;
      default:
        return time;
    }
    return fromLocal(localMs);
  }

  function nextBucket(start, granularity) {
    const local = localDate(start);
    const year = local.getUTCFullYear();
    const month = local.getUTCMonth();
    const day = local.getUTCDate();

    switch (granularity) {
      case "hour":
        return fromLocal(Date.UTC(year, month, day, local.getUTCHours() + 1));
      case "day":
        return fromLocal(Date.UTC(year, month, day + 1));
      case "week":
        return fromLocal(Date.UTC(year, month, day + 7));
      case "month":
        return fromLocal(Date.UTC(year, month + 1, 1));
      default:
        return start + GRANULARITIES.raw.step;
    }
  }

  function bucketLabel(start, granularity) {
    const date = new Date(start);
    switch (granularity) {
      case "hour":
        return `${dateFmt.format(date)} ${clockFmt.format(date)}`;
      case "day":
        return dateFmt.format(date);
      case "week": {
        const end = new Date(start + 6 * DAY);
        return `${dateFmt.format(date)}–${dateFmt.format(end)}`;
      }
      case "month":
        return monthFmt.format(date);
      default:
        return ESO.core.timeFmt.format(date);
    }
  }

  /**
   * Group rows into buckets, including the empty ones. A gap where the machine
   * was asleep has to stay visible as a gap - silently closing it would draw a
   * straight line through hours nobody measured.
   */
  function bucketRows(rows, granularity) {
    if (!rows.length) return [];
    if (granularity === "raw") return rows.map((row) => ({ t: row.t, rows: [row] }));

    const grouped = new Map();
    for (const row of rows) {
      const start = bucketStart(row.t, granularity);
      let bucket = grouped.get(start);
      if (!bucket) grouped.set(start, (bucket = []));
      bucket.push(row);
    }

    const out = [];
    const last = bucketStart(rows[rows.length - 1].t, granularity);
    let cursor = bucketStart(rows[0].t, granularity);
    let guard = 0;
    while (cursor <= last && guard < 20000) {
      out.push({ t: cursor, rows: grouped.get(cursor) || [] });
      cursor = nextBucket(cursor, granularity);
      guard += 1;
    }
    return out;
  }

  /**
   * One row per bucket: the chosen aggregation per metric, plus the min and max
   * that the chart draws as a band around it, plus how many readings went in.
   */
  function summarise(buckets, keys, how) {
    const apply = (AGGREGATIONS[how] || AGGREGATIONS.avg).apply;
    return buckets.map((bucket) => {
      const point = { t: bucket.t, count: bucket.rows.length, empty: !bucket.rows.length };
      for (const key of keys) {
        // A reading that was never taken must not be averaged in as a zero.
        const values = bucket.rows.map((row) => row[key]).filter((v) => v !== null);
        if (!values.length) {
          point[key] = null;
          point[`${key}_min`] = null;
          point[`${key}_max`] = null;
          continue;
        }
        point[key] = apply(values);
        point[`${key}_min`] = Math.min(...values);
        point[`${key}_max`] = Math.max(...values);
      }
      return point;
    });
  }

  /** The same aggregation over a whole set of rows, for KPI tiles and totals. */
  function overall(rows, keys, how) {
    const apply = (AGGREGATIONS[how] || AGGREGATIONS.avg).apply;
    const out = { count: rows.length };
    for (const key of keys) {
      const known = rows.filter((row) => row[key] !== null);
      if (!known.length) {
        out[key] = null;
        out[`${key}_min`] = null;
        out[`${key}_max`] = null;
        out[`${key}_peak_t`] = null;
        continue;
      }
      const values = known.map((row) => row[key]);
      out[key] = apply(values);
      out[`${key}_min`] = Math.min(...values);
      out[`${key}_max`] = Math.max(...values);
      let peakAt = known[0];
      for (const row of known) if (row[key] > peakAt[key]) peakAt = row;
      out[`${key}_peak_t`] = peakAt.t;
    }
    return out;
  }

  /* ---------------- matrix dimensions ---------------- */

  const DIMENSIONS = {
    weekday: {
      label: "Savaitės diena",
      of: (time) => weekdayIndex(time),
      fixed: [0, 1, 2, 3, 4, 5, 6],
      format: (value) => WEEKDAYS[value],
    },
    hour: {
      label: "Valanda",
      of: (time) => hourOfDay(time),
      fixed: Array.from({ length: 24 }, (_, i) => i),
      format: (value) => `${String(value).padStart(2, "0")}`,
    },
    monthday: {
      label: "Mėnesio diena",
      of: (time) => localDate(time).getUTCDate(),
      fixed: Array.from({ length: 31 }, (_, i) => i + 1),
      format: (value) => String(value),
    },
    month: {
      label: "Mėnuo",
      of: (time) => {
        const local = localDate(time);
        return local.getUTCFullYear() * 12 + local.getUTCMonth();
      },
      format: (value) => monthFmt.format(new Date(Date.UTC(Math.floor(value / 12), value % 12, 1))),
    },
  };

  /**
   * Cross-tabulation: one metric aggregated over two dimensions. Empty cells
   * stay empty - a missing weekday/hour pair is "never measured", which is not
   * the same as zero.
   */
  function matrix(rows, rowDim, colDim, key, how) {
    const apply = (AGGREGATIONS[how] || AGGREGATIONS.avg).apply;
    const rowMeta = DIMENSIONS[rowDim];
    const colMeta = DIMENSIONS[colDim];
    const cells = new Map();
    const seenRows = new Set();
    const seenCols = new Set();

    for (const row of rows) {
      if (row[key] === null) continue;
      const r = rowMeta.of(row.t);
      const c = colMeta.of(row.t);
      seenRows.add(r);
      seenCols.add(c);
      const cellKey = `${r}|${c}`;
      let values = cells.get(cellKey);
      if (!values) cells.set(cellKey, (values = []));
      values.push(row[key]);
    }

    const axis = (meta, seen) =>
      (meta.fixed || Array.from(seen).sort((a, b) => a - b));

    const rowKeys = axis(rowMeta, seenRows);
    const colKeys = axis(colMeta, seenCols);

    let min = Infinity;
    let max = -Infinity;
    const values = new Map();
    for (const [cellKey, list] of cells) {
      const value = apply(list);
      values.set(cellKey, { value, count: list.length });
      if (value < min) min = value;
      if (value > max) max = value;
    }

    return {
      rowKeys, colKeys, values, min, max,
      rowLabel: rowMeta.format, colLabel: colMeta.format,
      rowTitle: rowMeta.label, colTitle: colMeta.label,
      get: (r, c) => values.get(`${r}|${c}`) || null,
    };
  }

  /** Averages are fractional; peaks and last readings are whole people. */
  function formatValue(value, how) {
    if (value === null || value === undefined || Number.isNaN(value)) return "–";
    return how === "avg" ? decimalFmt.format(value) : numberFmt.format(Math.round(value));
  }

  ESO.agg = {
    GRANULARITIES, AGGREGATIONS, DIMENSIONS,
    autoGranularity, bucketStart, nextBucket, bucketLabel,
    bucketRows, summarise, overall, matrix, formatValue,
  };
})(window.ESO);
