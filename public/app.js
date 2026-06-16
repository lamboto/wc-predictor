// Team World Cup Predictor — frontend (vanilla JS).
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const api = async (path, opts = {}) => {
  const headers = { "Content-Type": "application/json", ...(opts.headers || {}) };
  if (store.gate) headers["X-Gate-Token"] = store.gate;
  if (store.token) headers["X-Auth-Token"] = store.token; // per-player auth on write actions
  const r = await fetch(path, { ...opts, headers });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    if (r.status === 401 && data.gate) { store.gate = null; showGate(); }
    if (r.status === 401 && data.auth) { store.token = null; store.person = null; location.reload(); } // session expired → re-login
    throw new Error(data.error || "Request failed");
  }
  return data;
};

const store = {
  get person() {
    try { return JSON.parse(localStorage.getItem("wc_person") || "null"); } catch { return null; }
  },
  set person(p) { p ? localStorage.setItem("wc_person", JSON.stringify(p)) : localStorage.removeItem("wc_person"); },
  get gate() { return localStorage.getItem("wc_gate") || ""; },
  set gate(t) { t ? localStorage.setItem("wc_gate", t) : localStorage.removeItem("wc_gate"); },
  get token() { return localStorage.getItem("wc_token") || ""; },
  set token(t) { t ? localStorage.setItem("wc_token", t) : localStorage.removeItem("wc_token"); },
};

// Safari is strict about muted autoplay — force every decorative video to play.
function kickVideos() {
  document.querySelectorAll("video").forEach((v) => {
    try {
      v.muted = true; v.defaultMuted = true; v.playsInline = true;
      v.setAttribute("muted", ""); v.setAttribute("playsinline", ""); v.setAttribute("webkit-playsinline", "");
      if (v.readyState < 2) { try { v.load(); } catch (e) {} }
      const tryPlay = () => { const p = v.play(); if (p && p.catch) p.catch(() => {}); };
      tryPlay();
      v.addEventListener("canplay", tryPlay, { once: true });
      v.addEventListener("loadeddata", tryPlay, { once: true });
    } catch (e) { /* ignore */ }
  });
}
(function videoAutoplayFix() {
  kickVideos();
  window.addEventListener("load", kickVideos);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) kickVideos(); });
  // retry on the first interaction (covers Safari's strict gating / Low Power Mode)
  ["pointerdown", "touchstart", "click"].forEach((ev) =>
    document.addEventListener(ev, kickVideos, { once: true, passive: true }));
})();

// ripple on press + 3D tilt of cards on hover
(function uiFx() {
  const RIPPLE = "#gate-form button, #join-form button, .bet-place";
  document.addEventListener("pointerdown", (e) => {
    const btn = e.target.closest(RIPPLE);
    if (!btn) return;
    const r = btn.getBoundingClientRect();
    const s = Math.max(r.width, r.height);
    const sp = document.createElement("span");
    sp.className = "ripple";
    sp.style.width = sp.style.height = s + "px";
    sp.style.left = (e.clientX - r.left - s / 2) + "px";
    sp.style.top = (e.clientY - r.top - s / 2) + "px";
    btn.appendChild(sp);
    setTimeout(() => sp.remove(), 650);
  }, { passive: true });

  if (!matchMedia("(hover: none)").matches) {
    const SEL = ".match, .gp-card, .cpx";
    let cur = null;
    document.addEventListener("pointermove", (e) => {
      const card = e.target.closest(SEL);
      if (card !== cur) { if (cur) cur.style.transform = ""; cur = card; }
      if (!card) return;
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      card.style.transition = "transform 0.08s ease";
      card.style.transform = `perspective(900px) rotateY(${px * 5}deg) rotateX(${-py * 5}deg)`;
    }, { passive: true });
    document.addEventListener("pointerout", (e) => {
      if (cur && (!e.relatedTarget || !cur.contains(e.relatedTarget))) { cur.style.transform = ""; cur = null; }
    });
  }
})();

// dynamic browser tab: show the player's rank in the title + favicon
const BASE_TITLE = "World Cup Predictor";
function setRankBadge(rank) {
  document.title = rank ? `#${rank} · ${BASE_TITLE}` : BASE_TITLE;
  if (!rank) return;
  try {
    const c = document.createElement("canvas"); c.width = c.height = 64;
    const x = c.getContext("2d");
    x.fillStyle = "#c9963f"; x.beginPath(); x.arc(32, 32, 31, 0, Math.PI * 2); x.fill();
    x.fillStyle = "#2a1f0e"; x.textAlign = "center"; x.textBaseline = "middle";
    x.font = `bold ${rank > 99 ? 30 : 42}px Oswald, Arial, sans-serif`;
    x.fillText(String(rank), 32, 37);
    let link = document.querySelector("link[rel='icon']");
    if (!link) { link = document.createElement("link"); link.rel = "icon"; document.head.appendChild(link); }
    link.href = c.toDataURL("image/png");
  } catch (e) { /* ignore */ }
}

// rank rings: top-3 players get a gold/silver/bronze ring around their avatar everywhere
let rankById = {};
function computeRankMap(rows) {
  const sorted = [...(rows || [])].sort((a, b) => b.points - a.points || b.correct - a.correct || a.name.localeCompare(b.name));
  const map = {}; let rk = 0, last = null;
  sorted.forEach((r, i) => { if (r.points !== last) { rk = i + 1; last = r.points; } map[r.person_id] = rk; });
  rankById = map;
}
function rankRing(pid) { const r = rankById[pid]; return r >= 1 && r <= 3 ? ` rank-${r}` : ""; }

// online presence (heartbeat) — green dot on avatars + count in chat
let onlineSet = new Set();
function onlineDot(pid) { return onlineSet.has(pid) ? '<span class="on-dot" title="Online"></span>' : ""; }
function fmtDur(ms) { const h = Math.floor(ms / 3600000), m = Math.ceil((ms % 3600000) / 60000); return h > 0 ? `${h}h ${m}m` : `${Math.max(1, m)}m`; }
function updateOnlineCount() { const el = $("#chat-online"); if (el) { const n = onlineSet.size; el.textContent = n ? `· ${n} online` : ""; } }
function presencePing() {
  if (!store.person) return;
  api("/api/ping", { method: "POST", body: JSON.stringify({ personId: store.person.id }) })
    .then((d) => { onlineSet = new Set(d.online || []); updateOnlineCount(); }).catch(() => {});
}

// holographic foil: the rainbow sheen follows the cursor across .holo cards
(function holoFx() {
  if (matchMedia("(hover: none)").matches) return;
  let cur = null;
  const reset = () => { if (cur) { cur.style.removeProperty("--hx"); cur.style.removeProperty("--hy"); cur = null; } };
  document.addEventListener("pointermove", (e) => {
    const el = e.target.closest(".holo");
    if (el !== cur) { if (cur) { cur.style.removeProperty("--hx"); cur.style.removeProperty("--hy"); } cur = el; }
    if (!el) return;
    const r = el.getBoundingClientRect();
    el.style.setProperty("--hx", ((e.clientX - r.left) / r.width * 100).toFixed(1) + "%");
    el.style.setProperty("--hy", ((e.clientY - r.top) / r.height * 100).toFixed(1) + "%");
  }, { passive: true });
  document.addEventListener("pointerout", (e) => { if (cur && (!e.relatedTarget || !cur.contains(e.relatedTarget))) reset(); });
})();

// parallax: the FIFA art background drifts subtly with cursor + scroll (leaderboard/profile)
(function artParallax() {
  if (matchMedia("(hover: none)").matches && !("onscroll" in window)) return;
  let mx = 0, my = 0, raf = 0;
  const apply = () => {
    raf = 0;
    if (!document.body.classList.contains("art-bg")) return;
    const sc = Math.min(40, (window.scrollY || 0) * 0.05);
    document.documentElement.style.setProperty("--ax", (mx * -18) + "px");
    document.documentElement.style.setProperty("--ay", (my * -18 + sc) + "px");
  };
  const queue = () => { if (!raf) raf = requestAnimationFrame(apply); };
  window.addEventListener("pointermove", (e) => { mx = e.clientX / innerWidth - 0.5; my = e.clientY / innerHeight - 0.5; queue(); }, { passive: true });
  window.addEventListener("scroll", queue, { passive: true });
})();

let pollTimer = null;
let currentView = "matches";

const PICK_LABELS = { a_win: "{A} win", draw: "Draw", b_win: "{B} win" };

function fmtKickoff(iso) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0,0,0,0);
  const day = new Date(d); day.setHours(0,0,0,0);
  const isToday = +day === +today;
  const isTomorrow = +day === +today + 86400000;
  const prefix = isToday ? "Today" : isTomorrow ? "Tomorrow" : d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" });
  return `${prefix} · ${d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}`;
}

// team marker: real crest image if available, otherwise the flag emoji
function mark(flag, crest) {
  return crest
    ? `<img class="crest" src="${crest}" alt="" loading="lazy" onerror="this.outerHTML='${flag || ""}'">`
    : (flag || "");
}

// escape user-supplied text before inserting as HTML
function escapeHtml(s) {
  return (s || "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// odds-movement arrow since the last sync (up = drifted, down = shortened)
function oddArrow(dir) {
  return dir === "up" ? '<span class="od-mv od-up" title="drifted up since last update">▲</span>'
    : dir === "down" ? '<span class="od-mv od-down" title="shortened since last update">▼</span>' : "";
}

// player avatar: photo in a circle if set, otherwise a monogram (first letter of name)
// downscale a chosen image to a small square-ish JPEG data URL (keeps storage light)
function resizeImage(file, max, cb) {
  const reader = new FileReader();
  reader.onload = () => {
    const img = new Image();
    img.onload = () => {
      let w = img.width, h = img.height;
      const scale = Math.min(1, max / Math.max(w, h));
      w = Math.max(1, Math.round(w * scale)); h = Math.max(1, Math.round(h * scale));
      const c = document.createElement("canvas"); c.width = w; c.height = h;
      c.getContext("2d").drawImage(img, 0, 0, w, h);
      try { cb(c.toDataURL("image/jpeg", 0.82)); } catch (e) { cb(reader.result); }
    };
    img.onerror = () => cb(reader.result);
    img.src = reader.result;
  };
  reader.readAsDataURL(file);
}
function avatarMark(name, photo) {
  const initial = ((name || "?").trim().charAt(0) || "?").toUpperCase();
  return photo
    ? `<span class="ava"><img class="ava-photo" src="${photo}" alt="" loading="lazy"></span>`
    : `<span class="ava ava-mono">${initial}</span>`;
}

// accent-friendly primary colours per nation (white text stays readable)
const TEAM_COLORS = {
  "Brazil": "#0a8f3c", "Argentina": "#2e7fc1", "France": "#1b3a7a", "England": "#c8102e", "Spain": "#c8102e",
  "Portugal": "#0a7d34", "Germany": "#2b2b2b", "Netherlands": "#e8590c", "Belgium": "#b8121b", "Italy": "#0067b1",
  "Croatia": "#c8102e", "Mexico": "#0a7d44", "United States": "#3b3b8f", "Uruguay": "#2e7fc1", "Colombia": "#1b5fa8",
  "Japan": "#bc002d", "South Korea": "#c8102e", "Morocco": "#b5121b", "Senegal": "#0a8f3c", "Switzerland": "#d52b1e",
  "Denmark": "#c60c30", "Poland": "#c8102e", "Serbia": "#b5121b", "Sweden": "#1f6fb2", "Wales": "#c8102e",
  "Scotland": "#1b3a7a", "Australia": "#0a7d44", "Canada": "#c8102e", "Qatar": "#7a1330", "Ecuador": "#1f6fb2",
  "Ivory Coast": "#e8590c", "Ghana": "#0a8f3c", "Cameroon": "#0a7d44", "Nigeria": "#0a8f3c", "Tunisia": "#c8102e",
  "Saudi Arabia": "#0a7d44", "Iran": "#0a8f3c", "Czech Republic": "#1b3a7a", "Turkey": "#c8102e", "Paraguay": "#c8102e",
  "Bosnia and Herzegovina": "#1b5fa8", "Curacao": "#1b3a7a", "Haiti": "#1b3a7a", "South Africa": "#0a7d44",
  "Norway": "#c8102e", "Austria": "#c8102e", "Peru": "#c8102e", "Chile": "#c8102e", "Egypt": "#c8102e",
  "New Zealand": "#2b2b2b", "Costa Rica": "#c8102e", "Panama": "#b5121b", "Jordan": "#b5121b", "Uzbekistan": "#1f6fb2",
};
// tint the site accent with the colours of the player's champion pick
function applyAccentForTeam(team) {
  const c = team && TEAM_COLORS[team];
  if (c) document.documentElement.style.setProperty("--accent-blue", c);
  else document.documentElement.style.removeProperty("--accent-blue");
}
// champion-page theming: header + background take the team's colour
let myChampionTeam = null;
const champFlags = {}; // team name -> flag emoji (filled from /api/champion)
const FLAG_SUBDIV = { "England": "gb-eng", "Scotland": "gb-sct", "Wales": "gb-wls", "Northern Ireland": "gb-nir" };
// derive an ISO country code from a 🇧🇷-style flag emoji
function flagEmojiToCode(flag) {
  const ri = [...(flag || "")].map((c) => c.codePointAt(0)).filter((c) => c >= 0x1F1E6 && c <= 0x1F1FF);
  return ri.length === 2 ? ri.map((c) => String.fromCharCode(c - 0x1F1E6 + 97)).join("") : null;
}
function champFlagUrl(team) {
  const code = FLAG_SUBDIV[team] || flagEmojiToCode(champFlags[team]);
  return code ? `https://flagcdn.com/w640/${code}.png` : null;
}
function champColor(team) { return (team && TEAM_COLORS[team]) || "#a6781f"; }
function setChampVar(team) {
  const c = team && TEAM_COLORS[team];
  document.documentElement.style.setProperty("--champ-color", c || "#a6781f");
  document.body.classList.toggle("has-champ", !!c);
  const url = champFlagUrl(team);
  const badge = document.getElementById("champ-flag-badge");
  if (badge) {
    if (url) { badge.src = url; badge.classList.add("on"); }
    else { badge.removeAttribute("src"); badge.classList.remove("on"); }
  }
}

// ---------- identity / gate / join ----------
async function init() {
  let info = {};
  try { info = await api("/api/info"); } catch {}
  if (info.gateRequired && !store.gate) { showGate(); return; }

  const p = store.person;
  if (p && !store.token) { store.person = null; showJoin(); return; } // legacy session without a token → log in once
  if (p) {
    try {
      await api(`/api/me?personId=${p.id}`); // validate still exists (also re-checks gate)
      enterApp();
      return;
    } catch {
      if (info.gateRequired && !store.gate) return; // gate was shown by api()
      store.person = null;
    }
  }
  showJoin();
}

function showGate() {
  $("#app").classList.add("hidden");
  $("#join-screen").classList.add("hidden");
  $("#gate-screen").classList.remove("hidden");
}

$("#gate-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  $("#gate-error").textContent = "";
  const code = $("#gate-code").value.trim();
  try {
    const { token } = await api("/api/gate", { method: "POST", body: JSON.stringify({ code }) });
    store.gate = token || "ok";
    $("#gate-screen").classList.add("hidden");
    $("#gate-code").value = "";
    init();
  } catch (err) { $("#gate-error").textContent = err.message; }
});

function showJoin() {
  $("#app").classList.add("hidden");
  $("#gate-screen").classList.add("hidden");
  $("#join-screen").classList.remove("hidden");
}

$("#join-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const name = $("#join-name").value.trim();
  const pin = $("#join-pin").value.trim();
  $("#join-error").textContent = "";
  if (!name) { $("#join-error").textContent = "Please enter your name."; return; }
  if (!pin) { $("#join-error").textContent = "A PIN is required."; return; }
  if (!/^\d{4,8}$/.test(pin)) { $("#join-error").textContent = "PIN must be 4–8 digits."; return; }
  try {
    const { person, token } = await api("/api/join", { method: "POST", body: JSON.stringify({ name, pin }) });
    store.person = person;
    store.token = token || null;
    enterApp();
  } catch (err) {
    $("#join-error").textContent = err.message;
  }
});

function enterApp() {
  $("#join-screen").classList.add("hidden");
  $("#app").classList.remove("hidden");
  kickVideos(); // the nav logo video is now visible — make sure it plays (Safari)
  $("#who-name").textContent = store.person.display_name;
  $("#who-avatar").innerHTML = avatarMark(store.person.display_name, store.person.photo);
  const who = $(".who");
  if (who) { who.dataset.profile = store.person.id; who.title = "My profile"; } // click name/photo → my profile
  // load ranks once so the top-3 avatar rings show everywhere from the start
  api("/api/leaderboard").then((d) => computeRankMap(d.leaderboard)).catch(() => {});
  // set the champion aura + accent site-wide from the start (not only after visiting Champion)
  api(`/api/champion?personId=${store.person.id}`).then((d) => {
    myChampionTeam = d.pick || null;
    setChampVar(myChampionTeam);
    if (typeof applyAccentForTeam === "function") applyAccentForTeam(d.pick);
  }).catch(() => {});
  presencePing();
  setInterval(presencePing, 30000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden) presencePing(); });
  switchView("matches");
  startPolling();
  initChrome();
  chatStart();
  api(`/api/champion?personId=${store.person.id}`).then((d) => { myChampionTeam = d.pick || null; applyAccentForTeam(d.pick); setChampVar(myChampionTeam); }).catch(() => {}); // theme by champion
}

const REDUCE = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// ---------- marquee + countdown ----------
function buildMarquee() {
  const track = $("#marquee-track");
  if (track) {
    const items = ["FIFA World Cup 2026", "#WeAre26", "Predict", "Compete", "Crown a Champion", "USA · CAN · MEX", "Climb the Board"];
    const one = items.map((t, i) => `<span class="${i % 3 === 0 ? "hot" : ""}">${t}</span><span>•</span>`).join("");
    track.innerHTML = one + one;
  }
  const footEl = $("#footer-track");
  if (footEl) {
    const foot = ["For fun only", "No money involved", "Polls every 60s", "#WeAre26", "Good luck"];
    footEl.innerHTML = foot.map((t, i) => `<span class="${i % 2 === 0 ? "hot" : ""}">${t}</span><span>•</span>`).join("");
  }
}

// ---------- ambient FX: scroll progress, cursor glow, grain, card tilt ----------
const POINTER_FINE = window.matchMedia && window.matchMedia("(pointer: fine)").matches;
function initFx() {
  // scroll progress bar
  const bar = document.createElement("div"); bar.id = "scroll-prog"; document.body.appendChild(bar);
  const onScroll = () => {
    const h = document.documentElement;
    const max = h.scrollHeight - h.clientHeight;
    const sy = h.scrollTop || window.pageYOffset || 0;
    bar.style.width = (max > 0 ? (sy / max) * 100 : 0) + "%";
  };
  window.addEventListener("scroll", onScroll, { passive: true }); onScroll();

  // grain texture
  const grain = document.createElement("div"); grain.id = "grain"; document.body.appendChild(grain);

  // cursor spotlight (desktop, motion ok)
  if (!REDUCE && POINTER_FINE) {
    const glow = document.createElement("div"); glow.id = "cursor-glow"; document.body.appendChild(glow);
    window.addEventListener("mousemove", (e) => { glow.style.left = e.clientX + "px"; glow.style.top = e.clientY + "px"; }, { passive: true });
  }
}

// subtle 3D tilt on cards (re-applied after renders; guarded so it binds once)
function tiltify() {
  if (REDUCE || !POINTER_FINE) return;
  $$(".pk-match").forEach((card) => {
    if (card.dataset.tilt) return;
    card.dataset.tilt = "1";
    card.addEventListener("mousemove", (e) => {
      const r = card.getBoundingClientRect();
      const px = (e.clientX - r.left) / r.width - 0.5;
      const py = (e.clientY - r.top) / r.height - 0.5;
      card.style.transform = `perspective(720px) rotateX(${(-py * 5).toFixed(2)}deg) rotateY(${(px * 5).toFixed(2)}deg) translateY(-3px)`;
    });
    card.addEventListener("mouseleave", () => { card.style.transform = ""; });
  });
}

let tournamentStartMs = null, cdTimer = null;
async function initChrome() {
  buildMarquee();
  try { const info = await api("/api/info"); tournamentStartMs = new Date(info.tournamentStart).getTime(); }
  catch { tournamentStartMs = null; }
  // build the rotating decorative rings + a persistent inner element (once)
  const cd = $("#countdown");
  if (cd && !$("#cd-inner")) {
    cd.innerHTML = `<div class="cd-inner" id="cd-inner"></div>`;
  }
  clearInterval(cdTimer);
  renderCountdown();
  cdTimer = setInterval(renderCountdown, 1000);
}
function renderCountdown() {
  const el = $("#cd-inner") || $("#countdown");
  if (!el || tournamentStartMs == null) return;
  const diff = tournamentStartMs - Date.now();
  if (diff <= 0) { const band = document.querySelector(".cd-band"); if (band) band.classList.add("hidden"); clearInterval(cdTimer); return; }
  const d = Math.floor(diff / 86400000), h = Math.floor(diff / 3600000) % 24, m = Math.floor(diff / 60000) % 60, s = Math.floor(diff / 1000) % 60;
  const cell = (n, l) => `<div class="cd-cell"><div class="cd-num">${String(n).padStart(2, "0")}</div><div class="cd-label">${l}</div></div>`;
  const sep = `<span class="cd-sep">:</span>`;
  el.innerHTML = `<div class="cd-nums">${cell(d, "Days")}${sep}${cell(h, "Hours")}${sep}${cell(m, "Minutes")}${sep}${cell(s, "Seconds")}</div><div class="cd-foot">Until FIFA World Cup 26™ kickoff</div>`;
}

// ---------- confetti ----------
function fireConfetti() {
  if (REDUCE) return;
  let c = document.getElementById("confetti-canvas");
  if (!c) { c = document.createElement("canvas"); c.id = "confetti-canvas"; document.body.appendChild(c); }
  const ctx = c.getContext("2d");
  const W = (c.width = window.innerWidth), H = (c.height = window.innerHeight);
  const colors = ["#ff2d9b", "#8b3bff", "#2f6bff", "#00e6c3", "#c6ff3a", "#ffd24a"];
  const parts = [];
  for (let i = 0; i < 150; i++) parts.push({
    x: W / 2 + (Math.random() - 0.5) * W * 0.4, y: H * 0.32 + (Math.random() - 0.5) * 60,
    vx: (Math.random() - 0.5) * 10, vy: Math.random() * -9 - 3, g: 0.22 + Math.random() * 0.12,
    rot: Math.random() * 6.28, vr: (Math.random() - 0.5) * 0.35, s: 6 + Math.random() * 7, col: colors[i % colors.length], life: 0,
  });
  let t0 = performance.now();
  (function frame(now) {
    const dt = Math.min(32, now - t0); t0 = now;
    ctx.clearRect(0, 0, W, H);
    let maxLife = 0;
    parts.forEach((p) => {
      p.vy += p.g; p.x += p.vx; p.y += p.vy; p.rot += p.vr; p.life += dt; maxLife = Math.max(maxLife, p.life);
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.rot); ctx.globalAlpha = Math.max(0, 1 - p.life / 2400);
      ctx.fillStyle = p.col; ctx.fillRect(-p.s / 2, -p.s / 2, p.s, p.s * 0.6); ctx.restore();
    });
    if (maxLife < 2400) requestAnimationFrame(frame); else ctx.clearRect(0, 0, W, H);
  })(t0);
}

// remember which wins we've already celebrated so confetti fires only once each
const celebrated = {
  _get() { try { return new Set(JSON.parse(localStorage.getItem("wc_celebrated") || "[]")); } catch { return new Set(); } },
  has(k) { return this._get().has(k); },
  add(k) { const s = this._get(); s.add(k); localStorage.setItem("wc_celebrated", JSON.stringify([...s])); },
};

// ---------- tabs ----------
let profileTarget = null; // whose profile to show (null = my own)
$$(".tab").forEach((t) => t.addEventListener("click", () => {
  if (t.dataset.view === "profile") profileTarget = null; // tab always opens my own
  switchView(t.dataset.view);
}));
// clicking the logo goes home (Matches)
(function brandHome() {
  const brand = $(".brand");
  if (!brand) return;
  brand.style.cursor = "pointer";
  brand.title = "Home — Matches";
  brand.addEventListener("click", () => switchView("matches"));
})();
// profile now opens in a slide-in side panel (drawer), not a full page
function openProfile(personId) {
  profileTarget = personId;
  const d = $("#profile-drawer");
  if (d) {
    const pc = $("#profile-content");
    if (pc) pc.innerHTML = `<p class="muted small" style="padding:24px">Loading…</p>`;
    d.classList.remove("hidden");
    d.setAttribute("aria-hidden", "false");
    requestAnimationFrame(() => d.classList.add("open"));
    document.body.classList.add("drawer-open");
  }
  loadProfile();
}
function closeProfileDrawer() {
  const d = $("#profile-drawer");
  if (!d) return;
  d.classList.remove("open");
  d.setAttribute("aria-hidden", "true");
  document.body.classList.remove("drawer-open");
  setTimeout(() => d.classList.add("hidden"), 320);
}
// open a photo full-size in an overlay
function openPhotoLightbox(src) {
  if (!src) return;
  let lb = document.getElementById("photo-lightbox");
  if (!lb) {
    lb = document.createElement("div");
    lb.id = "photo-lightbox";
    lb.className = "photo-lightbox hidden";
    lb.innerHTML = `<button class="plb-close" aria-label="Close">✕</button><img class="plb-img" alt="" />`;
    document.body.appendChild(lb);
    lb.addEventListener("click", () => lb.classList.add("hidden"));
  }
  lb.querySelector(".plb-img").src = src;
  lb.classList.remove("hidden");
}
function closePhotoLightbox() {
  const lb = document.getElementById("photo-lightbox");
  if (lb && !lb.classList.contains("hidden")) { lb.classList.add("hidden"); return true; }
  return false;
}
document.addEventListener("click", (e) => {
  // clicking the photo in an opened profile → show it larger
  const hero = e.target.closest(".np-ava");
  if (hero) { const img = hero.querySelector("img.ava-photo"); if (img) { openPhotoLightbox(img.src); return; } }
  const el = e.target.closest("[data-profile]");
  if (el) { openProfile(el.dataset.profile); return; }
  if (e.target.closest("[data-close]")) closeProfileDrawer();
});
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { if (!closePhotoLightbox()) closeProfileDrawer(); } });
function switchView(view) {
  currentView = view;
  $$(".tab").forEach((t) => t.classList.toggle("active", t.dataset.view === view));
  $$(".view").forEach((v) => v.classList.add("hidden"));
  const shown = $(`#view-${view}`);
  shown.classList.remove("hidden");
  shown.classList.remove("view-anim"); void shown.offsetWidth; shown.classList.add("view-anim"); // retrigger fade-in
  document.body.classList.toggle("theme-blue", ["leaderboard"].includes(view)); // dark page
  document.body.classList.toggle("champ-theme", view === "champion"); // champion page takes the team's colour
  document.body.classList.toggle("hide-countdown", view === "leaderboard" || view === "profile"); // no countdown band here
  document.body.classList.toggle("art-bg", view === "leaderboard"); // full-screen key-art background (leaderboard only)
  if (view === "champion") setChampVar(myChampionTeam);
  closeNav(); // collapse the mobile menu after navigating
  refresh(true);
}

// ---------- mobile menu (hamburger) ----------
function closeNav() {
  document.body.classList.remove("nav-open");
  const t = $("#nav-toggle"); if (t) t.setAttribute("aria-expanded", "false");
}
(function navToggle() {
  const btn = $("#nav-toggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const open = document.body.classList.toggle("nav-open");
    btn.setAttribute("aria-expanded", open ? "true" : "false");
  });
  // tapping outside the header closes the menu
  document.addEventListener("click", (e) => {
    if (document.body.classList.contains("nav-open") && !e.target.closest("header")) closeNav();
  });
})();

// ---------- polling ----------
function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(() => refresh(false), 60000); // 60s, no re-animation
  refresh(true);
}
async function refresh(animate) {
  if (currentView === "matches") await loadMatches();
  else if (currentView === "schedule") await loadSchedule();
  else if (currentView === "champion") await loadChampion();
  else if (currentView === "leaderboard") await loadLeaderboard();
  else if (currentView === "picks") await loadPicks();
  else if (currentView === "profile") await loadProfile();
  else if (currentView === "standings") await loadStandings();
  if (animate) observeReveals();
  tiltify();
}

// ---------- groups (fixture posters per group) ----------
// ---------- groups: Fixtures / Standings toggle ----------
let groupTab = "fixtures";
let groupsCache = null;
async function loadStandings() {
  const { groups } = await api("/api/groups");
  groupsCache = groups || {};
  renderGroups();
}
function renderGroups() {
  const groups = groupsCache || {};
  const wrap = $("#standings-list"), empty = $("#standings-empty");
  const keys = Object.keys(groups).sort();
  if (!keys.length) { wrap.innerHTML = ""; empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");
  const toggle = `<div class="gt-toggle">
    <button class="gt-btn${groupTab === "fixtures" ? " active" : ""}" data-gt="fixtures">Fixtures</button>
    <button class="gt-btn${groupTab === "standings" ? " active" : ""}" data-gt="standings">Standings</button>
  </div>`;
  const body = `<div class="gp-grid">` + keys.map((g) => {
    const data = groups[g] || { table: [], fixtures: [] };
    const inner = groupTab === "standings"
      ? `<div class="gp-table">
           <div class="gp-th"><span></span><span>Team</span><span>P</span><span>GD</span><span>Pts</span></div>
           ${(data.table || []).map((t) => `
             <div class="gp-tr${t.pos <= 2 ? " q" : ""}">
               <span class="gp-pos">${t.pos}</span>
               <span class="gp-tteam"><span class="gp-tflag">${flagCircle(t.team, t.flag, t.crest)}</span><b>${teamCode(t.tla, t.team)}</b></span>
               <span>${t.P}</span>
               <span>${t.knownGD ? (t.GD > 0 ? "+" : "") + t.GD : "–"}</span>
               <span class="gp-tpts">${t.Pts}</span>
             </div>`).join("")}
         </div>`
      : `<div class="gp-fixtures">${(data.fixtures || []).map((m) => {
           const res = (m.score_home != null && m.score_away != null) ? `${m.score_home}–${m.score_away}` : "v";
           return `<div class="gp-fix">
             <div class="gp-bar">
               <span class="gp-side"><span class="gp-flag">${flagCircle(m.team_a, m.flag_a, m.crest_a)}</span><b>${teamCode(m.tla_a, m.team_a)}</b></span>
               <span class="gp-mid">${res}</span>
               <span class="gp-side r"><b>${teamCode(m.tla_b, m.team_b)}</b><span class="gp-flag">${flagCircle(m.team_b, m.flag_b, m.crest_b)}</span></span>
             </div>
             <div class="gp-date">${matchDate(m.kickoff_time)}</div>
           </div>`;
         }).join("")}</div>`;
    return `<div class="gp-card" id="grp-${g}"><div class="gp-title">Group ${g}</div>${inner}</div>`;
  }).join("") + `</div>`;
  wrap.innerHTML = toggle + body;
  wrap.querySelectorAll(".gt-btn").forEach((b) => b.addEventListener("click", () => { groupTab = b.dataset.gt; renderGroups(); }));
  // if we arrived here from a Schedule "Group X" pill, scroll to that group + flash it
  if (pendingGroupScroll) {
    const target = wrap.querySelector(`#grp-${CSS.escape(pendingGroupScroll)}`);
    pendingGroupScroll = null;
    if (target) requestAnimationFrame(() => {
      target.scrollIntoView({ behavior: "smooth", block: "center" });
      target.classList.add("grp-flash");
      setTimeout(() => target.classList.remove("grp-flash"), 1600);
    });
  }
}

// ---------- scroll reveal (elements rise in as they enter the viewport) ----------
let _revealIO;
function revealObserver() {
  if (!_revealIO) {
    _revealIO = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("in"); _revealIO.unobserve(e.target); } });
    }, { threshold: 0.08 });
  }
  return _revealIO;
}
function observeReveals() {
  const sel = "#view-matches .match, #view-schedule .day-group, #view-schedule .sch-row, #view-champion .champion-banner, #view-picks .cp-card, #view-picks .vs-card";
  const io = revealObserver();
  let i = 0;
  $$(sel).forEach((el) => {
    if (el.dataset.rev) return;
    el.dataset.rev = "1";
    el.classList.add("reveal");
    el.style.transitionDelay = Math.min(i * 45, 320) + "ms";
    i++;
    io.observe(el);
  });
}

// ---------- matches ----------
let myBalance = null; // virtual bankroll balance, refreshed with matches
async function loadMatches() {
  const [{ matches }, bank] = await Promise.all([
    api(`/api/matches?personId=${store.person.id}`),
    api(`/api/bankroll?personId=${store.person.id}`).catch(() => null),
  ]);
  if (bank && bank.me) myBalance = bank.me.balance;
  const list = $("#matches-list");
  const empty = $("#matches-empty");
  const title = $("#matches-title");
  if (!matches.length) {
    list.innerHTML = "";
    if (title) title.textContent = "Upcoming Matches";
    empty.classList.remove("hidden");
    empty.textContent = "No upcoming matches. Set your champion pick in the meantime.";
    return;
  }
  empty.classList.add("hidden");
  if (title) title.textContent = "Upcoming Matches";
  list.innerHTML = matches.map(renderMatch).join("");
  $$(".pick-target[data-match]").forEach((b) => b.addEventListener("click", onPick));
  wireBets();

  // celebrate any newly-correct results (once each)
  let won = false;
  matches.forEach((m) => {
    if (m.result && m.pick && m.pick === m.result) {
      const k = "m" + m.id;
      if (!celebrated.has(k)) { celebrated.add(k); won = true; }
    }
  });
  if (won) fireConfetti();
}

// round flag for the matchday poster: real flag image, else crest, else emoji
function flagCircle(team, flag, crest) {
  const code = FLAG_SUBDIV[team] || flagEmojiToCode(flag);
  if (code) return `<img class="mh-fimg" src="https://flagcdn.com/w160/${code}.png" alt="" loading="lazy">`;
  if (crest) return `<img class="mh-fimg" src="${crest}" alt="" loading="lazy">`;
  return `<span class="mh-femoji">${flag || ""}</span>`;
}
function teamCode(tla, team) { return (tla || (team || "").replace(/[^A-Za-z]/g, "").slice(0, 3).toUpperCase() || "?"); }
function matchDate(iso) { const d = new Date(iso); return `${d.getDate()} ${d.toLocaleDateString("en-US", { month: "long" }).toUpperCase()}`; }

function renderMatch(m) {
  const stageLabel = m.stage === "knockout" ? (m.round || "Knockout") : `Group ${m.group} · MD${m.matchday || ""}`;
  // pick by tapping the flag (or the middle for a draw)
  const pk = (val) => m.locked ? "" : ` data-match="${m.id}" data-pick="${val}" role="button" tabindex="0"`;
  const cls = (val) => `${m.pick === val ? " sel" : ""}${m.result === val ? " won" : ""}`;

  const hasScore = m.score_home != null && m.score_away != null;
  const isLive = m.status === "IN_PLAY" || m.status === "PAUSED";
  const centre = hasScore ? `${m.score_home}–${m.score_away}` : (m.locked ? "v" : "DRAW");
  const when = isLive
    ? `<span class="mh-live">LIVE${m.minute != null ? " " + m.minute + "'" : ""}</span>`
    : `${fmtKickoff(m.kickoff_time)}${m.locked ? " · LOCKED" : ""}`;

  // odds chips on the poster (only when odds exist)
  const hasOdds = m.odds_a != null && m.odds_draw != null && m.odds_b != null;
  const odd = (v, dir) => hasOdds ? `<span class="mh-odd">${v.toFixed(2)}${oddArrow(dir)}</span>` : "";

  // result verdict only (the gold ring + ✓ already shows your pick before the result)
  const pickName = { a_win: m.team_a, draw: "Draw", b_win: m.team_b };
  let ribbon = "";
  if (m.result) {
    const resTxt = hasScore ? `${m.team_a} ${m.score_home}–${m.score_away} ${m.team_b}` : pickName[m.result] + (m.result === "draw" ? "" : " won");
    if (!m.pick) ribbon = `<div class="pk-ribbon none">Result: <b>${resTxt}</b> · you didn't pick</div>`;
    else if (m.pick === m.result) ribbon = `<div class="pk-ribbon ok">Result: <b>${resTxt}</b> · you nailed it ✓</div>`;
    else ribbon = `<div class="pk-ribbon no">Result: <b>${resTxt}</b> · you said ${pickName[m.pick]} ✗</div>`;
  }

  return `
    <div class="match">
      <div class="mh${m.locked ? " locked" : ""}" style="--ta:${champColor(m.team_a)};--tb:${champColor(m.team_b)}">
        <div class="mh-burst" aria-hidden="true"></div>
        <div class="mh-tags">
          <span class="mh-tag">${stageLabel}</span>
          <span class="mh-tag">${when}</span>
        </div>
        <div class="mh-row">
          <div class="mh-pick">
            <span class="mh-flag pick-target${cls("a_win")}"${pk("a_win")}>${flagCircle(m.team_a, m.flag_a, m.crest_a)}</span>
            ${odd(m.odds_a, m.odds_dir_a)}
          </div>
          <div class="mh-pick mid">
            <span class="mh-v pick-target${cls("draw")}"${pk("draw")}>${centre}</span>
            ${odd(m.odds_draw, m.odds_dir_draw)}
          </div>
          <div class="mh-pick">
            <span class="mh-flag pick-target${cls("b_win")}"${pk("b_win")}>${flagCircle(m.team_b, m.flag_b, m.crest_b)}</span>
            ${odd(m.odds_b, m.odds_dir_b)}
          </div>
        </div>
        <div class="mh-labels">
          <span class="mh-code">${teamCode(m.tla_a, m.team_a)}</span>
          <span class="mh-date">${matchDate(m.kickoff_time)}</span>
          <span class="mh-code">${teamCode(m.tla_b, m.team_b)}</span>
        </div>
        ${renderBetBar(m)}
      </div>
      ${ribbon ? `<div class="match-body">${ribbon}</div>` : ""}
    </div>`;
}

// embedded betting bar in the poster — bets on the outcome you already tapped
function renderBetBar(m) {
  const hasOdds = m.odds_a != null && m.odds_draw != null && m.odds_b != null;
  const bet = m.bet;
  if (!hasOdds && !bet) return "";
  const oddName = { a_win: m.team_a, draw: "Draw", b_win: m.team_b };
  const oddVal = { a_win: m.odds_a, draw: m.odds_draw, b_win: m.odds_b };

  // settled (result in) → show how the bet went
  if (m.result) {
    if (!bet) return "";
    const won = bet.pick === m.result;
    return `<div class="mh-bet done ${won ? "win" : "loss"}">💰 €${bet.stake} on ${oddName[bet.pick]} @${bet.odds} — ${won ? `won €${bet.potential.toFixed(2)} ✓` : `lost €${bet.stake} ✗`}</div>`;
  }
  // locked, no result → static view of any bet
  if (m.locked) {
    if (!bet) return "";
    return `<div class="mh-bet done">💰 €${bet.stake} on ${oddName[bet.pick]} @${bet.odds} → returns €${bet.potential.toFixed(2)} (locked)</div>`;
  }
  if (!hasOdds) return "";
  // no pick yet → nudge to pick first
  if (!m.pick) return `<div class="mh-bet nudge">Tap a flag to predict — then stake to bet on it</div>`;
  // open: stake money on your current pick
  const odd = oddVal[m.pick];
  return `<div class="mh-bet" data-match="${m.id}" data-pick="${m.pick}" data-odd="${odd}">
    <span class="mh-bet-lbl">Bet €</span>
    <input type="number" class="bet-amt" min="1" step="1" placeholder="0" value="${bet ? bet.stake : ""}" />
    <span class="mh-bet-on">on ${oddName[m.pick]} @${odd.toFixed(2)}</span>
    <span class="bet-win">→ €0.00</span>
    <button class="bet-place">${bet ? "Update" : "Bet"}</button>
    ${bet ? `<button class="bet-cancel">✕</button>` : ""}
  </div>`;
}

function wireBets() {
  $$(".mh-bet[data-match]").forEach((box) => {
    const matchId = Number(box.dataset.match), pick = box.dataset.pick, odd = Number(box.dataset.odd);
    const amt = box.querySelector(".bet-amt");
    const win = box.querySelector(".bet-win");
    const place = box.querySelector(".bet-place");
    const sync = () => { const stake = Number(amt.value) || 0; win.textContent = `→ €${(stake * odd).toFixed(2)}`; };
    if (amt) { amt.addEventListener("input", sync); sync(); }
    if (place) place.addEventListener("click", async () => {
      const stake = Math.round(Number(amt.value));
      if (!(stake > 0)) { alert("Enter a stake greater than 0."); return; }
      try {
        await api("/api/bet", { method: "POST", body: JSON.stringify({ personId: store.person.id, matchId, pick, stake }) });
        loadMatches();
      } catch (err) { alert(err.message); }
    });
    const cancel = box.querySelector(".bet-cancel");
    if (cancel) cancel.addEventListener("click", async () => {
      try { await api("/api/bet/cancel", { method: "POST", body: JSON.stringify({ personId: store.person.id, matchId }) }); loadMatches(); }
      catch (err) { alert(err.message); }
    });
  });
}

async function onPick(e) {
  const btn = e.currentTarget;
  const matchId = Number(btn.dataset.match);
  const pick = btn.dataset.pick;
  try {
    await api("/api/predict", { method: "POST", body: JSON.stringify({ personId: store.person.id, matchId, pick }) });
    loadMatches();
  } catch (err) {
    alert(err.message);
    loadMatches();
  }
}

// ---------- schedule (full program, view-only) ----------
function dayHeading(iso) {
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  if (+day === +today) return "Today";
  if (+day === +today + 86400000) return "Tomorrow";
  return d.toLocaleDateString("en-US", { weekday: "long", day: "numeric", month: "long" });
}

async function loadSchedule() {
  const { matches } = await api(`/api/schedule?personId=${store.person.id}`);
  const wrap = $("#schedule-list");
  const empty = $("#schedule-empty");
  if (!matches.length) { wrap.innerHTML = ""; empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");
  wrap.innerHTML = `<div class="sch-rows">${matches.map(renderScheduleCard).join("")}</div>`;
  wrap.querySelectorAll("[data-goto-group]").forEach((el) => {
    const go = () => gotoGroup(el.dataset.gotoGroup);
    el.addEventListener("click", go);
    el.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); go(); } });
  });
}
// jump from Schedule to a specific group on the Groups page
let pendingGroupScroll = null;
function gotoGroup(g) {
  pendingGroupScroll = g;
  groupTab = "standings";
  switchView("standings");
}

// read-only full-width schedule row: date/time · flags + "A v. B" · status pill
function renderScheduleCard(m) {
  const d = new Date(m.kickoff_time);
  const dateStr = d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
  const isLive = m.status === "IN_PLAY" || m.status === "PAUSED";
  const timeStr = isLive ? `LIVE${m.minute != null ? " " + m.minute + "'" : ""}` : d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  const hasScore = m.score_home != null && m.score_away != null;
  const pill = hasScore ? `${m.score_home}–${m.score_away}` : (m.stage === "knockout" ? (m.round || "Knockout") : `Group ${m.group}`);
  const toGroup = (m.stage === "group" && m.group) ? ` data-goto-group="${m.group}" role="button" tabindex="0" title="Open Group ${m.group}"` : "";
  return `
    <div class="schr${isLive ? " live" : ""}">
      <div class="schr-when"><span class="schr-date">${dateStr}</span><span class="schr-time">${timeStr}</span></div>
      <div class="schr-match">
        <span class="schr-flag">${flagCircle(m.team_a, m.flag_a, m.crest_a)}</span>
        <span class="schr-vs"><b>${m.team_a}</b> <em>v.</em> <b>${m.team_b}</b></span>
        <span class="schr-flag">${flagCircle(m.team_b, m.flag_b, m.crest_b)}</span>
      </div>
      <div class="schr-right"><span class="schr-pill${hasScore ? " score" : ""}${toGroup ? " link" : ""}"${toGroup}>${pill}</span></div>
    </div>`;
}

// ---------- champion ----------
let championSearch = "";
async function loadChampion() {
  const data = await api(`/api/champion?personId=${store.person.id}`);
  data.teams.forEach((t) => { champFlags[t.name] = t.flag; }); // remember flags for theming
  applyAccentForTeam(data.pick); // tint the site with your champion's colours
  myChampionTeam = data.pick || null;
  setChampVar(myChampionTeam); // header flag + page colour on the champion view
  const locked = data.locked;
  const picked = data.teams.find((t) => t.name === data.pick);

  // showcase — poster of the chosen champion
  const stage = $("#champion-showcase");
  if (data.pick) {
    const won = data.winner ? (data.pick === data.winner ? `<span class="cs-won">Champion! +10</span>` : `<span class="cs-lost">Winner: ${data.winner}</span>`) : "";
    stage.className = "champ-showcase picked holo";
    stage.innerHTML = `<span class="holo-foil" aria-hidden="true"></span><div class="cs-flag-wrap">${flagCircle(data.pick, picked ? picked.flag : "", picked ? picked.crest : null)}</div><div class="cs-info"><div class="cs-eyebrow">Your pick to win it all</div><div class="cs-name">${data.pick}</div>${won}</div>`;
  } else {
    stage.className = "champ-showcase empty";
    stage.innerHTML = `<div class="cs-placeholder">Tap a team below to crown your champion</div>`;
  }

  // search box
  const search = $("#champion-search");
  if (search) {
    search.value = championSearch;
    search.disabled = locked;
    search.oninput = () => { championSearch = search.value; filterChampGrid(); };
  }

  // grid
  const grid = $("#champion-grid");
  grid.innerHTML = data.teams.map((t) => `
    <button class="team-tile${data.pick === t.name ? " sel" : ""}" data-team="${t.name.replace(/"/g, "&quot;")}" data-search="${t.name.toLowerCase()}" ${locked ? "disabled" : ""}>
      <span class="tt-flag-circle">${flagCircle(t.name, t.flag, t.crest)}</span>
      <span class="tt-name">${t.name}</span>
      <span class="tt-check">✓</span>
    </button>`).join("");
  grid.querySelectorAll(".team-tile").forEach((b) => {
    b.addEventListener("click", onChampionPick);
    if (POINTER_FINE && !locked) { // live colour preview while browsing teams
      b.addEventListener("mouseenter", () => setChampVar(b.dataset.team));
      b.addEventListener("mouseleave", () => setChampVar(myChampionTeam));
    }
  });
  filterChampGrid();

  if (data.winner && data.pick && data.pick === data.winner && !celebrated.has("champ")) { celebrated.add("champ"); fireConfetti(); }

  $("#champion-hint").textContent = locked
    ? "Champion pick is locked."
    : data.lockMode === "first_submission"
      ? "Worth 10 points. Locks the moment you pick — choose carefully!"
      : (data.lockAt ? `Worth 10 points. Tap a team. You can change it until ${new Date(data.lockAt).toLocaleDateString()}.` : "Worth 10 points. Tap a team. You can change it until the tournament's first kickoff.");
  $("#champion-msg").textContent = "";
}

// a World Cup trophy that fills with gold as your champion advances
const TROPHY_SIL = "M34,14 C34,54 48,74 60,74 C72,74 86,54 86,14 Z M55,74 L65,74 L63,100 L57,100 Z M46,100 L74,100 L80,122 L40,122 Z M36,122 L84,122 L84,132 L36,132 Z";
function renderChampionTrophy(pj) {
  const el = $("#champion-trophy"); if (!el) return;
  if (!pj || !pj.path) { el.innerHTML = ""; return; }
  const passed = pj.path.filter((n) => n.status === "advanced" || n.status === "champion").length;
  let fill = pj.champion ? 100 : Math.round((passed / pj.path.length) * 100);
  if (fill === 0 && pj.path.some((n) => n.status === "live")) fill = 7;
  const reached = [...pj.path].reverse().find((n) => n.status !== "pending" && n.status !== "skip");
  const cap = pj.champion ? "Champions! Cup is full" : reached ? `Reached: ${reached.label}` : "Group stage";
  el.innerHTML = `
    <svg class="ct-svg${pj.champion ? " full" : ""}" viewBox="0 0 120 150" style="--fill:${(fill / 100).toFixed(3)}" aria-label="${cap}">
      <defs><linearGradient id="ctliq" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6e3a0"/><stop offset="1" stop-color="#a6781f"/></linearGradient></defs>
      <clipPath id="ctclip"><path d="${TROPHY_SIL}"/></clipPath>
      <path d="${TROPHY_SIL}" fill="rgba(255,255,255,0.06)"/>
      <g clip-path="url(#ctclip)"><rect class="ct-liq" x="0" y="0" width="120" height="150" fill="url(#ctliq)"/></g>
      <path d="${TROPHY_SIL}" fill="none" stroke="#e8c879" stroke-width="2.6"/>
      <path d="M34,20 C12,24 12,50 38,55" fill="none" stroke="#e8c879" stroke-width="2.6"/>
      <path d="M86,20 C108,24 108,50 82,55" fill="none" stroke="#e8c879" stroke-width="2.6"/>
    </svg>
    <div class="ct-cap">${cap} · <b>${fill}%</b></div>`;
}

// how-it-works guide (accordion) shown in the profile drawer
function guideBlock() {
  const item = (title, body) => `<details class="gd"><summary>${title}</summary><div class="gd-body">${body}</div></details>`;
  return `<h3 class="pf-h">How it works</h3>
    <p class="muted small" style="margin:0 0 12px">Tap a section to expand.</p>
    ${item("Logging in", "You sign in with a <b>name</b> and a <b>4–8 digit PIN</b> — both are required. The PIN keeps your name yours, so use the same two every time you come back. Forgot which name? It's the same one your friends see on the leaderboard.")}
    ${item("Predicting matches", "On the <b>Matches</b> tab, tap a team's flag to predict it wins — or tap <b>DRAW</b> in the middle. Your pick gets a gold ring. You can change it freely until kickoff, when it locks.")}
    ${item("Points", "You earn points for each <b>correct match result</b> and a bigger bonus for correctly picking the <b>tournament champion</b>. Knockout matches may count double. See the exact numbers in the <b>Leaderboard</b> legend.")}
    ${item("Champion pick", "On the <b>Champion</b> tab, crown the team you think wins the whole tournament. It's worth the most points and locks at the first kickoff, so choose carefully.")}
    ${item("Betting & bankroll", "Everyone starts with the same virtual € to bet with. On a match, after you tap a pick you can stake money at the <b>real odds</b>; win the bet and your balance grows. This is separate from points — pure bragging rights — and shows under <b>Leaderboard → Money</b>.")}
    ${item("Leaderboard", "Two views: <b>Points</b> (prediction skill) and <b>Money</b> (betting balance + profit). Top 3 stand on the podium; you're highlighted, and gold / silver / bronze rings mark the top three everywhere they appear.")}
    ${item("Picks", "See <b>who picked what</b> for every upcoming match — tap a card to flip it and reveal the split — plus everyone's champion pick.")}
    ${item("Groups & Schedule", "<b>Groups</b> shows each group's fixtures and a live standings table (3 pts a win, 1 a draw). <b>Schedule</b> is the full match programme.")}
    ${item("Your profile", "Your stats, accuracy, streaks and recent form live here, plus your <b>betting style</b>. Tap the ✎ by your name to change your name, PIN <b>or photo</b>.")}
    ${item("Team chat", "Open the floating <b>chat</b> (bottom-right). Type <b>@</b> to mention someone, and tap 🙂 for emoji. Hover or long-press a message for actions: <b>↩ reply</b> quotes it (tap the quote to jump back), and on your own messages <b>✎ edit</b> (shows an \"edited\" tag) and <b>✕ delete</b>. A red <b>“New messages”</b> line marks where you left off, and <b>“Seen by…”</b> shows who's read your last message.")}
    ${item("Reactions & online", "React with emojis on chat messages, picks and matches — tap the 🙂 to add one, tap again to remove. A green dot on someone's avatar (and a count in the chat header) means they're <b>online</b> right now.")}`;
}

// champion's bracket run: Groups → R32 → R16 → QF → SF → Final
function renderChampionPath(pj) {
  const el = $("#champion-path"); if (!el) return;
  if (!pj || !pj.path) { el.innerHTML = ""; return; }
  const icon = { advanced: "✓", champion: "★", out: "✕" };
  const shortL = (l) => ({ "Group stage": "Groups", "Round of 32": "R32", "Round of 16": "R16", "Quarter-final": "QF", "Semi-final": "SF", "Final": "Final" }[l] || l);
  const nodes = pj.path.map((n, i) => {
    const reached = n.status === "advanced" || n.status === "champion";
    const line = i < pj.path.length - 1 ? `<span class="cp-line${reached ? " done" : ""}"></span>` : "";
    return `<div class="cp-node ${n.status}"><span class="cp-dot">${icon[n.status] || ""}</span><span class="cp-lbl">${shortL(n.label)}</span></div>${line}`;
  }).join("");
  const tag = pj.champion ? "Lifted the cup!" : pj.eliminated ? "Knocked out" : "Still alive";
  const tagCls = pj.champion ? "win" : pj.eliminated ? "out" : "live";
  el.innerHTML = `<div class="cp-head">Champion's run <span class="cp-tag ${tagCls}">${tag}</span></div><div class="cp-track">${nodes}</div>`;
}

function filterChampGrid() {
  const q = (championSearch || "").trim().toLowerCase();
  $$("#champion-grid .team-tile").forEach((el) => {
    el.style.display = !q || el.dataset.search.includes(q) ? "" : "none";
  });
}

async function onChampionPick(e) {
  const team = e.currentTarget.dataset.team;
  try {
    await api("/api/champion", { method: "POST", body: JSON.stringify({ personId: store.person.id, team }) });
    await loadChampion();
    const stage = $("#champion-showcase");
    if (stage) { stage.classList.remove("pop"); void stage.offsetWidth; stage.classList.add("pop"); }
  } catch (err) {
    $("#champion-msg").textContent = err.message;
    $("#champion-msg").className = "error";
  }
}

// ---------- leaderboard (Points / Money toggle, video background) ----------
let lbCache = null, lbMode = "points";
async function loadLeaderboard() {
  const [lb, bk] = await Promise.all([api("/api/leaderboard"), api("/api/bankroll").catch(() => ({ rows: [] }))]);
  const bankByPid = {};
  (bk.rows || []).forEach((r) => { bankByPid[r.person_id] = r; });
  computeRankMap(lb.leaderboard);
  lbCache = { rows: lb.leaderboard, config: lb.config, serverTime: lb.serverTime, bankByPid, startingBankroll: bk.startingBankroll };
  renderLeaderboard();
}
function renderLeaderboard() {
  if (!lbCache) return;
  const { rows, config, serverTime } = lbCache;
  const podium = $("#lb-podium"), list = $("#lb-list");
  $$(".lb-tab").forEach((t) => t.classList.toggle("active", t.dataset.lb === lbMode));
  const upd = $("#lb-updated");
  if (!rows.length) { podium.innerHTML = `<div class="empty">No players yet.</div>`; list.innerHTML = ""; if (upd) upd.textContent = ""; buildLegend(config); return; }

  const money = lbMode === "money";
  const bankByPid = lbCache.bankByPid || {};
  const bank = (r) => bankByPid[r.person_id] || { profit: 0, open: 0, wins: 0 };
  const val = (r) => (money ? r.balance : r.points);
  const sorted = [...rows].sort((a, b) => val(b) - val(a) || (money ? bank(b).wins - bank(a).wins : b.correct - a.correct) || a.name.localeCompare(b.name));
  let rank = 0, last = null;
  sorted.forEach((r, i) => { const v = val(r); if (v !== last) { rank = i + 1; last = v; } r._rank = rank; });
  const mineRow = sorted.find((r) => r.person_id === store.person.id);
  setRankBadge(mineRow ? mineRow._rank : null);
  const maxV = Math.max(1, val(sorted[0]));
  const fmtM = (n) => "€" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  const bigVal = (r) => (money ? fmtM(r.balance) : r.points);
  // money sub = wins + stake in play; points sub = balance
  const subLine = (r) => {
    if (!money) return `💰 ${fmtM(r.balance)}`;
    const b = bank(r);
    return `${b.wins} won · ${fmtM(b.open)} in play`;
  };
  // profit ▲/▼ chip (money mode only)
  const profitTag = (r) => {
    const p = bank(r).profit || 0;
    return p > 0 ? `<span class="tr-up">▲ ${fmtM(p)}</span>` : p < 0 ? `<span class="tr-down">▼ ${fmtM(Math.abs(p))}</span>` : `<span class="tr-eq">€0</span>`;
  };
  const pidAttr = (r) => (money ? "" : ` data-pid="${r.person_id}"`);

  const top = sorted.slice(0, 3);
  const order = [top[1], top[0], top[2]].filter(Boolean);
  const cardVid = ""; // videos removed
  const gapTxt = (behind) => (money ? fmtM(behind) : `${behind} pts`);

  podium.innerHTML = order.map((r, i) => {
    const me = r.person_id === store.person.id ? " mine" : "";
    const behind = maxV - val(r);
    return `<div class="lb-pod p${r._rank}${me}" data-profile="${r.person_id}" role="button" tabindex="0" title="View ${r.name}'s profile" style="animation-delay:${i * 0.09}s">
      ${cardVid}
      <div class="pod-card">
        ${r._rank === 1 ? '<div class="pod-crown">👑</div>' : ""}
        <div class="pod-ava">${avatarMark(r.name, r.photo)}${onlineDot(r.person_id)}</div>
        <div class="pod-name">${r.name}</div>
        <div class="lb-pts pod-pts"${pidAttr(r)}>${bigVal(r)}</div>
        <div class="pod-sub">${money ? `${bank(r).wins} bets won` : `@${r.correct} correct`}</div>
        <div class="pod-money">${money ? profitTag(r) : subLine(r)}</div>
      </div>
      <div class="pod-base">${r._rank}</div>
    </div>`;
  }).join("");

  const rest = sorted.slice(3);
  list.innerHTML = rest.map((r, i) => {
    const me = r.person_id === store.person.id ? " mine" : "";
    const pct = Math.round((val(r) / maxV) * 100);
    const behind = maxV - val(r);
    const prev = lastPts[r.person_id];
    const trend = money
      ? profitTag(r)
      : (prev != null && prev !== r.points) ? (r.points > prev ? `<span class="tr-up">▲</span>` : `<span class="tr-down">▼</span>`) : `<span class="tr-eq">–</span>`;
    return `<button class="lb-row${money ? " money" : ""}${me}" data-profile="${r.person_id}" title="View ${r.name}'s profile" style="animation-delay:${i * 0.04}s">
      ${cardVid}
      <span class="lb-rank">${r._rank}</span>
      <span class="lb-ava">${avatarMark(r.name, r.photo)}${onlineDot(r.person_id)}</span>
      <span class="lb-nm">${r.name}${me ? ' <span class="lb-you">you</span>' : ""}<span class="lb-bar" title="−${gapTxt(behind)} to top"><i style="width:${pct}%"></i></span><span class="lb-money">${subLine(r)}</span></span>
      <span class="lb-pts"${pidAttr(r)}>${bigVal(r)}</span>
      <span class="lb-trend">${trend}</span>
      <span class="lb-caret">›</span>
    </button>`;
  }).join("");

  if (upd) upd.textContent = `Updated ${new Date(serverTime).toLocaleTimeString()}`;
  const legH = $(".legend h3"), legL = $("#legend-list");
  if (money && legL) {
    if (legH) legH.textContent = "How the bankroll works";
    const start = lbCache.startingBankroll;
    legL.innerHTML = `<li>Everyone starts with <b>${start != null ? fmtM(start) : "the same"}</b> of virtual cash to bet with.</li>`
      + `<li><b>▲ / ▼</b> — profit or loss against that starting bankroll.</li>`
      + `<li><b>in play</b> — stake tied up in bets that haven't settled yet.</li>`
      + `<li>Bets are placed on the Matches tab; this board is bragging rights only.</li>`;
  } else {
    if (legH) legH.textContent = "How points work";
    buildLegend(config);
  }
  if (!money) animateCounts();
}
(function lbToggleSetup() {
  $$(".lb-tab").forEach((b) => b.addEventListener("click", () => { lbMode = b.dataset.lb; renderLeaderboard(); }));
})();

// ---------- player profile ----------
async function loadProfile() {
  const id = profileTarget || store.person.id;
  const wrap = $("#profile-content");
  let d;
  try { d = await api(`/api/profile?personId=${id}`); }
  catch (e) { wrap.innerHTML = `<p class="empty">Couldn't load this profile.</p>`; return; }

  const isMe = d.person.id === store.person.id;
  if (isMe && d.rank) setRankBadge(d.rank);
  const teamColor = (d.champion && TEAM_COLORS[d.champion.team]) || "#a6781f";

  // recent-form dots (history is newest-first → reverse so newest is on the right)
  const recent = d.history.slice(0, 12).reverse();
  const formDots = recent.length
    ? recent.map((h, i) => `<span class="fg-dot ${h.correct ? "ok" : "no"}${i === recent.length - 1 ? " last" : ""}" style="animation-delay:${i * 0.05}s" title="${h.team_a} v ${h.team_b}: ${h.correct ? "✓" : "✗"}"></span>`).join("")
    : `<span class="muted small">No results yet</span>`;
  const recentBlock = `
    <div class="pf-form">
      <div class="pf-form-side" style="flex:1">
        <div class="pf-form-h">Recent form</div>
        <div class="pf-form-dots">${formDots}</div>
        <div class="pf-form-sub muted small">${d.correct}/${d.decided} correct${d.bestStreak ? ` · best run ${d.bestStreak}` : ""}</div>
      </div>
    </div>`;

  // betting style: average stake vs bankroll → Cautious / Balanced / Reckless
  // betting summary block (balance / profit / in play / won)
  const bt = d.betting || {};
  const eur = (n) => "€" + Number(n || 0).toLocaleString(undefined, { maximumFractionDigits: 0 });
  const profitCls = bt.profit > 0 ? "up" : bt.profit < 0 ? "down" : "eq";
  const profitStr = bt.profit > 0 ? `▲ ${eur(bt.profit)}` : bt.profit < 0 ? `▼ ${eur(Math.abs(bt.profit))}` : "€0";
  const betBlock = bt.bets
    ? `<h3 class="pf-h">Bets</h3>
       <div class="bet-stats">
         <div class="bet-stat"><b>${eur(bt.balance)}</b><span>Balance</span></div>
         <div class="bet-stat ${profitCls}"><b>${profitStr}</b><span>Profit / loss</span></div>
         <div class="bet-stat"><b>${eur(bt.inPlay)}</b><span>${bt.openCount} bet${bt.openCount === 1 ? "" : "s"} in play</span></div>
         <div class="bet-stat"><b>${bt.wins}/${bt.settled}</b><span>Bets won</span></div>
       </div>
       <p class="muted small" style="margin:10px 0 0">${bt.bets} bet${bt.bets === 1 ? "" : "s"} placed · ${eur(bt.staked)} staked in total.</p>`
    : `<h3 class="pf-h">Bets</h3><p class="muted small">No bets placed yet.</p>`;

  const risk = d.risk;
  const riskDesc = {
    Cautious: "Small, careful stakes — you protect your bankroll.",
    Balanced: "Measured stakes — a healthy balance of risk and reward.",
    Reckless: "Big swings — high stakes, high drama.",
  };
  const riskBlock = risk
    ? `<h3 class="pf-h">Betting style</h3>
       <div class="rk-card">
         <div class="rk-head"><span class="rk-type ${risk.type.toLowerCase()}">${risk.type}</span><span class="rk-avg">avg stake €${risk.avgStake.toLocaleString()} · ${risk.pct}% of bankroll</span></div>
         <div class="rk-meter"><span class="rk-marker" style="left:${Math.min(risk.pct, 12) / 12 * 100}%"></span></div>
         <div class="rk-scale"><span>Cautious</span><span>Balanced</span><span>Reckless</span></div>
         <p class="rk-desc muted small">${riskDesc[risk.type]}</p>
       </div>`
    : `<h3 class="pf-h">Betting style</h3>
       <p class="muted small">No bets yet — your betting style appears once you start placing bets.</p>`;

  const rows = d.history.length
    ? d.history.map((h) => {
        const resMap = { a_win: h.team_a, draw: "Draw", b_win: h.team_b };
        const pickMap = { a_win: h.team_a, draw: "Draw", b_win: h.team_b };
        const score = (h.score_home != null && h.score_away != null) ? `${h.score_home}–${h.score_away}` : "";
        return `<div class="pf-row ${h.correct ? "ok" : "no"}">
          <span class="pf-mark">${h.correct ? "✓" : "✗"}</span>
          <span class="pf-match">${mark(h.flag_a, h.crest_a)} ${h.team_a} <span class="muted">${score || "v"}</span> ${h.team_b} ${mark(h.flag_b, h.crest_b)}</span>
          <span class="pf-pick">picked <b>${pickMap[h.pick]}</b></span>
          <span class="pf-res">${resMap[h.result]}</span>
        </div>`;
      }).join("")
    : `<p class="muted small" style="padding:8px 2px">No finished matches yet — history fills in as results come in.</p>`;

  const champ = d.champion;
  const subParts = [];
  if (champ) subParts.push(`${champ.flag || ""} ${champ.team}${champ.correct ? " ✓" : ""}`.trim());
  subParts.push(d.rank ? `Rank #${d.rank}` : "Unranked");
  const subtitle = subParts.join(" · ");
  const bal = "€" + Number(d.bankroll).toLocaleString();
  // cover = the chosen champion team's flag (full-bleed), tinted for contrast
  const champCode = champ ? (FLAG_SUBDIV[champ.team] || flagEmojiToCode(champ.flag)) : null;
  const heroFlag = champCode ? `<img class="np-hero-flag" src="https://flagcdn.com/w640/${champCode}.png" alt="">` : "";

  wrap.innerHTML = `
    <div class="np">
      <div class="np-hero${heroFlag ? " has-flag" : ""}" style="--pf-accent:${teamColor}">
        ${heroFlag}
        <span class="np-hero-tint"></span>
        <svg class="np-deco" viewBox="0 0 400 160" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
          <g fill="none" stroke="#fff" stroke-width="7" stroke-linecap="round" opacity="0.22"><path d="M40 42 l22 22 M62 42 l-22 22"/><path d="M336 28 l20 20 M356 28 l-20 20"/></g>
          <g fill="#fff" opacity="0.15"><path d="M150 0 a40 40 0 0 1 80 0 z"/><ellipse cx="305" cy="120" rx="13" ry="21" transform="rotate(24 305 120)"/><ellipse cx="78" cy="118" rx="11" ry="19" transform="rotate(-22 78 118)"/></g>
          <g fill="none" stroke="#fff" stroke-width="4" stroke-linecap="round" opacity="0.18"><path d="M250 64 l30 -30 M262 74 l30 -30 M274 84 l30 -30"/></g>
        </svg>
      </div>
      <div class="np-ava${d.rank >= 1 && d.rank <= 3 ? " rank-" + d.rank : ""}">${avatarMark(d.person.display_name, d.person.photo)}${onlineDot(d.person.id)}</div>
      <h2 class="np-name">${d.person.display_name}${isMe ? ' <span class="np-you">you</span> <button class="np-edit" type="button" title="Edit profile" aria-label="Edit profile">✎</button>' : ""}</h2>
      <div class="np-sub">${subtitle}</div>
      ${isMe ? `<form id="np-editform" class="np-editform hidden">
        <div class="npe-photo">
          <span class="npe-prev" id="npe-prev">${avatarMark(d.person.display_name, d.person.photo)}</span>
          <label class="npe-photobtn">Choose photo<input id="npe-file" type="file" accept="image/*" /></label>
          <button type="button" id="npe-rmphoto" class="npe-ghost${d.person.photo ? "" : " hidden"}">Remove</button>
        </div>
        <input id="npe-name" type="text" maxlength="40" value="${escapeHtml(d.person.display_name)}" placeholder="Display name" autocomplete="off" />
        ${d.person.hasPin ? `<input id="npe-cur" type="password" inputmode="numeric" maxlength="8" placeholder="Current PIN" autocomplete="off" />` : ""}
        <input id="npe-new" type="password" inputmode="numeric" maxlength="8" placeholder="${d.person.hasPin ? "New PIN (blank = keep)" : "Set a PIN (optional)"}" autocomplete="off" />
        <div class="npe-row"><button type="submit">Save</button><button type="button" id="npe-cancel" class="npe-ghost">Cancel</button></div>
        <p id="npe-err" class="error"></p>
      </form>` : ""}
      <div class="np-stats">
        <div class="np-st"><b class="np-stv" data-count="${d.points}">0</b><span>Points</span></div>
        <div class="np-st"><b class="np-stv" data-count="${d.accuracy}" data-suffix="%">0%</b><span>Accuracy</span></div>
        <div class="np-st"><b class="np-stv">${bal}</b><span>Balance</span></div>
      </div>
      <div class="np-tabs">
        <button class="np-tab active" data-pt="form">Form</button>
        <button class="np-tab" data-pt="style">Style</button>
        <button class="np-tab" data-pt="guide">Guide</button>
      </div>
      <div class="np-panel" data-panel="form">
        ${recentBlock}
        ${d.history.length ? `<div class="pf-hfilter">
          <button class="pf-fchip active" data-f="all">All</button>
          <button class="pf-fchip" data-f="ok">✓ Hits</button>
          <button class="pf-fchip" data-f="no">✗ Misses</button>
        </div>` : ""}
        <div class="pf-list">${rows}</div>
      </div>
      <div class="np-panel hidden" data-panel="style">${betBlock}${riskBlock}</div>
      <div class="np-panel hidden" data-panel="guide">${guideBlock()}</div>
    </div>`;

  animateProfile();

  // edit own profile (name + PIN)
  const editBtn = wrap.querySelector(".np-edit"), editForm = wrap.querySelector("#np-editform");
  if (editBtn && editForm) {
    let pendingPhoto; // undefined = unchanged, "" = remove, dataURL = new
    editBtn.addEventListener("click", () => { editForm.classList.toggle("hidden"); if (!editForm.classList.contains("hidden")) wrap.querySelector("#npe-name").focus(); });
    wrap.querySelector("#npe-cancel").addEventListener("click", () => editForm.classList.add("hidden"));
    const prevEl = wrap.querySelector("#npe-prev"), fileEl = wrap.querySelector("#npe-file"), rmEl = wrap.querySelector("#npe-rmphoto");
    if (fileEl) fileEl.addEventListener("change", () => {
      const f = fileEl.files && fileEl.files[0]; if (!f) return;
      resizeImage(f, 256, (url) => { pendingPhoto = url; prevEl.innerHTML = `<span class="ava"><img class="ava-photo" src="${url}" alt=""></span>`; if (rmEl) rmEl.classList.remove("hidden"); });
    });
    if (rmEl) rmEl.addEventListener("click", () => { pendingPhoto = ""; prevEl.innerHTML = avatarMark(d.person.display_name, null); rmEl.classList.add("hidden"); });
    editForm.addEventListener("submit", async (e) => {
      e.preventDefault();
      const err = wrap.querySelector("#npe-err"); err.textContent = "";
      const newName = wrap.querySelector("#npe-name").value.trim();
      const curEl = wrap.querySelector("#npe-cur"), newEl = wrap.querySelector("#npe-new");
      const body = { personId: store.person.id, newName };
      if (curEl) body.pin = curEl.value.trim();
      if (newEl && newEl.value.trim()) body.newPin = newEl.value.trim();
      if (pendingPhoto !== undefined) body.newPhoto = pendingPhoto;
      try {
        const resp = await api("/api/profile/update", { method: "POST", body: JSON.stringify(body) });
        if (resp.token) store.token = resp.token; // PIN may have changed → refresh token
        const pp = store.person; pp.display_name = resp.person.display_name; pp.photo = resp.person.photo; store.person = pp;
        $("#who-name").textContent = resp.person.display_name;
        $("#who-avatar").innerHTML = avatarMark(resp.person.display_name, resp.person.photo);
        loadProfile();
      } catch (e2) { err.textContent = e2.message; }
    });
  }

  // tab switching (Form / Rivalries / Style)
  wrap.querySelectorAll(".np-tab").forEach((t) => t.addEventListener("click", () => {
    wrap.querySelectorAll(".np-tab").forEach((x) => x.classList.remove("active"));
    t.classList.add("active");
    const p = t.dataset.pt;
    wrap.querySelectorAll(".np-panel").forEach((pan) => pan.classList.toggle("hidden", pan.dataset.panel !== p));
  }));

  // history filter chips
  const hf = wrap.querySelector(".pf-hfilter");
  if (hf) hf.querySelectorAll(".pf-fchip").forEach((chip) => chip.addEventListener("click", () => {
    hf.querySelectorAll(".pf-fchip").forEach((c) => c.classList.remove("active"));
    chip.classList.add("active");
    const f = chip.dataset.f;
    wrap.querySelectorAll(".pf-row").forEach((r) => {
      r.style.display = (f === "all" || r.classList.contains(f)) ? "" : "none";
    });
  }));
}

// count-up stats + animated accuracy ring on profile open
function animateProfile() {
  const wrap = $("#profile-content");
  if (!wrap) return;
  const ease = (k) => k * (2 - k);
  const countTo = (el, target, dur, suffix) => {
    if (REDUCE) { el.textContent = target + (suffix || ""); return; }
    const t0 = performance.now();
    (function step(now) {
      const k = Math.min(1, (now - t0) / dur);
      el.textContent = Math.round(target * ease(k)) + (suffix || "");
      if (k < 1) requestAnimationFrame(step); else el.textContent = target + (suffix || "");
    })(t0);
  };
  wrap.querySelectorAll("[data-count]").forEach((el) => countTo(el, Number(el.dataset.count) || 0, 800, el.dataset.suffix || ""));
}

// ---------- bankroll (virtual betting standings) ----------
async function loadBankroll() {
  const { rows, startingBankroll } = await api(`/api/bankroll?personId=${store.person.id}`);
  const intro = $("#bankroll-intro");
  if (intro && startingBankroll != null) intro.textContent = `Everyone starts with €${Number(startingBankroll).toLocaleString()}. Bet on matches at the odds — just for bragging rights, the points table is separate.`;
  const wrap = $("#bankroll-list"), empty = $("#bankroll-empty");
  if (!rows.length) { wrap.innerHTML = ""; empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");
  const fmt = (n) => "€" + Number(n).toLocaleString(undefined, { maximumFractionDigits: 2 });
  wrap.innerHTML = `<div class="bk-list">` + rows.map((r) => {
    const me = r.person_id === store.person.id ? " mine" : "";
    const prof = r.profit > 0 ? `<span class="bk-up">▲ ${fmt(r.profit)}</span>`
      : r.profit < 0 ? `<span class="bk-down">▼ ${fmt(Math.abs(r.profit))}</span>`
      : `<span class="bk-eq">€0</span>`;
    return `<button class="bk-row${me}" data-profile="${r.person_id}" title="View ${r.name}'s profile">
      <span class="bk-rank">${r.rank}</span>
      <span class="bk-ava${rankRing(r.person_id)}">${avatarMark(r.name, r.photo)}${onlineDot(r.person_id)}</span>
      <span class="bk-nm">${r.name}${me ? ' <span class="lb-you">you</span>' : ""}<span class="bk-sub">${r.wins} won · ${fmt(r.open)} in play</span></span>
      <span class="bk-bal">${fmt(r.balance)}</span>
      <span class="bk-prof">${prof}</span>
    </button>`;
  }).join("") + `</div>`;
}

function buildLegend(config) {
  const items = [
    `<li><b>${config.matchPoints}</b> ${config.matchPoints === 1 ? "point" : "points"} — correct match outcome (Team A win / Draw / Team B win)</li>`,
    `<li><b>${config.championPoints}</b> points — correctly picking the tournament champion</li>`,
  ];
  if (config.knockoutDouble) items.push(`<li><b>×2</b> — knockout matches count double</li>`);
  items.push(`<li>predictions lock <b>${config.lockLeadHours || 0}h</b> before kickoff</li>`);
  $("#legend-list").innerHTML = items.join("");
}

// odometer points: rolling digits when a player's points change
const lastPts = {};
const OD_DIGITS = "0123456789".split("").map((n) => `<span>${n}</span>`).join("");
function buildOdometer(el, value, roll) {
  const chars = String(value).split("");
  el.classList.add("odo");
  el.innerHTML = chars.map((ch) => {
    if (ch < "0" || ch > "9") return `<span class="od-sep">${ch}</span>`;
    const d = Number(ch);
    return `<span class="od-col"><span class="od-strip" style="transform:translateY(${roll ? 0 : -d * 10}%)">${OD_DIGITS}</span></span>`;
  }).join("");
  if (!roll) return;
  requestAnimationFrame(() => {
    const strips = el.querySelectorAll(".od-strip");
    let di = 0;
    chars.forEach((ch) => {
      if (ch < "0" || ch > "9") return;
      const strip = strips[di];
      if (strip) { strip.style.transitionDelay = (di * 0.05) + "s"; strip.style.transform = `translateY(-${Number(ch) * 10}%)`; }
      di++;
    });
  });
}
function animateCounts() {
  $$(".lb-pts").forEach((el) => {
    const pid = el.dataset.pid;
    const target = Number((el.textContent || "").replace(/\D/g, "")) || 0;
    const from = lastPts[pid];
    lastPts[pid] = target;
    buildOdometer(el, target, !REDUCE && (from == null || from !== target));
  });
}

// ---------- picks (who picked what) ----------
// ---------- emoji reactions (on champion picks & matches) ----------
const RX_EMOJI = ["🔥", "😂", "😱", "🤡", "👏", "💀"];
function reactionBar(key, reactions) {
  const chips = (reactions || []).map((g) => {
    const mine = (g.by || []).includes(store.person.id) ? " mine" : "";
    const who = (g.names || []).join(", ").replace(/"/g, "");
    return `<button type="button" class="rx-chip${mine}" data-emoji="${g.emoji}" title="${who}">${g.emoji} <span class="rx-n">${g.count}</span></button>`;
  }).join("");
  const palette = RX_EMOJI.map((e) => `<button type="button" class="rx-emoji" data-emoji="${e}">${e}</button>`).join("");
  return `<div class="rx" data-key="${key}">
    <button type="button" class="rx-add" aria-label="Add reaction">☺</button>
    <div class="rx-palette">${palette}</div>
    ${chips}
  </div>`;
}
async function doReact(key, emoji) {
  try {
    await api("/api/react", { method: "POST", body: JSON.stringify({ personId: store.person.id, key, emoji }) });
    if (key.startsWith("chatmsg:")) chatRefresh(); else refresh(false);
  } catch (e) { /* ignore transient errors */ }
}
document.addEventListener("click", (e) => {
  const add = e.target.closest(".rx-add");
  if (add) {
    const wrap = add.closest(".rx"); const wasOpen = wrap.classList.contains("open");
    $$(".rx.open").forEach((el) => el.classList.remove("open"));
    if (!wasOpen) wrap.classList.add("open");
    return;
  }
  const btn = e.target.closest(".rx-emoji, .rx-chip");
  if (btn) {
    const wrap = btn.closest(".rx");
    if (wrap) { wrap.classList.remove("open"); doReact(wrap.dataset.key, btn.dataset.emoji); }
  } else if (!e.target.closest(".rx")) {
    $$(".rx.open").forEach((el) => el.classList.remove("open"));
  }
});

async function loadPicks() {
  const { matches, champions } = await api("/api/picks");

  // ---- champion picks → trophy cards + a "group favourite" banner ----
  const champWrap = $("#picks-champions");
  const champFav = $("#champion-fav");
  if (!champions.length) {
    if (champFav) champFav.innerHTML = "";
    champWrap.innerHTML = `<p class="muted small">No champion picks yet.</p>`;
  } else {
    // tally backers per team to surface the group's favourite + per-card counts
    const tally = {};
    champions.forEach((c) => { tally[c.team] = (tally[c.team] || 0) + 1; });
    const favTeam = Object.keys(tally).sort((a, b) => tally[b] - tally[a])[0];
    const favC = champions.find((c) => c.team === favTeam);
    if (champFav) {
      champFav.innerHTML = tally[favTeam] > 1
        ? `<div class="cf-banner"><span class="cf-txt">Group favourite to lift the cup</span><span class="cf-team">${favC.flag || ""} <b>${favTeam}</b></span><span class="cf-count">${tally[favTeam]} backers</span></div>`
        : "";
    }
    champWrap.innerHTML = champions.map((c) => {
      const me = c.person_id === store.person.id ? " me" : "";
      const backers = tally[c.team];
      const shared = backers > 1 ? `<span class="mh-tag">${backers} backers</span>` : "";
      return `<div class="cpx holo${me}" style="--cp-accent:${champColor(c.team)}">
        <div class="mh">
          <div class="mh-burst" aria-hidden="true"></div>
          <span class="holo-foil" aria-hidden="true"></span>
          <div class="mh-tags"><span class="mh-tag">Champion pick</span>${shared}</div>
          <div class="cpx-stage"><span class="cpx-flag">${flagCircle(c.team, c.flag, c.crest)}</span></div>
          <div class="mh-labels"><span class="mh-code">${c.team}</span></div>
          <div class="cpx-foot">
            <span class="cpx-ava${rankRing(c.person_id)}" data-profile="${c.person_id}" title="View ${c.name}'s profile">${avatarMark(c.name, c.photo)}${onlineDot(c.person_id)}</span>
            <span class="cpx-name">${c.name}</span>
          </div>
        </div>
        <div class="cpx-rx">${reactionBar(`champ:${c.person_id}`, c.reactions)}</div>
      </div>`;
    }).join("");
  }

  // ---- per-match picks → consensus split bars ----
  const wrap = $("#picks-matches");
  const empty = $("#picks-empty");
  if (!matches.length) { wrap.innerHTML = ""; empty.classList.remove("hidden"); return; }
  empty.classList.add("hidden");

  wrap.innerHTML = `<div class="pk-grid">${matches.map(renderPickPoster).join("")}</div>`;

  // filter chips (All + each group present, KO last)
  const filters = $("#pk-filters");
  if (filters) {
    const groups = [...new Set(matches.map((m) => m.group || "KO"))]
      .sort((a, b) => (a === "KO" ? 1 : b === "KO" ? -1 : a.localeCompare(b)));
    filters.innerHTML = groups.length > 1
      ? `<button class="pk-fchip active" data-filter="all">All</button>` +
        groups.map((g) => `<button class="pk-fchip" data-filter="${g}">${g === "KO" ? "Knockout" : "Group " + g}</button>`).join("")
      : "";
    filters.querySelectorAll("[data-filter]").forEach((chip) => chip.addEventListener("click", () => {
      filters.querySelectorAll("[data-filter]").forEach((c) => c.classList.remove("active"));
      chip.classList.add("active");
      const f = chip.dataset.filter;
      wrap.querySelectorAll(".pkf").forEach((card) => {
        card.style.display = (f === "all" || card.dataset.group === f) ? "" : "none";
      });
    }));
  }

  // flip a card to reveal who picked what (ignore reaction & avatar clicks)
  wrap.querySelectorAll(".pkf-inner").forEach((inner) => {
    const flip = () => { const c = inner.closest(".pkf"); const f = c.classList.toggle("flipped"); inner.setAttribute("aria-pressed", f ? "true" : "false"); };
    inner.addEventListener("click", (e) => { if (e.target.closest("[data-profile]") || e.target.closest(".rx")) return; flip(); });
    inner.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); flip(); } });
  });
}

// lock countdown chip for the versus card
function vsLock(lockIso, locked) {
  if (locked) return `<span class="vs-lock">Locked</span>`;
  const ms = new Date(lockIso) - Date.now();
  if (ms <= 0) return `<span class="vs-lock">Locked</span>`;
  const h = Math.floor(ms / 3600000), mn = Math.floor((ms % 3600000) / 60000), d = Math.floor(h / 24);
  const txt = d >= 1 ? `${d}d ${h % 24}h` : h >= 1 ? `${h}h ${mn}m` : `${mn}m`;
  return `<span class="vs-lock open">locks in ${txt}</span>`;
}

// picks: compact neon flip-card — front = matchup + consensus, back = who picked
function renderPickPoster(m) {
  const groups = {
    a_win: m.picks.filter((p) => p.pick === "a_win"),
    draw: m.picks.filter((p) => p.pick === "draw"),
    b_win: m.picks.filter((p) => p.pick === "b_win"),
  };
  const nA = groups.a_win.length, nD = groups.draw.length, nB = groups.b_win.length;
  const total = m.picks.length;
  const pc = (n) => (total ? Math.round((n / total) * 100) : 0);
  const oddName = { a_win: m.team_a, draw: "Draw", b_win: m.team_b };

  let lead = "a_win", leadN = nA;
  for (const k of ["draw", "b_win"]) if (groups[k].length > leadN) { lead = k; leadN = groups[k].length; }
  const headline = !total ? "No picks yet — be the first"
    : leadN === total ? `Everyone's on ${oddName[lead]}`
    : leadN / total >= 0.66 ? `${pc(leadN)}% back ${oddName[lead]}`
    : "Split decision";

  // highlight my own pick (gold) and the actual result (green)
  const myPick = (m.picks.find((p) => p.person_id === store.person.id) || {}).pick || null;
  const cls = (val) => `${myPick === val ? " sel" : ""}${m.result === val ? " won" : ""}`;

  const hasScore = m.score_home != null && m.score_away != null;
  const isLive = m.status === "IN_PLAY" || m.status === "PAUSED";
  const centre = hasScore ? `${m.score_home}–${m.score_away}` : "VS";
  const when = isLive
    ? `<span class="mh-live">LIVE${m.minute != null ? " " + m.minute + "'" : ""}</span>`
    : `${fmtKickoff(m.kickoff_time)}${m.locked ? " · LOCKED" : ""}`;

  const seg = (key, c) => {
    const n = groups[key].length;
    if (!n) return "";
    return `<span class="vs-seg ${c}" style="flex:${n}" title="${pc(n)}%"></span>`;
  };
  const col = (key, code, c) => {
    const who = groups[key];
    const n = who.length;
    const isLead = total > 0 && n === leadN;
    return `<div class="pkb-col ${c}${isLead ? " lead" : ""}">
      <div class="pkb-code">${code}</div>
      <div class="pkb-pct">${pc(n)}<i>%</i></div>
      <div class="pkb-n">${n} ${n === 1 ? "pick" : "picks"}</div>
      <div class="pkb-avas">${who.length ? who.map((p) => `<span class="vs-ava${p.person_id === store.person.id ? " me" : ""}${rankRing(p.person_id)}" data-profile="${p.person_id}" title="View ${p.name}'s profile">${avatarMark(p.name, p.photo)}${onlineDot(p.person_id)}</span>`).join("") : '<span class="pkb-none">—</span>'}</div>
    </div>`;
  };
  const stageLabel = m.stage === "knockout" ? (m.round || "Knockout") : `Group ${m.group}`;
  const grp = m.group || "KO";

  return `
    <div class="pkf${m.locked ? " locked" : ""}" data-group="${grp}">
      <div class="pkf-inner" role="button" tabindex="0" aria-pressed="false" title="Tap to flip — see who picked">
        <div class="pkf-face pkf-front">
          <div class="mh-burst" aria-hidden="true"></div>
          <div class="pkf-tags"><span class="mh-tag">${stageLabel}</span><span class="mh-tag">${when}</span></div>
          <div class="pkf-row">
            <span class="pkf-flag${cls("a_win")}">${flagCircle(m.team_a, m.flag_a, m.crest_a)}</span>
            <span class="pkf-mid${cls("draw")}">${centre}</span>
            <span class="pkf-flag${cls("b_win")}">${flagCircle(m.team_b, m.flag_b, m.crest_b)}</span>
          </div>
          <div class="pkf-codes"><span class="mh-code">${teamCode(m.tla_a, m.team_a)}</span><span class="mh-code">${teamCode(m.tla_b, m.team_b)}</span></div>
          <div class="pk-bar small">${seg("a_win", "s-a")}${seg("draw", "s-d")}${seg("b_win", "s-b")}${total ? "" : '<span class="vs-seg s-empty" style="flex:1"></span>'}</div>
          <div class="pkf-front-foot"><span class="pkf-headline">${headline}</span><span class="pkf-flip">who picked ⤺</span></div>
        </div>
        <div class="pkf-face pkf-back">
          <div class="pkb-h">Who picked <span>${total} ${total === 1 ? "pick" : "picks"}</span></div>
          <div class="pkb-cols">
            ${col("a_win", teamCode(m.tla_a, m.team_a), "a")}
            ${col("draw", "DRAW", "d")}
            ${col("b_win", teamCode(m.tla_b, m.team_b), "b")}
          </div>
          <div class="pkb-foot">${reactionBar(`match:${m.id}`, m.reactions)}<span class="pkf-flip">⤺ flip back</span></div>
        </div>
      </div>
    </div>`;
}

// ---------- floating team chat ----------
const chat = { open: false, msgs: [], players: [], poll: null, typing: [], readers: [], lastSeen: Number(localStorage.getItem("wc_chat_seen") || 0), composing: null, dividerTs: 0, scrollToDivider: false };
function markChatSeen() { const ts = chatLatestTs(); if (!ts) return; api("/api/chat/seen", { method: "POST", body: JSON.stringify({ personId: store.person.id, ts }) }).catch(() => {}); }
function setChatPoll(ms) { clearInterval(chat.poll); chat.poll = setInterval(chatRefresh, ms); }
function chatLatestTs() { return chat.msgs.length ? new Date(chat.msgs[chat.msgs.length - 1].created_at).getTime() : 0; }
function chatTime(iso) { return new Date(iso).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }); }
function chatStart() {
  if (!$("#chat-toggle")) return;
  api("/api/players").then((d) => { chat.players = d.players || []; }).catch(() => {});
  chatRefresh();
  setChatPoll(8000);
}
// highlight @mentions of real players in already-escaped text
function highlightMentions(safe) {
  const names = (chat.players || []).map((p) => p.name).sort((a, b) => b.length - a.length);
  let out = safe;
  for (const n of names) {
    const esc = escapeHtml(n).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    out = out.replace(new RegExp("@" + esc + "(?![\\wА-Яа-я])", "gi"), (mm) => `<span class="cm-mention">${mm}</span>`);
  }
  return out;
}
async function chatRefresh() {
  let data; try { data = await api("/api/chat"); } catch { return; }
  chat.msgs = data.messages || [];
  chat.typing = (data.typing || []).filter((t) => t.id !== store.person.id);
  chat.readers = data.readers || [];
  if (chat.open) { renderChat(); renderTyping(); markChatSeen(); }
  updateChatBadge();
}
function renderTyping() {
  const el = $("#chat-typing"); if (!el) return;
  const names = (chat.typing || []).map((t) => t.name);
  if (!names.length) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const who = names.length === 1 ? `${names[0]} is typing`
    : names.length === 2 ? `${names[0]} and ${names[1]} are typing`
    : `${names.length} people are typing`;
  el.innerHTML = `<span class="ct-dots"><i></i><i></i><i></i></span><span class="ct-txt">${escapeHtml(who)}…</span>`;
  el.classList.remove("hidden");
}
function updateChatBadge() {
  const badge = $("#chat-badge"); if (!badge) return;
  const unread = chat.msgs.filter((m) => new Date(m.created_at).getTime() > chat.lastSeen && m.person_id !== store.person.id).length;
  if (chat.open || !unread) { badge.classList.add("hidden"); }
  else { badge.textContent = unread > 9 ? "9+" : unread; badge.classList.remove("hidden"); }
}
// quoted snippet shown above a message that's a reply
function chatQuote(reply) {
  if (!reply) return "";
  if (reply.deleted) return `<div class="cm-quote cm-quote-del"><span class="cm-quote-text"><i>deleted message</i></span></div>`;
  return `<div class="cm-quote" data-jump="${reply.id}"><span class="cm-quote-name">${escapeHtml(reply.name)}</span><span class="cm-quote-text">${escapeHtml(reply.text)}</span></div>`;
}
function renderChat() {
  const box = $("#chat-msgs"); if (!box) return;
  let dividerShown = false;
  const parts = [];
  if (!chat.msgs.length) {
    parts.push(`<p class="cm-empty muted small">No messages yet — say hi to the team.</p>`);
  } else {
    for (const m of chat.msgs) {
      // "new messages" divider before the first unread message from someone else
      if (!dividerShown && !m.system && m.person_id !== store.person.id && new Date(m.created_at).getTime() > chat.dividerTs) {
        parts.push(`<div class="cm-divider" id="cm-divider"><span>New messages</span></div>`);
        dividerShown = true;
      }
      const rx = `<div class="cm-rx">${reactionBar(`chatmsg:${m.id}`, m.reactions)}</div>`;
      if (m.system) {
        parts.push(`<div class="cm-sys-wrap">${chatQuote(m.reply)}<div class="cm-sys">${escapeHtml(m.text)}</div><div class="cm-actions"><button class="cm-reply" data-id="${m.id}" title="Reply">↩</button></div>${rx}</div>`);
        continue;
      }
      const me = m.person_id === store.person.id;
      const acts = `<div class="cm-actions">
            <button class="cm-reply" data-id="${m.id}" title="Reply">↩</button>
            ${me ? `<button class="cm-edit" data-id="${m.id}" title="Edit">✎</button><button class="cm-del" data-id="${m.id}" title="Delete">✕</button>` : ""}
          </div>`;
      parts.push(`<div class="cm ${me ? "me" : "them"}">
          ${me ? "" : `<span class="cm-ava${rankRing(m.person_id)}" data-profile="${m.person_id}" title="View ${escapeHtml(m.name)}'s profile">${avatarMark(m.name, m.photo)}${onlineDot(m.person_id)}</span>`}
          <div class="cm-body">
            ${me ? "" : `<span class="cm-name" data-profile="${m.person_id}">${escapeHtml(m.name)}</span>`}
            ${chatQuote(m.reply)}
            <div class="cm-bubble">${highlightMentions(escapeHtml(m.text))}</div>
            <span class="cm-time">${chatTime(m.created_at)}${m.edited ? ` · <span class="cm-edited">edited</span>` : ""}</span>
            ${acts}
            ${rx}
          </div>
        </div>`);
    }
  }
  box.innerHTML = parts.join("");
  // "seen by" under the last message if it's mine
  const last = chat.msgs[chat.msgs.length - 1];
  if (last && !last.system && last.person_id === store.person.id) {
    const lastTs = new Date(last.created_at).getTime();
    const seers = (chat.readers || []).filter((r) => r.id !== store.person.id && r.ts >= lastTs).map((r) => r.name);
    if (seers.length) {
      const txt = seers.length <= 2 ? seers.join(", ") : `${seers.length} people`;
      box.innerHTML += `<div class="cm-seen">Seen by ${escapeHtml(txt)}</div>`;
    }
  }
  // on first open with unread, land on the divider; otherwise stick to the bottom
  if (chat.scrollToDivider && dividerShown) {
    const d = box.querySelector("#cm-divider");
    if (d) d.scrollIntoView({ block: "center" }); else box.scrollTop = box.scrollHeight;
    chat.scrollToDivider = false;
  } else {
    box.scrollTop = box.scrollHeight;
  }
}
// reply/edit context bar above the input
function renderComposeCtx() {
  const el = $("#chat-ctx"); if (!el) return;
  const c = chat.composing;
  if (!c) { el.classList.add("hidden"); el.innerHTML = ""; return; }
  const label = c.mode === "edit" ? "Editing message" : `Replying to ${escapeHtml(c.name)}`;
  el.innerHTML = `<div class="cc-bar"><div class="cc-info"><span class="cc-label">${c.mode === "edit" ? "✎ " : "↩ "}${label}</span><span class="cc-snip">${escapeHtml(c.text || "")}</span></div><button type="button" class="cc-cancel" title="Cancel">✕</button></div>`;
  el.classList.remove("hidden");
}
function cancelCompose() {
  const wasEdit = chat.composing && chat.composing.mode === "edit";
  chat.composing = null;
  renderComposeCtx();
  if (wasEdit) { const i = $("#chat-input"); if (i) i.value = ""; }
}
function openChat() {
  chat.open = true;
  $("#chat-panel").classList.remove("hidden");
  $("#chat-toggle").classList.add("active");
  // remember where the unread divider goes (what they'd seen before opening)
  chat.dividerTs = chat.lastSeen || 0;
  chat.scrollToDivider = true;
  chat.lastSeen = chatLatestTs() || Date.now();
  localStorage.setItem("wc_chat_seen", chat.lastSeen);
  renderChat(); renderTyping(); updateChatBadge(); markChatSeen();
  setChatPoll(3000); // poll faster while open (for live typing + messages)
  document.body.classList.add("chat-open");
  setTimeout(() => { const i = $("#chat-input"); if (i) i.focus(); }, 50);
}
function closeChat() {
  chat.open = false; $("#chat-panel").classList.add("hidden"); $("#chat-toggle").classList.remove("active");
  document.body.classList.remove("chat-open");
  setChatPoll(8000);
}
const CHAT_EMOJI = ["😀","😂","😅","😉","😎","🥳","😭","😱","😡","🤔","🙄","😏","🤩","🥶","🤝","👍","👎","👏","🙌","💪","🙏","🔥","💯","⚽","🏆","🥅","🟥","🟨","🎉","☕","💰","🤡","💀","❤️","💔","👀","🤞","😬","🫡","🐐"];
(function chatSetup() {
  const toggle = $("#chat-toggle"), close = $("#chat-close"), form = $("#chat-form"), input = $("#chat-input");
  const emojiBtn = $("#chat-emoji-btn"), emojiPanel = $("#chat-emoji-panel");
  if (emojiPanel) emojiPanel.innerHTML = CHAT_EMOJI.map((e) => `<button type="button" class="ce" data-e="${e}">${e}</button>`).join("");
  if (emojiBtn) emojiBtn.addEventListener("click", () => emojiPanel.classList.toggle("hidden"));
  if (emojiPanel) emojiPanel.addEventListener("click", (e) => {
    const b = e.target.closest(".ce"); if (!b) return;
    const em = b.dataset.e, i = $("#chat-input");
    const s = i.selectionStart != null ? i.selectionStart : i.value.length;
    const en = i.selectionEnd != null ? i.selectionEnd : i.value.length;
    i.value = i.value.slice(0, s) + em + i.value.slice(en);
    const pos = s + em.length; i.focus(); try { i.setSelectionRange(pos, pos); } catch {}
  });
  document.addEventListener("click", (e) => {
    if (emojiPanel && !emojiPanel.classList.contains("hidden") && !e.target.closest("#chat-emoji-panel") && !e.target.closest("#chat-emoji-btn")) emojiPanel.classList.add("hidden");
  });
  // typing indicator ping (throttled)
  let lastPing = 0;
  const pingTyping = () => {
    const t = Date.now();
    if (t - lastPing < 2000) return;
    lastPing = t;
    api("/api/typing", { method: "POST", body: JSON.stringify({ personId: store.person.id }) }).catch(() => {});
  };
  if (input) input.addEventListener("input", () => { if (input.value.trim()) pingTyping(); });

  // @mention autocomplete
  const mention = $("#chat-mention");
  const closeMention = () => mention && mention.classList.add("hidden");
  if (input && mention) input.addEventListener("input", () => {
    const val = input.value, pos = input.selectionStart != null ? input.selectionStart : val.length;
    const mt = val.slice(0, pos).match(/@([\wА-Яа-я]*)$/);
    if (!mt) { closeMention(); return; }
    const q = mt[1].toLowerCase();
    const matches = (chat.players || []).filter((p) => p.id !== store.person.id && p.name.toLowerCase().startsWith(q)).slice(0, 6);
    if (!matches.length) { closeMention(); return; }
    mention.innerHTML = matches.map((p) => `<button type="button" class="cm-mention-opt" data-name="${escapeHtml(p.name)}"><span class="cm-mention-ava">${avatarMark(p.name, p.photo)}</span>${escapeHtml(p.name)}</button>`).join("");
    mention.classList.remove("hidden");
  });
  if (mention) mention.addEventListener("click", (e) => {
    const b = e.target.closest(".cm-mention-opt"); if (!b) return;
    const name = b.dataset.name, val = input.value, pos = input.selectionStart != null ? input.selectionStart : val.length;
    const before = val.slice(0, pos).replace(/@([\wА-Яа-я]*)$/, "@" + name + " ");
    input.value = before + val.slice(pos);
    const np = before.length; input.focus(); try { input.setSelectionRange(np, np); } catch {}
    closeMention();
  });
  document.addEventListener("click", (e) => {
    if (mention && !mention.classList.contains("hidden") && !e.target.closest("#chat-mention") && !e.target.closest("#chat-input")) closeMention();
  });

  if (toggle) toggle.addEventListener("click", () => (chat.open ? closeChat() : openChat()));
  if (close) close.addEventListener("click", closeChat);
  if (form) form.addEventListener("submit", async (e) => {
    e.preventDefault();
    closeMention();
    const t = (input.value || "").trim();
    if (!t) return;
    const c = chat.composing;
    input.value = "";
    try {
      if (c && c.mode === "edit") {
        const d = await api("/api/chat/edit", { method: "POST", body: JSON.stringify({ personId: store.person.id, id: c.id, text: t }) });
        chat.msgs = d.messages || [];
      } else {
        const replyTo = c && c.mode === "reply" ? c.id : null;
        const d = await api("/api/chat", { method: "POST", body: JSON.stringify({ personId: store.person.id, text: t, replyTo }) });
        chat.msgs = d.messages || [];
        chat.lastSeen = chatLatestTs(); localStorage.setItem("wc_chat_seen", chat.lastSeen);
      }
      chat.composing = null; renderComposeCtx(); renderChat();
    } catch (err) { input.value = t; alert(err.message); }
  });
  // delete / reply / edit / cancel / jump-to-quoted
  document.addEventListener("click", async (e) => {
    const del = e.target.closest(".cm-del");
    if (del) {
      if (!confirm("Delete this message?")) return;
      try { const d = await api("/api/chat/delete", { method: "POST", body: JSON.stringify({ personId: store.person.id, id: del.dataset.id }) }); chat.msgs = d.messages || []; renderChat(); } catch (err) { /* ignore */ }
      return;
    }
    const rep = e.target.closest(".cm-reply");
    if (rep) {
      const m = chat.msgs.find((x) => x.id === rep.dataset.id); if (!m) return;
      chat.composing = { mode: "reply", id: m.id, name: m.system ? "Match bot" : m.name, text: m.text };
      renderComposeCtx(); const i = $("#chat-input"); if (i) i.focus();
      return;
    }
    const ed = e.target.closest(".cm-edit");
    if (ed) {
      const m = chat.msgs.find((x) => x.id === ed.dataset.id); if (!m) return;
      chat.composing = { mode: "edit", id: m.id, name: m.name, text: m.text };
      renderComposeCtx(); const i = $("#chat-input"); if (i) { i.value = m.text; i.focus(); }
      return;
    }
    if (e.target.closest(".cc-cancel")) { cancelCompose(); return; }
    const jump = e.target.closest(".cm-quote[data-jump]");
    if (jump) {
      const box = $("#chat-msgs");
      // find the rendered bubble for the quoted message id and flash it
      const target = box && Array.from(box.querySelectorAll(".cm-reply")).find((b) => b.dataset.id === jump.dataset.jump);
      const card = target && target.closest(".cm, .cm-sys-wrap");
      if (card) { card.scrollIntoView({ block: "center" }); card.classList.add("cm-flash"); setTimeout(() => card.classList.remove("cm-flash"), 1400); }
      return;
    }
  });
})();

// intro splash — shows on every load, dismiss on click or after a few seconds
(function () {
  const intro = document.getElementById("intro");
  if (!intro) return;
  let done = false;
  const dismiss = () => { if (done) return; done = true; intro.classList.add("hide"); setTimeout(() => intro.remove(), 700); };
  intro.addEventListener("click", dismiss);
  setTimeout(dismiss, 5000);
})();

initFx();
init();
