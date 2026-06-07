// Smoke test for the API. Run: node test.js  (server must be running on PORT).
const B = `http://localhost:${process.env.PORT || 3000}`;
const j = async (p, m = "GET", body) =>
  (await fetch(B + p, { method: m, headers: { "Content-Type": "application/json" }, body: body && JSON.stringify(body) })).json();
let pass = 0, fail = 0;
const ok = (cond, msg) => { (cond ? pass++ : fail++); console.log(`${cond ? "PASS" : "FAIL"}  ${msg}`); };

(async () => {
  const cara = (await j("/api/join", "POST", { name: "Cara" })).person;
  const dan = (await j("/api/join", "POST", { name: "Dan" })).person;
  ok(cara && dan, "two players joined");

  const dup = await j("/api/join", "POST", { name: "CARA" });
  ok(dup.error && /taken/i.test(dup.error), "duplicate name (case-insensitive) rejected");

  await j("/api/predict", "POST", { personId: cara.id, matchId: 1, pick: "a_win" });
  const changed = await j("/api/predict", "POST", { personId: cara.id, matchId: 1, pick: "draw" });
  ok(changed.pick === "draw", "pick can be changed before kickoff");

  const bad = await j("/api/predict", "POST", { personId: cara.id, matchId: 1, pick: "foo" });
  ok(bad.error, "invalid pick rejected");

  await j("/api/predict", "POST", { personId: dan.id, matchId: 1, pick: "b_win" });
  await j("/api/champion", "POST", { personId: cara.id, team: "Brazil" });
  await j("/api/champion", "POST", { personId: dan.id, team: "Spain" });

  const badAdmin = await j("/api/admin/result?key=nope", "POST", { matchId: 1, result: "a_win" });
  ok(badAdmin.error, "bad admin key rejected");

  // m1 -> a_win: Cara picked draw (wrong), Dan picked b_win (wrong)
  await j("/api/admin/result?key=worldcup-admin", "POST", { matchId: 1, result: "a_win" });
  // Cara picks m2 a_win, result a_win -> +1
  await j("/api/predict", "POST", { personId: cara.id, matchId: 2, pick: "a_win" });
  await j("/api/admin/result?key=worldcup-admin", "POST", { matchId: 2, result: "a_win" });

  let lb = (await j("/api/leaderboard")).leaderboard;
  const caraRow = lb.find((r) => r.name === "Cara");
  const danRow = lb.find((r) => r.name === "Dan");
  ok(caraRow.points === 1 && caraRow.correct === 1, `Cara has 1 correct match = 1pt (got ${caraRow.points})`);
  ok(danRow.points === 0, `Dan has 0pts (got ${danRow.points})`);

  // champion winner Brazil -> Cara +10
  await j("/api/admin/config?key=worldcup-admin", "POST", { championWinner: "Brazil" });
  lb = (await j("/api/leaderboard")).leaderboard;
  const cara2 = lb.find((r) => r.name === "Cara");
  ok(cara2.points === 11 && cara2.championCorrect, `Cara 1 + 10 champ = 11 (got ${cara2.points})`);
  ok(cara2.rank === 1, "Cara ranks #1");

  // champion locked after winner recorded
  const lockedTry = await j("/api/champion", "POST", { personId: dan.id, team: "France" });
  ok(lockedTry.error, "champion pick locked after winner recorded");

  // knockout double: turn on, set a knockout match result and verify 2 pts
  await j("/api/admin/config?key=worldcup-admin", "POST", { knockoutDouble: true });
  const all = (await j("/api/admin/matches?key=worldcup-admin")).matches;
  const ko = all.find((m) => m.stage === "knockout");
  await j("/api/admin/match?key=worldcup-admin", "POST", { id: ko.id, team_a: "Brazil", team_b: "France", kickoff_time: "2026-06-28T18:00:00-04:00" });
  await j("/api/predict", "POST", { personId: dan.id, matchId: ko.id, pick: "a_win" });
  await j("/api/admin/result?key=worldcup-admin", "POST", { matchId: ko.id, result: "a_win" });
  lb = (await j("/api/leaderboard")).leaderboard;
  ok(lb.find((r) => r.name === "Dan").points === 2, `knockout double = 2pts for Dan (got ${lb.find(r=>r.name==="Dan").points})`);

  // current matches today+tomorrow should be empty (tournament starts Jun 11)
  const cur = (await j(`/api/matches?personId=${cara.id}`)).matches;
  ok(cur.length === 0, `no current matches today/tomorrow (got ${cur.length})`);

  // static index
  const idx = await fetch(B + "/").then((r) => r.status);
  ok(idx === 200, "static index served");

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
