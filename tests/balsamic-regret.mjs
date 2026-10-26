import assert from 'node:assert/strict';
import { calculateBalsamicRegret } from '../assets/balsamic-regret-core.mjs';
import { playerPoints, normalizeRosterEntry, optimizeLineup } from '../scripts/advanced-data.mjs';

const scoringEntry = { appliedStatTotal: 45, playerPoolEntry: { player: { stats: [
  { scoringPeriodId: 2, statSourceId: 0, statSplitTypeId: 1, appliedTotal: 7 },
  { scoringPeriodId: 2, statSourceId: 1, statSplitTypeId: 1, appliedTotal: 12 },
] } } };
assert.equal(playerPoints(scoringEntry, 2), 7, 'Weekly actual points must override season totals and projections');
assert.equal(playerPoints({ appliedStatTotal: 45 }, 2), null, 'A multi-period score cannot stand in for a missing weekly score');
assert.equal(playerPoints({ appliedStatTotal: 13, player: { stats: [{ scoringPeriodId: 1, statSourceId: 0, statSplitTypeId: 1, appliedTotal: 13 }] } }, 2), 0, 'A missing weekly stat is zero when the aggregate equals the prior actual');
assert.equal(playerPoints({ appliedStatTotal: 0 }, 2), 0, 'A zero aggregate confirms a zero weekly score');
assert.equal(normalizeRosterEntry({ ...scoringEntry, playerId: 11, lineupSlotId: 20 }, 2).points, 7);

const legal = optimizeLineup([
  { playerId: 1, status: 'STARTER', points: 10, eligibleSlots: [0] },
  { playerId: 2, status: 'STARTER', points: 10, eligibleSlots: [2] },
  { playerId: 3, status: 'BENCH', points: 25, eligibleSlots: [2, 23] },
  { playerId: 4, status: 'BENCH', points: 30, eligibleSlots: [4, 23] },
  { playerId: 5, status: 'IR', points: 100, eligibleSlots: [0, 2, 23] },
], [0, 2, 23]);
assert.equal(legal.valid, true);
assert.equal(legal.points, 65);
assert.ok(legal.assignments.every(row => row.playerId !== 5));

const makeData = () => {
  const games = [], rosters = [], lineupRegret = [];
  for (let n = 1; n <= 10; n++) {
    const starter = { playerId: n * 10 + 1, player: `Starter ${n}`, status: 'STARTER', lineupSlotId: 0, eligibleSlots: [0], points: 10 };
    const bench = { playerId: n * 10 + 2, player: `Bench ${n}`, status: 'BENCH', lineupSlotId: 20, eligibleSlots: [0, 20], points: n === 1 ? 25 : 15 };
    const ir = { playerId: n * 10 + 3, player: `IR ${n}`, status: 'IR', lineupSlotId: 21, eligibleSlots: [0, 21], points: 100 };
    rosters.push({ teamId: n, week: 1, source: 'ESPN mMatchupScore', slots: [0], players: [starter, bench, ir] });
    lineupRegret.push({ teamId: n, week: 1, actual: 10, optimal: bench.points, regret: bench.points - 10, available: true, assignments: [{ slot: 0, playerId: bench.playerId, points: bench.points }] });
  }
  for (let n = 1; n <= 10; n += 2) games.push({ week: 1, aTeamId: n, bTeamId: n + 1, al: `Manager ${n}`, bl: `Manager ${n + 1}`, at: `Team ${n}`, bt: `Team ${n + 1}`, as: 10, bs: 10, status: 'FINAL' });
  return { games, advanced: { rosters, lineupRegret }, dataAvailability: { rosterPeriods: { captured: [1] } } };
};
const award = data => calculateBalsamicRegret(data)[0];
assert.deepEqual(award(makeData()).winners.map(row => row.teamId), [1]);
const tie = makeData();
tie.advanced.rosters.find(row => row.teamId === 2).players[1].points = 25;
Object.assign(tie.advanced.lineupRegret.find(row => row.teamId === 2), { optimal: 25, regret: 15, assignments: [{ slot: 0, playerId: 22, points: 25 }] });
assert.deepEqual(award(tie).winners.map(row => row.teamId), [1, 2], 'Exact ties are shared');
const live = makeData(); live.games[0].status = 'LIVE';
assert.equal(award(live).status, 'pending');
const missing = makeData(); missing.advanced.rosters[0].players[1].points = null;
assert.equal(award(missing).status, 'unavailable');
const mismatch = makeData(); mismatch.games[0].as = 11;
assert.equal(award(mismatch).status, 'unavailable');
const illegal = makeData(); illegal.advanced.lineupRegret[0].assignments[0].slot = 2;
assert.equal(award(illegal).status, 'unavailable');
const uncaptured = makeData(); uncaptured.dataAvailability.rosterPeriods.captured = [];
assert.equal(award(uncaptured).status, 'unavailable');
console.log('Passed: weekly ESPN scores, legal lineup slots, IR, final-week gate, ties, and missing-data gates.');

