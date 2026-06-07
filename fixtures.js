// Real 2026 FIFA World Cup data (hosts: Canada, Mexico, USA).
// Group compositions are the official draw (6 Dec 2025). Kickoff times are
// representative ET times; matchday 1 and matchday 3 dates follow the FIFA
// schedule, matchday 2 is interpolated. Admin can adjust any match.

// Group order = seeded positions 1..4 (used to build the round-robin).
const GROUPS = {
  A: { teams: ["Mexico", "South Africa", "South Korea", "Czech Republic"], md1: "2026-06-11", md3: "2026-06-24" },
  B: { teams: ["Canada", "Bosnia and Herzegovina", "Qatar", "Switzerland"], md1: "2026-06-12", md3: "2026-06-24" },
  C: { teams: ["Brazil", "Morocco", "Haiti", "Scotland"], md1: "2026-06-13", md3: "2026-06-24" },
  D: { teams: ["United States", "Paraguay", "Australia", "Turkey"], md1: "2026-06-12", md3: "2026-06-25" },
  E: { teams: ["Germany", "Curacao", "Ivory Coast", "Ecuador"], md1: "2026-06-14", md3: "2026-06-25" },
  F: { teams: ["Netherlands", "Japan", "Sweden", "Tunisia"], md1: "2026-06-14", md3: "2026-06-25" },
  G: { teams: ["Belgium", "Egypt", "Iran", "New Zealand"], md1: "2026-06-15", md3: "2026-06-26" },
  H: { teams: ["Spain", "Cape Verde", "Saudi Arabia", "Uruguay"], md1: "2026-06-15", md3: "2026-06-26" },
  I: { teams: ["France", "Senegal", "Iraq", "Norway"], md1: "2026-06-16", md3: "2026-06-26" },
  J: { teams: ["Argentina", "Algeria", "Austria", "Jordan"], md1: "2026-06-16", md3: "2026-06-27" },
  K: { teams: ["Portugal", "DR Congo", "Uzbekistan", "Colombia"], md1: "2026-06-17", md3: "2026-06-27" },
  L: { teams: ["England", "Croatia", "Ghana", "Panama"], md1: "2026-06-17", md3: "2026-06-27" },
};

// Standard FIFA round-robin pairing using seed positions (1-indexed).
const ROUNDS = [
  { md: 1, pairs: [[1, 2], [3, 4]] },
  { md: 2, pairs: [[1, 3], [4, 2]] },
  { md: 3, pairs: [[4, 1], [2, 3]] },
];

const KICK_HOURS = ["12:00", "15:00", "18:00", "21:00"]; // staggered ET kickoffs

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function isoKickoff(dateStr, hour) {
  // Treat as US Eastern (UTC-4 in June, EDT).
  return `${dateStr}T${hour}:00-04:00`;
}

// Build the 72 group-stage matches with real teams.
function buildGroupMatches() {
  const matches = [];
  let id = 1;
  let hourIdx = 0;
  for (const [g, info] of Object.entries(GROUPS)) {
    const md2date = addDays(info.md1, 5);
    const dateFor = { 1: info.md1, 2: md2date, 3: info.md3 };
    for (const round of ROUNDS) {
      for (const [a, b] of round.pairs) {
        matches.push({
          id: id++,
          team_a: info.teams[a - 1],
          team_b: info.teams[b - 1],
          group: g,
          stage: "group",
          matchday: round.md,
          kickoff_time: isoKickoff(dateFor[round.md], KICK_HOURS[hourIdx % KICK_HOURS.length]),
          result: null,
        });
        hourIdx++;
      }
    }
  }
  return matches;
}

// Knockout skeleton (teams TBD; admin sets teams + results as the bracket fills).
function buildKnockoutMatches(startId) {
  const rounds = [
    { stage: "knockout", round: "Round of 32", count: 16, start: "2026-06-28", end: "2026-07-03" },
    { stage: "knockout", round: "Round of 16", count: 8, start: "2026-07-04", end: "2026-07-07" },
    { stage: "knockout", round: "Quarter-final", count: 4, start: "2026-07-09", end: "2026-07-11" },
    { stage: "knockout", round: "Semi-final", count: 2, start: "2026-07-14", end: "2026-07-15" },
    { stage: "knockout", round: "Third place", count: 1, start: "2026-07-18", end: "2026-07-18" },
    { stage: "knockout", round: "Final", count: 1, start: "2026-07-19", end: "2026-07-19" },
  ];
  const matches = [];
  let id = startId;
  for (const r of rounds) {
    for (let i = 0; i < r.count; i++) {
      // Spread matches across the round's date window.
      const span = (new Date(r.end) - new Date(r.start)) / 86400000;
      const dayOffset = r.count > 1 ? Math.round((i / (r.count - 1)) * span) : 0;
      const date = addDays(r.start, dayOffset);
      matches.push({
        id: id++,
        team_a: "TBD",
        team_b: "TBD",
        group: null,
        stage: "knockout",
        matchday: null,
        round: r.round,
        kickoff_time: isoKickoff(date, "18:00"),
        result: null,
      });
    }
  }
  return matches;
}

function buildAllMatches() {
  const group = buildGroupMatches();
  const knockout = buildKnockoutMatches(group.length + 1);
  return [...group, ...knockout];
}

// Emoji flags for every team (England/Scotland use the regional tag sequences).
const FLAGS = {
  "Mexico": "🇲🇽", "South Africa": "🇿🇦", "South Korea": "🇰🇷", "Czech Republic": "🇨🇿",
  "Canada": "🇨🇦", "Bosnia and Herzegovina": "🇧🇦", "Qatar": "🇶🇦", "Switzerland": "🇨🇭",
  "Brazil": "🇧🇷", "Morocco": "🇲🇦", "Haiti": "🇭🇹", "Scotland": "🏴󠁧󠁢󠁳󠁣󠁴󠁿",
  "United States": "🇺🇸", "Paraguay": "🇵🇾", "Australia": "🇦🇺", "Turkey": "🇹🇷",
  "Germany": "🇩🇪", "Curacao": "🇨🇼", "Ivory Coast": "🇨🇮", "Ecuador": "🇪🇨",
  "Netherlands": "🇳🇱", "Japan": "🇯🇵", "Sweden": "🇸🇪", "Tunisia": "🇹🇳",
  "Belgium": "🇧🇪", "Egypt": "🇪🇬", "Iran": "🇮🇷", "New Zealand": "🇳🇿",
  "Spain": "🇪🇸", "Cape Verde": "🇨🇻", "Saudi Arabia": "🇸🇦", "Uruguay": "🇺🇾",
  "France": "🇫🇷", "Senegal": "🇸🇳", "Iraq": "🇮🇶", "Norway": "🇳🇴",
  "Argentina": "🇦🇷", "Algeria": "🇩🇿", "Austria": "🇦🇹", "Jordan": "🇯🇴",
  "Portugal": "🇵🇹", "DR Congo": "🇨🇩", "Uzbekistan": "🇺🇿", "Colombia": "🇨🇴",
  "England": "🏴󠁧󠁢󠁥󠁮󠁧󠁿", "Croatia": "🇭🇷", "Ghana": "🇬🇭", "Panama": "🇵🇦",
};

// football-data.org (and other feeds) spell some nations differently — map to our keys.
const ALIASES = {
  "Korea Republic": "South Korea", "Republic of Korea": "South Korea", "South Korea": "South Korea",
  "Côte d'Ivoire": "Ivory Coast", "Cote d'Ivoire": "Ivory Coast",
  "USA": "United States", "United States of America": "United States",
  "Czechia": "Czech Republic", "Türkiye": "Turkey", "Turkiye": "Turkey",
  "Cabo Verde": "Cape Verde", "Curaçao": "Curacao",
  "Congo DR": "DR Congo", "DR Congo": "DR Congo", "Democratic Republic of the Congo": "DR Congo",
  "IR Iran": "Iran", "Bosnia-Herzegovina": "Bosnia and Herzegovina",
};

function canonicalTeam(name) {
  if (!name) return name;
  return ALIASES[name] || name;
}

function flagFor(team) {
  const t = canonicalTeam(team);
  return FLAGS[t] || "🏳️"; // TBD / unknown -> neutral flag
}

function allTeams() {
  const set = new Set();
  for (const info of Object.values(GROUPS)) info.teams.forEach((t) => set.add(t));
  return [...set].sort();
}

module.exports = { GROUPS, buildAllMatches, allTeams, flagFor, canonicalTeam };
