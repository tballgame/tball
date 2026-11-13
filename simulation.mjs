import catalog from './catalog.cjs';
import { hash } from './session-auth.mjs';

const simulation = '15-teams-three-groups';
const teamNames = ['飛燕隊', '松風隊', '山雀隊', '銀狐隊', '海風隊', '勝利隊', '晨光隊', '白浪隊', '青松隊', '金隼隊',
  '石虎隊', '雲豹隊', '夜鷹隊', '小鹿隊', '星火隊'];
const simulations = {
  '15-teams-three-groups': { title: '三區循環測試賽（15 隊）', names: teamNames, teamSize: 7, matchFormat: '11122' },
  'six-team-knockout': { title: '六隊單淘汰測試賽', names: ['A 隊', 'B 隊', 'C 隊', 'D 隊', 'E 隊', 'F 隊'],
    teamSize: 4, matchFormat: '111', manual: true },
  'ten-team-round-robin': { title: '十隊單循環測試賽', names: teamNames.slice(0, 10),
    teamSize: 7, matchFormat: '11122', completeScores: true }
};

export async function prepareSimulation(state, actor, today, scenario = simulation) {
  if (!actor.organizer) throw Error('此操作僅限大會。');
  if (!Object.hasOwn(simulations, scenario)) throw Error('找不到此測試賽設定。');
  const { title, names, teamSize, matchFormat, manual, completeScores } = simulations[scenario];
  const existing = state.events.find(entry => entry.simulation === scenario);
  if (existing) return existing.id;

  const members = state.members.filter(member => member.demo && !member.removed && member.loginHash);
  const used = new Set(state.members.map(member => member.loginHash));
  const needed = names.length * teamSize;
  let sequence = 31;
  while (members.length < needed) {
    const code = 'sim' + String(sequence++).padStart(3, '0');
    const loginHash = await hash(code);
    if (used.has(loginHash)) continue;
    const member = {
      id: 'simulation-' + crypto.randomUUID(), name: code, demo: true, loginHash,
      number: 'M' + String(state.members.length + 1).padStart(4, '0')
    };
    used.add(loginHash);
    members.push(member);
    state.members.push(member);
  }

  const eventId = catalog.changeCatalog(state, actor, {
    action: 'publish', title, signupDeadline: today, teamSize, matchFormat
  }, today);
  const act = (action, fields = {}) => catalog.changeCatalog(state, actor, { action, eventId, ...fields }, today);
  const reserves = teamSize - 1;
  const rosters = names.map((name, index) => ({
    name, members: [members[index], ...members.slice(names.length + index * reserves, names.length + (index + 1) * reserves)]
  }));
  const entries = rosters.flatMap(({ name, members: roster }) => roster.map((member, index) => ({
    id: member.id, name: name.replace(/\s*隊$/, '') + ' ' + (index + 1)
  })));
  for (let offset = 0; offset < entries.length; offset += 30) {
    const batch = entries.slice(offset, offset + 30);
    act('enrollMembers', { members: batch.map(item => item.id), names: batch.map(item => item.name) });
  }
  const entry = state.events.find(item => item.id === eventId);
  const players = new Map(entry.event.players.map(player => [player.memberId, player.id]));
  for (const roster of rosters) act('captain', { player: players.get(roster.members[0].id), name: roster.name });
  act('addTeamMembers', { assignments: rosters.map((roster, index) => ({
    teamId: entry.event.teams[index].id, players: roster.members.slice(1).map(member => players.get(member.id))
  })) });
  for (const team of entry.event.teams) team.rosterComplete = true;
  act('close');
  if (manual) {
    entry.event.preferredSchedule = 'manual';
  } else if (!completeScores) {
    const ids = entry.event.teams.map(team => team.id);
    act('saveGroups', { groups: [ids.slice(0, 5), ids.slice(5, 10), ids.slice(10)] });
  }
  if (completeScores) {
    act('lock');
    const teams = new Map(entry.event.teams.map(team => [team.id, team]));
    for (const [index, fixture] of entry.tournament.fixtures.entries()) {
      for (const teamId of fixture.teams) {
        const team = teams.get(teamId);
        const captain = entry.event.players.find(player => player.id === team.captainId);
        catalog.changeCatalog(state, { uid: captain.uid, organizer: false }, {
          action: 'lineup', eventId, fixture: fixture.id, starters: team.playerIds
        }, today);
      }
      for (let point = 0; point < fixture.points.length; point++) {
        const winner = (index + 3 * point) % 7 < 4 ? 0 : 1;
        const loserScore = String((index + point) % 3);
        act('score', { fixture: fixture.id, point: String(point),
          home: winner === 0 ? '3' : loserScore, away: winner === 1 ? '3' : loserScore });
      }
    }
  }
  entry.simulation = scenario;
  return eventId;
}
