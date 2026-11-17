import assert from 'node:assert/strict';
import test from 'node:test';
import catalog from './catalog.cjs';
import demo from './seeded-demo.cjs';
import { knockoutBoard, knockoutGroups } from './knockout-board.mjs';

const owner = { uid: 'organizer', organizer: true };
const visitor = { organizer: false };
const today = '2026-11-16';

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
