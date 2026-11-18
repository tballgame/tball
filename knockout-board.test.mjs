import assert from 'node:assert/strict';
import test from 'node:test';
import catalog from './catalog.cjs';
import demo from './seeded-demo.cjs';
import invitational from './invitational-demo.cjs';
import stages from './stages.cjs';
import { knockoutBoard, knockoutGroups } from './knockout-board.mjs';

const owner = { uid: 'organizer', organizer: true };
const visitor = { organizer: false };
const today = '2026-11-16';

test('the invitational plays five doubles with all 60 people and ranks each group separately before crossovers', () => {
  const state = { members: [{ id: 'existing-member' }], events: [], nextEventNumber: 1 };
  const previousId = demo.createSeededDemo(state, owner, today);
  const original = structuredClone(state);
  assert.throws(() => invitational.createInvitationalDemo(state, visitor, today), /僅限大會/);
  assert.deepEqual(state, original);
  const id = invitational.createInvitationalDemo(state, owner, today);
  const entry = state.events.find(event => event.id === id);
  assert.deepEqual(state.events.find(event => event.id === previousId), original.events[0]);
  assert.deepEqual(state.members, original.members);
  assert.equal(entry.event.players.length, 60);
  assert.equal(entry.event.matchFormat, '22222');
  assert.ok(entry.event.teams.every(team => team.playerIds.length === 10 && team.rosterComplete));
  assert.deepEqual(entry.event.teams.map(team => team.playerIds.map(id =>
    entry.event.players.find(player => player.id === id).name)), invitational.rosters);
  assert.deepEqual(entry.tournament.stages.map(stage => stages.stageFixtures(entry.tournament, stage).length), [15, 6, 2, 2]);
  const firstRanking = stages.stageRankings(entry.tournament, entry.tournament.stages[0])[0].rows;
  const ranks = new Map(firstRanking.map((team, index) => [team.id, index + 1]));
  assert.deepEqual(entry.tournament.stages[1].groups.map(group => group.map(id => ranks.get(id))),
    [[1, 4, 5], [2, 3, 6]]);
  const [a, b] = stages.stageRankings(entry.tournament, entry.tournament.stages[1]);
  assert.ok([a, b].every(group => group.finished === 3 && group.rows.every(row => row.won + row.lost === 2)));
  assert.deepEqual(stages.stageFixtures(entry.tournament, entry.tournament.stages[2]).map(match => match.teams),
    [[a.rows[0].id, b.rows[1].id], [b.rows[0].id, a.rows[1].id]]);
  for (const match of entry.tournament.fixtures) {
    assert.equal(match.points.length, 5);
    assert.ok(match.points.every(point => point.format === 2 && point.result.status === 'confirmed'));
    for (const id of match.teams) {
      const selected = match.lineups[id].flat();
      const roster = entry.event.teams.find(team => team.id === id).playerIds;
      assert.equal(selected.length, 10);
      assert.equal(new Set(selected).size, 10);
      assert.ok(selected.every(player => roster.includes(player)));
      const players = new Map(entry.event.players.map(player => [player.id, player]));
      assert.deepEqual(match.lineups[id].map(pair => pair.map(player => players.get(player).grade)),
        [[1, 3], [7, 9], [4, 6], [2, 5], [8, 10]]);
    }
  }
  const view = catalog.catalogView(state, visitor, id);
  assert.equal(view.placements.length, 4);
  assert.equal(view.archived, false);
  assert.equal(view.simulationNotes.length, 6);
  const organizerView = catalog.catalogView(state, owner, id);
  assert.deepEqual(organizerView.matchups[0].points[0].sides[0], ['王德山（1 級）', '蘇木斌（3 級）']);
  assert.equal(organizerView.registeredPlayers[0].grade, 1);
  assert.equal(knockoutGroups(view.stages, view.matchups)[0].rounds.length, 2);
  const snapshot = structuredClone(state);
  assert.equal(invitational.createInvitationalDemo(state, owner, today), id);
  assert.deepEqual(state, snapshot);
  assert.throws(() => invitational.reverseInvitationalResults(state, visitor, id, today), /僅限大會/);
  invitational.reverseInvitationalResults(state, owner, id, today);
  const reversed = catalog.catalogView(state, owner, id);
  assert.deepEqual(reversed.placements.map(row => row.name), ['B 隊', 'E 隊', 'A 隊', 'C 隊']);
  assert.equal(reversed.matchups.length, 25);
  assert.ok(reversed.matchups.every(match => match.summary.complete));
  const reversedEntry = state.events.find(event => event.id === id);
  assert.deepEqual(reversedEntry.event, entry.event);
  assert.deepEqual(reversedEntry.tournament.fixtures.slice(0, 21), entry.tournament.fixtures.slice(0, 21));
  for (const match of reversedEntry.tournament.fixtures.slice(21)) {
    for (const side of match.teams) {
      const roster = new Map(reversedEntry.event.players.map(player => [player.id, player.grade]));
      assert.deepEqual(match.lineups[side].map(pair => pair.map(id => roster.get(id))), invitational.gradePairs);
    }
  }
  const retried = structuredClone(state);
  invitational.reverseInvitationalResults(state, owner, id, today);
  assert.deepEqual(state, retried);
});

test('seeded demo stops after the two first-round matches and preserves its state if retried', () => {
  const state = { members: [], events: [], nextEventNumber: 1 };
  assert.throws(() => demo.createSeededDemo(state, visitor, today), /僅限大會/);
  const id = demo.createSeededDemo(state, owner, today);
  assert.equal(demo.createSeededDemo(state, owner, today), id);
  assert.equal(state.members.length, 0);
  assert.equal(state.events.length, 1);
  assert.equal(state.events[0].event.players.length, 24);
  assert.ok(state.events[0].event.teams.every(team => team.rosterComplete && team.playerIds.length === 4));
  const view = catalog.catalogView(state, visitor, id);
  assert.equal(view.archived, false);
  assert.deepEqual(view.stages.map(stage => stage.byeTeams), [['t3', 't6']]);
  assert.deepEqual(view.matchups.map(match => [match.teams, match.summary]), [
    [['A 隊', 'B 隊'], { wins: [1, 2], complete: true }],
    [['D 隊', 'E 隊'], { wins: [0, 3], complete: true }]
  ]);
  assert.match(knockoutBoard(view, String), /下一輪.*待大會排定/);

  const act = (action, data) => catalog.changeCatalog(state, owner, { action, eventId: id, ...data }, today);
  act('createStage', { name: '準決賽', mode: 'manual', teams: ['t2', 't3', 't5', 't6'] });
  act('addStageMatch', { stage: 's2', home: 't2', away: 't3' });
  act('addStageMatch', { stage: 's2', home: 't5', away: 't6' });
  const second = catalog.catalogView(state, visitor, id);
  const [{ rounds }] = knockoutGroups(second.stages, second.matchups);
  assert.deepEqual(rounds.map(round => round.cards.map(card => card.teamIds)), [
    [['t1', 't2'], ['t3'], ['t4', 't5'], ['t6']], [['t2', 't3'], ['t5', 't6']]
  ]);
  assert.match(knockoutBoard(second, String), /<path d="M0 [^"]+ H100"/);
  assert.equal(knockoutBoard({ ...second, stages: second.stages.map(stage => ({ ...stage, mode: 'roundRobin' })) }, String), '');

  assert.throws(() => demo.finishSeededRound(state, visitor, id, today), /僅限大會/);
  assert.throws(() => demo.finishSeededRound(state, owner, 'other-event', today), /沒有可模擬/);
  demo.finishSeededRound(state, owner, id, today);
  assert.throws(() => demo.finishSeededRound(state, owner, id, today), /沒有可模擬/);
  const completed = catalog.catalogView(state, owner, id);
  assert.equal(completed.stages.length, 2);
  assert.equal(completed.archived, false);
  assert.deepEqual(completed.matchups.map(match => match.summary.wins), [[1, 2], [0, 3], [1, 2], [2, 1]]);
  assert.ok(completed.matchups.every(match => match.summary.complete));
  assert.deepEqual(completed.medalPlan.pairs, [
    { kind: 'final', teams: ['t3', 't5'] }, { kind: 'third', teams: ['t2', 't6'] }
  ]);
  act('createMedalStage', { name: '冠季賽', ...completed.medalPlan });
  const medals = catalog.catalogView(state, visitor, id);
  const [{ rounds: medalRounds }] = knockoutGroups(medals.stages, medals.matchups);
  assert.deepEqual(medalRounds.at(-1).bronze.map(match => match.teams), [['B 隊', 'F 隊']]);
  const medalColumn = knockoutBoard(medals, String).split('<div class="bracket-round">').at(-1);
  assert.match(medalColumn, /冠季賽.*冠軍賽.*C 隊.*E 隊.*bracket-bronze.*季軍賽.*B 隊.*F 隊/);
  demo.finishSeededRound(state, owner, id, today, true);
  const final = catalog.catalogView(state, visitor, id);
  assert.ok(final.matchups.every(match => match.summary.complete));
  assert.deepEqual(final.placements.map(({ name, rank }) => [name, rank]),
    [['E 隊', 1], ['C 隊', 2], ['B 隊', 3], ['F 隊', 4]]);
});
