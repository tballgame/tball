const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const test = require('node:test');

const source = ['model.js', 'registration.js'].map(file => fs.readFileSync(path.join(__dirname, file), 'utf8')).join('\n');
const model = vm.runInNewContext(source +
  '\n({ createTournament, submitLineup, pointSides, propose, reply, submitScore, confirmScore, standings,' +
  'createRegistration, registerPlayer, closeRegistration, designateCaptain, addTeamPlayer, leaveTeam,' +
  'allowRejoin, lockRegistration, findPlayerTeam })');

test('registration, captain assignment, voluntary departure, rejoin consent, and fixture generation', () => {
  const event = model.createRegistration('試跑', '2026-12-01', '2026-12-31', 2);
  assert.throws(() => model.registerPlayer(event, '逾期選手', '2026-12-02'));
  assert.throws(() => model.closeRegistration(event));
  const [a, b, c, d, spare] = ['甲', '乙', '丙', '丁', '戊'].map(name =>
    model.registerPlayer(event, name, '2026-12-01').id);
  model.closeRegistration(event);
  assert.throws(() => model.registerPlayer(event, '停止報名後', '2026-12-01'));
  model.designateCaptain(event, a, '松風隊');
  model.designateCaptain(event, c, '海潮隊');
  assert.throws(() => model.addTeamPlayer(event, b, spare));
  model.addTeamPlayer(event, a, b);
  assert.throws(() => model.addTeamPlayer(event, c, b));
  model.leaveTeam(event, b);
  assert.equal(model.findPlayerTeam(event, b), undefined);
  assert.ok(event.players.some(player => player.id === b));
  assert.throws(() => model.addTeamPlayer(event, a, b));
  model.addTeamPlayer(event, c, b);
  model.leaveTeam(event, b);
  model.allowRejoin(event, b, 't1');
  model.addTeamPlayer(event, a, b);
  assert.throws(() => model.lockRegistration(event, true));
  model.addTeamPlayer(event, c, d);
  assert.throws(() => model.lockRegistration(event, false));
  model.addTeamPlayer(event, a, spare);
  const tournament = model.lockRegistration(event, false);
  assert.equal(tournament.fixtures.length, 1);
  assert.equal(tournament.teams[0].captainId, a);
  assert.equal(tournament.teams[0].players[1].id, b);
  assert.equal(tournament.teams[0].players[2].id, spare);
  assert.throws(() => model.leaveTeam(event, b));
  model.submitLineup(tournament, tournament.fixtures[0], 't1', [[a], [a, b], [b]]);
});

test('three teams, separate dates by point, and opponent confirmation before standings update', () => {
  const teams = ['a', 'b', 'c'].map(id => ({
    id, name: id, players: [1, 2].map(n => ({ id: id + n }))
  }));
  const tournament = model.createTournament('試跑', '2026-12-31', teams, [1, 2, 1]);
  assert.equal(tournament.fixtures.length, 3);
  const fixture = tournament.fixtures[0];
  model.submitLineup(tournament, fixture, 'a', [['a1'], ['a1', 'a2'], ['a2']]);
  assert.throws(() => model.submitLineup(tournament, fixture, 'b', [['b1'], ['b1', 'b1'], ['b2']]));
  model.submitLineup(tournament, fixture, 'b', [['b1'], ['b1', 'b2'], ['b2']]);
  fixture.points.forEach((point, index) => {
    const sides = model.pointSides(fixture, index);
    const players = sides.flat();
    const date = '2026-12-0' + (index + 1) + 'T12:00';
    assert.throws(() => model.propose(tournament, point, players, 'c1', date, '球館'));
    model.propose(tournament, point, players, players[0], date, '球館');
    assert.throws(() => model.submitScore(point, sides, players[0], [3, 1]));
    players.slice(1).forEach(player => model.reply(point, players, player, 'yes'));
    model.submitScore(point, sides, players[0], [3, 1]);
    assert.throws(() => model.confirmScore(point, sides, players[0], true));
    assert.equal(model.standings(tournament)[0].won, 0);
    model.confirmScore(point, sides, sides[1][0], true);
    assert.equal(point.appointment.date, date);
  });
  assert.equal(model.standings(tournament)[0].won, 1);
  assert.equal(model.standings(tournament)[0].points, 3);
});
