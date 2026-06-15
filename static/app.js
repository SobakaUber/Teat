(() => {
  "use strict";

  const grid = document.getElementById("grid");
  const errorBox = document.getElementById("error");
  const emptyBox = document.getElementById("empty");
  const updated = document.getElementById("updated");
  const statRunning = document.getElementById("stat-running");
  const statTotal = document.getElementById("stat-total");
  const subStat = document.getElementById("subStat");
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

  // Human-readable uptime from seconds.
  function fmtUptime(s) {
    if (s == null) return "";
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (d > 0) return `${d}d ${h}h ${m}m`;
    if (h > 0) return `${h}h ${m}m`;
    return `${m}m ${s % 60}s`;
  }

  // Inner HTML of a card (without the <article> wrapper).
  function cardInner(c) {
    const info = statusInfo(c);
    const url = buildUrl(c);
    const icon = c.icon ? escapeHtml(c.icon) : (info.cls === "running" ? "◆" : "◇");

    const ports = (c.ports || []).map((p) => `<span class="port-chip">:${p}</span>`).join("");
    const up = fmtUptime(c.uptime);

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
      <div class="card-bar">
        <span class="card-idx">${escapeHtml(c.id)}</span>
        <span class="card-modtag">// container</span>
        <span class="card-bardot"></span>
      </div>
      <div class="card-head">
        <div class="icon">${icon}</div>
        <div class="title-wrap">
          <div class="title">${escapeHtml(c.name)}</div>
          <div class="subtitle">${escapeHtml(c.image)}</div>
        </div>
        ${controls}
      </div>
      <div class="card-rows">
        <div class="krow">
          <span class="k">Status</span>
          <span class="v ${info.group}"><span class="status-dot ${info.cls}"></span>${escapeHtml(info.label)}${health}</span>
        </div>
        <div class="krow">
          <span class="k">Uptime</span>
          <span class="v uptime-v">${up || "—"}</span>
        </div>
        ${ports ? `<div class="krow"><span class="k">Ports</span><span class="v">${ports}</span></div>` : ""}
      </div>
      ${button}`;
  }

  // id -> { el, hash }  — lets us touch the DOM only when data actually changed.
  const cards = new Map();
  let lastContainers = [];

  function applySpine(el, c) {
    const spine = statusInfo(c).spine;
    el.classList.remove("is-running", "is-warn", "is-stopped");
    el.classList.add(spine);
  }

  function render(containers) {
    lastContainers = containers;
    const running = containers.filter((c) => c.status === "running").length;
    statRunning.textContent = `${running} online`;
    statTotal.textContent = `${containers.length} units`;
    if (subStat) subStat.textContent = `${running} ONLINE / ${containers.length} TOTAL`;
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

  function ensureAudio() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    if (!audioCtx) audioCtx = new AC();
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx.state === "running" ? audioCtx : null;
  }

  // Short terminal "tick" played per printed boot line.
  let lastTick = 0;
  function tick(vol) {
    const ctx = audioCtx;
    if (!ctx || ctx.state !== "running") return;
    const now = ctx.currentTime;
    if (now - lastTick < 0.012) return; // throttle
    lastTick = now;
    const dur = 0.022;
    const buf = ctx.createBuffer(1, Math.floor(ctx.sampleRate * dur), ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / d.length, 3);
    const s = ctx.createBufferSource(); s.buffer = buf;
    const f = ctx.createBiquadFilter(); f.type = "bandpass"; f.frequency.value = 2200; f.Q.value = 1.1;
    const g = ctx.createGain(); g.gain.value = vol || 0.09;
    s.connect(f).connect(g).connect(ctx.destination); s.start(now);
  }

  // --- eDEX-style boot sequence -------------------------------------
  const gate = document.getElementById("start-gate");
  const intro = document.getElementById("intro");
  const bootlog = document.getElementById("bootlog");
  const bootFinal = document.getElementById("bootFinal");
  const bootflash = document.getElementById("bootflash");

  // Boot log: each entry is {t, s, d?} or {burst:n} or {t:'blank'}.
  const BOOT = [
    { t: "head", s: "UBER OS 2.34.2 (brainlink)" },
    { t: "info", s: "(c) 2026 UBER CORP — all rights reserved", d: 70 },
    { t: "blank" },
    { t: "info", s: "POST ... firmware rev 4.7" },
    { t: "ok", s: "CPU0: 16 cores @ 4.20GHz online" },
    { t: "ok", s: "Memory test ... 65536 MB OK" },
    { t: "info", s: "Detecting storage devices" },
    { t: "ok", s: "/dev/sda  NVMe SSD 1.0 TB" },
    { t: "ok", s: "/dev/sdb  NVMe SSD 2.0 TB" },
    { burst: 9 },
    { t: "head", s: "Loading kernel" },
    { t: "info", s: "Decompressing image .................. done" },
    { t: "ok", s: "Mounting root filesystem (ro)" },
    { t: "ok", s: "Remounting root filesystem (rw)" },
    { t: "ok", s: "Started system logger" },
    { t: "ok", s: "Started D-Bus message bus" },
    { t: "ok", s: "Reached target Basic System" },
    { t: "head", s: "Bringing up network" },
    { t: "ok", s: "lo: loopback interface up" },
    { t: "ok", s: "eth0: link up — 192.168.1.103/24" },
    { t: "warn", s: "ntp: clock skew 0.3s — corrected" },
    { burst: 13 },
    { t: "head", s: "Starting container engine" },
    { t: "ok", s: "containerd: started" },
    { t: "ok", s: "dockerd: api v1.45 ready" },
    { t: "info", s: "scanning local containers ..." },
    { t: "ok", s: "service discovery complete" },
    { t: "head", s: "Establishing brainlink" },
    { t: "info", s: "neural handshake ... syncing buffer" },
    { t: "warn", s: "cortex latency 12ms (nominal)" },
    { t: "ok", s: "BRAINLINK ESTABLISHED" },
    { burst: 8 },
    { t: "blank" },
    { t: "head", s: ">>> SYSTEM READY <<<", d: 120 },
  ];

  const HEX = "0123456789ABCDEF";
  const rb = () => HEX[(Math.random() * 16) | 0] + HEX[(Math.random() * 16) | 0];
  function randHex() {
    const addr = "0x" + (0x4000 + ((Math.random() * 0xbfff) | 0)).toString(16).toUpperCase().padStart(4, "0");
    let bytes = "";
    for (let i = 0; i < 12; i++) bytes += rb() + " ";
    return addr + "   " + bytes + "   " + (Math.random() < 0.85 ? "OK" : "··");
  }

  const esc = (s) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" }[c]));

  function addLine(html, cls) {
    if (!bootlog) return;
    const span = document.createElement("span");
    span.className = "l " + (cls || "");
    span.innerHTML = html;
    bootlog.appendChild(span);
    bootlog.scrollTop = bootlog.scrollHeight;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let skipReq = false;
  let finished = false;
  let revealed = false;

  async function runBoot() {
    for (const item of BOOT) {
      if (skipReq) break;
      if (item.burst) {
        for (let i = 0; i < item.burst && !skipReq; i++) {
          addLine(esc(randHex()), "dim");
          if (i % 4 === 0) tick(0.05);
          if (i % 2 === 0) await sleep(7);
        }
        continue;
      }
      if (item.t === "blank") { addLine("&nbsp;"); continue; }
      let html;
      if (item.t === "ok") html = "<b>[  OK  ]</b> " + esc(item.s);
      else if (item.t === "warn") html = "<b>[ WARN ]</b> " + esc(item.s);
      else html = esc(item.s);
      addLine(html, item.t);
      tick();
      await sleep(item.d != null ? item.d : 14 + Math.random() * 42);
    }
    // Let the finished log (with blinking cursor) sit for a beat.
    if (!skipReq) await sleep(1000);
    finishBoot();
  }

  function finishBoot() {
    if (finished) return;
    finished = true;
    if (bootFinal) bootFinal.classList.add("on");
    // A couple of glitch ticks as UBER snaps in.
    tick(0.14); setTimeout(() => tick(0.12), 90); setTimeout(() => tick(0.1), 200);
    // Start the cinematic so its boom lands on the desktop reveal (~3s).
    setTimeout(() => { const ctx = ensureAudio(); if (ctx) scheduleBoot(ctx); }, 1500);
    // Hold the big UBER splash before revealing the dashboard.
    setTimeout(revealDesktop, 3000);
  }

  function revealDesktop() {
    if (revealed) return;
    revealed = true;
    if (bootflash) {
      bootflash.classList.add("flash");
      setTimeout(() => bootflash.remove(), 600);
    }
    document.body.classList.add("booted");
    if (intro) {
      intro.classList.add("intro-done");
      setTimeout(() => intro.remove(), 700);
    }
  }

  // Tap during boot -> skip straight to the dashboard.
  function skipBoot() {
    skipReq = true;
    finished = true;
    revealDesktop();
  }

  const startSequence = () => {
    ensureAudio(); // unlocked by the start gesture
    if (!intro) return;
    intro.classList.remove("pending");
    intro.addEventListener("click", skipBoot, { once: true });
    runBoot();
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

  // --- Live clock ---------------------------------------------------
  const clockEl = document.getElementById("clock");
  function updateClock() {
    if (clockEl) clockEl.textContent = new Date().toLocaleTimeString("ru-RU");
  }
  updateClock();
  setInterval(updateClock, 1000);

  // --- Hologram globe (rotates only when the server has real internet) ---
  const globeCanvas = document.getElementById("globeCanvas");
  const globeErr = document.getElementById("globeErr");
  let globeRAF = null;
  let globeT = 0;
  let globeOnline = null;

  function drawGlobe(t) {
    const ctx = globeCanvas.getContext("2d");
    const W = globeCanvas.width;
    const R = 50, cx = W / 2, cy = W / 2, tilt = -0.4;
    const ct = Math.cos(tilt), st = Math.sin(tilt);
    ctx.clearRect(0, 0, W, W);
    ctx.shadowColor = "rgba(255,40,56,0.7)";
    ctx.shadowBlur = 4;

    const proj = (lat, lon) => {
      const cl = Math.cos(lat), sl = Math.sin(lat);
      const x = R * cl * Math.sin(lon);
      const y = R * sl;
      const z = R * cl * Math.cos(lon);
      return [cx + x, cy - (y * ct - z * st), y * st + z * ct];
    };
    const drawLine = (pts) => {
      for (let i = 1; i < pts.length; i++) {
        const a = pts[i - 1], b = pts[i];
        const front = (a[2] + b[2]) / 2 >= 0;
        ctx.strokeStyle = front ? "rgba(255,46,58,0.95)" : "rgba(255,46,58,0.22)";
        ctx.lineWidth = front ? 1.1 : 0.7;
        ctx.beginPath(); ctx.moveTo(a[0], a[1]); ctx.lineTo(b[0], b[1]); ctx.stroke();
      }
    };

    // outline
    ctx.strokeStyle = "rgba(255,46,58,0.9)"; ctx.lineWidth = 1.3;
    ctx.beginPath(); ctx.arc(cx, cy, R, 0, 2 * Math.PI); ctx.stroke();
    // parallels (static under Y-rotation)
    for (let lat = -60; lat <= 60; lat += 30) {
      const phi = (lat * Math.PI) / 180, pts = [];
      for (let d = 0; d <= 360; d += 8) pts.push(proj(phi, (d * Math.PI) / 180));
      drawLine(pts);
    }
    // meridians (sweep with t -> rotation)
    for (let k = 0; k < 6; k++) {
      const lon = (k * Math.PI) / 6 + t, pts = [];
      for (let d = -90; d <= 90; d += 6) pts.push(proj((d * Math.PI) / 180, lon));
      drawLine(pts);
    }
    ctx.shadowBlur = 0;
  }

  function globeFrame() {
    globeT += 0.012;
    drawGlobe(globeT);
    globeRAF = requestAnimationFrame(globeFrame);
  }
  function startGlobe() {
    if (globeRAF || !globeCanvas) return;
    if (globeErr) globeErr.hidden = true;
    globeCanvas.style.visibility = "visible";
    globeFrame();
  }
  function stopGlobe() {
    if (globeRAF) { cancelAnimationFrame(globeRAF); globeRAF = null; }
    if (globeCanvas) {
      globeCanvas.getContext("2d").clearRect(0, 0, globeCanvas.width, globeCanvas.height);
      globeCanvas.style.visibility = "hidden";
    }
    if (globeErr) globeErr.hidden = false; // ERROR glitch
  }
  function setOnline(on) {
    if (on === globeOnline) return;
    globeOnline = on;
    if (on) startGlobe(); else stopGlobe();
  }
  async function checkNet() {
    try {
      const r = await fetch("/api/net", { cache: "no-store" });
      const d = await r.json();
      setOnline(!!d.online);
    } catch {
      setOnline(false);
    }
  }
  checkNet();
  setInterval(checkNet, 15000);

  // --- Dropdown menu + OS-style windows -----------------------------
  const menuBtn = document.getElementById("menuBtn");
  const menuDrop = document.getElementById("menuDrop");
  const winLayer = document.getElementById("winLayer");
  const winTitle = document.getElementById("winTitle");
  const winBody = document.getElementById("winBody");
  const winFoot = document.getElementById("winFoot");
  const winClose = document.getElementById("winClose");
  const winBackdrop = document.getElementById("winBackdrop");

  let winTimer = null;
  let currentWin = null;

  function closeMenu() {
    if (!menuDrop) return;
    menuDrop.hidden = true;
    if (menuBtn) menuBtn.setAttribute("aria-expanded", "false");
  }
  function toggleMenu() {
    if (!menuDrop) return;
    const open = menuDrop.hidden;
    menuDrop.hidden = !open;
    if (menuBtn) menuBtn.setAttribute("aria-expanded", String(open));
  }

  function fmtKB(kb) {
    const mb = kb / 1024;
    return mb >= 1024 ? (mb / 1024).toFixed(1) + " GB" : Math.round(mb) + " MB";
  }

  function placeholderBody(title) {
    return `
      <div class="win-ph">
        <div class="win-ph-glyph">◣</div>
        <div class="win-ph-title">${escapeHtml(title)}</div>
        <div class="win-ph-sub">Модуль в разработке. Здесь появится содержимое — пока это заглушка.</div>
        <div class="win-ph-bar"></div>
      </div>`;
  }

  async function renderSysmon() {
    let s;
    try {
      const r = await fetch("/api/stats", { cache: "no-store" });
      s = await r.json();
    } catch {
      winBody.innerHTML = `<div class="win-ph"><div class="win-ph-glyph">⚠</div><div class="win-ph-sub">нет данных</div></div>`;
      return;
    }
    if (currentWin !== "sysmon") return;
    const cpuN = s.cpu_count || 1;
    const load1 = s.load ? s.load[0] : 0;
    const loadPct = Math.min(100, Math.round((load1 / cpuN) * 100));
    const mem = s.mem;
    const memPct = mem && mem.total ? Math.round((mem.used / mem.total) * 100) : 0;
    winBody.innerHTML = `
      <div class="mon">
        <div class="mon-grid">
          <div class="mon-cell"><div class="lbl">CPU Cores</div><div class="val">${cpuN}</div></div>
          <div class="mon-cell"><div class="lbl">Docker</div><div class="val">${s.docker ? escapeHtml(s.docker) : "—"}</div></div>
          <div class="mon-cell"><div class="lbl">Containers</div><div class="val">${s.containers ? `${s.containers.running}/${s.containers.total}` : "—"}</div></div>
          <div class="mon-cell"><div class="lbl">Internet</div><div class="val ${s.online ? "on" : "off"}">${s.online ? "ONLINE" : "OFFLINE"}</div></div>
        </div>
        <div class="mon-row">
          <div class="mon-head"><span>CPU Load (1m)</span><b>${load1.toFixed(2)} / ${cpuN}</b></div>
          <div class="mon-bar"><div class="mon-bar-fill" style="width:${loadPct}%"></div></div>
        </div>
        <div class="mon-row">
          <div class="mon-head"><span>Memory</span><b>${mem ? `${fmtKB(mem.used)} / ${fmtKB(mem.total)} · ${memPct}%` : "—"}</b></div>
          <div class="mon-bar"><div class="mon-bar-fill" style="width:${memPct}%"></div></div>
        </div>
        <div class="mon-row"><div class="mon-head"><span>Host Uptime</span><b>${s.host_uptime != null ? fmtUptime(s.host_uptime) : "—"}</b></div></div>
        ${s.load ? `<div class="mon-row"><div class="mon-head"><span>Load Avg 1·5·15</span><b>${s.load.map((x) => x.toFixed(2)).join("   ")}</b></div></div>` : ""}
      </div>`;
  }

  function renderNetwork() {
    const host = window.location.hostname;
    const cs = lastContainers;
    const svc = cs.map((c) => {
      const up = c.status === "running";
      const url = buildUrl(c);
      const ports = (c.ports || []).map((p) => `<span class="net-port">:${p}</span>`).join(" ");
      const link = url ? `<a class="net-open" href="${escapeHtml(url)}" target="_blank" rel="noopener">OPEN ↗</a>` : "";
      return `<div class="net-svc ${up ? "up" : ""}"><span class="ndot"></span><span class="nm">${escapeHtml(c.name)}</span>${ports} ${link}</div>`;
    }).join("");
    winBody.innerHTML = `
      <div class="net">
        <div class="net-node"><span>◈ Node</span> <span class="ip">${escapeHtml(host)}</span> <span style="margin-left:auto" class="${globeOnline ? "" : ""}">NET ${globeOnline ? "ONLINE" : "OFFLINE"}</span></div>
        <div class="win-sect">// exposed services (${cs.length})</div>
        ${svc || '<div class="win-ph-sub">нет сервисов</div>'}
      </div>`;
  }

  function fillWindow(winId, title) {
    if (winId === "sysmon") { renderSysmon(); return; }
    if (winId === "network") { renderNetwork(); return; }
    winBody.innerHTML = placeholderBody(title);
  }

  function openWindow(winId, title) {
    if (!winLayer) return;
    currentWin = winId;
    winTitle.textContent = title;
    if (winFoot) winFoot.textContent = `UBER OS // ${title}`;
    winLayer.hidden = false;
    fillWindow(winId, title);
    if (winTimer) { clearInterval(winTimer); winTimer = null; }
    if (winId === "sysmon") winTimer = setInterval(() => fillWindow(winId, title), 2500);
  }
  function closeWindow() {
    if (winLayer) winLayer.hidden = true;
    if (winTimer) { clearInterval(winTimer); winTimer = null; }
    currentWin = null;
  }

  if (menuBtn) {
    menuBtn.addEventListener("click", (e) => { e.stopPropagation(); toggleMenu(); });
  }
  if (menuDrop) {
    menuDrop.addEventListener("click", (e) => {
      const item = e.target.closest(".menu-item");
      if (!item) return;
      closeMenu();
      openWindow(item.dataset.win, item.dataset.title || item.textContent.trim());
    });
  }
  document.addEventListener("click", (e) => {
    if (menuDrop && !menuDrop.hidden && !e.target.closest(".navmenu")) closeMenu();
  });
  if (winClose) winClose.addEventListener("click", closeWindow);
  if (winBackdrop) winBackdrop.addEventListener("click", closeWindow);
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") { closeWindow(); closeMenu(); }
  });

  load();
  setInterval(load, REFRESH_MS);
})();
