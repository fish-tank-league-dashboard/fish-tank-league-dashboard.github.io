// Dick Brick of the Week tab. Hand-written (not build output); loaded by page-Dbq9q0Z0.js.
import { r as wrap } from './rolldown-runtime-S-ySWqyJ.js';
import { i as reactFactory } from './framework-CXnKph_e.js';

const React = wrap(reactFactory(), 1);
const h = React.createElement;
const base = '/';
const STATUSES = ['verified', 'manual'];
let cachedRequest;
let cachedAt = 0;

const css = `
.bricks .brick-grid{display:grid;grid-template-columns:minmax(220px,300px) 1fr;gap:19px;margin-bottom:19px}
.bricks .brick-showcase{text-align:center}
.bricks .brick-showcase img{max-width:100%;height:auto;border-radius:6px}
.bricks .brick-showcase h2{margin:12px 0 4px}
.bricks .brick-showcase p{color:var(--muted);margin:0}
.bricks .brick-recipient{margin:14px 0 0;padding-top:14px;border-top:1px solid var(--line)}
.bricks .brick-recipient b{display:block;font-size:22px;color:var(--ink)}
.bricks button{background:transparent;color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:6px 10px;font:11px DM Mono;cursor:pointer;margin-top:8px}
.bricks .brick-leaders{list-style:none;margin:0;padding:0}
.bricks .leader b{flex:1}
.bricks .leader small,.bricks td small{display:block;color:var(--muted);font-weight:400}
.bricks .leader em{font:12px DM Mono;color:var(--lime);font-style:normal}
.bricks table{width:100%;border-collapse:collapse}
.bricks th,.bricks td{text-align:left;padding:10px 12px;border-bottom:1px solid var(--line)}
.bricks .tag{display:inline-block;font:10px DM Mono;color:var(--orange);border:1px solid var(--orange);border-radius:4px;padding:1px 5px;margin-left:6px}
.bricks .brick-rule{color:var(--muted);font-size:13px}
.bricks .brick-season select{margin-left:8px;background:var(--paper);color:var(--ink);border:1px solid var(--line);border-radius:6px;padding:5px}
@media (max-width:720px){.bricks .brick-grid{grid-template-columns:1fr}}
`;
function ensureStyles() {
  if (typeof document === 'undefined' || !document.head || document.getElementById('dick-brick-styles')) return;
  const style = document.createElement('style');
  style.id = 'dick-brick-styles';
  style.textContent = css;
  document.head.appendChild(style);
}

// A verified award must carry a captured probability; a manual award must not claim one.
export function validateAwards(data) {
  if (!data || !Array.isArray(data.awards)) throw new Error('Invalid award ledger');
  const weeks = new Set();
  for (const award of data.awards) {
    const complete = award && Number.isInteger(award.season) && award.season >= 2026 &&
      Number.isInteger(award.week) && award.week >= 1 && award.week <= 18 &&
      STATUSES.includes(award.status) &&
      ['manager', 'team', 'opponent', 'finalScore'].every(key => typeof award[key] === 'string' && award[key].trim());
    if (!complete) throw new Error('Incomplete award record');
    const hasProbability = Number.isFinite(award.winProbability) && award.winProbability >= 0 && award.winProbability <= 100;
    if (award.status === 'verified' && (!hasProbability || !award.capturedAt)) throw new Error('Verified award lacks a captured probability');
    if (award.status === 'manual' && award.winProbability != null) throw new Error('Manual award must not carry a probability');
    const key = `${award.season}:${award.week}`;
    if (weeks.has(key)) throw new Error('Duplicate weekly award');
    weeks.add(key);
  }
  return data.awards;
}

function loadAwards() {
  if (!cachedRequest || Date.now() - cachedAt > 60000) {
    cachedAt = Date.now();
    cachedRequest = fetch(`${base}data/dick-bricks.json?t=${Date.now()}`, { cache: 'no-store' })
      .then(response => {
        if (!response.ok) throw new Error('Award ledger unavailable');
        return response.json();
      }).then(validateAwards).catch(error => {
        cachedRequest = null;
        throw error;
      });
  }
  return cachedRequest;
}

// Optional retrospective reviews for weeks with no live capture; absent files are simply skipped.
function loadReview(season, week) {
  return fetch(`${base}data/dick-brick-review-week${week}.json?t=${Date.now()}`, { cache: 'no-store' })
    .then(response => response.ok ? response.json() : null)
    .then(review => review && review.season === season && review.week === week && review.status === 'retrospective' && Array.isArray(review.matchups) ? review : null)
    .catch(() => null);
}

const fixed = value => Number(value).toFixed(2);
const loadJson = file => fetch(`${base}data/${file}?t=${Date.now()}`, { cache: 'no-store' })
  .then(response => response.ok ? response.json() : null)
  .catch(() => null);

const validMatchups = matchups => Array.isArray(matchups) && matchups.length > 0 &&
  matchups.every(matchup => [matchup?.home, matchup?.away].every(side => side && side.team && side.manager &&
    Number.isFinite(side.projectedPoints) && Number.isFinite(side.winProbability)));

// This week's projections for a week with no award yet: the pre-kickoff capture once it
// exists, otherwise the Monday-morning preliminary run. Neither is an award.
export function currentProjections(snapshots, previews, awards) {
  const awarded = new Set(awards.map(row => `${row.season}:${row.week}`));
  const candidates = [
    ...(snapshots?.snapshots || []).filter(row => validMatchups(row.matchups)).map(row => ({ ...row, kind: 'capture' })),
    ...(previews?.previews || []).filter(row => row.status === 'preliminary' && validMatchups(row.matchups)).map(row => ({ ...row, kind: 'preliminary' }))
  ].filter(row => Number.isInteger(row.season) && Number.isInteger(row.week) && !awarded.has(`${row.season}:${row.week}`));
  candidates.sort((a, b) => b.season - a.season || b.week - a.week || (a.kind === 'capture' ? -1 : 1) - (b.kind === 'capture' ? -1 : 1));
  return candidates[0] || null;
}

const easternTime = iso => new Date(iso).toLocaleString('en-US', { timeZone: 'America/New_York', weekday: 'short', hour: 'numeric', minute: '2-digit' }) + ' ET';
function ProjectionsPanel({ projection }) {
  const captured = projection.kind === 'capture';
  return h('article', { className: 'brick-history' },
    h('h2', { className: 'eyebrow' }, `WEEK ${projection.week} PROJECTIONS · ${captured ? 'PRE-KICKOFF CAPTURE' : 'PRELIMINARY'}`),
    h('p', null, captured
      ? `ESPN live projections captured ${easternTime(projection.capturedAt)}, ${projection.minutesBeforeKickoff} minutes before the first Monday Night Football kickoff. These are the probabilities the brick will be decided on once the week is final.`
      : `ESPN live projections as of ${easternTime(projection.capturedAt)}. Preliminary only: the brick is decided on the capture taken just before the first Monday Night Football kickoff.`),
    h('div', { className: 'table-card', tabIndex: 0, role: 'region', 'aria-label': `Week ${projection.week} projections` },
      h('table', null,
        h('thead', null, h('tr', null, ['Team', 'Points so far', 'Projected total', 'Win %'].map(label => h('th', { scope: 'col', key: label }, label)))),
        h('tbody', null, projection.matchups.flatMap((matchup, index) => [matchup.home, matchup.away].map(side => h('tr', { key: `${index}-${side.manager}` },
          h('td', null, h('b', null, side.team), h('small', null, side.manager)),
          h('td', null, fixed(side.pointsAtCapture ?? 0)), h('td', null, fixed(side.projectedPoints)),
          h('td', null, `${side.winProbability}%`, !captured && h('span', { className: 'tag' }, 'PRELIMINARY')))))))));
}

export function summarizeSeason(awards, season) {
  const receipts = awards.filter(row => row.season === season).sort((a, b) => b.week - a.week);
  const managers = new Map();
  for (const row of receipts) {
    const key = row.managerId || row.manager;
    if (!managers.has(key)) managers.set(key, { key, manager: row.manager, team: row.team, bricks: 0, manual: 0 });
    const entry = managers.get(key);
    entry.bricks++;
    if (row.status === 'manual') entry.manual++;
  }
  const leaders = [...managers.values()].sort((a, b) => b.bricks - a.bricks || a.manager.localeCompare(b.manager));
  let rank = 0;
  for (let i = 0; i < leaders.length; i++) {
    if (i === 0 || leaders[i].bricks !== leaders[i - 1].bricks) rank = i + 1;
    leaders[i].rank = rank;
  }
  return { receipts, leaders, latest: receipts[0] || null };
}

const probabilityCell = (row, review) => row.status === 'verified'
  ? h('td', { className: 'minus' }, `${row.winProbability}%`)
  : review
    ? h('td', null, `${review.recipientProbability}%`, h('span', { className: 'tag' }, 'RETROSPECTIVE'))
    : h('td', null, 'Not captured', h('span', { className: 'tag' }, 'MANUAL'));

export function recipientProbability(review, award) {
  for (const matchup of review.matchups) for (const side of [matchup.home, matchup.away]) if (side.managerId === award.managerId) return side.winProbability;
  return null;
}
function ReviewPanel({ review, award }) {
  const agrees = review.brickRecipient === award.manager;
  return h('article', { className: 'brick-history' },
    h('h2', { className: 'eyebrow' }, `WEEK ${review.week} VERIFICATION · RETROSPECTIVE`),
    h('p', null, agrees
      ? `Rebuilt from ESPN data, ${award.manager} was the losing team with the highest win probability heading into Monday Night Football (${review.brickWinProbability}%).`
      : `Rebuilt from ESPN data, the losing team with the highest win probability heading into Monday Night Football was ${review.brickRecipient} (${review.brickWinProbability}%), not ${award.manager}. The award has not been changed.`),
    h('div', { className: 'table-card', tabIndex: 0, role: 'region', 'aria-label': `Week ${review.week} pre-MNF projections` },
      h('table', null,
        h('thead', null, h('tr', null, ['Team', 'Scored before MNF', 'Projected rest', 'Projected total', 'Win % at MNF', 'Final'].map(label => h('th', { scope: 'col', key: label }, label)))),
        h('tbody', null, review.matchups.flatMap((matchup, index) => [matchup.home, matchup.away].map(side => h('tr', { key: `${index}-${side.managerId}` },
          h('td', null, h('b', null, side.team), h('small', null, side.manager)),
          h('td', null, fixed(side.scoredBeforeMnf)), h('td', null, fixed(side.projectedRemaining)), h('td', null, fixed(side.projectedTotal)),
          h('td', { className: side.manager === matchup.loser ? 'minus' : '' }, `${side.winProbability}%`),
          h('td', null, fixed(side.finalScore)))))))),
    h('p', { className: 'brick-rule' }, review.method));
}

export default function DickBrickAward() {
  const [awards, setAwards] = React.useState(null);
  const [error, setError] = React.useState(false);
  const [attempt, setAttempt] = React.useState(0);
  const [reviews, setReviews] = React.useState({});
  const [projection, setProjection] = React.useState(null);
  const [selectedSeason, setSelectedSeason] = React.useState(2026);
  const [animate, setAnimate] = React.useState(() => !window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  React.useEffect(() => {
    ensureStyles();
    let active = true;
    setError(false);
    loadAwards().then(rows => {
      if (!active) return;
      setAwards(rows);
      Promise.all([loadJson('dick-brick-snapshots.json'), loadJson('dick-brick-preliminary.json')])
        .then(([snapshots, previews]) => { if (active) setProjection(currentProjections(snapshots, previews, rows)); });
      rows.filter(row => row.status === 'manual').forEach(row => loadReview(row.season, row.week).then(review => {
        if (active && review) setReviews(current => ({ ...current, [`${row.season}:${row.week}`]: { ...review, recipientProbability: recipientProbability(review, row) } }));
      }));
    })
      .catch(() => { if (active) setError(true); });
    return () => { active = false; };
  }, [attempt]);
  const seasons = React.useMemo(() => [...new Set([2026, ...(awards || []).map(row => row.season)])].sort((a, b) => b - a), [awards]);
  const { receipts, leaders, latest } = React.useMemo(() => summarizeSeason(awards || [], selectedSeason), [awards, selectedSeason]);

  let board;
  if (error) board = h('div', { className: 'empty', role: 'alert' },
    h('b', null, 'Brick records could not be loaded'),
    h('p', null, 'Try again to see the season totals.'),
    h('button', { onClick: () => setAttempt(value => value + 1) }, 'Retry'));
  else if (awards === null) board = h('p', { role: 'status' }, 'Loading brick records…');
  else if (!leaders.length) board = h('div', { className: 'empty' },
    h('b', null, 'No bricks recorded'),
    h('p', null, 'Weekly recipients appear here once their pre-MNF probabilities and final results are recorded.'));
  else board = h('ol', { className: 'brick-leaders', 'aria-label': `${selectedSeason} brick leaderboard` },
    leaders.map(row => h('li', { className: 'leader', key: row.key },
      h('span', null, row.rank), h('b', null, row.manager, h('small', null, row.team)),
      h('em', null, `${row.bricks} ${row.bricks === 1 ? 'brick' : 'bricks'}`))));

  const recipient = latest && h('div', { className: 'brick-recipient' },
    h('p', { className: 'eyebrow' }, `WEEK ${latest.week} RECIPIENT`),
    h('b', null, latest.manager), h('span', null, latest.team),
    h('p', null, `Lost ${latest.finalScore} to ${latest.opponent}`),
    latest.status === 'manual'
      ? h('p', null, h('span', { className: 'tag' }, 'MANUAL'), reviews[`${latest.season}:${latest.week}`]
        ? ` ${reviews[`${latest.season}:${latest.week}`].recipientProbability}% to win at MNF kickoff (retrospective, see verification below).`
        : ' Pre-MNF win probability was not captured.')
      : h('p', null, `${latest.winProbability}% to win at MNF kickoff`));

  return h('section', { className: 'page bricks' },
    h('div', { className: 'page-title' },
      h('div', null, h('p', { className: 'eyebrow' }, 'THE WEEKLY SHAME'),
        h('h1', null, 'Dick Brick of the Week'),
        h('p', null, 'Among the teams that lost, the brick goes to the team with the highest win probability immediately before the first Monday Night Football kickoff.')),
      h('label', { className: 'brick-season' }, 'Season',
        h('select', { value: selectedSeason, onChange: event => setSelectedSeason(Number(event.target.value)) },
          seasons.map(season => h('option', { value: season, key: season }, season))))),
    h('section', { className: 'brick-grid' },
      h('article', { className: 'brick-showcase' },
        h('img', { src: `${base}assets/dick-brick.${animate ? 'webp' : 'jpg'}`, width: 220, height: 271,
          decoding: 'async', alt: 'Dick Brick of the Week award' }),
        h('button', { onClick: () => setAnimate(value => !value), 'aria-pressed': animate }, animate ? 'Pause animation' : 'Play animation'),
        h('h2', null, 'Hold this.'), h('p', null, 'Monday had other plans. The brick is yours.'),
        recipient),
      h('article', null, h('p', { className: 'eyebrow' }, `${selectedSeason} SEASON BRICK COUNT`), board)),
    !error && projection && projection.season === selectedSeason && h(ProjectionsPanel, { projection }),
    !error && receipts.length > 0 && h('article', { className: 'brick-history' },
      h('h2', { className: 'eyebrow' }, 'BRICK RECEIPTS'),
      h('div', { className: 'table-card', tabIndex: 0, role: 'region', 'aria-label': 'Weekly brick receipts' },
        h('table', null,
          h('thead', null, h('tr', null, ['Week', 'Recipient', 'Opponent', 'Win % at MNF', 'Final score'].map(label => h('th', { scope: 'col', key: label }, label)))),
          h('tbody', null, receipts.map(row => h('tr', { key: row.week },
            h('td', null, `W${row.week}`), h('td', null, h('b', null, row.team), h('small', null, row.manager)),
            h('td', null, row.opponent, row.opponentManager && h('small', null, row.opponentManager)),
            probabilityCell(row, reviews[`${row.season}:${row.week}`]), h('td', null, row.finalScore))))))),
    !error && receipts.filter(row => reviews[`${row.season}:${row.week}`]).map(row => h(ReviewPanel, { key: `review-${row.week}`, review: reviews[`${row.season}:${row.week}`], award: row })),
    h('p', { className: 'brick-rule' }, 'One brick per week. Win probabilities come only from ESPN live projections captured before the first Monday Night Football kickoff; weeks without a capture are marked manual and show no probability.'));
}
