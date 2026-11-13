// DOM helpers: map thumbnails, menu widgets, HUD and results.
import { MAPS } from './maps.js';
import { DRILLS, PROFILES, PROFILE_ORDER, TRAINING, STATE_DRILL, drill } from './doctrine.js';
import { PAGE_INDEX, TOPICS, MANUALS } from './manual.js';

export const $ = (id) => document.getElementById(id);
export function show(id, on = true) { $(id).classList.toggle('hidden', !on); }
export const fmt = (t) => { t = Math.max(0, t); return `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`; };
export const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export function drawMap(canvas, rows, px = 8) {
  const cols = Math.max(...rows.map((r) => r.length));
  canvas.width = cols * px;
  canvas.height = rows.length * px;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fbfbfc';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = '#e3e7ec';
  for (let c = 0; c <= cols; c++) { g.beginPath(); g.moveTo(c * px + 0.5, 0); g.lineTo(c * px + 0.5, canvas.height); g.stroke(); }
  for (let r = 0; r <= rows.length; r++) { g.beginPath(); g.moveTo(0, r * px + 0.5); g.lineTo(canvas.width, r * px + 0.5); g.stroke(); }
  for (let r = 0; r < rows.length; r++) for (let c = 0; c < cols; c++) {
    const ch = rows[r][c] || '.';
    const x = c * px, y = r * px;
    const fill = (col, inset = 0) => { g.fillStyle = col; g.fillRect(x + inset, y + inset, px - inset * 2, px - inset * 2); };
    if (ch === '#') fill('#343b48');
    else if (ch === 'W') fill('#7fc4ff');
    else if (ch === 'D') fill('#e3a53a');
    else if (ch === 'I') fill('#4b525c');
    else if (ch === '-') fill('#9aa3ae', px * 0.2);
    else if (ch === 'S') fill('#b39a6a', px * 0.15);
    else if (ch === 'C') fill('#b48a58', px * 0.2);
    else if (ch === '=') fill('#cfd5de');
    else if (ch === '^') fill('#dfe4ea');
    else if (ch === 'w') { g.strokeStyle = '#4a4f57'; for (let k = 0; k < 2; k++) { g.beginPath(); g.arc(x + px * (0.3 + k * 0.4), y + px / 2, px * 0.2, 0, 6.3); g.stroke(); } g.strokeStyle = '#e3e7ec'; }
    else if (ch === 'P') { g.fillStyle = 'rgba(31,111,255,.18)'; g.beginPath(); g.arc(x + px / 2, y + px / 2, px * 4, 0, 6.3); g.fill(); g.fillStyle = '#1f6fff'; g.beginPath(); g.arc(x + px / 2, y + px / 2, px * 0.45, 0, 6.3); g.fill(); }
  }
}

export function renderMapGrid(selected, onPick) {
  const grid = $('mapGrid');
  grid.innerHTML = '';
  for (const m of MAPS) {
    const b = document.createElement('button');
    b.className = 'mapcard' + (m.id === selected ? ' on' : '');
    const cv = document.createElement('canvas');
    drawMap(cv, m.map, 7);
    b.appendChild(cv);
    b.insertAdjacentHTML('beforeend', `<b>${esc(m.name)}</b><span>${esc(m.desc)}</span>`);
    b.onclick = () => onPick(m.id);
    grid.appendChild(b);
  }
}

export function renderDiffs(selected, onPick, elId = 'diffs') {
  const el = $(elId);
  el.innerHTML = '';
  for (const k of PROFILE_ORDER) {
    const p = PROFILES[k];
    const b = document.createElement('button');
    b.className = k === selected ? 'on' : '';
    b.innerHTML = `<b>${esc(p.label)} <span class="n">${p.size} AI</span></b><span>${esc(p.blurb)}</span>`;
    b.onclick = () => onPick(k);
    el.appendChild(b);
  }
}

/** The training panel: what the AI studied (every doctrinal page) and the drills it runs. */
export function renderTraining() {
  $('manualCount').textContent = `· ${TRAINING.pages.toLocaleString()} of ${TRAINING.totalPages.toLocaleString()} pages`;
  const man = TRAINING.perManual.map((m) => `<span>${esc(m.short)} — ${esc(m.title)}</span><span>${m.trained}/${m.pages}</span>`).join('');
  const drills = DRILLS.map((d) => `<div class="page"><b>${esc(d.title)}</b><i>${esc(d.ref)} · studied from ${d.topics.map((t) => `${TRAINING.perTopic[t].got} “${t}” pages`).join(', ')}</i><p>${esc(d.text)}</p></div>`).join('');
  $('manual').innerHTML = `
    <p class="train-sum">Every AI force, at every difficulty, is trained on every doctrinal page of the four manuals. Only covers, contents, indexes, glossaries and blank pages are left out. Difficulty changes the force's size, experience and kit, not what it knows.</p>
    <div class="train-man">${man}</div>
    <div class="browse"><select id="pgTopic"><option value="">All topics</option>${TOPICS.map((t) => `<option>${t}</option>`).join('')}</select><input id="pgFind" placeholder="Search page headings" /></div>
    <div class="pagelist" id="pgList"></div>
    <h3>Drills built from those pages</h3>${drills}`;
  const list = () => {
    const t = $('pgTopic').value, q = $('pgFind').value.toLowerCase();
    const bit = t ? 1 << TOPICS.indexOf(t) : 0;
    const rows = PAGE_INDEX.filter((p) => p[5] && (!bit || p[4] & bit) && (!q || p[3].toLowerCase().includes(q)));
    $('pgList').innerHTML = rows.slice(0, 120).map((p) => `<div><b>${esc(MANUALS[p[0]].short)}</b> p.${p[1]} ${esc(p[2])} — ${esc(p[3])}</div>`).join('') + (rows.length > 120 ? `<div>…and ${rows.length - 120} more</div>` : '') + (rows.length ? '' : '<div>No pages match.</div>');
  };
  $('pgTopic').onchange = list;
  $('pgFind').oninput = list;
  list();
}

export const CONTROLS = [
  ['WASD', 'move'], ['Mouse', 'aim'], ['Click', 'fire one round'], ['R', 'reload'], ['Shift', 'sprint'], ['X / Ctrl', 'crouch'],
  ['E', 'open/close door · cut wire · disarm claymore'], ['F', 'set breaching charge on a door or wall'],
  ['G', 'throw frag grenade at cursor'], ['Q', 'throw smoke at cursor'], ['C', 'place claymore facing your aim (defending)'],
  ['Wheel', 'zoom'], ['Esc', 'menu'],
];
export function renderControls() {
  $('controlsRef').innerHTML = CONTROLS.map(([k, d]) => `<div><kbd>${k}</kbd><span>${d}</span></div>`).join('');
}

// ───────────── HUD ─────────────
let lastFeed = '';
/** st: decoded snapshot; info: { mission, mapName, diff, roster, myId, messages, prompt, spectating } */
export function updateHUD(st, info) {
  if (info.watch) return updateSpectatorHUD(st, info);
  $('loadout').style.display = '';
  const prof = PROFILES[info.diff];
  $('hudMission').textContent = `${info.mapName.toUpperCase()} · ${info.mission === 'breach' ? 'BREACH' : 'DEFEND'} · ${prof.label.toUpperCase()}`;
  const reds = info.roster.filter((r) => r[1]);
  const redDown = reds.filter((r) => st.units.get(r[0]) && !st.units.get(r[0]).alive).length;
  $('hudEnemy').textContent = `Enemy: ${reds.length} expected · ${redDown} down`;
  if (st.phase === 'prep') {
    $('hudPhase').textContent = info.mission === 'breach' ? 'DEFENDERS SETTING IN — STAY IN THE STAGING AREA' : 'PREPARE YOUR DEFENSE';
    $('hudTimer').textContent = fmt(st.prepLeft);
  } else {
    $('hudPhase').textContent = info.mission === 'breach' ? 'CLEAR THE BUILDING' : 'HOLD THE OBJECTIVE';
    $('hudTimer').textContent = fmt(st.timeLeft);
  }
  $('squad').innerHTML = info.roster.filter((r) => !r[1]).map((r) => {
    const s = st.units.get(r[0]);
    if (!s) return '';
    return `<div class="sq ${s.alive ? '' : 'dead'} ${r[0] === info.myId ? 'me' : ''}">${esc(r[3])}<div class="hp"><i style="width:${s.hp}%"></i></div></div>`;
  }).join('');
  const me = st.units.get(info.myId);
  if (me) {
    const col = me.hp > 50 ? 'var(--green)' : me.hp > 25 ? 'var(--amber)' : 'var(--red)';
    $('loadout').innerHTML = `<div class="row">HEALTH ${me.hp}</div><div class="hpbar"><i style="width:${me.hp}%;background:${col}"></i></div>
      <div class="ammo">${me.reloading ? '<small>RELOADING</small>' : `${me.ammo}<small> · ${me.mags} mags</small>`}</div>
      <div class="row">FRAG ×${me.frags} · SMOKE ×${me.smokes}${me.charges ? ` · CHARGE ×${me.charges}` : ''}${me.clay ? ` · CLAYMORE ×${me.clay}` : ''}${me.crouch ? ' · CROUCHED' : ''}</div>`;
    $('vignette').style.boxShadow = `inset 0 0 160px 40px rgba(180,0,0,${Math.min(0.5, me.supp * 0.55).toFixed(2)})`;
    $('flash').style.opacity = me.stun && me.alive ? 0.5 : 0;
    const ch = $('channel');
    if (me.channel && me.alive) { ch.style.display = 'block'; $('channelFill').style.width = `${me.chanP * 100}%`; $('channelText').textContent = 'WORKING — hold still'; }
    else ch.style.display = 'none';
    $('spectate').textContent = me.alive ? '' : info.spectating ? `YOU ARE DOWN — WATCHING ${info.spectating}` : 'YOU ARE DOWN';
  } else {
    $('loadout').innerHTML = '<div class="row">SPECTATING</div>';
    $('spectate').textContent = info.spectating ? `SPECTATING ${info.spectating}` : 'SPECTATING';
  }
  $('prompt').textContent = info.prompt || '';
  $('hint').innerHTML = '<kbd>Click</kbd> fire <kbd>R</kbd> reload <kbd>X</kbd> crouch <kbd>Shift</kbd> sprint <kbd>E</kbd> door/wire <kbd>F</kbd> charge <kbd>G</kbd> frag <kbd>Q</kbd> smoke <kbd>C</kbd> claymore';
  const feed = info.messages.slice(-4).map((m) => `<div class="msg ${m.kind || ''}">${esc(m.text)}</div>`).join('');
  if (feed !== lastFeed) { $('feed').innerHTML = feed; lastFeed = feed; }
}

const STATE_LABEL = { recon: 'Reconnoitering', occupy: 'Occupying positions', hold: 'Holding sectors', advance: 'Advancing', contact: 'Fire and movement', breach: 'Breaching (SOSRA)', clear: 'Clearing rooms', consolidate: 'Consolidating', break: 'Breaking contact', follow: 'Following' };

function updateSpectatorHUD(st, info) {
  const c = info.cfg;
  $('hudMission').textContent = `${info.mapName.toUpperCase()} · ${c.mode === 'watch' ? 'AI vs AI' : 'SPECTATING'} · BLUE ${c.mission === 'breach' ? 'ATTACKS' : 'DEFENDS'}`;
  $('hudEnemy').textContent = `View: ${info.vision === 'all' ? 'everything' : info.vision + ' side only'} · speed ${info.speed}×`;
  $('hudPhase').textContent = st.phase === 'prep' ? 'DEFENDERS SETTING IN' : c.mission === 'breach' ? 'BLUE MUST CLEAR THE BUILDING' : 'RED MUST TAKE THE BUILDING';
  $('hudTimer').textContent = fmt(st.phase === 'prep' ? st.prepLeft : st.timeLeft);
  const force = (isRed, key, state) => {
    const ids = info.roster.filter((r) => !!r[1] === isRed).map((r) => r[0]);
    const alive = ids.filter((id) => st.units.get(id)?.alive).length;
    const d = drill(STATE_DRILL[state] || 'org');
    return `<div class="force ${isRed ? 'red' : ''}">${isRed ? 'RED' : 'BLUE'} · ${esc(key ? PROFILES[key].label : 'Players')} · ${alive}/${ids.length}
      <div class="bar"><i style="width:${(alive / ids.length) * 100}%"></i></div>
      <div class="st">${esc(STATE_LABEL[state] || state || '')}${d ? ` — ${esc(d.ref)}` : ''}</div></div>`;
  };
  const ai = st.ai || [];
  $('squad').innerHTML = force(false, c.mode === 'watch' ? c.blueForce : null, ai[0]) + force(true, c.difficulty, ai[1]);
  $('loadout').style.display = 'none';
  $('vignette').style.boxShadow = 'none';
  $('flash').style.opacity = 0;
  $('channel').style.display = 'none';
  $('prompt').textContent = '';
  $('spectate').textContent = info.following ? `FOLLOWING ${info.following}` : '';
  $('hint').innerHTML = '<kbd>WASD</kbd> pan <kbd>Wheel</kbd> zoom <kbd>Tab</kbd> follow next soldier <kbd>V</kbd> view all / blue / red' + (info.canSpeed ? ' <kbd>1–4</kbd> speed 1×/2×/4×/8×' : '');
  const feed = info.messages.slice(-4).map((m) => `<div class="msg ${m.kind || ''}">${esc(m.text)}</div>`).join('');
  if (feed !== lastFeed) { $('feed').innerHTML = feed; lastFeed = feed; }
}

export function renderResults(r, canReplay) {
  const t = $('resTitle');
  t.textContent = r.matchup ? (r.win ? 'BLUE WINS' : 'RED WINS') : r.win ? 'MISSION SUCCESS' : 'MISSION FAILED';
  t.className = r.matchup ? '' : r.win ? 'win' : 'loss';
  t.style.color = r.matchup ? (r.win ? 'var(--blue)' : 'var(--red)') : '';
  $('resReason').textContent = r.reason;
  const cells = [
    ['Map', r.map], ['Mission', (r.matchup ? 'Blue ' : '') + (r.mission === 'breach' ? (r.matchup ? 'attacks' : 'Breach') : (r.matchup ? 'defends' : 'Defend'))],
    r.matchup ? ['Forces', `${PROFILES[r.blueForce].label} vs ${PROFILES[r.difficulty].label}`] : ['Enemy', PROFILES[r.difficulty].label],
    ['Time', fmt(r.time)], [r.matchup ? 'Red lost' : 'Enemy down', `${r.redLost}/${r.redTotal}`], [r.matchup ? 'Blue lost' : 'Your side lost', `${r.blueLost}/${r.blueTotal}`],
  ];
  $('resStats').innerHTML = cells.map(([k, v]) => `<div>${k}<b>${esc(v)}</b></div>`).join('');
  $('btnAgain').disabled = !canReplay;
  $('btnAgain').textContent = canReplay ? 'Play again' : 'Waiting for host';
}
