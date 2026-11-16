const { changeCatalog } = require('./catalog.cjs');
const { registerPlayer, designateCaptain, addTeamPlayer, completeTeamRoster } = require('./registration.js');
const { submitLineup } = require('./model.js');

const scenario = 'six-team-seeded-board';
const demoExists = state => state.events.some(event => event.simulation === scenario);

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

module.exports = { createSeededDemo, demoExists };
