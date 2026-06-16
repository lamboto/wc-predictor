#!/usr/bin/env node
// Terminal admin tool for the World Cup Predictor.
// The web app has NO admin UI — all admin actions go through here.
//
// Usage (server must be running):
//   node admin.js status
//   node admin.js list [filter]
//   node admin.js result <matchId> <a_win|draw|b_win|clear>
//   node admin.js teams <matchId> "<Team A>" "<Team B>"   # fill a knockout fixture
//   node admin.js winner "<Team>"                          # award champion bonus
//   node admin.js pick "<name>" "<Team A>" "<Team B>" "<winner|draw>"  # set a player's pick (admin override)
//   node admin.js clearafter "<name>" "<Team A>" "<Team B>"  # remove a player's picks for matches after this one
//   node admin.js resetpin "<name>"                         # clear a player's PIN (they set a new one next login)
//   node admin.js rename "<old name>" "<new name>"          # rename a player (keeps points)
//   node admin.js set <key> <value>                        # config: knockoutDouble,
//        lockLeadHours, championLock, dataSource, autoSync, apiCompetition, apiKey
//   node admin.js sync                                      # pull from football-data.org
//   node admin.js odds-key "<the-odds-api token>"           # enable betting odds (odds-key off to clear)
//   node admin.js sync-odds                                 # pull 1X2 odds from the-odds-api.com
//   node admin.js gate "TEAMCODE"                           # lock app behind a shared code (gate off: gate off)
//
// Env: ADMIN_KEY (default "worldcup-admin"), PORT (default 3000), BASE (full URL override).

const KEY = process.env.ADMIN_KEY || "worldcup-admin";
const BASE = process.env.BASE || `http://localhost:${process.env.PORT || 3000}`;

async function call(path, method = "GET", body) {
  const url = `${BASE}${path}${path.includes("?") ? "&" : "?"}key=${encodeURIComponent(KEY)}`;
  let r;
  try {
    r = await fetch(url, { method, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) });
  } catch (e) {
    console.error(`\n✗ Can't reach the server at ${BASE}. Is it running (node server.js)?\n`);
    process.exit(1);
  }
  const data = await r.json().catch(() => ({}));
  if (!r.ok) { console.error(`✗ ${data.error || r.status}`); process.exit(1); }
  return data;
}

const fmt = (iso) => new Date(iso).toLocaleString();
const RES = { a_win: "A win", draw: "Draw", b_win: "B win", null: "—" };

(async () => {
  const [cmd, a, b, c, d] = process.argv.slice(2);

  if (!cmd || cmd === "help" || cmd === "-h") {
    const lines = require("fs").readFileSync(__filename, "utf8").split("\n").slice(1);
    const help = [];
    for (const l of lines) { if (!l.startsWith("//")) break; help.push(l.replace(/^\/\/ ?/, "")); }
    console.log(help.join("\n"));
    return;
  }

  if (cmd === "status") {
    const { config, leaderboard } = await call("/api/leaderboard");
    console.log("\nConfig:");
    console.log(`  data source     : ${config.dataSource}${config.hasApiKey ? " (API key set)" : ""}`);
    console.log(`  auto-sync       : ${config.autoSync}`);
    console.log(`  betting closes  : ${config.lockLeadHours}h before kickoff`);
    console.log(`  knockout double : ${config.knockoutDouble}`);
    console.log(`  champion lock   : ${config.championLock}`);
    console.log(`  champion winner : ${config.championWinner || "—"}`);
    console.log(`  last sync       : ${config.lastSync ? fmt(config.lastSync) : "never"}${config.lastSyncMsg ? " · " + config.lastSyncMsg : ""}`);
    console.log("\nLeaderboard:");
    leaderboard.forEach((r) => console.log(`  ${String(r.rank).padStart(2)}. ${r.name.padEnd(16)} ${String(r.points).padStart(3)} pts  (${r.correct} correct, champ ${r.champion || "—"})`));
    console.log("");
    return;
  }

  if (cmd === "list") {
    const { matches } = await call("/api/admin/matches");
    const f = (a || "").toLowerCase();
    matches
      .filter((m) => !f || m.team_a.toLowerCase().includes(f) || m.team_b.toLowerCase().includes(f))
      .sort((x, y) => new Date(x.kickoff_time) - new Date(y.kickoff_time))
      .forEach((m) => {
        const meta = m.stage === "knockout" ? (m.round || "KO") : `Grp ${m.group} MD${m.matchday || ""}`;
        console.log(`#${String(m.id).padStart(3)}  ${(m.team_a + " v " + m.team_b).padEnd(34)} ${meta.padEnd(14)} ${fmt(m.kickoff_time).padEnd(22)} ${RES[m.result] || "—"}`);
      });
    return;
  }

  if (cmd === "result") {
    if (!a || !b) { console.error("usage: node admin.js result <matchId> <a_win|draw|b_win|clear>"); process.exit(1); }
    const result = b === "clear" ? null : b;
    await call("/api/admin/result", "POST", { matchId: Number(a), result });
    console.log(`✓ match #${a} → ${b}`);
    return;
  }

  if (cmd === "teams") {
    if (!a || !b || !c) { console.error('usage: node admin.js teams <matchId> "<Team A>" "<Team B>"'); process.exit(1); }
    await call("/api/admin/match", "POST", { id: Number(a), team_a: b, team_b: c });
    console.log(`✓ match #${a} → ${b} v ${c}`);
    return;
  }

  if (cmd === "photo") {
    // node admin.js photo "Name" /path/to/pic.jpg   (or a URL, or "clear")
    if (!a || !b) { console.error('usage: node admin.js photo "<name>" <image-file | url | clear>'); process.exit(1); }
    const fs = require("fs");
    let photo = b;
    if (b === "clear") {
      photo = null;
    } else if (/^https?:\/\//i.test(b)) {
      photo = b; // external URL — use as-is
    } else if (fs.existsSync(b)) {
      // local file — auto-shrink to ~320px (macOS sips), then embed as data URI
      let srcFile = b, mime = "image/jpeg";
      try {
        const os = require("os"), path = require("path"), { execFileSync } = require("child_process");
        const tmp = path.join(os.tmpdir(), `wcp-photo-${Date.now()}.jpg`);
        execFileSync("sips", ["-Z", "320", "-s", "format", "jpeg", b, "--out", tmp], { stdio: "ignore" });
        srcFile = tmp;
        console.log("  ↳ auto-shrunk to ~320px");
      } catch (e) {
        const ext = (b.split(".").pop() || "png").toLowerCase();
        mime = ext === "png" ? "image/png" : ext === "webp" ? "image/webp" : "image/jpeg";
        console.warn("  ⚠ couldn't auto-shrink (sips unavailable) — using original");
      }
      const buf = fs.readFileSync(srcFile);
      photo = `data:${mime};base64,${buf.toString("base64")}`;
      console.log(`  image size: ${Math.round(buf.length / 1024)}KB`);
    } else if (b.startsWith("/")) {
      photo = b; // site-relative URL like /avatars/x.png
    } else {
      console.error(`✗ File not found: ${b}`); process.exit(1);
    }
    await call("/api/admin/photo", "POST", { name: a, photo });
    console.log(photo ? `✓ photo set for "${a}"` : `✓ photo cleared for "${a}"`);
    return;
  }

  if (cmd === "rename") {
    if (!a || !b) { console.error('usage: node admin.js rename "<old name>" "<new name>"'); process.exit(1); }
    await call("/api/admin/rename", "POST", { from: a, to: b });
    console.log(`✓ renamed "${a}" → "${b}" (predictions & points kept)`);
    return;
  }

  if (cmd === "pick") {
    // node admin.js pick "<name>" "<Team A>" "<Team B>" "<winner team | draw>"
    if (!a || !b || !c || !d) { console.error('usage: node admin.js pick "<name>" "<Team A>" "<Team B>" "<winner team | draw>"'); process.exit(1); }
    const r = await call("/api/admin/predict", "POST", { name: a, teamA: b, teamB: c, pick: d });
    console.log(`✓ ${r.player} → ${r.match}: picked ${r.picked}`);
    return;
  }

  if (cmd === "clearafter") {
    // node admin.js clearafter "<name>" "<Team A>" "<Team B>"  → wipes that player's picks for matches kicking off after this one
    if (!a || !b || !c) { console.error('usage: node admin.js clearafter "<name>" "<Team A>" "<Team B>"'); process.exit(1); }
    const r = await call("/api/admin/clearpicks", "POST", { name: a, afterTeamA: b, afterTeamB: c });
    console.log(`✓ ${r.player}: removed ${r.removed} pick(s) after ${r.after}`);
    return;
  }

  if (cmd === "resetpin") {
    // node admin.js resetpin "<name>"  → clears the PIN; they set a new one on next login
    if (!a) { console.error('usage: node admin.js resetpin "<name>"'); process.exit(1); }
    const r = await call("/api/admin/resetpin", "POST", { name: a });
    console.log(`✓ PIN reset for "${r.player}". They log in with their name and the new PIN they type becomes their PIN — tell them to do it soon.`);
    return;
  }

  if (cmd === "winner") {
    if (!a) { console.error('usage: node admin.js winner "<Team>"'); process.exit(1); }
    await call("/api/admin/config", "POST", { championWinner: a });
    console.log(`✓ tournament winner set to ${a} (champion bonuses awarded)`);
    return;
  }

  if (cmd === "gate") {
    // node admin.js gate "CODE"   |   node admin.js gate off
    if (!a) { console.error('usage: node admin.js gate "<code>"   (or: gate off)'); process.exit(1); }
    const code = (a === "off" || a === "none") ? null : a;
    await call("/api/admin/config", "POST", { accessCode: code });
    console.log(code ? `✓ access gate ON — code: "${code}" (share it only with your team)` : "✓ access gate OFF");
    return;
  }

  if (cmd === "set") {
    if (!a || b === undefined) { console.error("usage: node admin.js set <key> <value>"); process.exit(1); }
    let val = b;
    if (val === "true") val = true; else if (val === "false") val = false;
    else if (val === "null" || val === "none") val = null;
    else if (!isNaN(Number(val)) && !["apiKey", "apiCompetition", "accessCode"].includes(a)) val = Number(val);
    const { config } = await call("/api/admin/config", "POST", { [a]: val });
    console.log(`✓ ${a} = ${a === "apiKey" ? "(hidden)" : JSON.stringify(config[a])}`);
    return;
  }

  if (cmd === "enable-api") {
    // One-shot: store the token, switch to API mode, turn on auto-sync, and sync now.
    if (!a) { console.error('usage: node admin.js enable-api "<football-data.org token>"'); process.exit(1); }
    await call("/api/admin/config", "POST", { apiKey: a, dataSource: "api", autoSync: true });
    console.log("✓ API key stored, data source = api, auto-sync on");
    const { summary } = await call("/api/admin/sync", "POST", {});
    console.log(`✓ first sync: ${summary.total} matches (${summary.added} new, ${summary.updated} updated, ${summary.results} results)`);
    return;
  }

  if (cmd === "sync") {
    const { summary } = await call("/api/admin/sync", "POST", {});
    console.log(`✓ synced: ${summary.total} matches (${summary.added} new, ${summary.updated} updated, ${summary.results} results)`);
    return;
  }

  if (cmd === "odds-key") {
    // node admin.js odds-key "<token>"   |   node admin.js odds-key off
    if (!a) { console.error('usage: node admin.js odds-key "<the-odds-api token>"   (or: odds-key off)'); process.exit(1); }
    const key = (a === "off" || a === "none") ? null : a;
    await call("/api/admin/config", "POST", { oddsApiKey: key });
    console.log(key ? '✓ odds API key stored — now run: node admin.js sync-odds' : "✓ odds API key cleared");
    return;
  }

  if (cmd === "sync-odds") {
    const { summary } = await call("/api/admin/sync-odds", "POST", {});
    console.log(`✓ odds synced: ${summary.matched} match(es) matched from ${summary.events} events`);
    return;
  }

  console.error(`Unknown command "${cmd}". Run: node admin.js help`);
  process.exit(1);
})();
