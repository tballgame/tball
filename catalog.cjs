const domain = require('./cloud-domain.cjs');
const { stagesOf, stageRankings, stageFixtures, medalPlan, placements } = require('./stages.cjs');
const { findPlayerTeam } = require('./registration.js');

function completed(tournament) {
  return Boolean(tournament?.fixtures.length && stagesOf(tournament).every(stage => stageFixtures(tournament, stage).length) &&
    tournament.fixtures.every(fixture =>
    fixture.points.every(point => point.result?.status === 'confirmed')));
}

function migrateCatalog(state) {
  let changed = false;
  if (state.nextEventNumber === undefined) {
    if (!state.events) {
      state.events = [];
      if (state.event) {
        const entry = { id: 'legacy', event: state.event };
        if (state.tournament) entry.tournament = state.tournament;
        if (completed(entry.tournament)) entry.archived = true;
        state.events.push(entry);
        delete state.event;
        delete state.tournament;
      }
    }
    state.events.forEach((entry, index) => { entry.number = index + 1; });
    state.nextEventNumber = state.events.length + 1;
    changed = true;
  }
  for (const entry of state.events) {
    if (!entry.archived && domain.activateSubmittedScores(entry.tournament)) changed = true;
  }
  return changed;
}

function selectedEvent(state, actor, id) {
  const entry = state.events.find(item => item.id === id && (!item.draft || actor.organizer));
  if (!entry) throw Error('找不到這場賽事。');
  return entry;
}

function changeCatalog(state, actor, data, today) {
  if (['publish', 'createDraft', 'publishDraft', 'archive', 'reopenEvent', 'resetMedalSimulation', 'deleteArchivedEvent', 'addMember', 'removeMember'].includes(data.action) && !actor.organizer) {
    throw Error('此操作僅限大會。');
  }
  if (data.action === 'addMember') {
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name || name.length > 40 || state.members.some(member => !member.removed && member.name === name)) {
      throw Error('請輸入 1 至 40 字且未使用的會員名稱。');
    }
    state.members.push({ id: 'manual-' + crypto.randomUUID(), name, manual: true });
    return null;
  }
  if (data.action === 'removeMember') {
    const member = state.members.find(item => item.id === data.memberId && !item.removed);
    if (!member) throw Error('找不到這位會員。');
    member.removed = true;
    return null;
  }
  if (data.action === 'register' && state.members.some(member => member.id === actor.uid && member.removed)) {
    throw Error('此帳號已從會員名冊移除。');
  }
  if (data.action === 'publish' || data.action === 'createDraft') {
    const entry = domain.mutate({ members: state.members }, actor, { ...data, action: 'publish' }, today);
    const id = crypto.randomUUID();
    const draft = data.action === 'createDraft';
    state.events.push({ id, number: state.nextEventNumber++, event: entry.event, draft, openedOn: draft ? null : today });
    return id;
  }
  const entry = selectedEvent(state, actor, data.eventId);
  if (data.action === 'resetMedalSimulation') {
    const tournament = entry.tournament;
    const stages = tournament && stagesOf(tournament);
    const latest = stages?.at(-1);
    if (entry.simulation !== 'six-team-knockout' || entry.event.phase !== 'locked' || !latest || latest.id !== data.stage) {
      throw Error('測試賽階段已變更，請重新核對。');
    }
    if (entry.medalSimulationBackup) throw Error('此測試賽已回復過一次。');
    const fixtures = stageFixtures(tournament, latest);
    if (!/^(冠季賽|冠季軍戰|決賽)$/u.test(latest.name) || fixtures.length !== 2 ||
        JSON.stringify(fixtures.map(match => match.id)) !== JSON.stringify(data.fixtures)) {
      throw Error('測試賽的冠季賽場次已變更，請重新核對。');
    }
    const previous = { ...tournament, stages: stages.slice(0, -1),
      fixtures: tournament.fixtures.filter(match => !fixtures.includes(match)) };
    const plan = medalPlan(previous);
    if (!plan || !plan.pairs.every(pair => fixtures.some(match => pair.teams.every(id => match.teams.includes(id))))) {
      throw Error('上一輪的四強結果與冠季賽對戰不符。');
    }
    entry.medalSimulationBackup = { stage: latest, fixtures, archivedOn: entry.archivedOn ?? null };
    entry.tournament = previous;
    delete entry.archived;
    delete entry.archivedOn;
    return entry.id;
  }
  if (data.action === 'reopenEvent') {
    if (!entry.archived || entry.event.phase !== 'locked' || !entry.tournament) throw Error('只能重新開啟已完賽的賽事。');
    delete entry.archived;
    delete entry.archivedOn;
    return entry.id;
  }
  if (data.action === 'deleteArchivedEvent') {
    if (!entry.archived) throw Error('只能刪除已移入完賽紀錄的賽事。');
    state.events.splice(state.events.indexOf(entry), 1);
    return null;
  }
  if (entry.archived) throw Error('此場賽事已移入完賽紀錄。');
  if (data.action === 'publishDraft') {
    if (!entry.draft || entry.event.signupDeadline < today) throw Error('草稿已發布或報名期限已過。');
    entry.draft = false;
    entry.openedOn = today;
  } else if (data.action === 'archive') {
    if (!completed(entry.tournament)) throw Error('請先登錄各點比分並裁定所有異議，再確認完賽。');
    entry.archived = true;
    entry.archivedOn = today;
  } else {
    if (entry.draft) throw Error('請先發布賽事。');
    const updated = domain.mutate({ ...entry, members: state.members }, actor, data, today);
    entry.event = updated.event;
    if (updated.tournament) entry.tournament = updated.tournament;
  }
  return entry.id;
}

function catalogView(state, actor, id) {
  if (id) {
    const entry = selectedEvent(state, actor, id);
    const result = domain.view({ ...entry, members: state.members }, actor);
    if (entry.archived && result.matchups) {
      for (const match of result.matchups) {
        match.canRemove = false;
        for (const point of match.points) {
          point.canScore = false;
          point.canDispute = false;
        }
      }
    }
    return { ...result, eventId: entry.id, eventNumber: entry.number,
      openedOn: entry.openedOn ?? null, draft: Boolean(entry.draft), archived: Boolean(entry.archived) };
  }
  const events = state.events.filter(entry => actor.organizer || !entry.draft).map(entry => {
    const fixtures = entry.tournament?.fixtures ?? [];
    const rankings = entry.archived ? stageRankings(entry.tournament, stagesOf(entry.tournament).at(-1)) : [];
    const champion = entry.archived ? placements(entry.tournament).find(row => row.rank === 1) : null;
    const player = actor.uid && !entry.draft && !entry.archived && entry.event.players.find(item =>
      item.uid === actor.uid || item.memberId === actor.uid);
    const team = player && findPlayerTeam(entry.event, player.id);
    const captain = team && team.captainId === player.id ? { teamName: team.name, playerName: player.name } : null;
    return {
      id: entry.id, number: entry.number, openedOn: entry.openedOn ?? null,
      title: entry.event.title, phase: entry.event.phase,
      draft: Boolean(entry.draft), archived: Boolean(entry.archived), archivedOn: entry.archivedOn ?? null,
      ...(captain ? { captain } : {}),
      playerCount: entry.event.players.length, teamCount: entry.event.teams.length,
      fixtureCount: fixtures.length,
      finishedCount: fixtures.filter(match => match.points.every(point => point.result?.status === 'confirmed')).length,
      disputed: fixtures.some(match => match.points.some(point => point.result?.status === 'disputed')),
      leaders: champion ? [champion.name] : rankings.flatMap(({ name, rows }) =>
        rows.filter(team => team.won === rows[0].won && team.points === rows[0].points)
          .map(team => name ? name + ' ' + team.name : team.name))
    };
  });
  const result = { organizer: actor.organizer, events };
  if (actor.organizer) result.members = state.members.filter(member => !member.removed).map(member => ({
    id: member.id, number: member.number, name: member.name, demo: member.demo, manual: member.manual,
    history: state.events.filter(entry => entry.event.players.some(player =>
      player.memberId === member.id || player.uid === member.id)).map(entry => ({ id: entry.id, title: entry.event.title }))
  }));
  return result;
}

module.exports = { migrateCatalog, changeCatalog, catalogView };
