/* The "Apžvalga" tab: what is happening right now. Four tiles, two charts and
   the raw reading table - unchanged in behaviour, now drawn with the shared
   primitives in viz.js. */

(function (ESO) {
  "use strict";

  const {
    SERIES, RANGE_LABELS, METRICS, numberFmt, timeFmt, clockFmt, dateFmt,
    duration, state, decimate, el,
  } = ESO.core;
  const { fillDelta, sparkline, renderLegend, lineChart } = ESO.viz;

  const TILES = [
    { key: "n", hero: true },
    { key: "c" },
    { key: "k" },
    { key: "p" },
  ];

  const CHARTS = [
    { plot: "plot-clients", tip: "tip-clients", legend: "legend-clients", keys: ["n", "p"] },
    { plot: "plot-events", tip: "tip-events", legend: "legend-events", keys: ["k", "c"] },
  ];

  const TABLE_LIMIT = 500;

  /**
   * Delta line for a tile. `window` names the span it covers, so the two deltas
   * on a tile can never be mistaken for each other.
   */
  function deltaLine(change, window, className) {
    const span = document.createElement("span");
    span.className = `tile__delta delta ${className}`;
    return fillDelta(span, change, `per ${window}`);
  }

  function renderTiles(rows) {
    const host = el("tiles");
    host.textContent = "";
    if (!rows.length) return;

    const last = rows[rows.length - 1];
    const first = rows[0];

    // The step delta is about the freshest data, so it looks at the sample
    // before `last` in the full series - which may pre-date the selected range.
    const lastIndex = state.rows.indexOf(last);
    const previous = lastIndex > 0 ? state.rows[lastIndex - 1] : null;
    // Never hard-code 15 minutes: a sleeping machine leaves real gaps, and the
    // label has to say how long the step actually was.
    const stepWindow = previous ? duration(last.t - previous.t) : null;

    for (const tile of TILES) {
      const meta = SERIES[tile.key];
      const card = document.createElement("div");
      card.className = `tile${tile.hero ? " tile--hero" : ""}`;

      const label = document.createElement("div");
      label.className = "tile__label";
      const swatch = document.createElement("span");
      swatch.className = "swatch";
      swatch.style.setProperty("--key-color", meta.color);
      label.append(swatch, document.createTextNode(meta.name));

      const value = document.createElement("div");
      value.className = "tile__value";
      value.textContent = numberFmt.format(last[tile.key]);

      const foot = document.createElement("div");
      foot.className = "tile__foot";

      const deltas = document.createElement("div");
      deltas.className = "tile__deltas";
      if (previous) {
        deltas.appendChild(deltaLine(
          last[tile.key] - previous[tile.key], stepWindow, "tile__delta--step",
        ));
      }
      if (rows.length > 1) {
        deltas.appendChild(deltaLine(
          last[tile.key] - first[tile.key], RANGE_LABELS[state.hours], "tile__delta--range",
        ));
      }

      foot.append(deltas, sparkline(rows, tile.key, meta.color));
      card.append(label, value, foot);
      host.appendChild(card);
    }
  }

  function renderTable(rows) {
    const body = el("table-body");
    body.textContent = "";

    // Newest first, each row paired with the reading that came before it.
    const from = Math.max(0, rows.length - TABLE_LIMIT);
    let shown = 0;
    for (let i = rows.length - 1; i >= from; i -= 1) {
      const row = rows[i];
      const previous = i > 0 ? rows[i - 1] : null;
      const tr = document.createElement("tr");

      const time = document.createElement("td");
      time.textContent = timeFmt.format(new Date(row.t));
      tr.appendChild(time);

      for (const key of ["k", "c", "n", "p"]) {
        const td = document.createElement("td");

        const value = document.createElement("span");
        value.className = "cell-value";
        value.textContent = numberFmt.format(row[key]);

        // Fixed-width so the values above it stay in a straight column.
        const delta = document.createElement("span");
        delta.className = "cell-delta delta";
        if (previous) fillDelta(delta, row[key] - previous[key]);

        td.append(value, delta);
        tr.appendChild(td);
      }

      body.appendChild(tr);
      shown += 1;
    }

    el("table-count").textContent =
      `${numberFmt.format(rows.length)} įrašų per ${RANGE_LABELS[state.hours]}`;
    el("table-note").textContent = rows.length > shown
      ? `Rodomi paskutiniai ${shown}. Visa istorija — CSV failuose docs/data/.`
      : "";
  }

  function render(rows) {
    const points = decimate(rows);
    const span = points.length > 1 ? points[points.length - 1].t - points[0].t : 0;
    const useClock = span <= 36 * 3600 * 1000;

    renderTiles(rows);
    for (const config of CHARTS) {
      renderLegend(el(config.legend), config.keys);
      lineChart({
        svg: el(config.plot),
        tip: el(config.tip),
        rows: points,
        keys: config.keys,
        tickFormat: (t) => (useClock ? clockFmt : dateFmt).format(new Date(t)),
        pointLabel: (row) => timeFmt.format(new Date(row.t)),
        emptyText: "Per mažai taškų grafikui — palaukite kitų nuskaitymų",
      });
    }
    if (state.tableOpen) renderTable(rows);
  }

  ESO.overview = { render, renderTable, METRICS };
})(window.ESO);
