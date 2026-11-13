const matchFormats = {
  'single-double-single': [1, 2, 1],
  'three-singles': [1, 1, 1],
  'four-singles-one-double': [1, 1, 2, 1, 1]
};

function matchPoints(format) {
  if (typeof format !== 'string') return null;
  if (/^[12](?:[12]{2}){0,4}$/.test(format)) return Array.from(format, Number);
  return Object.hasOwn(matchFormats, format) ? matchFormats[format] : null;
}

function createRegistration(title, signupDeadline, deadline, teamSize, matchFormat = 'single-double-single') {
  const points = matchPoints(matchFormat);
  if (!points) throw Error('請選擇有效的對戰項目。');
  if (!title.trim() || !signupDeadline || (deadline && signupDeadline > deadline) ||
      !Number.isInteger(teamSize) || teamSize < Math.max(...points)) {
    throw Error('請填寫賽名、報名截止日，以及足以安排單打或雙打的每隊最低人數。');
  }
  return { title, signupDeadline, deadline, teamSize, matchFormat, phase: 'signup', players: [], teams: [] };
}

function registerPlayer(event, name, today, { allowDuplicateName = false } = {}) {
  if (event.phase !== 'signup' || today > event.signupDeadline) throw Error('個人報名已截止。');
  if (!name.trim()) throw Error('請輸入參賽名稱。');
  if (!allowDuplicateName && event.players.some(player => player.name === name)) throw Error('請輸入尚未登記的姓名。');
  event.playerSequence = (event.playerSequence ?? event.players.length) + 1;
  const player = { id: 'p' + event.playerSequence, name, blockedTeams: [] };
  event.players.push(player);
  return player;
}

function closeRegistration(event) {
  if (event.phase !== 'signup' || event.players.length < event.teamSize * 2) {
    throw Error('至少要有兩隊所需的報名人數，才能截止報名。');
  }
  event.phase = 'grouping';
}

function findPlayerTeam(event, playerId) {
  return event.teams.find(team => team.playerIds.includes(playerId));
}

function canEditTeamRoster(phase) {
  return phase === 'signup' || phase === 'grouping';
}

function designateCaptain(event, playerId, name) {
  if (!canEditTeamRoster(event.phase) || !name.trim() || event.teams.some(team => team.name === name) ||
      !event.players.some(player => player.id === playerId) || findPlayerTeam(event, playerId)) {
    throw Error('請選擇尚未入隊的選手，並輸入尚未使用的隊名。');
  }
  event.teams.push({ id: 't' + (event.teams.length + 1), name, captainId: playerId, playerIds: [playerId] });
}

function addTeamPlayer(event, captainId, playerId) {
  const team = event.teams.find(team => team.captainId === captainId);
  const player = event.players.find(player => player.id === playerId);
  if (!canEditTeamRoster(event.phase) || !team || !player || findPlayerTeam(event, playerId) ||
      player.blockedTeams.includes(team.id)) {
    throw Error('此選手目前無法加入你的隊伍。');
  }
  team.playerIds.push(playerId);
  delete team.rosterComplete;
}

function replaceCaptain(event, teamId, playerId) {
  const team = event.teams.find(item => item.id === teamId);
  const assignedTeam = findPlayerTeam(event, playerId);
  if (!canEditTeamRoster(event.phase) || !team || team.captainId === playerId || (assignedTeam && assignedTeam !== team)) {
    throw Error('請選擇本隊隊員或尚未入隊的參賽者擔任新隊長。');
  }
  if (!assignedTeam) addTeamPlayer(event, team.captainId, playerId);
  team.captainId = playerId;
  delete team.rosterComplete;
}

function completeTeamRoster(event, captainId) {
  const team = event.teams.find(item => item.captainId === captainId);
  if (!canEditTeamRoster(event.phase) || !team) throw Error('只有隊長可以確認組隊完成。');
  if (team.playerIds.length < event.teamSize) throw Error('隊伍達到最低人數後才能確認完成。');
  team.rosterComplete = true;
}

function leaveTeam(event, playerId) {
  const team = findPlayerTeam(event, playerId);
  if (!canEditTeamRoster(event.phase) || !team || team.captainId === playerId) {
    throw Error('隊長異動請洽大會。');
  }
  team.playerIds = team.playerIds.filter(id => id !== playerId);
  delete team.rosterComplete;
  event.players.find(player => player.id === playerId).blockedTeams.push(team.id);
}

function removeTeamPlayer(event, captainId, playerId) {
  const team = event.teams.find(item => item.captainId === captainId);
  if (!canEditTeamRoster(event.phase) || !team || playerId === captainId || !team.playerIds.includes(playerId)) {
    throw Error('隊長只能移除自己隊上的其他隊員。');
  }
  team.playerIds = team.playerIds.filter(id => id !== playerId);
  delete team.rosterComplete;
}

function allowRejoin(event, playerId, teamId) {
  const player = event.players.find(player => player.id === playerId);
  if (!canEditTeamRoster(event.phase) || !player?.blockedTeams.includes(teamId)) {
    throw Error('目前沒有可解除的回隊限制。');
  }
  player.blockedTeams = player.blockedTeams.filter(id => id !== teamId);
}

function lockRegistration(event, acceptUnassigned, manualSchedule = false) {
  if (event.phase !== 'grouping' || event.teams.length < 2 ||
      event.teams.some(team => team.playerIds.length < event.teamSize)) {
    throw Error('至少需要兩隊，且各隊都須達到最低人數。');
  }
  if (!acceptUnassigned && event.players.some(player => !findPlayerTeam(event, player.id))) {
    throw Error('仍有未分隊選手，請先確認如何處理。');
  }
  const teams = event.teams.map(team => ({
    id: team.id, name: team.name, captainId: team.captainId,
    players: team.playerIds.map(id => event.players.find(player => player.id === id))
  }));
  const buildTournament = typeof module !== 'undefined' ? require('./model.js').createTournament : createTournament;
  const tournament = manualSchedule ? {
    title: event.title, deadline: event.deadline, teams, fixtures: [],
    stages: [{ id: 's1', name: '首輪', groups: [teams.map(team => team.id)] }]
  } : buildTournament(event.title, event.deadline, teams, matchPoints(event.matchFormat ?? 'single-double-single'));
  event.phase = 'locked';
  return tournament;
}

if (typeof module !== 'undefined') {
  module.exports = { matchPoints, createRegistration, registerPlayer, closeRegistration, findPlayerTeam,
    canEditTeamRoster, designateCaptain, replaceCaptain, addTeamPlayer, completeTeamRoster, leaveTeam, removeTeamPlayer, allowRejoin,
    lockRegistration };
}
