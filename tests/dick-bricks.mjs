// Run with: node tests/dick-bricks.mjs
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

globalThis.window = { matchMedia: () => ({ matches: true }) };
const { validateAwards, summarizeSeason } = await import('../assets/dick-bricks.js');
const { projectedWinProbability, awardCandidate, projectedSide, teamDirectory } = await import('../scripts/capture-dick-brick.mjs');
const json = async path => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8'));

// Shipped ledger: Week 1 is manual with no probability, names match the ESPN feed.
const ledger = await json('../data/dick-bricks.json');
const league = await json('../data/espn-2026.json');
validateAwards(ledger);
const week1 = ledger.awards.find(row => row.season === 2026 && row.week === 1);
assert.equal(week1.status, 'manual');
assert.equal(week1.winProbability, null);
const game = league.games.find(row => row.season === 2026 && row.week === 1 && [row.a, row.b].includes(week1.managerId));
const mine = game.a === week1.managerId ? 'a' : 'b', theirs = mine === 'a' ? 'b' : 'a';
assert.equal(week1.team, game[`${mine}t`].trim());
assert.equal(week1.opponent, game[`${theirs}t`].trim());
assert.ok(game[`${mine}s`] < game[`${theirs}s`], 'Week 1 recipient must have lost');
assert.equal(week1.finalScore, `${game[`${mine}s`].toFixed(2)}–${game[`${theirs}s`].toFixed(2)}`);
assert.equal((await json('../data/dick-brick-snapshots.json')).snapshots.length, 0);

// Validation rejects invented or missing probabilities.
const row = (week, manager, extra = {}) => ({ season: 2026, week, status: 'verified', manager, team: `${manager} team`, opponent: 'Opp', winProbability: 80, capturedAt: '2026-09-22T00:00:00Z', finalScore: '1–2', ...extra });
assert.throws(() => validateAwards({ awards: [row(1, 'A', { status: 'manual' })] }), /must not carry/);
assert.throws(() => validateAwards({ awards: [row(1, 'A', { winProbability: null })] }), /lacks a captured/);
assert.throws(() => validateAwards({ awards: [row(1, 'A', { capturedAt: undefined })] }), /lacks a captured/);
assert.throws(() => validateAwards({ awards: [row(1, 'A'), row(1, 'B')] }), /Duplicate/);
assert.throws(() => validateAwards({ awards: [row(1, 'A', { status: undefined })] }), /Incomplete/);
const summary = summarizeSeason([row(1, 'A', { status: 'manual', winProbability: null }), row(2, 'A'), row(3, 'B')], 2026);
assert.deepEqual(summary.leaders.map(r => [r.manager, r.bricks, r.rank]), [['A', 2, 1], ['B', 1, 2]]);
assert.equal(summary.latest.week, 3);

// Capture: probabilities only from live projections, loud failure otherwise.
assert.equal(projectedWinProbability(100, 100), 50);
assert.equal(projectedWinProbability(80, 100), 15.9);
const directory = teamDirectory(league);
assert.equal(directory.get(9).manager, 'Gilguy');
assert.throws(() => projectedSide({ teamId: 9, totalPoints: 100 }, { teamId: 2, totalProjectedPointsLive: 90 }, directory), /live projected totals/);
assert.throws(() => projectedSide({ teamId: 999, totalProjectedPointsLive: 1 }, { teamId: 2, totalProjectedPointsLive: 1 }, directory), /not in data/);
const side = projectedSide({ teamId: 9, totalProjectedPointsLive: 120 }, { teamId: 2, totalProjectedPointsLive: 108 }, directory);
assert.equal(side.team, 'Dico Rowdle');
assert.ok(side.winProbability > 70 && side.winProbability < 75);

const s = (manager, winProbability, projectedPoints) => ({ manager, managerId: manager, team: `${manager} team`, winProbability, projectedPoints });
const snapshot = { matchups: [{ id: 1, home: s('Fav won', 91, 150), away: s('A', 74, 128) }, { id: 2, home: s('B', 63, 120), away: s('Fav lost', 86, 143) }] };
const award = awardCandidate(snapshot, [
  { id: 1, winner: 'HOME', home: { totalPoints: 123.45 }, away: { totalPoints: 111.11 } },
  { id: 2, winner: 'HOME', home: { totalPoints: 120 }, away: { totalPoints: 119.5 } }
]);
assert.deepEqual([award.manager, award.opponent, award.finalScore], ['Fav lost', 'B team', '119.50–120.00']);
assert.equal(awardCandidate(snapshot, [{ id: 1, winner: 'UNDECIDED' }]), null);

// Bundle patch: tab sits directly after Standings, Tank Features kept, module wired in.
const bundle = await readFile(new URL('../assets/page-Dbq9q0Z0.js', import.meta.url), 'utf8');
const nav = [...bundle.match(/nav`,\{children:\[(.*?)\]\.map/)[1].matchAll(/\[`(\w+)`,`([^`]+)`\]/g)].map(m => m[1]);
assert.deepEqual(nav, ['home', 'live', 'standings', 'bricks', 'results', 'rivalries', 'features', 'trophy', 'drafts', 'about']);
assert.match(bundle, /import __DickBrick from"\.\/dick-bricks\.js"/);
assert.match(bundle, /n===`bricks`&&\(0,p\.jsx\)\(__DickBrick,\{\}\),n===`features`/);
console.log('Passed: ledger integrity, no invented probabilities, capture failures, award selection, and nav wiring.');

// Retrospective review: scored-before-MNF plus stored projections for starters still to play.
const { projectedAtKickoff } = await import('../scripts/capture-dick-brick.mjs');
const mnf = new Date('2026-09-15T00:15:00Z');
const entry = (lineupSlotId, name, proTeamId, actual, projected) => ({ lineupSlotId, playerPoolEntry: { appliedStatTotal: actual, player: { fullName: name, proTeamId, stats: projected == null ? [] : [{ statSourceId: 1, statSplitTypeId: 1, scoringPeriodId: 1, appliedTotal: projected }] } } });
const kickoffs = new Map([['1', new Date('2026-09-14T17:00:00Z')], ['2', mnf]]);
const rebuilt = projectedAtKickoff({ rosterForCurrentScoringPeriod: { entries: [entry(0, 'Sunday', 1, 18, 10), entry(2, 'Monday', 2, 25, 13.9), entry(20, 'Bench', 2, 40, 20)] } }, kickoffs, mnf, 1);
assert.deepEqual([rebuilt.scoredBeforeMnf, rebuilt.projectedRemaining, rebuilt.projectedTotal, rebuilt.problems.length], [18, 13.9, 31.9, 0]);
const missing = projectedAtKickoff({ rosterForCurrentScoringPeriod: { entries: [entry(2, 'Monday', 2, 25, null), entry(0, 'Nobody', 99, 1, 1)] } }, kickoffs, mnf, 1);
assert.equal(missing.problems.length, 2, 'Missing projections or kickoffs must be reported, not guessed');
console.log('Passed: retrospective pre-MNF rebuild and missing-data reporting.');
