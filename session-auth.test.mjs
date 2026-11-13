import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { prepareAccounts, createSession, sessionIdentity, deleteSession, hash, normalizeCode } from './session-auth.mjs';
import { createRequire } from 'node:module';
import { onRequestPost } from './functions/api/account.js';
import { onRequestPost as registrationRequest } from './functions/api/registration.js';
import { clubAvailability } from './club-access.mjs';
import { prepareSimulation } from './simulation.mjs';
const require = createRequire(import.meta.url);
const { catalogView, changeCatalog } = require('./catalog.cjs');

function database() {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec('CREATE TABLE registration_state(id INTEGER PRIMARY KEY,state TEXT,revision INTEGER)');
  const db = {
    prepare(sql) {
      let values = [];
      const query = {
        bind(...args) { values = args; return query; },
        async first() { return sqlite.prepare(sql).get(...values) ?? null; },
        async run() {
          const result = sqlite.prepare(sql).run(...values);
          return { meta: { changes: Number(result.changes) } };
        }
      };
      return query;
    },
    async batch(queries) {
      sqlite.exec('BEGIN');
      try {
        const results = [];
        for (const query of queries) results.push(await query.run());
        sqlite.exec('COMMIT');
        return results;
      } catch (error) {
        sqlite.exec('ROLLBACK');
        throw error;
      }
    }
  };
  return { db, sqlite };
}

test('15-team simulation supports group stages, qualification, repeated pairings and archive', async () => {
  const { db, sqlite } = database();
  const owner = { uid: 'owner-uid', organizer: true };
  const state = { members: [], events: [], nextEventNumber: 1 };
  const today = '2026-11-12';
  await assert.rejects(prepareSimulation(state, { uid: 'member' }, today), /僅限大會/);
  const eventId = await prepareSimulation(state, owner, today);
  assert.equal(await prepareSimulation(state, owner, today), eventId);
  assert.equal(state.members.length, 105);
  const act = (action, data = {}, actor = owner) => changeCatalog(state, actor, { action, eventId, ...data }, today);
  const view = (actor = owner) => catalogView(state, actor, eventId);
  const entry = state.events[0];
  assert.equal(entry.event.players.length, 105);
  assert.deepEqual(entry.event.groups.map(group => group.length), [5, 5, 5]);
  assert.ok(entry.event.teams.every(team => team.playerIds.length === 7 && team.rosterComplete));
  assert.equal(view().fixturePreview.length, 30);
  assert.throws(() => act('saveGroups', { groups: [['t1', 't2'], ['t2', 't3']] }), /組別/);
  sqlite.prepare('INSERT INTO registration_state VALUES(1,?,0)').run(JSON.stringify(state));
  await prepareAccounts(db, owner.uid);
  assert.equal(sqlite.prepare("SELECT count(*) AS count FROM login_accounts WHERE member_id LIKE 'simulation-%'").get().count, 105);
  assert.ok(sqlite.prepare('SELECT member_id FROM login_accounts WHERE code_hash=?').get(await hash('sim135')));
  act('lock');
  assert.equal(view().matchups.length, 30);
  assert.deepEqual(view().stages[0].rankings.map(rank => [rank.name, rank.total]), [['A 組', 10], ['B 組', 10], ['C 組', 10]]);
  const finish = matches => matches.forEach(match => match.points.forEach(point => {
    point.result = { status: 'confirmed', score: [3, 1] };
  }));
  const selection = { name: '複賽', mode: 'roundRobin', selection: 'rank', source: 's1', top: '2' };
  assert.throws(() => act('createStage', selection), /先完成/);
  finish(entry.tournament.fixtures);
  assert.throws(() => act('createStage', selection, { uid: 'member', organizer: false }), /僅限大會/);
  act('createStage', selection);
  assert.deepEqual(view().stages[1].groups, [['t1', 't2', 't6', 't7', 't11', 't12']]);
  assert.throws(() => act('archive'), /先登錄/);
  act('generateStage', { stage: 's2', groups: [['t1', 't2', 't6', 't7', 't11', 't12']] });
  assert.equal(view().stages[1].matchCount, 15);
  assert.equal(view().matchups.find(match => match.id === 's2-t1-t2').canRemove, false);
  assert.ok(entry.tournament.fixtures.some(match => match.id === 't1-t2'));
  assert.ok(entry.tournament.fixtures.some(match => match.id === 's2-t1-t2'));
  assert.throws(() => act('addStageMatch', { stage: 's2', home: 't2', away: 't1' }), /系統配對/);
  assert.throws(() => act('removeStageMatch', { stage: 's2', fixture: 's2-t1-t2' }), /系統配對/);
  finish(entry.tournament.fixtures.filter(match => match.stageId === 's2'));
  act('createStage', { name: '決賽', mode: 'manual', selection: 'rank', source: 's2', top: '4' });
  act('addStageMatch', { stage: 's3', home: 't1', away: 't2', kind: 'final' });
  act('addStageMatch', { stage: 's3', home: 't6', away: 't7', kind: 'third' });
  finish(entry.tournament.fixtures.filter(match => match.stageId === 's3'));
  assert.deepEqual(view().placements.map(item => item.rank), [1, 2, 3, 4]);
  act('archive');
  assert.equal(catalogView(state, owner).events[0].leaders[0], '飛燕隊');
  const recorded = structuredClone(entry.tournament);
  const reopen = { action: 'reopenEvent', eventId };
  assert.throws(() => changeCatalog(state, { uid: 'member', organizer: false }, reopen, today), /僅限大會/);
  assert.throws(() => act('createStage', { name: '加賽', teams: ['t1', 't2'] }), /已移入/);
  act('reopenEvent');
  assert.equal(view().archived, false);
  assert.equal(view().event.phase, 'locked');
  assert.deepEqual(entry.tournament, recorded);
  assert.equal(catalogView(state, owner).events[0].archivedOn, null);
  assert.throws(() => act('reopenEvent'), /已完賽/);
  act('createStage', { name: '加賽', mode: 'manual', singleMatch: false, teams: ['t1', 't2', 't3'] });
  act('addStageMatch', { stage: 's4', home: 't1', away: 't2' });
  assert.throws(() => act('addStageMatch', { stage: 's4', home: 't2', away: 't1' }), /已有/);
  act('addStageMatch', { stage: 's4', home: 't1', away: 't3' });
  assert.equal(view().matchups.length, recorded.fixtures.length + 2);
});

test('six-team simulation ends at confirmed rosters and supports a manual first round with byes', async () => {
  const owner = { uid: 'owner-uid', organizer: true };
  const today = '2026-11-13';
  const state = { members: [], events: [], nextEventNumber: 1 };
  await prepareSimulation(state, owner, today);
  const eventId = await prepareSimulation(state, owner, today, 'six-team-knockout');
  assert.equal(await prepareSimulation(state, owner, today, 'six-team-knockout'), eventId);
  assert.equal(state.members.length, 105);
  const view = () => catalogView(state, owner, eventId);
  const act = (action, data = {}) => changeCatalog(state, owner, { action, eventId, ...data }, today);
  assert.equal(view().event.phase, 'grouping');
  assert.equal(view().event.preferredSchedule, 'manual');
  assert.equal(view().event.matchFormat, '111');
  assert.equal(view().registeredPlayers.length, 24);
  assert.equal(view().teams.length, 6);
  assert.ok(view().teams.every(team => team.rosterComplete && team.playerIds.length === 4));
  assert.equal(view().fixturePreview, undefined);
  act('lock', { schedule: 'manual' });
  assert.deepEqual(view().matchups, []);
  assert.equal(view().stages[0].name, '首輪');
  assert.throws(() => act('archive'), /先登錄/);
  act('addStageMatch', { stage: 's1', home: 't1', away: 't2' });
  assert.deepEqual(view().stages[0].scheduledTeams, ['t1', 't2']);
  assert.throws(() => act('addStageMatch', { stage: 's1', home: 't1', away: 't3' }), /每隊最多一場/);
  assert.throws(() => act('generateStage', { stage: 's1', groups: [['t1', 't2', 't3', 't4', 't5', 't6']] }), /逐場配對/);
  act('addStageMatch', { stage: 's1', home: 't4', away: 't5' });
  assert.deepEqual(view().matchups.map(match => match.teams), [['A 隊', 'B 隊'], ['D 隊', 'E 隊']]);
  assert.ok(view().matchups.every(match => match.points.length === 3 && match.points.every(point => point.format === 1)));
  const first = view().matchups[0];
  const second = view().matchups[1];
  const remove = { stage: 's1', fixture: first.id };
  assert.equal(first.canRemove, true);
  act('createStage', { name: '四強', mode: 'manual', teams: ['t2', 't3', 't5', 't6'] });
  assert.throws(() => act('addStageMatch', { stage: 's1', home: 't2', away: 't3' }), /最新階段/);
  assert.throws(() => act('generateStage', { stage: 's1', groups: [['t1', 't2', 't3', 't4', 't5', 't6']] }), /最新階段/);
  assert.equal(view().stages[0].matchCount, 2);
  const team = view().teams[0];
  const captain = state.events.find(entry => entry.id === eventId).event.players.find(player => player.id === team.captainId);
  const role = { uid: captain.uid, organizer: false };
  assert.throws(() => changeCatalog(state, role, { eventId, action: 'removeStageMatch', ...remove }, today), /僅限大會/);
  act('removeStageMatch', remove);
  assert.deepEqual(view().stages[0].scheduledTeams, ['t4', 't5']);
  assert.deepEqual(view().matchups.map(match => match.id), [second.id]);
  act('deleteStage', { stage: 's2' });
  act('addStageMatch', { stage: 's1', home: 't1', away: 't2' });
  changeCatalog(state, role, { eventId, action: 'lineup', fixture: first.id, starters: team.playerIds.slice(0, 3) }, today);
  assert.equal(view().matchups.find(match => match.id === first.id).canRemove, false);
  assert.throws(() => act('removeStageMatch', remove), /已有排點/);
  const entry = state.events.find(item => item.id === eventId);
  act('createStage', { name: '四強', mode: 'manual', teams: ['t2', 't3', 't5', 't6'] });
  act('addStageMatch', { stage: 's2', home: 't2', away: 't3' });
  act('addStageMatch', { stage: 's2', home: 't5', away: 't6' });
  assert.equal(view().medalPlan, null);
  const finish = (matches, score) => matches.forEach(match => match.points.forEach(point => {
    point.result = { status: 'confirmed', score };
  }));
  finish(entry.tournament.fixtures.filter(match => !match.stageId), [1, 3]);
  finish(entry.tournament.fixtures.filter(match => match.id === 's2-t2-t3'), [1, 3]);
  finish(entry.tournament.fixtures.filter(match => match.id === 's2-t5-t6'), [3, 1]);
  const plan = view().medalPlan;
  assert.deepEqual(plan.pairs, [{ kind: 'final', teams: ['t3', 't5'] }, { kind: 'third', teams: ['t2', 't6'] }]);
  assert.throws(() => act('createMedalStage', { ...plan, pairs: [], name: '冠季賽' }), /已更新/);
  const previous = structuredClone(entry.tournament);
  act('createStage', { name: '冠季賽', mode: 'manual', teams: ['t2', 't3', 't5', 't6'] });
  act('addStageMatch', { stage: 's3', home: 't3', away: 't5' });
  act('addStageMatch', { stage: 's3', home: 't2', away: 't6' });
  const finals = entry.tournament.fixtures.filter(match => match.stageId === 's3');
  finish(finals, [3, 1]);
  act('resetMedalSimulation', { stage: 's3', fixtures: finals.map(match => match.id) });
  assert.deepEqual(entry.tournament, previous);
  assert.deepEqual(entry.medalSimulationBackup.fixtures, finals);
  act('createMedalStage', { ...plan, name: '冠季賽' });
  assert.deepEqual(view().stages[2].placements.map(row => row.name), [null, null, null, null]);
  const typed = entry.tournament.fixtures.filter(match => match.stageId === 's3');
  finish(typed.slice(0, 1), [1, 3]);
  assert.deepEqual(view().stages[2].placements.map(row => row.name), ['E 隊', 'C 隊', null, null]);
  finish(typed.slice(1), [3, 1]);
  assert.deepEqual(view().placements.map(row => row.name), ['E 隊', 'C 隊', 'B 隊', 'F 隊']);
  assert.equal(view().stages[2].rankings[0].total, 0);
});

test('existing accounts keep identity, test codes are English, and only the cookie restores a session', async () => {
  const { db, sqlite } = database();
  const original = { members: [
    { id: 'old-uid', name: 'olduser' },
    { id: 'demo-1', name: '測試會員 01', demo: true }
  ], events: [{ id: 'event', event: { title: '原賽事', phase: 'grouping', players: [
    { id: 'p1', uid: 'old-uid', name: '選手甲' },
    { id: 'p2', memberId: 'demo-1', name: '測試會員 01', demo: true }
  ], teams: [{ id: 't1', name: '甲隊', captainId: 'p1', playerIds: ['p1', 'p2'] }] } }] };
  sqlite.prepare('INSERT INTO registration_state VALUES(1,?,0)').run(JSON.stringify(original));
  await prepareAccounts(db, 'owner-uid');
  await prepareAccounts(db, 'owner-uid');
  const state = JSON.parse(sqlite.prepare('SELECT state FROM registration_state').get().state);
  assert.equal(state.members[0].number, 'M0001');
  assert.equal(state.events[0].event.players[0].uid, 'old-uid');
  assert.equal(state.events[0].event.players[0].name, '選手甲');
  assert.equal(state.events[0].event.players[1].uid, 'demo-1');
  assert.equal(state.members[1].name, 'test01');
  assert.equal(state.events[0].event.players[1].name, '測試會員 01');
  assert.equal(sqlite.prepare('SELECT member_id FROM login_accounts WHERE code_hash=?').get(await hash('test01')).member_id, 'demo-1');
  assert.equal(sqlite.prepare('SELECT member_id FROM login_accounts WHERE code_hash=?').get(await hash('icered')).member_id, 'owner-uid');
  assert.equal(JSON.stringify(catalogView(state, { organizer: true })).includes('olduser'), false);
  assert.equal(JSON.stringify(catalogView(state, { organizer: true })).includes('loginHash'), false);
  const cookie = await createSession(db, 'old-uid', 'olduser');
  assert.match(cookie, /HttpOnly; Secure; SameSite=Lax/);
  const request = new Request('https://tball.example/api/registration', { headers: { Cookie: cookie.split(';')[0] } });
  assert.deepEqual(await sessionIdentity(request, db), { uid: 'old-uid', code: 'olduser' });
  assert.equal(await sessionIdentity(new Request('https://tball.example/'), db), null);
  await deleteSession(request, db);
  assert.equal(await sessionIdentity(request, db), null);
  assert.equal(normalizeCode('我的私人代號123'), '我的私人代號123');
});

test('signup requires only a login code, assigns a member number, and restores the session', async () => {
  const { db, sqlite } = database();
  sqlite.prepare('INSERT INTO registration_state VALUES(1,?,0)').run(JSON.stringify({
    members: [{ id: 'old-uid', name: 'olduser' }], events: []
  }));
  const env = { TBALL_DB: db, TBALL_OWNER_UID: 'owner-uid' };
  const call = (data, cookie, origin = 'https://tball.example') => onRequestPost({
    env, request: new Request('https://tball.example/api/account', { method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie.split(';')[0] } : {}) },
      body: JSON.stringify(data) })
  });
  assert.equal((await call({ action: 'login', code: 'olduser' }, null, 'https://untrusted.example')).status, 403);
  const login = await call({ action: 'login', code: 'olduser' });
  assert.equal(login.status, 200);
  assert.equal((await login.json()).user.uid, 'old-uid');
  const cookie = login.headers.get('Set-Cookie');
  assert.equal((await (await call({ action: 'session' }, cookie)).json()).user.code, 'olduser');
  const signup = await call({ action: 'signup', code: '私人代號123' });
  assert.equal(signup.status, 200);
  const newUser = (await signup.json()).user;
  assert.match(newUser.number, /^M\d+$/);
  assert.equal(newUser.name, undefined);
  const state = JSON.parse(sqlite.prepare('SELECT state FROM registration_state').get().state);
  assert.equal(state.members.find(member => member.id === newUser.uid).name, '會員 ' + newUser.number);
  const duplicate = await call({ action: 'signup', code: '私人代號123' });
  assert.equal(duplicate.status, 409);
  assert.match((await duplicate.json()).error, /已被註冊，請改用另一個代號/);
  await call({ action: 'logout' }, cookie);
  assert.equal((await (await call({ action: 'session' }, cookie)).json()).user, null);
});

test('new club starts empty and uses its own organizer credential', async () => {
  const { db, sqlite } = database();
  const ownerHash = await hash('club-private-code');
  await prepareAccounts(db, 'new-club-owner', { legacy: false, ownerHash });
  const state = JSON.parse(sqlite.prepare('SELECT state FROM registration_state').get().state);
  assert.equal(state.members.length, 1);
  assert.equal(state.members[0].id, 'new-club-owner');
  assert.deepEqual(state.events, []);
  assert.ok(sqlite.prepare('SELECT member_id FROM login_accounts WHERE code_hash=?').get(ownerHash));
  assert.equal(sqlite.prepare('SELECT count(*) AS total FROM login_accounts').get().total, 1);
});

test('club authorization uses its Firebase project ID and blocks both APIs when suspended', async t => {
  const payload = (projectId, active) => ({ fields: {
    productId: { stringValue: 'tball' }, projectId: { stringValue: projectId },
    registered: { booleanValue: true }, active: { booleanValue: active }
  } });
  const lookup = async url => {
    assert.match(url, /\/product_registrations\/tball\/tenants\/club-test$/);
    return Response.json(payload('club-test', true));
  };
  assert.equal(await clubAvailability({}, lookup, 'club-test'), null);
  assert.equal((await clubAvailability({}, async () => Response.json(payload('other-club', true)), 'club-test')).status, 403);
  assert.equal((await clubAvailability({}, async () => new Response(null, { status: 500 }), 'club-test')).status, 503);

  const { db } = database();
  const env = { TBALL_DB: db, TBALL_OWNER_UID: 'owner-uid', TBALL_REQUIRE_HQ: 'true' };
  let active = false;
  t.mock.method(globalThis, 'fetch', async () => Response.json(payload('tball-ef787', active)));
  const call = (handler, path, body) => handler({ env, request: new Request('https://tball.example/api/' + path, {
    method: 'POST', headers: { Origin: 'https://tball.example' }, body: JSON.stringify(body)
  }) });
  assert.equal((await call(onRequestPost, 'account', { action: 'signup', code: 'example1' })).status, 403);
  assert.equal((await call(registrationRequest, 'registration', { action: 'view' })).status, 403);
  active = true;
  // Initialize the existing pilot's state for its normal account path.
  await db.prepare('INSERT INTO registration_state VALUES (1, ?, 0)').bind('{"members":[],"events":[]}').run();
  assert.equal((await call(onRequestPost, 'account', { action: 'signup', code: 'example1' })).status, 200);
  assert.equal((await call(registrationRequest, 'registration', { action: 'view' })).status, 200);
});
