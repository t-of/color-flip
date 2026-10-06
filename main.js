'use strict';

// localStorage はほかのアプリと共有される（同じ t-of.github.io のため）。
// キーは必ず 'color-flip.' で始める。
const STORE = 'color-flip.';

function load(key, fallback) {
  try {
    const v = localStorage.getItem(STORE + key);
    return v == null ? fallback : JSON.parse(v);
  } catch { return fallback; }
}
function save(key, value) {
  try { localStorage.setItem(STORE + key, JSON.stringify(value)); } catch { /* 保存できなくても遊べる */ }
}

WebAppKit.init({ title: 'color-flip', text: '色を合わせてめくる心理戦カードゲーム' });

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('./sw.js');
}

// 音を使うときは、鳴らす前と音の設定を切り替えたときにこれを呼ぶ（RULES.md §5「音」）。
function setAudioSession(soundOn) {
  try { if (navigator.audioSession) navigator.audioSession.type = soundOn ? 'playback' : 'auto'; } catch { /* 対応していない */ }
}

// ---- ここからアプリ本体 ----
// ponytail: 効果音・記録・設定は入れていない（芯だけ）。盤は 5×5 のマス。
const COL = ['#e5484d', '#3b82f6', '#f5c542', '#30a46c'];
const CN = ['赤', '青', '黄', '緑'];
const PAIRS = [[0, 1], [0, 2], [0, 3], [1, 2], [1, 3], [2, 3]];
const CHIPS = {
  skip: ['休み', 'めくり成功で好きな人を1回休み'],
  minus: ['点−1', 'めくり成功で好きな人の得点−1'],
  swap: ['手札交換', '好きな人と手札を全部交換'],
  guard: ['ガード', 'この番の失敗で体力が減らない'],
  recolor: ['色替え', '次の自分の番まで、ある色を別の色として扱う'],
  heal: ['体力+1', '体力+1（最大2）'],
  double: ['2枚置き', 'この番は2枚置ける'],
};
const ROUNDS = 3;
const WIN_SCORE = 4;

let G = { players: null, wait: null, t: {}, mode: null, sel: null, ui: null, log: '' };
const $ = (id) => document.getElementById(id);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
function shuffle(a) {
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function say(m) { G.log = m; render(); }

// ---- 画面 ----
function colorStyle(cols) {
  return cols.length === 1 ? COL[cols[0]] : `linear-gradient(135deg, ${COL[cols[0]]} 50%, ${COL[cols[1]]} 50%)`;
}
function cardHtml(card, extra = '') {
  return `<span class="face ${extra}" style="background:${colorStyle(card.c)}">${card.c.map((c) => CN[c]).join('')}</span>`;
}
function render() {
  let h = '';
  const P = G.players;
  if (!P) {
    h += `<div class="intro"><h2>color-flip</h2><p>置いたカードを、色が合うようにめくる心理戦。<br>裏向きの色は置いた本人だけが知っている。</p></div>`;
  } else {
    const cur = G.players[G.turn];
    h += `<div class="info">ラウンド ${G.round + 1}/${ROUNDS} ・ 山札 ${G.deck.length} ・ チップ山 ${G.chipDeck.length}</div>`;
    h += `<div class="players">` + P.map((p) => `<div class="pl${p === cur ? ' cur' : ''}${p.alive ? '' : ' dead'}">
      <b>${p.name}</b><span>点${p.score} ♥${p.hp}</span>
      <span>${G.bomb && G.bomb.holder === p.i ? `<em>爆${G.bomb.count}</em> ` : ''}札${p.hand.length} 勝${G.wins[p.i]}${p.skip ? ' 休' : ''}</span></div>`).join('') + `</div>`;
    h += `<div class="board">` + G.board.map((c, k) => {
      let cls = 'cell', inner = '';
      if (!c) { cls += ' empty'; if (G.mode === 'place' && G.sel != null) cls += ' hot'; }
      else if (c.up) inner = cardHtml(c.card);
      else {
        cls += ' down';
        if (G.mode === 'flip') cls += ' hot';
        inner = c.owner === 0 ? `<span class="mine">${c.card.c.map((x) => `<i style="background:${COL[x]}"></i>`).join('')}</span>` : '?';
      }
      return `<button class="${cls}" data-cell="${k}">${inner}</button>`;
    }).join('') + `</div>`;
  }
  h += `<div class="log">${G.log || '&nbsp;'}</div>`;
  if (G.ui) {
    h += `<div class="prompt"><p>${G.ui.title}</p>` + G.ui.labels.map((l, i) => `<button class="btn" data-opt="${i}">${l}</button>`).join('') + `</div>`;
  }
  if (P) {
    const me = P[0], acting = G.wait && G.wait.kind === 'act';
    const can = acting ? canDo(me) : {};
    const ex = G.t.extra;
    h += `<div class="hand">` + me.hand.map((c, i) => `<button class="card${G.sel === i ? ' sel' : ''}" data-h="${i}">${cardHtml(c)}</button>`).join('') + `</div>`;
    h += `<div class="chips">` + me.chips.map((id, i) => `<button class="chip" data-chip="${i}" ${acting && !G.t.chipUsed && !ex ? '' : 'disabled'}><b>${CHIPS[id][0]}</b><small>${CHIPS[id][1]}</small></button>`).join('') + `</div>`;
    h += `<div class="acts">
      <button class="btn" data-a="draw" ${can.draw && !ex ? '' : 'disabled'}>引く</button>
      <button class="btn${G.mode === 'place' ? ' on' : ''}" data-a="place" ${can.place ? '' : 'disabled'}>置く</button>
      ${ex ? '<button class="btn" data-a="end">おわり</button>' : `<button class="btn${G.mode === 'flip' ? ' on' : ''}" data-a="flip" ${can.flip ? '' : 'disabled'}>めくる</button>`}
    </div>`;
  }
  $('stage').innerHTML = h;
}

// 選ぶ（ボタンの番号を返す）。-1 はキャンセル相当を呼び出し側で作る
function choose(title, labels) {
  G.ui = { title, labels };
  render();
  return new Promise((res) => { G.wait = { kind: 'opt', res: (v) => { G.ui = null; res(v); } }; });
}
function waitAct() {
  render();
  return new Promise((res) => { G.wait = { kind: 'act', res }; });
}
function give(v) { const w = G.wait; G.wait = null; if (w) w.res(v); }

$('stage').addEventListener('click', (e) => {
  const el = e.target.closest('[data-a],[data-h],[data-cell],[data-chip],[data-opt]');
  const w = G.wait;
  if (!el || !w) return;
  const d = el.dataset;
  if (w.kind === 'opt') { if (d.opt != null) give(Number(d.opt)); return; }
  const me = G.players[0], can = canDo(me);
  if (d.chip != null) { if (!G.t.chipUsed && !G.t.extra) give({ t: 'chip', i: Number(d.chip) }); return; }
  if (d.a === 'draw') { if (can.draw && !G.t.extra) give({ t: 'draw' }); return; }
  if (d.a === 'end') { give({ t: 'end' }); return; }
  if (d.a === 'place' || d.a === 'flip') {
    if (!can[d.a] || (d.a === 'flip' && G.t.extra)) return;
    G.mode = G.mode === d.a ? null : d.a; if (G.mode !== 'place') G.sel = null; render(); return;
  }
  if (d.h != null) { G.mode = 'place'; G.sel = G.sel === Number(d.h) ? null : Number(d.h); render(); return; }
  if (d.cell != null) {
    const k = Number(d.cell), c = G.board[k];
    if (G.mode === 'place' && G.sel != null && !c) give({ t: 'place', ci: G.sel, cell: k });
    else if (G.mode === 'flip' && c && !c.up) give({ t: 'flip', cell: k });
  }
});

// ---- ルール ----
function neighbors(k) {
  const r = Math.floor(k / 5), c = k % 5, a = [];
  if (r > 0) a.push(k - 5);
  if (r < 4) a.push(k + 5);
  if (c > 0) a.push(k - 1);
  if (c < 4) a.push(k + 1);
  return a;
}
const mapCols = (cols, m) => cols.map((c) => (m && c === m.from ? m.to : c));
// 'ok' 成功 / 'ng' 失敗 / 'none' 隣に表向きがない
function judge(k, p, map = p.map) {
  const mine = mapCols(G.board[k].card.c, map);
  let any = false;
  for (const j of neighbors(k)) {
    const b = G.board[j];
    if (b && b.up) {
      any = true;
      if (mapCols(b.card.c, map).some((c) => mine.includes(c))) return 'ok';
    }
  }
  return any ? 'ng' : 'none';
}
const others = (p) => G.players.filter((q) => q.alive && q !== p);
const emptyCells = () => G.board.map((c, k) => (c ? -1 : k)).filter((k) => k >= 0);
const downCells = () => G.board.map((c, k) => (c && !c.up ? k : -1)).filter((k) => k >= 0);
function canDo(p) {
  return {
    draw: G.deck.length > 0 && p.hand.length < 5,
    place: p.hand.length > 0 && emptyCells().length > 0,
    flip: downCells().length > 0,
  };
}
function nextAlive(i) {
  for (let s = 1; s <= G.players.length; s++) { const q = G.players[(i + s) % G.players.length]; if (q.alive) return q.i; }
  return i;
}
function decided() {
  return G.players.filter((p) => p.alive).length <= 1 || G.players.some((p) => p.score >= WIN_SCORE);
}
function hurt(p) {
  p.hp--;
  if (p.hp <= 0) {
    p.alive = false;
    if (G.bomb && G.bomb.holder === p.i) { G.bomb.holder = nextAlive(p.i); G.bomb.count = G.bomb.init; }
  }
}
async function bombTick(p) {
  const b = G.bomb;
  if (!b || b.holder !== p.i || !p.alive) return;
  b.count--;
  if (b.count > 0) return;
  hurt(p);
  say(`${p.name}の爆弾が爆発。体力−1`);
  if (b.holder === p.i) { b.holder = nextAlive(p.i); b.count = b.init; }
  await sleep(900);
}
const topOther = (p) => others(p).reduce((a, b) => (b.score > a.score ? b : a));
async function pickPlayer(p, title, optional) {
  const l = others(p);
  if (!l.length) return null;
  if (!p.human) return topOther(p);
  const labels = l.map((q) => `${q.name}（点${q.score}）`);
  if (optional) labels.push('渡さない');
  return l[await choose(title, labels)] || null;
}

async function flip(p, k) {
  const cell = G.board[k];
  cell.up = true;
  const r = judge(k, p);
  const who = p.name;
  if (r === 'none') { say(`${who}がめくった。隣に表向きがなく、何も起きない`); return; }
  if (r === 'ng') {
    if (G.t.guard) say(`${who}がめくって失敗。ガードで体力はそのまま`);
    else { hurt(p); say(`${who}がめくって失敗。体力−1${p.alive ? '' : '（脱落）'}`); }
    return;
  }
  p.score++;
  const chip = G.chipDeck.pop();
  if (chip) p.chips.push(chip);
  say(`${who}がめくって成功。得点+1${chip ? '、チップを引いた' : ''}`);
  if (decided()) return;
  await sleep(p.human ? 200 : 700);
  if (G.t.skip) {
    const q = await pickPlayer(p, '1回休みにする人');
    if (q) { q.skip = true; say(`${who}は${q.name}を1回休みにした`); await sleep(700); }
  }
  if (G.t.minus) {
    const q = await pickPlayer(p, '得点−1にする人');
    if (q) { q.score = Math.max(0, q.score - 1); say(`${who}は${q.name}の得点を−1にした`); await sleep(700); }
  }
  const init = G.bomb ? G.bomb.init : G.players.length === 2 ? 4 : 3;
  if (!G.bomb) {
    const q = await pickPlayer(p, '爆弾を渡す人');
    G.bomb = { holder: q.i, count: init, init };
    say(`${who}は${q.name}に爆弾を渡した`);
  } else if (G.bomb.holder === p.i) {
    const q = await pickPlayer(p, '爆弾を渡す人', true);
    if (q) { G.bomb.holder = q.i; G.bomb.count = init; say(`${who}は${q.name}に爆弾を渡した`); }
  }
}

function place(p, ci, k) {
  G.board[k] = { card: p.hand.splice(ci, 1)[0], up: false, owner: p.i };
  say(`${p.name}がカードを裏向きで置いた`);
}
function draw(p) {
  p.hand.push(G.deck.pop());
  say(`${p.name}がカードを引いた`);
}

// チップの効果。args: { target, from, to }
function applyChip(p, id, args) {
  p.chips.splice(p.chips.indexOf(id), 1);
  G.t.chipUsed = true;
  say(`${p.name}がチップ「${CHIPS[id][0]}」を使った`);
  if (id === 'heal') p.hp = Math.min(2, p.hp + 1);
  else if (id === 'swap') { const q = args.target; [p.hand, q.hand] = [q.hand, p.hand]; }
  else if (id === 'recolor') p.map = { from: args.from, to: args.to };
  else G.t[id] = true;
}

// ---- 手番 ----
async function humanTurn(p) {
  for (;;) {
    const can = canDo(p);
    if (!can.draw && !can.place && !can.flip) { say('できることがない。パス'); await sleep(900); return false; }
    G.mode = null; G.sel = null;
    const a = await waitAct();
    G.mode = null; G.sel = null;
    if (a.t === 'chip') { await humanChip(p, a.i); continue; }
    if (a.t === 'draw') draw(p);
    else if (a.t === 'flip') await flip(p, a.cell);
    else {
      place(p, a.ci, a.cell);
      if (G.t.double && canDo(p).place) {
        G.t.extra = true;
        const b = await waitAct();
        if (b.t === 'place') place(p, b.ci, b.cell);
        G.t.extra = false; G.mode = null; G.sel = null;
      }
    }
    return true;
  }
}
async function humanChip(p, i) {
  const id = p.chips[i];
  if (id === 'heal' && p.hp >= 2) { say('体力は満タン'); return; }
  const args = {};
  if (id === 'swap') {
    const l = others(p);
    const n = await choose('手札を交換する人', l.map((q) => `${q.name}（札${q.hand.length}）`).concat('やめる'));
    if (n >= l.length) return;
    args.target = l[n];
  } else if (id === 'recolor') {
    const f = await choose('どの色を', CN.concat('やめる'));
    if (f > 3) return;
    const rest = [0, 1, 2, 3].filter((c) => c !== f);
    const t = await choose(`${CN[f]}を、どの色として扱う？`, rest.map((c) => CN[c]).concat('やめる'));
    if (t >= rest.length) return;
    args.from = f; args.to = rest[t];
  }
  applyChip(p, id, args);
}

function bestPlace(p) {
  let best = [], top = 0;
  p.hand.forEach((card, ci) => emptyCells().forEach((k) => {
    let s = 0;
    for (const j of neighbors(k)) { const b = G.board[j]; if (b && b.up && b.card.c.some((c) => card.c.includes(c))) s++; }
    if (s > top) { top = s; best = []; }
    if (s === top) best.push({ ci, k, s });
  }));
  return top > 0 ? rnd(best) : null;
}
const myDown = (p) => downCells().filter((k) => G.board[k].owner === p.i);
// 手元の知識だけで考える（自分が置いたカードの色しか使わない）
async function cpuTurn(p) {
  await sleep(700);
  const can = canDo(p);
  let safe = myDown(p).filter((k) => judge(k, p) === 'ok');
  const has = (id) => p.chips.includes(id);
  const forced = !safe.length && !can.draw && !can.place;
  if (p.hp < 2 && has('heal')) applyChip(p, 'heal', {});
  else if (safe.length && has('skip')) applyChip(p, 'skip', {});
  else if (safe.length && has('minus')) applyChip(p, 'minus', {});
  else if (!safe.length && has('recolor')) {
    for (const k of myDown(p)) for (let f = 0; f < 4; f++) for (let t = 0; t < 4; t++) {
      if (f !== t && !G.t.chipUsed && judge(k, p, { from: f, to: t }) === 'ok' && has('recolor')) applyChip(p, 'recolor', { from: f, to: t });
    }
  } else if (forced && has('guard')) applyChip(p, 'guard', {});
  else if (!safe.length && p.hand.length <= 1 && has('swap') && others(p).some((q) => q.hand.length >= 3)) {
    applyChip(p, 'swap', { target: others(p).reduce((a, b) => (b.hand.length > a.hand.length ? b : a)) });
  } else if (!safe.length && p.hand.length >= 2 && has('double')) applyChip(p, 'double', {});
  safe = myDown(p).filter((k) => judge(k, p) === 'ok');
  if (G.t.chipUsed) await sleep(700);

  const doPlace = () => {
    const b = bestPlace(p);
    if (!b) return false;
    place(p, b.ci, b.k);
    return true;
  };
  const c2 = canDo(p);
  if (safe.length) await flip(p, rnd(safe));
  else if (p.hand.length < 2 && c2.draw) draw(p);
  else if (c2.place && doPlace()) { /* 置いた */ }
  else if (c2.draw) draw(p);
  else if (c2.place) {
    // ponytail: 良い置き場がなければ、表向きの隣でない空きマスにランダムで置く
    const k = rnd(emptyCells());
    place(p, 0, k);
  } else if (c2.flip) {
    // 引けも置けもしない。隣に表向きがないものを優先して、他人のカードをめくる
    const d = downCells();
    const calm = d.filter((k) => judge(k, p) === 'none');
    await flip(p, rnd(calm.length ? calm : d));
  } else return false;
  if (G.t.double && !decided() && canDo(p).place) { await sleep(500); doPlace(); }
  return true;
}

async function takeTurn(p) {
  G.t = {};
  p.map = null;
  say(`${p.name}の番`);
  if (p.skip) {
    p.skip = false;
    say(`${p.name}は休み`);
    await sleep(900);
    await bombTick(p);
    return true;
  }
  const acted = p.human ? await humanTurn(p) : await cpuTurn(p);
  await sleep(p.human ? 400 : 900);
  if (!decided()) await bombTick(p);
  return acted;
}

function startRound(r) {
  const deck = [];
  for (let c = 0; c < 4; c++) for (let i = 0; i < 6; i++) deck.push({ c: [c] });
  PAIRS.forEach((pr) => deck.push({ c: pr }));
  shuffle(deck);
  G.round = r;
  G.deck = deck;
  G.players.forEach((p) => Object.assign(p, { hand: deck.splice(0, 3), score: 0, hp: 2, alive: true, chips: [], skip: false, map: null }));
  G.chipDeck = shuffle(Object.keys(CHIPS));
  G.board = Array(25).fill(null);
  G.board[12] = { card: deck.pop(), up: true, owner: -1 };
  G.bomb = null;
  G.turn = r % G.players.length;
  G.t = {};
}
// 勝者の番号、同点などで勝者なしなら -1
async function playRound(r) {
  startRound(r);
  say(`ラウンド${r + 1} 開始`);
  await sleep(600);
  let passes = 0;
  for (;;) {
    const p = G.players[G.turn];
    if (p.alive) passes = (await takeTurn(p)) ? 0 : passes + 1;
    const alive = G.players.filter((q) => q.alive);
    if (alive.length === 1) return alive[0].i;
    const hi = G.players.find((q) => q.score >= WIN_SCORE);
    if (hi) return hi.i;
    if (passes >= alive.length) {
      const m = Math.max(...alive.map((q) => q.score));
      const w = alive.filter((q) => q.score === m);
      return w.length === 1 ? w[0].i : -1;
    }
    G.turn = nextAlive(G.turn);
  }
}

async function playGame() {
  G = { players: null, wait: null, t: {}, mode: null, sel: null, ui: null, log: '' };
  const n = 2 + (await choose('人数を選ぶ（あなた＋CPU）', ['2人', '3人', '4人', '5人']));
  G.players = Array.from({ length: n }, (_, i) => ({ i, human: i === 0, name: i === 0 ? 'あなた' : `CPU${i}`, hand: [], chips: [], alive: true, score: 0, hp: 2 }));
  G.wins = Array(n).fill(0);
  G.deck = []; G.chipDeck = []; G.board = Array(25).fill(null); G.turn = 0; G.round = 0;
  for (let r = 0; r < ROUNDS; r++) {
    const w = await playRound(r);
    if (w >= 0) G.wins[w]++;
    const msg = w >= 0 ? `ラウンド${r + 1}は${G.players[w].name}の勝ち` : `ラウンド${r + 1}は勝者なし`;
    say(msg);
    if (r < ROUNDS - 1) await choose(msg, ['つぎのラウンドへ']);
  }
  const m = Math.max(...G.wins);
  const champs = G.players.filter((p) => G.wins[p.i] === m).map((p) => p.name).join('・');
  await choose(`ゲーム終了。優勝: ${champs}（${m}勝）`, ['もう一度']);
  playGame();
}
playGame();
