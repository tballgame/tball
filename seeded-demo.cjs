const { changeCatalog } = require('./catalog.cjs');
const { registerPlayer, designateCaptain, addTeamPlayer, completeTeamRoster } = require('./registration.js');
const { submitLineup } = require('./model.js');
const { stageFixtures, stagesOf } = require('./stages.cjs');

const scenario = 'six-team-seeded-board';
const demoExists = state => state.events.some(event => event.simulation === scenario);
const semifinalScores = {
  't2,t3': [[3, 2], [1, 3], [2, 3]],
  't5,t6': [[3, 1], [2, 3], [3, 2]]
};
const medalScores = {
  't3,t5': [[3, 2], [1, 3], [2, 3]],
  't2,t6': [[3, 1], [2, 3], [3, 2]]
};

const matchupKey = fixture => fixture.teams.slice().sort().join(',');

function pendingFixtures(entry, medal) {
  if (entry?.simulation !== scenario || entry.archived || !entry.tournament) return [];
  const stages = stagesOf(entry.tournament);
  if (stages.length !== (medal ? 3 : 2)) return [];
  const fixtures = stageFixtures(entry.tournament, stages.at(-1));
  const scores = medal ? medalScores : semifinalScores;
  if (fixtures.length !== 2 || new Set(fixtures.map(matchupKey)).size !== 2 ||
      fixtures.some(fixture => !Object.hasOwn(scores, matchupKey(fixture)) ||
        (medal ? fixture.kind !== (matchupKey(fixture) === 't3,t5' ? 'final' : 'third') :
          (fixture.kind ?? 'regular') !== 'regular') ||
        fixture.points.length !== 3 || fixture.points.some(point => point.format !== 1 ||
          point.result?.status === 'disputed'))) return [];
  return fixtures.filter(fixture => fixture.points.some(point => !point.result));
}

function finishSeededRound(state, actor, eventId, today, medal = false) {
  if (!actor.organizer) throw Error('此操作僅限大會。');
  const entry = state.events.find(item => item.id === eventId);
  const fixtures = pendingFixtures(entry, medal);
  if (!fixtures.length) throw Error('目前沒有可模擬的場次。請重新核對對戰及比分。');
  for (const fixture of fixtures) {
    for (const id of fixture.teams) {
      if (fixture.lineups[id]) continue;
      const team = entry.tournament.teams.find(item => item.id === id);
      submitLineup(entry.tournament, fixture, id, team.players.slice(0, 3).map(player => [player.id]));
    }
    const key = matchupKey(fixture);
    const scores = (medal ? medalScores : semifinalScores)[key];
    for (const [index, score] of scores.entries()) {
      if (fixture.points[index].result) continue;
      const [homeWins, awayWins] = fixture.teams.join(',') === key ? score : [score[1], score[0]];
      changeCatalog(state, actor, { action: 'score', eventId, fixture: fixture.id, point: String(index),
        home: String(homeWins), away: String(awayWins) }, today);
    }
  }
  return eventId;
}

function createSeededDemo(state, actor, today) {
  if (!actor.organizer) throw Error('此操作僅限大會。');
  if (demoExists(state)) return state.events.find(event => event.simulation === scenario).id;

  const eventId = changeCatalog(state, actor, {
    action: 'publish', title: '六隊種子測試賽', signupDeadline: today, teamSize: 4, matchFormat: '111'
  }, today);
  const entry = state.events.find(event => event.id === eventId);
  const act = (action, fields) => changeCatalog(state, actor, { action, eventId, ...fields }, today);
  for (const letter of 'ABCDEF') {
    const roster = Array.from({ length: 4 }, (_, index) => registerPlayer(entry.event, letter + ' 選手 ' + (index + 1), today));
    designateCaptain(entry.event, roster[0].id, letter + ' 隊');
    roster.slice(1).forEach(player => addTeamPlayer(entry.event, roster[0].id, player.id));
    completeTeamRoster(entry.event, roster[0].id);
  }
  act('close');
  act('lock', { schedule: 'manual', singleMatch: true });
  const [a, b, c, d, e, f] = entry.tournament.teams;
  const first = entry.tournament.stages[0];
  first.byeTeams = [c.id, f.id];
  for (const [home, away, scores] of [
    [a, b, [['1', '3'], ['3', '2'], ['2', '3']]],
    [d, e, [['0', '3'], ['1', '3'], ['2', '3']]]
  ]) {
    act('addStageMatch', { stage: first.id, home: home.id, away: away.id });
    const fixture = entry.tournament.fixtures.at(-1);
    for (const team of [home, away]) {
      submitLineup(entry.tournament, fixture, team.id, team.players.slice(0, 3).map(player => [player.id]));
    }
    for (const [index, [homeWins, awayWins]] of scores.entries()) {
      act('score', { fixture: fixture.id, point: String(index), home: homeWins, away: awayWins });
    }
  }
  entry.simulation = scenario;
  return eventId;
}

module.exports = { createSeededDemo, demoExists, finishSeededRound, pendingFixtures };
