const storageKey = 'tball-local-v1';
const screen = document.querySelector('#screen');
const role = document.querySelector('#role');
const statusMessage = document.querySelector('#status');
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, char =>
  ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
let tournament = null;
let registration = null;
try {
  const saved = JSON.parse(localStorage.getItem(storageKey));
  tournament = saved?.fixtures ? saved : saved?.tournament ?? null;
  registration = saved?.registration ?? null;
} catch {
  statusMessage.textContent = '無法讀取先前的本機資料。';
}

function isPlayer() {
  return /^(?:t\d+)?p\d+$/.test(role.value);
}

function renderRoles() {
  const selected = role.value;
  role.replaceChildren(new Option('大會主辦方', 'organizer'));
  if (registration && !tournament) {
    role.add(new Option('新報名選手', 'visitor'));
    for (const player of registration.players) {
      const captain = registration.teams.some(team => team.captainId === player.id);
      role.add(new Option(player.name + (captain ? '｜隊長' : ''), player.id));
    }
  }
  for (const team of tournament?.teams || []) {
    if (!team.captainId) role.add(new Option(team.name + '｜隊長', team.id));
    for (const player of team.players) {
      role.add(new Option(team.name + '｜' + player.name + (team.captainId === player.id ? '（隊長）' : ''), player.id));
    }
  }
  if (Array.from(role.options).some(option => option.value === selected)) role.value = selected;
}

function isCaptainOf(team) {
  return (team.captainId || team.id) === role.value;
}

function renderPoint(fixture, point, index, locked) {
  const sides = pointSides(fixture, index);
  const players = sides.flat();
  const participant = players.includes(role.value);
  if (isPlayer() && (!locked || !participant)) return '';
  const names = sides.map(side => side.map(id => escapeHtml(
    tournament.teams.flatMap(team => team.players).find(player => player.id === id)?.name
  )).join('、')).join(' vs ');
  const appointment = point.appointment;
  const agreed = appointment && players.every(id => appointment.replies[id] === 'yes');
  const rejected = appointment && players.some(id => appointment.replies[id] === 'no');
  const result = point.result;
  const state = result ? { pending: '待對方確認', confirmed: '成績已確認', disputed: '比分有異議' }[result.status] :
    !locked ? '待排陣' : agreed ? '已約期' : rejected ? '待重新約期' : appointment ? '待回覆邀約' : '未約期';
  const form = (action, body) => '<form data-action="' + action + '" data-fixture="' + fixture.id +
    '" data-point="' + index + '">' + body + '</form>';
  return '<div class="point"><h3>第 ' + (index + 1) + ' 點 · ' + (point.format === 1 ? '單打' : '雙打') +
    ' <span class="pill">' + state + '</span></h3>' +
    (locked ? '<p>' + names + '</p>' : '') +
    (appointment ? '<p>' + escapeHtml(appointment.date.replace('T', ' ')) + ' · ' +
      escapeHtml(appointment.place) + ' · ' + players.filter(id => appointment.replies[id] === 'yes').length +
      '/' + players.length + ' 人同意</p>' : '') +
    (result ? '<p>局數 <strong>' + result.score.join('：') + '</strong></p>' : '') +
    (locked && participant && !result ? form('propose',
      '<div class="row"><label>時間 <input name="date" type="datetime-local" required></label>' +
      '<label>地點 <input name="place" required maxlength="80"></label><button>' +
      (appointment ? '提出改期' : '送出邀約') + '</button></div>') : '') +
    (participant && appointment && !result && !agreed ? form('reply',
      '<div class="row"><button name="answer" value="yes">接受時間</button>' +
      '<button class="secondary" name="answer" value="no">拒絕時間</button></div>') : '') +
    (participant && agreed && !result ? form('score',
      '<div class="row"><label>左方局數 <input name="home" type="number" min="0" max="3" required></label>' +
      '<label>右方局數 <input name="away" type="number" min="0" max="3" required></label><button>送出比分</button></div>') : '') +
    (result?.status === 'pending' && sides[1 - result.side].includes(role.value) ? form('confirm',
      '<div class="row"><button name="answer" value="yes">確認比分</button>' +
      '<button class="secondary" name="answer" value="no">比分有異議</button></div>') : '') +
    (role.value === 'organizer' && result?.status === 'disputed' ? form('reopen',
      '<label>重開原因 <input name="reason" required maxlength="120></label><button>退回重填</button>') : '') +
    (point.audit ? '<small>大會退回原因：' + escapeHtml(point.audit.at(-1).reason) + '</small>' : '') + '</div>';
}

function renderFixture(fixture) {
  const teams = fixture.teams.map(id => tournament.teams.find(team => team.id === id));
  const ownTeam = teams.find(isCaptainOf);
  const locked = fixture.teams.every(id => fixture.lineups[id]);
  const content = fixture.points.map((point, index) => renderPoint(fixture, point, index, locked)).join('');
  if (role.value !== 'organizer' && !ownTeam && (!isPlayer() || !content)) return '';
  const done = fixture.points.filter(point => point.result?.status === 'confirmed').length;
  const form = ownTeam && !locked ? '<form data-action="lineup" data-fixture="' + fixture.id + '">' +
    fixture.points.map((point, index) => '<div class="row">' +
      Array.from({ length: point.format }, (_, slot) => '<label>第 ' + (index + 1) + ' 點選手 ' + (slot + 1) +
        ' <select name="player" required><option value="">請選擇</option>' +
        ownTeam.players.map(player => '<option value="' + player.id + '"' +
          (fixture.lineups[ownTeam.id]?.[index]?.[slot] === player.id ? ' selected' : '') +
          '>' + escapeHtml(player.name) + '</option>').join('') + '</select></label>').join('') + '</div>').join('') +
    '<button>提交排陣</button></form>' : '';
  return '<section><h2>' + teams.map(team => escapeHtml(team.name)).join(' vs ') + '</h2><p>' +
    (locked ? '排陣已揭曉' : Object.keys(fixture.lineups).length + '/2 隊已提交排陣') +
    ' · ' + done + '/' + fixture.points.length + ' 點已確認</p>' + form + content + '</section>';
}

const formFor = (action, body) => '<form data-action="' + action + '">' + body + '</form>';
const playerOption = player => '<option value="' + player.id + '">' + escapeHtml(player.name) + '</option>';
const todayInTaiwan = () => new Intl.DateTimeFormat('sv-SE', {
  timeZone: 'Asia/Taipei', year: 'numeric', month: '2-digit', day: '2-digit'
}).format(new Date());

function renderRegistration() {
  if (!registration) return '<section><h2>發布賽事公告</h2>' + formFor('publish',
    '<label>賽名 <input name="title" required maxlength="80"></label>' +
    '<label>報名截止日 <input name="signupDeadline" type="date" required></label>' +
    '<label>完賽期限 <input name="deadline" type="date" required></label>' +
    '<label>每隊人數（含隊長） <input name="teamSize" type="number" min="2" value="3" required></label>' +
    '<button>發布公告</button>') + '</section>';
  const event = registration;
  const organizer = role.value === 'organizer';
  const player = event.players.find(item => item.id === role.value);
  const team = player && findPlayerTeam(event, player.id);
  const free = event.players.filter(item => !findPlayerTeam(event, item.id));
  const heading = '<section><h2>' + escapeHtml(event.title) + '</h2><p>報名截止 ' + escapeHtml(event.signupDeadline) +
    ' · 完賽期限 ' + escapeHtml(event.deadline) + ' · 每隊 ' + event.teamSize + ' 人</p></section>';
  if (event.phase === 'signup') {
    const list = organizer ? '<p>' + event.players.length + ' 人已報名</p><ul>' +
      event.players.map(item => '<li>' + escapeHtml(item.name) + '</li>').join('') + '</ul>' : '';
    return heading + '<section><h2>個人報名</h2>' + list +
      (organizer ? formFor('close', '<button>截止報名，開始組隊</button>') :
        player ? '<p>你已完成報名。</p>' : todayInTaiwan() > event.signupDeadline ? '<p>報名已截止。</p>' :
          formFor('register', '<label>姓名 <input name="name" required maxlength="40"></label><button>登記參賽</button>')) +
      '</section>';
  }
  if (organizer) {
    const roster = event.teams.map(item => '<li>' + escapeHtml(item.name) + '（隊長 ' +
      escapeHtml(event.players.find(person => person.id === item.captainId).name) + '） · ' +
      item.playerIds.map(id => escapeHtml(event.players.find(person => person.id === id).name)).join('、') +
      ' · ' + item.playerIds.length + '/' + event.teamSize + '</li>').join('');
    return heading + '<section><h2>指定隊長與確認名單</h2><ul>' + roster + '</ul><p>待組隊：' +
      (free.map(item => escapeHtml(item.name)).join('、') || '無') + '</p>' +
      (free.length ? formFor('captain', '<label>隊長 <select name="player">' + free.map(playerOption).join('') +
        '</select></label><label>隊名 <input name="name" required maxlength="40"></label><button>指定隊長</button>') : '') +
      formFor('lock', (free.length ? '<label><input type="checkbox" name="acceptUnassigned" required> 已確認未組隊選手，本次賽程不納入這些選手</label>' : '') +
        '<button>鎖定名單並產生循環賽程</button>') + '</section>';
  }
  if (!player) return heading + '<section>個人報名已截止。</section>';
  const eligible = team?.captainId === player.id
    ? free.filter(item => !item.blockedTeams.includes(team.id)) : [];
  const add = eligible.length ? formFor('add', '<label>已私下談定的選手 <select name="player">' +
    eligible.map(playerOption).join('') + '</select></label><button>加入隊伍</button>') : '';
  const leave = team && team.captainId !== player.id ? formFor('leave', '<button class="secondary">退出此隊</button>') : '';
  const unblock = event.teams.filter(item => player.blockedTeams.includes(item.id)).map(item =>
    formFor('allow', '<input type="hidden" name="team" value="' + item.id +
      '"><button class="secondary">允許「' + escapeHtml(item.name) + '」再加入我</button>')).join('');
  return heading + '<section><h2>我的隊伍</h2><p>' + (team ? escapeHtml(team.name) + ' · ' +
    team.playerIds.length + '/' + event.teamSize + ' 人' : '尚未加入隊伍') + '</p>' +
    (team ? '<ul>' + team.playerIds.map(id => '<li>' +
      escapeHtml(event.players.find(item => item.id === id).name) +
      (team.captainId === id ? '（隊長）' : '') + '</li>').join('') + '</ul>' : '') + add + leave + unblock + '</section>';
}

function render() {
  if (!tournament) {
    screen.innerHTML = renderRegistration();
    return;
  }
  const matches = tournament.fixtures.map(renderFixture).join('');
  screen.innerHTML = '<section><h2>' + escapeHtml(tournament.title) + '</h2><p>完賽期限 ' +
    escapeHtml(tournament.deadline) + '</p><table><thead><tr><th>隊伍</th><th>勝場</th><th>敗場</th><th>得點</th></tr></thead><tbody>' +
    standings(tournament).map(team => '<tr><td>' + escapeHtml(team.name) + '</td><td>' + team.won +
      '</td><td>' + team.lost + '</td><td>' + team.points + '</td></tr>').join('') +
    '</tbody></table><small>只彙總三點都已確認的團體場次。試跑依勝場、總得點排序。</small></section>' +
    '<h2>' + (role.value === 'organizer' ? '全賽事進度' : '我的對戰') + '</h2>' +
    (matches || '<section>目前沒有已揭曉的個人對戰。</section>');
}

screen.addEventListener('submit', event => {
  event.preventDefault();
  const { action, fixture: fixtureId, point: pointIndex } = event.target.dataset;
  const fields = new FormData(event.target, event.submitter);
  const fixture = tournament?.fixtures.find(item => item.id === fixtureId);
  const point = fixture?.points[Number(pointIndex)];
  const before = JSON.stringify({ registration, tournament });
  const previousRole = role.value;
  try {
    let nextRole = role.value;
    if (!tournament) {
      if (action === 'publish' && !registration && role.value === 'organizer') {
        if (fields.get('signupDeadline') < todayInTaiwan()) throw Error('報名截止日不可早於今天。');
        registration = createRegistration(fields.get('title').trim(), fields.get('signupDeadline'),
          fields.get('deadline'), Number(fields.get('teamSize')));
      }
      if (action === 'register' && role.value === 'visitor') {
        nextRole = registerPlayer(registration, fields.get('name').trim(), todayInTaiwan()).id;
      }
      if (role.value === 'organizer') {
        if (action === 'close') closeRegistration(registration);
        if (action === 'captain') designateCaptain(registration, fields.get('player'), fields.get('name').trim());
        if (action === 'lock') tournament = lockRegistration(registration, fields.has('acceptUnassigned'));
      }
      if (action === 'add') addTeamPlayer(registration, role.value, fields.get('player'));
      if (action === 'leave') leaveTeam(registration, role.value);
      if (action === 'allow') allowRejoin(registration, role.value, fields.get('team'));
    } else if (action === 'lineup') {
      const ids = fields.getAll('player');
      const team = tournament.teams.find(item => fixture.teams.includes(item.id) && isCaptainOf(item));
      if (!team) throw Error('只有這場對戰的隊長可以提交排陣。');
      let offset = 0;
      submitLineup(tournament, fixture, team.id, fixture.points.map(item => {
        const selections = ids.slice(offset, offset + item.format);
        offset += item.format;
        return selections;
      }));
    } else if (point && fixture.teams.every(id => fixture.lineups[id])) {
      const sides = pointSides(fixture, Number(pointIndex));
      const players = sides.flat();
      if (action === 'propose') propose(tournament, point, players, role.value, fields.get('date'), fields.get('place').trim());
      if (action === 'reply') reply(point, players, role.value, fields.get('answer'));
      if (action === 'score') submitScore(point, sides, role.value, [Number(fields.get('home')), Number(fields.get('away'))]);
      if (action === 'confirm') confirmScore(point, sides, role.value, fields.get('answer') === 'yes');
      if (action === 'reopen' && role.value === 'organizer' && point.result?.status === 'disputed') {
        const reason = fields.get('reason').trim();
        if (!reason) throw Error('請填寫退回原因。');
        (point.audit ||= []).push({ reason, result: point.result, at: new Date().toISOString() });
        delete point.result;
      }
    }
    localStorage.setItem(storageKey, JSON.stringify({ registration, tournament }));
    statusMessage.textContent = '';
    renderRoles();
    if (Array.from(role.options).some(option => option.value === nextRole)) role.value = nextRole;
    render();
  } catch (error) {
    ({ registration, tournament } = JSON.parse(before));
    role.value = previousRole;
    statusMessage.textContent = error.message;
  }
});

role.addEventListener('change', () => {
  statusMessage.textContent = '';
  render();
});
renderRoles();
render();
