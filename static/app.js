(() => {
  "use strict";

  const grid = document.getElementById("grid");
  const errorBox = document.getElementById("error");
  const emptyBox = document.getElementById("empty");
  const updated = document.getElementById("updated");
  const statRunning = document.getElementById("stat-running");
  const statTotal = document.getElementById("stat-total");
  const refreshBtn = document.getElementById("refresh");

  const REFRESH_MS = 5000;

  // Status -> css modifier + label
  const STATUS_INFO = {
    running: { cls: "running", group: "s-running", spine: "is-running", label: "online" },
    restarting: { cls: "restarting", group: "s-warn", spine: "is-warn", label: "restarting" },
    paused: { cls: "paused", group: "s-warn", spine: "is-warn", label: "paused" },
    removing: { cls: "removing", group: "s-warn", spine: "is-warn", label: "removing" },
    exited: { cls: "exited", group: "s-stopped", spine: "is-stopped", label: "offline" },
    dead: { cls: "dead", group: "s-stopped", spine: "is-stopped", label: "dead" },
    created: { cls: "created", group: "s-stopped", spine: "is-stopped", label: "created" },
  };

  function escapeHtml(str) {
    return String(str).replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    }[c]));
  }

  function buildUrl(c) {
    if (c.url_override) return c.url_override;
    if (c.link_port) {
      const host = window.location.hostname;
      return `${c.scheme || "http"}://${host}:${c.link_port}`;
    }
    return null;
  }

  function statusInfo(c) {
    return STATUS_INFO[c.status] || { cls: "exited", group: "s-stopped", spine: "is-stopped", label: c.status };
  }

  // Inner HTML of a card (without the <article> wrapper).
  function cardInner(c) {
    const info = statusInfo(c);
    const url = buildUrl(c);
    const icon = c.icon ? escapeHtml(c.icon) : (info.cls === "running" ? "◆" : "◇");

    const ports = (c.ports || []).map((p) => `<span class="port-chip">:${p}</span>`).join("");

    let health = "";
    if (c.health) {
      health = `<span class="health ${escapeHtml(c.health)}">${escapeHtml(c.health)}</span>`;
    }

    let button;
    if (url) {
      button = `<a class="open-btn" href="${escapeHtml(url)}" target="_blank" rel="noopener">Открыть ↗</a>`;
    } else {
      button = `<span class="open-btn disabled">нет порта</span>`;
    }

    const running = c.status === "running";
    const controls = c.is_self
      ? `<div class="controls"><span class="ctl-self">это дашборд</span></div>`
      : `<div class="controls">
           <button class="ctl ctl-start" data-act="start" ${running ? "disabled" : ""} title="Запустить">▶</button>
           <button class="ctl ctl-restart" data-act="restart" ${running ? "" : "disabled"} title="Перезапустить">⟳</button>
           <button class="ctl ctl-stop" data-act="stop" ${running ? "" : "disabled"} title="Остановить">■</button>
         </div>`;

    return `
      <div class="card-head">
        <div class="icon">${icon}</div>
        <div class="title-wrap">
          <div class="title">${escapeHtml(c.name)}</div>
          <div class="subtitle">${escapeHtml(c.image)}</div>
        </div>
        ${controls}
      </div>
      <div class="status-row ${info.group}">
        <span class="status-dot ${info.cls}"></span>
        <span>${escapeHtml(info.label)}</span>
        ${health}
      </div>
      ${ports ? `<div class="ports">${ports}</div>` : ""}
      ${button}`;
  }

  // id -> { el, hash }  — lets us touch the DOM only when data actually changed.
  const cards = new Map();

  function applySpine(el, c) {
    const spine = statusInfo(c).spine;
    el.classList.remove("is-running", "is-warn", "is-stopped");
    el.classList.add(spine);
  }

  function render(containers) {
    const running = containers.filter((c) => c.status === "running").length;
    statRunning.textContent = `${running} online`;
    statTotal.textContent = `${containers.length} units`;
    emptyBox.classList.toggle("hidden", containers.length > 0);

    const seen = new Set();

    // Add new / update changed cards.
    for (const c of containers) {
      seen.add(c.id);
      const hash = JSON.stringify(c);
      let entry = cards.get(c.id);

      if (!entry) {
        const el = document.createElement("article");
        el.className = "card enter";
        el.dataset.id = c.id;
        el.innerHTML = cardInner(c);
        applySpine(el, c);
        grid.appendChild(el);
        cards.set(c.id, { el, hash });
      } else if (entry.hash !== hash) {
        entry.el.innerHTML = cardInner(c);
        applySpine(entry.el, c);
        entry.hash = hash;
      }
    }

    // Remove cards for containers that disappeared.
    for (const [id, entry] of cards) {
      if (!seen.has(id)) {
        entry.el.remove();
        cards.delete(id);
      }
    }

    // Reorder DOM to match the new order. appendChild moves existing nodes
    // without re-triggering the enter animation, so there's no flicker.
    let prev = null;
    for (const c of containers) {
      const entry = cards.get(c.id);
      if (!entry) continue;
      const expected = prev ? prev.nextSibling : grid.firstChild;
      if (entry.el !== expected) {
        grid.insertBefore(entry.el, expected);
      }
      prev = entry.el;
    }
  }

  async function load() {
    try {
      const res = await fetch("/api/containers", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      errorBox.classList.add("hidden");
      render(data.containers || []);
      updated.textContent = `обновлено ${new Date().toLocaleTimeString("ru-RU")}`;
    } catch (err) {
      errorBox.textContent = `Ошибка получения данных от Docker: ${err.message}`;
      errorBox.classList.remove("hidden");
      updated.textContent = "ошибка соединения";
    }
  }

  async function doAction(id, action, btn) {
    const card = btn.closest(".card");
    card.querySelectorAll(".ctl").forEach((b) => (b.disabled = true));
    btn.classList.add("busy");
    try {
      const res = await fetch(`/api/containers/${id}/${action}`, { method: "POST" });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      errorBox.classList.add("hidden");
    } catch (err) {
      errorBox.textContent = `Не удалось выполнить «${action}»: ${err.message}`;
      errorBox.classList.remove("hidden");
    } finally {
      btn.classList.remove("busy");
      setTimeout(load, 600);
    }
  }

  grid.addEventListener("click", (e) => {
    const btn = e.target.closest(".ctl");
    if (!btn || btn.disabled) return;
    const card = btn.closest(".card");
    if (!card) return;
    doAction(card.dataset.id, btn.dataset.act, btn);
  });

  refreshBtn.addEventListener("click", () => {
    refreshBtn.classList.add("spin");
    setTimeout(() => refreshBtn.classList.remove("spin"), 450);
    load();
  });

  // --- Boot intro ---------------------------------------------------
  const intro = document.getElementById("intro");
  if (intro) {
    let ended = false;
    const endIntro = () => {
      if (ended) return;
      ended = true;
      intro.classList.add("intro-done");
      setTimeout(() => intro.remove(), 650);
    };
    const auto = setTimeout(endIntro, 4000);
    intro.addEventListener("click", () => {
      clearTimeout(auto);
      endIntro();
    });
  }

  load();
  setInterval(load, REFRESH_MS);
})();
