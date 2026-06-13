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

  // Status -> css modifier + russian label
  const STATUS_INFO = {
    running: { cls: "running", group: "s-running", label: "running" },
    restarting: { cls: "restarting", group: "s-warn", label: "restarting" },
    paused: { cls: "paused", group: "s-warn", label: "paused" },
    removing: { cls: "removing", group: "s-warn", label: "removing" },
    exited: { cls: "exited", group: "s-stopped", label: "stopped" },
    dead: { cls: "dead", group: "s-stopped", label: "dead" },
    created: { cls: "created", group: "s-stopped", label: "created" },
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

  function cardHtml(c) {
    const info = STATUS_INFO[c.status] || { cls: "exited", group: "s-stopped", label: c.status };
    const url = buildUrl(c);

    const icon = c.icon
      ? escapeHtml(c.icon)
      : (info.cls === "running" ? "◆" : "◇");

    const ports = (c.ports || []).map(
      (p) => `<span class="port-chip">:${p}</span>`
    ).join("");

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

    // Control buttons (start/stop/restart). Disabled for the dashboard itself.
    const running = c.status === "running";
    const controls = c.is_self
      ? `<div class="controls"><span class="ctl-self">это дашборд</span></div>`
      : `<div class="controls">
           <button class="ctl ctl-start" data-act="start" ${running ? "disabled" : ""} title="Запустить">▶</button>
           <button class="ctl ctl-restart" data-act="restart" ${running ? "" : "disabled"} title="Перезапустить">⟳</button>
           <button class="ctl ctl-stop" data-act="stop" ${running ? "" : "disabled"} title="Остановить">■</button>
         </div>`;

    return `
      <article class="card" data-id="${escapeHtml(c.id)}">
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
        ${button}
      </article>`;
  }

  function render(containers) {
    if (!containers.length) {
      grid.innerHTML = "";
      emptyBox.classList.remove("hidden");
      statRunning.textContent = "0 running";
      statTotal.textContent = "0 total";
      return;
    }
    emptyBox.classList.add("hidden");

    const running = containers.filter((c) => c.status === "running").length;
    statRunning.textContent = `${running} running`;
    statTotal.textContent = `${containers.length} total`;

    grid.innerHTML = containers.map(cardHtml).join("");
  }

  async function load() {
    try {
      const res = await fetch("/api/containers", { cache: "no-store" });
      const data = await res.json();
      if (!res.ok || data.error) {
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      errorBox.classList.add("hidden");
      render(data.containers || []);
      const t = new Date().toLocaleTimeString("ru-RU");
      updated.textContent = `обновлено ${t}`;
    } catch (err) {
      errorBox.textContent = `Ошибка получения данных от Docker: ${err.message}`;
      errorBox.classList.remove("hidden");
      updated.textContent = "ошибка соединения";
    }
  }

  async function doAction(id, action, btn) {
    const card = btn.closest(".card");
    const buttons = card.querySelectorAll(".ctl");
    buttons.forEach((b) => (b.disabled = true));
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
      // Refresh shortly after so the new state is reflected.
      setTimeout(load, 600);
    }
  }

  // Event delegation for the per-card control buttons.
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

  load();
  setInterval(load, REFRESH_MS);
})();
