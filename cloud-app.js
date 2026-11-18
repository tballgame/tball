import { knockoutBoard } from './knockout-board.mjs?v=0.7.8';

const screen = document.querySelector('#screen');
const identity = document.querySelector('#identity');
const status = document.querySelector('#status');
const login = document.querySelector('#login');
const logout = document.querySelector('#logout');
const refresh = document.querySelector('#refresh');
const boardEventId = new URLSearchParams(window.location.search).get('board');
let session = 0;
let busy = false;
let user = null;
let activeEventId = null;
let dashboardPanel = 'active';

const esc = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
const form = (action, content) => '<form data-action="' + action + '">' + content + '</form>';
const nextAction = (label, highlight = true) => highlight
  ? '<button class="next-action"><span>下一步</span>' + esc(label) + '</button>'
  : '<button>' + esc(label) + '</button>';
const workflowNotice = (status, title, text) => '<div class="workflow-notice workflow-' + status +
  '"><strong>' + esc(title) + '</strong><p>' + esc(text) + '</p></div>';
const list = items => '<ul>' + items.map(item => '<li>' + esc(item) + '</li>').join('') + '</ul>';
const playerLabel = ({ name, memberNumber, grade }) => name +
  (Number.isInteger(grade) && grade > 0 ? '（' + grade + ' 級）' : '') +
  (memberNumber ? '（' + memberNumber + '）' : '');
const options = players => players.map(item => '<option value="' + esc(item.id) + '">' + esc(playerLabel(item)) + '</option>').join('');
const checkboxes = (items, field) => items.map(item => '<label><input type="checkbox" name="' +
  field + '" value="' + esc(item.id) + '"' + (item.assigned ? ' disabled' : '') + '> ' +
  (item.assigned ? '<span class="assigned">' + esc(playerLabel(item)) + '（已加入其他隊）</span>' : esc(playerLabel(item))) +
  '</label>').join('');

const matchupPlayers = (match, point) => match.teams.map((name, side) =>
  name + '（' + (point.sides[side].join('、') || '待排點') + '）').join(' ： ');
const pointLabel = (format, index) => '第 ' + (index + 1) + ' 點 ' + (format === 1 ? '單打' : '雙打');

function lineupForms(lineups, members, matchups) {
  const nextFixture = lineups?.find(fixture => !fixture.locked && !fixture.starters.length);
  return (lineups ?? []).map(fixture => {
    const starters = fixture.starters.flat();
    const reserves = members.filter(member => !starters.includes(member.id));
    const reserveList = starters.length ? '<p>本場備用：' + (reserves.map(member => esc(member.name)).join('、') || '無') + '</p>' : '';
    if (fixture.locked) {
      const match = matchups.find(item => item.id === fixture.id);
      return '<details class="lineup-card workflow-done"><summary>對 ' + esc(fixture.opponent) +
        ' · 雙方已提交</summary>' +
        (match ? '<ol>' + match.points.map((point, index) => '<li><strong>' + pointLabel(point.format, index) +
          '</strong><p>' + esc(matchupPlayers(match, point)) + '</p></li>').join('') + '</ol>' : '') +
        reserveList + '</details>';
    }
    let slot = 0;
    const fields = fixture.formats.map((count, index) => '<fieldset data-point="' + (index + 1) + '"><legend>' +
      pointLabel(count, index) + '</legend>' +
      Array.from({ length: count }, (_, index) => {
        const selected = starters[slot++];
        return '<label>選手 ' + (index + 1) + ' <select name="starter" required><option value="">請選擇</option>' +
          members.map(member => '<option value="' + esc(member.id) + '"' +
            (member.id === selected ? ' selected' : '') + '>' + esc(member.name) + '</option>').join('') + '</select></label>';
      }).join('') + '</fieldset>').join('');
    const controls = fields + nextAction('提交出賽名單', !starters.length) + '<p role="alert"></p>';
    const state = starters.length ? 'waiting' : 'pending';
    return '<details class="lineup-card workflow-' + state + '"' + (fixture === nextFixture ? ' open' : '') +
      '><summary>對 ' + esc(fixture.opponent) + ' · ' +
      (starters.length ? '已提交，等待對方隊長' : '待指定出賽隊員') + '</summary>' +
      form('lineup', '<input type="hidden" name="fixture" value="' + esc(fixture.id) + '">' + controls) +
      reserveList +
      '</details>';
  }).join('');
}

function captainLineups(view, message) {
  const { lineups = [], team, matchups = [] } = view;
  const pending = lineups.filter(fixture => !fixture.locked && !fixture.starters.length).length;
  const waiting = lineups.filter(fixture => !fixture.locked && fixture.starters.length).length;
  const ownMatches = matchups.filter(match => lineups.some(fixture => fixture.id === match.id));
  const canReport = ownMatches.some(match => match.points.some(point => point.canScore && !point.result));
  const complete = ownMatches.length && ownMatches.every(match => match.points.every(point => point.result?.status === 'confirmed'));
  const notice = pending ? workflowNotice('pending', '隊長下一步：指定出賽隊員',
    '還有 ' + pending + ' 場未排點。展開紅框對戰，逐點選人後提交名單。') :
    canReport ? workflowNotice('pending', '下一步：登錄賽果', '在逐點對戰結果登錄尚未填寫的比分。比分送出後即計入勝點。') :
    waiting ? workflowNotice('waiting', '等待對方隊長排點', '本隊名單已送出。雙方提交後即可查看完整對陣。') :
    complete ? workflowNotice('done', '本隊各點比分已計入', '可查看比賽排名。') :
      workflowNotice('waiting', '等待賽果', '排點完成後，由各點出賽隊員或大會登錄比分。');
  return '<h3>指定出賽隊員</h3>' + notice + '<p id="team-feedback" role="status" tabindex="-1">' + esc(message) +
    '</p>' + lineupForms(lineups, team.members, matchups);
}

function confirmRepeatedStarters(lineupForm) {
  const appearances = new Map();
  for (const select of lineupForm.querySelectorAll('select[name="starter"]')) {
    if (!select.value) continue;
    if (!appearances.has(select.value)) {
      appearances.set(select.value, { name: select.selectedOptions[0].textContent, points: new Set() });
    }
    appearances.get(select.value).points.add(select.closest('[data-point]').dataset.point);
  }
  const repeated = Array.from(appearances.values()).filter(player => player.points.size > 1)
    .map(player => player.name + '（第 ' + Array.from(player.points).join('、') + ' 點）');
  return repeated.length === 0 || window.confirm(
    '以下隊員在同一場被安排出賽多點。\n' + repeated.join('\n') + '\n\n確定要提交這份出賽名單嗎？'
  );
}

function matchupResults(matches, organizer, publicBoard = false) {
  return matches.map(match => {
    const { wins, complete } = match.summary;
    const points = match.points.map((point, index) => {
      const fields = '<input type="hidden" name="fixture" value="' + esc(match.id) +
        '"><input type="hidden" name="point" value="' + index + '">';
      const result = point.result;
      const label = result ? ({ confirmed: '已計入勝點', disputed: '異議處理中，暫停計入勝點' })[result.status] :
        match.submitted.every(Boolean) ? '待登錄' : '待排點';
      const winner = result?.status === 'confirmed' ? match.teams[result.score[0] > result.score[1] ? 0 : 1] : null;
      const correcting = organizer && result?.status === 'confirmed';
      const disputed = result?.status === 'disputed';
      const actionLabel = correcting ? '儲存更正' : disputed ? '裁定本點比分' :
        organizer ? '登錄本點比分' : '送出本點比分';
      const scoreForm = point.canScore ? form('score', fields +
        '<p><strong>本點比分</strong>（五局三勝，例如 2：3）' +
        (correcting || disputed ? '。儲存後會重算團體勝點與排名。' : '。送出後即計入勝點。') + '</p>' +
        match.teams.map((name, side) => '<label>' + esc(name) + ' 本點勝局 <input type="number" name="' +
          (side ? 'away' : 'home') + '" min="0" max="3" required value="' + (result?.score[side] ?? '') + '"></label>').join('') +
        nextAction(actionLabel, !correcting) +
        '<p role="alert"></p>') : '';
      return '<li' + ((organizer && disputed) || (!organizer && point.canScore) ? ' class="point-task workflow-pending"' : '') +
        '><strong>' + pointLabel(point.format, index) + '</strong>' +
        (publicBoard ? '' : '<p>' + esc(matchupPlayers(match, point)) + '</p>') + '<p>' +
        (result ? '<strong>' + esc(result.score.join('：')) + '</strong> · ' : '') + esc(label) +
        (winner ? ' · <strong>' + esc(winner) + ' 勝出</strong>' : '') + '</p>' +
        (organizer && disputed ? '<p><strong>收到異議申請</strong>' +
          (point.dispute?.team ? ' ' + esc(point.dispute.team) : '') +
          (point.dispute?.player ? '（' + esc(point.dispute.player) + '）' : '') + '</p>' : '') +
        (correcting && scoreForm ? '<details><summary>修改本點比分</summary>' + scoreForm + '</details>' : scoreForm) +
        (point.canDispute ? form('disputeScore', fields + '<button>申請異議</button><p role="alert"></p>') : '') + '</li>';
    }).join('');
    const pendingTeams = match.teams.filter((_, index) => !match.submitted[index]);
    const disputes = match.points.filter(point => point.result?.status === 'disputed').length;
    const missingScores = match.points.filter(point => !point.result).length;
    const title = esc((match.kind === 'final' ? '冠軍戰 · ' : match.kind === 'third' ? '季軍戰 · ' : '') +
      match.teams.join(' vs '));
    const winner = complete ? match.teams[wins[0] > wins[1] ? 0 : 1] : null;
    const status = disputes ? disputes + ' 點待裁定' : pendingTeams.length ? '待排點' :
      missingScores ? missingScores + ' 點待登錄' : '已完賽';
    const needsAction = organizer ? !complete : match.points.some(point => point.canScore);
    const remove = organizer && match.canRemove ? form('removeStageMatch',
      '<input type="hidden" name="stage" value="' + esc(match.stageId) +
      '"><input type="hidden" name="fixture" value="' + esc(match.id) +
      '"><button type="submit" class="remove-match" data-match-label="' + esc(match.teams.join(' vs ')) +
      '">移除此場對戰</button><p role="alert"></p>') : '';
    return (remove ? '<div class="editable-match">' : '') +
      '<details class="match-result' + (needsAction ? ' match-needs-action' : '') +
      '" data-match-id="' + esc(match.id) + '"><summary>' + title + ' · ' + wins.join('：') + ' · ' +
      (winner ? '<span aria-hidden="true">🏆</span> ' + esc(winner) + ' 勝出' : esc(status)) +
      '</summary><p>' + esc(match.teams.map((team, index) => team +
        (match.submitted[index] ? '已排點' : '待排點')).join(' · ')) + '</p>' +
      (organizer && pendingTeams.length ? '<p><strong>待隊長指定出賽隊員</strong> ' + esc(pendingTeams.join('、')) + '</p>' : '') +
      '<ol>' + points + '</ol></details>' + (remove ? remove + '</div>' : '');
  }).join('');
}

function rankingTable(rows) {
  let rank = 0;
  return '<p>依團體勝場、已完賽場次的勝點數排序。兩項相同時並列。</p>' +
    '<table><thead><tr><th scope="col">名次</th><th scope="col">隊伍</th><th scope="col">勝場</th>' +
    '<th scope="col">敗場</th><th scope="col">勝點</th></tr></thead><tbody>' +
    rows.map((team, index) => {
      const previous = rows[index - 1];
      if (!previous || team.won !== previous.won || team.points !== previous.points) rank = index + 1;
      return '<tr><td>' + rank + '</td><th scope="row">' + esc(team.name) + '</th><td>' + team.won +
        '</td><td>' + team.lost + '</td><td>' + team.points + '</td></tr>';
    }).join('') + '</tbody></table>';
}

function roundRobinMatrix(rank, matches, caption) {
  const { rows } = rank;
  if (rows.length < 5 || rank.name === '全階段') return '';
  const results = new Map(rows.map(team => [team.name, new Map()]));
  for (const match of matches) {
    if (match.kind === 'final' || match.kind === 'third') continue;
    const [home, away] = match.teams;
    if (!results.has(home) || !results.has(away)) continue;
    if (results.get(home).has(away)) return '';
    results.get(home).set(away, { match, side: 0 });
    results.get(away).set(home, { match, side: 1 });
  }
  if (Array.from(results.values()).some(opponents => opponents.size !== rows.length - 1)) return '';

  const totals = (label, key) => '<tr><th scope="row">' + label + '</th>' +
    rows.map(team => '<td>' + team[key] + '</td>').join('') + '<td>—</td></tr>';
  let place = 0;
  const body = rows.map((team, index) => {
    const previous = rows[index - 1];
    if (!previous || previous.won !== team.won || previous.points !== team.points) place = index + 1;
    return '<tr><th scope="row">' + esc(team.name) + '</th>' + rows.map(opponent => {
      if (team === opponent) return '<td class="matrix-self">—</td>';
      const { match, side } = results.get(team.name).get(opponent.name);
      const { wins, complete } = match.summary;
      const score = wins[side] + '：' + wins[1 - side];
      if (complete) {
        const won = wins[side] > wins[1 - side];
        return '<td' + (won ? ' class="matrix-win"' : '') + '>' + score + (won ? ' <small>勝</small>' : '') + '</td>';
      }
      const status = match.points.some(point => point.result?.status === 'disputed') ? '有異議' :
        !match.submitted.every(Boolean) ? '待排點' : wins.some(Boolean) ? '進行中' : '待比分';
      return '<td class="matrix-pending">' + (wins.some(Boolean) ? score + '<br>' : '') + esc(status) + '</td>';
    }).join('') + '<td>' + (rank.finished ? place : '—') + '</td></tr>';
  }).join('');
  return '<p>每格比分依左列隊伍在前、上欄對手在後。排名和合計只計已完賽場次。</p>' +
    '<div class="matrix-scroll" tabindex="0" role="region" aria-label="' + esc(caption) + '">' +
    '<table class="round-robin-matrix"><caption>' + esc(caption) + '</caption><thead><tr><th scope="col">隊伍／對手</th>' +
    rows.map(team => '<th scope="col">' + esc(team.name) + '</th>').join('') +
    '<th scope="col">名次</th></tr></thead><tbody>' + body + '</tbody><tfoot>' +
    totals('團體勝場', 'won') + totals('總勝點', 'points') + '</tfoot></table></div>';
}

function stageRankings(view) {
  const labels = ['冠軍', '亞軍', '季軍', '殿軍'];
  const placements = view.placements?.length ? '<h3>名次賽結果</h3>' +
    list(view.placements.map(row => labels[row.rank - 1] + ' · ' + row.name)) : '';
  return placements + (view.stages ?? []).map((stage, index, all) => {
    const matches = (view.matchups ?? []).filter(match => match.stageId === stage.id);
    return '<details data-ranking-stage="' + esc(stage.id) + '"' + (index === all.length - 1 ? ' open' : '') +
      '><summary>' + esc(stage.name) + '</summary>' +
      (stage.placements?.length ? list(stage.placements.map(row => labels[row.rank - 1] + ' · ' + (row.name ?? '待定'))) : '') +
      stage.rankings.filter(rank => !stage.placements?.length || rank.total).map(rank =>
        (rank.name ? '<h4>' + esc(rank.name) + '</h4>' : '') +
        (roundRobinMatrix(rank, matches, [stage.name, rank.name, '循環對戰表'].filter(Boolean).join(' · ')) ||
          (rank.finished ? rankingTable(rank.rows) : '<p>待首場對戰完成。</p>'))).join('') + '</details>';
  }).join('');
}

function stageMatchups(view, organizer, publicBoard = false) {
  const stages = view.stages ?? [];
  return stages.map((stage, index) => {
    const matches = (view.matchups ?? []).filter(match => match.stageId === stage.id);
    const groups = new Map();
    for (const match of matches) {
      if (!groups.has(match.groupName)) groups.set(match.groupName, []);
      groups.get(match.groupName).push(match);
    }
    const body = Array.from(groups, ([name, items]) =>
      (name ? '<h4>' + esc(name) + '</h4>' : '') + matchupResults(items, organizer, publicBoard)).join('');
    const latest = index === stages.length - 1;
    const complete = matches.filter(match => match.summary.complete).length;
    const pendingLineups = matches.filter(match => !match.summary.complete && !match.submitted.every(Boolean)).length;
    const disputes = organizer ? matches.reduce((count, match) =>
      count + match.points.filter(point => point.result?.status === 'disputed').length, 0) : 0;
    const state = !matches.length ? '待排賽' : complete === matches.length ? '已完賽' :
      pendingLineups === matches.length ? '待排點' : '比賽中';
    const tone = state === '已完賽' ? 'done' : state === '比賽中' ? 'active' : 'waiting';
    const progress = state === '待排點' ? pendingLineups + ' 場待排點' :
      matches.length ? complete + '／' + matches.length + ' 場已完賽' : '';
    const open = latest && (!organizer || (!view.archived && !matches.length));
    return '<details class="stage-panel' + (disputes ? ' stage-has-disputes' : '') +
      '" data-stage-panel="' + esc(stage.id) + '"' + (open ? ' open' : '') +
      '><summary>第 ' + (index + 1) + ' 階段　' + esc(stage.name) +
      ' <span class="stage-status stage-status-' + tone + '">' + state + '</span>' +
      (progress ? ' <span class="stage-progress">' + progress + '</span>' : '') +
      (disputes ? ' <span class="stage-status stage-status-dispute">待處理 ' + disputes + ' 筆異議</span>' : '') +
      '</summary>' + (organizer && !view.archived ? stageSchedule(view, stage, latest) : '') +
      (body || '<p>尚未安排對戰。</p>') + '</details>';
  }).join('');
}

function groupEditor(action, teams, groups, stageId = '') {
  const count = groups?.length ?? 1;
  const indexById = new Map((groups ?? []).flatMap((group, index) => group.map(id => [id, index])));
  const choices = Array.from({ length: count }, (_, index) => [index, String.fromCharCode(65 + index) + ' 組']);
  return form(action, (stageId ? '<input type="hidden" name="stage" value="' + esc(stageId) + '">' : '') +
    '<label>組數 <select data-group-count>' + Array.from({ length: Math.floor(teams.length / 2) }, (_, index) =>
      '<option value="' + (index + 1) + '"' + (index + 1 === count ? ' selected' : '') + '>' +
      (index === 0 ? '單組' : (index + 1) + ' 組') + '</option>').join('') + '</select></label>' +
    '<div class="team-group-fields">' + teams.map(team => '<label>' + esc(team.name) +
      ' <select data-group-team="' + esc(team.id) + '">' + choices.map(([index, label]) => '<option value="' + index +
        '"' + (index === (indexById.get(team.id) ?? 0) ? ' selected' : '') + '>' + label + '</option>').join('') +
      '</select></label>').join('') + '</div>' +
    nextAction(action === 'saveGroups' ? '儲存預賽分組' : '產生組內循環') + '<p role="alert"></p>');
}

function scheduleFields(name, manual = false) {
  return '<label>' + (name === 'schedule' ? '首階段排賽方式' : '排賽方式') +
    ' <select name="' + name + '" data-schedule-mode>' +
    '<option value="roundRobin">循環賽（系統自動排定）</option>' +
    '<option value="manual"' + (manual ? ' selected' : '') + '>大會排定（手動配對）</option></select></label>' +
    '<div data-schedule-help="roundRobin"' + (manual ? ' hidden' : '') +
    '><p>同組每兩隊交手一次。分成多組時，各組各自循環。</p></div>' +
    '<fieldset data-schedule-help="manual"' + (manual ? '' : ' hidden disabled') +
    '><legend>手動配對設定</legend><p>由大會逐場配對，可安排淘汰賽、種子輪空、冠軍賽、季軍賽或加賽。</p>' +
    '<label><input type="checkbox" name="singleMatch" checked> 本輪每隊最多一場</label>' +
    '<p>勾選時，已排賽的隊伍會從下拉清單移除。取消勾選可讓同一隊在本階段對上不同隊伍。</p></fieldset>';
}

function stageToolbar(view) {
  if (view.archived) return '';
  const { stages, teams } = view;
  const medal = view.medalPlan ? '<details data-medal-editor><summary>建立冠季賽</summary>' +
    form('createMedalStage', '<label>階段名稱 <input name="name" value="冠季賽" maxlength="30" required></label>' +
      '<input type="hidden" name="source" value="' + esc(view.medalPlan.source) + '">' +
      '<input type="hidden" name="pairs" value="' + esc(JSON.stringify(view.medalPlan.pairs)) + '">' +
      list(view.medalPlan.pairs.map(pair => (pair.kind === 'final' ? '冠軍戰（第 1、2 名）' : '季軍戰（第 3、4 名）') +
        ' · ' + pair.teams.map(id => teams.find(team => team.id === id).name).join(' vs '))) +
      nextAction('確認建立兩場對戰') + '<p role="alert"></p>') + '</details>' : '';
  const create = '<div id="stage-create" data-create-stage hidden>' + form('createStage',
    '<p>建立新階段後，新增對戰與產生循環賽程會移到新階段。</p>' +
    '<label>階段名稱 <input name="name" maxlength="30" required placeholder="例如四強賽"></label>' +
    scheduleFields('mode') +
    '<label>參賽隊伍 <select name="selection" data-stage-selection><option value="manual">手動選隊</option>' +
    '<option value="rank">依排名選隊</option></select></label>' +
    '<fieldset data-team-selection="manual"><legend>本階段參賽隊伍</legend><div class="team-group-fields">' +
    checkboxes(teams, 'teams') + '</div></fieldset>' +
    '<fieldset data-team-selection="rank" hidden disabled><legend>依來源階段各組名次取隊</legend>' +
    '<label>來源階段 <select name="source">' + options(stages.slice().reverse()) + '</select></label>' +
    '<label>每組取前幾名 <input type="number" name="top" min="1" max="' + teams.length + '" required></label></fieldset>' +
    nextAction('建立階段') + '<p role="alert"></p>') + '</div>';
  return '<div class="stage-toolbar"><h3>賽事階段</h3>' +
    '<button type="button" class="next-action" data-toggle-stage aria-expanded="false" aria-controls="stage-create">＋ 新增階段</button></div>' +
    '<p id="stage-feedback" role="status" tabindex="-1"></p>' + create + medal;
}

function stageSchedule(view, stage, latest) {
  const { teams } = view;
  const removeEmpty = stage.id !== 's1' && !stage.matchCount ? form('deleteStage',
    '<input type="hidden" name="stage" value="' + esc(stage.id) +
    '"><button>移除空階段</button><p role="alert"></p>') : '';
  if (!latest) return removeEmpty;
  const eligible = stage.groups.flat().map(id => teams.find(team => team.id === id));
  const automatic = stage.mode === 'roundRobin';
  const legacyRegular = stage.mode === 'regular';
  const singleMatch = stage.mode === 'knockout' || (stage.mode === 'manual' && stage.singleMatch !== false);
  const scheduled = new Set(stage.scheduledTeams);
  const available = singleMatch ? eligible.filter(team => !scheduled.has(team.id)) : eligible;
  const teamOptions = '<option value="">請選擇</option>' + options(available);
  if (automatic && stage.matchCount) return '';
  if (singleMatch && available.length < 2 && stage.matchCount) return '';
  return '<div class="stage-schedule"><h4>排賽（' + eligible.length + ' 隊）</h4>' +
    (!automatic && eligible.length === 4 && !stage.matchCount ? '<p>安排冠季賽時，請將兩場用途分別選為冠軍賽與季軍賽。</p>' : '') +
    (singleMatch ? '<p>本輪每隊最多一場，尚有 ' + available.length + ' 隊可配對。未排對戰的隊伍可輪空。</p>' : '') +
    ((automatic || legacyRegular) && !stage.matchCount ? '<details' + (automatic ? ' open' : '') + '><summary>產生組內循環</summary>' +
      groupEditor('generateStage', eligible, stage.groups, stage.id) + '</details>' : '') +
    (automatic ? '' : available.length >= 2 ? form('addStageMatch', '<input type="hidden" name="stage" value="' + esc(stage.id) + '">' +
      '<div class="team-group-fields"><label>第一隊 <select name="home" required>' + teamOptions +
      '</select></label><label>第二隊 <select name="away" required>' + teamOptions + '</select></label>' +
      '<label>對戰用途 <select name="kind"><option value="regular">一般對戰</option><option value="final">冠軍賽（第 1、2 名）</option>' +
      '<option value="third">季軍賽（第 3、4 名）</option></select></label></div>' +
      nextAction('加入「' + stage.name + '」') + '<p role="alert"></p>') :
      '<p>目前沒有兩支可再配對的隊伍。</p>') + removeEmpty + '</div>';
}

function registrationRoster(players) {
  if (!players?.length) return players ? '<p>目前尚無人報名。</p>' : '';
  const title = '已報名名單（' + players.length + ' 人）';
  const roster = '<ul class="registration-roster">' + players.map(item =>
    '<li>' + esc(playerLabel(item)) + '</li>').join('') + '</ul>';
  return players.length > 8
    ? '<details><summary>' + title + '</summary>' + roster + '</details>'
    : '<h3>' + title + '</h3>' + roster;
}

function teamRosterStatus(team, event) {
  if (team.rosterComplete) return '組隊完成';
  if (event.phase === 'locked') return '名單已鎖定';
  return team.playerIds.length >= event.teamSize ? '待隊長確認' : '組隊中';
}

function rosterList(members, captainId, canRemove = false) {
  const captain = members.find(member => member.id === captainId);
  const rows = members.filter(member => member.id !== captainId).map(member =>
    '<li><span>' + esc(playerLabel(member)) + '</span>' + (canRemove ? form('remove',
      '<input type="hidden" name="player" value="' + esc(member.id) + '">' +
      '<button aria-label="移除隊員 ' + esc(member.name) + '">移除隊員</button><p role="alert"></p>') : '') + '</li>').join('');
  return '<div class="team-roster"><p class="roster-captain"><strong>隊長</strong> ' + esc(captain ? playerLabel(captain) : '未指定') +
    '</p><div class="roster-members"><strong>隊員</strong>' +
    (rows ? '<ul role="list">' + rows + '</ul>' : '<p>尚無隊員。</p>') + '</div></div>';
}

function teamRoster(view, captain, message) {
  const { team, event, eligible, blocked } = view;
  const needsMembers = captain && team.members.length < event.teamSize;
  return '<p id="team-feedback" role="status" tabindex="-1">' + esc(message) + '</p>' +
    (team ? rosterList(team.members, team.captainId, captain) : '<p>尚未加入隊伍。</p>') +
    (captain ? (needsMembers ? workflowNotice('pending', '隊長下一步：加入隊員',
      '再加入 ' + (event.teamSize - team.members.length) + ' 位隊員，達到最低人數。') :
      team.rosterComplete ? workflowNotice('waiting', '等待大會鎖定名單', '正式賽程產生後，請逐場指定出賽隊員。') :
        workflowNotice('pending', '隊長下一步：完成組隊', '確認名單後按「完成組隊」。日後若有隊員異動，請重新確認。')) : '') +
    (eligible?.length ? form('add',
      '<p>勾選你的隊員，再按「加入勾選的隊員」儲存。</p>' +
      checkboxes(eligible, 'players') + nextAction('加入勾選的隊員', needsMembers && eligible.some(player => !player.assigned)) +
      '<p role="alert"></p>') : '') +
    (captain && !team.rosterComplete && !needsMembers ?
      form('completeTeam', nextAction('完成組隊') + '<p role="alert"></p>') : '') +
    (team && !captain ? form('leave', '<button>自行退出隊伍</button><p role="alert"></p>') : '') +
    blocked.map(group => form('allow', '<input type="hidden" name="team" value="' + esc(group.id) +
      '"><button>允許「' + esc(group.name) + '」重新加入我</button>')).join('');
}

function organizerNotice(view, canLock, canAppoint, confirmed, final) {
  const { event, teams, matchups = [], fixturePreview, archived } = view;
  if (archived) return workflowNotice('done', '賽事已完賽', '可在完賽紀錄查看排名及各場賽果。');
  if (view.medalPlan) return workflowNotice('pending', '大會下一步：建立冠季賽', '四強已打完，到流程 5 核對系統預填的冠軍戰與季軍戰。');
  if (final) return workflowNotice('pending', '大會下一步：加賽或確認完賽',
    '到流程 5 選擇「新增下一輪」，或在全部賽程結束後確認整場賽事完賽。');
  if (event.phase === 'locked') {
    const stage = view.stages?.at(-1);
    if (stage && !stage.matchCount) {
      const instruction = stage.mode === 'roundRobin' ? '設定分組後按「產生組內循環」。' :
        stage.mode === 'regular' ? '可產生組內循環，或手動加入對戰。' : '選擇兩隊，逐場加入對戰。';
      return workflowNotice('pending', '大會下一步：安排「' + stage.name + '」', '到流程 4 ' + instruction);
    }
    const disputes = matchups.flatMap(match => match.points).filter(point => point.result?.status === 'disputed').length;
    if (disputes) {
      return workflowNotice('pending', '大會下一步：處理 ' + disputes + ' 筆賽果異議', '到流程 4 查看紅框點次，核對後按「裁定本點比分」。');
    }
    if (matchups.some(match => match.points.some(point => point.canScore && point.result?.status !== 'confirmed'))) {
      const pendingLineups = matchups.some(match => !match.submitted.every(Boolean));
      return workflowNotice('pending', '大會下一步：核對賽果', '流程 4 可替已排點的場次登錄比分。' +
        (pendingLineups ? '紅框場次仍待隊長排點。' : ''));
    }
    return workflowNotice('waiting', '隊長下一步：指定出賽隊員', '請各隊長登入後逐場排點。流程 4 的紅框會列出尚未提交的隊伍。');
  }
  if (fixturePreview?.length && event.phase === 'signup') {
    return workflowNotice('pending', '大會下一步：截止報名', '在流程 4 截止報名，再確認未入隊選手及鎖定名單。');
  }
  if (canLock && confirmed === teams.length) {
    if (event.preferredSchedule === 'manual') {
      return workflowNotice('pending', '大會下一步：手動排賽', '在流程 4 鎖定隊伍名單，再於首輪自行加入對戰。');
    }
    return workflowNotice('pending', '大會下一步：鎖定名單並產生賽程', '到流程 4 核對對戰及未入隊名單。產生賽程後，請隊長排點。');
  }
  if (teams.length < 2) {
    return canAppoint ? workflowNotice('pending', '大會下一步：指定隊長', '到流程 2 從已報名會員中指定隊長。') :
      workflowNotice('waiting', '等待選手報名', '有符合資格的報名選手後，大會可在流程 2 指定隊長。');
  }
  return workflowNotice('waiting', '隊長下一步：完成組隊', '請隊長加入隊員並確認組隊。大會可在流程 3 查看各隊進度。');
}

function organizerFlow(view, announcement, captain, message) {
  const { event, teams, players, matchups } = view;
  const ownTeam = captain && event.phase !== 'locked' ? view.team : null;
  const playersById = new Map(players.map(player => [player.id, player]));
  const assigned = new Map(teams.flatMap(team => team.playerIds.map(id => [id, team.id])));
  const candidates = players.filter(player => player.canCaptain && !assigned.has(player.id));
  const captainList = teams.map(team => {
    const replacements = event.phase === 'locked' ? [] : players.filter(player => player.canCaptain &&
      player.id !== team.captainId && (assigned.get(player.id) === team.id ||
        (!assigned.has(player.id) && !player.blockedTeams?.includes(team.id))));
    return '<li><p>' + esc(team.name + ' · ' + (playersById.get(team.captainId)?.name ?? '未指定')) + '</p>' +
      (replacements.length ? '<details><summary>更換隊長</summary>' +
        form('replaceCaptain', '<input type="hidden" name="team" value="' + esc(team.id) +
          '"><label>新隊長 <select name="player" required><option value="">請選擇</option>' + options(replacements) +
          '</select></label><p>原隊長保留為隊員，由新隊長重新確認組隊。</p>' +
          '<button>確認更換隊長</button><p role="alert"></p>') + '</details>' : '') + '</li>';
  }).join('');
  const appoint = event.phase === 'locked' ? '' : candidates.length ?
    form('captain', '<label>隊長 <select name="player">' + options(candidates) +
      '</select></label><label>隊名 <input name="name" maxlength="40" required></label>' +
      nextAction('指定隊長', teams.length < 2)) :
    '<p>可指定已報名、可登入且尚未入隊的會員。</p>';
  const confirmed = teams.filter(team => team.rosterComplete).length;
  const preview = view.fixturePreview;
  const free = players.filter(player => !assigned.has(player.id));
  const canLock = event.phase === 'grouping' && teams.length >= 2 &&
    teams.every(team => team.playerIds.length >= event.teamSize);
  const scheduleAction = canLock ? form('lock',
    (free.length ? '<details><summary>尚未入隊的選手（' + free.length + ' 人）</summary>' +
      list(free.map(playerLabel)) + '</details>' +
      '<label><input type="checkbox" name="acceptUnassigned" required> 確認本次賽程排除這 ' +
      free.length + ' 位未入隊選手</label>' : '') +
    scheduleFields('schedule', event.preferredSchedule === 'manual') + nextAction('鎖定隊伍名單') + '<p role="alert"></p>') :
    preview?.length && event.phase === 'signup' ?
      form('close', '<p>截止報名後，可在這裡鎖定名單並產生正式賽程。</p>' + nextAction('截止報名') + '<p role="alert"></p>') :
      '<p>大會須先截止報名，且至少兩隊、每隊都達到最低人數，才能鎖定名單。</p>';
  const finished = matchups?.filter(match => match.submitted.every(Boolean)).length ?? 0;
  const completed = matchups?.filter(match => match.points.every(point => point.result?.status === 'confirmed')).length ?? 0;
  const final = Boolean(matchups?.length && completed === matchups.length && view.stages?.every(stage => stage.matchCount));
  const steps = [
    ['比賽發布', '已發布 · ' + players.length + ' 人報名', announcement],
    ['選隊長', teams.length + ' 位已指定',
      (message === captainChangeMessage ? '<p id="captain-feedback" role="status" tabindex="-1">' + esc(message) + '</p>' : '') +
      (teams.length ? '<ul>' + captainList + '</ul>' : '<p>待大會指定隊長。</p>') + appoint],
    ['隊長組隊', confirmed + '／' + teams.length + ' 隊已確認完成', teams.length ? teams.map(team =>
      '<h3>' + esc(team.name) + ' · ' + team.playerIds.length + ' 人 · ' + teamRosterStatus(team, event) + '</h3>' +
      (ownTeam && team.id === ownTeam.id ? teamRoster(view, captain, message) :
        rosterList(team.playerIds.map(id => playersById.get(id)).filter(Boolean), team.captainId))).join('') : '<p>待隊長組隊。</p>'],
    ['對戰名單', matchups?.length ? finished + '／' + matchups.length + ' 場已排點 · ' + completed + ' 場已完賽' :
      preview?.length ? '預覽 ' + preview.length + ' 場 · 待鎖定名單' : '待排賽',
      view.stages?.length ? (captain && !view.archived && view.lineups?.length ? captainLineups(view, message) : '') +
        stageToolbar(view) + (view.canSimulateSemifinals ? form('finishSeededSemifinals',
          '<button>模擬四強賽比分</button><p role="alert"></p>') : '') + (view.canSimulateMedals ? form('finishSeededMedals',
          '<button>模擬冠季賽比分</button><p role="alert"></p>') : '') + stageMatchups(view, true) :
        (event.phase === 'grouping' && teams.length >= 2 ? '<details><summary>設定預賽分組</summary>' +
          groupEditor('saveGroups', teams, view.groups) + '</details>' : '') +
        (preview?.length ? list(preview.map(pair => pair.join(' vs '))) : '') + scheduleAction],
    ['比賽排名', view.archived ? '最終排名' : final ? '目前排名' : completed ? '暫定排名' : '待完賽',
      (matchups?.length ? stageRankings(view) : '<p>產生賽程後可查看對戰表與排名。</p>') +
      (final && !view.archived ?
        '<p>目前安排的場次已完成。可以新增下一輪，或在整場賽事結束後歸檔。</p>' +
        (view.medalPlan ? '<button type="button" class="next-action" data-next-stage="medal"><span>下一步</span>建立冠季賽</button> ' : '') +
        '<button type="button"' + (view.medalPlan ? '' : ' class="next-action"') + ' data-next-stage="manual">新增下一輪</button>' +
        form('archive', '<button>確認整場賽事完賽</button><p role="alert"></p>') : '')]
  ];
  const current = event.phase === 'locked' ? (final && message !== reopenedEventMessage ? 4 : 3) : preview?.length || canLock ? 3 :
    teams.length >= 2 ? 2 : candidates.length || event.phase === 'grouping' ? 1 : 0;
  return '<section><h2>比賽流程</h2>' + organizerNotice(view, canLock, candidates.length > 0, confirmed, final) +
    '<ol class="event-flow">' + steps.map(([label, status, body], index) =>
    '<li><details' + (index === current || (index === 2 && ownTeam) ||
      (index === 1 && message === captainChangeMessage) ? ' open' : '') + '><summary' +
    (index === current ? ' aria-current="step"' : '') + '>' + label + ' · ' + esc(status) +
    (index === current ? ' <span class="current-step-label">目前步驟</span>' : '') +
    '</summary>' + body + '</details></li>').join('') + '</ol></section>';
}
const formats = {
  'single-double-single': '單打、雙打、單打',
  'three-singles': '單打、單打、單打',
  'four-singles-one-double': '單打、單打、雙打、單打、單打'
};

function renderPoints(container, count) {
  const previous = Array.from(container.querySelectorAll('select'), select => select.value);
  container.innerHTML = Array.from({ length: count }, (_, index) =>
    '<label>第 ' + (index + 1) + ' 點 <select name="pointType">' +
    '<option value="1">單打</option><option value="2">雙打</option></select></label>').join('');
  container.querySelectorAll('select').forEach((select, index) => {
    select.value = previous[index] ?? '1';
  });
}

const captainChangeMessage = '已更換隊長，待新隊長確認組隊。';
const reopenedEventMessage = '已重新開啟賽事，可在流程 4 新增階段或對戰。';
const stageMessages = {
  createMedalStage: '已建立冠軍戰與季軍戰。',
  saveGroups: '已儲存預賽分組。', createStage: '已新增階段，請安排本階段對戰。',
  generateStage: '已產生本階段組內循環。', addStageMatch: '已加入這場對戰。',
  removeStageMatch: '已移除此場對戰。', deleteStage: '已移除空階段。'
};
const teamActions = {
  add: '已加入勾選的隊員。', remove: '已移除隊員。', leave: '已退出隊伍。',
  completeTeam: '已確認組隊完成，大會可查看。', lineup: '已提交出賽名單。'
};

function eventLink(id, label) {
  return '<button type="button" data-open-event="' + esc(id) + '">' + esc(label) + '</button>';
}

function dashboard(view, announcement, message) {
  const groups = [
    ['active', '進行中賽事', view.events.filter(event => !event.archived)],
    ['archive', '完賽紀錄', view.events.filter(event => event.archived)]
  ];
  const tabs = groups.map(([key, label]) => [key, label]);
  if (view.organizer) tabs.push(['members', '會員管理']);
  const sections = groups.map(([key, label, events]) => '<section data-panel="' + key + '"' +
    (key === dashboardPanel ? '' : ' hidden') + '><h2>' + label + '</h2>' +
    (key === 'archive' && message ? '<p id="archive-feedback" role="status" tabindex="-1">' + esc(message) + '</p>' : '') +
    (key === 'active' && view.organizer ? '<details><summary>建立賽事</summary>' + announcement + '</details>' +
      (view.canCreateSeededDemo ? form('createSeededDemo',
        '<button>建立六隊種子測試賽</button><p role="alert"></p>') : '') +
      (view.canCreateInvitationalDemo ? form('createInvitationalDemo',
        '<button>建立六隊會內賽模擬</button><p>圖片名單 60 人，5 點雙打。模擬六隊循環、平均分組循環、四強及冠季賽，共 25 場。</p><p role="alert"></p>') : '') : '') +
    (events.length ? '<ul>' + events.map(event => {
      const phase = event.draft ? '草稿' :
        event.fixtureCount && event.finishedCount === event.fixtureCount ? '待大會確認完賽' :
          { signup: '報名中', grouping: '組隊中', locked: '對戰中' }[event.phase];
      const status = event.archived ? [
        '開團日期 ' + (event.openedOn ?? '未記錄'),
        event.archivedOn ? '完賽日期 ' + event.archivedOn : '',
        '首名 ' + event.leaders.join('、'), event.teamCount + ' 隊'
      ].filter(Boolean).join(' · ') :
        phase + ' · ' + event.playerCount + ' 人報名 · ' + event.finishedCount + '／' + event.fixtureCount + ' 場完賽' +
        (event.disputed ? ' · 待大會處理比分異議' : '');
      const label = '編號 ' + event.number + ' · ' + event.title;
      const deleteControl = event.archived && view.organizer
        ? ' <form class="archive-delete" data-action="deleteArchivedEvent" data-event-label="' + esc(label) +
          '"><input type="hidden" name="eventId" value="' + esc(event.id) + '">' +
          '<button aria-label="刪除賽事 ' + esc(label) + '">刪除賽事</button><p role="alert"></p></form>'
        : '';
      return '<li>' + eventLink(event.id, label) + (event.fixtureCount ? ' ' + boardLink(event.id) : '') +
        deleteControl + '<p>' + esc(status) + '</p></li>';
    }).join('') + '</ul>' : '<p>目前沒有賽事。</p>') + '</section>').join('');
  const members = view.organizer ? '<section data-panel="members"' +
    (dashboardPanel === 'members' ? '' : ' hidden') + '><h2>全站會員名冊</h2>' +
    '<p>共 ' + view.members.length + ' 位會員。</p>' +
    (dashboardPanel === 'members' && message ? '<p id="member-feedback" role="status" tabindex="-1">' + esc(message) + '</p>' : '') +
    form('addMember', '<label>會員名稱 <input name="name" maxlength="40" required></label><button>新增會員</button><p role="alert"></p>') +
    '<label>搜尋會員 <input id="member-search" type="search"></label><ul>' +
    view.members.map(member => '<li data-member="' + esc(member.name.toLowerCase()) + '"><div class="member-row"><details><summary>' +
      esc(member.number ?? '') + ' · ' + esc(member.name) + (member.demo ? '（測試）' : member.manual ? '（名冊會員）' : '') +
      (member.organizer ? ' <span class="member-role">大會管理員</span>' : '') +
      ' · ' + member.history.length + ' 場參賽</summary>' +
      (member.history.length ? member.history.map(event => eventLink(event.id, event.title)).join(' ') :
      '<p>目前沒有參賽紀錄。</p>') + '</details>' +
      (member.number && !member.manual && !member.demo ? form('issueMemberReset',
        '<input type="hidden" name="memberId" value="' + esc(member.id) +
        '"><button data-reset-member="' + esc(member.number) + '">重設登入代號</button><p role="alert"></p>') : '') +
      (member.organizer ? '' : form('removeMember', '<input type="hidden" name="memberId" value="' +
        esc(member.id) + '"><button class="remove-match" aria-label="刪除 ' + esc(member.name) +
        '" data-member-name="' + esc(member.name) + '">刪除</button><p role="alert"></p>')) +
      '</div></li>').join('') + '</ul></section>' : '';
  return '<nav aria-label="賽事分區">' + tabs.map(([key, label]) => '<button type="button" data-panel-tab="' +
    key + '" aria-pressed="' + (key === dashboardPanel) + '">' + label + '</button>').join(' ') + '</nav>' + sections + members;
}

function render(view, message = '') {
  const { organizer, player, event, teams, players, team, blocked, fixtures,
    memberCount, unenrolledMembers, setupPending, limitedMode } = view;
  const captain = Boolean(team && player && team.captainId === player.id);
  const captainEvents = view.events?.filter(entry => entry.captain) ?? [];
  const greeting = ({ teamName, playerName }) => '恭迎' + teamName + '隊長 ' + playerName;
  let label = organizer ? '大會管理' : team ? '隊員專區' : user ? (event ? '未入隊選手' : '會員專區') : '大會看板';
  if (!organizer && captain) label = greeting({ teamName: team.name, playerName: player.name });
  if (!organizer && captainEvents.length) label = captainEvents.length === 1 ? greeting(captainEvents[0].captain) : '隊長專區';
  const roleHeading = '<section><h2>' + esc(label) + '</h2>' +
    (!user && !organizer && !event ? '<p>選擇賽事查看對戰進度、比分與排名。</p>' : '') +
    (!organizer && captainEvents.length > 1 ? list(captainEvents.map(entry => entry.title + ' · ' + greeting(entry.captain))) : '') +
    (team && !captain ? '<p>我的隊伍：' + esc(team.name) + '</p>' : '') +
    (organizer && !view.events && !view.eventId ? '<p>會員名冊共 ' + (memberCount ?? 0) + ' 人。</p>' : '') +
    (setupPending ? '<p>資料庫尚未接通，目前可查看介面。</p>' : '') +
    (limitedMode ? '<p>目前開放大會管理公告與名單，選手可查看公告。</p>' : '') + '</section>';
  if (!event) {
    const announcement = organizer ? '<section><h2>發布賽事公告</h2>' + form('publish',
      '<fieldset' + (setupPending ? ' disabled' : '') + '><legend>賽事設定</legend>' +
      '<label>賽名 <input name="title" maxlength="80" required></label>' +
      '<label>報名截止 <input name="signupDeadline" type="date" required></label>' +
      (view.events ? '' : '<label>完賽期限 <input name="deadline" type="date" required></label>') +
      '<p>預賽採團體循環，可在截止報名後分組。各點可分開約期。</p>' +
      '<label>每場總點數 <select id="point-count">' + [1, 3, 5, 7, 9].map(count =>
        '<option' + (count === 3 ? ' selected' : '') + '>' + count + '</option>').join('') + '</select></label>' +
      '<div id="point-types"></div>' +
      '<label>每隊最低人數（含隊長） <input name="teamSize" type="number" min="1" max="18" value="3" required></label>' +
      nextAction('發布公告') + (view.events ? ' <button name="draft" value="yes">儲存草稿</button>' : '') +
      '</fieldset>') + '</section>' :
      '<section><h2>賽事公告</h2><p>目前沒有可報名的賽事。</p>' +
      (user ? '<p>公告開放後，可用目前帳號登記參賽。</p>' : '<p>登入後即可登記已開放的賽事。</p>') + '</section>';
    const examples = organizer && (setupPending || limitedMode) ? '<details><summary>預覽選手介面</summary>' +
      '<h3>隊員專區</h3><p>範例：我的隊伍 · 松風隊。排陣揭曉後，這裡顯示自己的對戰。</p>' +
      '<h3>未入隊選手</h3><p>查看賽事公告及報名狀態。大會開始組隊後，可查看自己的入隊狀態。</p></details>' : '';
    screen.innerHTML = roleHeading + (view.events ? dashboard(view, announcement, message) : announcement + examples);
    if (organizer) {
      const count = screen.querySelector('#point-count');
      const points = screen.querySelector('#point-types');
      const minimum = screen.querySelector('input[name="teamSize"]');
      const suggest = () => {
        const sizes = Array.from(points.querySelectorAll('select'), select => Number(select.value));
        minimum.min = Math.max(...sizes);
        minimum.value = sizes.reduce((sum, size) => sum + size, 0);
      };
      const update = () => { renderPoints(points, Number(count.value)); suggest(); };
      count.addEventListener('change', update);
      points.addEventListener('change', suggest);
      update();
    }
    return;
  }
  const heading = '<section><h2>' + esc(event.title) + '</h2><p>' +
    (view.eventNumber ? '編號 ' + view.eventNumber + ' · 開團日期 ' + esc(view.openedOn ?? '未記錄') + ' · ' : '') +
    '報名截止 ' + esc(event.signupDeadline) + ' · 每隊至少 ' + esc(event.teamSize) + ' 人（含隊長）</p>' +
    '<p>' + (event.preferredSchedule === 'manual' ? '首輪由大會手動排定。' :
      event.groupCount ? '預賽分 ' + event.groupCount + ' 組進行組內循環。' : '預賽採團體循環。') +
    '每場順序：' +
    esc(formats[event.matchFormat] ?? Array.from(event.matchFormat, point => point === '1' ? '單打' : '雙打').join('、')) +
    '。</p>' + (view.eventId && view.matchups?.length ? '<p>' + boardLink(view.eventId) + '</p>' : '') +
    (view.draft ? '' : registrationRoster(view.registeredPlayers)) + '</section>';
  const back = view.eventId ? '<p>' + eventLink('', '返回賽事首頁') + '</p>' : '';
  if (view.draft) {
    screen.innerHTML = roleHeading + back + heading + '<section><h2>草稿</h2>' +
      workflowNotice('pending', '大會下一步：發布賽事', '核對賽制及報名截止日後，發布賽事開放報名。') +
      form('publishDraft', nextAction('發布這場賽事')) + '</section>';
    return;
  }
  let content;
  if (event.phase === 'locked') {
    content = '<h2>比賽賽程</h2>' +
      (fixtures ? '' : '<p>請登入會員帳號查看對戰表。</p>') +
      (captain && !view.archived && view.lineups?.length ? captainLineups(view, message) : '') +
      (fixtures && !fixtures.length ? '<p>等待大會排定對戰。</p>' : '') +
      (!organizer && view.matchups?.length ? '<h2>' + (user ? '出賽名單與各點賽果' : '各階段對戰與比分') + '</h2>' +
        (view.matchups.some(match => match.points.some(point => point.canScore)) ?
          workflowNotice('pending', '下一步：登錄本點比分', '展開紅色標題的場次，處理紅框點次。出賽選手也可把比分回報給隊長代登。') : '') +
        stageMatchups(view, false, !user) + '<h2>比賽排名</h2>' + stageRankings(view) : '');
  } else if (event.phase === 'signup' && (organizer || (!team && !blocked?.length))) {
    const signup = player ? '<p>' + esc(player.name) + '，你已報名。</p>' :
      limitedMode ? '<p>選手自行報名尚未開放。</p>' :
      user ? form('register', '<label>本場參賽名稱 <input name="name" maxlength="40" required autocomplete="off">' +
        '</label><p>每場比賽可使用不同名稱。此名稱會公開顯示，請勿使用登入代號。</p><button>' +
        (organizer ? '報名參賽' : '報名') + '</button><p role="alert"></p>') : '<p>請登入後報名。</p>';
    content = '<h2>個人報名</h2>' + signup + (organizer ?
      (!limitedMode && unenrolledMembers?.length ? '<details><summary>從會員名冊加入本場參賽者</summary>' +
        form('enrollMembers', checkboxes(unenrolledMembers, 'members') + '<button>將勾選會員加入本場報名</button><p role="alert"></p>') + '</details>' : '') +
      (view.fixturePreview?.length ? '' : form('close',
        nextAction('截止報名', players.length >= event.teamSize * 2) + '<p role="alert"></p>')) : '');
  } else if (organizer) {
    const free = players.filter(item => !teams.some(group => group.playerIds.includes(item.id)));
    const names = new Map(players.map(item => [item.id, item.name]));
    content = '<h2>指定隊長與確認名單</h2>' + list(teams.map(group => group.name + '（隊長 ' +
      names.get(group.captainId) + '） · ' + group.playerIds.map(id => names.get(id)).join('、'))) +
      '<p>待組隊：' + (free.map(item => esc(item.name)).join('、') || '無') + '</p>' +
      (!limitedMode ? form('reopen', '<label>新報名截止日 <input name="signupDeadline" type="date" value="' +
        esc(event.signupDeadline) + '" required></label><button>重新開放報名</button>') : '');
  } else if (player) {
    content = '<h2>我的隊伍</h2>' +
      (team ? '<p>' + esc(team.name) + ' · ' + team.members.length + ' 人 · ' + teamRosterStatus(team, event) + '</p>' : '') +
      teamRoster(view, captain, message) +
      (view.fixturePreview?.length ? '<h3>對戰預覽</h3>' + list(view.fixturePreview.map(pair => pair.join(' vs '))) +
        '<p>大會鎖定名單後，即可排點。</p>' : '');
  } else {
    content = '<h2>組隊中</h2><p>個人報名已截止。</p>';
  }
  screen.innerHTML = roleHeading + back + (view.archived ? '<p>已移入完賽紀錄</p>' : '') +
    (organizer && view.archived && event.phase === 'locked' ? form('reopenEvent',
      '<button>重新開啟賽事</button><p role="alert"></p>') : '') +
    (message === reopenedEventMessage ? '<p id="reopen-feedback" role="status" tabindex="-1">' + esc(message) + '</p>' : '') +
    (organizer ? organizerFlow(view, heading, captain, message) : heading) +
    (organizer && event.phase === 'locked' && view.stages ? '' : '<section>' + content + '</section>');
}

async function send(data, submittedForm) {
  if (busy) return;
  const active = session;
  busy = true;
  status.textContent = '';
  const feedback = submittedForm?.querySelector('[role="alert"]') ?? status;
  feedback.textContent = '';
  screen.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    const headers = { 'Content-Type': 'application/json' };
    const response = await fetch('/api/registration', { method: 'POST', headers,
      body: JSON.stringify({ eventId: activeEventId, ...data }) });
    const view = await response.json();
    if (active !== session) return;
    if (!response.ok) {
      if (response.status === 401 && user) {
        user = null;
        accountUi();
      }
      feedback.textContent = view.error || '無法完成操作。';
      return;
    }
    accountUi(view.organizer);
    const deleted = data.action === 'deleteArchivedEvent';
    const removedMember = data.action === 'removeMember';
    const message = deleted ? '已刪除賽事及其完賽紀錄。' :
      removedMember ? '已從全站會員名冊刪除。' :
      data.action === 'replaceCaptain' ? captainChangeMessage :
      data.action === 'reopenEvent' ? reopenedEventMessage :
        Object.hasOwn(teamActions, data.action) ? teamActions[data.action] : '';
    const detailSelector = 'details[data-match-id], details[data-stage-panel]';
    const detailKey = item => item.dataset.matchId ?? 'stage-' + item.dataset.stagePanel;
    const openStates = new Map(view.eventId && view.eventId === activeEventId ?
      Array.from(screen.querySelectorAll(detailSelector), item => [detailKey(item), item.open]) : []);
    const keepMatchStepOpen = openStates.size &&
      screen.querySelector('[data-stage-panel]')?.closest('.event-flow > li > details')?.open;
    activeEventId = view.eventId ?? null;
    if (data.action === 'archive' || deleted) dashboardPanel = 'archive';
    if (data.action === 'reopenEvent') dashboardPanel = 'active';
    render(view, message);
    for (const item of screen.querySelectorAll(detailSelector)) {
      const key = detailKey(item);
      if (openStates.has(key)) item.open = openStates.get(key);
    }
    if (keepMatchStepOpen && data.action !== 'archive') {
      const step = screen.querySelector('[data-stage-panel]')?.closest('.event-flow > li > details');
      if (step) step.open = true;
    }
    if (Object.hasOwn(stageMessages, data.action)) {
      const stageFeedback = screen.querySelector('#stage-feedback') ?? status;
      stageFeedback.textContent = stageMessages[data.action];
      stageFeedback.focus();
    }
    if (message) screen.querySelector(deleted ? '#archive-feedback' :
      removedMember ? '#member-feedback' :
      data.action === 'replaceCaptain' ? '#captain-feedback' :
        data.action === 'reopenEvent' ? '#reopen-feedback' : '#team-feedback')?.focus();
  } catch {
    if (active === session) feedback.textContent = '無法連線到試用服務，請重新整理。';
  } finally {
    if (active === session) {
      busy = false;
      screen.querySelectorAll('button').forEach(button => { button.disabled = false; });
    }
  }
}

function accountUi(organizer = false) {
  identity.textContent = user ? (organizer ? '大會 · ' : '會員 · ') + user.number : '尚未登入';
  document.querySelector('#my-code').textContent = user?.code ?? '';
  document.querySelector('#my-account').hidden = !user;
  login.hidden = Boolean(user);
  logout.hidden = !user;
  refresh.hidden = false;
}

async function accountRequest(data) {
  const response = await fetch('/api/account', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
  });
  const body = await response.json();
  if (!response.ok) throw Error(body.error || '無法完成登入操作。');
  return body;
}

async function showResetLink(form, memberId) {
  const button = form.querySelector('button');
  const feedback = form.querySelector('[role="alert"]');
  if (!window.confirm('為 ' + button.dataset.resetMember + ' 產生登入代號重設連結？')) return;
  button.disabled = true;
  feedback.replaceChildren();
  try {
    const { token } = await accountRequest({ action: 'issueMemberReset', memberId });
    const link = new URL(window.location.pathname, window.location.origin);
    link.hash = 'reset=' + token;
    const input = document.createElement('input');
    input.value = link.href;
    input.readOnly = true;
    input.setAttribute('aria-label', '一次性重設連結');
    feedback.append('請私下交給會員，連結 30 分鐘內有效。', input);
    input.select();
  } catch (error) {
    feedback.textContent = error.message;
  } finally {
    button.disabled = false;
  }
}

function showResetForm(token) {
  document.querySelector('#account').hidden = true;
  const resetForm = document.querySelector('#reset-login');
  resetForm.hidden = false;
  resetForm.onsubmit = async event => {
    event.preventDefault();
    const button = resetForm.querySelector('button');
    button.disabled = true;
    status.textContent = '';
    try {
      await accountRequest({ action: 'redeemMemberReset', token, code: new FormData(resetForm).get('code') });
      resetForm.reset();
      resetForm.hidden = true;
      document.querySelector('#account').hidden = false;
      await changeUser(null);
      status.textContent = '已重設登入代號，請用新代號登入。';
    } catch (error) {
      status.textContent = error.message;
    } finally {
      button.disabled = false;
    }
  };
}

async function changeUser(current) {
  session++;
  activeEventId = null;
  dashboardPanel = 'active';
  user = current;
  busy = false;
  screen.replaceChildren();
  accountUi();
  await send({ action: 'view' });
}
login.onsubmit = async event => {
  event.preventDefault();
  const fields = new FormData(login);
  const signup = event.submitter?.value === 'signup';
  login.querySelectorAll('button').forEach(button => { button.disabled = true; });
  try {
    const body = await accountRequest({ action: signup ? 'signup' : 'login',
      code: fields.get('username') });
    login.reset();
    await changeUser(body.user);
  } catch (error) {
    status.textContent = error.message;
  } finally {
    login.querySelectorAll('button').forEach(button => { button.disabled = false; });
  }
};
logout.onclick = async () => {
  try {
    await accountRequest({ action: 'logout' });
    await changeUser(null);
  } catch (error) {
    status.textContent = error.message;
  }
};
refresh.onclick = () => send({ action: 'view' });
screen.addEventListener('click', event => {
  const stageToggle = event.target.closest('[data-toggle-stage]');
  if (stageToggle) {
    const editor = screen.querySelector('[data-create-stage]');
    editor.hidden = !editor.hidden;
    stageToggle.setAttribute('aria-expanded', String(!editor.hidden));
    if (!editor.hidden) editor.querySelector('input[name="name"]').focus();
    return;
  }
  const nextStage = event.target.closest('[data-next-stage]');
  if (nextStage) {
    const editor = screen.querySelector(nextStage.dataset.nextStage === 'medal' ? '[data-medal-editor]' : '[data-create-stage]');
    if (!editor) return;
    const step = editor.closest('.event-flow > li > details');
    step.open = true;
    if (editor.matches('[data-create-stage]')) {
      editor.hidden = false;
      screen.querySelector('[data-toggle-stage]').setAttribute('aria-expanded', 'true');
    } else {
      editor.open = true;
    }
    const field = editor.querySelector('input[name="name"]');
    field.focus({ preventScroll: true });
    editor.scrollIntoView({ block: 'start' });
    return;
  }
  const eventButton = event.target.closest('[data-open-event]');
  if (eventButton) send({ action: 'view', eventId: eventButton.dataset.openEvent || null });
  const tab = event.target.closest('[data-panel-tab]');
  if (!tab) return;
  dashboardPanel = tab.dataset.panelTab;
  screen.querySelectorAll('[data-panel]').forEach(panel => { panel.hidden = panel.dataset.panel !== tab.dataset.panelTab; });
  screen.querySelectorAll('[data-panel-tab]').forEach(button => { button.setAttribute('aria-pressed', String(button === tab)); });
});
screen.addEventListener('input', event => {
  if (event.target.id !== 'member-search') return;
  const query = event.target.value.trim().toLowerCase();
  screen.querySelectorAll('[data-member]').forEach(item => { item.hidden = !item.dataset.member.includes(query); });
});
screen.addEventListener('change', event => {
  const control = event.target;
  if (control.matches('[data-schedule-mode]')) {
    control.form.querySelectorAll('[data-schedule-help]').forEach(section => {
      section.hidden = section.dataset.scheduleHelp !== control.value;
      if (section.matches('fieldset')) section.disabled = section.hidden;
    });
  }
  if (control.matches('form[data-action="addStageMatch"] select:is([name="home"],[name="away"])')) {
    const { home, away } = control.form.elements;
    for (const [select, other] of [[home, away], [away, home]]) {
      for (const option of select.options) {
        option.hidden = Boolean(option.value) && option.value === other.value;
        option.disabled = option.hidden;
      }
    }
  }
  if (control.matches('[data-group-count]')) {
    const count = Number(control.value);
    const teams = [...control.form.querySelectorAll('[data-group-team]')];
    teams.forEach((select, index) => {
      select.replaceChildren(...Array.from({ length: count }, (_, group) => new Option(String.fromCharCode(65 + group) + ' 組', group)));
      select.value = Math.floor(index * count / teams.length);
    });
  }
  if (control.matches('[data-stage-selection]')) {
    control.form.querySelectorAll('[data-team-selection]').forEach(fields => {
      fields.hidden = fields.dataset.teamSelection !== control.value;
      fields.disabled = fields.hidden;
    });
  }
});
screen.addEventListener('submit', event => {
  event.preventDefault();
  if (busy) return;
  const fields = new FormData(event.target, event.submitter);
  const action = fields.has('draft') ? 'createDraft' : event.target.dataset.action;
  if (action === 'issueMemberReset') {
    showResetLink(event.target, fields.get('memberId'));
    return;
  }
  if (action === 'archive' && !window.confirm('確定整場賽事已結束並移入完賽紀錄？若還要加賽，請取消並回流程 4。')) return;
  if (action === 'removeStageMatch' &&
      !window.confirm('確定移除「' + event.target.querySelector('[data-match-label]').dataset.matchLabel + '」？')) return;
  if (action === 'removeMember' && !window.confirm('確定從全站會員名冊刪除「' +
      event.target.querySelector('[data-member-name]').dataset.memberName + '」？歷史賽事仍會保留。')) return;
  if (action === 'deleteArchivedEvent' && !window.confirm('確定刪除「' + event.target.dataset.eventLabel +
    '」？這場賽事的名單、比分和排名會一併刪除，無法從網站復原。')) return;
  if (action === 'lineup' && !confirmRepeatedStarters(event.target)) return;
  const matchFormat = ['publish', 'createDraft'].includes(action) ? fields.getAll('pointType').join('') : undefined;
  fields.delete('pointType');
  const selection = action === 'add' ? { players: fields.getAll('players') } :
    action === 'enrollMembers' ? { members: fields.getAll('members') } :
      action === 'lineup' ? { starters: fields.getAll('starter') } : {};
  if (action === 'createStage') selection.teams = fields.getAll('teams');
  if (action === 'createStage' || action === 'lock') selection.singleMatch = fields.has('singleMatch');
  if (action === 'createMedalStage') selection.pairs = JSON.parse(fields.get('pairs'));
  if (action === 'saveGroups' || action === 'generateStage') {
    selection.groups = Array.from({ length: Number(event.target.querySelector('[data-group-count]').value) }, () => []);
    event.target.querySelectorAll('[data-group-team]').forEach(select => selection.groups[Number(select.value)].push(select.dataset.groupTeam));
  }
  if (action === 'add' && !selection.players.length) {
    event.target.querySelector('[role="alert"]').textContent = '請至少勾選一位隊員。';
    return;
  }
  if (action === 'completeTeam' && screen.querySelector('form[data-action="add"] input:checked')) {
    event.target.querySelector('[role="alert"]').textContent = '請先按「加入勾選的隊員」儲存名單，再完成組隊。';
    return;
  }
  send({ ...Object.fromEntries(fields), ...selection, action, matchFormat,
    acceptUnassigned: fields.has('acceptUnassigned') }, event.target);
});

function boardLink(id) {
  return '<a class="board-link" href="?board=' + esc(encodeURIComponent(id)) +
    '" target="_blank" rel="noopener">大螢幕看板</a>';
}

async function startBoard(eventId) {
  document.body.classList.add('board-mode');
  const toolbar = document.querySelector('#board-toolbar');
  const updated = document.querySelector('#board-updated');
  toolbar.hidden = false;
  toolbar.querySelector('button').addEventListener('click', async () => {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch {
      status.textContent = '可按 F11 切換瀏覽器全螢幕。';
    }
  });
  let lastMarkup;
  async function poll() {
    try {
      const response = await fetch('/api/board?eventId=' + encodeURIComponent(eventId), {
        credentials: 'omit', signal: AbortSignal.timeout(10000)
      });
      const view = await response.json();
      if ([403, 404, 503].includes(response.status)) {
        screen.replaceChildren();
        lastMarkup = '';
        status.textContent = view.error || '目前無法確認球團的啟用狀態。';
        return;
      }
      if (!response.ok || !view.event) throw Error('找不到賽事');
      const matches = view.matchups ?? [];
      const finished = matches.filter(match => match.summary.complete).length;
      const state = view.archived ? '已完賽' :
        matches.length && finished === matches.length ?
          (view.placements?.length === 4 ? '場次已打完・名次已出爐' : '目前排定的場次已打完') :
          { signup: '報名中', grouping: '組隊中', locked: '對戰中' }[view.event.phase];
      const markup = '<section class="board-heading"><h2>' + esc(view.event.title) + '</h2><p>' +
        esc(state) + ' · 已完成 ' + finished + '／' + matches.length + ' 場</p></section>' +
        (view.simulationNotes ? '<section><details><summary>模擬賽設定與分組方式</summary>' +
          list(view.simulationNotes) + '</details></section>' : '') +
        knockoutBoard(view, esc) +
        '<section><h2>比賽排名</h2>' + (view.stages?.length ? stageRankings(view) : '<p>待大會產生賽程。</p>') +
        '</section><section><h2>對戰進度與比分</h2>' +
        (matches.length ? stageMatchups(view, false, true) : '<p>尚未安排對戰。</p>') + '</section>';
      if (markup !== lastMarkup) {
        const selector = 'details[data-match-id],details[data-stage-panel],details[data-ranking-stage]';
        const key = item => item.dataset.matchId ?? (item.dataset.stagePanel ?
          'match-' + item.dataset.stagePanel : 'rank-' + item.dataset.rankingStage);
        const opened = new Map(Array.from(screen.querySelectorAll(selector), item => [key(item), item.open]));
        const scrollSelector = '.matrix-scroll,.bracket-scroll';
        const scroll = Array.from(screen.querySelectorAll(scrollSelector), item => item.scrollLeft);
        screen.innerHTML = markup;
        screen.querySelectorAll(selector).forEach(item => {
          if (opened.has(key(item))) item.open = opened.get(key(item));
        });
        screen.querySelectorAll(scrollSelector).forEach((item, index) => { item.scrollLeft = scroll[index] ?? 0; });
        lastMarkup = markup;
      }
      updated.textContent = '最後更新 ' + new Date().toLocaleTimeString('zh-TW', { timeZone: 'Asia/Taipei', hour12: false });
      status.textContent = '';
    } catch {
      status.textContent = lastMarkup ? '暫時無法更新，正顯示上次取得的賽況。' : '暫時無法載入賽況，稍後會重試。';
    } finally {
      setTimeout(poll, 10000);
    }
  }
  await poll();
}

const resetToken = new URLSearchParams(window.location.hash.slice(1)).get('reset');
if (resetToken) {
  window.history.replaceState(null, '', window.location.pathname);
  showResetForm(resetToken);
} else if (boardEventId) startBoard(boardEventId);
else accountRequest({ action: 'session' }).then(result => changeUser(result.user)).catch(error => {
  accountUi();
  status.textContent = error.message;
});
