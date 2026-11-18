const registration = require('./registration.js');
const { createTournament, submitLineup, pointSides, submitScore, validateScore, fixtureResult } = require('./model.js');
const { stagesOf, stageFixtures, stageMode, limitsTeamToOneMatch, canRemoveFixture, stageRankings, roundRobinFixtures, validateGroups, medalPlan, updateStage, placements } = require('./stages.cjs');

const stageActions = new Set(['createStage', 'createMedalStage', 'generateStage', 'addStageMatch', 'removeStageMatch', 'deleteStage']);

const organizerActions = new Set([
  'publish', 'close', 'captain', 'replaceCaptain', 'lock', 'seedPlayers', 'enrollMembers', 'reopen', 'addTeamMembers',
  'saveGroups', ...stageActions
]);

function scoreSides(tournament, fixture, sides) {
  return sides.map((players, index) => {
    const captain = tournament.teams.find(team => team.id === fixture.teams[index])?.captainId;
    return captain && !players.includes(captain) ? [...players, captain] : players;
  });
}

function activateSubmittedScores(tournament) {
  let changed = false;
  for (const fixture of tournament?.fixtures ?? []) {
    for (const point of fixture.points) {
      if (point.result?.status !== 'pending') continue;
      point.result.status = 'confirmed';
      changed = true;
    }
  }
  return changed;
}

function canDisputeScore(result, side) {
  return result?.status === 'confirmed' && (result.side === 0 || result.side === 1) && side === 1 - result.side;
}

function fixtureGroup(groups, fixture) {
  if (!groups || groups.length < 2) return '';
  const index = groups.findIndex(group => fixture.teams.every(id => group.includes(id)));
  return index < 0 ? '跨組加賽' : String.fromCharCode(65 + index) + ' 組';
}

function migrate(state) {
  if (state.members) return state;
  const players = state.event?.players ?? [];
  state.members = players.filter(player => player.demo || player.uid).map(player => ({
    id: player.demo ? 'demo-' + player.id : player.uid,
    name: player.demo ? player.name.replace(/^測試選手 /, '測試會員 ') : player.name,
    demo: Boolean(player.demo)
  }));
  if (state.event && state.event.phase !== 'locked') {
    state.event.players = players.filter(player => !player.demo || registration.findPlayerTeam(state.event, player.id));
    state.event.playerSequence = players.length;
    for (const player of state.event.players) {
      if (player.demo) player.memberId = 'demo-' + player.id;
    }
  }
  return state;
}

function memberIds(input, max = 30) {
  if (!Array.isArray(input) || !input.length || input.length > max ||
      input.some(id => typeof id !== 'string' || !id || id.length > 128) ||
      new Set(input).size !== input.length) throw Error('請勾選有效且不重複的名單。');
  return input;
}

function text(input, max) {
  return typeof input === 'string' && input.length <= max ? input.trim() : '';
}

function unenrolledMembers(state, organizerId) {
  const registeredIds = new Set((state.event?.players ?? []).flatMap(player => [player.uid, player.memberId]));
  return (state.members ?? []).filter(member =>
    !member.removed && member.id !== organizerId && !registeredIds.has(member.id));
}

function date(input) {
  if (typeof input !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(input)) return '';
  const parsed = new Date(input);
  return !Number.isNaN(+parsed) && parsed.toISOString().slice(0, 10) === input ? input : '';
}

function mutate(state, actor, data, today) {
  if (!actor.uid) throw Error('請先登入已驗證的帳號。');
  if (organizerActions.has(data.action) && !actor.organizer) throw Error('此操作僅限大會。');
  state = migrate(state ?? {});
  if (data.action === 'seedPlayers') {
    if (state.members.some(member => member.demo)) throw Error('會員名冊已有測試會員。');
    for (let index = 1; index <= 30; index++) {
      state.members.push({ id: 'demo-' + index, name: '測試會員 ' + String(index).padStart(2, '0'), demo: true });
    }
    return state;
  }
  if (data.action === 'publish') {
    if (state.event) throw Error('試用環境已有一場賽事。');
    const signupDeadline = date(data.signupDeadline);
    const format = data.matchFormat ?? 'single-double-single';
    const points = registration.matchPoints(format);
    const teamSize = data.teamSize ? Number(data.teamSize) : points?.reduce((sum, point) => sum + point, 0);
    if (!signupDeadline || signupDeadline < today || teamSize > 18) {
      throw Error('報名期限須在今天或之後，每隊最低人數最多可設 18 人。');
    }
    state.event = registration.createRegistration(text(data.title, 80), signupDeadline,
      date(data.deadline), teamSize, format);
    return state;
  }
  if (data.action === 'lineup') {
    const tournament = state.tournament;
    const fixture = tournament?.fixtures.find(item => item.id === data.fixture);
    const team = tournament?.teams.find(item => fixture?.teams.includes(item.id) &&
      item.players.some(player => player.id === item.captainId && player.uid === actor.uid));
    if (state.event?.phase !== 'locked' || !team) throw Error('只有該場隊長可以指定出賽隊員。');
    if (!Array.isArray(data.starters) || data.starters.length !== fixture.points.reduce((sum, point) => sum + point.format, 0)) {
      throw Error('請填寫每一點的出賽隊員。');
    }
    let offset = 0;
    const selections = fixture.points.map(point => {
      const players = data.starters.slice(offset, offset + point.format);
      offset += point.format;
      return players;
    });
    submitLineup(tournament, fixture, team.id, selections);
    return state;
  }
  if (stageActions.has(data.action)) {
    if (!state.tournament || state.event?.phase !== 'locked') throw Error('請先鎖定隊伍並產生預賽。');
    updateStage(state.tournament, data, registration.matchPoints(state.event.matchFormat ?? 'single-double-single'));
    return state;
  }
  if (['score', 'disputeScore'].includes(data.action)) {
    const fixture = state.tournament?.fixtures.find(item => item.id === data.fixture);
    const index = typeof data.point === 'string' && /^[0-8]$/.test(data.point) ? Number(data.point) : -1;
    const point = fixture?.points[index];
    if (state.event?.phase !== 'locked' || !point || !fixture.teams.every(id => fixture.lineups[id])) {
      throw Error('雙方完成排點後才能登錄賽果。');
    }
    const sides = pointSides(fixture, index);
    if (!sides.every(side => side.length === point.format)) throw Error('雙方完成排點後才能登錄賽果。');
    const authorized = scoreSides(state.tournament, fixture, sides);
    const player = state.event.players.find(item => item.uid === actor.uid || item.memberId === actor.uid);
    if (data.action === 'score') {
      const score = [data.home, data.away].map(value => typeof value === 'string' && /^[0-3]$/.test(value) ? Number(value) : NaN);
      if (actor.organizer) {
        validateScore(score);
        point.result = { score, status: 'confirmed' };
      } else {
        submitScore(point, authorized, player?.id, score, false);
        point.result.status = 'confirmed';
      }
    } else {
      const side = authorized.findIndex(ids => ids.includes(player?.id));
      if (!canDisputeScore(point.result, side)) throw Error('只有對方出賽選手或隊長可以對此比分提出異議。');
      point.result.status = 'disputed';
      point.result.disputedBy = player.id;
    }
    return state;
  }
  if (!state.event || state.event.phase === 'locked') throw Error('目前沒有開放操作的賽事。');
  const { event } = state;
  const player = event.players.find(item => item.uid === actor.uid || item.memberId === actor.uid);
  const target = text(data.player, 8);
  switch (data.action) {
    case 'enrollMembers': {
      const available = new Map(unenrolledMembers(state, actor.uid).map(member => [member.id, member]));
      const selected = memberIds(data.members).map(id => available.get(id));
      if (event.phase !== 'signup' || event.players.length + selected.length > 144 || selected.some(member => !member)) {
        throw Error('請在報名期間勾選尚未報名的名冊會員。');
      }
      if (data.names !== undefined && (!Array.isArray(data.names) || data.names.length !== selected.length)) {
        throw Error('請為每位勾選的會員填寫參賽名稱。');
      }
      const names = selected.map((member, index) => data.names
        ? text(data.names[index], 40)
        : member.demo ? '測試選手 ' + (member.number ?? member.id) : member.name);
      if (names.some(name => !name)) throw Error('請為每位勾選的會員填寫參賽名稱。');
      for (const [index, member] of selected.entries()) {
        const player = registration.registerPlayer(event, names[index], today, { allowDuplicateName: true });
        if (member.demo) player.demo = true;
        player.memberId = member.id;
        player.uid = member.id;
      }
      break;
    }
    case 'reopen': {
      const deadline = date(data.signupDeadline);
      if (event.phase !== 'grouping' || !deadline || deadline < today) {
        throw Error('請填入今天或之後的報名截止日。');
      }
      event.signupDeadline = deadline;
      event.phase = 'signup';
      break;
    }
    case 'close':
      registration.closeRegistration(event);
      break;
    case 'captain':
    case 'replaceCaptain': {
      const candidate = event.players.find(item => item.id === target);
      if (!candidate?.uid || state.members.some(member => member.id === candidate.uid && member.removed)) {
        throw Error('請指定已報名且可登入的會員擔任隊長。');
      }
      if (data.action === 'replaceCaptain') {
        registration.replaceCaptain(event, text(data.team, 8), target);
      } else {
        if (event.teams.length >= 24) throw Error('試用版最多 24 隊。');
        registration.designateCaptain(event, target, text(data.name, 40));
        delete event.groups;
      }
      break;
    }
    case 'saveGroups':
      if (event.phase !== 'grouping') throw Error('請先截止報名，再設定預賽分組。');
      event.groups = validateGroups(event.teams.map(team => team.id), data.groups);
      break;
    case 'lock': {
      const manual = data.schedule === 'manual';
      state.tournament = registration.lockRegistration(event, data.acceptUnassigned === true, manual);
      if (manual) event.preferredSchedule = 'manual';
      else delete event.preferredSchedule;
      if (manual) {
        Object.assign(state.tournament.stages[0], { mode: 'manual', singleMatch: data.singleMatch !== false });
      } else {
        const { title, deadline, teams } = state.tournament;
        const groups = event.groups ? validateGroups(teams.map(team => team.id), event.groups) : [teams.map(team => team.id)];
        if (event.groups) {
          state.tournament.fixtures = roundRobinFixtures(title, deadline, teams,
            registration.matchPoints(event.matchFormat ?? 'single-double-single'), groups, 's1');
        }
        state.tournament.stages = [{ id: 's1', name: '預賽', mode: 'roundRobin', groups }];
      }
      break;
    }
    case 'register':
      if (player || event.players.length >= 144) throw Error('目前無法報名或此帳號已報名。');
      registration.registerPlayer(event, text(data.name, 40), today, { allowDuplicateName: true }).uid = actor.uid;
      break;
    case 'completeTeam':
      registration.completeTeamRoster(event, player?.id);
      break;
    case 'add':
    case 'addTeamMembers': {
      const captainAdding = data.action === 'add';
      const assignments = captainAdding ? [{ players: data.players ?? [target] }] : data.assignments;
      if (!Array.isArray(assignments) || !assignments.length || assignments.length > 24) {
        throw Error('請提供有效的隊伍和隊員名單。');
      }
      const copy = structuredClone(event);
      for (const assignment of assignments) {
        const captainId = captainAdding ? player?.id : event.teams.find(team => team.id === assignment?.teamId)?.captainId;
        if (!captainId) throw Error('找不到可加入隊員的隊伍。');
        for (const id of memberIds(assignment.players, 144)) registration.addTeamPlayer(copy, captainId, id);
      }
      state.event = copy;
      break;
    }
    case 'remove':
    case 'leave':
    case 'allow':
      if (!player) throw Error('請先完成個人報名。');
      if (data.action === 'remove') registration.removeTeamPlayer(event, player.id, target);
      if (data.action === 'leave') registration.leaveTeam(event, player.id);
      if (data.action === 'allow') registration.allowRejoin(event, player.id, text(data.team, 8));
      break;
    default:
      throw Error('未知的操作。');
  }
  return state;
}

function view(state, actor) {
  const result = { organizer: actor.organizer, player: null, event: null };
  if (actor.organizer) {
    result.memberCount = state?.members?.length ?? 0;
    result.hasDemoMembers = state?.members?.some(member => member.demo) ?? false;
    result.unenrolledMembers = unenrolledMembers(state ?? {}, actor.uid).map(({ id, name }) => ({ id, name }));
  }
  if (!state?.event) return result;
  const { title, signupDeadline, deadline, teamSize, matchFormat, phase, players, teams } = state.event;
  result.event = { title, signupDeadline, deadline, teamSize, matchFormat: matchFormat ?? 'single-double-single', phase,
    ...(state.event.groups?.length > 1 && state.event.preferredSchedule !== 'manual' ?
      { groupCount: state.event.groups.length } : {}),
    ...(state.event.preferredSchedule === 'manual' ? { preferredSchedule: 'manual' } : {}) };
  const visiblePlayer = ({ id, name, grade }) => ({ id, name,
    ...(Number.isInteger(grade) && grade > 0 ? { grade } : {}) });
  const memberNumbers = new Map((state.members ?? []).map(member => [member.id, member.number]));
  const memberNumber = ({ memberId, uid }) => memberNumbers.get(memberId) ?? memberNumbers.get(uid) ?? null;
  if (actor.organizer || actor.uid) {
    result.registeredPlayers = players.map(item => ({ name: item.name,
      ...(Number.isInteger(item.grade) && item.grade > 0 ? { grade: item.grade } : {}),
      memberNumber: memberNumber(item) }));
  }
  if (actor.organizer) {
    result.teams = teams;
    if (state.event.groups) result.groups = state.event.groups;
    result.players = players.map(item => ({ ...visiblePlayer(item), memberNumber: memberNumber(item), demo: Boolean(item.demo),
      canCaptain: Boolean(item.uid && !state.members?.some(member => member.id === item.uid && member.removed)),
      blockedTeams: item.blockedTeams }));
  }
  const player = actor.uid && players.find(item => item.uid === actor.uid || item.memberId === actor.uid);
  if (player) {
    result.player = visiblePlayer(player);
    const team = registration.findPlayerTeam(state.event, player.id);
    result.team = team ? {
      ...team, members: team.playerIds.map(id => visiblePlayer(players.find(item => item.id === id)))
    } : null;
    result.blocked = teams.filter(item => player.blockedTeams.includes(item.id)).map(visiblePlayer);
    if (team?.captainId === player.id && registration.canEditTeamRoster(phase)) {
      result.eligible = players.filter(item => !team.playerIds.includes(item.id) &&
        !item.blockedTeams.includes(team.id)).map(item => ({
        ...visiblePlayer(item), memberNumber: memberNumber(item), assigned: Boolean(registration.findPlayerTeam(state.event, item.id))
      }));
    }
  }
  if (state.event.preferredSchedule !== 'manual' && registration.canEditTeamRoster(phase) && teams.length >= 2 &&
      teams.every(team => team.rosterComplete && team.playerIds.length >= teamSize) &&
      (actor.organizer || (result.team && result.team.captainId === player?.id))) {
    const names = new Map(teams.map(team => [team.id, team.name]));
    const formats = registration.matchPoints(result.event.matchFormat);
    const fixtures = state.event.groups ? roundRobinFixtures(title, deadline, teams, formats, state.event.groups, 's1') :
      createTournament(title, deadline, teams, formats).fixtures;
    result.fixturePreview = fixtures.filter(fixture => actor.organizer || fixture.teams.includes(result.team.id))
      .map(fixture => fixture.teams.map(id => names.get(id)));
  }
  if (state.tournament) {
    const stages = stagesOf(state.tournament);
    const groupsByStage = new Map(stages.map(stage => [stage.id, stage.groups]));
    const automaticStageIds = new Set(stages.filter(stage => stageMode(stage) === 'roundRobin').map(stage => stage.id));
    result.stages = stages.map(stage => {
      const fixtures = stageFixtures(state.tournament, stage);
      return { ...stage, mode: stageMode(stage), matchCount: fixtures.length,
        ...(actor.organizer && limitsTeamToOneMatch(stage) ? { scheduledTeams: fixtures.flatMap(fixture => fixture.teams) } : {}),
        placements: placements(state.tournament, fixtures, true),
        rankings: stageRankings(state.tournament, stage) };
    });
    if (actor.organizer && !state.archived) result.medalPlan = medalPlan(state.tournament);
    result.placements = placements(state.tournament);
    const latest = result.stages.at(-1);
    result.standings = latest.rankings.length === 1 ? latest.rankings[0].rows : [];
    const names = new Map(teams.map(team => [team.id, team.name]));
    result.fixtures = state.tournament.fixtures.map(item => item.teams.map(id => names.get(id)));
    {
      const playerNames = new Map(players.map(player => [player.id, player.name +
        (Number.isInteger(player.grade) && player.grade > 0 ? '（' + player.grade + ' 級）' : '')]));
      result.matchups = state.tournament.fixtures.map(fixture => ({
        id: fixture.id,
        stageId: fixture.stageId ?? 's1',
        canRemove: actor.organizer && !automaticStageIds.has(fixture.stageId ?? 's1') && canRemoveFixture(fixture),
        groupName: fixtureGroup(groupsByStage.get(fixture.stageId ?? 's1'), fixture),
        kind: fixture.kind,
        teamIds: fixture.teams,
        teams: fixture.teams.map(id => names.get(id)),
        submitted: fixture.teams.map(id => Boolean(fixture.lineups[id])),
        summary: fixtureResult(fixture),
        points: fixture.points.map((point, index) => {
          const sides = pointSides(fixture, index);
          const ready = fixture.teams.every(id => fixture.lineups[id]) &&
            sides.every(side => side.length === point.format);
          const side = scoreSides(state.tournament, fixture, sides).findIndex(ids => ids.includes(player?.id));
          return {
            format: point.format,
            sides: actor.organizer || (actor.uid && ready) ? sides.map(ids => ids.map(id => playerNames.get(id))) : [[], []],
            result: point.result ? { score: point.result.score, status: point.result.status } : null,
            ...(actor.organizer && point.result?.status === 'disputed' ? { dispute: {
              team: names.get(fixture.teams[1 - point.result.side]),
              player: playerNames.get(point.result.disputedBy)
            } } : {}),
            canScore: ready && (actor.organizer || (side >= 0 && !point.result)),
            canDispute: Boolean(actor.uid) && ready && canDisputeScore(point.result, side)
          };
        })
      }));
    }
    if (result.team?.captainId === player?.id && result.team) {
      const teamId = result.team.id;
      result.lineups = state.tournament.fixtures.filter(item => item.teams.includes(teamId)).map(item => ({
        id: item.id, opponent: names.get(item.teams.find(id => id !== teamId)),
        stageId: item.stageId ?? 's1',
        formats: item.points.map(point => point.format), starters: item.lineups[teamId] ?? [],
        locked: item.teams.every(id => item.lineups[id])
      }));
    }
  }
  return result;
}

module.exports = { mutate, view, migrate, activateSubmittedScores };
