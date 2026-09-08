import fs from "node:fs";
import path from "node:path";
import {
  buildAdvancedFeatures,
  normalizeMatchupStatus,
  normalizeRosterEntry,
  rosterSlots,
} from "./advanced-data.mjs";

const leagueId = Number(process.env.ESPN_LEAGUE_ID || 791101930);
const season = Number(process.env.ESPN_SEASON || 2026);
const outputPath = path.resolve(
  process.env.ESPN_OUTPUT || `public/data/espn-${season}.json`,
);
let previous = null;
try { previous = JSON.parse(fs.readFileSync(outputPath, "utf8")); } catch {}
const allowPrivate = Boolean(process.env.ESPN_S2 && process.env.ESPN_SWID);
if (Boolean(process.env.ESPN_S2) !== Boolean(process.env.ESPN_SWID))
  throw new Error("Private ESPN access requires both ESPN_S2 and ESPN_SWID secrets.");

const aliases = {
  1: { manager: "Michael", ownerId: "owner:michael" },
  2: { manager: "Jake", ownerId: "owner:jake" },
  3: { manager: "Rich", ownerId: "owner:rich" },
  4: { manager: "Nick", ownerId: "owner:nick" },
  5: { manager: "Mob", ownerId: "owner:mob" },
  6: { manager: "Chris", ownerId: "owner:chris" },
  7: { manager: "Nyle", ownerId: "owner:nyle" },
  8: { manager: "Min", ownerId: "owner:min" },
  9: { manager: "Gilguy", ownerId: "owner:gilguy" },
  10: { manager: "Blake", ownerId: "owner:blake" },
};

const round = (value) => Math.round((Number(value) || 0) * 100) / 100;
const ownerId = (label) => `owner:${String(label).trim().toLowerCase()}`;
const teamName = (team) =>
  team.name || [team.location, team.nickname].filter(Boolean).join(" ") || `Team ${team.id}`;

const params = new URLSearchParams();
for (const view of ["mSettings", "mTeam", "mRoster", "mMatchupScore", "mScoreboard", "mStatus", "mDraftDetail"])
  params.append("view", view);
const endpoint =
  `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}` +
  `/segments/0/leagues/${leagueId}?${params}`;

const headers = {
  Accept: "application/json",
  "User-Agent": "Fish-Tank-League-Dashboard/1.0",
};
if (allowPrivate) {
  headers.Cookie = `espn_s2=${process.env.ESPN_S2}; SWID=${process.env.ESPN_SWID}`;
}

const response = await fetch(endpoint, { headers, signal: AbortSignal.timeout(30000) });
if (!response.ok) {
  await response.text();
  if (response.status === 401) {
    if (allowPrivate)
      throw new Error("ESPN login expired or was rejected. Refresh both GitHub ESPN secrets; saved data is unchanged.");
    console.log(
      "ESPN sync skipped: league is not publicly viewable. The existing dashboard data was left unchanged.",
    );
    process.exit(0);
  }
  throw new Error(`ESPN returned HTTP ${response.status}; saved data is unchanged.`);
}

const raw = await response.json();
if (Number(raw.id) !== leagueId || Number(raw.seasonId) !== season)
  throw new Error("ESPN response did not match the configured league and season.");
if (!Array.isArray(raw.teams) || raw.teams.length !== 10)
  throw new Error(`Expected 10 ESPN teams; received ${raw.teams?.length ?? 0}.`);
if (!Array.isArray(raw.schedule)) throw new Error("ESPN response is missing its schedule.");

const members = new Map((raw.members || []).map((member) => [member.id, member]));
const normalizedTeams = raw.teams.map((team) => {
  const member = members.get(team.owners?.[0]);
  const fallbackManager =
    member?.firstName ||
    member?.displayName ||
    [member?.firstName, member?.lastName].filter(Boolean).join(" ") ||
    `Manager ${team.id}`;
  const alias = aliases[team.id] || {
    manager: fallbackManager,
    ownerId: ownerId(fallbackManager),
  };
  const overall = team.record?.overall || {};
  return {
    teamId: Number(team.id),
    team: teamName(team),
    manager: alias.manager,
    ownerId: alias.ownerId,
    wins: Number(overall.wins || 0),
    losses: Number(overall.losses || 0),
    ties: Number(overall.ties || 0),
    pf: round(overall.pointsFor),
    pa: round(overall.pointsAgainst),
    espnRank: Number(team.playoffSeed || team.rankCalculatedFinal || 0),
  };
});

const standings = normalizedTeams
  .slice()
  .sort(
    (a, b) =>
      (a.espnRank || 999) - (b.espnRank || 999) ||
      b.wins - a.wins ||
      b.pf - a.pf ||
      a.team.localeCompare(b.team),
  )
  .map((team, index) => ({
    rank: team.espnRank || index + 1,
    team: team.team,
    manager: team.manager,
    ownerId: team.ownerId,
    record: `${team.wins}-${team.losses}-${team.ties}`,
    pf: team.pf,
    pa: team.pa,
  }));

const teamById = new Map(normalizedTeams.map((team) => [team.teamId, team]));
const positionNames = {
  1: "QB",
  2: "RB",
  3: "WR",
  4: "TE",
  5: "K",
  16: "D/ST",
};
const draftPicks = raw.draftDetail?.picks || [];
let playerById = new Map();
let playerPayloadAvailable = false;
const rosterPlayerById = new Map();
for (const team of raw.teams || []) for (const entry of team?.roster?.entries || []) {
  const rosterPlayer = (entry.playerPoolEntry || entry).player || entry.player || {};
  const rosterPlayerId = Number(entry.playerId ?? rosterPlayer.id);
  const rosterName = rosterPlayer.fullName || [rosterPlayer.firstName, rosterPlayer.lastName].filter(Boolean).join(" ");
  if (rosterPlayerId > 0 && rosterName) rosterPlayerById.set(rosterPlayerId, rosterName);
}
if (draftPicks.length) {
  const draftPlayerIds = [...new Set(draftPicks.map((pick) => Number(pick.playerId)).filter((id) => id > 0))];
  const playercardUrl = `https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?view=kona_playercard`;
  for (let offset = 0; offset < draftPlayerIds.length; offset += 50) try {
    const batch = draftPlayerIds.slice(offset, offset + 50);
    const playerHeaders = { ...headers, "X-Fantasy-Filter": JSON.stringify({ players: { filterIds: { value: batch } } }) };
    const playersResponse = await fetch(playercardUrl, { headers: playerHeaders, signal: AbortSignal.timeout(30000) });
    if (!playersResponse.ok) continue;
    const playersPayload = await playersResponse.json();
    const playerEntries = Array.isArray(playersPayload) ? playersPayload : (playersPayload.players || playersPayload.playerCards || []);
    for (const entry of playerEntries) {
      const player = entry.player || entry.playerPoolEntry?.player || entry;
      const id = Number(entry.id ?? entry.playerId ?? player.id);
      if (id > 0) playerById.set(id, player);
    }
    playerPayloadAvailable = playerEntries.length > 0;
  } catch { /* raw roster names and verified recap names remain usable */ }
}
// The first 50 names are a verified ESPN Draft Recap snapshot.  Prefer those
// names over a stale/mismatched player-pool response, while still allowing the
// authenticated player endpoint to resolve picks 51–150.
const fallbackDraftPath = path.join(path.dirname(outputPath), `draft-${season}.json`);
let verifiedDraftByPick = new Map();
try {
  const fallbackDraft = JSON.parse(fs.readFileSync(fallbackDraftPath, "utf8"));
  verifiedDraftByPick = new Map(fallbackDraft.map((pick) => [`${pick.round}:${pick.pick}`, pick]));
} catch {}
const drafts = draftPicks
  .map((pick) => {
    const team = teamById.get(Number(pick.teamId));
    if (!team) return null;
    const fallback = verifiedDraftByPick.get(`${Number(pick.roundId || 0)}:${Number(pick.overallPickNumber || pick.id || 0)}`);
    const player = playerById.get(Number(pick.playerId)) || pick.player || {};
    const playerName = fallback?.player ||
      player.fullName ||
      [player.firstName, player.lastName].filter(Boolean).join(" ") ||
      rosterPlayerById.get(Number(pick.playerId)) ||
      `Player #${pick.playerId}`;
    const position = fallback?.position ||
      positionNames[player.defaultPositionId] ||
      positionNames[player.positionId] ||
      player.position ||
      "Player";
    return {
      season,
      round: Number(pick.roundId || 0),
      pick: Number(pick.overallPickNumber || pick.id || 0),
      player: playerName,
      position,
      team: team.team,
      manager: team.manager,
      keeper: Boolean(pick.keeper),
      playerId: Number(pick.playerId || 0),
      seasonPoints: null,
      nameSource: fallback?.player ? "verified-draft-recap" : playerPayloadAvailable ? "espn-player-endpoint" : "espn-pick-or-id",
    };
  })
  .filter(Boolean)
  .sort((a, b) => a.pick - b.pick);
const currentWeek = Number(raw.status?.currentMatchupPeriod || raw.scoringPeriodId || 1);

// mMatchupScore roster payloads are authoritative for legal lineup regret. A
// bounded 1–18 period sweep preserves historical rosters despite transactions.
const rosterRows = [];
const rosterRowKeys = new Set();
const rosterEntries = (team) => team?.roster?.entries || team?.rosterForCurrentScoringPeriod?.entries || team?.rosterForMatchupPeriod?.entries || [];
for (const team of raw.teams) {
  const entries = rosterEntries(team);
  const key = `${Number(team.id)}:${currentWeek}`;
  if (entries.length && !rosterRowKeys.has(key)) { rosterRowKeys.add(key); rosterRows.push({ teamId: Number(team.id), week: currentWeek, players: entries.map((entry) => normalizeRosterEntry(entry, currentWeek)), slots: rosterSlots(raw), source: "ESPN mRoster" }); }
}
if (allowPrivate) {
  // Roster transactions make a current roster invalid for historical regret;
  // fetch each completed period's frozen matchup roster instead.
  let frozenRosterCount = 0;
  for (let week = 1; week <= Math.min(currentWeek, 18); week++) try {
    const periodHeaders = { ...headers, "X-Fantasy-Filter": JSON.stringify({ schedule: { filterMatchupPeriodIds: { value: [week] } } }) };
    const periodResponse = await fetch(`${endpoint}&scoringPeriodId=${week}`, { headers: periodHeaders, signal: AbortSignal.timeout(30000) });
    if (!periodResponse.ok) continue;
    const period = await periodResponse.json();
    for (const team of period.teams || []) {
      const entries = team?.roster?.entries || team?.rosterForMatchupPeriod?.entries || [];
      const key = `${Number(team.id)}:${week}`;
      if (!entries.length || !team?.id || rosterRowKeys.has(key)) continue;
      rosterRowKeys.add(key); frozenRosterCount++;
      rosterRows.push({ teamId: Number(team.id), week, players: entries.map((entry) => normalizeRosterEntry(entry, week)), slots: rosterSlots(period), source: "ESPN mRoster scoringPeriodId" });
    }
    for (const matchup of period.schedule || []) {
      if (Number(matchup.matchupPeriodId) !== week) continue;
      for (const side of [matchup.home, matchup.away]) {
      const entries = side?.rosterForMatchupPeriod?.entries || side?.rosterForMatchupPeriodDelayed?.entries || side?.rosterForCurrentScoringPeriod?.entries || [];
      const key = `${Number(side?.teamId)}:${week}`;
      if (!entries.length || !side?.teamId || rosterRowKeys.has(key)) continue;
      rosterRowKeys.add(key);
      rosterRows.push({ teamId: Number(side.teamId), week, players: entries.map((entry) => normalizeRosterEntry(entry, week)), slots: rosterSlots(period), source: "ESPN mMatchupScore" }); frozenRosterCount++;
      }
    }
  } catch { /* preserve the rows already captured and mark absent periods unavailable */ }
  console.log(`ESPN frozen roster capture: ${frozenRosterCount} team-period rows; player scores are league-applied totals only.`);
}
const games = raw.schedule
  .filter(
    (matchup) =>
      matchup.matchupPeriodId >= 1 &&
      matchup.matchupPeriodId <= currentWeek &&
      matchup.home?.teamId &&
      matchup.away?.teamId,
  )
  .map((matchup) => {
    const home = teamById.get(Number(matchup.home.teamId));
    const away = teamById.get(Number(matchup.away.teamId));
    if (!home || !away) return null;
    const week = Number(matchup.matchupPeriodId);
    return {
      season,
      week,
      a: home.ownerId,
      al: home.manager,
      at: home.team,
      as: round(matchup.home.totalPoints),
      b: away.ownerId,
      bl: away.manager,
      bt: away.team,
      bs: round(matchup.away.totalPoints),
      status: normalizeMatchupStatus(matchup, currentWeek),
      aTeamId: home.teamId,
      bTeamId: away.teamId,
    };
  })
  .filter(Boolean)
  .sort((a, b) => a.week - b.week || a.at.localeCompare(b.at));

// Keep a visible unavailable row for every finalized period/team whose frozen
// roster was not returned.  Missing data must not look like a zero-point week.
const completedWeeks = [...new Set(games.filter((game) => game.status === "FINAL").map((game) => game.week))].sort((a, b) => a - b);
const missingRosterWeeks = completedWeeks.filter((week) => normalizedTeams.some((team) => !rosterRows.some((row) => row.teamId === team.teamId && row.week === week)));
for (const week of missingRosterWeeks) for (const team of normalizedTeams) {
  if (rosterRows.some((row) => row.teamId === team.teamId && row.week === week)) continue;
  rosterRows.push({ teamId: team.teamId, week, players: [], slots: rosterSlots(raw), source: "UNAVAILABLE ESPN mMatchupScore", unavailableReason: "Frozen matchup roster was not returned" });
}
if (Array.isArray(previous?.advanced?.rosters)) {
  const merged = new Map(rosterRows.map((row) => [`${row.teamId}:${row.week}`, row]));
  const previousFinalWeeks = new Set((previous.games || []).filter((game) => game.status === "FINAL").map((game) => Number(game.week)));
  for (const row of previous.advanced.rosters.filter((row) => previousFinalWeeks.has(Number(row.week)))) {
    const key = `${row.teamId}:${row.week}`;
    if (row.players?.length && (!merged.has(key) || !merged.get(key).players?.length)) merged.set(key, row);
  }
  rosterRows.splice(0, rosterRows.length, ...merged.values());
}
const finalizedRosters = rosterRows.filter((row) => completedWeeks.includes(Number(row.week)));

// Draft performance is derived only from observed league matchup scores. The
// global player directory may use a different scoring system, so it is never
// used as a report-card result.
const observedPlayerTotals = new Map();
const observedPlayerWeeks = new Set();
for (const row of finalizedRosters) for (const player of row.players) if (player.points !== null && player.playerId > 0) {
  const key = `${row.week}:${player.playerId}`;
  if (observedPlayerWeeks.has(key)) continue;
  observedPlayerWeeks.add(key);
  observedPlayerTotals.set(player.playerId, round((observedPlayerTotals.get(player.playerId) || 0) + player.points));
}
const scoredDrafts = drafts.map((pick) => ({
  ...pick,
  seasonPoints: observedPlayerTotals.get(pick.playerId) ?? null,
  seasonPointsSource: observedPlayerTotals.has(pick.playerId) ? "ESPN mMatchupScore" : null,
}));

if (new Set(standings.map((team) => team.team)).size !== 10)
  throw new Error("ESPN sync produced duplicate team names.");
if (new Set(games.map((game) => `${game.week}:${[game.a, game.b].sort().join(":")}`)).size !== games.length)
  throw new Error("ESPN sync produced duplicate matchups.");

let archivedDrafts = [];
try {
  const archive = JSON.parse(fs.readFileSync(path.join(path.dirname(outputPath), "league.json"), "utf8"));
  archivedDrafts = (archive.drafts || []).filter((pick) => Number(pick.season) !== season);
} catch {}
const reportDrafts = [...archivedDrafts, ...scoredDrafts];

const content = {
  leagueId,
  season,
  leagueName: raw.settings?.name || "The Fish Tank",
  available: true,
  source: "ESPN Fantasy Football",
  currentWeek,
  isActive: Boolean(raw.status?.isActive),
  draftCompleteDate: raw.draftDetail?.completeDate || null,
  drafts,
  standings,
  games,
  dataAvailability: {
    matchupStatus: games.some((game) => game.status === "FINAL") ? "FINAL_DATA_PRESENT" : "NO_COMPLETED_MATCHUPS",
    rosterScoring: finalizedRosters.some((row) => row.players.some((player) => player.points !== null)) ? "AVAILABLE" : "UNAVAILABLE",
    rosterPeriods: { requested: completedWeeks, captured: completedWeeks.filter((week) => !missingRosterWeeks.includes(week)), missing: missingRosterWeeks },
    playerDirectory: playerPayloadAvailable ? "AVAILABLE" : "UNAVAILABLE",
  },
  advanced: { ...buildAdvancedFeatures({ matchups: games.map((game) => ({ ...game, homeId: game.aTeamId, awayId: game.bTeamId, homeScore: game.as, awayScore: game.bs })), teams: normalizedTeams, rosters: finalizedRosters, drafts: reportDrafts, currentWeek }), rosters: finalizedRosters },
};

if (Array.isArray(previous?.advanced?.lineupRegret)) {
  const preserved = new Map(content.advanced.lineupRegret.map((row) => [`${row.teamId}:${row.week}`, row]));
  const previousFinalWeeks = new Set((previous.games || []).filter((game) => game.status === "FINAL").map((game) => Number(game.week)));
  for (const row of previous.advanced.lineupRegret.filter((row) => previousFinalWeeks.has(Number(row.week)))) {
    const key = `${row.teamId}:${row.week}`;
    if (row.available && (!preserved.has(key) || !preserved.get(key).available)) preserved.set(key, row);
  }
  content.advanced.lineupRegret = [...preserved.values()];
}
const previousComparable = previous && { ...previous, updatedAt: undefined };
if (JSON.stringify(previousComparable) === JSON.stringify({ ...content, updatedAt: undefined })) {
  console.log("ESPN sync complete: no league changes.");
  process.exit(0);
}

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(
  outputPath,
  `${JSON.stringify({ ...content, updatedAt: new Date().toISOString() }, null, 2)}\n`,
);
console.log(
  `ESPN sync wrote ${standings.length} teams and ${games.length} matchups through Week ${currentWeek}.`,
);
