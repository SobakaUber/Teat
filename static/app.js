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

  // White-noise buffer of `dur` seconds.
  function makeNoise(ctx, dur) {
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
    return buf;
  }

  // Cinematic, dark cyberpunk boot — no chiptune beeps.
  function scheduleBoot(ctx) {
    const t0 = ctx.currentTime + 0.03;
    const IMPACT = 1.5; // when the logo lands

    // Compressor glues everything and prevents clipping.
    const comp = ctx.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.ratio.value = 4;
    comp.attack.value = 0.003;
    comp.release.value = 0.25;

    const master = ctx.createGain();
    master.gain.setValueAtTime(0.0001, t0);
    master.gain.linearRampToValueAtTime(0.72, t0 + 0.12);
    master.gain.setValueAtTime(0.72, t0 + 2.7);
    master.gain.linearRampToValueAtTime(0.0001, t0 + 3.5);
    master.connect(comp).connect(ctx.destination);

    // 1) Dark drone bed: detuned saws through a slowly opening lowpass.
    const droneGain = ctx.createGain();
    droneGain.gain.setValueAtTime(0.0001, t0);
    droneGain.gain.exponentialRampToValueAtTime(0.16, t0 + 1.2);
    droneGain.gain.exponentialRampToValueAtTime(0.05, t0 + 2.2);
    droneGain.gain.exponentialRampToValueAtTime(0.0001, t0 + 3.3);
    const lp = ctx.createBiquadFilter();
    lp.type = "lowpass";
    lp.Q.value = 7;
    lp.frequency.setValueAtTime(110, t0);
    lp.frequency.linearRampToValueAtTime(460, t0 + 1.5);
    lp.connect(droneGain).connect(master);
    [55, 55.5, 110].forEach((f, i) => {
      const o = ctx.createOscillator();
      o.type = "sawtooth";
      o.frequency.value = f;
      o.detune.value = (i - 1) * 7;
      o.connect(lp);
      o.start(t0);
      o.stop(t0 + 3.4);
    });

    // 2) Riser: noise through a lowpass sweeping upward into the impact.
    const riser = ctx.createBufferSource();
    riser.buffer = makeNoise(ctx, IMPACT + 0.3);
    const rf = ctx.createBiquadFilter();
    rf.type = "lowpass";
    rf.Q.value = 9;
    rf.frequency.setValueAtTime(180, t0);
    rf.frequency.exponentialRampToValueAtTime(5200, t0 + IMPACT - 0.05);
    const rg = ctx.createGain();
    rg.gain.setValueAtTime(0.0001, t0);
    rg.gain.exponentialRampToValueAtTime(0.2, t0 + IMPACT - 0.1);
    rg.gain.exponentialRampToValueAtTime(0.0001, t0 + IMPACT + 0.25);
    riser.connect(rf).connect(rg).connect(master);
    riser.start(t0);

    // 3) Impact — deep sub boom.
    const boom = ctx.createOscillator();
    const bg = ctx.createGain();
    boom.type = "sine";
    boom.frequency.setValueAtTime(92, t0 + IMPACT);
    boom.frequency.exponentialRampToValueAtTime(34, t0 + IMPACT + 0.7);
    bg.gain.setValueAtTime(0.0001, t0 + IMPACT);
    bg.gain.exponentialRampToValueAtTime(0.95, t0 + IMPACT + 0.05);
    bg.gain.exponentialRampToValueAtTime(0.0001, t0 + IMPACT + 1.1);
    boom.connect(bg).connect(master);
    boom.start(t0 + IMPACT);
    boom.stop(t0 + IMPACT + 1.2);

    // 3b) Impact body — short lowpassed noise punch (not harsh).
    const hit = ctx.createBufferSource();
    hit.buffer = makeNoise(ctx, 0.5);
    const hf = ctx.createBiquadFilter();
    hf.type = "lowpass";
    hf.frequency.value = 2000;
    const hg = ctx.createGain();
    hg.gain.setValueAtTime(0.45, t0 + IMPACT);
    hg.gain.exponentialRampToValueAtTime(0.0001, t0 + IMPACT + 0.35);
    hit.connect(hf).connect(hg).connect(master);
    hit.start(t0 + IMPACT);

    // 4) Metallic tail — band-passed noise shimmer, dark and short.
    const tail = ctx.createBufferSource();
    tail.buffer = makeNoise(ctx, 1.3);
    const tf = ctx.createBiquadFilter();
    tf.type = "bandpass";
    tf.frequency.value = 1500;
    tf.Q.value = 1.8;
    const tg = ctx.createGain();
    tg.gain.setValueAtTime(0.0001, t0 + IMPACT + 0.05);
    tg.gain.exponentialRampToValueAtTime(0.06, t0 + IMPACT + 0.2);
    tg.gain.exponentialRampToValueAtTime(0.0001, t0 + IMPACT + 1.3);
    tail.connect(tf).connect(tg).connect(master);
    tail.start(t0 + IMPACT + 0.05);
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
  const SVGNS = "http://www.w3.org/2000/svg";

  // Build the repetitive HUD decorations (hatch rows, progress cells) so the
  // markup stays manageable. Elements fade in with staggered delays.
  function buildHud() {
    if (!intro) return;

    const addHatch = (groupId, y, x0, x1, baseDelay) => {
      const g = intro.querySelector("#" + groupId);
      if (!g) return;
      let i = 0;
      for (let x = x0; x <= x1; x += 16, i++) {
        let el;
        if (i % 7 === 3) {
          el = document.createElementNS(SVGNS, "rect");
          el.setAttribute("x", x); el.setAttribute("y", y - 5);
          el.setAttribute("width", 5); el.setAttribute("height", 5);
          el.setAttribute("fill", "var(--red)");
        } else {
          // alternating diagonal ticks
          const up = i % 2 === 0;
          el = document.createElementNS(SVGNS, "line");
          el.setAttribute("x1", x); el.setAttribute("y1", up ? y + 6 : y - 6);
          el.setAttribute("x2", x + 9); el.setAttribute("y2", up ? y - 6 : y + 6);
          el.setAttribute("stroke", "var(--red)"); el.setAttribute("stroke-width", "2");
        }
        el.setAttribute("class", "show");
        el.style.animationDelay = (baseDelay + i * 0.012) + "s";
        g.appendChild(el);
      }
    };

    addHatch("hudHatchTop", 140, 100, 500, 1.0);
    addHatch("hudHatchBot", 528, 90, 290, 1.0);
    addHatch("hudHatchBot", 528, 310, 510, 1.0);
    addHatch("hudHatchBot", 548, 90, 290, 1.1);
    addHatch("hudHatchBot", 548, 310, 510, 1.1);

    // progress cells fill left -> right
    const prog = intro.querySelector("#hudProgress");
    if (prog) {
      let i = 0;
      for (let x = 200; x <= 398; x += 8, i++) {
        const c = document.createElementNS(SVGNS, "rect");
        c.setAttribute("x", x); c.setAttribute("y", 484);
        c.setAttribute("width", 5); c.setAttribute("height", 11);
        c.setAttribute("fill", "var(--red)");
        c.setAttribute("class", "show");
        c.style.animationDelay = (0.95 + i * 0.03) + "s";
        prog.appendChild(c);
      }
    }
  }
  buildHud();

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
    const auto = setTimeout(endIntro, 5400);
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
