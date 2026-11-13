const { createTournament, fixtureResult, standings } = require('./model.js');

function stagesOf(tournament) {
  return tournament.stages ?? [{ id: 's1', name: '預賽', groups: [tournament.teams.map(team => team.id)] }];
}

function stageFixtures(tournament, stage) {
  return tournament.fixtures.filter(fixture => (fixture.stageId ?? 's1') === stage.id);
}

function stageMode(stage) {
  return stage.mode ?? (/淘汰|^(?:四強|4強|準決)(?:賽)?$/u.test(stage.name) ? 'knockout' : 'regular');
}

function limitsTeamToOneMatch(stage) {
  const mode = stageMode(stage);
  return mode === 'knockout' || (mode === 'manual' && stage.singleMatch !== false);
}

function canRemoveFixture(fixture) {
  return !Object.keys(fixture.lineups ?? {}).length &&
    fixture.points.every(point => !point.result && !point.appointment);
}

function validateGroups(teamIds, groups) {
  if (!Array.isArray(groups) || !groups.length || groups.some(group => !Array.isArray(group) || group.length < 2)) {
    throw Error('每組至少要有兩隊。');
  }
  const assigned = groups.flat();
  if (assigned.length !== teamIds.length || new Set(assigned).size !== assigned.length ||
      assigned.some(id => !teamIds.includes(id))) {
    throw Error('請為每支參賽隊伍指定一個組別。');
  }
  return groups;
}

function roundRobinFixtures(title, deadline, teams, formats, groups, stageId) {
  const byId = new Map(teams.map(team => [team.id, team]));
  return groups.flatMap(group => createTournament(title, deadline, group.map(id => byId.get(id)), formats)
    .fixtures.map(fixture => stageId === 's1' ? fixture :
      { ...fixture, id: stageId + '-' + fixture.id, stageId }));
}

function stageRankings(tournament, stage) {
  const fixtures = stageFixtures(tournament, stage).filter(fixture => !['final', 'third'].includes(fixture.kind));
  const groupNames = index => String.fromCharCode(65 + index) + ' 組';
  const scopes = stage.groups.map((teamIds, index) => ({
    name: stage.groups.length > 1 ? groupNames(index) : '', teamIds
  }));
  if (stage.groups.length > 1 &&
      fixtures.some(fixture => !stage.groups.some(group => fixture.teams.every(id => group.includes(id))))) {
    scopes.push({ name: '全階段', teamIds: stage.groups.flat() });
  }
  return scopes.map(({ name, teamIds }) => {
    const matches = fixtures.filter(fixture => fixture.teams.every(id => teamIds.includes(id)));
    return {
      name, teamIds, rows: standings({ teams: tournament.teams.filter(team => teamIds.includes(team.id)), fixtures: matches }),
      total: matches.length, finished: matches.filter(match => fixtureResult(match).complete).length
    };
  });
}

function qualifiers(tournament, source, count) {
  const rankings = stageRankings(tournament, source);
  const groups = rankings.slice(0, source.groups.length);
  if (groups.some(group => !group.total || group.finished !== group.total || group.rows.length < count)) {
    throw Error('請先完成來源階段的各組對戰，並檢查晉級名額。');
  }
  return groups.flatMap(group => {
    const last = group.rows[count - 1];
    const next = group.rows[count];
    if (next && last.won === next.won && last.points === next.points) {
      throw Error('晉級線上有並列，請依大會的同分規則手動選隊。');
    }
    return group.rows.slice(0, count).map(team => team.id);
  });
}

function medalPlan(tournament) {
  const source = stagesOf(tournament).at(-1);
  if (!/^(?:四強|4強|準決)(?:賽)?$/u.test(source.name) ||
      tournament.fixtures.some(fixture => ['final', 'third'].includes(fixture.kind))) return null;
  const matches = stageFixtures(tournament, source);
  if (matches.length !== 2 || new Set(matches.flatMap(fixture => fixture.teams)).size !== 4 ||
      !matches.every(fixture => fixtureResult(fixture).complete)) return null;
  const results = matches.map(fixture => {
    const { wins } = fixtureResult(fixture);
    return wins[0] > wins[1] ? fixture.teams : fixture.teams.slice().reverse();
  });
  return { source: source.id, pairs: [
    { kind: 'final', teams: results.map(pair => pair[0]) },
    { kind: 'third', teams: results.map(pair => pair[1]) }
  ] };
}

function updateStage(tournament, data, formats) {
  const stages = stagesOf(tournament);
  if (data.action === 'createMedalStage') {
    const plan = medalPlan(tournament);
    if (!plan || plan.source !== data.source || JSON.stringify(plan.pairs) !== JSON.stringify(data.pairs)) {
      throw Error('四強賽或階段已更新，請重新整理後核對對戰。');
    }
    const draft = { ...tournament, fixtures: tournament.fixtures.slice() };
    updateStage(draft, { action: 'createStage', name: data.name, mode: 'manual', teams: plan.pairs.flatMap(pair => pair.teams) }, formats);
    const stage = draft.stages.at(-1).id;
    for (const { kind, teams: [home, away] } of plan.pairs) {
      updateStage(draft, { action: 'addStageMatch', stage, kind, home, away }, formats);
    }
    tournament.stages = draft.stages;
    tournament.fixtures = draft.fixtures;
    return;
  }
  if (data.action === 'createStage') {
    const name = typeof data.name === 'string' ? data.name.trim() : '';
    if (!name || name.length > 30 || stages.some(stage => stage.name === name)) throw Error('請輸入尚未使用的階段名稱。');
    let teamIds = data.teams;
    if (data.selection === 'rank') {
      const source = stages.find(stage => stage.id === data.source);
      const count = Number(data.top);
      if (!source || !Number.isInteger(count) || count < 1 || count > tournament.teams.length) {
        throw Error('請選擇排名來源與有效的晉級名額。');
      }
      teamIds = qualifiers(tournament, source, count);
    }
    validateGroups(tournament.teams.filter(team => Array.isArray(teamIds) && teamIds.includes(team.id)).map(team => team.id), [teamIds]);
    const next = Math.max(...stages.map(stage => Number(stage.id.slice(1)))) + 1;
    const mode = data.mode;
    if (!['roundRobin', 'manual'].includes(mode)) throw Error('請選擇有效的排賽方式。');
    tournament.stages = [...stages, { id: 's' + next, name, mode, groups: [teamIds],
      ...(mode === 'manual' ? { singleMatch: data.singleMatch !== false } : {}) }];
    return;
  }
  const stage = stages.find(item => item.id === data.stage);
  if (!stage) throw Error('找不到這個比賽階段。');
  if ((data.action === 'addStageMatch' || data.action === 'generateStage') && stage !== stages.at(-1)) {
    throw Error('已有下一輪，只能在最新階段新增對戰或產生循環賽程。');
  }
  const matches = stageFixtures(tournament, stage);
  const mode = stageMode(stage);
  if (data.action === 'removeStageMatch') {
    if (mode === 'roundRobin') throw Error('循環賽由系統配對，不能單獨移除場次。');
    const fixture = matches.find(item => item.id === data.fixture);
    if (!fixture) throw Error('找不到此階段的對戰。');
    if (!canRemoveFixture(fixture)) throw Error('已有排點、約賽或比分的場次不能移除。');
    tournament.fixtures.splice(tournament.fixtures.indexOf(fixture), 1);
  } else if (data.action === 'deleteStage') {
    if (stage.id === 's1' || matches.length) throw Error('只能移除尚未安排對戰的加賽階段。');
    tournament.stages = stages.filter(item => item !== stage);
  } else if (data.action === 'generateStage') {
    if (['manual', 'knockout'].includes(mode)) throw Error('大會排定請逐場配對。');
    if (matches.length) throw Error('此階段已有對戰。');
    const groups = validateGroups(stage.groups.flat(), data.groups);
    const fixtures = roundRobinFixtures(tournament.title, tournament.deadline, tournament.teams, formats, groups, stage.id);
    stage.groups = groups;
    tournament.fixtures.push(...fixtures);
  } else {
    if (mode === 'roundRobin') throw Error('循環賽由系統配對，不能手動加入場次。');
    const [home, away] = [data.home, data.away];
    const selected = stage.groups.flat();
    if (home === away || !selected.includes(home) || !selected.includes(away)) throw Error('請選擇此階段內兩支不同隊伍。');
    if (limitsTeamToOneMatch(stage) && matches.some(match => match.teams.includes(home) || match.teams.includes(away))) {
      throw Error('其中一隊本輪已排定對戰。本輪每隊最多一場。');
    }
    if (matches.some(match => match.teams.includes(home) && match.teams.includes(away))) throw Error('此階段已有這兩隊的對戰。');
    const kind = data.kind ?? 'regular';
    if (!['regular', 'final', 'third'].includes(kind) || (kind !== 'regular' && tournament.fixtures.some(match =>
      match.kind === kind || (['final', 'third'].includes(match.kind) && match.teams.some(id => id === home || id === away))))) {
      throw Error('請確認冠軍戰、季軍戰的隊伍與場次。');
    }
    const fixture = roundRobinFixtures(tournament.title, tournament.deadline, tournament.teams, formats, [[home, away]], stage.id)[0];
    if (kind !== 'regular') fixture.kind = kind;
    tournament.fixtures.push(fixture);
  }
}

function placements(tournament, fixtures = tournament.fixtures, includePending = false) {
  return fixtures.flatMap(fixture => {
    const { wins, complete } = fixtureResult(fixture);
    if (!['final', 'third'].includes(fixture.kind) || (!complete && !includePending)) return [];
    const winner = wins[0] > wins[1] ? 0 : 1;
    const first = fixture.kind === 'final' ? 1 : 3;
    return [winner, 1 - winner].map((side, index) => ({
      rank: first + index, name: complete ? tournament.teams.find(team => team.id === fixture.teams[side]).name : null
    }));
  }).sort((a, b) => a.rank - b.rank);
}

module.exports = { stagesOf, stageFixtures, stageMode, limitsTeamToOneMatch, canRemoveFixture, validateGroups, roundRobinFixtures, stageRankings, medalPlan, updateStage, placements };
