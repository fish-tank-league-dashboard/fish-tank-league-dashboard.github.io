import fs from "node:fs";
import path from "node:path";

const leagueId = Number(process.env.ESPN_LEAGUE_ID || 791101930);
const season = Number(process.env.ESPN_SEASON || 2026);
const outputPath = path.resolve(
  process.env.ESPN_OUTPUT || `public/data/espn-${season}.json`,
);
const allowPrivate = Boolean(process.env.ESPN_S2 && process.env.ESPN_SWID);

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
for (const view of ["mSettings", "mTeam", "mMatchupScore", "mStatus"])
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

const response = await fetch(endpoint, { headers });
if (!response.ok) {
  const message = await response.text();
  if (response.status === 401) {
    console.log(
      "ESPN sync skipped: league is not publicly viewable. The existing dashboard data was left unchanged.",
    );
    process.exit(0);
  }
  throw new Error(`ESPN returned ${response.status}: ${message.slice(0, 300)}`);
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
const currentWeek = Number(raw.status?.currentMatchupPeriod || raw.scoringPeriodId || 1);
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
      status: week < currentWeek ? "FINAL" : "LIVE",
    };
  })
  .filter(Boolean)
  .sort((a, b) => a.week - b.week || a.at.localeCompare(b.at));

if (new Set(standings.map((team) => team.team)).size !== 10)
  throw new Error("ESPN sync produced duplicate team names.");
if (new Set(games.map((game) => `${game.week}:${[game.a, game.b].sort().join(":")}`)).size !== games.length)
  throw new Error("ESPN sync produced duplicate matchups.");

const content = {
  leagueId,
  season,
  leagueName: raw.settings?.name || "The Fish Tank",
  available: true,
  source: "ESPN Fantasy Football",
  currentWeek,
  isActive: Boolean(raw.status?.isActive),
  standings,
  games,
};

let previous = null;
try {
  previous = JSON.parse(fs.readFileSync(outputPath, "utf8"));
} catch {}
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
