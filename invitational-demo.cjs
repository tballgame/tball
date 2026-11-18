const { changeCatalog } = require('./catalog.cjs');
const { registerPlayer, designateCaptain, addTeamPlayer, completeTeamRoster } = require('./registration.js');
const { submitLineup } = require('./model.js');
const { stageRankings, stageFixtures, medalPlan, placements } = require('./stages.cjs');

const scenario = 'invitational-six-team-doubles';
const title = '115 年第三次會內賽（六隊雙打模擬）';
const gradePairs = [[1, 3], [7, 9], [4, 6], [2, 5], [8, 10]];
const rosters = [
  ['王德山', '黃文良', '蘇木斌', '王碧如', '江明炎', '汪一家', '歐崑琅', '朱榮瑞', '鄭錦隆', '陳威靚'],
  ['黃太郎', '程麗君', '吳春暉', '陳麗貞', '陳盈達', '陳進隆', '黃雅君', '周志宏', '賴美玉', '施冠汝'],
  ['劉進益', '吳名彬', '呂中柱', '李英宗', '劉鴻銘', '謝見佑', '買武東', '林耿立', '林俊佑', '嚴建川'],
  ['李士傑', '林溶徐', '劉國銘', '李錦玫', '喬惠康', '王廷智', '賴怡婷', '嚴碧昇', '周俊宇', '吳英芬'],
  ['陳志宏', '呂捷廷', '劉清源', '吳明堅', '蘇明安', '陳國省', '葉志忠', '陳尚喬', '傅開恩', '洪燈河'],
  ['吳思翰', '黃奕廷', '徐賓鴻', '李新榮', '繆萍', '李明哲', '蔡幸芳', '陳增菱', '黃妹燕', '簡妙芝']
];

function exists(state) {
  return state.events.some(entry => entry.simulation === scenario);
}

function createInvitationalDemo(state, actor, today) {
  if (!actor.organizer) throw Error('此操作僅限大會。');
  const previous = state.events.find(entry => entry.simulation === scenario);
  if (previous) return previous.id;

  // Build every stage before changing the caller's catalog so retries cannot leave half a simulation.
  const draft = structuredClone(state);
  const eventId = changeCatalog(draft, actor, {
    action: 'publish', title, signupDeadline: today, teamSize: 10, matchFormat: '22222'
  }, today);
  const entry = draft.events.find(item => item.id === eventId);
  const act = (action, fields = {}) => changeCatalog(draft, actor, { action, eventId, ...fields }, today);

  for (const [index, names] of rosters.entries()) {
    const players = names.map((name, index) => {
      const player = registerPlayer(entry.event, name, today, { allowDuplicateName: true });
      player.grade = index + 1;
      return player;
    });
    const captainId = players[0].id;
    designateCaptain(entry.event, captainId, String.fromCharCode(65 + index) + ' 隊');
    for (const player of players.slice(1)) addTeamPlayer(entry.event, captainId, player.id);
    completeTeamRoster(entry.event, captainId);
  }
  act('close');
  act('lock');
  entry.tournament.stages[0].name = '六隊單循環';

  // These strengths generate sample scores only, with a unique ranking for each group.
  const strengthOrder = ['t3', 't1', 't5', 't2', 't6', 't4'];
  const strength = new Map(strengthOrder.map((id, index) => [id, index]));
  function completeStage(stage) {
    for (const [matchIndex, fixture] of stageFixtures(entry.tournament, stage).entries()) {
      for (const teamId of fixture.teams) {
        const team = entry.tournament.teams.find(item => item.id === teamId);
        const playersByGrade = new Map(team.players.map(player => [player.grade, player.id]));
        const lineup = gradePairs.map(grades => grades.map(grade => playersByGrade.get(grade)));
        submitLineup(entry.tournament, fixture, teamId, lineup);
      }
      const winnerSide = strength.get(fixture.teams[0]) < strength.get(fixture.teams[1]) ? 0 : 1;
      const winningPoints = (matchIndex + Number(stage.id.slice(1))) % 2 === 0 ? 4 : 3;
      for (let point = 0; point < 5; point++) {
        const pointWinner = (point + matchIndex) % 5 < winningPoints ? winnerSide : 1 - winnerSide;
        const score = [0, 0];
        score[pointWinner] = 3;
        score[1 - pointWinner] = (point + matchIndex + Number(stage.id.slice(1))) % 3;
        act('score', { fixture: fixture.id, point: String(point), home: String(score[0]), away: String(score[1]) });
      }
    }
  }

  completeStage(entry.tournament.stages[0]);
  const firstRanking = stageRankings(entry.tournament, entry.tournament.stages[0])[0].rows;
  const groups = [[0, 3, 4], [1, 2, 5]].map(positions => positions.map(position => firstRanking[position].id));
  act('createStage', { name: '強弱平均分組循環', mode: 'roundRobin', teams: firstRanking.map(team => team.id) });
  const grouped = entry.tournament.stages.at(-1);
  act('generateStage', { stage: grouped.id, groups });
  completeStage(grouped);

  const [groupA, groupB] = stageRankings(entry.tournament, grouped);
  const semifinalPairs = [
    [groupA.rows[0].id, groupB.rows[1].id],
    [groupB.rows[0].id, groupA.rows[1].id]
  ];
  act('createStage', { name: '四強賽', mode: 'manual', teams: semifinalPairs.flat(), singleMatch: true });
  const semifinals = entry.tournament.stages.at(-1);
  for (const [home, away] of semifinalPairs) act('addStageMatch', { stage: semifinals.id, home, away });
  completeStage(semifinals);
  act('createMedalStage', { name: '冠季賽', ...medalPlan(entry.tournament) });
  completeStage(entry.tournament.stages.at(-1));

  entry.simulation = scenario;
  entry.simulationNotes = [
    '此場為模擬賽，比分與排名僅供操作測試。',
    '每隊 10 人，每場 5 點雙打，每位隊員每場出賽一次。',
    '1 級最強。各隊每場依序配對：第 1 點 1＋3 級、第 2 點 7＋9 級、第 3 點 4＋6 級、第 4 點 2＋5 級、第 5 點 8＋10 級。',
    '第一階段六隊單循環 15 場，按本階段團體勝場與勝點排名。',
    '第二階段依第一階段名次分組，A 組為第 1、4、5 名，B 組為第 2、3、6 名。各組重新計分，各打 3 場。',
    '各組前二交叉淘汰，A 組第一對 B 組第二、B 組第一對 A 組第二。勝隊爭冠，敗隊爭季軍。'
  ];
  state.events = draft.events;
  state.nextEventNumber = draft.nextEventNumber;
  return eventId;
}

function reverseInvitationalResults(state, actor, eventId, today) {
  if (!actor.organizer) throw Error('此操作僅限大會。');
  const previous = state.events.find(entry => entry.id === eventId && entry.simulation === scenario);
  if (!previous) throw Error('找不到這場會內模擬賽。');
  if (previous.simulationReversal) return eventId;
  const tournament = previous.tournament;
  const [semifinals, medals] = tournament.stages.slice(-2);
  const previousPlacements = placements(tournament);
  if (tournament.stages.length !== 4 || semifinals.name !== '四強賽' || medals.name !== '冠季賽' ||
      JSON.stringify(previousPlacements.map(row => row.name)) !== JSON.stringify(['C 隊', 'A 隊', 'E 隊', 'B 隊'])) {
    throw Error('賽事已變更，請先核對目前名次。');
  }
  const draft = structuredClone(state);
  const entry = draft.events.find(item => item.id === eventId);
  const act = (action, fields = {}) => changeCatalog(draft, actor, { action, eventId, ...fields }, today);
  if (previous.archived) act('reopenEvent');

  const oldMedals = stageFixtures(entry.tournament, medals);
  entry.tournament.fixtures = entry.tournament.fixtures.filter(match => !oldMedals.includes(match));
  entry.tournament.stages.pop();
  for (const fixture of stageFixtures(entry.tournament, semifinals)) {
    for (const [index, point] of fixture.points.entries()) {
      const [home, away] = point.result.score;
      act('score', { fixture: fixture.id, point: String(index), home: String(away), away: String(home) });
    }
  }
  act('createMedalStage', { name: medals.name, ...medalPlan(entry.tournament) });
  for (const fixture of stageFixtures(entry.tournament, entry.tournament.stages.at(-1))) {
    const desiredWinner = fixture.kind === 'final' ? 't2' : 't1';
    const winnerSide = fixture.teams.indexOf(desiredWinner);
    if (winnerSide < 0) throw Error('反轉後的冠季賽隊伍不符，請核對四強結果。');
    for (const teamId of fixture.teams) {
      const team = entry.tournament.teams.find(item => item.id === teamId);
      const playersByGrade = new Map(team.players.map(player => [player.grade, player.id]));
      submitLineup(entry.tournament, fixture, teamId, gradePairs.map(pair => pair.map(grade => playersByGrade.get(grade))));
    }
    for (let point = 0; point < 5; point++) {
      const pointWinner = point < 3 ? winnerSide : 1 - winnerSide;
      const score = [0, 0];
      score[pointWinner] = 3;
      score[1 - pointWinner] = point % 3;
      act('score', { fixture: fixture.id, point: String(point), home: String(score[0]), away: String(score[1]) });
    }
  }
  entry.simulationReversal = { previousPlacements, reversedOn: today };
  entry.simulationNotes.push('淘汰賽比分已反轉模擬，前四名依序為 B 隊、E 隊、A 隊、C 隊。');
  if (previous.archived) act('archive');
  state.events = draft.events;
  return eventId;
}

module.exports = { createInvitationalDemo, exists, rosters, gradePairs, reverseInvitationalResults };
