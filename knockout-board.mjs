const isKnockout = stage => stage.mode === 'knockout' ||
  (stage.mode === 'manual' && stage.singleMatch !== false);

function winner(match) {
  const [home, away] = match.summary.wins;
  return match.summary.complete && home !== away ? match.teamIds[home > away ? 0 : 1] : null;
}

function makeRounds(stages, matches) {
  return stages.map((stage, index) => {
    const fixtures = matches.filter(match => match.stageId === stage.id);
    const scheduled = new Set(fixtures.flatMap(match => match.teamIds));
    const nextScheduled = new Set(matches.filter(match => match.stageId === stages[index + 1]?.id &&
      match.kind !== 'third').flatMap(match => match.teamIds));
    const cards = fixtures.filter(match => match.kind !== 'third').map(match => ({
      match, teamIds: match.teamIds, advances: winner(match)
    }));
    const allFinished = fixtures.length > 0 && fixtures.every(match => match.summary.complete);
    const teams = new Map(stage.rankings.flatMap(group => group.rows.map(team => [team.id, team.name])));
    for (const id of teams.keys()) {
      const bye = stage.byeTeams?.includes(id) || nextScheduled.has(id);
      if (!scheduled.has(id) && (allFinished || bye)) {
        cards.push({ teamIds: [id], name: teams.get(id), advances: bye ? id : null });
      }
    }
    if (stage.byeTeams?.length) {
      const order = stage.groups.flat();
      cards.sort((a, b) => Math.min(...a.teamIds.map(id => order.indexOf(id))) -
        Math.min(...b.teamIds.map(id => order.indexOf(id))));
    }
    return { name: stage.name, cards, bronze: fixtures.filter(match => match.kind === 'third') };
  });
}

export function knockoutGroups(stages = [], matches = []) {
  const groups = [];
  let run = [];
  function finishRun() {
    if (!run.length) return;
    const ids = new Set(run.map(stage => stage.id));
    const fixtures = matches.filter(match => ids.has(match.stageId));
    if (fixtures.length) groups.push({ rounds: makeRounds(run, fixtures) });
    run = [];
  }
  for (const stage of stages) {
    if (isKnockout(stage)) run.push(stage);
    else finishRun();
  }
  finishRun();
  return groups;
}

function connectRounds(rounds) {
  for (let index = 0; index < rounds.length - 1; index++) {
    const current = rounds[index];
    const next = rounds[index + 1];
    const teams = new Map(current.cards.filter(card => card.advances).map(card => [card.advances, card]));
    next.cards.forEach(card => {
      card.sources = card.teamIds.map(id => teams.get(id)).filter(Boolean);
    });
    // Place the first round in the order its winners and seeds feed the next round.
    if (index === 0) {
      const linked = next.cards.flatMap(card => card.sources);
      current.cards = [...linked, ...current.cards.filter(card => !linked.includes(card))];
    }
  }
}

export function knockoutBoard(view, esc) {
  const groups = knockoutGroups(view.stages, view.matchups);
  if (!groups.length) return '';

  function matchCard(match, label = '') {
    const winningTeam = winner(match);
    const status = match.summary.complete ? '' : match.points.some(point => point.result?.status === 'disputed') ?
      '待裁定' : match.submitted.every(Boolean) ? '比賽中' : '待排點';
    return '<div class="bracket-match' + (match.kind === 'final' ? ' bracket-final' : '') + '">' +
      (label || status ? '<small>' + esc([label, status].filter(Boolean).join(' · ')) + '</small>' : '') +
      match.teams.map((name, side) => '<div class="bracket-team' +
        (match.teamIds[side] === winningTeam ? ' bracket-winner' : '') + '"><span>' + esc(name) +
        '</span><strong>' + (match.submitted.every(Boolean) || match.summary.complete ? match.summary.wins[side] : '–') +
        '</strong></div>').join('') + '</div>';
  }

  return '<section class="knockout-board"><h2>淘汰賽對戰樹</h2>' + groups.map(({ rounds }) => {
    const final = rounds.flatMap(round => round.cards).find(card => card.match?.kind === 'final');
    const latest = rounds.at(-1);
    if (!final && !view.archived && !latest.bronze.length && latest.cards.some(card => card.match) &&
        latest.cards.every(card => !card.match || card.match.summary.complete)) {
      rounds.push({ name: '下一輪', cards: [], bronze: [], pending: true });
    }
    connectRounds(rounds);
    const height = Math.max(...rounds.map(round => round.cards.length), 1) * 126 + 16;
    for (const round of rounds) {
      round.cards.forEach((card, slot) => {
        const evenY = (slot + 0.5) * height / round.cards.length;
        const sourceY = card.sources?.length ? card.sources.reduce((sum, source) => sum + source.y, 0) / card.sources.length : evenY;
        const previousY = slot ? round.cards[slot - 1].y + 126 : 63;
        card.y = Math.min(height - 63 - (round.cards.length - slot - 1) * 126, Math.max(previousY, sourceY));
      });
    }
    const bronzeY = round => (round.cards.at(-1)?.y ?? -63) + 126;
    const boardHeight = Math.max(height, ...rounds.filter(round => round.bronze.length)
      .map(round => bronzeY(round) + 63));
    const columns = rounds.map((round, index) => {
      const wires = round.cards.flatMap(card => (card.sources ?? []).map(source =>
        'M0 ' + source.y + ' H50 V' + card.y + ' H100'));
      return (index ? '<div class="bracket-wires" aria-hidden="true"><svg viewBox="0 0 100 ' +
        boardHeight + '" preserveAspectRatio="none"><path d="' + wires.join(' ') + '"/></svg></div>' : '') +
        '<div class="bracket-round"><h3>' + esc(round.name) + '</h3><div class="bracket-cards">' +
        round.cards.map(card => '<div class="bracket-slot" style="--y:' + card.y + 'px">' +
          (card.match ? matchCard(card.match, card.match.kind === 'final' ? '冠軍賽' : '') :
            '<div class="bracket-bye">' + esc(card.name) + '<small>' +
            (card.advances ? '輪空' : '本輪未排對戰') + '</small></div>') + '</div>').join('') +
        round.bronze.map(match => '<div class="bracket-slot bracket-bronze" style="--y:' + bronzeY(round) + 'px">' +
          matchCard(match, '季軍賽') + '</div>').join('') +
        (!round.cards.length && !round.bronze.length ? '<p class="bracket-next">' +
          (round.pending ? '待大會排定' : '本階段待排定') + '</p>' : '') + '</div></div>';
    }).join('');
    const champion = final?.advances && final.match.teams[final.match.teamIds.indexOf(final.advances)];
    return '<div class="bracket-scroll" tabindex="0" aria-label="淘汰賽晉級圖，可左右捲動">' +
      '<div class="bracket-grid" style="--height:' + boardHeight + 'px;--rounds:' + rounds.length + '">' +
      columns + '</div></div>' +
      (champion ? '<p class="bracket-champion">冠軍 <strong>' + esc(champion) + '</strong></p>' : '');
  }).join('') + '</section>';
}
