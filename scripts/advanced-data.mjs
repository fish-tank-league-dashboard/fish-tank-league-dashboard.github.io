// Pure ESPN-derived feature calculations.  This file deliberately contains no
// network or model calls so the recurring sync remains deterministic.

export const FEATURE_VERSION = 1;
export const TRANSACTION_FEATURE_VERSION = 1;

const round = (value) => Math.round((Number(value) || 0) * 100) / 100;
const asArray = (value) => Array.isArray(value) ? value : [];
const number = (value) => value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);

const integer = (value) => {
  const parsed = number(value);
  return parsed === null ? null : Math.trunc(parsed);
};

const text = (value) => value === null || value === undefined ? "" : String(value).trim();

const acceptedTransactionStatuses = new Set([
  "COMPLETE", "COMPLETED", "EXECUTED", "PROCESSED", "SUCCESS", "SUCCESSFUL",
]);
const rejectedTransactionStatuses = new Set([
  "CANCELLED", "CANCELED", "DECLINED", "FAILED", "INVALID", "PENDING", "PROPOSED",
  "REJECTED", "VETOED", "WAIVER_PENDING",
]);

/**
 * ESPN's transaction endpoint has had a few response wrappers over time. Keep
 * extraction deliberately narrow: league transactions/activities only, never
 * discussions, messages, bids, or arbitrary communication payloads.
 */
export function extractTransactionRecords(payload = {}) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== "object") return [];
  if (Array.isArray(payload.transactions)) return payload.transactions;
  return [];
}

export function isCompletedTransaction(transaction = {}) {
  const status = text(transaction.status ?? transaction.state ?? transaction.transactionStatus ?? transaction.executionStatus).toUpperCase();
  if (rejectedTransactionStatuses.has(status)) return false;
  // A status alone is not enough: ESPN can expose an accepted/proposed review
  // record before it is executed. Require a verified process/completion date.
  const processed = transaction.processDate ?? transaction.completedAt ?? transaction.executedDate;
  if (processed === null || processed === undefined || processed === "") return false;
  return acceptedTransactionStatuses.has(status);
}

const transactionType = (transaction = {}, item = {}) => {
  const rawItem = text(item.type).toUpperCase().replace(/[\s-]+/g, "_");
  const rawTransaction = text(transaction.type || transaction.transactionType).toUpperCase().replace(/[\s-]+/g, "_");
  const raw = rawItem || rawTransaction;
  if (["WAIVER", "WAIVER_CLAIM", "WAIVER_ADD", "FAAB"].includes(rawTransaction) && ["", "ADD", "ADDED", "CLAIM", "FREE_AGENT", "FREEAGENT"].includes(rawItem)) return "WAIVER";
  if (["WAIVER", "WAIVER_CLAIM", "WAIVER_ADD", "FAAB"].includes(raw)) return "WAIVER";
  if (["TRADE", "TRADES"].includes(raw)) return "TRADE";
  if (["DROP", "DROPPED", "RELEASE"].includes(raw)) return "DROP";
  if (["ADD", "ADDED", "CLAIM", "FREE_AGENT", "FREEAGENT"].includes(raw)) return "ADD";
  return raw;
};

const transactionDate = (transaction = {}) => {
  const value = transaction.processDate ?? transaction.completedAt ?? transaction.executedDate ?? transaction.proposedDate ?? transaction.date;
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "number" || /^\d+$/.test(String(value)) ? new Date(Number(value)) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
};

const transactionPlayer = (item = {}) => item.player || item.playerPoolEntry?.player || item.playerPoolEntry || {};
const transactionPlayerId = (item = {}) => integer(item.playerId ?? item.player?.id ?? item.playerPoolEntry?.player?.id ?? item.targetId);
const transactionPlayerName = (item = {}, playerNames = new Map()) => {
  const id = transactionPlayerId(item);
  const player = transactionPlayer(item);
  return text(item.playerName || player.fullName || [player.firstName, player.lastName].filter(Boolean).join(" ") || (id !== null ? playerNames.get(id) : ""));
};
const transactionTeamId = (value) => integer(value?.teamId ?? value?.id ?? value);

const teamForId = (teamId, teamsById) => {
  const team = teamsById.get(Number(teamId));
  if (!team) return { teamId: teamId === null ? null : Number(teamId), team: null, manager: null, ownerId: null };
  return { teamId: Number(team.teamId ?? team.id), team: team.team || null, manager: team.manager || null, ownerId: team.ownerId || null };
};

const itemTeamId = (transaction, item, direction = "to") => {
  const direct = direction === "from"
    ? (item.fromTeamId ?? item.from?.teamId ?? item.from?.id ?? transaction.fromTeamId ?? transaction.from?.teamId)
    : (item.toTeamId ?? item.to?.teamId ?? item.to?.id ?? item.forTeamId ?? item.for?.teamId ?? item.for?.id ?? transaction.toTeamId ?? transaction.to?.teamId ?? transaction.teamId ?? transaction.team?.id);
  return transactionTeamId(direct);
};

const playerPosition = (item = {}) => {
  const player = transactionPlayer(item);
  return normalizePosition(player.defaultPositionId ?? player.positionId ?? player.position ?? item.position);
};

const faabAmount = (transaction = {}, item = {}) => {
  const value = item.bidAmount ?? item.bid ?? item.faab ?? transaction.bidAmount ?? transaction.bid ?? transaction.faab;
  return value === null || value === undefined || value === "" || !Number.isFinite(Number(value)) ? null : Number(value);
};

/**
 * Convert only accepted ESPN transactions into the public-safe, stable feed.
 * No ESPN member IDs, cookies, bids/offers, or communication text are copied.
 */
export function normalizeTransactions(records = [], { season = null, teams = [], playerNames = new Map() } = {}) {
  const teamsById = new Map(teams.map((team) => [Number(team.teamId ?? team.id), team]));
  const names = playerNames instanceof Map ? playerNames : new Map(Object.entries(playerNames).map(([id, name]) => [Number(id), name]));
  const items = [];
  const trades = [];
  const seen = new Set();
  let acceptedCount = 0;
  let excludedCount = 0;

  for (let index = 0; index < records.length; index++) {
    const transaction = records[index] || {};
    if (!isCompletedTransaction(transaction)) { excludedCount++; continue; }
    const type = transactionType(transaction);
    if (!["ADD", "DROP", "WAIVER", "TRADE"].includes(type)) { excludedCount++; continue; }
    const date = transactionDate(transaction);
    const scoringPeriodId = integer(transaction.scoringPeriodId ?? transaction.period ?? transaction.week);
    const rawId = transaction.id ?? transaction.transactionId ?? transaction.activityId;
    const fallbackPlayers = (Array.isArray(transaction.items) ? transaction.items : [transaction]).map((item) => transactionPlayerId(item) ?? transactionPlayerName(item, names)).filter(Boolean).sort().join(",");
    const fallbackTeams = [transaction.teamId, transaction.fromTeamId, transaction.toTeamId].map(transactionTeamId).filter((teamId) => teamId !== null).sort((a, b) => a - b).join(",");
    const transactionId = rawId !== null && rawId !== undefined && rawId !== ""
      ? `espn:${String(rawId)}`
      : `tx:${season ?? "unknown"}:${scoringPeriodId ?? "unknown"}:${type}:${date ?? "unknown"}:${fallbackTeams}:${fallbackPlayers}`;
    if (seen.has(transactionId)) continue;
    seen.add(transactionId);
    acceptedCount++;
    const transactionItems = Array.isArray(transaction.items) ? transaction.items : [];

    if (type === "TRADE") {
      const sidesById = new Map();
      const ensureSide = (teamId) => {
        if (teamId === null) return null;
        if (!sidesById.has(teamId)) sidesById.set(teamId, { ...teamForId(teamId, teamsById), players: [], sentPlayers: [], totalPoints: null, starterPoints: null, pointsCoverage: "unavailable" });
        return sidesById.get(teamId);
      };
      let flowedPlayers = 0;
      for (const item of transactionItems) {
        const fromTeamId = transactionTeamId(item.fromTeamId ?? item.from?.teamId ?? item.from?.id ?? transaction.fromTeamId ?? transaction.from?.teamId);
        const toTeamId = transactionTeamId(item.toTeamId ?? item.to?.teamId ?? item.to?.id ?? item.forTeamId ?? item.for?.teamId ?? item.for?.id ?? transaction.toTeamId ?? transaction.to?.teamId);
        const playerId = transactionPlayerId(item);
        const player = transactionPlayerName(item, names);
        if (fromTeamId === null || toTeamId === null || (playerId === null && !player)) continue;
        flowedPlayers++;
        const playerRow = { playerId, name: player || (playerId !== null ? `Player #${playerId}` : "Player unavailable"), player: player || (playerId !== null ? `Player #${playerId}` : "Player unavailable"), position: playerPosition(item) || null };
        const destination = ensureSide(toTeamId);
        const source = ensureSide(fromTeamId);
        if (destination && !destination.players.some((row) => row.playerId === playerId && row.name === playerRow.name)) destination.players.push(playerRow);
        if (source && !source.sentPlayers.some((row) => row.playerId === playerId && row.name === playerRow.name)) source.sentPlayers.push(playerRow);
      }
      // Some ESPN payloads put participant IDs on the transaction itself. They
      // are only labels after at least one explicit player flow is verified.
      if (flowedPlayers) for (const team of Array.isArray(transaction.teams) ? transaction.teams : []) ensureSide(transactionTeamId(team));
      const sides = [...sidesById.values()].sort((a, b) => (a.teamId ?? 999) - (b.teamId ?? 999));
      if (flowedPlayers && sides.length >= 2 && sides.some((side) => side.players.length)) trades.push({ id: transactionId, status: "Completed", date, completedAt: date, scoringPeriodId, sides });
      continue;
    }

    const fallbackTeamId = itemTeamId(transaction, {}, "to");
    const normalizedItems = transactionItems.length ? transactionItems : [transaction];
    for (let itemIndex = 0; itemIndex < normalizedItems.length; itemIndex++) {
      const item = normalizedItems[itemIndex] || {};
      const itemType = transactionType(transaction, item);
      if (!["ADD", "DROP", "WAIVER"].includes(itemType)) continue;
      const playerId = transactionPlayerId(item);
      const player = transactionPlayerName(item, names);
      if (playerId === null && !player) continue;
      const teamId = itemTeamId(transaction, item, "to") ?? fallbackTeamId;
      const team = teamForId(teamId, teamsById);
      const eventKey = `${transactionId}:${itemType}:${playerId ?? player}:${teamId ?? "unknown"}`;
      if (seen.has(eventKey)) continue;
      seen.add(eventKey);
      items.push({
        id: eventKey,
        kind: itemType,
        type: itemType,
        playerId,
        player: player || (playerId !== null ? `Player #${playerId}` : "Player unavailable"),
        position: playerPosition(item) || null,
        ...team,
        date,
        completedAt: date,
        scoringPeriodId,
        faab: ["ADD", "WAIVER"].includes(itemType) ? faabAmount(transaction, item) : null,
      });
    }
  }
  items.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || a.id.localeCompare(b.id));
  trades.sort((a, b) => String(b.date || "").localeCompare(String(a.date || "")) || a.id.localeCompare(b.id));
  return { version: TRANSACTION_FEATURE_VERSION, items, trades, acceptedCount, excludedCount };
}

/**
 * Attribute observed FINAL roster points only after the first full scoring
 * period following a pickup/waiver. A drop ends the interval before its period
 * so we never claim points earned after the player left the roster.
 */
export function buildPickupLeaderboard({ items = [], trades = [], rosters = [], completedWeeks = [] } = {}) {
  const finals = new Set(completedWeeks.map(Number));
  const rows = new Map();
  const pickups = items.filter((item) => ["ADD", "WAIVER"].includes(item.kind) && item.playerId !== null && item.teamId !== null).map((item, index) => ({ ...item, _order: index }));
  const drops = items.filter((item) => item.kind === "DROP" && item.playerId !== null && item.teamId !== null).map((item, index) => ({ ...item, _order: index }));
  for (const [tradeIndex, trade] of trades.entries()) for (const side of trade.sides || []) for (const player of side.sentPlayers || []) {
    drops.push({ ...player, kind: "DROP", teamId: side.teamId, scoringPeriodId: trade.scoringPeriodId, date: trade.date, _order: tradeIndex });
  }
  const occursAfter = (later, earlier) => {
    const laterPeriod = integer(later.scoringPeriodId);
    const earlierPeriod = integer(earlier.scoringPeriodId);
    if (laterPeriod === null || earlierPeriod === null) return false;
    if (laterPeriod !== earlierPeriod) return laterPeriod > earlierPeriod;
    const laterDate = later.date ? new Date(later.date).getTime() : NaN;
    const earlierDate = earlier.date ? new Date(earlier.date).getTime() : NaN;
    if (Number.isFinite(laterDate) && Number.isFinite(earlierDate)) return laterDate > earlierDate;
    return Number(later._order ?? 0) < Number(earlier._order ?? 0);
  };
  const seenAcquisitions = new Set();
  for (const pickup of pickups) {
    if (seenAcquisitions.has(pickup.id)) continue;
    seenAcquisitions.add(pickup.id);
    const period = integer(pickup.scoringPeriodId);
    if (period === null) continue;
    const laterAcquisition = pickups.filter((candidate) => candidate !== pickup && Number(candidate.teamId) === Number(pickup.teamId) && Number(candidate.playerId) === Number(pickup.playerId) && occursAfter(candidate, pickup));
    const endCandidates = [...drops.filter((drop) => Number(drop.teamId) === Number(pickup.teamId) && Number(drop.playerId) === Number(pickup.playerId) && occursAfter(drop, pickup)), ...laterAcquisition];
    const end = endCandidates.sort((a, b) => Number(a.scoringPeriodId) - Number(b.scoringPeriodId) || String(a.date || "").localeCompare(String(b.date || "")))[0];
    const expectedWeeks = [...finals].filter((week) => week > period && (!end || week < Number(end.scoringPeriodId))).sort((a, b) => a - b);
    const eligibleWeeks = rosters.filter((roster) => {
      const week = Number(roster.week);
      return Number(roster.teamId) === Number(pickup.teamId) && finals.has(week) && week > period && (!end || week < Number(end.scoringPeriodId));
    }).sort((a, b) => Number(a.week) - Number(b.week));
    const seenRosterWeeks = new Set();
    let totalPoints = 0;
    let starterPoints = 0;
    let scoredPeriods = 0;
    for (const roster of eligibleWeeks) {
      const rosterWeekKey = `${pickup.teamId}:${roster.week}`;
      if (seenRosterWeeks.has(rosterWeekKey)) continue;
      seenRosterWeeks.add(rosterWeekKey);
      const player = (roster.players || []).find((candidate) => Number(candidate.playerId) === Number(pickup.playerId));
      if (!player || player.points === null || player.points === undefined || !Number.isFinite(Number(player.points))) continue;
      const points = Number(player.points);
      totalPoints += points;
      if (player.status === "STARTER") starterPoints += points;
      scoredPeriods++;
    }
    if (!scoredPeriods) continue;
    const key = `${pickup.teamId}:${pickup.playerId}`;
    const existing = rows.get(key);
    const row = existing || { id: `pickup:${pickup.teamId}:${pickup.playerId}`, playerId: pickup.playerId, player: pickup.player, teamId: pickup.teamId, team: pickup.team, manager: pickup.manager, ownerId: pickup.ownerId, faab: pickup.faab, totalPoints: 0, starterPoints: 0, scoredPeriods: 0, coverage: "complete" };
    row.totalPoints = round(row.totalPoints + totalPoints);
    row.starterPoints = round(row.starterPoints + starterPoints);
    row.scoredPeriods += scoredPeriods;
    if (row.player.startsWith("Player #") && pickup.player) row.player = pickup.player;
    if (expectedWeeks.length > scoredPeriods) row.coverage = "partial";
    rows.set(key, row);
  }
  return [...rows.values()].sort((a, b) => b.totalPoints - a.totalPoints || a.player.localeCompare(b.player));
}

/** Add deterministic post-trade production to each receiving side. */
export function addTradeProduction(trades = [], rosters = [], completedWeeks = [], items = []) {
  const finals = new Set(completedWeeks.map(Number));
  const drops = items.filter((item) => item.kind === "DROP" && item.playerId !== null && item.teamId !== null);
  const tradeAcquisitions = [];
  for (const [tradeIndex, trade] of trades.entries()) for (const side of trade.sides || []) for (const player of side.players || []) tradeAcquisitions.push({ ...player, teamId: side.teamId, scoringPeriodId: trade.scoringPeriodId, date: trade.date, _order: tradeIndex, tradeId: trade.id });
  const tradeDrops = [];
  for (const [tradeIndex, trade] of trades.entries()) for (const side of trade.sides || []) for (const player of side.sentPlayers || []) tradeDrops.push({ ...player, teamId: side.teamId, scoringPeriodId: trade.scoringPeriodId, date: trade.date, _order: tradeIndex });
  const occursAfter = (later, earlier) => {
    const laterPeriod = integer(later.scoringPeriodId);
    const earlierPeriod = integer(earlier.scoringPeriodId);
    if (laterPeriod === null || earlierPeriod === null) return false;
    if (laterPeriod !== earlierPeriod) return laterPeriod > earlierPeriod;
    const laterDate = later.date ? new Date(later.date).getTime() : NaN;
    const earlierDate = earlier.date ? new Date(earlier.date).getTime() : NaN;
    if (Number.isFinite(laterDate) && Number.isFinite(earlierDate)) return laterDate > earlierDate;
    return Number(later._order ?? 0) < Number(earlier._order ?? 0);
  };
  return trades.map((trade, tradeIndex) => {
    const period = integer(trade.scoringPeriodId);
    return {
      ...trade,
      sides: (trade.sides || []).map((side) => {
        if (period === null) return { ...side, totalPoints: null, starterPoints: null, pointsCoverage: "unavailable" };
        let total = 0; let starter = 0; let scored = 0; let expected = 0;
        for (const player of side.players || []) {
          const acquisition = { ...player, teamId: side.teamId, scoringPeriodId: period, date: trade.date, _order: tradeIndex, tradeId: trade.id };
          const laterAcquisition = tradeAcquisitions.filter((candidate) => candidate.tradeId !== trade.id && Number(candidate.teamId) === Number(side.teamId) && Number(candidate.playerId) === Number(player.playerId) && occursAfter(candidate, acquisition));
          const endCandidates = [
            ...drops.filter((drop) => Number(drop.teamId) === Number(side.teamId) && Number(drop.playerId) === Number(player.playerId) && occursAfter(drop, acquisition)),
            ...tradeDrops.filter((drop) => Number(drop.teamId) === Number(side.teamId) && Number(drop.playerId) === Number(player.playerId) && occursAfter(drop, acquisition)),
            ...laterAcquisition,
          ];
          const end = endCandidates.sort((a, b) => Number(a.scoringPeriodId) - Number(b.scoringPeriodId) || String(a.date || "").localeCompare(String(b.date || "")))[0];
          const expectedWeeks = [...finals].filter((week) => week > period && (!end || week < Number(end.scoringPeriodId)));
          const weeks = rosters.filter((roster) => Number(roster.teamId) === Number(side.teamId) && finals.has(Number(roster.week)) && Number(roster.week) > period && (!end || Number(roster.week) < Number(end.scoringPeriodId))).sort((a, b) => Number(a.week) - Number(b.week));
          const seenWeeks = new Set();
          expected += expectedWeeks.length;
          for (const roster of weeks) {
            if (seenWeeks.has(Number(roster.week))) continue;
            seenWeeks.add(Number(roster.week));
            const observed = (roster.players || []).find((candidate) => Number(candidate.playerId) === Number(player.playerId));
            if (!observed || observed.points === null || observed.points === undefined || !Number.isFinite(Number(observed.points))) continue;
            const points = Number(observed.points); total += points; if (observed.status === "STARTER") starter += points; scored++;
          }
        }
        return { ...side, totalPoints: scored ? round(total) : null, starterPoints: scored ? round(starter) : null, pointsCoverage: !scored ? "unavailable" : scored < expected ? "partial" : "complete" };
      }),
    };
  });
}

export function isFinalMatchup(matchup = {}) {
  const status = matchup.status || {};
  const type = typeof status === "string" ? status : (status.type || status);
  const id = String(type.id || status.id || matchup.statusId || (typeof status === "string" ? status : "")).toUpperCase();
  const label = String(type.name || type.abbreviation || status.displayName || (typeof status === "string" ? status : "")).toUpperCase();
  if (status.isFinal === true || type.isFinal === true || matchup.isFinal === true) return true;
  if (/FINAL|COMPLETE|COMPLETED/.test(`${id} ${label}`) && !/POSTPONED|CANCEL/.test(`${id} ${label}`)) return true;
  // ESPN uses a zero score while an in-progress/preseason matchup is still
  // undecided.  A nonzero result may be treated as final only when the feed
  // explicitly says the scoring period has closed.
  return false;
}

export function normalizeMatchupStatus(matchup = {}, currentWeek = 1) {
  if (isFinalMatchup(matchup)) return "FINAL";
  const week = Number(matchup.matchupPeriodId || matchup.week || 0);
  if (week > 0 && week < Number(currentWeek || 1) &&
      number(matchup.home?.totalPoints) !== null && number(matchup.away?.totalPoints) !== null &&
      (Number(matchup.home.totalPoints) !== 0 || Number(matchup.away.totalPoints) !== 0)) return "FINAL";
  if (matchup.home?.totalPoints != null || matchup.away?.totalPoints != null) return "LIVE";
  return "SCHEDULED";
}

const normalizePosition = (value) => {
  const names = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "D/ST" };
  const raw = String(value ?? "").toUpperCase();
  return names[value] || (raw.includes("DEF") ? "D/ST" : raw.includes("DST") ? "D/ST" : raw);
};

export function playerPoints(player = {}, scoringPeriodId) {
  const directScore = player.appliedStatTotal ?? player.playerPoolEntry?.appliedStatTotal;
  if (directScore !== null && directScore !== undefined && directScore !== "") return number(directScore);
  const stats = asArray(player.stats || player.player?.stats || player.playerPoolEntry?.player?.stats);
  const period = Number(scoringPeriodId);
  if (!Number.isFinite(period) || period <= 0) return null;
  const candidates = stats.filter((stat) => Number(stat.scoringPeriodId) === period);
  const stat = candidates.find((entry) => Number(entry.statSourceId) === 0 && Number(entry.statSplitTypeId) === 1);
  return number(stat?.appliedTotal ?? stat?.appliedStats?.total ?? stat?.points) ?? null;
}

export function normalizeRosterEntry(entry = {}, scoringPeriodId) {
  const pool = entry.playerPoolEntry || entry;
  const player = pool.player || entry.player || {};
  const id = Number(entry.playerId ?? pool.playerId ?? player.id);
  const name = player.fullName || [player.firstName, player.lastName].filter(Boolean).join(" ") || `Player #${id}`;
  const eligibleIds = asArray(player.eligibleSlots || pool.eligibleSlots || entry.eligibleSlots).map(Number).filter(Number.isFinite);
  const position = normalizePosition(player.defaultPositionId ?? player.positionId ?? player.position);
  const status = Number(entry.lineupSlotId) === 20 ? "BENCH" : Number(entry.lineupSlotId) === 21 ? "IR" : "STARTER";
  return {
    playerId: id,
    player: name,
    position,
    eligibleSlots: eligibleIds,
    lineupSlotId: Number(entry.lineupSlotId ?? -1),
    status,
    points: playerPoints(entry, scoringPeriodId) ?? playerPoints(player, scoringPeriodId),
  };
}

const eligibleForSlot = (player, slot) => {
  if (player.status === "IR") return false;
  const slotId = Number(slot);
  const eligible = Array.isArray(player.eligibleSlots) ? player.eligibleSlots.map(Number) : [];
  if (eligible.length) {
    if (eligible.includes(slotId)) return true;
    return false;
  }
  return false;
};

export function rosterSlots(raw = {}) {
  const settings = raw.settings?.rosterSettings || raw.rosterSettings || raw;
  const counts = settings.lineupSlotCounts || settings.slotCounts || {};
  const slots = [];
  for (const [slot, count] of Object.entries(counts)) for (let i = 0; i < Number(count || 0); i++) slots.push(Number(slot));
  if (slots.length) return slots.filter((slot) => ![20, 21].includes(slot));
  return [];
}

export function optimizeLineup(players = [], slots = []) {
  if (players.some((player) => player.status !== "IR" && player.points === null)) return { points: 0, assignments: [], valid: false };
  const usable = players.filter((player) => Number.isFinite(Number(player.points)) && player.points !== null);
  let best = { points: 0, assignments: [], valid: false };
  if (!slots.length) return best;
  const orderedSlots = [...slots].sort((a, b) => Number([3, 5, 23, 24].includes(Number(a))) - Number([3, 5, 23, 24].includes(Number(b))));
  const visit = (index, used, assignments, points) => {
    if (index === orderedSlots.length) {
      if (assignments.length === orderedSlots.length && (!best.valid || points > best.points)) best = { points: round(points), assignments: assignments.slice(), valid: true };
      return;
    }
    const slot = orderedSlots[index];
    for (let p = 0; p < usable.length; p++) {
      if (used.has(p) || !eligibleForSlot(usable[p], slot)) continue;
      used.add(p); assignments.push({ slot, playerId: usable[p].playerId, player: usable[p].player, points: usable[p].points });
      visit(index + 1, used, assignments, points + Number(usable[p].points));
      assignments.pop(); used.delete(p);
    }
    // Allow an unfilled position.  This is important for incomplete/preseason
    // rosters and prevents an unavailable score from becoming artificial zero.
    visit(index + 1, used, assignments, points);
  };
  visit(0, new Set(), [], 0);
  return best;
}

export function allPlayLuck(matchups = [], teamIds = []) {
  const rows = new Map(teamIds.map((id) => [id, { teamId: id, allPlayWins: 0, allPlayLosses: 0, allPlayTies: 0, weeks: 0 }]));
  for (const matchup of matchups.filter((m) => m.status === "FINAL")) {
    const scores = [{ id: matchup.homeId ?? matchup.a, score: number(matchup.homeScore ?? matchup.as) }, { id: matchup.awayId ?? matchup.b, score: number(matchup.awayScore ?? matchup.bs) }];
    if (scores.some((entry) => !rows.has(entry.id) || entry.score === null)) continue;
    const allScores = [...matchups.filter((m) => m.status === "FINAL" && Number(m.week) === Number(matchup.week)).flatMap((m) => [number(m.homeScore ?? m.as), number(m.awayScore ?? m.bs)])].filter((score) => score !== null);
    for (const item of scores) {
      const row = rows.get(item.id); const better = allScores.filter((score) => score < item.score).length; const worse = allScores.filter((score) => score > item.score).length;
      row.allPlayWins += better; row.allPlayLosses += worse; row.allPlayTies += allScores.length - better - worse - 1; row.weeks++;
    }
  }
  return [...rows.values()].map((row) => ({ ...row, allPlayPct: row.allPlayWins + row.allPlayLosses + row.allPlayTies ? round((row.allPlayWins + row.allPlayTies * 0.5) / (row.allPlayWins + row.allPlayLosses + row.allPlayTies)) : null }));
}

export function buildAdvancedFeatures({ matchups = [], teams = [], rosters = [], drafts = [], currentWeek = 1 } = {}) {
  const completed = matchups.filter((m) => (m.status || normalizeMatchupStatus(m, currentWeek)) === "FINAL");
  const teamIds = teams.map((team) => team.teamId ?? team.ownerId ?? team.id);
  const allPlay = allPlayLuck(completed, teamIds);
  const rivalryMap = new Map();
  for (const matchup of completed) {
    const key = [matchup.homeId ?? matchup.a, matchup.awayId ?? matchup.b].sort().join(":");
    const row = rivalryMap.get(key) || { teamIds: key.split(":"), games: 0, margin: 0, wins: 0, ties: 0 };
    row.games++; row.margin += Math.abs(Number(matchup.homeScore ?? matchup.as ?? 0) - Number(matchup.awayScore ?? matchup.bs ?? 0));
    if (Number(matchup.homeScore ?? matchup.as) === Number(matchup.awayScore ?? matchup.bs)) row.ties++;
    else row.wins += 1;
    rivalryMap.set(key, row);
  }
  const trends = teams.map((team) => {
    const id = team.teamId ?? team.ownerId ?? team.id;
    const scores = completed.flatMap((m) => (m.homeId ?? m.a) === id ? [Number(m.homeScore ?? m.as)] : (m.awayId ?? m.b) === id ? [Number(m.awayScore ?? m.bs)] : []).filter(Number.isFinite);
    const recent = scores.slice(-3); const average = scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null; const recentAverage = recent.length ? recent.reduce((a, b) => a + b, 0) / recent.length : null;
    return { teamId: id, games: scores.length, average: average === null ? null : round(average), recentAverage: recentAverage === null ? null : round(recentAverage), delta: average === null || recentAverage === null ? null : round(recentAverage - average), state: recent.length < 2 ? "UNAVAILABLE" : recentAverage > average + 5 ? "HOT" : recentAverage < average - 5 ? "COLD" : "STEADY" };
  });
  const finalizedWeeks = new Set(completed.map((m) => Number(m.week)));
  const lineupRegret = rosters.filter((row) => finalizedWeeks.has(Number(row.week))).map((row) => { const starters = row.players.filter((p) => p.status === "STARTER"); const actualAvailable = starters.length > 0 && starters.every((p) => number(p.points) !== null); const actual = actualAvailable ? starters.reduce((sum, p) => sum + Number(p.points), 0) : null; const optimal = actualAvailable ? optimizeLineup(row.players, row.slots || []) : { valid: false, points: 0, assignments: [] }; return { teamId: row.teamId, week: row.week, actual: actual === null ? null : round(actual), optimal: optimal.valid ? optimal.points : null, regret: optimal.valid && actual !== null ? round(optimal.points - actual) : null, assignments: optimal.assignments, available: optimal.valid && actualAvailable }; });
  const draftReport = drafts.map((pick) => ({ ...pick, performance: number(pick.seasonPoints ?? pick.points ?? pick.totalPoints), performanceStatus: number(pick.seasonPoints ?? pick.points ?? pick.totalPoints) === null ? "UNAVAILABLE" : "AVAILABLE" }));
  const weeks = [...new Set(completed.map((m) => Number(m.week)).filter(Number.isFinite))].sort((a, b) => a - b);
  const awards = weeks.map((week) => {
    const weekly = completed.filter((m) => Number(m.week) === week);
    const scores = weekly.flatMap((m) => [{ teamId: m.homeId ?? m.a, score: number(m.homeScore ?? m.as) }, { teamId: m.awayId ?? m.b, score: number(m.awayScore ?? m.bs) }]).filter((row) => row.score !== null);
    const largest = weekly.map((m) => ({ teamIds: [m.homeId ?? m.a, m.awayId ?? m.b], margin: round(Math.abs(Number(m.homeScore ?? m.as) - Number(m.awayScore ?? m.bs))) })).sort((a, b) => b.margin - a.margin)[0] || null;
    const playerRows = rosters.filter((row) => Number(row.week) === week).flatMap((row) => row.players.map((player) => ({ ...player, teamId: row.teamId }))).filter((player) => number(player.points) !== null).sort((a, b) => b.points - a.points);
    return { week, highestTeamScore: scores.sort((a, b) => b.score - a.score)[0] || null, largestMargin: largest, topPlayer: playerRows[0] ? { teamId: playerRows[0].teamId, playerId: playerRows[0].playerId, player: playerRows[0].player, points: playerRows[0].points } : null, available: scores.length > 0 };
  });
  return { version: FEATURE_VERSION, available: completed.length > 0, unavailableReason: completed.length ? null : "No completed ESPN matchups yet", awards, allPlayLuck: allPlay, rivalrySpotlight: [...rivalryMap.values()].sort((a, b) => b.games - a.games || b.margin - a.margin), trends, lineupRegret, draftReport };
}
