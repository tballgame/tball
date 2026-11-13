function createTournament(title, deadline, teams, formats) {
  if (!title.trim() || teams.length < 2 || formats.length % 2 === 0) {
    throw Error('請輸入賽名、至少兩隊與奇數個比賽項目。');
  }
  const fixtures = teams.flatMap((home, index) =>
    teams.slice(index + 1).map(away => ({
      id: home.id + '-' + away.id,
      teams: [home.id, away.id],
      lineups: {},
      points: formats.map(format => ({ format }))
    }))
  );
  return { title, deadline, teams, fixtures };
}

function submitLineup(tournament, fixture, teamId, selections) {
  if (!fixture.teams.includes(teamId) || fixture.teams.every(id => fixture.lineups[id])) {
    throw Error('此場排陣已鎖定或你無權操作。');
  }
  const team = tournament.teams.find(team => team.id === teamId);
  if (selections.length !== fixture.points.length || selections.some((players, index) =>
    players.length !== fixture.points[index].format ||
    new Set(players).size !== players.length ||
    players.some(id => !team.players.some(player => player.id === id))
  )) throw Error('請為每一點選擇完整且不重複的出賽選手。');
  fixture.lineups[teamId] = selections;
}

function pointSides(fixture, index) {
  return fixture.teams.map(teamId => fixture.lineups[teamId]?.[index] || []);
}

function propose(tournament, point, players, player, date, place) {
  if (!players.includes(player) || point.result || !place.trim() ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(date) || (tournament.deadline && date.slice(0, 10) > tournament.deadline)) {
    throw Error('請輸入賽期截止前的時間與地點。');
  }
  point.appointment = { date, place, replies: { [player]: 'yes' } };
}

function reply(point, players, player, answer) {
  if (!players.includes(player) || !point.appointment || point.result || !['yes', 'no'].includes(answer)) {
    throw Error('目前無法回覆。');
  }
  point.appointment.replies[player] = answer;
}

function validateScore(score) {
  if (score.length !== 2 ||
      !score.every(n => Number.isInteger(n) && n >= 0 && n <= 3) ||
      Math.max(...score) !== 3 || score[0] === score[1]) throw Error('請輸入有效的五局三勝局數。');
}

function submitScore(point, sides, player, score, requireAppointment = true) {
  const side = sides.findIndex(players => players.includes(player));
  if (side < 0 || point.result ||
      (requireAppointment && !sides.flat().every(id => point.appointment?.replies[id] === 'yes'))) {
    throw Error('目前無法由此帳號送出比分。');
  }
  validateScore(score);
  point.result = { score, side, player, status: 'pending' };
}

function confirmScore(point, sides, player, accepted) {
  if (point.result?.status !== 'pending' || !sides[1 - point.result.side].includes(player)) {
    throw Error('待對方選手確認。');
  }
  point.result.status = accepted ? 'confirmed' : 'disputed';
}

function fixtureResult(fixture) {
  const wins = [0, 0];
  for (const point of fixture.points) {
    if (point.result?.status === 'confirmed') wins[point.result.score[0] > point.result.score[1] ? 0 : 1]++;
  }
  return { wins, complete: wins[0] + wins[1] === fixture.points.length };
}

function standings(tournament) {
  const rows = tournament.teams.map(team => ({ id: team.id, name: team.name, won: 0, lost: 0, points: 0 }));
  for (const fixture of tournament.fixtures) {
    const { wins: [home, away], complete } = fixtureResult(fixture);
    if (!complete) continue;
    const sides = fixture.teams.map(id => rows.find(row => row.id === id));
    sides[0].points += home;
    sides[1].points += away;
    sides[home > away ? 0 : 1].won++;
    sides[home > away ? 1 : 0].lost++;
  }
  return rows.sort((a, b) => b.won - a.won || b.points - a.points);
}

if (typeof module !== 'undefined') {
  module.exports = { createTournament, submitLineup, pointSides, submitScore, confirmScore, validateScore, fixtureResult, standings };
}
