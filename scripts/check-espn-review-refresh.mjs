// Skip a Tuesday/Thursday fallback only after a successful review-morning sync.
// A no-diff sync counts: updatedAt intentionally does not change in that case.
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const eastern = date => Object.fromEntries(new Intl.DateTimeFormat('en-US', {
  timeZone: 'America/New_York', weekday: 'long', year: 'numeric', month: '2-digit',
  day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'
}).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
const dayKey = clock => `${clock.year}-${clock.month}-${clock.day}`;
const minutes = clock => Number(clock.hour) * 60 + Number(clock.minute);

export function validSnapshot(snapshot, leagueId = 791101930, season = 2026) {
  if (!snapshot || Number(snapshot.leagueId) !== leagueId || Number(snapshot.season) !== season || snapshot.available !== true) return false;
  if (!Number.isInteger(snapshot.currentWeek) || !Array.isArray(snapshot.standings) || snapshot.standings.length !== 10 || !Array.isArray(snapshot.games)) return false;
  const games = snapshot.games.filter(game => Number(game.week) === snapshot.currentWeek);
  return games.length === 5 && games.every(game => game.a && game.b && typeof game.status === 'string');
}

export function reviewScoresFinal(snapshot) {
  const currentGames = snapshot.games.filter(game => Number(game.week) === snapshot.currentWeek);
  const reviewWeek = currentGames.some(game => ['LIVE', 'FINAL'].includes(game.status)) ? snapshot.currentWeek : snapshot.currentWeek - 1;
  const games = snapshot.games.filter(game => Number(game.week) === reviewWeek);
  return games.length === 5 && games.every(game => game.status === 'FINAL');
}

export function needsReviewRefresh(runs, snapshot, now = new Date()) {
  const clock = eastern(now);
  if (!['Tuesday', 'Thursday'].includes(clock.weekday) || minutes(clock) < 8 * 60) return true;
  if (!validSnapshot(snapshot)) return true;
  // ESPN may have advanced currentWeek before the prior week's review.
  if (!reviewScoresFinal(snapshot)) return true;
  return !(runs || []).some(run => {
    const started = new Date(run.created_at);
    if (run.conclusion !== 'success' || run.status !== 'completed' || run.head_branch !== 'main' || !Number.isFinite(started.valueOf()) || started > now) return false;
    const runClock = eastern(started);
    return dayKey(runClock) === dayKey(clock) && minutes(runClock) >= 8 * 60;
  });
}

async function main() {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GH_TOKEN;
  if (!repo || !token) throw new Error('GITHUB_REPOSITORY and GH_TOKEN are required.');
  let snapshot = null;
  try { snapshot = JSON.parse(await readFile(resolve(process.env.ESPN_OUTPUT || 'data/espn-2026.json'), 'utf8')); }
  catch { /* Missing or malformed data requires a refresh. */ }
  try {
    const response = await fetch(`https://api.github.com/repos/${repo}/actions/workflows/sync-espn.yml/runs?per_page=50&status=success`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' }
    });
    if (!response.ok) throw new Error(`GitHub Actions API returned ${response.status}`);
    const payload = await response.json();
    console.log(needsReviewRefresh(payload.workflow_runs, snapshot) ? 'refresh' : 'skip');
  } catch (error) {
    console.error(`Could not verify a successful review-morning refresh: ${error.message}; refreshing ESPN.`);
    console.log('refresh');
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
