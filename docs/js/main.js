/* Boot, tabs and the refresh loop. Both tabs read the same period filter and
   the same loaded rows; switching tabs never refetches. */

(function (ESO) {
  "use strict";

  const {
    TZ, RANGE_LABELS, timeFmt, ago, state, el,
    loadIndex, monthsForRange, ensureMonths, rowsInRange, rowsInPreviousRange,
  } = ESO.core;

  const REFRESH_MS = 5 * 60 * 1000;

  function setTab(tab, { push = true } = {}) {
    state.tab = tab;
    for (const button of el("tabs").querySelectorAll("button[data-tab]")) {
      button.setAttribute("aria-selected", String(button.dataset.tab === tab));
    }
    el("tab-overview").classList.toggle("hidden", tab !== "overview");
    el("tab-detail").classList.toggle("hidden", tab !== "detail");
    for (const node of document.querySelectorAll(".overview-only")) {
      node.classList.toggle("hidden", tab !== "overview");
    }
    for (const node of document.querySelectorAll(".detail-only")) {
      node.classList.toggle("hidden", tab !== "detail");
    }
    if (push) writeHash();
    renderAll();
  }

  function writeHash() {
    history.replaceState(null, "", `#tab=${state.tab}&range=${state.hours}`);
  }

  function selectRange(hours, { push = true } = {}) {
    state.hours = hours;
    for (const button of el("range-picker").querySelectorAll("button")) {
      button.setAttribute("aria-pressed", String(Number(button.dataset.hours) === hours));
    }
    if (push) writeHash();
    refresh({ quiet: true });
  }

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

    if (state.tab === "overview") ESO.overview.render(rows);
    else ESO.detail.render(rows, rowsInPreviousRange());

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
      // The comparison view needs the period before the selected one, so pull
      // twice the range rather than exactly it.
      const span = state.hours ? state.hours * 2 : 0;
      await ensureMonths(monthsForRange(state.index, span));
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

  el("tabs").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-tab]");
    if (button) setTab(button.dataset.tab);
  });

  el("range-picker").addEventListener("click", (event) => {
    const button = event.target.closest("button[data-hours]");
    if (button) selectRange(Number(button.dataset.hours));
  });

  el("table-toggle").addEventListener("click", () => {
    state.tableOpen = !state.tableOpen;
    el("table-card").classList.toggle("hidden", !state.tableOpen);
    el("table-toggle").setAttribute("aria-expanded", String(state.tableOpen));
    el("table-toggle").textContent = state.tableOpen ? "Slėpti lentelę" : "Rodyti lentelę";
    if (state.tableOpen) ESO.overview.renderTable(rowsInRange());
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

  ESO.detail.setup(renderAll);

  let resizeTimer;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (state.rows.length) renderAll(); }, 150);
  });

  const hash = new URLSearchParams(location.hash.replace(/^#/, ""));
  const hashRange = Number(hash.get("range"));
  const hashTab = hash.get("tab");
  if (RANGE_LABELS[hashRange] !== undefined) state.hours = hashRange;
  for (const button of el("range-picker").querySelectorAll("button")) {
    button.setAttribute("aria-pressed", String(Number(button.dataset.hours) === state.hours));
  }
  setTab(hashTab === "detail" ? "detail" : "overview", { push: false });
  refresh();
  setInterval(() => refresh({ quiet: true }), REFRESH_MS);
})(window.ESO);
