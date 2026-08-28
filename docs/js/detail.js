/* The "Detaliai" tab: the same readings, reshaped.

   The controls above the page choose the period; the controls in this tab
   choose granularity, aggregation and which metrics take part. Everything
   below - tiles, chart, matrix, pivot and comparison - is redrawn from those
   four choices, so a new cut needs no new code. */

(function (ESO) {
  "use strict";

  const {
    SERIES, METRICS, numberFmt, decimalFmt, timeFmt, dateFmt,
    clockFmt, monthFmt, duration, state, el,
  } = ESO.core;
  const {
    GRANULARITIES, AGGREGATIONS, DIMENSIONS, autoGranularity,
    bucketRows, bucketLabel, summarise, overall, matrix, formatValue,
  } = ESO.agg;
  const { fillDelta, lineChart, heatmap } = ESO.viz;

  const config = {
    granularity: "auto",
    aggregation: "avg",
    metrics: new Set(METRICS),
    heatRows: "weekday",
    heatCols: "hour",
  };

  /** Metrics in the canonical order, never in click order. */
  function activeMetrics() {
    const chosen = METRICS.filter((key) => config.metrics.has(key));
    return chosen.length ? chosen : [METRICS[0]];
  }

  function effectiveGranularity(rows) {
    if (config.granularity !== "auto") return config.granularity;
    if (!rows.length) return "day";
    return autoGranularity(rows[rows.length - 1].t - rows[0].t);
  }

  const format = (value) => formatValue(value, config.aggregation);

  /* ---------------- KPI tiles ---------------- */

  function renderKpi(rows, previousRows) {
    const host = el("d-tiles");
    host.textContent = "";
    if (!rows.length) return;

    // Same rule as the overview tab: name the span the data covers, not the
    // one the picker asked for.
    const covered = duration(rows[rows.length - 1].t - rows[0].t);
    const now = overall(rows, METRICS, config.aggregation);
    const before = previousRows.length
      ? overall(previousRows, METRICS, config.aggregation)
      : null;
    const aggLabel = AGGREGATIONS[config.aggregation].label.toLowerCase();

    for (const key of activeMetrics()) {
      const meta = SERIES[key];
      const card = document.createElement("div");
      card.className = "tile";

      const label = document.createElement("div");
      label.className = "tile__label";
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.setProperty("--key-color", meta.color);
      label.append(swatch, document.createTextNode(meta.name));

      const value = document.createElement("div");
      value.className = "tile__value tile__value--kpi";
      value.textContent = format(now[key]);

      const caption = document.createElement("div");
      caption.className = "tile__caption";
      caption.textContent = `${aggLabel} per ${covered}`;

      const foot = document.createElement("div");
      foot.className = "tile__foot";
      const deltas = document.createElement("div");
      deltas.className = "tile__deltas";

      // Change against the period immediately before this one, in percent:
      // absolute counts of different lengths would not be comparable.
      const line = document.createElement("span");
      line.className = "tile__delta delta tile__delta--step";
      if (before && before[key]) {
        const percent = ((now[key] - before[key]) / Math.abs(before[key])) * 100;
        fillDelta(line, Math.round(percent * 10) / 10, "vs ankstesnis laikotarpis",
          (v) => `${decimalFmt.format(v)} %`);
      } else {
        line.classList.add("delta--flat");
        line.textContent = "nėra su kuo palyginti";
      }
      deltas.appendChild(line);

      const range = document.createElement("span");
      range.className = "tile__delta tile__delta--range";
      range.textContent = now[`${key}_min`] === null
        ? "nėra duomenų"
        : `nuo ${numberFmt.format(Math.round(now[`${key}_min`]))}`
          + ` iki ${numberFmt.format(Math.round(now[`${key}_max`]))}`;
      deltas.appendChild(range);

      foot.appendChild(deltas);
      card.append(label, value, caption, foot);
      host.appendChild(card);
    }
  }

  /* ---------------- aggregated chart ---------------- */

  const SVG_NS = "http://www.w3.org/2000/svg";

  /**
   * Small multiples, one chart per metric. Four metrics on one axis would be a
   * lie by omission: the peak of `n` runs to tens of thousands while `c` lives
   * in the hundreds, so three of the four flatten into the baseline. Separate
   * panels give each its own scale without inventing a second y-axis.
   */
  function renderChart(points, granularity) {
    const keys = activeMetrics();
    const host = el("d-charts");
    host.textContent = "";
    const showBand = granularity !== "raw";

    el("d-chart-note").textContent = showBand
      ? `${AGGREGATIONS[config.aggregation].label.toLowerCase()}, juosta — min ir maks. kiekviename intervale`
      : "kiekvienas nuskaitymas";

    // The label has to follow the span, not the bucket size: hourly buckets
    // across four days printed as bare clock times read as if they ran
    // backwards, because the date they belong to was missing.
    const span = points.length > 1 ? points[points.length - 1].t - points[0].t : 0;
    const tickFormat = (t) => {
      const moment = new Date(t);
      if (span <= 36 * 3600 * 1000) return clockFmt.format(moment);
      if (granularity === "month" || span > 400 * 24 * 3600 * 1000) return monthFmt.format(moment);
      return dateFmt.format(moment);
    };

    // Two passes on purpose. A chart measures its own width, and the grid
    // reflows every time a panel is added - drawing as we go would size the
    // first panels against a column count that no longer exists.
    const panels = keys.map((key) => {
      const block = document.createElement("div");
      block.className = "multiple";

      const head = document.createElement("div");
      head.className = "multiple__head";
      const swatch = document.createElement("span");
      swatch.className = "legend__key";
      swatch.style.setProperty("--key-color", SERIES[key].color);
      head.append(swatch, document.createTextNode(SERIES[key].name));

      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("class", "plot");
      svg.setAttribute("role", "img");
      svg.setAttribute("tabindex", "0");
      svg.setAttribute("aria-label", `${SERIES[key].name}: kitimas per laikotarpį`);

      const tip = document.createElement("div");
      tip.className = "tooltip";
      tip.setAttribute("role", "status");

      block.append(head, svg, tip);
      host.appendChild(block);
      return { key, svg, tip };
    });

    for (const panel of panels) {
      lineChart({
        svg: panel.svg,
        tip: panel.tip,
        rows: points,
        keys: [panel.key],
        band: showBand,
        valueFormat: format,
        tickFormat,
        pointLabel: (row) => bucketLabel(row.t, granularity),
        emptyText: "Pasirinktu laikotarpiu duomenų nepakanka",
        height: keys.length === 1 ? 300 : 210,
      });
    }
  }

  /* ---------------- matrix ---------------- */

  function renderMatrix(rows) {
    const key = activeMetrics()[0];
    const data = matrix(rows, config.heatRows, config.heatCols, key, config.aggregation);
    heatmap(el("d-heat"), data, {
      format,
      legendHost: el("d-heat-legend"),
      metricName: SERIES[key].name,
    });
    el("d-heat-note").textContent =
      `${SERIES[key].name} · ${AGGREGATIONS[config.aggregation].label.toLowerCase()}`;
  }

  /* ---------------- pivot table ---------------- */

  let csvText = "";

  function renderPivot(points, granularity, rows) {
    const keys = activeMetrics();
    const head = el("d-pivot-head");
    const body = el("d-pivot-body");
    head.textContent = "";
    body.textContent = "";

    const headRow = document.createElement("tr");
    for (const title of ["Laikotarpis", "Nuskaitymai", ...keys.map((k) => SERIES[k].short)]) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = title;
      headRow.appendChild(th);
    }
    head.appendChild(headRow);

    const csv = [["laikotarpis", "nuskaitymai", ...keys].join(",")];

    // Newest first, matching the raw table on the other tab.
    for (let i = points.length - 1; i >= 0; i -= 1) {
      const point = points[i];
      const tr = document.createElement("tr");
      if (point.empty) tr.className = "row--empty";

      const label = document.createElement("td");
      label.textContent = bucketLabel(point.t, granularity);
      tr.appendChild(label);

      const count = document.createElement("td");
      count.textContent = point.empty ? "–" : numberFmt.format(point.count);
      tr.appendChild(count);

      for (const key of keys) {
        const td = document.createElement("td");
        td.textContent = point.empty ? "–" : format(point[key]);
        tr.appendChild(td);
      }
      body.appendChild(tr);

      csv.push([
        bucketLabel(point.t, granularity),
        point.empty ? "" : point.count,
        ...keys.map((key) => (point[key] === null ? "" : point[key].toFixed(2))),
      ].join(","));
    }

    // Totals come from every reading in the period, not from the rows above:
    // an average of averages would silently weight short buckets equally.
    const totals = overall(rows, keys, config.aggregation);
    const footRow = document.createElement("tr");
    footRow.className = "row--total";
    const totalLabel = document.createElement("td");
    totalLabel.textContent = "IŠ VISO";
    footRow.appendChild(totalLabel);
    const totalCount = document.createElement("td");
    totalCount.textContent = numberFmt.format(totals.count);
    footRow.appendChild(totalCount);
    for (const key of keys) {
      const td = document.createElement("td");
      td.textContent = format(totals[key]);
      footRow.appendChild(td);
    }
    body.appendChild(footRow);

    csvText = csv.join("\n");
    el("d-pivot-count").textContent =
      `${numberFmt.format(points.length)} intervalai · ${GRANULARITIES[granularity].label.toLowerCase()}`;
  }

  /* ---------------- period comparison ---------------- */

  function renderCompare(rows, previousRows) {
    const body = el("d-compare-body");
    body.textContent = "";
    const note = el("d-compare-note");

    if (!previousRows.length) {
      note.textContent = state.hours
        ? "Ankstesniu tokios pat trukmės laikotarpiu duomenų dar nėra."
        : "Palyginimas veikia tik pasirinkus konkretų laikotarpį.";
      return;
    }
    const nowSpan = duration(rows[rows.length - 1].t - rows[0].t);
    const beforeSpan = duration(
      previousRows[previousRows.length - 1].t - previousRows[0].t,
    );
    note.textContent = `Dabar: ${nowSpan} duomenų · anksčiau: ${beforeSpan}.`;

    const now = overall(rows, METRICS, "avg");
    const before = overall(previousRows, METRICS, "avg");

    for (const key of activeMetrics()) {
      const tr = document.createElement("tr");

      const name = document.createElement("td");
      const swatch = document.createElement("span");
      swatch.className = "swatch swatch--inline";
      swatch.style.setProperty("--key-color", SERIES[key].color);
      name.append(swatch, document.createTextNode(SERIES[key].name));
      tr.appendChild(name);

      for (const value of [now[key], before[key]]) {
        const td = document.createElement("td");
        td.textContent = value === null ? "–" : decimalFmt.format(value);
        tr.appendChild(td);
      }

      const change = document.createElement("td");
      const delta = document.createElement("span");
      delta.className = "delta";
      if (before[key]) {
        const percent = ((now[key] - before[key]) / Math.abs(before[key])) * 100;
        fillDelta(delta, Math.round(percent * 10) / 10, "", (v) => `${decimalFmt.format(v)} %`);
      } else {
        delta.classList.add("delta--flat");
        delta.textContent = "–";
      }
      change.appendChild(delta);
      tr.appendChild(change);

      const peak = document.createElement("td");
      peak.textContent = now[`${key}_max`] === null
        ? "–" : numberFmt.format(now[`${key}_max`]);
      tr.appendChild(peak);

      const peakAt = document.createElement("td");
      peakAt.className = "cell-muted";
      peakAt.textContent = now[`${key}_peak_t`] === null
        ? "–" : timeFmt.format(new Date(now[`${key}_peak_t`]));
      tr.appendChild(peakAt);

      body.appendChild(tr);
    }
  }

  /* ---------------- orchestration ---------------- */

  function render(rows, previousRows) {
    const granularity = effectiveGranularity(rows);
    const buckets = bucketRows(rows, granularity);
    const points = summarise(buckets, METRICS, config.aggregation);

    el("d-granularity-note").textContent = config.granularity === "auto"
      ? `automatiškai: ${GRANULARITIES[granularity].label.toLowerCase()}`
      : "";

    renderKpi(rows, previousRows);
    renderChart(points, granularity);
    renderMatrix(rows);
    renderPivot(points, granularity, rows);
    renderCompare(rows, previousRows);
  }

  /* ---------------- controls ---------------- */

  function setup(onChange) {
    const segments = [
      { id: "d-granularity", field: "granularity", attr: "granularity" },
      { id: "d-aggregation", field: "aggregation", attr: "aggregation" },
    ];
    for (const segment of segments) {
      el(segment.id).addEventListener("click", (event) => {
        const button = event.target.closest(`button[data-${segment.attr}]`);
        if (!button) return;
        config[segment.field] = button.dataset[segment.attr];
        for (const other of el(segment.id).querySelectorAll("button")) {
          other.setAttribute("aria-pressed", String(other === button));
        }
        onChange();
      });
    }

    el("d-metrics").addEventListener("click", (event) => {
      const button = event.target.closest("button[data-metric]");
      if (!button) return;
      const key = button.dataset.metric;
      // Never let the last metric be switched off: an empty chart helps nobody.
      if (config.metrics.has(key) && config.metrics.size > 1) config.metrics.delete(key);
      else config.metrics.add(key);
      button.setAttribute("aria-pressed", String(config.metrics.has(key)));
      onChange();
    });

    for (const [id, field] of [["d-heat-rows", "heatRows"], ["d-heat-cols", "heatCols"]]) {
      const select = el(id);
      for (const [value, meta] of Object.entries(DIMENSIONS)) {
        const option = document.createElement("option");
        option.value = value;
        option.textContent = meta.label;
        select.appendChild(option);
      }
      select.value = config[field];
      select.addEventListener("change", () => {
        config[field] = select.value;
        onChange();
      });
    }

    el("d-copy-csv").addEventListener("click", async () => {
      const button = el("d-copy-csv");
      try {
        await navigator.clipboard.writeText(csvText);
        button.textContent = "Nukopijuota";
      } catch {
        button.textContent = "Nepavyko nukopijuoti";
      }
      setTimeout(() => { button.textContent = "Kopijuoti CSV"; }, 2000);
    });

    // Chips start pressed because every metric starts selected.
    for (const button of el("d-metrics").querySelectorAll("button[data-metric]")) {
      button.setAttribute("aria-pressed", String(config.metrics.has(button.dataset.metric)));
    }
  }

  ESO.detail = { render, setup, config };
})(window.ESO);
