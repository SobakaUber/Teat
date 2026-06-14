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

  // --- Boot sound (synthesized, no external assets) -----------------
  let audioCtx;
  let bootPlayed = false;

  function scheduleBoot(ctx) {
    const t0 = ctx.currentTime + 0.02;
    const master = ctx.createGain();
    master.gain.value = 0.42;
    master.connect(ctx.destination);

    const env = (g, start, peak, attack, end) => {
      g.gain.setValueAtTime(0.0001, t0 + start);
      g.gain.exponentialRampToValueAtTime(peak, t0 + start + attack);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + end);
    };

    // Low rumble sweep (power-up).
    const o1 = ctx.createOscillator(), g1 = ctx.createGain();
    o1.type = "sine";
    o1.frequency.setValueAtTime(48, t0);
    o1.frequency.exponentialRampToValueAtTime(180, t0 + 1.4);
    env(g1, 0, 0.6, 0.3, 1.8);
    o1.connect(g1).connect(master); o1.start(t0); o1.stop(t0 + 1.9);

    // Digital saw sweep up.
    const o2 = ctx.createOscillator(), g2 = ctx.createGain(), f2 = ctx.createBiquadFilter();
    o2.type = "sawtooth";
    o2.frequency.setValueAtTime(120, t0 + 0.1);
    o2.frequency.exponentialRampToValueAtTime(900, t0 + 1.25);
    f2.type = "lowpass"; f2.frequency.value = 1400;
    env(g2, 0.1, 0.16, 0.4, 1.35);
    o2.connect(f2).connect(g2).connect(master); o2.start(t0 + 0.1); o2.stop(t0 + 1.4);

    // Glitch blips.
    [0.25, 0.43, 0.6, 0.82, 1.05, 1.22].forEach((bt) => {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = "square";
      o.frequency.value = 280 + Math.random() * 1200;
      g.gain.setValueAtTime(0.0001, t0 + bt);
      g.gain.exponentialRampToValueAtTime(0.11, t0 + bt + 0.004);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + bt + 0.06);
      o.connect(g).connect(master); o.start(t0 + bt); o.stop(t0 + bt + 0.07);
    });

    // Impact when the logo lands (~1.55s): boom + noise burst.
    const boom = ctx.createOscillator(), bg = ctx.createGain();
    boom.type = "sine";
    boom.frequency.setValueAtTime(170, t0 + 1.5);
    boom.frequency.exponentialRampToValueAtTime(42, t0 + 2.1);
    env(bg, 1.5, 0.7, 0.06, 2.3);
    boom.connect(bg).connect(master); boom.start(t0 + 1.5); boom.stop(t0 + 2.3);

    const dur = 0.4;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) {
      data[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / data.length, 2.2);
    }
    const noise = ctx.createBufferSource(), ng = ctx.createGain(), nf = ctx.createBiquadFilter();
    noise.buffer = buf; nf.type = "highpass"; nf.frequency.value = 700; ng.gain.value = 0.22;
    noise.connect(nf).connect(ng).connect(master); noise.start(t0 + 1.5);

    // High shimmer tail.
    const o3 = ctx.createOscillator(), g3 = ctx.createGain();
    o3.type = "triangle";
    o3.frequency.setValueAtTime(1700, t0 + 1.6);
    o3.frequency.exponentialRampToValueAtTime(2600, t0 + 2.4);
    env(g3, 1.6, 0.05, 0.2, 2.6);
    o3.connect(g3).connect(master); o3.start(t0 + 1.6); o3.stop(t0 + 2.6);
  }

  function playBoot() {
    if (bootPlayed) return;
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === "suspended") audioCtx.resume();
    // Browsers block audio until a user gesture; bail and retry on gesture.
    if (audioCtx.state !== "running") return;
    bootPlayed = true;
    scheduleBoot(audioCtx);
  }

  // --- Tap-to-start gate + boot intro -------------------------------
  const gate = document.getElementById("start-gate");
  const intro = document.getElementById("intro");

  let ended = false;
  const endIntro = () => {
    if (ended || !intro) return;
    ended = true;
    intro.classList.add("intro-done");
    setTimeout(() => intro.remove(), 650);
  };

  // Runs on the start tap: sound is now unlocked by the user gesture, and the
  // intro animations begin from zero the moment we remove `pending`.
  const startSequence = () => {
    playBoot();
    if (!intro) return;
    intro.classList.remove("pending");
    const auto = setTimeout(endIntro, 4200);
    intro.addEventListener("click", () => { clearTimeout(auto); endIntro(); }, { once: true });
  };

  if (gate) {
    let begun = false;
    const begin = () => {
      if (begun) return;
      begun = true;
      gate.classList.add("gate-out");
      startSequence();
      setTimeout(() => gate.remove(), 520);
    };
    gate.addEventListener("click", begin);
    window.addEventListener("keydown", begin, { once: true });
  } else {
    startSequence();
  }

  load();
  setInterval(load, REFRESH_MS);
})();
