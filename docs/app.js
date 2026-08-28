/* ESO analizatorius - dashboard for the snapshots collected by
   collector/collect.py. No build step, no dependencies: it reads
   data/index.json, then the monthly CSVs it needs for the selected range. */

(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const TZ = "Europe/Vilnius";

  /* Colour follows the entity, never its rank or its position in a filter:
     `n` stays blue whichever chart or range it appears in. Slots 1-4 of the
     validated categorical order. */
  const SERIES = {
    n: { name: "Atjungti dėl sutrikimų", color: "var(--series-n)" },
    p: { name: "Atjungti dėl planinių darbų", color: "var(--series-p)" },
    k: { name: "Klientų pranešimai", color: "var(--series-k)" },
    c: { name: "Sutrikimai", color: "var(--series-c)" },
  };

  const TILES = [
    { key: "n", label: "Atjungti dėl sutrikimų", hero: true },
    { key: "c", label: "Sutrikimai" },
    { key: "k", label: "Klientų pranešimai" },
    { key: "p", label: "Atjungti dėl planinių darbų" },
  ];

  const CHARTS = [
    { plot: "plot-clients", tip: "tip-clients", legend: "legend-clients", keys: ["n", "p"] },
    { plot: "plot-events", tip: "tip-events", legend: "legend-events", keys: ["k", "c"] },
  ];

  const RANGE_LABELS = { 24: "24 val.", 168: "7 dienas", 720: "30 dienų", 0: "visą laiką" };

  const MAX_POINTS = 2000; // beyond this the line is stride-sampled for rendering
  const REFRESH_MS = 5 * 60 * 1000;

  const numberFmt = new Intl.NumberFormat("lt-LT");
  const timeFmt = new Intl.DateTimeFormat("lt-LT", {
    timeZone: TZ, day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit",
  });
  const clockFmt = new Intl.DateTimeFormat("lt-LT", {
    timeZone: TZ, hour: "2-digit", minute: "2-digit",
  });
  const dateFmt = new Intl.DateTimeFormat("lt-LT", {
    timeZone: TZ, day: "2-digit", month: "2-digit",
  });

  const state = {
    index: null,
    rows: [],          // every row loaded so far, ascending by time
    loadedFiles: new Set(),
    hours: 24,
    tableOpen: false,
    hoverIndex: null,
  };

  const el = (id) => document.getElementById(id);

  /* ---------------- data ---------------- */

  async function loadIndex() {
    const response = await fetch(`data/index.json?t=${Date.now()}`, { cache: "no-store" });
    if (!response.ok) throw new Error(`index.json: HTTP ${response.status}`);
    return response.json();
  }

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
        k: Number(row.k), c: Number(row.c),
        n: Number(row.n), p: Number(row.p),
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

  function monthFile(time) {
    return `${new Date(time).toISOString().slice(0, 7)}.csv`;
  }

  function rowsInRange() {
    if (!state.hours) return state.rows;
    const cutoff = Date.now() - state.hours * 3600 * 1000;
    return state.rows.filter((row) => row.t >= cutoff);
  }

  function decimate(rows) {
    if (rows.length <= MAX_POINTS) return rows;
    const stride = Math.ceil(rows.length / MAX_POINTS);
    const out = rows.filter((_, i) => i % stride === 0);
    if (out[out.length - 1] !== rows[rows.length - 1]) out.push(rows[rows.length - 1]);
    return out;
  }

  /* ---------------- small helpers ---------------- */

  function node(name, attrs, parent) {
    const element = document.createElementNS(SVG_NS, name);
    for (const [key, value] of Object.entries(attrs || {})) {
      element.setAttribute(key, value);
    }
    if (parent) parent.appendChild(element);
    return element;
  }

  /** Axis scale whose ticks land on round numbers, not on peak/4. */
  function niceScale(peak, steps) {
    if (peak <= 0) return { max: steps, step: 1 };
    const raw = peak / steps;
    const magnitude = 10 ** Math.floor(Math.log10(raw));
    for (const multiple of [1, 1.5, 2, 2.5, 3, 4, 5, 7.5, 10]) {
      const step = multiple * magnitude;
      if (step >= raw) return { max: step * steps, step };
    }
    return { max: 10 * magnitude * steps, step: 10 * magnitude };
  }

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

  /**
   * Fills `host` with an arrow, the direction spelled out for screen readers,
   * and the magnitude. The arrow is a second channel beside colour, so
   * direction survives colour blindness, greyscale print and forced-colors.
   */
  function fillDelta(host, change, suffix = "") {
    if (change === 0) {
      host.classList.add("delta--flat");
      host.textContent = suffix ? `be pokyčių ${suffix}` : "–";
      return host;
    }

    host.classList.add(change > 0 ? "delta--up" : "delta--down");

    const arrow = document.createElement("span");
    arrow.className = "delta__arrow";
    arrow.setAttribute("aria-hidden", "true");
    arrow.textContent = change > 0 ? "▲" : "▼";

    // The glyph carries no meaning for a screen reader; this word does.
    const spoken = document.createElement("span");
    spoken.className = "sr-only";
    spoken.textContent = change > 0 ? "padidėjo " : "sumažėjo ";

    const amount = numberFmt.format(Math.abs(change));
    host.append(arrow, spoken, document.createTextNode(suffix ? `${amount} ${suffix}` : amount));
    return host;
  }

  /**
   * Delta line for a tile. `window` names the span it covers, so the two deltas
   * on a tile can never be mistaken for each other.
   */
  function deltaLine(change, window, className) {
    const span = document.createElement("span");
    span.className = `tile__delta delta ${className}`;
    return fillDelta(span, change, `per ${window}`);
  }

  /* ---------------- stat tiles ---------------- */

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
      label.append(swatch, document.createTextNode(tile.label));

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

  function sparkline(rows, key, color) {
    const width = 84;
    const height = 26;
    const svg = node("svg", { class: "spark", width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true" });
    const points = decimate(rows).map((row) => row[key]);
    if (points.length < 2) return svg;

    const min = Math.min(...points);
    const max = Math.max(...points);
    const span = max - min || 1;
    const x = (i) => (i / (points.length - 1)) * (width - 6) + 3;
    const y = (v) => height - 4 - ((v - min) / span) * (height - 8);

    node("path", {
      d: points.map((v, i) => `${i ? "L" : "M"}${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" "),
      fill: "none", stroke: color, "stroke-width": 1.5, opacity: 0.45,
      "stroke-linejoin": "round", "stroke-linecap": "round",
    }, svg);
    node("circle", {
      cx: x(points.length - 1).toFixed(1), cy: y(points[points.length - 1]).toFixed(1),
      r: 2.5, fill: color,
    }, svg);
    return svg;
  }

  /* ---------------- charts ---------------- */

  function renderLegend(hostId, keys) {
    const host = el(hostId);
    host.textContent = "";
    for (const key of keys) {
      const item = document.createElement("span");
      item.className = "legend__item";
      const swatch = document.createElement("span");
      swatch.className = "legend__key";
      swatch.style.setProperty("--key-color", SERIES[key].color);
      item.append(swatch, document.createTextNode(SERIES[key].name));
      host.appendChild(item);
    }
  }

  function renderChart(config, allRows) {
    const svg = el(config.plot);
    const tip = el(config.tip);
    svg.textContent = "";

    const rows = decimate(allRows);
    const width = svg.clientWidth || svg.parentElement.clientWidth || 800;
    const height = Math.max(210, Math.min(320, Math.round(width * 0.32)));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("height", height);

    if (rows.length < 2) {
      node("text", { x: width / 2, y: height / 2, "text-anchor": "middle" }, svg)
        .appendChild(document.createTextNode("Per mažai taškų grafikui — palaukite kitų nuskaitymų"));
      return;
    }

    const t0 = rows[0].t;
    const t1 = rows[rows.length - 1].t;
    const tSpan = t1 - t0 || 1;
    let peak = 0;
    for (const row of rows) for (const key of config.keys) peak = Math.max(peak, row[key]);
    const steps = 4;
    const { max: yMax } = niceScale(peak, steps);

    // Reserve the gutters the labels actually need, so nothing is clipped:
    // left for the widest y tick, right for the direct end-labels.
    const tickWidth = numberFmt.format(yMax).length * 6.4;
    const endWidth = Math.max(...config.keys.map((key) => numberFmt.format(rows[rows.length - 1][key]).length)) * 6.6;
    const pad = {
      top: 14,
      right: Math.ceil(endWidth) + 18,
      bottom: 26,
      left: Math.ceil(tickWidth) + 12,
    };
    const plotWidth = Math.max(10, width - pad.left - pad.right);
    const plotHeight = Math.max(10, height - pad.top - pad.bottom);

    const xOf = (t) => pad.left + ((t - t0) / tSpan) * plotWidth;
    const yOf = (v) => pad.top + plotHeight - (v / yMax) * plotHeight;

    // Gridlines: solid hairlines, one step off the surface, with the value ticks
    // that carry everything the direct labels do not.
    for (let i = 0; i <= steps; i += 1) {
      const value = (yMax / steps) * i;
      const y = yOf(value);
      node("line", { class: i === 0 ? "axis" : "grid", x1: pad.left, x2: pad.left + plotWidth, y1: y, y2: y }, svg);
      const label = node("text", { class: "tick", x: pad.left - 8, y: y + 3.5, "text-anchor": "end" }, svg);
      label.appendChild(document.createTextNode(numberFmt.format(Math.round(value))));
    }

    // X ticks: clock for a day-scale range, date beyond it.
    const useClock = tSpan <= 36 * 3600 * 1000;
    const tickCount = width < 520 ? 3 : 5;
    for (let i = 0; i <= tickCount; i += 1) {
      const t = t0 + (tSpan / tickCount) * i;
      const anchor = i === 0 ? "start" : i === tickCount ? "end" : "middle";
      const label = node("text", {
        class: "tick", x: xOf(t), y: pad.top + plotHeight + 16, "text-anchor": anchor,
      }, svg);
      label.appendChild(document.createTextNode((useClock ? clockFmt : dateFmt).format(new Date(t))));
    }

    for (const key of config.keys) {
      const d = rows
        .map((row, i) => `${i ? "L" : "M"}${xOf(row.t).toFixed(1)},${yOf(row[key]).toFixed(1)}`)
        .join(" ");
      node("path", { class: "line", d, stroke: SERIES[key].color }, svg);
    }

    // End marker + direct label: the last value never depends on the tooltip.
    const last = rows[rows.length - 1];
    const placed = [];
    for (const key of config.keys) {
      const cx = xOf(last.t);
      const cy = yOf(last[key]);
      node("circle", { class: "ring", cx, cy, r: 4, fill: SERIES[key].color }, svg);

      let labelY = cy + 4;
      while (placed.some((y) => Math.abs(y - labelY) < 13)) labelY += 13;
      labelY = Math.min(Math.max(labelY, pad.top + 10), pad.top + plotHeight);
      placed.push(labelY);
      const label = node("text", { class: "end-label", x: cx + 9, y: labelY }, svg);
      label.appendChild(document.createTextNode(numberFmt.format(last[key])));
    }

    // Crosshair layer: the reader aims at a time, not at a 2px line.
    const crosshair = node("line", {
      class: "crosshair", y1: pad.top, y2: pad.top + plotHeight, x1: 0, x2: 0, opacity: 0,
    }, svg);
    const markers = config.keys.map((key) =>
      node("circle", { class: "ring", r: 4.5, fill: SERIES[key].color, opacity: 0, cx: 0, cy: 0 }, svg));

    const findIndex = (clientX) => {
      const box = svg.getBoundingClientRect();
      const x = ((clientX - box.left) / box.width) * width;
      const t = t0 + ((x - pad.left) / plotWidth) * tSpan;
      let best = 0;
      let bestGap = Infinity;
      for (let i = 0; i < rows.length; i += 1) {
        const gap = Math.abs(rows[i].t - t);
        if (gap < bestGap) { bestGap = gap; best = i; }
      }
      return best;
    };

    const show = (index) => {
      const row = rows[index];
      const x = xOf(row.t);
      crosshair.setAttribute("x1", x);
      crosshair.setAttribute("x2", x);
      crosshair.setAttribute("opacity", 1);
      config.keys.forEach((key, i) => {
        markers[i].setAttribute("cx", x);
        markers[i].setAttribute("cy", yOf(row[key]));
        markers[i].setAttribute("opacity", 1);
      });

      tip.textContent = "";
      const time = document.createElement("div");
      time.className = "tooltip__time";
      time.textContent = timeFmt.format(new Date(row.t));
      tip.appendChild(time);
      for (const key of config.keys) {
        const line = document.createElement("div");
        line.className = "tooltip__row";
        const swatch = document.createElement("span");
        swatch.className = "tooltip__key";
        swatch.style.setProperty("--key-color", SERIES[key].color);
        const value = document.createElement("span");
        value.className = "tooltip__value";
        value.textContent = numberFmt.format(row[key]);
        const name = document.createElement("span");
        name.className = "tooltip__name";
        name.textContent = SERIES[key].name;
        line.append(swatch, value, name);
        tip.appendChild(line);
      }

      tip.dataset.open = "true";
      const scale = (svg.getBoundingClientRect().width || width) / width;
      const tipWidth = tip.offsetWidth;
      const left = Math.min(
        Math.max(x * scale - tipWidth / 2, 4),
        (svg.getBoundingClientRect().width || width) - tipWidth - 4,
      );
      tip.style.left = `${left + svg.offsetLeft}px`;
      tip.style.top = `${svg.offsetTop + 8}px`;
      state.hoverIndex = index;
    };

    const hide = () => {
      crosshair.setAttribute("opacity", 0);
      markers.forEach((marker) => marker.setAttribute("opacity", 0));
      tip.dataset.open = "false";
    };

    svg.addEventListener("pointermove", (event) => show(findIndex(event.clientX)));
    svg.addEventListener("pointerleave", hide);
    svg.addEventListener("focus", () => show(rows.length - 1));
    svg.addEventListener("blur", hide);
    svg.addEventListener("keydown", (event) => {
      const current = state.hoverIndex ?? rows.length - 1;
      if (event.key === "ArrowLeft") { show(Math.max(0, current - 1)); event.preventDefault(); }
      if (event.key === "ArrowRight") { show(Math.min(rows.length - 1, current + 1)); event.preventDefault(); }
      if (event.key === "Escape") hide();
    });
  }

  /* ---------------- table view ---------------- */

  const TABLE_KEYS = ["k", "c", "n", "p"];
  const TABLE_LIMIT = 500;

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

      for (const key of TABLE_KEYS) {
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

    el("table-count").textContent = `${numberFmt.format(rows.length)} įrašų per ${RANGE_LABELS[state.hours]}`;
    el("table-note").textContent = rows.length > shown
      ? `Rodomi paskutiniai ${shown}. Visa istorija — CSV failuose docs/data/.`
      : "";
  }

  /* ---------------- orchestration ---------------- */

  function renderAll() {
    const rows = rowsInRange();
    const content = el("content");
    const placeholder = el("placeholder");

    if (!rows.length) {
      content.classList.add("hidden");
      placeholder.classList.remove("hidden");
      el("placeholder-text").textContent = state.rows.length
        ? "Pasirinktu laikotarpiu įrašų nėra — pabandykite platesnį laikotarpį."
        : "Kol kas nėra nė vieno įrašo.";
      return;
    }

    placeholder.classList.add("hidden");
    content.classList.remove("hidden");

    renderTiles(rows);
    for (const config of CHARTS) {
      renderLegend(config.legend, config.keys);
      renderChart(config, rows);
    }
    if (state.tableOpen) renderTable(rows);

    const last = state.rows[state.rows.length - 1];
    const meta = el("freshness");
    meta.textContent = "";
    meta.append(
      document.createTextNode("atnaujinta "),
      Object.assign(document.createElement("b"), { textContent: ago(Date.now() - last.t) }),
      document.createTextNode(` · ${timeFmt.format(new Date(last.t))}`),
    );
  }

  async function refresh({ quiet = false } = {}) {
    const content = el("content");
    if (!quiet) content.classList.add("loading");
    try {
      state.index = await loadIndex();
      await ensureMonths(monthsForRange(state.index, state.hours));
      renderAll();
    } catch (error) {
      if (!state.rows.length) {
        el("content").classList.add("hidden");
        el("placeholder").classList.remove("hidden");
        el("placeholder-text").textContent =
          "Duomenų dar nėra. Paleiskite rinkiklį: python collector/collect.py";
      }
      console.error(error);
    } finally {
      content.classList.remove("loading");
    }
  }

  /* ---------------- wiring ---------------- */

  function selectRange(hours, { push = true } = {}) {
    state.hours = hours;
    for (const button of el("range-picker").querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.hours) === hours));
    }
    // The range lives in the hash, so a view can be linked to.
    if (push) history.replaceState(null, "", `#range=${hours}`);
    refresh({ quiet: true });
  }

  el("range-picker").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-hours]");
    if (button) selectRange(Number(button.dataset.hours));
  });

  el("table-toggle").addEventListener("click", () => {
    state.tableOpen = !state.tableOpen;
    el("table-card").classList.toggle("hidden", !state.tableOpen);
    el("table-toggle").setAttribute("aria-expanded", String(state.tableOpen));
    el("table-toggle").textContent = state.tableOpen ? "Slėpti lentelę" : "Rodyti lentelę";
    if (state.tableOpen) renderTable(rowsInRange());
  });

  el("theme-toggle").addEventListener("click", () => {
    const prefersDark = window.matchMedia("(prefers-color-scheme: dark)").matches;
    const current = document.documentElement.dataset.theme || (prefersDark ? "dark" : "light");
    const next = current === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    try { localStorage.setItem("eso-theme", next); } catch { /* private mode */ }
    renderAll();
  });

  try {
    const saved = localStorage.getItem("eso-theme");
    if (saved) document.documentElement.dataset.theme = saved;
  } catch { /* private mode */ }

  el("tz-note").textContent = TZ.replace("_", " ");

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.rows.length) renderAll(); }, 150);
  });

  const fromHash = /^#range=(\d+)$/.exec(location.hash);
  if (fromHash && RANGE_LABELS[Number(fromHash[1])] !== undefined) {
    selectRange(Number(fromHash[1]), { push: false });
  } else {
    refresh();
  }
  setInterval(() => refresh({ quiet: true }), REFRESH_MS);
})();
