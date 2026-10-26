// Balsamic Regret is the actual lineup score lost versus the best legal lineup.
import { r as wrap } from './rolldown-runtime-S-ySWqyJ.js';
import { i as reactFactory } from './framework-CXnKph_e.js';

const React = wrap(reactFactory(), 1);
import { calculateBalsamicRegret } from './balsamic-regret-core.mjs';

const h = React.createElement;
const format = value => (value / 100).toFixed(2);
const style = `
.balsamic .regret-intro{max-width:760px;color:var(--muted)}
.balsamic .regret-summary{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin:20px 0}
.balsamic .regret-card{border:1px solid var(--line);border-radius:8px;padding:18px;background:var(--surface,transparent)}
.balsamic .regret-card strong{display:block;font-size:26px;color:var(--ink)}
.balsamic .regret-card small{display:block;color:var(--muted)}
.balsamic .regret-table{width:100%;border-collapse:collapse}
.balsamic .regret-table th,.balsamic .regret-table td{text-align:left;padding:10px;border-bottom:1px solid var(--line)}
.balsamic .regret-table small{display:block;color:var(--muted)}
.balsamic .regret-table tr.winner{color:var(--lime)}
.balsamic .regret-note{color:var(--muted);margin:12px 0}
`;
let installed = false;
function ensureStyle() {
  if (installed || typeof document === 'undefined') return;
  const node = document.createElement('style');
  node.textContent = style;
  document.head.appendChild(node);
  installed = true;
}

export default function BalsamicRegret({ league }) {
  React.useEffect(ensureStyle, []);
  const weeks = calculateBalsamicRegret(league);
  const final = weeks.filter(row => row.status === 'final');
  const latest = final[0];
  const totals = new Map();
  for (const row of final) for (const winner of row.winners) {
    const entry = totals.get(winner.teamId) || { ...winner, wins: 0 };
    entry.wins++;
    totals.set(winner.teamId, entry);
  }
  const leaders = [...totals.values()].sort((a, b) => b.wins - a.wins || a.manager.localeCompare(b.manager));
  return h('section', { className: 'page balsamic' },
    h('div', { className: 'page-title' }, h('div', null,
      h('p', { className: 'eyebrow' }, 'THE LINEUP RECEIPTS'),
      h('h1', null, 'Balsamic Regret'),
      h('p', { className: 'regret-intro' }, 'Each week, the team that lost the most points versus its best legal lineup gets the award. Injured reserve is ineligible. An exact tie gives the award to every tied team. Results appear only when all five matchups are final and all ten frozen rosters match ESPN scores.'))),
    h('div', { className: 'regret-summary' },
      h('article', { className: 'regret-card' }, h('p', { className: 'eyebrow' }, 'LATEST AWARD'), latest
        ? h(React.Fragment, null, h('strong', null, latest.winners.map(row => row.manager).join(' & ')), h('small', null, `Week ${latest.week} · ${format(latest.winners[0].points)} points lost`))
        : h('small', null, 'No verified winner yet')),
      h('article', { className: 'regret-card' }, h('p', { className: 'eyebrow' }, 'SEASON COUNT'), leaders.length
        ? leaders.map(row => h('small', { key: row.teamId }, `${row.manager}: ${row.wins}`))
        : h('small', null, 'Waiting for completed weeks'))),
    weeks.map(row => h('article', { className: 'regret-card', key: row.week },
      h('h2', null, `Week ${row.week}`),
      row.status === 'pending' ? h('p', { className: 'regret-note' }, 'Games in progress. Award pending.')
      : row.status === 'unavailable' ? h('p', { className: 'regret-note' }, `Award unavailable: ${row.reason}`)
      : h(React.Fragment, null,
        h('p', { className: 'regret-note' }, `${row.winners.map(winner => winner.manager).join(' & ')} · ${format(row.winners[0].points)} optimal-lineup points lost${row.winners.length > 1 ? ' · shared award' : ''}`),
        h('div', { className: 'table-card', role: 'region', tabIndex: 0, 'aria-label': `Week ${row.week} lineup scores` },
          h('table', { className: 'regret-table' },
              h('thead', null, h('tr', null, h('th', { scope: 'col' }, 'Team'), h('th', { scope: 'col' }, 'Actual lineup'), h('th', { scope: 'col' }, 'Best legal lineup'), h('th', { scope: 'col' }, 'Points lost'))),
            h('tbody', null, row.scores.map(score => h('tr', { key: score.teamId, className: row.winners.some(winner => winner.teamId === score.teamId) ? 'winner' : '' },
              h('td', null, score.team, h('small', null, score.manager)),
              h('td', null, format(score.actual)),
              h('td', null, format(score.optimal)),
              h('td', null, format(score.points))))))))));
}


