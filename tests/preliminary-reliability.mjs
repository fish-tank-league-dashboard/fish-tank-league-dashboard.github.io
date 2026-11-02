import assert from 'node:assert/strict';
import { isPreliminaryWindow, preliminaryIsFresh } from '../scripts/capture-dick-brick.mjs';

const matchup = id => ({ id, home: { winProbability: 60, projectedPoints: 120 }, away: { winProbability: 40, projectedPoints: 110 } });
const preview = capturedAt => ({ season: 2026, week: 8, status: 'preliminary', capturedAt, matchups: [1, 2, 3, 4, 5].map(matchup) });
const edtNow = new Date('2026-10-26T17:00:00Z');
const estNow = new Date('2026-11-02T18:00:00Z');

assert.equal(isPreliminaryWindow(new Date('2026-10-26T15:29:00Z')), false);
assert.equal(isPreliminaryWindow(new Date('2026-10-26T15:30:00Z')), true);
assert.equal(isPreliminaryWindow(new Date('2026-11-02T16:29:00Z')), false);
assert.equal(isPreliminaryWindow(new Date('2026-11-02T16:30:00Z')), true);
assert.equal(isPreliminaryWindow(new Date('2026-11-01T17:00:00Z')), false);

const valid = preview('2026-11-02T16:40:00Z');
assert.equal(preliminaryIsFresh(valid, estNow, 8), true);
assert.equal(preliminaryIsFresh(preview('2026-10-26T15:40:00Z'), edtNow, 8), true);
assert.equal(preliminaryIsFresh(valid, estNow, 7), false);
assert.equal(preliminaryIsFresh({ ...valid, season: 2025 }, estNow, 8), false);
assert.equal(preliminaryIsFresh(preview('2026-11-02T16:29:00Z'), estNow, 8), false);
assert.equal(preliminaryIsFresh(preview('2026-11-01T17:00:00Z'), estNow, 8), false);
assert.equal(preliminaryIsFresh(preview('2026-11-02T18:01:00Z'), estNow, 8), false);
assert.equal(preliminaryIsFresh({ ...valid, matchups: valid.matchups.slice(1) }, estNow, 8), false);
assert.equal(preliminaryIsFresh({ ...valid, matchups: [matchup(1), matchup(1), matchup(3), matchup(4), matchup(5)] }, estNow, 8), false);
assert.equal(preliminaryIsFresh({ ...valid, matchups: [matchup(1), matchup(2), matchup(3), matchup(4), { ...matchup(5), away: { winProbability: null } }] }, estNow, 8), false);
console.log('Passed: preliminary Eastern window and current-week five-matchup freshness.');
