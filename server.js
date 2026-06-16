// Team World Cup Predictor — single-file Node backend (zero dependencies).
// Run: node server.js   (Node 18+). Data persists to data.json.

const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const { buildAllMatches, allTeams, flagFor, canonicalTeam } = require("./fixtures");

const PORT = process.env.PORT || 3000;
// DATA_FILE can point at a persistent disk on a host (e.g. /data/data.json).
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, "data.json");
const PUBLIC_DIR = path.join(__dirname, "public");
// Uploaded avatars live next to the data file (i.e. on the same persistent disk),
// NOT inside public/, so they survive redeploys. Served via the /avatars/ route.
const AVATAR_DIR = path.join(path.dirname(DATA_FILE), "avatars");
const MAX_BODY = 2 * 1024 * 1024; // 2 MB cap on request bodies (allows a photo, blocks abuse)
// Light admin protection. Override with ADMIN_KEY env var.
const ADMIN_KEY = process.env.ADMIN_KEY || "worldcup-admin";

// ---------- persistence ----------
function defaultData() {
  return {
    config: {
      matchPoints: 1, // points for a correct match outcome
      championPoints: 10, // bonus for correct tournament champion
      knockoutDouble: false, // knockout matches worth double (config flag, default off)
      championLock: "open",
      championDeadline: "2026-06-26T23:59:59Z", // champion picks lock at this moment // "tournament_start" | "first_submission"
      championWinner: null, // set by admin when the tournament winner is known
      lockLeadHours: 2, // predictions close this many hours BEFORE kickoff
      dataSource: "manual", // "manual" | "api" (football-data.org)
      autoSync: false, // background polling when in api mode
      apiCompetition: "WC", // football-data.org competition code
      apiKey: null, // optional: set here OR via FOOTBALL_DATA_API_KEY env var
      lastSync: null, // ISO timestamp of last successful sync
      lastSyncMsg: null, // human-readable status of last sync attempt
      accessCode: null, // optional team gate: when set, players must enter this code first
      gateSecret: crypto.randomBytes(16).toString("hex"), // signs gate tokens (server-only)
      startingBankroll: 10000, // virtual € each player starts with for betting
      oddsApiKey: null, // the-odds-api.com key (optional; or ODDS_API_KEY env)
      oddsSport: "soccer_fifa_world_cup", // the-odds-api sport key
      oddsRegion: "eu", // bookmaker region
      lastOddsSync: null,
      lastOddsMsg: null,
      oddsMonthlyBudget: 450, // stay safely under the-odds-api free tier (500/mo)
      oddsSyncMinutes: 120, // min gap between auto odds fetches when matches are near
      oddsCalls: 0, // requests used this month
      oddsCallsMonth: null, // "YYYY-M" the counter belongs to (auto-resets monthly)
    },
    people: [], // { id, display_name, joined_at }
    matches: buildAllMatches(), // see fixtures.js
    predictions: [], // { id, person_id, match_id, pick, created_at }
    championPicks: [], // { id, person_id, team, created_at }
    reactions: [], // { id, key, emoji, person_id, created_at } — emoji reactions on picks/matches
    bets: [], // { id, person_id, match_id, pick, stake, odds, created_at } — virtual money bets
    chat: [], // { id, person_id, text, created_at } — team chat messages
  };
}

let db;
// Parse the data file, falling back to the .bak copy if the main one is corrupt.
function readDb() {
  const tryFile = (f) => {
    if (!fs.existsSync(f)) return null;
    try { return JSON.parse(fs.readFileSync(f, "utf8")); }
    catch (e) { console.error(`  ⚠ ${f} is corrupt (${e.message})`); return null; }
  };
  return tryFile(DATA_FILE) || (() => {
    const bak = readBak();
    if (bak) console.error("  ↳ recovered from backup (data.json.bak)");
    return bak;
  })();
}
function readBak() {
  try { return fs.existsSync(DATA_FILE + ".bak") ? JSON.parse(fs.readFileSync(DATA_FILE + ".bak", "utf8")) : null; }
  catch { return null; }
}
function load() {
  const parsed = readDb();
  if (parsed) {
    db = parsed;
    // Forward-compat: fill in any config keys added in newer versions.
    db.config = { ...defaultData().config, ...db.config };
    if (!Array.isArray(db.reactions)) db.reactions = [];
    if (!Array.isArray(db.bets)) db.bets = [];
    if (!Array.isArray(db.chat)) db.chat = [];
    if (!db.collections || typeof db.collections !== "object") db.collections = {};
    migrateAvatars(); // move any inline base64 photos out to files
    migratePins(); // hash any plaintext PINs left from older versions
    purgeBotChat(); // remove any old automated "match bot" messages
  } else {
    db = defaultData();
    saveNow();
  }
}
// Atomic write: write to a temp file, then rename over the target so a crash
// mid-write can never truncate the live data file.
let lastBackup = 0;
function writeDbFile() {
  const json = JSON.stringify(db, null, 2);
  const tmp = `${DATA_FILE}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, json);
  fs.renameSync(tmp, DATA_FILE);
  // Keep a backup at most once every 5 minutes (cheap safety net for recovery).
  const t = Date.now();
  if (t - lastBackup > 5 * 60 * 1000) {
    lastBackup = t;
    try { fs.copyFileSync(DATA_FILE, DATA_FILE + ".bak"); } catch { /* non-fatal */ }
  }
}
let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(writeDbFile, 50);
}
function saveNow() {
  clearTimeout(saveTimer);
  writeDbFile();
}

// ---------- avatar files (kept off the JSON, on the persistent disk) ----------
const PHOTO_EXT = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/webp": "webp", "image/gif": "gif" };
function ensureAvatarDir() { try { fs.mkdirSync(AVATAR_DIR, { recursive: true }); } catch { /* exists */ } }
// Decode a `data:` URL, write it as a file, and return the public path (/avatars/<id>.<ext>).
// Non-data values (http URLs, existing /avatars paths, null) are returned unchanged.
function storePhoto(ownerId, value) {
  if (!value || typeof value !== "string") return null;
  if (!value.startsWith("data:")) return value; // external URL or already a path
  const m = /^data:([^;,]+)(;base64)?,(.*)$/s.exec(value);
  if (!m) return null;
  const ext = PHOTO_EXT[m[1].toLowerCase()] || "jpg";
  const buf = m[2] ? Buffer.from(m[3], "base64") : Buffer.from(decodeURIComponent(m[3]), "utf8");
  ensureAvatarDir();
  const file = `${ownerId}.${ext}`;
  fs.writeFileSync(path.join(AVATAR_DIR, file), buf);
  return `/avatars/${file}?v=${Date.now().toString(36)}`; // cache-bust on change
}
function deletePhoto(value) {
  if (!value || typeof value !== "string" || !value.startsWith("/avatars/")) return;
  const name = value.replace(/^\/avatars\//, "").replace(/\?.*$/, "");
  try { fs.unlinkSync(path.join(AVATAR_DIR, path.basename(name))); } catch { /* already gone */ }
}
// One-time: pull any inline base64 photos out of the JSON into files (shrinks data.json).
function migrateAvatars() {
  let changed = false;
  for (const person of db.people || []) {
    if (typeof person.photo === "string" && person.photo.startsWith("data:")) {
      try { person.photo = storePhoto(person.id, person.photo); changed = true; }
      catch (e) { console.error(`  ⚠ avatar migrate failed for ${person.id}: ${e.message}`); }
    }
  }
  if (changed) { console.log("  ↳ migrated inline avatars to files"); saveNow(); }
}
// One-time: replace any plaintext `pin` with a salted hash in `pinHash`.
function migratePins() {
  let changed = false;
  for (const person of db.people || []) {
    if (person.pin && !person.pinHash) {
      person.pinHash = hashPin(person.pin);
      delete person.pin;
      changed = true;
    } else if (person.pin) {
      delete person.pin; // hash already exists; drop the leftover plaintext
      changed = true;
    }
  }
  if (changed) { console.log("  ↳ hashed plaintext PINs"); saveNow(); }
}
// One-time: strip any old automated "match bot" messages from the chat.
function purgeBotChat() {
  if (!Array.isArray(db.chat)) return;
  const before = db.chat.length;
  db.chat = db.chat.filter((m) => !m.system);
  if (db.chat.length !== before) { console.log(`  ↳ removed ${before - db.chat.length} match-bot message(s)`); saveNow(); }
}
// Serve an avatar file from the persistent disk (separate from public/).
function serveAvatar(req, res, pathname) {
  const name = path.basename(decodeURIComponent(pathname.replace(/^\/avatars\//, "").replace(/\?.*$/, "")));
  const full = path.join(AVATAR_DIR, name);
  if (!full.startsWith(AVATAR_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404).end("Not found");
    return;
  }
  const ext = path.extname(full).toLowerCase();
  const type = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".webp": "image/webp", ".gif": "image/gif" }[ext] || "application/octet-stream";
  res.writeHead(200, { "Content-Type": type, "Cache-Control": "public, max-age=604800" });
  fs.createReadStream(full).pipe(res);
}

// ---------- helpers ----------
const uid = () => crypto.randomBytes(8).toString("hex");
const now = () => new Date();

function tournamentStart() {
  const times = db.matches.map((m) => new Date(m.kickoff_time).getTime());
  return new Date(Math.min(...times));
}

// Predictions lock `lockLeadHours` before kickoff (default 2h), or once a result is in.
function lockTime(match) {
  const lead = (db.config.lockLeadHours || 0) * 3600 * 1000;
  return new Date(new Date(match.kickoff_time).getTime() - lead);
}
function isLocked(match) {
  return now() >= lockTime(match) || match.result !== null;
}

function championLocked() {
  if (db.config.championWinner) return true;
  if (db.config.championDeadline) return now() >= new Date(db.config.championDeadline);
  if (db.config.championLock === "tournament_start") return now() >= tournamentStart();
  return false; // "first_submission" handled at submit time (per person)
}

function pointsForMatch(match) {
  const base = db.config.matchPoints;
  if (db.config.knockoutDouble && match.stage === "knockout") return base * 2;
  return base;
}

// ---------- scoring ----------
function computeLeaderboard() {
  const byMatch = new Map(db.matches.map((m) => [m.id, m]));
  const predByPerson = new Map();
  for (const p of db.predictions) {
    if (!predByPerson.has(p.person_id)) predByPerson.set(p.person_id, []);
    predByPerson.get(p.person_id).push(p);
  }
  const champByPerson = new Map(db.championPicks.map((c) => [c.person_id, c]));

  const rows = db.people.map((person) => {
    let points = 0;
    let correct = 0;
    let decided = 0; // matches the person predicted that have a result
    for (const pred of predByPerson.get(person.id) || []) {
      const m = byMatch.get(pred.match_id);
      if (!m || m.result === null) continue;
      decided++;
      if (pred.pick === m.result) {
        correct++;
        points += pointsForMatch(m);
      }
    }
    let championCorrect = false;
    const champ = champByPerson.get(person.id);
    if (db.config.championWinner && champ && champ.team === db.config.championWinner) {
      points += db.config.championPoints;
      championCorrect = true;
    }
    return {
      person_id: person.id,
      name: person.display_name,
      avatar: person.avatar || "⚽",
      photo: person.photo || null,
      points,
      correct,
      decided,
      champion: champ ? champ.team : null,
      championCorrect,
    };
  });

  rows.sort((a, b) => b.points - a.points || b.correct - a.correct || a.name.localeCompare(b.name));
  let rank = 0;
  let lastPts = null;
  rows.forEach((r, i) => {
    if (r.points !== lastPts) {
      rank = i + 1;
      lastPts = r.points;
    }
    r.rank = rank;
  });
  return rows;
}

// ---------- betting style: average stake vs bankroll → a personality label ----------
function computeRisk(personId) {
  const myBets = db.bets.filter((b) => b.person_id === personId);
  if (!myBets.length) return null;
  const start = db.config.startingBankroll || 1000;
  const avg = myBets.reduce((s, b) => s + b.stake, 0) / myBets.length;
  const pct = (avg / start) * 100; // avg stake as a % of the starting bankroll
  const type = pct < 2 ? "Cautious" : pct <= 6 ? "Balanced" : "Reckless";
  return { type, avgStake: Math.round(avg), pct: Math.round(pct), bets: myBets.length };
}

// ---------- rivalries: "twin" (most-alike) & "nemesis" (opposite + beats you) ----------
// Compares a player against everyone else on the matches BOTH have predicted.
function computeRivals(personId) {
  const myPreds = new Map(db.predictions.filter((p) => p.person_id === personId).map((p) => [p.match_id, p.pick]));
  const byMatch = new Map(db.matches.map((m) => [m.id, m]));
  const MIN_COMMON = 3; // need a few shared picks before it's meaningful
  const stats = [];
  for (const other of db.people) {
    if (other.id === personId) continue;
    let common = 0, agree = 0, disagree = 0, disagreeBeats = 0;
    for (const p of db.predictions) {
      if (p.person_id !== other.id || !myPreds.has(p.match_id)) continue;
      common++;
      const mine = myPreds.get(p.match_id);
      if (mine === p.pick) { agree++; continue; }
      disagree++;
      const m = byMatch.get(p.match_id);
      if (m && m.result != null && p.pick === m.result && mine !== m.result) disagreeBeats++;
    }
    if (common < MIN_COMMON) continue;
    stats.push({
      person_id: other.id, name: other.display_name, avatar: other.avatar || "⚽", photo: other.photo || null,
      common, agree, disagree, disagreeBeats, agreeRate: Math.round((agree / common) * 100),
    });
  }
  if (!stats.length) return { twin: null, nemesis: null, rivals: 0 };

  const twin = [...stats].sort((a, b) => b.agreeRate - a.agreeRate || b.common - a.common || a.name.localeCompare(b.name))[0];
  const anyBeats = stats.some((s) => s.disagreeBeats > 0);
  const nemSort = anyBeats
    ? (a, b) => b.disagreeBeats - a.disagreeBeats || a.agreeRate - b.agreeRate || b.disagree - a.disagree || a.name.localeCompare(b.name)
    : (a, b) => a.agreeRate - b.agreeRate || b.disagree - a.disagree || a.name.localeCompare(b.name);
  let nemesis = [...stats].filter((s) => s.person_id !== twin.person_id).sort(nemSort)[0] || null;
  // twin & nemesis must never be the same person (needs ≥2 rivals for a nemesis)
  return { twin, nemesis, rivals: stats.length };
}

// ---------- virtual betting / bankroll ----------
const round2 = (x) => Math.round(x * 100) / 100;

// balance = starting − Σ(all stakes) + Σ(payout of settled winning bets)
// (pending stakes stay deducted until the match is settled)
function computeBankroll() {
  const start = db.config.startingBankroll || 1000;
  const byMatch = new Map(db.matches.map((m) => [m.id, m]));
  const rows = db.people.map((person) => {
    let staked = 0, returned = 0, open = 0, wins = 0, settled = 0;
    for (const b of db.bets) {
      if (b.person_id !== person.id) continue;
      staked += b.stake;
      const m = byMatch.get(b.match_id);
      if (m && m.result != null) {
        settled++;
        if (b.pick === m.result) { returned += b.stake * b.odds; wins++; }
      } else { open += b.stake; }
    }
    const balance = start - staked + returned;
    return {
      person_id: person.id, name: person.display_name,
      avatar: person.avatar || "⚽", photo: person.photo || null,
      balance: round2(balance), profit: round2(balance - start),
      open: round2(open), wins, settled,
    };
  });
  rows.sort((a, b) => b.balance - a.balance || b.wins - a.wins || a.name.localeCompare(b.name));
  let rank = 0, last = null;
  rows.forEach((r, i) => { if (r.balance !== last) { rank = i + 1; last = r.balance; } r.rank = rank; });
  return rows;
}
function personBalance(personId) {
  const r = computeBankroll().find((x) => x.person_id === personId);
  return r ? r.balance : (db.config.startingBankroll || 1000);
}

// Update a match's odds, keeping the previous values so we can show movement (▲▼).
function setMatchOdds(m, oa, od, ob) {
  if (m.odds_a != null) m.odds_prev_a = m.odds_a;
  if (m.odds_draw != null) m.odds_prev_draw = m.odds_draw;
  if (m.odds_b != null) m.odds_prev_b = m.odds_b;
  m.odds_a = oa; m.odds_draw = od; m.odds_b = ob; m.odds_updated = now().toISOString();
}

// Normalise team names for matching against The Odds API.
function normTeam(s) {
  return (s || "").toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();
}

// ---------- football-data.org sync ----------
function apiKey() {
  return process.env.FOOTBALL_DATA_API_KEY || db.config.apiKey || null;
}

// Map one football-data.org v4 match object to our internal shape.
function mapApiMatch(m) {
  const stageRaw = (m.stage || "").toUpperCase();
  const isGroup = stageRaw === "GROUP_STAGE" || stageRaw === "GROUP";
  const roundLabels = {
    LAST_32: "Round of 32", LAST_16: "Round of 16", ROUND_OF_16: "Round of 16",
    QUARTER_FINALS: "Quarter-final", QUARTER_FINAL: "Quarter-final",
    SEMI_FINALS: "Semi-final", SEMI_FINAL: "Semi-final",
    THIRD_PLACE: "Third place", FINAL: "Final",
  };
  let result = null;
  if ((m.status || "").toUpperCase() === "FINISHED" && m.score && m.score.winner) {
    const w = m.score.winner.toUpperCase();
    result = w === "HOME_TEAM" ? "a_win" : w === "AWAY_TEAM" ? "b_win" : w === "DRAW" ? "draw" : null;
  }
  return {
    ext_id: m.id,
    team_a: (m.homeTeam && m.homeTeam.name) ? canonicalTeam(m.homeTeam.name) : "TBD",
    team_b: (m.awayTeam && m.awayTeam.name) ? canonicalTeam(m.awayTeam.name) : "TBD",
    crest_a: (m.homeTeam && m.homeTeam.crest) || null,
    crest_b: (m.awayTeam && m.awayTeam.crest) || null,
    tla_a: (m.homeTeam && m.homeTeam.tla) || null,
    tla_b: (m.awayTeam && m.awayTeam.tla) || null,
    group: isGroup && m.group ? String(m.group).replace(/GROUP[_ ]?/i, "") : null,
    stage: isGroup ? "group" : "knockout",
    matchday: isGroup ? (m.matchday || null) : null,
    round: isGroup ? null : (roundLabels[stageRaw] || "Knockout"),
    kickoff_time: m.utcDate,
    status: m.status || null,
    minute: (m.minute != null ? m.minute : null),
    score_home: (m.score && m.score.fullTime && m.score.fullTime.home != null) ? m.score.fullTime.home : null,
    score_away: (m.score && m.score.fullTime && m.score.fullTime.away != null) ? m.score.fullTime.away : null,
    result,
  };
}

// Post an automatic "match bot" message into the team chat.
function joinNames(a) {
  if (a.length === 1) return a[0];
  if (a.length === 2) return `${a[0]} and ${a[1]}`;
  return `${a.slice(0, -1).join(", ")} and ${a[a.length - 1]}`;
}
function postChatBot(_text) {
  // Match bot disabled — no automatic messages in the team chat.
  return;
}
function announceMatch(m, kind) {
  if (kind === "kickoff") {
    postChatBot(`Kickoff — ${m.team_a} v ${m.team_b}. Picks are locked, good luck!`);
    return;
  }
  // full-time
  if (!m.result) return;
  let head;
  if (m.score_home != null && m.score_away != null) head = `FT — ${m.team_a} ${m.score_home}–${m.score_away} ${m.team_b}`;
  else if (m.result === "a_win") head = `FT — ${m.team_a} beat ${m.team_b}`;
  else if (m.result === "b_win") head = `FT — ${m.team_b} beat ${m.team_a}`;
  else head = `FT — ${m.team_a} and ${m.team_b} drew`;
  const names = db.predictions
    .filter((p) => p.match_id === m.id && p.pick === m.result)
    .map((p) => { const per = db.people.find((x) => x.id === p.person_id); return per && per.display_name; })
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
  const tail = names.length ? ` — ${joinNames(names)} nailed it!` : " — nobody called it.";
  postChatBot(head + tail);
}

// Upsert a list of API matches into db.matches (keyed by ext_id), preserving
// internal ids (and therefore existing predictions). Returns a summary.
function applyApiMatches(apiList) {
  let added = 0, updated = 0, results = 0;
  for (const raw of apiList) {
    const mapped = mapApiMatch(raw);
    const existing = db.matches.find((x) => x.ext_id === mapped.ext_id);
    if (existing) {
      const hadResult = existing.result;
      const hadStatus = existing.status;
      Object.assign(existing, mapped);
      updated++;
      if (existing.result && existing.result !== hadResult) results++;
      // auto chat: kickoff + full-time announcements (only on transition)
      const live = (s) => s === "IN_PLAY" || s === "PAUSED";
      if (!live(hadStatus) && live(existing.status)) announceMatch(existing, "kickoff");
      if (!hadResult && existing.result) announceMatch(existing, "final");
    } else {
      const newId = Math.max(0, ...db.matches.map((x) => x.id)) + 1;
      db.matches.push({ id: newId, ...mapped });
      added++;
      if (mapped.result) results++;
    }
  }
  if (db.config.dataSource === "api") {
    // Migrate predictions from any seeded duplicate onto its API equivalent
    // (same teams, same calendar day, same A/B order so picks stay correct),
    // then drop seeded placeholders that no longer have predictions.
    const sameDay = (x, y) => new Date(x).toDateString() === new Date(y).toDateString();
    const apiMatches = db.matches.filter((m) => m.ext_id != null);
    for (const s of db.matches.filter((m) => m.ext_id == null)) {
      const twin = apiMatches.find((a) => a.team_a === s.team_a && a.team_b === s.team_b && sameDay(a.kickoff_time, s.kickoff_time));
      if (twin) db.predictions.forEach((p) => { if (p.match_id === s.id) p.match_id = twin.id; });
    }
    const predMatchIds = new Set(db.predictions.map((p) => p.match_id));
    db.matches = db.matches.filter((m) => m.ext_id != null || predMatchIds.has(m.id));
  }

  // Auto-award the champion bonus once the Final has a winner (unless already set manually).
  if (!db.config.championWinner) {
    const final = db.matches.find((m) => m.stage === "knockout" && m.round === "Final" && (m.result === "a_win" || m.result === "b_win"));
    if (final) db.config.championWinner = final.result === "a_win" ? final.team_a : final.team_b;
  }

  // Build a team -> crest map (for dropdowns, leaderboard, champion banner).
  db.teamCrests = db.teamCrests || {};
  for (const m of db.matches) {
    if (m.crest_a && m.team_a && m.team_a !== "TBD") db.teamCrests[m.team_a] = m.crest_a;
    if (m.crest_b && m.team_b && m.team_b !== "TBD") db.teamCrests[m.team_b] = m.crest_b;
  }

  save();
  return { added, updated, results, total: db.matches.length };
}

// fetch that aborts if the upstream hangs (default 10s) so a stuck API can't stall sync
async function fetchWithTimeout(url, opts = {}, ms = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try { return await fetch(url, { ...opts, signal: ctrl.signal }); }
  finally { clearTimeout(t); }
}

async function syncFromFootballData() {
  const key = apiKey();
  if (!key) throw new Error("No API key. Set FOOTBALL_DATA_API_KEY or paste a key in Admin.");
  const comp = db.config.apiCompetition || "WC";
  const url = `https://api.football-data.org/v4/competitions/${comp}/matches`;
  const r = await fetchWithTimeout(url, { headers: { "X-Auth-Token": key } });
  if (!r.ok) {
    const txt = await r.text().catch(() => "");
    throw new Error(`football-data.org ${r.status}: ${txt.slice(0, 200)}`);
  }
  const data = await r.json();
  const list = Array.isArray(data.matches) ? data.matches : [];
  const summary = applyApiMatches(list);

  // Also pull standings (best-effort; may be empty pre-tournament).
  try {
    const sr = await fetchWithTimeout(`https://api.football-data.org/v4/competitions/${comp}/standings`, { headers: { "X-Auth-Token": key } });
    if (sr.ok) { const sd = await sr.json(); db.standings = Array.isArray(sd.standings) ? sd.standings : []; }
  } catch (e) { /* ignore */ }

  db.config.lastSync = now().toISOString();
  db.config.lastSyncMsg = `OK — ${summary.total} matches (${summary.added} new, ${summary.updated} updated, ${summary.results} results)`;
  save();
  return summary;
}

function oddsApiKey() { return process.env.ODDS_API_KEY || db.config.oddsApiKey || null; }

// ---- odds request budget (the-odds-api free tier = 500/month) ----
function oddsMonthKey() { const d = now(); return `${d.getUTCFullYear()}-${d.getUTCMonth() + 1}`; }
function oddsBudgetLeft() {
  if (db.config.oddsCallsMonth !== oddsMonthKey()) { db.config.oddsCallsMonth = oddsMonthKey(); db.config.oddsCalls = 0; }
  return (db.config.oddsMonthlyBudget || 450) - (db.config.oddsCalls || 0);
}
function noteOddsCall() {
  if (db.config.oddsCallsMonth !== oddsMonthKey()) { db.config.oddsCallsMonth = oddsMonthKey(); db.config.oddsCalls = 0; }
  db.config.oddsCalls = (db.config.oddsCalls || 0) + 1;
}
// Is there an unfinished match within the next 3 days (or kicked off <3h ago)?
function oddsWorthFetching() {
  const t = Date.now();
  return db.matches.some((m) => {
    const k = new Date(m.kickoff_time).getTime();
    return m.result == null && k > t - 3 * 3600 * 1000 && k < t + 3 * 86400000;
  });
}

// Pull head-to-head (1X2) decimal odds from the-odds-api.com and attach to fixtures.
async function syncOdds() {
  const key = oddsApiKey();
  if (!key) throw new Error("No odds API key. Set ODDS_API_KEY or paste one in Admin (odds-key).");
  const sport = db.config.oddsSport || "soccer_fifa_world_cup";
  const region = db.config.oddsRegion || "eu";
  const url = `https://api.the-odds-api.com/v4/sports/${sport}/odds/?apiKey=${encodeURIComponent(key)}&regions=${region}&markets=h2h&oddsFormat=decimal`;
  noteOddsCall(); // count against the monthly budget
  const r = await fetchWithTimeout(url);
  if (!r.ok) { const t = await r.text().catch(() => ""); throw new Error(`The Odds API ${r.status}: ${t.slice(0, 160)}`); }
  const events = await r.json();
  let matched = 0;
  for (const ev of Array.isArray(events) ? events : []) {
    const home = normTeam(ev.home_team), away = normTeam(ev.away_team);
    const bm = (ev.bookmakers || [])[0];
    if (!bm) continue;
    const mk = (bm.markets || []).find((x) => x.key === "h2h");
    if (!mk) continue;
    const price = {};
    for (const o of mk.outcomes || []) price[normTeam(o.name)] = o.price;
    const draw = price["draw"];
    if (draw == null) continue;
    for (const m of db.matches) {
      if (m.result != null) continue;
      const a = normTeam(m.team_a), b = normTeam(m.team_b);
      if (price[a] == null || price[b] == null) continue;
      if (a === home && b === away) { setMatchOdds(m, price[home], draw, price[away]); matched++; break; }
      if (a === away && b === home) { setMatchOdds(m, price[away], draw, price[home]); matched++; break; }
    }
  }
  db.config.lastOddsSync = now().toISOString();
  db.config.lastOddsMsg = `OK — odds for ${matched} match${matched === 1 ? "" : "es"} · ${db.config.oddsCalls}/${db.config.oddsMonthlyBudget || 450} requests this month`;
  save();
  return { events: Array.isArray(events) ? events.length : 0, matched, used: db.config.oddsCalls, budget: db.config.oddsMonthlyBudget || 450 };
}

// Separate, budgeted scheduler for odds (keeps us under the-odds-api's 500/mo).
let oddsTimer = null;
function scheduleOddsSync() {
  clearTimeout(oddsTimer);
  if (!oddsApiKey()) return; // no key → nothing to schedule
  const near = oddsWorthFetching();
  const gapMin = near ? (db.config.oddsSyncMinutes || 120) : 360; // 2h near matches, else every 6h
  oddsTimer = setTimeout(async () => {
    try {
      if (oddsWorthFetching() && oddsBudgetLeft() > 5) await syncOdds();
    } catch (e) { db.config.lastOddsMsg = "Auto odds sync failed: " + e.message; save(); }
    scheduleOddsSync();
  }, gapMin * 60 * 1000);
}

// Adaptive scheduler: poll often around live matches, rarely when quiet.
let syncTimer = null;
function scheduleNextSync() {
  clearTimeout(syncTimer);
  if (db.config.dataSource !== "api" || !db.config.autoSync) return;
  const nowMs = Date.now();
  const liveWindow = db.matches.some((m) => {
    const k = new Date(m.kickoff_time).getTime();
    return nowMs >= k && nowMs <= k + 3 * 3600 * 1000; // kicked off within last 3h
  });
  const delay = (liveWindow ? 5 : 30) * 60 * 1000; // 5 min live, else 30 min
  syncTimer = setTimeout(async () => {
    try { await syncFromFootballData(); }
    catch (e) { db.config.lastSyncMsg = "Auto-sync failed: " + e.message; save(); }
    scheduleNextSync();
  }, delay);
}

// ---------- HTTP plumbing ----------
function send(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json", "Cache-Control": "no-store" });
  res.end(body);
}
function readBody(req) {
  // memoize so the body can be read once centrally (auth) and again in the handler
  if (req._bodyPromise) return req._bodyPromise;
  req._bodyPromise = new Promise((resolve) => {
    let data = "";
    let aborted = false;
    req.on("data", (c) => {
      if (aborted) return;
      data += c;
      if (data.length > MAX_BODY) { aborted = true; req.destroy(); resolve({}); } // too big → drop
    });
    req.on("end", () => {
      if (aborted) return;
      try { resolve(data ? JSON.parse(data) : {}); }
      catch { resolve({}); }
    });
    req.on("error", () => resolve({}));
  });
  return req._bodyPromise;
}
function getPerson(id) {
  return db.people.find((p) => p.id === id);
}
// Never leak the PIN to the client.
function publicPerson(p) {
  return p ? { id: p.id, display_name: p.display_name, joined_at: p.joined_at, hasPin: !!p.pinHash, avatar: p.avatar || "⚽", photo: p.photo || null } : null;
}
// Never leak secrets to the client — expose only whether they're set.
function publicConfig() {
  const { apiKey, gateSecret, accessCode, oddsApiKey: oddsKey, ...rest } = db.config;
  return {
    ...rest,
    hasApiKey: !!(process.env.FOOTBALL_DATA_API_KEY || apiKey),
    hasOddsKey: !!(process.env.ODDS_API_KEY || oddsKey),
    gateRequired: !!currentAccessCode(),
  };
}

// Constant-time string compare (prevents timing attacks on secrets/tokens).
// Reveals only length, which is not sensitive here.
function safeEq(a, b) {
  const ba = Buffer.from(String(a == null ? "" : a));
  const bb = Buffer.from(String(b == null ? "" : b));
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}
// The key used to sign tokens. Prefer an env var so the secret lives outside the data file.
function signingSecret() {
  return process.env.GATE_SECRET || db.config.gateSecret;
}

// ---- PIN hashing (salted scrypt; never store the PIN in clear) ----
function hashPin(pin) {
  const salt = crypto.randomBytes(16).toString("hex");
  const dk = crypto.scryptSync(String(pin), salt, 32).toString("hex");
  return `${salt}:${dk}`;
}
function verifyPin(pin, stored) {
  if (!stored || typeof stored !== "string" || !stored.includes(":")) return false;
  const [salt, dk] = stored.split(":");
  const test = crypto.scryptSync(String(pin), salt, 32).toString("hex");
  return safeEq(test, dk);
}

// ---- team access gate ----
function currentAccessCode() {
  return process.env.ACCESS_CODE || db.config.accessCode || null;
}
function gateToken() {
  // stable token derived from the code + server secret (survives restarts)
  return crypto.createHmac("sha256", signingSecret()).update(currentAccessCode() || "").digest("hex").slice(0, 32);
}
function gateOk(req) {
  if (!currentAccessCode()) return true; // gate disabled
  return safeEq(req.headers["x-gate-token"] || "", gateToken());
}

// ---- per-player auth token ----
// A stable token tied to the player id + their hashed PIN, signed with the server secret.
// Survives restarts, can't be forged without the secret, and changes if the PIN changes.
function authToken(person) {
  return crypto.createHmac("sha256", signingSecret()).update("auth:" + person.id + ":" + (person.pinHash || "")).digest("hex").slice(0, 40);
}
// True only if the request carries a token that matches THIS personId's token.
function authOk(req, personId) {
  const tok = req.headers["x-auth-token"] || "";
  const p = personId && getPerson(personId);
  return !!(p && tok && safeEq(tok, authToken(p)));
}
const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml",
  ".mp4": "video/mp4", ".webm": "video/webm", ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".ico": "image/x-icon",
  ".txt": "text/plain", ".json": "application/json", ".webmanifest": "application/manifest+json" };
function serveStatic(req, res, pathname) {
  let file = pathname === "/" ? "/index.html" : pathname;
  const full = path.join(PUBLIC_DIR, path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  if (!full.startsWith(PUBLIC_DIR) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) {
    res.writeHead(404).end("Not found");
    return;
  }
  const ext = path.extname(full);
  const type = MIME[ext] || "application/octet-stream";
  const st = fs.statSync(full);
  const size = st.size;
  const lastMod = st.mtime.toUTCString();
  // Big media rarely changes → cache long. Code/markup → always revalidate so
  // edits show up immediately (no manual cache clearing).
  const longCache = [".mp4", ".webm", ".png", ".jpg", ".jpeg", ".svg", ".ico"].includes(ext);
  const cacheControl = longCache ? "public, max-age=604800" : "no-cache, must-revalidate";

  // cheap revalidation: if the file hasn't changed since the client's copy → 304
  const ims = req.headers["if-modified-since"];
  if (ims && Date.parse(ims) >= Math.floor(st.mtimeMs / 1000) * 1000) {
    res.writeHead(304, { "Cache-Control": cacheControl, "Last-Modified": lastMod }).end();
    return;
  }

  const range = req.headers.range;
  // Safari REQUIRES byte-range support to play <video>; honour Range requests.
  if (range) {
    const m = /^bytes=(\d*)-(\d*)$/.exec(range);
    if (m) {
      let start = m[1] ? parseInt(m[1], 10) : 0;
      let end = m[2] ? parseInt(m[2], 10) : size - 1;
      if (isNaN(start)) start = 0;
      if (isNaN(end) || end >= size) end = size - 1;
      if (start > end || start >= size) {
        res.writeHead(416, { "Content-Range": `bytes */${size}` }).end();
        return;
      }
      res.writeHead(206, {
        "Content-Type": type,
        "Content-Range": `bytes ${start}-${end}/${size}`,
        "Accept-Ranges": "bytes",
        "Content-Length": end - start + 1,
        "Cache-Control": cacheControl,
        "Last-Modified": lastMod,
      });
      fs.createReadStream(full, { start, end }).pipe(res);
      return;
    }
  }
  res.writeHead(200, {
    "Content-Type": type,
    "Accept-Ranges": "bytes",
    "Content-Length": size,
    "Cache-Control": cacheControl,
    "Last-Modified": lastMod,
  });
  fs.createReadStream(full).pipe(res);
}

// Direction of an odds change since the last sync: "up" | "down" | null.
function oddsDir(cur, prev) {
  if (cur == null || prev == null || cur === prev) return null;
  return cur > prev ? "up" : "down";
}

// Shape a match for client display (optionally with a person's pick).
function matchView(m, personId) {
  const pred = personId ? db.predictions.find((p) => p.person_id === personId && p.match_id === m.id) : null;
  const bet = personId ? db.bets.find((b) => b.person_id === personId && b.match_id === m.id) : null;
  return {
    id: m.id,
    team_a: m.team_a,
    team_b: m.team_b,
    flag_a: flagFor(m.team_a),
    flag_b: flagFor(m.team_b),
    group: m.group,
    stage: m.stage,
    round: m.round || null,
    kickoff_time: m.kickoff_time,
    lock_time: lockTime(m).toISOString(),
    result: m.result,
    locked: isLocked(m),
    pick: pred ? pred.pick : null,
    crest_a: m.crest_a || null,
    crest_b: m.crest_b || null,
    tla_a: m.tla_a || null,
    tla_b: m.tla_b || null,
    status: m.status || null,
    minute: (m.minute != null ? m.minute : null),
    score_home: (m.score_home != null ? m.score_home : null),
    score_away: (m.score_away != null ? m.score_away : null),
    odds_a: m.odds_a != null ? m.odds_a : null,
    odds_draw: m.odds_draw != null ? m.odds_draw : null,
    odds_b: m.odds_b != null ? m.odds_b : null,
    odds_updated: m.odds_updated || null,
    odds_dir_a: oddsDir(m.odds_a, m.odds_prev_a),
    odds_dir_draw: oddsDir(m.odds_draw, m.odds_prev_draw),
    odds_dir_b: oddsDir(m.odds_b, m.odds_prev_b),
    bet: bet ? { pick: bet.pick, stake: bet.stake, odds: bet.odds, potential: round2(bet.stake * bet.odds) } : null,
  };
}

// "Upcoming matches": find the soonest day that still has matches, then return
// every match on that day AND the next calendar day — so early-morning games on
// the following day can still be predicted ahead of time.
function nextMatchDayMatches() {
  const nowT = now();
  const upcoming = db.matches
    .filter((m) => new Date(m.kickoff_time) >= nowT)
    .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));
  if (!upcoming.length) return [];
  const start = new Date(upcoming[0].kickoff_time);
  start.setHours(0, 0, 0, 0); // start of the first match day
  const end = new Date(start);
  end.setDate(end.getDate() + 2); // base: first match day + the next day
  // Roll the window across weekends: while the last day it covers is a
  // Friday, Saturday or Sunday, extend by a day. This pulls Sat/Sun (and the
  // following Monday) matches forward onto the preceding Friday, so nobody has
  // to open the site on the weekend to get their picks in.
  const last = new Date(end); last.setDate(last.getDate() - 1); // last day inside [start, end)
  let guard = 0;
  while ([5, 6, 0].includes(last.getDay()) && guard++ < 7) { // 5=Fri, 6=Sat, 0=Sun
    end.setDate(end.getDate() + 1);
    last.setDate(last.getDate() + 1);
  }
  return db.matches
    .filter((m) => { const k = new Date(m.kickoff_time); return k >= start && k < end; })
    .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));
}

// ---------- reactions (emoji on picks / matches) ----------
const REACTION_EMOJI = ["🔥", "😂", "😱", "🤡", "👏", "💀"]; // allowed reaction set
const KEY_RE = /^(champ:[a-f0-9]+|match:\d+|chatmsg:[a-f0-9]+)$/; // valid reaction targets

// Group reactions for one target key → [{ emoji, count, by:[personId], names:[displayName] }]
function reactionsFor(key) {
  const nameById = new Map(db.people.map((x) => [x.id, x.display_name]));
  const out = new Map();
  for (const r of db.reactions) {
    if (r.key !== key) continue;
    if (!out.has(r.emoji)) out.set(r.emoji, { emoji: r.emoji, count: 0, by: [], names: [] });
    const g = out.get(r.emoji);
    g.count++; g.by.push(r.person_id);
    if (nameById.has(r.person_id)) g.names.push(nameById.get(r.person_id));
  }
  // keep a stable order matching REACTION_EMOJI
  return REACTION_EMOJI.filter((e) => out.has(e)).map((e) => out.get(e));
}

// Team chat messages, oldest first (with sender name & photo).
const typingMap = {}; // personId -> last "typing" timestamp (ms), in-memory
const presence = {}; // personId -> last seen timestamp (ms), in-memory
const chatRead = {}; // personId -> timestamp (ms) of the latest chat message they've seen

// ---- simple in-memory rate limiting (sliding window per key) ----
const rlHits = {}; // key -> [timestamps]
function rateOk(key, max, windowMs) {
  const t = Date.now();
  const arr = (rlHits[key] || []).filter((x) => x > t - windowMs);
  arr.push(t);
  rlHits[key] = arr;
  return arr.length <= max;
}
function clientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  return (xff ? String(xff).split(",")[0].trim() : "") || req.socket.remoteAddress || "?";
}
// prune the rate-limit table occasionally so it can't grow forever
setInterval(() => {
  const t = Date.now();
  for (const k of Object.keys(rlHits)) {
    rlHits[k] = rlHits[k].filter((x) => x > t - 5 * 60 * 1000);
    if (!rlHits[k].length) delete rlHits[k];
  }
}, 5 * 60 * 1000).unref();
const ONLINE_MS = 90000;
function onlineIds() { const cut = Date.now() - ONLINE_MS; return Object.keys(presence).filter((id) => presence[id] > cut); }

// a team's journey through the bracket: group → R32 → R16 → QF → SF → Final
function championPath(team) {
  const ladder = ["Round of 32", "Round of 16", "Quarter-final", "Semi-final", "Final"];
  const ko = db.matches.filter((m) => m.stage === "knockout" && (m.team_a === team || m.team_b === team));
  const anyKo = db.matches.some((m) => m.stage === "knockout");
  const groupMs = db.matches.filter((m) => m.stage === "group" && (m.team_a === team || m.team_b === team));
  const groupDone = groupMs.length > 0 && groupMs.every((m) => m.result != null);

  let groupStatus;
  if (ko.length) groupStatus = "advanced";
  else if (!groupMs.length) groupStatus = "pending";
  else if (!groupDone) groupStatus = "live";
  else groupStatus = anyKo ? "out" : "live";

  const path = [{ label: "Group stage", status: groupStatus }];
  let eliminated = groupStatus === "out", champion = false;
  for (const round of ladder) {
    const m = ko.find((x) => x.round === round);
    let status;
    if (eliminated) status = "skip";
    else if (!m) status = "pending";
    else if (m.result == null) status = "live";
    else {
      const won = (m.result === "a_win" && m.team_a === team) || (m.result === "b_win" && m.team_b === team);
      if (won) { status = round === "Final" ? "champion" : "advanced"; if (round === "Final") champion = true; }
      else { status = "out"; eliminated = true; }
    }
    path.push({ label: round, status });
  }
  return { path, champion, eliminated: eliminated && !champion };
}

// collectible team cards (pack opening)
const PACK_COOLDOWN_H = 8;
const RARITY_RANK = { common: 1, rare: 2, epic: 3, legendary: 4 };
function pickCard() {
  const teams = allTeams();
  const team = teams[Math.floor(Math.random() * teams.length)];
  const r = Math.random();
  const rarity = r < 0.03 ? "legendary" : r < 0.15 ? "epic" : r < 0.40 ? "rare" : "common";
  return { team, rarity, at: now().toISOString() };
}
function collectionView(personId) {
  const col = (db.collections && db.collections[personId]) || { cards: [], lastPack: null };
  const byTeam = {};
  (col.cards || []).forEach((c) => {
    const e = byTeam[c.team] || { team: c.team, flag: flagFor(c.team), crest: (db.teamCrests || {})[c.team] || null, rarity: c.rarity, count: 0 };
    e.count++;
    if ((RARITY_RANK[c.rarity] || 0) > (RARITY_RANK[e.rarity] || 0)) e.rarity = c.rarity;
    byTeam[c.team] = e;
  });
  const cards = Object.values(byTeam).sort((a, b) => (RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity]) || a.team.localeCompare(b.team));
  const cd = PACK_COOLDOWN_H * 3600000;
  const nextPackMs = col.lastPack ? Math.max(0, new Date(col.lastPack).getTime() + cd - Date.now()) : 0;
  return { cards, total: (col.cards || []).length, unique: cards.length, packReady: nextPackMs <= 0, nextPackMs, totalTeams: allTeams().length };
}

function chatView() {
  const nameById = new Map(db.people.map((x) => [x.id, x.display_name]));
  const photoById = new Map(db.people.map((x) => [x.id, x.photo || null]));
  const byId = new Map((db.chat || []).map((m) => [m.id, m]));
  // a short quoted snippet for a message that's being replied to
  const replyInfo = (rid) => {
    if (!rid) return null;
    const t = byId.get(rid);
    if (!t) return { id: rid, deleted: true };
    const name = t.system ? "Match bot" : (nameById.get(t.person_id) || "Unknown");
    const snip = (t.text || "").length > 90 ? t.text.slice(0, 90) + "…" : (t.text || "");
    return { id: rid, name, text: snip, system: !!t.system };
  };
  return (db.chat || [])
    .slice()
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
    .map((m) => m.system
      ? { id: m.id, system: true, text: m.text, created_at: m.created_at, reactions: reactionsFor(`chatmsg:${m.id}`), reply: replyInfo(m.reply_to) }
      : { id: m.id, person_id: m.person_id, name: nameById.get(m.person_id) || "Unknown", photo: photoById.get(m.person_id) || null, text: m.text, created_at: m.created_at, edited: !!m.edited_at, reactions: reactionsFor(`chatmsg:${m.id}`), reply: replyInfo(m.reply_to) });
}

// ---------- routes ----------
// Endpoints hit constantly by polling — skip them so the log stays readable.
const QUIET_LOG = new Set(["/api/ping", "/api/typing", "/api/chat/seen", "/api/health"]);
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  const q = url.searchParams;

  // One concise line per request (method, path, status, time) — minus the noisy polls.
  const t0 = Date.now();
  res.on("finish", () => {
    if (QUIET_LOG.has(p) || (p === "/api/chat" && req.method === "GET")) return;
    console.log(`${new Date().toISOString().slice(11, 19)} ${req.method} ${p} ${res.statusCode} ${Date.now() - t0}ms`);
  });

  // Security headers on every response (cheap defence-in-depth).
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "geolocation=(), microphone=(), camera=()");
  res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains"); // force HTTPS (honoured only over TLS)
  res.setHeader("Content-Security-Policy", [
    "default-src 'self'",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "img-src 'self' data: https:",
    "media-src 'self'",
    "connect-src 'self'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; "));

  // Liveness probe for the host (Render etc.) — public, no gate.
  if (p === "/api/health") return send(res, 200, { ok: true, uptime: Math.round(process.uptime()), now: new Date().toISOString() });

  if (p.startsWith("/avatars/")) return serveAvatar(req, res, p);
  if (!p.startsWith("/api/")) return serveStatic(req, res, p);

  try {
    // --- team access gate (enter the shared code once) ---
    if (p === "/api/gate" && req.method === "POST") {
      const { code } = await readBody(req);
      if (!currentAccessCode()) return send(res, 200, { ok: true, token: null }); // gate disabled
      if (safeEq((code || "").trim(), currentAccessCode())) return send(res, 200, { ok: true, token: gateToken() });
      return send(res, 401, { error: "Wrong access code.", gate: true });
    }

    // Gate enforcement: everything except /api/info, /api/gate and admin endpoints
    // requires a valid gate token when an access code is set. (Admin uses its own key.)
    const isPublic = p === "/api/info" || p === "/api/gate" || p.startsWith("/api/admin/");
    if (!isPublic && !gateOk(req)) {
      return send(res, 401, { error: "Access code required.", gate: true });
    }

    // Rate limits on the abuse-prone endpoints (per IP). Generous for humans, hostile to bots.
    if (req.method === "POST") {
      const ip = clientIp(req);
      if (p === "/api/join" && !rateOk(`join:${ip}`, 10, 60 * 1000))
        return send(res, 429, { error: "Too many attempts. Wait a minute and try again." });
      if (p === "/api/chat" && !rateOk(`chat:${ip}`, 20, 30 * 1000))
        return send(res, 429, { error: "You're sending messages too fast — slow down a moment." });
    }

    // Per-player auth: write actions must carry a valid token for the acting player.
    // The token is tied to the body's personId, so nobody can act as someone else.
    const AUTH_PATHS = new Set([
      "/api/predict", "/api/champion", "/api/react", "/api/bet", "/api/bet/cancel",
      "/api/chat", "/api/chat/edit", "/api/chat/delete", "/api/chat/seen",
      "/api/ping", "/api/typing", "/api/packs/open", "/api/profile/update",
    ]);
    if (req.method === "POST" && AUTH_PATHS.has(p)) {
      const body = await readBody(req); // memoized — the handler reads the same body
      if (!authOk(req, body.personId)) {
        return send(res, 401, { error: "Please log in again.", auth: true });
      }
    }

    // --- join OR log back in (name-based, lightweight) ---
    if (p === "/api/join" && req.method === "POST") {
      const { name, pin } = await readBody(req);
      const clean = (name || "").trim();
      const cleanPin = (pin || "").trim();
      if (!clean) return send(res, 400, { error: "Please enter a name." });
      if (clean.length > 40) return send(res, 400, { error: "Name too long (max 40)." });
      if (!cleanPin) return send(res, 400, { error: "A PIN is required." });
      if (!/^\d{4,8}$/.test(cleanPin)) return send(res, 400, { error: "PIN must be 4–8 digits." });

      const existing = db.people.find((x) => x.display_name.toLowerCase() === clean.toLowerCase());
      if (existing) {
        // Returning player: log them back into the same profile.
        if (existing.pinHash) {
          if (!verifyPin(cleanPin, existing.pinHash)) return send(res, 401, { error: "Wrong PIN for that name." });
        } else {
          existing.pinHash = hashPin(cleanPin); // legacy account without a PIN — set it now
          save();
        }
        return send(res, 200, { person: publicPerson(existing), token: authToken(existing), returning: true });
      }
      // New player.
      const person = { id: uid(), display_name: clean, joined_at: now().toISOString(), pinHash: hashPin(cleanPin) };
      db.people.push(person);
      save();
      return send(res, 200, { person: publicPerson(person), token: authToken(person), returning: false });
    }

    if (p === "/api/me" && req.method === "GET") {
      const person = getPerson(q.get("personId"));
      if (!person) return send(res, 404, { error: "Unknown player." });
      return send(res, 200, { person: publicPerson(person) });
    }

    // --- matches you can still act on: every fixture that hasn't finished yet ---
    if (p === "/api/matches" && req.method === "GET") {
      const personId = q.get("personId");
      const list = db.matches
        .filter((m) => m.result == null) // not yet decided → still predictable / bettable
        .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time))
        .map((m) => matchView(m, personId));
      return send(res, 200, { matches: list, serverTime: now().toISOString() });
    }

    // --- full schedule (all upcoming matches, view-only) ---
    if (p === "/api/schedule" && req.method === "GET") {
      const personId = q.get("personId");
      const nowT = now();
      const list = db.matches
        .filter((m) => new Date(m.kickoff_time) >= nowT) // upcoming only
        .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time))
        .map((m) => matchView(m, personId));
      return send(res, 200, { matches: list, serverTime: nowT.toISOString() });
    }

    // --- who picked what (upcoming matches + champion picks) ---
    if (p === "/api/picks" && req.method === "GET") {
      const nowT = now();
      const nameById = new Map(db.people.map((x) => [x.id, x.display_name]));
      const avatarById = new Map(db.people.map((x) => [x.id, x.avatar || "⚽"]));
      const photoById = new Map(db.people.map((x) => [x.id, x.photo || null]));
      const matches = db.matches
        .filter((m) => new Date(m.kickoff_time) >= nowT)
        .sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time))
        .map((m) => {
          const picks = db.predictions
            .filter((pr) => pr.match_id === m.id && nameById.has(pr.person_id))
            .map((pr) => ({ person_id: pr.person_id, name: nameById.get(pr.person_id), avatar: avatarById.get(pr.person_id), photo: photoById.get(pr.person_id), pick: pr.pick }))
            .sort((a, b) => a.name.localeCompare(b.name));
          return {
            id: m.id, team_a: m.team_a, team_b: m.team_b,
            flag_a: flagFor(m.team_a), flag_b: flagFor(m.team_b),
            crest_a: m.crest_a || null, crest_b: m.crest_b || null,
            kickoff_time: m.kickoff_time, lock_time: lockTime(m).toISOString(),
            locked: isLocked(m), stage: m.stage, group: m.group, matchday: m.matchday || null, round: m.round || null,
            picks, reactions: reactionsFor(`match:${m.id}`),
          };
        })
        .filter((m) => m.picks.length > 0);
      const champions = db.championPicks
        .filter((c) => nameById.has(c.person_id))
        .map((c) => ({ person_id: c.person_id, name: nameById.get(c.person_id), avatar: avatarById.get(c.person_id), photo: photoById.get(c.person_id), team: c.team, flag: flagFor(c.team), reactions: reactionsFor(`champ:${c.person_id}`) }))
        .sort((a, b) => a.name.localeCompare(b.name));
      return send(res, 200, { matches, champions, serverTime: nowT.toISOString() });
    }

    // --- predict ---
    if (p === "/api/predict" && req.method === "POST") {
      const { personId, matchId, pick } = await readBody(req);
      const person = getPerson(personId);
      if (!person) return send(res, 404, { error: "Unknown player." });
      const match = db.matches.find((m) => m.id === matchId);
      if (!match) return send(res, 404, { error: "Unknown match." });
      if (!["a_win", "draw", "b_win"].includes(pick)) return send(res, 400, { error: "Invalid pick." });
      if (isLocked(match)) return send(res, 403, { error: "This match is locked." });
      let pred = db.predictions.find((x) => x.person_id === personId && x.match_id === matchId);
      if (pred) {
        pred.pick = pick;
        pred.created_at = now().toISOString();
      } else {
        db.predictions.push({ id: uid(), person_id: personId, match_id: matchId, pick, created_at: now().toISOString() });
      }
      save();
      return send(res, 200, { ok: true, pick });
    }

    // --- champion ---
    if (p === "/api/teams" && req.method === "GET") {
      return send(res, 200, { teams: allTeams().map((t) => ({ name: t, flag: flagFor(t), crest: (db.teamCrests || {})[t] || null })) });
    }

    if (p === "/api/champion" && req.method === "GET") {
      const personId = q.get("personId");
      const champ = db.championPicks.find((c) => c.person_id === personId);
      return send(res, 200, {
        teams: allTeams().map((t) => ({ name: t, flag: flagFor(t), crest: (db.teamCrests || {})[t] || null })),
        pick: champ ? champ.team : null,
        path: champ ? championPath(champ.team) : null,
        locked: championLocked() || (db.config.championLock === "first_submission" && !!champ),
        lockMode: db.config.championLock,
        lockAt: db.config.championDeadline || null,
        winner: db.config.championWinner,
      });
    }

    if (p === "/api/champion" && req.method === "POST") {
      const { personId, team } = await readBody(req);
      const person = getPerson(personId);
      if (!person) return send(res, 404, { error: "Unknown player." });
      if (!allTeams().includes(team)) return send(res, 400, { error: "Unknown team." });
      const existing = db.championPicks.find((c) => c.person_id === personId);
      if (championLocked()) return send(res, 403, { error: "Champion pick is locked." });
      if (existing && db.config.championLock === "first_submission")
        return send(res, 403, { error: "You already locked your champion." });
      if (existing) {
        existing.team = team;
        existing.created_at = now().toISOString();
      } else {
        db.championPicks.push({ id: uid(), person_id: personId, team, created_at: now().toISOString() });
      }
      save();
      return send(res, 200, { ok: true, team });
    }

    // --- toggle an emoji reaction on a champion pick / match ---
    if (p === "/api/react" && req.method === "POST") {
      const { personId, key, emoji } = await readBody(req);
      const person = getPerson(personId);
      if (!person) return send(res, 404, { error: "Unknown player." });
      if (!REACTION_EMOJI.includes(emoji)) return send(res, 400, { error: "Invalid reaction." });
      if (!KEY_RE.test(key || "")) return send(res, 400, { error: "Invalid target." });
      const idx = db.reactions.findIndex((r) => r.key === key && r.emoji === emoji && r.person_id === personId);
      if (idx >= 0) db.reactions.splice(idx, 1); // toggle off
      else db.reactions.push({ id: uid(), key, emoji, person_id: personId, created_at: now().toISOString() });
      save();
      return send(res, 200, { ok: true, key, reactions: reactionsFor(key) });
    }

    // --- virtual betting: bankroll standings ---
    if (p === "/api/bankroll" && req.method === "GET") {
      const personId = q.get("personId");
      const rows = computeBankroll();
      const me = personId ? rows.find((r) => r.person_id === personId) : null;
      return send(res, 200, { rows, me: me || null, startingBankroll: db.config.startingBankroll || 1000, serverTime: now().toISOString() });
    }

    // --- virtual betting: place / change a bet ---
    if (p === "/api/bet" && req.method === "POST") {
      const { personId, matchId, pick, stake } = await readBody(req);
      const person = getPerson(personId);
      if (!person) return send(res, 404, { error: "Unknown player." });
      const match = db.matches.find((m) => m.id === matchId);
      if (!match) return send(res, 404, { error: "Unknown match." });
      if (!["a_win", "draw", "b_win"].includes(pick)) return send(res, 400, { error: "Invalid pick." });
      if (isLocked(match)) return send(res, 403, { error: "This match is locked." });
      const odds = pick === "a_win" ? match.odds_a : pick === "b_win" ? match.odds_b : match.odds_draw;
      if (odds == null) return send(res, 400, { error: "No odds available for this match yet." });
      const s = Math.round(Number(stake));
      if (!Number.isFinite(s) || s <= 0) return send(res, 400, { error: "Enter a stake greater than 0." });
      const existing = db.bets.find((b) => b.person_id === personId && b.match_id === matchId);
      const avail = personBalance(personId) + (existing ? existing.stake : 0); // freeing the old stake
      if (s > avail) return send(res, 400, { error: `Not enough balance — you have €${avail}.` });
      if (existing) { existing.pick = pick; existing.stake = s; existing.odds = odds; existing.created_at = now().toISOString(); }
      else db.bets.push({ id: uid(), person_id: personId, match_id: matchId, pick, stake: s, odds, created_at: now().toISOString() });
      save();
      return send(res, 200, { ok: true, balance: personBalance(personId), bet: { pick, stake: s, odds, potential: round2(s * odds) } });
    }

    // --- virtual betting: cancel a bet (before the match locks) ---
    if (p === "/api/bet/cancel" && req.method === "POST") {
      const { personId, matchId } = await readBody(req);
      const person = getPerson(personId);
      if (!person) return send(res, 404, { error: "Unknown player." });
      const match = db.matches.find((m) => m.id === matchId);
      if (match && isLocked(match)) return send(res, 403, { error: "This match is locked." });
      db.bets = db.bets.filter((b) => !(b.person_id === personId && b.match_id === matchId));
      save();
      return send(res, 200, { ok: true, balance: personBalance(personId) });
    }

    // --- roster (for @mentions) ---
    if (p === "/api/players" && req.method === "GET") {
      return send(res, 200, { players: db.people.map((x) => ({ id: x.id, name: x.display_name, photo: x.photo || null })) });
    }

    // --- team chat ---
    if (p === "/api/chat" && req.method === "GET") {
      const cut = Date.now() - 4500;
      const typing = Object.keys(typingMap)
        .filter((id) => typingMap[id] > cut)
        .map((id) => { const pp = getPerson(id); return pp ? { id, name: pp.display_name } : null; })
        .filter(Boolean);
      const readers = Object.keys(chatRead).map((id) => { const pp = getPerson(id); return pp ? { id, name: pp.display_name, ts: chatRead[id] } : null; }).filter(Boolean);
      return send(res, 200, { messages: chatView(), typing, readers, serverTime: now().toISOString() });
    }
    if (p === "/api/chat/seen" && req.method === "POST") {
      const { personId, ts } = await readBody(req);
      if (getPerson(personId) && ts) chatRead[personId] = Number(ts);
      return send(res, 200, { ok: true });
    }
    if (p === "/api/packs/open" && req.method === "POST") {
      const { personId } = await readBody(req);
      const person = getPerson(personId);
      if (!person) return send(res, 404, { error: "Unknown player." });
      if (!db.collections) db.collections = {};
      const col = db.collections[personId] || (db.collections[personId] = { cards: [], lastPack: null });
      const cd = PACK_COOLDOWN_H * 3600000;
      const wait = col.lastPack ? (new Date(col.lastPack).getTime() + cd - Date.now()) : 0;
      if (wait > 0) return send(res, 429, { error: "Your next pack isn't ready yet.", nextPackMs: wait });
      const card = pickCard();
      const isNew = !col.cards.some((c) => c.team === card.team);
      col.cards.push(card);
      col.lastPack = now().toISOString();
      save();
      return send(res, 200, {
        card: { team: card.team, rarity: card.rarity, flag: flagFor(card.team), crest: (db.teamCrests || {})[card.team] || null, isNew },
        collection: collectionView(personId),
      });
    }
    if (p === "/api/ping" && req.method === "POST") {
      const { personId } = await readBody(req);
      if (getPerson(personId)) presence[personId] = Date.now();
      return send(res, 200, { online: onlineIds() });
    }
    if (p === "/api/typing" && req.method === "POST") {
      const { personId } = await readBody(req);
      if (getPerson(personId)) typingMap[personId] = Date.now();
      return send(res, 200, { ok: true });
    }
    if (p === "/api/chat" && req.method === "POST") {
      const { personId, text, replyTo } = await readBody(req);
      const person = getPerson(personId);
      if (!person) return send(res, 404, { error: "Unknown player." });
      const clean = (text || "").trim().replace(/\s+/g, " ");
      if (!clean) return send(res, 400, { error: "Say something first." });
      if (clean.length > 500) return send(res, 400, { error: "Too long (max 500 characters)." });
      // only keep a valid reply reference
      const reply_to = replyTo && db.chat.some((m) => m.id === replyTo) ? replyTo : null;
      db.chat.push({ id: uid(), person_id: personId, text: clean, created_at: now().toISOString(), reply_to });
      if (db.chat.length > 2000) db.chat = db.chat.slice(-2000); // keep it bounded
      save();
      return send(res, 200, { ok: true, messages: chatView() });
    }
    if (p === "/api/chat/edit" && req.method === "POST") {
      const { personId, id, text } = await readBody(req);
      const person = getPerson(personId);
      if (!person) return send(res, 404, { error: "Unknown player." });
      const msg = db.chat.find((m) => m.id === id);
      if (!msg) return send(res, 404, { error: "Message not found." });
      if (msg.system || msg.person_id !== personId) return send(res, 403, { error: "You can only edit your own messages." });
      const clean = (text || "").trim().replace(/\s+/g, " ");
      if (!clean) return send(res, 400, { error: "Say something first." });
      if (clean.length > 500) return send(res, 400, { error: "Too long (max 500 characters)." });
      msg.text = clean;
      msg.edited_at = now().toISOString();
      save();
      return send(res, 200, { ok: true, messages: chatView() });
    }
    if (p === "/api/chat/delete" && req.method === "POST") {
      const { personId, id } = await readBody(req);
      const person = getPerson(personId);
      if (!person) return send(res, 404, { error: "Unknown player." });
      const msg = db.chat.find((m) => m.id === id);
      if (!msg) return send(res, 404, { error: "Message not found." });
      if (msg.person_id !== personId) return send(res, 403, { error: "You can only delete your own messages." });
      db.chat = db.chat.filter((m) => m.id !== id);
      save();
      return send(res, 200, { ok: true, messages: chatView() });
    }

    // --- groups: fixtures + computed standings table per group ---
    if (p === "/api/groups" && req.method === "GET") {
      const byGroup = {};
      const grouped = {};
      db.matches.filter((m) => m.stage === "group" && m.group).forEach((m) => { (grouped[m.group] = grouped[m.group] || []).push(m); });
      for (const g of Object.keys(grouped)) {
        const ms = grouped[g].slice().sort((a, b) => new Date(a.kickoff_time) - new Date(b.kickoff_time));
        // build the standings table from results we have (manual or API)
        const teams = {};
        const ensure = (name, crest, tla) => (teams[name] = teams[name] || { team: name, flag: flagFor(name), crest: crest || null, tla: tla || null, P: 0, W: 0, D: 0, L: 0, GF: 0, GA: 0, knownGD: true });
        for (const m of ms) {
          const A = ensure(m.team_a, m.crest_a, m.tla_a), B = ensure(m.team_b, m.crest_b, m.tla_b);
          if (m.result == null) continue;
          A.P++; B.P++;
          if (m.score_home != null && m.score_away != null) { A.GF += m.score_home; A.GA += m.score_away; B.GF += m.score_away; B.GA += m.score_home; }
          else { A.knownGD = false; B.knownGD = false; }
          if (m.result === "a_win") { A.W++; B.L++; }
          else if (m.result === "b_win") { B.W++; A.L++; }
          else { A.D++; B.D++; }
        }
        const table = Object.values(teams)
          .map((t) => ({ ...t, GD: t.GF - t.GA, Pts: t.W * 3 + t.D }))
          .sort((a, b) => b.Pts - a.Pts || b.GD - a.GD || b.GF - a.GF || a.team.localeCompare(b.team))
          .map((t, i) => ({ ...t, pos: i + 1 }));
        const fixtures = ms.map((m) => ({
          team_a: m.team_a, team_b: m.team_b,
          flag_a: flagFor(m.team_a), flag_b: flagFor(m.team_b),
          crest_a: m.crest_a || null, crest_b: m.crest_b || null,
          tla_a: m.tla_a || null, tla_b: m.tla_b || null,
          kickoff_time: m.kickoff_time, result: m.result,
          score_home: (m.score_home != null ? m.score_home : null),
          score_away: (m.score_away != null ? m.score_away : null),
        }));
        byGroup[g] = { table, fixtures };
      }
      return send(res, 200, { groups: byGroup, serverTime: now().toISOString() });
    }

    // --- group standings & top scorers (from football-data.org) ---
    if (p === "/api/standings" && req.method === "GET") {
      return send(res, 200, { standings: db.standings || [], serverTime: now().toISOString() });
    }

    // --- tournament info (for the countdown) ---
    if (p === "/api/info" && req.method === "GET") {
      const start = tournamentStart();
      return send(res, 200, {
        tournamentStart: start.toISOString(),
        serverTime: now().toISOString(),
        started: now() >= start,
        gateRequired: !!currentAccessCode(),
      });
    }

    // --- leaderboard (points) — also carries each player's bankroll balance ---
    if (p === "/api/leaderboard" && req.method === "GET") {
      const board = computeLeaderboard();
      const balById = new Map(computeBankroll().map((r) => [r.person_id, r.balance]));
      board.forEach((r) => { r.balance = balById.has(r.person_id) ? balById.get(r.person_id) : (db.config.startingBankroll || 1000); });
      return send(res, 200, { leaderboard: board, config: publicConfig(), serverTime: now().toISOString() });
    }

    // --- player profile (stats + full history of decided picks) ---
    if (p === "/api/profile" && req.method === "GET") {
      const person = getPerson(q.get("personId"));
      if (!person) return send(res, 404, { error: "Unknown player." });
      const row = computeLeaderboard().find((r) => r.person_id === person.id);
      const byMatch = new Map(db.matches.map((m) => [m.id, m]));
      const history = db.predictions
        .filter((pr) => pr.person_id === person.id)
        .map((pr) => ({ pr, m: byMatch.get(pr.match_id) }))
        .filter((x) => x.m && x.m.result !== null)
        .sort((a, b) => new Date(b.m.kickoff_time) - new Date(a.m.kickoff_time)) // newest first
        .map(({ pr, m }) => ({
          match_id: m.id, team_a: m.team_a, team_b: m.team_b,
          flag_a: flagFor(m.team_a), flag_b: flagFor(m.team_b),
          crest_a: m.crest_a || null, crest_b: m.crest_b || null,
          stage: m.stage, group: m.group, round: m.round || null, kickoff_time: m.kickoff_time,
          score_home: (m.score_home != null ? m.score_home : null),
          score_away: (m.score_away != null ? m.score_away : null),
          result: m.result, pick: pr.pick, correct: pr.pick === m.result,
        }));
      // streaks (history is newest-first)
      let currentStreak = 0;
      for (const h of history) { if (h.correct) currentStreak++; else break; }
      let bestStreak = 0, run = 0;
      for (let i = history.length - 1; i >= 0; i--) { if (history[i].correct) { run++; if (run > bestStreak) bestStreak = run; } else run = 0; }
      const decided = row ? row.decided : history.length;
      const correct = row ? row.correct : history.filter((h) => h.correct).length;
      const champ = db.championPicks.find((c) => c.person_id === person.id);
      // betting summary (balance, profit, stake in play, bets won, etc.)
      const bankRow = computeBankroll().find((r) => r.person_id === person.id) || {};
      const myBets = db.bets.filter((b) => b.person_id === person.id);
      const openCount = myBets.filter((b) => { const m = byMatch.get(b.match_id); return !m || m.result == null; }).length;
      const staked = myBets.reduce((s, b) => s + b.stake, 0);
      const betting = {
        balance: bankRow.balance != null ? bankRow.balance : personBalance(person.id),
        profit: bankRow.profit || 0,
        inPlay: bankRow.open || 0,
        openCount,
        wins: bankRow.wins || 0,
        settled: bankRow.settled || 0,
        bets: myBets.length,
        staked: round2(staked),
      };
      return send(res, 200, {
        person: publicPerson(person),
        rank: row ? row.rank : null,
        points: row ? row.points : 0,
        bankroll: personBalance(person.id),
        correct, decided,
        accuracy: decided ? Math.round((correct / decided) * 100) : 0,
        currentStreak, bestStreak,
        betting,
        risk: computeRisk(person.id),
        rivals: computeRivals(person.id),
        champion: champ ? { team: champ.team, flag: flagFor(champ.team), crest: (db.teamCrests || {})[champ.team] || null, correct: row ? row.championCorrect : false } : null,
        championWinner: db.config.championWinner,
        history,
        serverTime: now().toISOString(),
      });
    }

    // --- edit your own profile (name + PIN; PIN-protected if one is set) ---
    if (p === "/api/profile/update" && req.method === "POST") {
      const { personId, pin, newName, newPin, newPhoto } = await readBody(req);
      const person = getPerson(personId);
      if (!person) return send(res, 404, { error: "Unknown player." });
      if (person.pinHash && !verifyPin(String(pin || ""), person.pinHash)) return send(res, 401, { error: "Wrong current PIN." });
      if (newPhoto !== undefined) {
        if (newPhoto === null || newPhoto === "") { deletePhoto(person.photo); person.photo = null; }
        else if (typeof newPhoto === "string" && /^data:image\//.test(newPhoto)) {
          if (newPhoto.length > 400000) return send(res, 413, { error: "Image too large — try a smaller photo." });
          deletePhoto(person.photo); // remove the previous file (if any)
          person.photo = storePhoto(person.id, newPhoto); // write to /avatars, keep only the path in JSON
        } else return send(res, 400, { error: "Invalid image." });
      }
      if (newName !== undefined) {
        const clean = String(newName).trim().replace(/\s+/g, " ");
        if (!clean) return send(res, 400, { error: "Name can't be empty." });
        if (clean.length > 40) return send(res, 400, { error: "Name is too long (max 40)." });
        if (db.people.some((x) => x.id !== person.id && x.display_name.toLowerCase() === clean.toLowerCase()))
          return send(res, 409, { error: "That name is already taken." });
        person.display_name = clean;
      }
      if (newPin !== undefined && newPin !== null) {
        const cp = String(newPin).trim();
        if (cp !== "") {
          if (!/^\d{4,8}$/.test(cp)) return send(res, 400, { error: "PIN must be 4–8 digits." });
          person.pinHash = hashPin(cp);
        }
      }
      save();
      // PIN may have changed → token changes too; hand back a fresh one.
      return send(res, 200, { person: publicPerson(person), token: authToken(person) });
    }

    // --- admin (lightly protected by key) ---
    const adminKey = req.headers["x-admin-key"] || q.get("key");
    const requireAdmin = () => safeEq(adminKey, ADMIN_KEY);

    if (p === "/api/admin/matches" && req.method === "GET") {
      if (!requireAdmin()) return send(res, 401, { error: "Bad admin key." });
      return send(res, 200, { matches: db.matches.map((m) => matchView(m, null)), config: publicConfig() });
    }

    if (p === "/api/admin/result" && req.method === "POST") {
      if (!requireAdmin()) return send(res, 401, { error: "Bad admin key." });
      const { matchId, result } = await readBody(req);
      const match = db.matches.find((m) => m.id === matchId);
      if (!match) return send(res, 404, { error: "Unknown match." });
      if (result !== null && !["a_win", "draw", "b_win"].includes(result))
        return send(res, 400, { error: "Invalid result." });
      const hadResult = match.result;
      match.result = result; // null clears it
      if (!hadResult && result) announceMatch(match, "final"); // auto chat on first result
      save();
      return send(res, 200, { ok: true, leaderboard: computeLeaderboard() });
    }

    if (p === "/api/admin/predict" && req.method === "POST") {
      // set a player's pick for a match (admin override — ignores the kickoff lock)
      if (!requireAdmin()) return send(res, 401, { error: "Bad admin key." });
      const { name, teamA, teamB, pick } = await readBody(req);
      const person = db.people.find((x) => x.display_name.toLowerCase() === (name || "").trim().toLowerCase());
      if (!person) return send(res, 404, { error: `No player named "${name}".` });
      const norm = (s) => (canonicalTeam ? canonicalTeam(String(s || "").trim()) : String(s || "").trim());
      const eq = (x, y) => String(x || "").toLowerCase() === String(y || "").toLowerCase();
      const A = norm(teamA), B = norm(teamB);
      const match = db.matches.find((m) => (eq(norm(m.team_a), A) && eq(norm(m.team_b), B)) || (eq(norm(m.team_a), B) && eq(norm(m.team_b), A)));
      if (!match) return send(res, 404, { error: `No match between "${teamA}" and "${teamB}".` });
      let result;
      const pk = String(pick || "").trim().toLowerCase();
      if (pk === "draw" || pk === "x") result = "draw";
      else if (eq(norm(pick), norm(match.team_a))) result = "a_win";
      else if (eq(norm(pick), norm(match.team_b))) result = "b_win";
      else if (["a_win", "b_win", "draw"].includes(pk)) result = pk;
      else return send(res, 400, { error: `Pick must be one of the two teams or "draw" (got "${pick}").` });
      let pred = db.predictions.find((x) => x.person_id === person.id && x.match_id === match.id);
      if (pred) { pred.pick = result; pred.created_at = now().toISOString(); }
      else db.predictions.push({ id: uid(), person_id: person.id, match_id: match.id, pick: result, created_at: now().toISOString() });
      save();
      const picked = result === "a_win" ? match.team_a : result === "b_win" ? match.team_b : "Draw";
      return send(res, 200, { ok: true, player: person.display_name, match: `${match.team_a} v ${match.team_b}`, pick: result, picked });
    }

    if (p === "/api/admin/clearpicks" && req.method === "POST") {
      // remove a player's picks for every match that kicks off AFTER a reference match
      if (!requireAdmin()) return send(res, 401, { error: "Bad admin key." });
      const { name, afterTeamA, afterTeamB } = await readBody(req);
      const person = db.people.find((x) => x.display_name.toLowerCase() === (name || "").trim().toLowerCase());
      if (!person) return send(res, 404, { error: `No player named "${name}".` });
      const norm = (s) => (canonicalTeam ? canonicalTeam(String(s || "").trim()) : String(s || "").trim());
      const eq = (x, y) => String(x || "").toLowerCase() === String(y || "").toLowerCase();
      const A = norm(afterTeamA), B = norm(afterTeamB);
      const ref = db.matches.find((m) => (eq(norm(m.team_a), A) && eq(norm(m.team_b), B)) || (eq(norm(m.team_a), B) && eq(norm(m.team_b), A)));
      if (!ref) return send(res, 404, { error: `No match between "${afterTeamA}" and "${afterTeamB}".` });
      const refK = new Date(ref.kickoff_time).getTime();
      const byId = new Map(db.matches.map((m) => [m.id, m]));
      const before = db.predictions.length;
      db.predictions = db.predictions.filter((pr) => {
        if (pr.person_id !== person.id) return true;
        const m = byId.get(pr.match_id);
        if (!m) return true;
        return new Date(m.kickoff_time).getTime() <= refK; // keep the reference match and anything earlier
      });
      const removed = before - db.predictions.length;
      save();
      return send(res, 200, { ok: true, player: person.display_name, after: `${ref.team_a} v ${ref.team_b}`, removed });
    }

    if (p === "/api/admin/resetpin" && req.method === "POST") {
      // clear a player's PIN so they can set a new one on their next login
      if (!requireAdmin()) return send(res, 401, { error: "Bad admin key." });
      const { name } = await readBody(req);
      const person = db.people.find((x) => x.display_name.toLowerCase() === (name || "").trim().toLowerCase());
      if (!person) return send(res, 404, { error: `No player named "${name}".` });
      delete person.pinHash;
      save();
      return send(res, 200, { ok: true, player: person.display_name });
    }

    if (p === "/api/admin/match" && req.method === "POST") {
      // create or update a match (used to fill knockout teams / kickoff)
      if (!requireAdmin()) return send(res, 401, { error: "Bad admin key." });
      const b = await readBody(req);
      if (b.id) {
        const m = db.matches.find((x) => x.id === b.id);
        if (!m) return send(res, 404, { error: "Unknown match." });
        ["team_a", "team_b", "kickoff_time", "stage", "round", "group"].forEach((k) => {
          if (b[k] !== undefined) m[k] = b[k];
        });
      } else {
        const newId = Math.max(0, ...db.matches.map((m) => m.id)) + 1;
        db.matches.push({
          id: newId,
          team_a: b.team_a || "TBD",
          team_b: b.team_b || "TBD",
          group: b.group || null,
          stage: b.stage || "knockout",
          round: b.round || null,
          matchday: null,
          kickoff_time: b.kickoff_time,
          result: null,
        });
      }
      save();
      return send(res, 200, { ok: true });
    }

    if (p === "/api/admin/config" && req.method === "POST") {
      if (!requireAdmin()) return send(res, 401, { error: "Bad admin key." });
      const b = await readBody(req);
      ["matchPoints", "championPoints", "knockoutDouble", "championLock", "championWinner", "lockLeadHours",
       "dataSource", "autoSync", "apiCompetition", "apiKey", "accessCode",
       "startingBankroll", "oddsApiKey", "oddsSport", "oddsRegion"].forEach((k) => {
        if (b[k] !== undefined) db.config[k] = b[k];
      });
      save();
      scheduleNextSync(); // (re)arm or stop the background poller based on new settings
      scheduleOddsSync(); // (re)arm odds polling if a key was just added/removed
      return send(res, 200, { ok: true, config: publicConfig(), leaderboard: computeLeaderboard() });
    }

    if (p === "/api/admin/photo" && req.method === "POST") {
      if (!requireAdmin()) return send(res, 401, { error: "Bad admin key." });
      const { name, photo } = await readBody(req);
      const person = db.people.find((x) => x.display_name.toLowerCase() === (name || "").trim().toLowerCase());
      if (!person) return send(res, 404, { error: `No player named "${name}".` });
      deletePhoto(person.photo); // clear any previous avatar file
      person.photo = photo ? storePhoto(person.id, photo) : null; // data URI → file; URL kept as-is; null clears
      save();
      return send(res, 200, { ok: true, name: person.display_name, hasPhoto: !!person.photo });
    }

    if (p === "/api/admin/rename" && req.method === "POST") {
      if (!requireAdmin()) return send(res, 401, { error: "Bad admin key." });
      const { from, to } = await readBody(req);
      const newName = (to || "").trim();
      if (!newName) return send(res, 400, { error: "New name required." });
      if (newName.length > 40) return send(res, 400, { error: "Name too long (max 40)." });
      const person = db.people.find((x) => x.display_name.toLowerCase() === (from || "").trim().toLowerCase());
      if (!person) return send(res, 404, { error: `No player named "${from}".` });
      if (db.people.some((x) => x !== person && x.display_name.toLowerCase() === newName.toLowerCase()))
        return send(res, 409, { error: `"${newName}" is already taken.` });
      const old = person.display_name;
      person.display_name = newName;
      save();
      return send(res, 200, { ok: true, from: old, to: newName });
    }

    if (p === "/api/admin/sync" && req.method === "POST") {
      if (!requireAdmin()) return send(res, 401, { error: "Bad admin key." });
      try {
        const summary = await syncFromFootballData();
        scheduleNextSync();
        return send(res, 200, { ok: true, summary, config: publicConfig() });
      } catch (e) {
        db.config.lastSyncMsg = "Sync failed: " + e.message;
        save();
        return send(res, 502, { error: e.message, config: publicConfig() });
      }
    }

    if (p === "/api/admin/sync-odds" && req.method === "POST") {
      if (!requireAdmin()) return send(res, 401, { error: "Bad admin key." });
      try {
        const summary = await syncOdds();
        return send(res, 200, { ok: true, summary, config: publicConfig() });
      } catch (e) {
        db.config.lastOddsMsg = "Odds sync failed: " + e.message;
        save();
        return send(res, 502, { error: e.message, config: publicConfig() });
      }
    }

    return send(res, 404, { error: "Not found." });
  } catch (err) {
    return send(res, 500, { error: String(err && err.message) });
  }
});

// Keep the process alive if a stray error escapes (e.g. in a background timer)
// instead of dying silently — log it and carry on.
process.on("uncaughtException", (e) => console.error("uncaughtException:", e && e.stack || e));
process.on("unhandledRejection", (e) => console.error("unhandledRejection:", e && e.stack || e));

// Flush any pending (debounced) write before the process exits, so a deploy/restart
// (Render sends SIGTERM) can't drop the last change.
let shuttingDown = false;
function shutdown(sig) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\n  ${sig} received — flushing data and shutting down…`);
  try { saveNow(); } catch (e) { console.error("  save on exit failed:", e.message); }
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref(); // don't hang forever
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// Warn loudly about insecure/missing config at boot — catches the common deploy footguns.
function startupChecks() {
  const warn = [];
  if (ADMIN_KEY === "worldcup-admin") warn.push("ADMIN_KEY is still the default — set a strong ADMIN_KEY env var, or anyone can use admin endpoints.");
  if (!currentAccessCode()) warn.push("No ACCESS_CODE set — the app is open to anyone with the URL. Set ACCESS_CODE (or run: node admin.js gate \"CODE\").");
  if (!process.env.GATE_SECRET) warn.push("GATE_SECRET not set — login tokens are signed with a secret stored in the data file. Set GATE_SECRET env for stronger separation.");
  if (warn.length) {
    console.warn("\n  ⚠  Security checklist:");
    warn.forEach((w) => console.warn(`     • ${w}`));
    console.warn("");
  } else {
    console.log("  ✓  Security checklist: ADMIN_KEY, ACCESS_CODE and GATE_SECRET all set.\n");
  }
}

load();
scheduleNextSync(); // arm background polling if API mode + autoSync were enabled
scheduleOddsSync(); // arm budgeted odds polling if an odds key is set
server.listen(PORT, () => {
  console.log(`\n  ⚽  World Cup Predictor running:  http://localhost:${PORT}`);
  console.log(`      Admin view:  http://localhost:${PORT}/?admin=1   (key: "${ADMIN_KEY}")`);
  console.log(`      Data file:   ${DATA_FILE}\n`);
  startupChecks();
});
