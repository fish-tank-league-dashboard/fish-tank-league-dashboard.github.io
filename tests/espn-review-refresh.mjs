import assert from 'node:assert/strict';
import { needsReviewRefresh, validSnapshot, reviewScoresFinal } from '../scripts/check-espn-review-refresh.mjs';

const snapshot = {
  leagueId: 791101930, season: 2026, available: true, currentWeek: 8,
  // A no-diff sync leaves this timestamp unchanged. Run success proves the check ran.
  updatedAt: '2026-11-02T04:50:00Z', standings: Array.from({ length: 10 }, (_, n) => ({ rank: n + 1 })),
  games: Array.from({ length: 5 }, (_, n) => ({ week: 8, a: `a${n}`, b: `b${n}`, status: 'FINAL' }))
};
const run = created_at => ({ created_at, status: 'completed', conclusion: 'success', head_branch: 'main' });
const estReview = new Date('2026-11-03T14:17:00Z'); // 9:17am EST
const edtReview = new Date('2026-10-27T13:17:00Z'); // 9:17am EDT

assert.equal(validSnapshot(snapshot), true);
assert.equal(reviewScoresFinal(snapshot), true);
assert.equal(needsReviewRefresh([], snapshot, estReview), true, 'missed morning runs require a refresh');
assert.equal(needsReviewRefresh([run('2026-11-03T04:50:00Z')], snapshot, estReview), true, 'overnight success does not cover the review');
assert.equal(needsReviewRefresh([run('2026-11-03T13:17:00Z')], snapshot, estReview), false, 'successful no-diff morning run avoids another ESPN request');
assert.equal(needsReviewRefresh([run('2026-10-27T12:17:00Z')], snapshot, edtReview), false, 'EDT morning success counts');
assert.equal(needsReviewRefresh([run('2026-11-03T13:17:00Z')], { ...snapshot, games: snapshot.games.slice(1) }, estReview), true, 'invalid saved snapshot is refreshed');
assert.equal(needsReviewRefresh([run('2026-11-03T13:17:00Z')], { ...snapshot, games: snapshot.games.map(game => ({ ...game, status: 'LIVE' })) }, estReview), true, 'a prior sync with live games needs a final-score retry');
const rollover = { ...snapshot, currentWeek: 9, games: [...snapshot.games, ...snapshot.games.map(game => ({ ...game, week: 9, status: 'SCHEDULED' }))] };
assert.equal(needsReviewRefresh([run('2026-11-03T13:17:00Z')], rollover, estReview), false, 'next-week schedule does not force a redundant refresh after prior-week finals');
assert.equal(needsReviewRefresh([run('2026-11-03T13:17:00Z')], snapshot, new Date('2026-11-03T12:17:00Z')), true, 'before 8am ET retains the existing cadence');
assert.equal(needsReviewRefresh([run('2026-11-03T13:17:00Z')], snapshot, new Date('2026-11-05T14:17:00Z')), true, 'Tuesday success does not cover Thursday');
assert.equal(needsReviewRefresh([{ ...run('2026-11-03T13:17:00Z'), conclusion: 'failure' }], snapshot, estReview), true);
console.log('Passed: normal refresh, no-diff success, missed refresh, DST, and invalid snapshot.');
