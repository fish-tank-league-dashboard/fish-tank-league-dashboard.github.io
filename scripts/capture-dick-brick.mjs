// Dick Brick of the Week capture.
//   capture  - on Monday, within 30 minutes of the first MNF kickoff, record ESPN live projected totals.
//   finalize - once ESPN marks the week final, turn a captured snapshot into a verified award.
//   verify   - confirm ESPN access and that live projections are present.
//   auto     - capture, then check for a missed capture, then finalize.
// Nothing here estimates or back-fills a probability. Missing data is an error, not a guess.
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ledgerPath = resolve(root, 'data/dick-bricks.json');
const snapshotsPath = resolve(root, 'data/dick-brick-snapshots.json');
const leaguePath = resolve(root, 'data/espn-2026.json');
const leagueId = process.env.ESPN_LEAGUE_ID || '791101930';
const season = Number(process.env.ESPN_SEASON || 2026);
const CAPTURE_WINDOW_MINUTES = 30;
const nyFormatter = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: '2-digit', day: '2-digit' });

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT' && fallback !== undefined) return fallback; throw error; }
}
async function writeJson(path, value) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, `${JSON.stringify(value, null, 2)}\n`); }
const nyParts = date => Object.fromEntries(nyFormatter.formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));

async function fetchJson(url, authenticated = false) {
  const headers = { Accept: 'application/json, text/plain, */*' };
  if (authenticated) {
    headers.Referer = 'https://fantasy.espn.com/';
    headers['User-Agent'] = 'Mozilla/5.0 (compatible; FishTankLeagueHub/1.0)';
    headers.Cookie = `espn_s2=${process.env.ESPN_S2}; SWID=${process.env.ESPN_SWID}`;
  }
  const response = await fetch(url, { headers });
  const body = await response.text();
  const host = new URL(url).hostname;
  if (!response.ok) throw new Error(`${response.status} from ${host}`);
  if (!body.trim()) throw new Error(`${host} returned an empty response. Refresh the ESPN_S2 and ESPN_SWID repository secrets.`);
  try { return JSON.parse(body); }
  catch { throw new Error(`${host} returned a non-JSON response. Refresh the ESPN_S2 and ESPN_SWID repository secrets.`); }
}

export function projectedWinProbability(teamProjection, opponentProjection) {
  // A 12-point live projection edge corresponds to roughly a 73% win chance.
  const difference = Number(teamProjection) - Number(opponentProjection);
  return Math.round((100 / (1 + Math.exp(-difference / 12))) * 10) / 10;
}

// Names come from the site's own ESPN feed so the award matches the rest of the hub.
export function teamDirectory(league) {
  const directory = new Map();
  for (const game of league.games || []) {
    if (game.aTeamId != null) directory.set(Number(game.aTeamId), { managerId: game.a, manager: game.al, team: String(game.at).trim() });
    if (game.bTeamId != null) directory.set(Number(game.bTeamId), { managerId: game.b, manager: game.bl, team: String(game.bt).trim() });
  }
  return directory;
}

export function projectedSide(side, opponent, directory) {
  const details = directory.get(Number(side.teamId));
  if (!details || !details.manager || !details.team) throw new Error(`ESPN team ${side.teamId} is not in data/espn-2026.json; run the ESPN sync first.`);
  const projectedPoints = side.totalProjectedPointsLive;
  const opponentProjected = opponent.totalProjectedPointsLive;
  if (!Number.isFinite(projectedPoints) || !Number.isFinite(opponentProjected)) {
    throw new Error(`ESPN did not return live projected totals for team ${side.teamId}; refusing to record a probability.`);
  }
  return { teamId: Number(side.teamId), ...details, projectedPoints, pointsAtCapture: Number(side.totalPointsLive ?? side.totalPoints ?? 0), winProbability: projectedWinProbability(projectedPoints, opponentProjected) };
}

export function awardCandidate(snapshot, finalSchedule) {
  const finalById = new Map(finalSchedule.map(matchup => [matchup.id, matchup]));
  const candidates = [];
  for (const matchup of snapshot.matchups) {
    const final = finalById.get(matchup.id);
    if (!final || !['HOME', 'AWAY'].includes(final.winner)) return null;
    const homeWon = final.winner === 'HOME';
    const loser = homeWon ? matchup.away : matchup.home;
    const winner = homeWon ? matchup.home : matchup.away;
    const loserFinal = homeWon ? final.away : final.home;
    const winnerFinal = homeWon ? final.home : final.away;
    candidates.push({ ...loser, opponent: winner.team, opponentManager: winner.manager, finalScore: `${Number(loserFinal.totalPoints).toFixed(2)}–${Number(winnerFinal.totalPoints).toFixed(2)}` });
  }
  if (!candidates.length) return null;
  return candidates.sort((a, b) => b.winProbability - a.winProbability || b.projectedPoints - a.projectedPoints || a.manager.localeCompare(b.manager))[0];
}

async function firstMondayKickoff(now) {
  const date = nyParts(now);
  if (date.weekday !== 'Monday') return null;
  const games = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${date.year}${date.month}${date.day}&limit=1000`);
  return (games.events || []).map(event => new Date(event.date)).filter(value => Number.isFinite(value.valueOf())).sort((a, b) => a - b)[0] || null;
}

async function leagueScoreboard() {
  const query = new URLSearchParams();
  for (const view of ['mMatchupScore', 'mScoreboard', 'mStatus']) query.append('view', view);
  const payload = await fetchJson(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?${query}`, true);
  const week = Number(payload.status?.currentMatchupPeriod || payload.scoringPeriodId);
  if (!Number.isInteger(week) || week < 1) throw new Error('ESPN did not return a current matchup period');
  return { week, payload };
}
const weekSchedule = (payload, week) => (payload.schedule || []).filter(matchup => matchup.matchupPeriodId === week && matchup.home && matchup.away);

async function capture(now) {
  const kickoff = await firstMondayKickoff(now);
  if (!kickoff) return 'No Monday Night Football kickoff today.';
  const minutes = (kickoff - now) / 60000;
  if (minutes > CAPTURE_WINDOW_MINUTES) return `Capture window not open yet (${minutes.toFixed(1)} minutes to kickoff).`;
  const { week, payload } = await leagueScoreboard();
  const snapshots = await readJson(snapshotsPath, { snapshots: [] });
  if (snapshots.snapshots.some(row => row.season === season && row.week === week)) return `Week ${week} already captured.`;
  if (minutes <= 0) {
    throw new Error(`Missed the Week ${week} capture: first MNF kickoff was ${(-minutes).toFixed(1)} minutes ago and no snapshot exists. Week ${week} must be recorded as a manual award.`);
  }
  const directory = teamDirectory(await readJson(leaguePath));
  const schedule = weekSchedule(payload, week);
  if (!schedule.length) throw new Error(`ESPN returned no Week ${week} matchups`);
  const matchups = schedule.map(matchup => ({
    id: matchup.id,
    home: projectedSide(matchup.home, matchup.away, directory),
    away: projectedSide(matchup.away, matchup.home, directory)
  }));
  snapshots.snapshots.push({ season, week, capturedAt: now.toISOString(), firstMnfKickoff: kickoff.toISOString(), minutesBeforeKickoff: Math.round(minutes * 10) / 10, matchups });
  snapshots.snapshots.sort((a, b) => a.season - b.season || a.week - b.week);
  await writeJson(snapshotsPath, snapshots);
  return `Captured Week ${week} ${minutes.toFixed(1)} minutes before kickoff.`;
}

async function finalize() {
  const snapshots = await readJson(snapshotsPath, { snapshots: [] });
  const open = snapshots.snapshots.filter(row => row.season === season && !row.finalizedAt);
  if (!open.length) return 'No captured weeks awaiting final scores.';
  const { payload } = await leagueScoreboard();
  const ledger = await readJson(ledgerPath);
  const messages = [];
  let changed = false;
  for (const snapshot of open) {
    const award = awardCandidate(snapshot, weekSchedule(payload, snapshot.week));
    if (!award) { messages.push(`Week ${snapshot.week} is not final yet.`); continue; }
    if (!ledger.awards.some(row => row.season === snapshot.season && row.week === snapshot.week)) {
      ledger.awards.push({ season: snapshot.season, week: snapshot.week, status: 'verified', managerId: award.managerId, manager: award.manager, team: award.team, opponent: award.opponent, opponentManager: award.opponentManager, winProbability: award.winProbability, projectedPoints: award.projectedPoints, finalScore: award.finalScore, capturedAt: snapshot.capturedAt });
    }
    snapshot.finalizedAt = new Date().toISOString();
    snapshot.awardManager = award.manager;
    changed = true;
    messages.push(`Week ${snapshot.week} brick: ${award.manager} (${award.winProbability}%).`);
  }
  if (changed) {
    ledger.awards.sort((a, b) => b.season - a.season || b.week - a.week);
    await writeJson(ledgerPath, ledger);
    await writeJson(snapshotsPath, snapshots);
  }
  return messages.join(' ');
}

async function verify() {
  const { week, payload } = await leagueScoreboard();
  const schedule = weekSchedule(payload, week);
  if (!schedule.length) throw new Error(`ESPN returned no Week ${week} matchups`);
  const directory = teamDirectory(await readJson(leaguePath));
  schedule.forEach(matchup => { projectedSide(matchup.home, matchup.away, directory); projectedSide(matchup.away, matchup.home, directory); });
  return `Verified ESPN access for Week ${week}: ${schedule.length} matchups with live projections and resolved team names.`;
}

// Retrospective review for a week that was never captured (Week 1). It rebuilds the pre-MNF
// projected total the same way ESPN's live projection works: points already scored by players
// whose games kicked off before MNF, plus ESPN's stored projection for each starter still to play.
// It is labeled retrospective and never becomes a "verified" award.
export function projectedAtKickoff(side, kickoffByProTeam, kickoff, scoringPeriodId) {
  let scored = 0;
  let projectedRemaining = 0;
  const remaining = [];
  const problems = [];
  for (const entry of side.rosterForCurrentScoringPeriod?.entries || []) {
    if ([20, 21].includes(entry.lineupSlotId)) continue; // bench, IR
    const player = entry.playerPoolEntry?.player || {};
    const name = player.fullName || `Player ${player.id}`;
    const playerKickoff = kickoffByProTeam.get(String(player.proTeamId));
    if (!playerKickoff) { problems.push(`${name}: no NFL kickoff found`); continue; }
    if (playerKickoff < kickoff) { scored += Number(entry.playerPoolEntry?.appliedStatTotal ?? 0); continue; }
    const projection = (player.stats || []).find(stat => stat.statSourceId === 1 && stat.statSplitTypeId === 1 && stat.scoringPeriodId === scoringPeriodId);
    if (!projection || !Number.isFinite(projection.appliedTotal)) { problems.push(`${name}: ESPN has no stored projection`); continue; }
    projectedRemaining += projection.appliedTotal;
    remaining.push({ name, projected: Math.round(projection.appliedTotal * 100) / 100, actual: Math.round(Number(entry.playerPoolEntry?.appliedStatTotal ?? 0) * 100) / 100 });
  }
  return { scoredBeforeMnf: Math.round(scored * 100) / 100, projectedRemaining: Math.round(projectedRemaining * 100) / 100, projectedTotal: Math.round((scored + projectedRemaining) * 100) / 100, remaining, problems };
}

async function review(week) {
  const query = new URLSearchParams({ scoringPeriodId: String(week), matchupPeriodId: String(week) });
  for (const view of ['mMatchupScore', 'mBoxscore']) query.append('view', view);
  const payload = await fetchJson(`https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/${season}/segments/0/leagues/${leagueId}?${query}`, true);
  const schedule = weekSchedule(payload, week);
  if (!schedule.length) throw new Error(`ESPN returned no Week ${week} matchups`);
  const nfl = await fetchJson(`https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=${season}&seasontype=2&week=${week}&limit=1000`);
  const events = (nfl.events || []).map(event => ({ date: new Date(event.date), teams: (event.competitions?.[0]?.competitors || []).map(c => String(c.team?.id)) }));
  const kickoff = events.map(event => event.date).filter(date => nyParts(date).weekday === 'Monday').sort((a, b) => a - b)[0];
  if (!kickoff) throw new Error(`No Monday Night Football kickoff found for Week ${week}`);
  const kickoffByProTeam = new Map(events.flatMap(event => event.teams.map(id => [id, event.date])));
  const directory = teamDirectory(await readJson(leaguePath));
  const problems = [];
  const matchups = schedule.map(matchup => {
    const sides = ['home', 'away'].map(key => {
      const details = directory.get(Number(matchup[key].teamId));
      if (!details) throw new Error(`ESPN team ${matchup[key].teamId} is not in data/espn-2026.json`);
      const result = projectedAtKickoff(matchup[key], kickoffByProTeam, kickoff, week);
      problems.push(...result.problems.map(problem => `${details.manager}: ${problem}`));
      return { ...details, ...result, finalScore: Number(matchup[key].totalPoints ?? 0) };
    });
    const [home, away] = sides;
    home.winProbability = projectedWinProbability(home.projectedTotal, away.projectedTotal);
    away.winProbability = projectedWinProbability(away.projectedTotal, home.projectedTotal);
    const winner = home.finalScore > away.finalScore ? home : away;
    const loser = winner === home ? away : home;
    delete home.problems; delete away.problems;
    return { home, away, loser: loser.manager, loserWinProbability: loser.winProbability };
  });
  if (problems.length) throw new Error(`Week ${week} review cannot be verified:\n${problems.join('\n')}`);
  const losers = [...matchups].sort((a, b) => b.loserWinProbability - a.loserWinProbability);
  const report = {
    season, week, status: 'retrospective', generatedAt: new Date().toISOString(), firstMnfKickoff: kickoff.toISOString(),
    method: 'Retrospective: points scored by starters whose NFL games kicked off before the first MNF game, plus ESPN\'s stored projection (statSourceId 1) for each starter still to play, run through the standard probability formula. Not a live capture; ESPN\'s stored projection is its last pregame value for each player.',
    brickRecipient: losers[0].loser, brickWinProbability: losers[0].loserWinProbability, matchups
  };
  await writeJson(resolve(root, `data/dick-brick-review-week${week}.json`), report);
  return `Week ${week} retrospective: ${report.brickRecipient} was the biggest losing favorite at ${report.brickWinProbability}%.`;
}

async function main() {
  const mode = process.argv[2] || 'auto';
  if (!['auto', 'capture', 'finalize', 'verify', 'review'].includes(mode)) throw new Error(`Unknown mode: ${mode}`);
  if (!process.env.ESPN_S2 || !process.env.ESPN_SWID) throw new Error('ESPN_S2 and ESPN_SWID secrets are required; nothing was captured.');
  if (mode === 'verify') return console.log(await verify());
  if (mode === 'review') return console.log(await review(Number(process.argv[3] || 1)));
  if (mode === 'auto' || mode === 'capture') console.log(await capture(new Date()));
  if (mode === 'auto' || mode === 'finalize') console.log(await finalize());
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message || error); process.exitCode = 1; });
}
