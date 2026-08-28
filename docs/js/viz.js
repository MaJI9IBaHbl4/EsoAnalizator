/* Drawing primitives shared by both tabs: deltas, sparklines, legends, the
   line chart and the matrix heatmap. Nothing here knows which tab it serves. */

(function (ESO) {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const { SERIES, numberFmt, decimate, state } = ESO.core;

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

  /**
   * Fills `host` with an arrow, the direction spelled out for screen readers,
   * and the magnitude. The arrow is a second channel beside colour, so
   * direction survives colour blindness, greyscale print and forced-colors.
   */
  function fillDelta(host, change, suffix = "", format = numberFmt.format) {
    if (change === 0 || change === null || Number.isNaN(change)) {
      host.classList.add("delta--flat");
      host.textContent = change === 0 && suffix ? `be pokyčių ${suffix}` : "–";
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

    const amount = format(Math.abs(change));
    host.append(arrow, spoken, document.createTextNode(suffix ? `${amount} ${suffix}` : amount));
    return host;
  }

  function sparkline(rows, key, color) {
    const width = 84;
    const height = 26;
    const svg = node("svg", {
      class: "spark", width, height, viewBox: `0 0 ${width} ${height}`, "aria-hidden": "true",
    });
    const points = decimate(rows).map((row) => row[key]).filter((v) => v !== null);
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

  /** A legend is always present for two or more series; one series needs none. */
  function renderLegend(host, keys, extra = []) {
    host.textContent = "";
    if (keys.length + extra.length < 2) return;
    for (const key of keys) {
      const item = document.createElement("span");
      item.className = "legend__item";
      const swatch = document.createElement("span");
      swatch.className = "legend__key";
      swatch.style.setProperty("--key-color", SERIES[key].color);
      item.append(swatch, document.createTextNode(SERIES[key].name));
      host.appendChild(item);
    }
    for (const entry of extra) {
      const item = document.createElement("span");
      item.className = "legend__item";
      const swatch = document.createElement("span");
      swatch.className = entry.band ? "legend__band" : "legend__key";
      swatch.style.setProperty("--key-color", entry.color);
      item.append(swatch, document.createTextNode(entry.name));
      host.appendChild(item);
    }
  }

  /* ---------------- line chart ---------------- */

  /**
   * One line per key over time, with an optional min-max band, a crosshair that
   * snaps to the nearest reading and keyboard stepping. `rows` may contain
   * nulls: a gap in the data is drawn as a gap, never bridged.
   */
  function lineChart(options) {
    const {
      svg, tip, rows, keys,
      band = false,
      tickFormat,
      pointLabel,
      valueFormat = (v) => numberFmt.format(Math.round(v)),
      emptyText = "Per mažai taškų grafikui",
      height: fixedHeight,
    } = options;

    svg.textContent = "";
    if (tip) tip.dataset.open = "false";

    const width = svg.clientWidth || svg.parentElement.clientWidth || 800;
    const height = fixedHeight || Math.max(210, Math.min(320, Math.round(width * 0.32)));
    svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
    svg.setAttribute("height", height);

    const usable = rows.filter((row) => keys.some((key) => row[key] !== null));
    if (usable.length < 2) {
      node("text", { x: width / 2, y: height / 2, "text-anchor": "middle" }, svg)
        .appendChild(document.createTextNode(emptyText));
      return;
    }

    const t0 = rows[0].t;
    const t1 = rows[rows.length - 1].t;
    const tSpan = t1 - t0 || 1;

    let peak = 0;
    for (const row of rows) {
      for (const key of keys) {
        const candidates = band ? [row[key], row[`${key}_max`]] : [row[key]];
        for (const value of candidates) if (value !== null && value > peak) peak = value;
      }
    }
    const steps = 4;
    const { max: yMax } = niceScale(peak, steps);

    // Reserve the gutters the labels actually need, so nothing is clipped:
    // left for the widest y tick, right for the direct end-labels.
    const lastPoint = usable[usable.length - 1];
    const tickWidth = valueFormat(yMax).length * 6.4;
    const endWidth = Math.max(...keys.map((key) =>
      (lastPoint[key] === null ? 1 : valueFormat(lastPoint[key]).length))) * 6.6;
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

    // Gridlines: solid hairlines, one step off the surface, carrying the values
    // the direct labels do not.
    for (let i = 0; i <= steps; i += 1) {
      const value = (yMax / steps) * i;
      const y = yOf(value);
      node("line", {
        class: i === 0 ? "axis" : "grid", x1: pad.left, x2: pad.left + plotWidth, y1: y, y2: y,
      }, svg);
      node("text", { class: "tick", x: pad.left - 8, y: y + 3.5, "text-anchor": "end" }, svg)
        .appendChild(document.createTextNode(valueFormat(value)));
    }

    const tickCount = width < 520 ? 3 : 5;
    for (let i = 0; i <= tickCount; i += 1) {
      const t = t0 + (tSpan / tickCount) * i;
      const anchor = i === 0 ? "start" : i === tickCount ? "end" : "middle";
      node("text", {
        class: "tick", x: xOf(t), y: pad.top + plotHeight + 16, "text-anchor": anchor,
      }, svg).appendChild(document.createTextNode(tickFormat(t)));
    }

    // The band goes down first: it is context behind the line, not a mark of
    // its own, so it never covers the value the reader came for.
    if (band) {
      for (const key of keys) {
        const runs = splitRuns(rows, (row) => row[`${key}_min`]);
        for (const run of runs) {
          if (run.length < 2) continue;
          const top = run.map((row) => `${xOf(row.t).toFixed(1)},${yOf(row[`${key}_max`]).toFixed(1)}`);
          const bottom = run.slice().reverse()
            .map((row) => `${xOf(row.t).toFixed(1)},${yOf(row[`${key}_min`]).toFixed(1)}`);
          node("path", {
            class: "band", d: `M${top.join("L")}L${bottom.join("L")}Z`, fill: SERIES[key].color,
          }, svg);
        }
      }
    }

    for (const key of keys) {
      for (const run of splitRuns(rows, (row) => row[key])) {
        if (run.length === 1) {
          node("circle", {
            cx: xOf(run[0].t), cy: yOf(run[0][key]), r: 2.5, fill: SERIES[key].color,
          }, svg);
          continue;
        }
        const d = run
          .map((row, i) => `${i ? "L" : "M"}${xOf(row.t).toFixed(1)},${yOf(row[key]).toFixed(1)}`)
          .join(" ");
        node("path", { class: "line", d, stroke: SERIES[key].color }, svg);
      }
    }

    // End marker + direct label: the last value never depends on the tooltip.
    const placed = [];
    for (const key of keys) {
      if (lastPoint[key] === null) continue;
      const cx = xOf(lastPoint.t);
      const cy = yOf(lastPoint[key]);
      node("circle", { class: "ring", cx, cy, r: 4, fill: SERIES[key].color }, svg);

      let labelY = cy + 4;
      while (placed.some((y) => Math.abs(y - labelY) < 13)) labelY += 13;
      // Converging series: nudging labels apart until they pile up at the
      // baseline reads as noise and detaches each from its line. Drop the ones
      // that no longer fit - the dot keeps identity, the tooltip keeps values.
      if (labelY > pad.top + plotHeight + 4) continue;
      labelY = Math.max(labelY, pad.top + 10);
      placed.push(labelY);
      node("text", { class: "end-label", x: cx + 9, y: labelY }, svg)
        .appendChild(document.createTextNode(valueFormat(lastPoint[key])));
    }

    if (!tip) return;

    // Crosshair layer: the reader aims at a time, not at a 2px line.
    const crosshair = node("line", {
      class: "crosshair", y1: pad.top, y2: pad.top + plotHeight, x1: 0, x2: 0, opacity: 0,
    }, svg);
    const markers = keys.map((key) =>
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
      keys.forEach((key, i) => {
        if (row[key] === null) {
          markers[i].setAttribute("opacity", 0);
          return;
        }
        markers[i].setAttribute("cx", x);
        markers[i].setAttribute("cy", yOf(row[key]));
        markers[i].setAttribute("opacity", 1);
      });

      tip.textContent = "";
      const header = document.createElement("div");
      header.className = "tooltip__time";
      header.textContent = pointLabel(row);
      tip.appendChild(header);

      for (const key of keys) {
        const line = document.createElement("div");
        line.className = "tooltip__row";
        const swatch = document.createElement("span");
        swatch.className = "tooltip__key";
        swatch.style.setProperty("--key-color", SERIES[key].color);
        const value = document.createElement("span");
        value.className = "tooltip__value";
        value.textContent = row[key] === null ? "–" : valueFormat(row[key]);
        const name = document.createElement("span");
        name.className = "tooltip__name";
        name.textContent = SERIES[key].name;
        line.append(swatch, value, name);
        tip.appendChild(line);

        if (band && row[`${key}_min`] !== null && row[`${key}_min`] !== undefined) {
          const range = document.createElement("div");
          range.className = "tooltip__range";
          range.textContent =
            `${valueFormat(row[`${key}_min`])} – ${valueFormat(row[`${key}_max`])}`;
          tip.appendChild(range);
        }
      }

      if (row.count !== undefined) {
        const note = document.createElement("div");
        note.className = "tooltip__range";
        note.textContent = `${numberFmt.format(row.count)} nuskaitymai`;
        tip.appendChild(note);
      }

      tip.dataset.open = "true";
      const boxWidth = svg.getBoundingClientRect().width || width;
      const scale = boxWidth / width;
      const left = Math.min(
        Math.max(x * scale - tip.offsetWidth / 2, 4),
        boxWidth - tip.offsetWidth - 4,
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

    // Capture on touch: the finger keeps driving the crosshair even when it
    // strays off the plot, and the reading stays up after it lifts - lifting
    // is how you read the number on a phone.
    svg.addEventListener("pointerdown", (event) => {
      if (event.pointerType === "mouse") return;
      // Capturing can throw if the pointer is already gone; the crosshair
      // still has to appear.
      try { svg.setPointerCapture(event.pointerId); } catch { /* released */ }
      show(findIndex(event.clientX));
    });
    svg.addEventListener("pointermove", (event) => show(findIndex(event.clientX)));
    svg.addEventListener("pointerleave", (event) => {
      if (event.pointerType === "mouse") hide();
    });
    svg.addEventListener("pointercancel", hide);
    svg.addEventListener("focus", () => show(rows.length - 1));
    svg.addEventListener("blur", hide);
    svg.addEventListener("keydown", (event) => {
      const current = state.hoverIndex ?? rows.length - 1;
      if (event.key === "ArrowLeft") { show(Math.max(0, current - 1)); event.preventDefault(); }
      if (event.key === "ArrowRight") { show(Math.min(rows.length - 1, current + 1)); event.preventDefault(); }
      if (event.key === "Escape") hide();
    });
  }

  /** Split into runs of consecutive non-null points, so gaps stay gaps. */
  function splitRuns(rows, valueOf) {
    const runs = [];
    let run = [];
    for (const row of rows) {
      if (valueOf(row) === null || valueOf(row) === undefined) {
        if (run.length) runs.push(run);
        run = [];
      } else {
        run.push(row);
      }
    }
    if (run.length) runs.push(run);
    return runs;
  }

  /* ---------------- matrix heatmap ---------------- */

  const HEAT_STEPS = 7;

  function heatRamp() {
    const styles = getComputedStyle(document.documentElement);
    return Array.from({ length: HEAT_STEPS }, (_, i) =>
      styles.getPropertyValue(`--heat-${i}`).trim() || "#cde2fb");
  }

  /**
   * Cross-tab rendered as a table: one hue, light to dark, so the eye reads
   * magnitude and not identity. Empty cells stay blank - "never measured" is
   * not the same as zero.
   */
  function heatmap(host, data, options) {
    const { format, legendHost, metricName } = options;
    host.textContent = "";

    if (!data.values.size) {
      const empty = document.createElement("p");
      empty.className = "empty";
      empty.textContent = "Pasirinktu laikotarpiu duomenų nepakanka.";
      host.appendChild(empty);
      if (legendHost) legendHost.textContent = "";
      return;
    }

    const ramp = heatRamp();
    const span = data.max - data.min || 1;
    const table = document.createElement("table");
    table.className = "heat";

    const head = document.createElement("thead");
    const headRow = document.createElement("tr");
    const corner = document.createElement("th");
    corner.scope = "col";
    corner.textContent = data.rowTitle;
    headRow.appendChild(corner);
    for (const col of data.colKeys) {
      const th = document.createElement("th");
      th.scope = "col";
      th.textContent = data.colLabel(col);
      headRow.appendChild(th);
    }
    head.appendChild(headRow);
    table.appendChild(head);

    const body = document.createElement("tbody");
    for (const rowKey of data.rowKeys) {
      const tr = document.createElement("tr");
      const th = document.createElement("th");
      th.scope = "row";
      th.textContent = data.rowLabel(rowKey);
      tr.appendChild(th);

      for (const colKey of data.colKeys) {
        const cell = data.get(rowKey, colKey);
        const td = document.createElement("td");
        if (cell) {
          const level = Math.min(HEAT_STEPS - 1,
            Math.floor(((cell.value - data.min) / span) * HEAT_STEPS));
          td.style.background = ramp[level];
          // Ink flips on the dark half of the ramp so the number always clears.
          td.classList.add(level >= HEAT_STEPS - 3 ? "heat--deep" : "heat--shallow");
          td.textContent = format(cell.value);
          td.title = `${data.rowLabel(rowKey)} · ${data.colLabel(colKey)}\n`
            + `${metricName}: ${format(cell.value)}\n${cell.count} nuskaitymai`;
        } else {
          td.className = "heat--none";
        }
        tr.appendChild(td);
      }
      body.appendChild(tr);
    }
    table.appendChild(body);
    host.appendChild(table);

    if (legendHost) renderHeatLegend(legendHost, data, ramp, format);
  }

  /** A sequential scale is unreadable without its legend. */
  function renderHeatLegend(host, data, ramp, format) {
    host.textContent = "";

    const low = document.createElement("span");
    low.className = "heat-legend__end";
    low.textContent = format(data.min);

    const scale = document.createElement("span");
    scale.className = "heat-legend__scale";
    scale.setAttribute("aria-hidden", "true");
    for (const color of ramp) {
      const step = document.createElement("span");
      step.style.background = color;
      scale.appendChild(step);
    }

    const high = document.createElement("span");
    high.className = "heat-legend__end";
    high.textContent = format(data.max);

    host.append(low, scale, high);
  }

  ESO.viz = { node, niceScale, fillDelta, sparkline, renderLegend, lineChart, heatmap };
})(window.ESO);
