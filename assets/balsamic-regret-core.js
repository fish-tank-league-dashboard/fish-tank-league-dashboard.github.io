const cents = value => Math.round((value + Number.EPSILON) * 100);
const format = value => (value / 100).toFixed(2);
const frozenSource = source => source === 'ESPN mMatchupScore' || source === 'ESPN mRoster scoringPeriodId';

export function calculateBalsamicRegret(data) {
  if (!data || !Array.isArray(data.games)) return [];
  const rosters = data.advanced?.rosters || [];
  const regretRows = data.advanced?.lineupRegret || [];
  const captured = new Set(data.dataAvailability?.rosterPeriods?.captured || []);
  const weeks = [...new Set(data.games.map(game => Number(game.week)).filter(Number.isInteger))].sort((a, b) => b - a);
  return weeks.map(week => {
    const games = data.games.filter(game => Number(game.week) === week);
    const teams = new Map();
    for (const game of games) {
      if (!Number.isInteger(game.aTeamId) || !Number.isInteger(game.bTeamId) || game.aTeamId === game.bTeamId || teams.has(game.aTeamId) || teams.has(game.bTeamId))
        return { week, status: 'unavailable', reason: 'ESPN matchup teams are incomplete or duplicated.' };
      teams.set(game.aTeamId, { teamId: game.aTeamId, manager: game.al, team: game.at, gameScore: game.as });
      teams.set(game.bTeamId, { teamId: game.bTeamId, manager: game.bl, team: game.bt, gameScore: game.bs });
    }
    if (games.length !== 5 || teams.size !== 10)
      return { week, status: 'unavailable', reason: 'The full five-matchup league schedule is unavailable.' };
    if (games.some(game => game.status !== 'FINAL')) return { week, status: 'pending' };
    if (!captured.has(week)) return { week, status: 'unavailable', reason: 'Frozen weekly rosters have not been captured.' };
    const scores = [];
    for (const team of teams.values()) {
      const matches = rosters.filter(row => Number(row.week) === week && Number(row.teamId) === team.teamId);
      if (matches.length !== 1 || !frozenSource(matches[0].source) || !Array.isArray(matches[0].players) || !matches[0].players.length)
        return { week, status: 'unavailable', reason: 'A verified frozen weekly roster is missing.' };
      const roster = matches[0];
      const players = roster.players;
      const seen = new Set();
      let starterScore = 0;
      let starterCount = 0;
      for (const player of players) {
        if (!Number.isFinite(player.playerId) || seen.has(player.playerId))
          return { week, status: 'unavailable', reason: 'A roster contains missing or duplicate players.' };
        seen.add(player.playerId);
        const slot = Number(player.lineupSlotId);
        if (slot === 20 && player.status === 'BENCH') {
          // Eligible for the optimizer; never counted directly as regret.
        } else if (slot === 21 && player.status === 'IR') {
          // IR is outside the eligible player pool.
        } else if (slot !== 20 && slot !== 21 && player.status === 'STARTER') {
          starterCount++;
          if (player.points !== null && player.points !== undefined && Number.isFinite(Number(player.points))) starterScore += cents(Number(player.points));
        } else return { week, status: 'unavailable', reason: 'A roster has an unrecognized lineup slot.' };
        if (slot !== 21 && (player.points === null || player.points === undefined || !Number.isFinite(Number(player.points))))
          return { week, status: 'unavailable', reason: 'An actual ESPN player score is missing.' };
      }
      if (!starterCount) return { week, status: 'unavailable', reason: 'A weekly starting lineup is missing.' };
      if (!Number.isFinite(Number(team.gameScore)) || starterScore !== cents(Number(team.gameScore)))
        return { week, status: 'unavailable', reason: 'Roster player scores do not match the official ESPN matchup score.' };
      const metrics = regretRows.filter(row => Number(row.week) === week && Number(row.teamId) === team.teamId);
      if (metrics.length !== 1 || metrics[0].available !== true || !Array.isArray(metrics[0].assignments))
        return { week, status: 'unavailable', reason: 'A verified optimal lineup is missing.' };
      const metric = metrics[0];
      if (cents(Number(metric.actual)) !== starterScore || !Number.isFinite(Number(metric.optimal)))
        return { week, status: 'unavailable', reason: 'Optimal lineup totals do not match the verified starters.' };
      const slots = [...(roster.slots || [])].map(Number).sort((a, b) => a - b);
      const assignedSlots = metric.assignments.map(row => Number(row.slot)).sort((a, b) => a - b);
      const assignedPlayers = new Set();
      let optimalScore = 0;
      for (const assignment of metric.assignments) {
        const player = players.find(row => row.playerId === assignment.playerId);
        if (!player || player.status === 'IR' || assignedPlayers.has(player.playerId) || !player.eligibleSlots?.includes(Number(assignment.slot)))
          return { week, status: 'unavailable', reason: 'Optimal lineup has an ineligible or duplicate player.' };
        assignedPlayers.add(player.playerId);
        optimalScore += cents(Number(player.points));
      }
      if (JSON.stringify(slots) !== JSON.stringify(assignedSlots) || optimalScore !== cents(Number(metric.optimal)) || optimalScore < starterScore)
        return { week, status: 'unavailable', reason: 'Optimal lineup does not satisfy the scoring slots.' };
      scores.push({ ...team, actual: starterScore, optimal: optimalScore, points: optimalScore - starterScore });
    }
    scores.sort((a, b) => b.points - a.points || a.manager.localeCompare(b.manager));
    const top = scores[0].points;
    return { week, status: 'final', winners: scores.filter(row => row.points === top), scores };
  });
}



