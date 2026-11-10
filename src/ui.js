// DOM UI: level-select grid, briefing, HUD, breakdown reel captions, results.
import { LEVELS, TIERS } from './levels.js';
import { levelStatuses } from './progression.js';
import { TIER_PARAMS, RULES } from './difficulty.js';
import { GameMap, T, TILE } from './map.js';

const $ = (id) => document.getElementById(id);
const TIER_COLOR = { EASY: '#18b26b', MEDIUM: '#f0a020', HARD: '#ff5a1f', INSANE: '#d0103a' };
const LOCK_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="4" y="11" width="16" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

export function show(id, on = true) { $(id).classList.toggle('hidden', !on); }

/** Top-down blueprint thumbnail of a level map. */
export function drawMap(canvas, level, px = 10, opts = {}) {
  const rows = level.map;
  const cols = Math.max(...rows.map((r) => r.length));
  canvas.width = cols * px;
  canvas.height = rows.length * px;
  const g = canvas.getContext('2d');
  g.fillStyle = '#fbfbfc';
  g.fillRect(0, 0, canvas.width, canvas.height);
  g.strokeStyle = '#e3e7ec';
  g.lineWidth = 1;
  for (let c = 0; c <= cols; c++) { g.beginPath(); g.moveTo(c * px + 0.5, 0); g.lineTo(c * px + 0.5, canvas.height); g.stroke(); }
  for (let r = 0; r <= rows.length; r++) { g.beginPath(); g.moveTo(0, r * px + 0.5); g.lineTo(canvas.width, r * px + 0.5); g.stroke(); }
  const dot = (c, r, col, rad = 0.36) => { g.fillStyle = col; g.beginPath(); g.arc((c + 0.5) * px, (r + 0.5) * px, px * rad, 0, Math.PI * 2); g.fill(); };
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < cols; c++) {
      const ch = rows[r][c] || '.';
      const x = c * px, y = r * px;
      const fill = (col, inset = 0) => { g.fillStyle = col; g.fillRect(x + inset, y + inset, px - inset * 2, px - inset * 2); };
      switch (ch) {
        case '#': fill('#343b48'); break;
        case 'W': fill('#7fc4ff'); break;
        case 'D': fill('#e3a53a'); break;
        case 'B': fill('#d9622b'); break;
        case 'I': fill('#4b525c'); g.strokeStyle = '#fff'; g.beginPath(); g.moveTo(x, y); g.lineTo(x + px, y + px); g.stroke(); break;
        case '-': fill('#9aa3ae', px * 0.2); break;
        case 'S': fill('#b39a6a', px * 0.15); break;
        case 'C': fill('#b48a58', px * 0.2); break;
        case 'w': g.strokeStyle = '#4a4f57'; g.lineWidth = 1; for (let k = 0; k < 3; k++) { g.beginPath(); g.arc(x + px * (0.2 + k * 0.3), y + px / 2, px * 0.18, 0, Math.PI * 2); g.stroke(); } break;
        case 'm': fill('rgba(255,130,0,.22)'); break;
        case '=': case 'H': case 'J': fill('#cfd5de'); break;
        case '^': fill('#dfe4ea'); g.fillStyle = '#9aa3ae'; for (let k = 0; k < 3; k++) g.fillRect(x, y + k * px / 3, px, 1); break;
        default: break;
      }
      if (ch === 'E' || ch === 'H') dot(c, r, '#ff2d2d');
      if (ch === 'G' || ch === 'J') { dot(c, r, '#ff2d2d', 0.45); g.fillStyle = '#fff'; g.font = `bold ${px * 0.55}px sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('M', (c + 0.5) * px, (r + 0.55) * px); }
      if (ch === 'c') { g.fillStyle = 'rgba(255,45,45,.5)'; g.beginPath(); g.moveTo((c + 0.5) * px, (r + 0.5) * px); g.arc((c + 0.5) * px, (r + 0.5) * px, px * 1.1, Math.PI * 0.2, Math.PI * 0.8); g.fill(); dot(c, r, '#55603a', 0.25); }
      if (ch === 'P') dot(c, r, '#1f6fff', 0.45);
      if (ch === 'R') { g.fillStyle = 'rgba(255,45,45,.25)'; g.fillRect(x - px, y, px * 3, px); dot(c, r, '#ff2d2d', 0.3); }
      if (ch === 'X') { g.strokeStyle = '#1f6fff'; g.lineWidth = Math.max(1.5, px * 0.15); g.strokeRect(x + 2, y + 2, px - 4, px - 4); }
    }
  }
  if (opts.plan) {
    // fire plan overlay: sector lines from each defender to its aim point
    g.lineWidth = Math.max(1, px * 0.12);
    for (const d of opts.plan.defs) {
      g.strokeStyle = d.type === 'mg' ? 'rgba(220,0,0,.75)' : 'rgba(255,60,60,.45)';
      g.setLineDash(d.type === 'mg' ? [] : [px * 0.4, px * 0.3]);
      const sx = (d.x / TILE) * px, sy = (d.z / TILE) * px;
      const L = Math.min(Math.hypot(d.aim.x - d.x, d.aim.z - d.z), 30) / TILE * px;
      g.beginPath(); g.moveTo(sx, sy); g.lineTo(sx + Math.sin(d.sectorYaw) * L, sy + Math.cos(d.sectorYaw) * L); g.stroke();
    }
    g.setLineDash([]);
    for (const il of opts.plan.interlocks) {
      g.strokeStyle = '#d0103a'; g.lineWidth = 2;
      g.beginPath(); g.arc((il.at.x / TILE) * px, (il.at.z / TILE) * px, px * 0.8, 0, Math.PI * 2); g.stroke();
    }
  }
}

// ─────────────────────────── level select ───────────────────────────
export function renderMenu(onPick) {
  const grid = $('levelGrid');
  grid.innerHTML = '';
  const st = levelStatuses();
  for (const tier of TIERS) {
    const row = document.createElement('div');
    row.className = 'tier-row';
    const lab = document.createElement('div');
    lab.className = 'tier-label';
    lab.style.borderColor = TIER_COLOR[tier];
    lab.style.color = TIER_COLOR[tier];
    lab.innerHTML = `${tier}<small>${TIER_PARAMS[tier].label}</small>`;
    row.appendChild(lab);
    for (const s of st.filter((x) => x.level.tier === tier)) {
      const L = s.level;
      const card = document.createElement('div');
      card.className = `card ${s.status}`;
      const cv = document.createElement('canvas');
      drawMap(cv, L, 8);
      card.appendChild(cv);
      card.insertAdjacentHTML('beforeend', `
        <div class="num">${L.number}</div>
        <div class="mode ${L.mode}">${L.mode.toUpperCase()}</div>
        <div class="name">${L.name}</div>
        <div class="status">${statusText(s)}</div>`);
      if (s.status === 'locked') card.insertAdjacentHTML('beforeend', `<div class="lock">${LOCK_SVG}<span>${s.lockReason.toUpperCase()}</span></div>`);
      card.title = s.status === 'locked' ? s.lockReason : L.brief;
      card.addEventListener('click', () => { if (s.status !== 'locked') onPick(L); });
      row.appendChild(card);
    }
    grid.appendChild(row);
  }
}

function statusText(s) {
  if (s.status === 'locked') return '<span>LOCKED</span>';
  if (s.status === 'available') return '<span style="color:#1f6fff;font-weight:700">▶ READY</span>';
  const t = s.bestTime != null ? `${Math.floor(s.bestTime / 60)}:${String(Math.floor(s.bestTime % 60)).padStart(2, '0')}` : '';
  const perfect = s.perfect ? `<span class="perfect">${s.level.mode === 'breach' ? 'PERFECT' : 'FLAWLESS'}</span>` : `<span>CLEARED ${t}</span>`;
  return `${perfect}<span class="grade">${s.bestGrade || ''}</span>`;
}

// ─────────────────────────── briefing ───────────────────────────
export function renderBriefing(level, preview) {
  $('briefTag').innerHTML = `<span style="color:${TIER_COLOR[level.tier]}">LEVEL ${level.number} · ${level.tier} — ${TIER_PARAMS[level.tier].label.toUpperCase()}</span> · ${level.mode.toUpperCase()}`;
  $('briefName').textContent = level.name;
  $('briefText').textContent = level.brief;
  const res = [];
  if (level.smokes) res.push(`SMOKE ×${level.smokes}`);
  if (level.charges) res.push(`CHARGES ×${level.charges}`);
  if (level.claymores) res.push(`CLAYMORES ×${level.claymores}`);
  if (level.waves) res.push(`WAVES ×${level.waves.length}`);
  res.push(`PAR ${Math.floor(level.par / 60)}:${String(level.par % 60).padStart(2, '0')}`);
  $('briefRes').innerHTML = res.map((r) => `<span>${r}</span>`).join('');
  $('briefLog').textContent = preview.log.join('\n');
  const mapCanvas = $('briefMap');
  const L2 = { ...level, map: preview.mapRows };
  drawMap(mapCanvas, L2, 22, { plan: preview.plan });
  $('legend').innerHTML = [
    ['#343b48', 'wall'], ['#7fc4ff', 'window'], ['#e3a53a', 'door'], ['#d9622b', 'breach wall'], ['#4b525c', 'iron barricade'],
    ['#9aa3ae', 'low wall'], ['#b39a6a', 'sandbags'], ['#4a4f57', 'wire'], ['rgba(255,130,0,.4)', 'mortar TRP'], ['#ff2d2d', 'defender / sector'], ['#1f6fff', 'you'],
  ].map(([c, n]) => `<span><i style="background:${c}"></i>${n}</span>`).join('');
  const common = [
    ['WASD', 'move the soldier you control (Shift = slow)'], ['Mouse', 'aim'], ['Click', 'fire one round'], ['R', 'reload'],
    ['1–4 / Tab', 'take control of another squad member — the others hold their position and cover their sector'],
    ['G', 'standing order: keep suppressing the cursor point after you switch away (SUPPRESS)'], ['Q', 'throw smoke at the cursor (OBSCURE)'],
  ];
  const ctl = level.mode === 'breach' ? [
    ...common,
    ['', 'SECURE = a teammate near the breach, left holding a sector that faces away from it'],
    ['E', `reduce: charge / cut wire / disarm (${RULES.reduceTime}s) (REDUCE)`], ['F', 'open a door quietly (no stun)'], ['V', 'toggle sight fans'], ['Esc', 'pause'],
  ] : [
    ['Click', 'prep: place squad + sectors, then claymores'], ['Backspace', 'undo last placement'], ['Enter', 'begin defense'],
    ...common, ['V', 'toggle sight fans'], ['Esc', 'pause'],
  ];
  $('briefControls').innerHTML = ctl.map(([k, d]) => `<kbd>${k}</kbd><span>${d}</span>`).join('');
}

/** Map rows as they will actually be played (after the difficulty director shaped obstacles). */
export function previewRows(map) {
  const inv = { [T.FLOOR]: '.', [T.WALL]: '#', [T.WINDOW]: 'W', [T.DOOR]: 'D', [T.BWALL]: 'B', [T.IRON]: 'I', [T.LOW]: '-', [T.SANDBAG]: 'S', [T.CRATE]: 'C', [T.WIRE]: 'w', [T.PLATFORM]: '=', [T.STAIRS]: '^' };
  const rows = [];
  for (let r = 0; r < map.rows; r++) {
    let s = '';
    for (let c = 0; c < map.cols; c++) {
      const i = map.idx(c, r);
      let ch = inv[map.tiles[i]] || '.';
      if (ch === '.' && map.mortar[i]) ch = 'm';
      s += ch;
    }
    rows.push(s.split(''));
  }
  const put = (p, ch) => { const t = map.toTile(p.x, p.z); if (rows[t.r]) rows[t.r][t.c] = ch; };
  for (const d of map.defenders) put(d, map.get(d.c, d.r) === T.PLATFORM ? (d.type === 'mg' ? 'J' : 'H') : (d.type === 'mg' ? 'G' : 'E'));
  for (const c of map.claymores) put(c, 'c');
  put(map.spawn, 'P');
  for (const r of map.attackerSpawns) put(r, 'R');
  if (map.objective) put(map.objective, 'X');
  return rows.map((r) => r.join(''));
}

// ─────────────────────────── HUD ───────────────────────────
const fmt = (t) => `${Math.floor(t / 60)}:${String(Math.floor(t % 60)).padStart(2, '0')}`;
let lastFeed = '';

export function updateHUD(g) {
  const L = g.level;
  $('hudLevel').innerHTML = `<span style="color:${TIER_COLOR[L.tier]}">L${L.number} · ${L.tier}</span> · ${L.name.toUpperCase()}`;
  $('hudTime').textContent = fmt(g.t);
  // SOSRA tracker
  const so = $('sosra');
  if (g.mode === 'breach') {
    const c = g.sosraLive;
    const ev = c && c.ev;
    const ch = c && c.channel;
    const lb = c && c.lastBreach;
    const sawOn = g.units.some((u) => u.alive && u.mode === 'support' && u.sbfLos);
    const chip = (k, name, cls, sub) => `<div class="chip ${cls}"><b>${k}</b>${name}${sub ? `<div style="font-size:10px">${sub}</div>` : ''}</div>`;
    let s, o, sc, r, a;
    if (ev) {
      s = ev.s ? ['ok', ev.over.length ? `${ev.over.length} pinned/blind` : 'no overwatch'] : ['bad', `${ev.unsup.length} unsuppressed`];
      o = ev.o ? ['ok', ev.over.length ? 'smoke up' : 'not needed'] : ['bad', 'no smoke'];
      sc = ev.sec ? ['ok', 'flank held'] : [g.P.sosraStrict ? 'bad' : '', g.P.sosraStrict ? 'required' : 'needed for PERFECT'];
    } else {
      s = [sawOn ? 'act' : '', sawOn ? 'support firing' : ''];
      o = [g.smokes.length ? 'act' : '', g.smokes.length ? `${g.smokes.length} cloud` : ''];
      sc = ['', ''];
    }
    r = ch ? ['act', `${(ch.dur - ch.t).toFixed(1)}s`] : (c && c.target ? ['', 'in reach'] : ['', '']);
    if (lb && lb.blastT != null && lb.assaultDelay == null) {
      const left = RULES.stunWindow - (g.t - lb.blastT);
      a = left > 0 ? ['act', `GO ${left.toFixed(1)}s`] : ['bad', 'late'];
    } else if (lb && lb.assaultDelay != null) a = lb.assaultDelay <= RULES.stunWindow ? ['ok', `+${lb.assaultDelay.toFixed(1)}s`] : ['bad', `+${lb.assaultDelay.toFixed(1)}s`];
    else a = ['', ''];
    so.innerHTML = chip('S', 'SUPPRESS', ...s) + chip('O', 'OBSCURE', ...o) + chip('S', 'SECURE', ...sc) + chip('R', 'REDUCE', ...r) + chip('A', 'ASSAULT', ...a);
    $('hudCenterInfo').textContent = `${g.reds.length} hostiles${g.P.sosraStrict ? ' · SOSRA STRICT' : ''}`;
  } else {
    so.innerHTML = '';
    const w = L.waves.length;
    $('hudCenterInfo').textContent = g.state === 'prep'
      ? `PREP PHASE · interlocking sector pairs: ${g.interlocks.length}`
      : `WAVE ${Math.min(g.waveI, w)}/${w} · ${g.reds.length} attackers · interlocks ${g.interlocks.length}`;
  }
  // squad
  $('squad').innerHTML = g.units.filter((u) => u.team === 'blue').map((u, i) => {
    const ctl = u === g.player;
    const mode = ctl ? (u.channel ? 'REDUCING' : u.sbf ? 'YOU · SUPPRESS ON SWITCH' : 'YOU') : (u.mode === 'support' ? (u.sbfLos === false ? 'SUPPRESS — NO LOS' : 'SUPPRESSING') : 'HOLDING SECTOR');
    const st = u.alive ? (u.suppressed ? ' · SUPPRESSED' : '') : '';
    return `<div class="sq ${u.alive ? '' : 'dead'} ${ctl && u.alive ? 'ctl' : ''}"><div><div><span class="key">${i + 1}</span>${u.label}</div><div class="hp"><i style="width:${u.hp}%"></i></div></div><div style="text-align:right;font-size:11px">${u.alive ? mode : 'KIA'}${st}</div></div>`;
  }).join('');
  // weapon
  const p = g.player;
  $('weapon').innerHTML = `<div class="ammo">${p.reloadUntil > 0 ? '<small>RELOADING</small>' : `${p.ammo}<small>/${p.mag}</small>`}</div>
    <div class="row">${p.label} · SEMI · SMOKE ×${g.smokesLeft}${L.mode === 'breach' ? ` · CHARGES ×${g.chargesLeft}` : ''}</div>`;
  // hint
  $('hint').innerHTML = g.mode === 'breach'
    ? '<kbd>1–4</kbd>/<kbd>Tab</kbd> switch soldier <kbd>G</kbd> suppress order <kbd>Q</kbd> smoke <kbd>E</kbd> reduce <kbd>F</kbd> open <kbd>V</kbd> fans'
    : '<kbd>1–4</kbd>/<kbd>Tab</kbd> switch soldier <kbd>G</kbd> suppress order <kbd>Q</kbd> smoke <kbd>R</kbd> reload <kbd>V</kbd> fans';
  // reduce prompt
  let prompt = '';
  if (g.state === 'live' && g.mode === 'breach' && g.sosraLive && g.sosraLive.target && !p.channel) {
    const t = g.sosraLive.target;
    if (t.kind === 'charge') prompt = `[E] Set breaching charge on ${t.t === T.IRON ? 'IRON BARRICADE (5s)' : t.t === T.BWALL ? 'WALL (3s)' : 'DOOR (3s)'}${t.t === T.DOOR ? '   [F] Open quietly' : ''}`;
    else if (t.kind === 'cut') prompt = '[E] Cut a lane through the wire (3s)';
    else prompt = '[E] Disarm claymore (3s)';
  }
  $('prompt').textContent = prompt;
  // channel
  const chEl = $('channel');
  if (p.channel) {
    chEl.style.display = 'block';
    $('channelFill').style.width = `${(p.channel.t / p.channel.dur) * 100}%`;
    $('channelText').textContent = `${p.channel.kind === 'charge' ? 'PLACING CHARGE' : p.channel.kind === 'cut' ? 'CUTTING WIRE' : 'DISARMING'} — hold still`;
  } else chEl.style.display = 'none';
  // bunching
  const bEl = $('bunch');
  if (g.bunchMax > 0.05 && g.state === 'live') {
    bEl.style.display = 'block';
    $('bunchFill').style.width = `${Math.min(1, g.bunchMax / RULES.bunchTime) * 100}%`;
  } else bEl.style.display = 'none';
  // messages
  const feedHtml = g.messages.slice(-4).map((m) => `<div class="msg ${m.kind}">${m.text}</div>`).join('');
  if (feedHtml !== lastFeed) { $('feed').innerHTML = feedHtml; lastFeed = feedHtml; }
  // prep
  const pb = $('prepBar');
  if (g.state === 'prep') {
    const can = g.prepCanBegin();
    const html = `${g.prepPrompt()} ${can ? '<button id="btnBegin" class="primary">BEGIN</button>' : ''}<small>Sectors crossing at 45–90° = interlocking fire. ${g.P.bunchAnywhere ? 'INSANE: never place 3 men within 2 m.' : ''} Backspace = undo.</small>`;
    if (pb.dataset.html !== html) { pb.innerHTML = html; pb.dataset.html = html; const b = document.getElementById('btnBegin'); if (b) b.onclick = () => g.beginDefense(); }
  } else if (pb.innerHTML) { pb.innerHTML = ''; pb.dataset.html = ''; }
  $('vignette').classList.toggle('on', p.alive && p.suppressed);
}

// ─────────────────────────── results ───────────────────────────
export function failLabel(r) {
  return {
    sosra: 'SOSRA VIOLATION', bunch: 'CROSSFIRE WIPE', bunch_open: 'SQUAD WIPED', overrun: 'OBJECTIVE OVERRUN', squad_killed: 'SQUAD KILLED',
  }[r.reason] || 'MISSION FAILED';
}

/** One plain sentence on why the round ended. */
function debrief(r) {
  const i = r.info || {};
  if (r.win) {
    if (r.perfect) return r.mode === 'breach' ? 'Every reduction had full SOSRA and the assault went in inside the stun window.' : 'No casualties, objective never contested, sectors interlocked.';
    const missed = r.breaches.filter((b) => !(b.s && b.o && b.sec)).length;
    if (r.mode === 'breach' && missed) return `${missed} reduction${missed > 1 ? 's' : ''} started without full Suppress / Obscure / Secure.`;
    return r.casualties ? `${r.casualties} casualt${r.casualties > 1 ? 'ies' : 'y'} taken.` : 'Clean, but not perfect — check your assault timing and SOSRA.';
  }
  switch (r.reason) {
    case 'sosra': return `Reduction started without ${(i.missing || []).join(' / ')} in place.`;
    case 'bunch': return `${i.count || 3} soldiers held in one chokepoint for 1.5 s under enemy observation.`;
    case 'bunch_open': return 'Three soldiers clustered within 2 m of each other.';
    case 'overrun': return 'An attacker reached the objective.';
    default:
      if (i.cause === 'mortar') return 'Last soldier lingered in a pre-registered mortar zone without smoke.';
      if (i.cause === 'claymore') return 'Last soldier walked into a claymore\'s blast arc.';
      if (i.funnel) return 'Last soldier was killed standing in a doorway (fatal funnel).';
      if (i.wire) return 'Last soldier was killed while stuck in the wire.';
      return 'The whole squad was killed.';
  }
}


export function renderResults(r, unlock, hasNext) {
  const el = $('resRating');
  el.textContent = r.win ? r.rating : `${failLabel(r)}`;
  el.className = r.win ? 'win' : 'loss';
  $('resDebrief').textContent = debrief(r);
  $('resGrade').textContent = r.win ? `GRADE ${r.grade} · ${fmt(r.time)} (par ${fmt(r.level.par)})` : `Level ${r.level.number} — ${r.level.name}`;
  const s = r.stats;
  const cells = [
    ['Time', fmt(r.time)], ['Kills', s.kills], ['Casualties', r.casualties],
    ['Suppression', `${s.suppressionTime.toFixed(0)} s`], ['Smoke used', s.smokesUsed], [r.mode === 'breach' ? 'Breaches' : 'Interlocks', r.mode === 'breach' ? r.breaches.length : r.interlocks],
  ];
  if (r.mode === 'breach') {
    const full = r.breaches.filter((b) => b.s && b.o && b.sec).length;
    cells.push(['Full SOSRA', `${full}/${r.breaches.length}`], ['Stun kills', s.stunKills], ['Overwatch hits', s.overwatchCasualties]);
  } else cells.push(['Claymore kills', s.claymoreKills], ['Obj. contested', r.objectiveContested ? 'YES' : 'NO'], ['Shots', s.shots]);
  $('resStats').innerHTML = cells.map(([k, v]) => `<div>${k}<b>${v}</b></div>`).join('');
  $('resUnlock').textContent = unlock != null ? `🔓 LEVEL ${unlock + 1} UNLOCKED — ${LEVELS[unlock].name.toUpperCase()}` : '';
  document.getElementById('btnNext').disabled = !hasNext;
}
