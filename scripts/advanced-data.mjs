// Pure ESPN-derived feature calculations.  This file deliberately contains no
// network or model calls so the recurring sync remains deterministic.

export const FEATURE_VERSION = 1;

const round = (value) => Math.round((Number(value) || 0) * 100) / 100;
const asArray = (value) => Array.isArray(value) ? value : [];
const number = (value) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

export function isFinalMatchup(matchup = {}) {
  const status = matchup.status || {};
  const type = typeof status === "string" ? status : (status.type || status);
  const id = String(type.id || status.id || matchup.statusId || (typeof status === "string" ? status : "")).toUpperCase();
  const label = String(type.name || type.abbreviation || status.displayName || (typeof status === "string" ? status : "")).toUpperCase();
  if (status.isFinal === true || type.isFinal === true || matchup.isFinal === true) return true;
  if (/FINAL|COMPLETE|COMPLETED/.test(`${id} ${label}`) && !/POSTPONED|CANCEL/.test(`${id} ${label}`)) return true;
  // ESPN uses a zero score while an in-progress/preseason matchup is still
  // undecided.  A nonzero result may be treated as final only when the feed
  // explicitly says the scoring period has closed.
  return false;
}

export function normalizeMatchupStatus(matchup = {}, currentWeek = 1) {
  if (isFinalMatchup(matchup)) return "FINAL";
  const week = Number(matchup.matchupPeriodId || matchup.week || 0);
  if (week > 0 && week < Number(currentWeek || 1) &&
      number(matchup.home?.totalPoints) !== null && number(matchup.away?.totalPoints) !== null &&
      (Number(matchup.home.totalPoints) !== 0 || Number(matchup.away.totalPoints) !== 0)) return "FINAL";
  if (matchup.home?.totalPoints != null || matchup.away?.totalPoints != null) return "LIVE";
  return "SCHEDULED";
}

const normalizePosition = (value) => {
  const names = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
  const raw = String(value ?? "").toUpperCase();
  return names[value] || (raw.includes("DEF") ? "D/ST" : raw.includes("DST") ? "D/ST" : raw);
};

export function playerPoints(player = {}, scoringPeriodId) {
  const directScore = player.appliedStatTotal ?? player.playerPoolEntry?.appliedStatTotal;
  if (directScore !== null && directScore !== undefined && directScore !== "") return number(directScore);
  const stats = asArray(player.stats || player.player?.stats || player.playerPoolEntry?.player?.stats);
  const period = Number(scoringPeriodId);
  if (!Number.isFinite(period) || period <= 0) return null;
  const candidates = stats.filter((stat) => Number(stat.scoringPeriodId) === period);
  const stat = candidates.find((entry) => Number(entry.statSourceId) === 0 && Number(entry.statSplitTypeId) === 1);
  return number(stat?.appliedTotal ?? stat?.appliedStats?.total ?? stat?.points) ?? null;
}

export function normalizeRosterEntry(entry = {}, scoringPeriodId) {
  const pool = entry.playerPoolEntry || entry;
  const player = pool.player || entry.player || {};
  const id = Number(entry.playerId ?? pool.playerId ?? player.id);
  const name = player.fullName || [player.firstName, player.lastName].filter(Boolean).join(" ") || `Player #${id}`;
  const eligibleIds = asArray(player.eligibleSlots || pool.eligibleSlots || entry.eligibleSlots).map(Number).filter(Number.isFinite);
  const position = normalizePosition(player.defaultPositionId ?? player.positionId ?? player.position);
  const status = Number(entry.lineupSlotId) === 20 ? "BENCH" : Number(entry.lineupSlotId) === 21 ? "IR" : "STARTER";
  return {
    playerId: id,
    player: name,
    position,
    eligibleSlots: eligibleIds,
    lineupSlotId: Number(entry.lineupSlotId ?? -1),
    status,
    points: playerPoints(entry, scoringPeriodId) ?? playerPoints(player, scoringPeriodId),
  };
}

const eligibleForSlot = (player, slot) => {
  if (player.status === "IR") return false;
  const slotId = Number(slot);
  const eligible = Array.isArray(player.eligibleSlots) ? player.eligibleSlots.map(Number) : [];
  if (eligible.length) {
    if (eligible.includes(slotId)) return true;
    return false;
  }
  return false;
};

export function rosterSlots(raw = {}) {
  const settings = raw.settings?.rosterSettings || raw.rosterSettings || raw;
  const counts = settings.lineupSlotCounts || settings.slotCounts || {};
  const slots = [];
  for (const [slot, count] of Object.entries(counts)) for (let i = 0; i < Number(count || 0); i++) slots.push(Number(slot));
  if (slots.length) return slots.filter((slot) => ![20, 21].includes(slot));
  return [];
}

export function optimizeLineup(players = [], slots = []) {
  if (players.some((player) => player.status !== "IR" && player.points === null)) return { points: 0, assignments: [], valid: false };
  const usable = players.filter((player) => Number.isFinite(Number(player.points)) && player.points !== null);
  let best = { points: 0, assignments: [], valid: false };
  if (!slots.length) return best;
  const orderedSlots = [...slots].sort((a, b) => Number([3, 5, 23, 24].includes(Number(a))) - Number([3, 5, 23, 24].includes(Number(b))));
  const visit = (index, used, assignments, points) => {
    if (index === orderedSlots.length) {
      if (assignments.length === orderedSlots.length && (!best.valid || points > best.points)) best = { points: round(points), assignments: assignments.slice(), valid: true };
      return;
    }
    const slot = orderedSlots[index];
    for (let p = 0; p < usable.length; p++) {
      if (used.has(p) || !eligibleForSlot(usable[p], slot)) continue;
      used.add(p); assignments.push({ slot, playerId: usable[p].playerId, player: usable[p].player, points: usable[p].points });
      visit(index + 1, used, assignments, points + Number(usable[p].points));
      assignments.pop(); used.delete(p);
    }
    // Allow an unfilled position.  This is important for incomplete/preseason
    // rosters and prevents an unavailable score from becoming artificial zero.
    visit(index + 1, used, assignments, points);
  };
  visit(0, new Set(), [], 0);
  return best;
}

export function allPlayLuck(matchups = [], teamIds = []) {
  const rows = new Map(teamIds.map((id) => [id, { teamId: id, allPlayWins: 0, allPlayLosses: 0, allPlayTies: 0, weeks: 0 }]));
  for (const matchup of matchups.filter((m) => m.status === "FINAL")) {
    const scores = [{ id: matchup.homeId ?? matchup.a, score: number(matchup.homeScore ?? matchup.as) }, { id: matchup.awayId ?? matchup.b, score: number(matchup.awayScore ?? matchup.bs) }];
    if (scores.some((entry) => !rows.has(entry.id) || entry.score === null)) continue;
    const allScores = [...matchups.filter((m) => m.status === "FINAL" && Number(m.week) === Number(matchup.week)).flatMap((m) => [number(m.homeScore ?? m.as), number(m.awayScore ?? m.bs)])].filter((score) => score !== null);
    for (const item of scores) {
      const row = rows.get(item.id); const better = allScores.filter((score) => score < item.score).length; const worse = allScores.filter((score) => score > item.score).length;
      row.allPlayWins += better; row.allPlayLosses += worse; row.allPlayTies += allScores.length - better - worse - 1; row.weeks++;
    }
  }
  return [...rows.values()].map((row) => ({ ...row, allPlayPct: row.allPlayWins + row.allPlayLosses + row.allPlayTies ? round((row.allPlayWins + row.allPlayTies * 0.5) / (row.allPlayWins + row.allPlayLosses + row.allPlayTies)) : null }));
}

export function buildAdvancedFeatures({ matchups = [], teams = [], rosters = [], drafts = [], currentWeek = 1 } = {}) {
  const completed = matchups.filter((m) => (m.status || normalizeMatchupStatus(m, currentWeek)) === "FINAL");
  const teamIds = teams.map((team) => team.teamId ?? team.ownerId ?? team.id);
  const allPlay = allPlayLuck(completed, teamIds);
  const rivalryMap = new Map();
  for (const matchup of completed) {
    const key = [matchup.homeId ?? matchup.a, matchup.awayId ?? matchup.b].sort().join(":");
    const row = rivalryMap.get(key) || { teamIds: key.split(":"), games: 0, margin: 0, wins: 0, ties: 0 };
    row.games++; row.margin += Math.abs(Number(matchup.homeScore ?? matchup.as ?? 0) - Number(matchup.awayScore ?? matchup.bs ?? 0));
    if (Number(matchup.homeScore ?? matchup.as) === Number(matchup.awayScore ?? matchup.bs)) row.ties++;
    else row.wins += 1;
    rivalryMap.set(key, row);
  }
  const trends = teams.map((team) => {
    const id = team.teamId ?? team.ownerId ?? team.id;
    const scores = completed.flatMap((m) => (m.homeId ?? m.a) === id ? [Number(m.homeScore ?? m.as)] : (m.awayId ?? m.b) === id ? [Number(m.awayScore ?? m.bs)] : []).filter(Number.isFinite);
    const recent = scores.slice(-3); const average = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null; const recentAverage = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
    return { teamId: id, games: scores.length, average: average === null ? null : round(average), recentAverage: recentAverage === null ? null : round(recentAverage), delta: average === null || recentAverage === null ? null : round(recentAverage - average), state: recent.length < 2 ? "UNAVAILABLE" : recentAverage > average + 5 ? "HOT" : recentAverage < average - 5 ? "COLD" : "STEADY" };
  });
  const finalizedWeeks = new Set(completed.map((m) => Number(m.week)));
  const lineupRegret = rosters.filter((row) => finalizedWeeks.has(Number(row.week))).map((row) => { const starters = row.players.filter((p) => p.status === "STARTER"); const actualAvailable = starters.length > 0 && starters.every((p) => number(p.points) !== null); const actual = actualAvailable ? starters.reduce((sum, p) => sum + Number(p.points), 0) : null; const optimal = actualAvailable ? optimizeLineup(row.players, row.slots || []) : { valid: false, points: 0, assignments: [] }; return { teamId: row.teamId, week: row.week, actual: actual === null ? null : round(actual), optimal: optimal.valid ? optimal.points : null, regret: optimal.valid && actual !== null ? round(optimal.points - actual) : null, assignments: optimal.assignments, available: optimal.valid && actualAvailable }; });
  const draftReport = drafts.map((pick) => ({ ...pick, performance: number(pick.seasonPoints ?? pick.points ?? pick.totalPoints), performanceStatus: number(pick.seasonPoints ?? pick.points ?? pick.totalPoints) === null ? "UNAVAILABLE" : "AVAILABLE" }));
  const weeks = [...new Set(completed.map((m) => Number(m.week)).filter(Number.isFinite))].sort((a, b) => a - b);
  const awards = weeks.map((week) => {
    const weekly = completed.filter((m) => Number(m.week) === week);
    const scores = weekly.flatMap((m) => [{ teamId: m.homeId ?? m.a, score: number(m.homeScore ?? m.as) }, { teamId: m.awayId ?? m.b, score: number(m.awayScore ?? m.bs) }]).filter((row) => row.score !== null);
    const largest = weekly.map((m) => ({ teamIds: [m.homeId ?? m.a, m.awayId ?? m.b], margin: round(Math.abs(Number(m.homeScore ?? m.as) - Number(m.awayScore ?? m.bs))) })).sort((a, b) => b.margin - a.margin)[0] || null;
    const playerRows = rosters.filter((row) => Number(row.week) === week).flatMap((row) => row.players.map((player) => ({ ...player, teamId: row.teamId }))).filter((player) => number(player.points) !== null).sort((a, b) => b.points - a.points);
    return { week, highestTeamScore: scores.sort((a, b) => b.score - a.score)[0] || null, largestMargin: largest, topPlayer: playerRows[0] ? { teamId: playerRows[0].teamId, playerId: playerRows[0].playerId, player: playerRows[0].player, points: playerRows[0].points } : null, available: scores.length > 0 };
  });
  return { version: FEATURE_VERSION, available: completed.length > 0, unavailableReason: completed.length ? null : "No completed ESPN matchups yet", awards, allPlayLuck: allPlay, rivalrySpotlight: [...rivalryMap.values()].sort((a, b) => b.games - a.games || b.margin - a.margin), trends, lineupRegret, draftReport };
}
