// App: menus, solo / host / client game loops, input, camera.
import * as THREE from 'three';
import { loadAssets } from './assets.js';
import { MAPS } from './maps.js';
import { Sim, CFG } from './sim.js';
import { View, decodeSnap } from './view.js';
import { T, TILE, isBreachable } from './map.js';
import { detectNet, fitSnapshot } from './net.js';
import * as UI from './ui.js';
import { audio } from './audio.js';

const { $ } = UI;

// ───────────────────────── renderer ─────────────────────────
const canvas = $('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;
const scene = new THREE.Scene();
scene.background = new THREE.Color(0xeef0f3);
scene.add(new THREE.HemisphereLight(0xffffff, 0xb8c0cc, 1.9));
const sun = new THREE.DirectionalLight(0xffffff, 1.6);
sun.castShadow = true;
sun.shadow.mapSize.set(2048, 2048);
sun.shadow.bias = -0.0005;
sun.shadow.normalBias = 0.02;
scene.add(sun, sun.target);
const camera = new THREE.PerspectiveCamera(38, window.innerWidth / window.innerHeight, 0.5, 500);
window.addEventListener('resize', () => { renderer.setSize(window.innerWidth, window.innerHeight, false); camera.aspect = window.innerWidth / window.innerHeight; camera.updateProjectionMatrix(); });

// ───────────────────────── state ─────────────────────────
const cfg = { mode: 'play', mapId: 0, mission: 'breach', difficulty: 'REGULAR', blueForce: 'MARINES', aiMates: 0, name: 'Operator' };
try { Object.assign(cfg, JSON.parse(localStorage.getItem('killhouse.cfg') || '{}')); } catch (e) { /* storage unavailable */ }
if (!MAPS[cfg.mapId]) cfg.mapId = 0;
const saveCfg = () => { try { localStorage.setItem('killhouse.cfg', JSON.stringify(cfg)); } catch (e) { /* */ } };

const app = {
  screen: 'loading', mode: null, sim: null, view: null, roster: null, myId: null, gcfg: null,
  net: null, room: null, code: null, gid: null, snaps: [], messages: [], pending: [], snapT: 0, tilesT: 0,
  camTarget: new THREE.Vector3(), camDist: 32, paused: false, result: null, pred: null, hudT: 0, unsub: [],
  speed: 1, vision: 'all', follow: null,
};
window.__app = app;

const input = { keys: {}, mouse: { x: 0, z: 0 }, crouch: false, seq: { fs: 0, rs: 0, us: 0, cs: 0, gs: 0, ss: 0, ys: 0 } };

function setScreen(name) {
  app.screen = name;
  for (const s of ['loading', 'menu', 'lobby', 'pause', 'results']) UI.show(s, s === name);
  UI.show('hud', name === 'playing' || name === 'pause');
}

// ───────────────────────── menu ─────────────────────────
function renderMenu() {
  const watch = cfg.mode === 'watch';
  UI.renderMapGrid(cfg.mapId, (id) => { cfg.mapId = id; saveCfg(); renderMenu(); });
  UI.renderDiffs(cfg.difficulty, (k) => { cfg.difficulty = k; saveCfg(); renderMenu(); });
  UI.renderDiffs(cfg.blueForce, (k) => { cfg.blueForce = k; saveCfg(); renderMenu(); }, 'diffsBlue');
  for (const b of $('segMode').children) b.classList.toggle('on', b.dataset.v === cfg.mode);
  UI.show('blueBlock', watch);
  UI.show('matesBlock', !watch);
  $('redHead').textContent = watch ? 'Red force' : 'Enemy force';
  $('mBreach').textContent = watch ? 'Blue assaults the building, red defends it.' : 'You assault the building. The AI defends it.';
  $('mDefend').textContent = watch ? 'Blue holds the building, red attacks it.' : 'You hold the building. The AI attacks it.';
  $('btnSolo').textContent = watch ? 'Watch' : 'Play solo';
  $('btnHost').textContent = watch ? 'Host online (others watch)' : 'Host online game';
  for (const b of $('segMission').children) b.classList.toggle('on', b.dataset.v === cfg.mission);
  for (const b of $('segMates').children) b.classList.toggle('on', +b.dataset.v === cfg.aiMates);
  $('optName').value = cfg.name;
}
$('segMode').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { cfg.mode = b.dataset.v; saveCfg(); renderMenu(); } });
$('segMission').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { cfg.mission = b.dataset.v; saveCfg(); renderMenu(); } });
$('segMates').addEventListener('click', (e) => { const b = e.target.closest('button'); if (b) { cfg.aiMates = +b.dataset.v; saveCfg(); renderMenu(); } });
$('optName').addEventListener('change', (e) => { cfg.name = e.target.value.trim().slice(0, 14) || 'Operator'; saveCfg(); });

function openMenu() {
  endGame();
  leaveRoom();
  renderMenu();
  setScreen('menu');
}

// ───────────────────────── game setup ─────────────────────────
function endGame() {
  if (app.view) { app.view.dispose(); app.view = null; }
  app.sim = null; app.mode = null; app.result = null; app.snaps = []; app.pending = []; app.messages = []; app.pred = null; app.paused = false;
}

function startView(roster, myId, gcfg) {
  if (app.view) app.view.dispose();
  app.roster = roster; app.myId = myId; app.gcfg = gcfg;
  app.watch = gcfg.mode === 'watch';
  app.vision = app.watch ? 'all' : 'blue';
  app.follow = null; app.speed = 1;
  app.view = new View(scene, gcfg.mapId, roster, app.vision, myId);
  const m = app.view.map;
  const R = Math.max(m.w, m.h) * 0.75 + 6;
  sun.position.set(m.w / 2 - 18, 40, m.h / 2 + 24);
  sun.target.position.set(m.w / 2, 0, m.h / 2);
  Object.assign(sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 140 });
  sun.shadow.camera.updateProjectionMatrix();
  const c0 = app.watch ? m.objective : m.spawn;
  app.camTarget.set(c0.x, 0, c0.z + (app.watch ? 6 : 0));
  if (app.watch) app.camDist = Math.max(40, Math.min(56, Math.max(m.w, m.h) * 0.7));
  app.messages = [];
  app.result = null;
  setScreen('playing');
}

function newSim(humans) {
  const watch = cfg.mode === 'watch';
  return new Sim({ mapId: cfg.mapId, mission: cfg.mission, difficulty: cfg.difficulty, aiMates: cfg.aiMates, blueForce: watch ? cfg.blueForce : null, humans: watch ? [] : humans, seed: (Math.random() * 1e9) | 0 });
}

function startSolo() {
  endGame();
  app.mode = 'solo';
  app.sim = newSim([{ peer: 'local', name: cfg.name }]);
  const me = app.sim.humanUnit('local');
  startView(app.sim.roster(), me ? me.id : null, { ...cfg });
}

// ───────────────────────── multiplayer ─────────────────────────
function randomCode() { const a = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < 5; i++) s += a[(Math.random() * a.length) | 0]; return s; }

async function hostGame() {
  if (!app.net) return;
  leaveRoom();
  app.code = randomCode();
  try { app.room = await app.net.join(app.code); } catch (e) { $('netStatus').textContent = 'Could not open a room: ' + e.message; return; }
  app.mode = 'host-lobby';
  app.room.presence({ kh: 'host', name: cfg.name, cfg: { ...cfg }, st: 'lobby', gid: null, roster: null });
  app.unsub.push(app.room.onPeers(renderLobby));
  renderLobby();
  setScreen('lobby');
}

async function joinGame(code) {
  if (!app.net || !code) return;
  leaveRoom();
  app.code = code.toLowerCase();
  try { app.room = await app.net.join(app.code); } catch (e) { $('netStatus').textContent = 'Could not join: ' + e.message; return; }
  app.mode = 'client-lobby';
  app.room.presence({ kh: 'client', name: cfg.name });
  app.unsub.push(app.room.onPeers(onPeersClient));
  app.unsub.push(app.room.on('snap', onSnap));
  onPeersClient();
  setScreen('lobby');
}

function leaveRoom() {
  for (const u of app.unsub) try { u(); } catch (e) { /* */ }
  app.unsub = [];
  if (app.room) app.room.leave();
  app.room = null; app.gid = null;
}

function hostPeer() {
  if (!app.room) return null;
  return app.room.peers().find((p) => p.presence && p.presence.kh === 'host') || null;
}

function renderLobby() {
  if (!app.room) return;
  const isHost = app.mode && app.mode.startsWith('host');
  const host = isHost ? { presence: { cfg, name: cfg.name } } : hostPeer();
  $('lobbyCode').textContent = app.code.toUpperCase();
  const c = host && host.presence.cfg;
  $('lobbyCfg').textContent = !c ? 'Waiting for the host…' : c.mode === 'watch'
    ? `AI vs AI on ${MAPS[c.mapId].name}: ${c.blueForce} (blue, ${c.mission === 'breach' ? 'attacking' : 'defending'}) vs ${c.difficulty} (red). Everyone watches.`
    : `${MAPS[c.mapId].name} · ${c.mission === 'breach' ? 'Breach (you attack)' : 'Defend (you hold)'} · vs ${c.difficulty} · ${c.aiMates} AI teammates`;
  const peers = app.room.peers().filter((p) => p.presence && (p.presence.kh === 'host' || p.presence.kh === 'client'));
  $('lobbyPlayers').innerHTML = peers.map((p) => `<div>${UI.esc(p.presence.name || 'Player')}${p.presence.kh === 'host' ? ' · host' : ''}${p.isMe ? ' (you)' : ''}</div>`).join('');
  $('lobbyNote').textContent = isHost ? 'Share the room code. Players who join see these settings. Change them from the main menu before hosting.' : 'The host starts the mission.';
  $('btnLobbyStart').classList.toggle('hidden', !isHost);
}

function hostStart() {
  const clients = app.room.peers().filter((p) => !p.isMe && p.presence && p.presence.kh === 'client');
  const humans = [{ peer: app.room.me, name: cfg.name }, ...clients.map((p) => ({ peer: p.peer, name: String(p.presence.name || 'Player').slice(0, 14) }))];
  endGame();
  app.mode = 'host';
  app.sim = newSim(humans);
  app.gid = randomCode();
  const roster = app.sim.roster();
  app.room.presence({ kh: 'host', name: cfg.name, cfg: { ...cfg }, st: 'play', gid: app.gid, roster });
  const me = app.sim.humanUnit(app.room.me);
  startView(roster, me ? me.id : null, { ...cfg });
}

function onPeersClient() {
  const host = hostPeer();
  if (app.mode === 'client-lobby' || app.mode === 'client') renderLobby();
  if (!host) {
    if (app.mode === 'client') { app.messages.push({ text: 'Host left the game', kind: 'bad', until: performance.now() + 4000 }); }
    return;
  }
  const hp = host.presence;
  if (hp.st === 'play' && hp.gid && hp.gid !== app.gid && hp.roster) {
    endGame();
    app.mode = 'client';
    app.gid = hp.gid;
    const mine = hp.roster.find((r) => r[4] === app.room.me);
    startView(hp.roster, mine ? mine[0] : null, hp.cfg);
  } else if (hp.st === 'lobby' && app.mode === 'client') {
    endGame();
    app.mode = 'client-lobby';
    renderLobby();
    setScreen('lobby');
  }
}

function onSnap(data) {
  if (app.mode !== 'client' || !data || data.gid !== app.gid || !app.view) return;
  const st = decodeSnap(data);
  app.snaps.push({ at: performance.now(), st });
  if (app.snaps.length > 12) app.snaps.shift();
  if (data.tiles) app.view.applyTiles(data.tiles);
  if (data.ev) {
    app.view.events(data.ev);
    for (const e of data.ev) {
      if (e.k === 'msg') app.messages.push({ text: e.text, kind: e.kind, until: performance.now() + 3000 });
      if (e.k === 'end' && !app.result) { app.result = e.result; setTimeout(showResults, 1200); }
    }
  }
}

/** Host: AI takes over the units of players who left. */
function hostDropLeavers() {
  const present = new Set(app.room.peers().map((p) => p.peer));
  for (const u of app.sim.units) if (u.human && u.human !== app.room.me && !present.has(u.human)) app.sim.dropHuman(u.human);
}

// ───────────────────────── input ─────────────────────────
const ray = new THREE.Raycaster();
const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ndc = new THREE.Vector2();
const hit = new THREE.Vector3();
let mouseX = innerWidth / 2, mouseY = innerHeight / 2;
window.addEventListener('mousemove', (e) => { mouseX = e.clientX; mouseY = e.clientY; });
canvas.addEventListener('mousedown', (e) => { if (app.screen === 'playing' && e.button === 0) input.seq.fs++; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('wheel', (e) => { if (app.screen === 'playing') app.camDist = Math.max(16, Math.min(56, app.camDist + Math.sign(e.deltaY) * 2)); }, { passive: true });
window.addEventListener('keydown', (e) => {
  if (e.code === 'Escape') {
    if (app.screen === 'playing') { app.paused = app.mode === 'solo'; $('pauseTitle').textContent = app.mode === 'solo' ? 'PAUSED' : 'MENU'; $('btnRestart').classList.toggle('hidden', app.mode === 'client'); setScreen('pause'); }
    else if (app.screen === 'pause') { app.paused = false; setScreen('playing'); }
    return;
  }
  if (app.screen !== 'playing' || e.target.tagName === 'INPUT') return;
  if (['Space', 'ArrowUp', 'ArrowDown', 'Tab'].includes(e.code)) e.preventDefault();
  input.keys[e.code] = true;
  if (e.repeat) return;
  if (app.watch || !app.myId) {
    if (e.code === 'Tab') cycleFollow();
    if (e.code === 'KeyV' && app.view) {
      const order = app.watch ? ['all', 'blue', 'red'] : ['blue', 'all'];
      app.vision = order[(order.indexOf(app.vision) + 1) % order.length];
      app.view.localTeam = app.vision;
    }
    if (app.sim && /^Digit[1-4]$/.test(e.code)) app.speed = [1, 2, 4, 8][+e.code.slice(5) - 1];
    if (/^Key[WASD]$/.test(e.code)) app.follow = null;
    return;
  }
  const s = input.seq;
  switch (e.code) {
    case 'KeyR': s.rs++; break;
    case 'KeyE': s.us++; break;
    case 'KeyF': s.cs++; break;
    case 'KeyG': s.gs++; break;
    case 'KeyQ': s.ss++; break;
    case 'KeyC': s.ys++; break;
    case 'KeyX': input.crouch = !input.crouch; break;
    default: break;
  }
});
window.addEventListener('keyup', (e) => { input.keys[e.code] = false; });
window.addEventListener('blur', () => { input.keys = {}; });

function cycleFollow() {
  const st = app.lastState;
  if (!st) return;
  const alive = app.roster.filter((r) => st.units.get(r[0])?.alive);
  if (!alive.length) return;
  const i = alive.findIndex((r) => r[0] === app.follow);
  app.follow = alive[(i + 1) % alive.length][0];
}

function mouseWorld(h) {
  ndc.set((mouseX / innerWidth) * 2 - 1, -(mouseY / innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  plane.constant = -(h + 1);
  if (ray.ray.intersectPlane(plane, hit)) { input.mouse.x = hit.x; input.mouse.z = hit.z; }
}

function buildInput() {
  const k = input.keys;
  let mx = 0, mz = 0;
  if (k.KeyW || k.ArrowUp) mz -= 1;
  if (k.KeyS || k.ArrowDown) mz += 1;
  if (k.KeyA || k.ArrowLeft) mx -= 1;
  if (k.KeyD || k.ArrowRight) mx += 1;
  return { mx, mz, ax: +input.mouse.x.toFixed(2), az: +input.mouse.z.toFixed(2), sp: k.ShiftLeft || k.ShiftRight ? 1 : 0, cr: input.crouch || k.ControlLeft ? 1 : 0, ...input.seq };
}

// ───────────────────────── per-frame ─────────────────────────
function interpState() {
  const S = app.snaps;
  if (!S.length) return null;
  const rt = performance.now() - 110;
  let a = S[0], b = S[S.length - 1];
  for (let i = 0; i < S.length - 1; i++) if (S[i].at <= rt && S[i + 1].at >= rt) { a = S[i]; b = S[i + 1]; break; }
  if (rt >= b.at) return b.st;
  const k = b.at > a.at ? Math.max(0, Math.min(1, (rt - a.at) / (b.at - a.at))) : 1;
  const units = new Map();
  for (const [id, ub] of b.st.units) {
    const ua = a.st.units.get(id) || ub;
    let dy = ub.yaw - ua.yaw;
    while (dy > Math.PI) dy -= 2 * Math.PI;
    while (dy < -Math.PI) dy += 2 * Math.PI;
    units.set(id, { ...ub, x: ua.x + (ub.x - ua.x) * k, z: ua.z + (ub.z - ua.z) * k, yaw: ua.yaw + dy * k });
  }
  return { ...b.st, units };
}

/** Client-side prediction of the local soldier so movement feels immediate. */
function predict(st, inp, dt) {
  const me = st.units.get(app.myId);
  if (!me) return;
  const latest = app.snaps[app.snaps.length - 1].st.units.get(app.myId);
  if (!app.pred || !me.alive) app.pred = { x: latest.x, z: latest.z };
  const p = app.pred;
  const m = app.view.map;
  if (me.alive && !me.channel) {
    let mx = inp.mx, mz = inp.mz;
    const L = Math.hypot(mx, mz);
    if (L > 1) { mx /= L; mz /= L; }
    let sp = inp.sp && !inp.cr ? CFG.sprint : inp.cr ? CFG.crouchSpeed : CFG.walk;
    if (m.tileAt(p.x, p.z) === T.WIRE) sp *= CFG.wireSpeed;
    const h = m.heightAt(p.x, p.z);
    if (m.canOccupy(p.x + mx * sp * dt, p.z, 0.36, h)) p.x += mx * sp * dt;
    if (m.canOccupy(p.x, p.z + mz * sp * dt, 0.36, h)) p.z += mz * sp * dt;
  }
  const err = Math.hypot(latest.x - p.x, latest.z - p.z);
  const moving = inp.mx || inp.mz;
  if (err > 2.5) { p.x = latest.x; p.z = latest.z; }
  else if (!moving) { p.x += (latest.x - p.x) * 0.15; p.z += (latest.z - p.z) * 0.15; }
  me.x = p.x; me.z = p.z;
  me.yaw = Math.atan2(input.mouse.x - p.x, input.mouse.z - p.z);
}

function contextPrompt(st, me) {
  if (!me || !me.alive || me.channel) return '';
  const m = app.view.map;
  const tc = m.toTile(me.x, me.z);
  let door = false, wire = false, breach = false;
  for (let r = tc.r - 1; r <= tc.r + 1; r++) for (let c = tc.c - 1; c <= tc.c + 1; c++) {
    const t = m.get(c, r);
    const ctr = m.center(c, r);
    const d = Math.hypot(ctr.x - me.x, ctr.z - me.z);
    if ((t === T.DOOR || t === T.OPEN) && d < 2.6) door = t;
    if (t === T.WIRE && d < 2.2) wire = true;
    if (isBreachable(t) && d < 2.6) breach = true;
  }
  const parts = [];
  if (door) parts.push(`[E] ${door === T.DOOR ? 'Open' : 'Close'} door`);
  if (wire) parts.push('[E] Cut wire (3s)');
  if (breach && me.charges > 0) parts.push('[F] Set breaching charge');
  return parts.join('   ');
}

function updateCamera(st, dt) {
  if (app.watch || !app.myId) {
    let tx = app.camTarget.x, tz = app.camTarget.z;
    const f = app.follow && st.units.get(app.follow);
    if (f && f.alive) { tx = f.x; tz = f.z; }
    else {
      const k = input.keys, sp = app.camDist * 0.9 * dt;
      if (k.KeyW || k.ArrowUp) tz -= sp;
      if (k.KeyS || k.ArrowDown) tz += sp;
      if (k.KeyA || k.ArrowLeft) tx -= sp;
      if (k.KeyD || k.ArrowRight) tx += sp;
    }
    const m = app.view.map;
    tx = Math.max(-10, Math.min(m.w + 10, tx)); tz = Math.max(-10, Math.min(m.h + 10, tz));
    const kk = f ? 1 - Math.pow(0.002, dt) : 1;
    app.camTarget.x += (tx - app.camTarget.x) * kk;
    app.camTarget.z += (tz - app.camTarget.z) * kk;
    const d = app.camDist;
    camera.position.set(app.camTarget.x, d * 0.95, app.camTarget.z + d * 0.55);
    camera.lookAt(app.camTarget.x, 0, app.camTarget.z);
    app.view.setListener(app.camTarget.x, app.camTarget.z);
    return f ? app.roster.find((r) => r[0] === app.follow)?.[3] : null;
  }
  let focus = st.units.get(app.myId);
  let spect = null;
  if (!focus || !focus.alive) {
    const alt = app.roster.filter((r) => !r[1]).map((r) => st.units.get(r[0])).find((u) => u && u.alive);
    if (alt) { spect = app.roster.find((r) => r[0] === alt.id)[3]; focus = alt; }
  }
  if (!focus) return null;
  const local = focus.id === app.myId && focus.alive;
  const tx = focus.x + (local ? (input.mouse.x - focus.x) * 0.2 : 0);
  const tz = focus.z + (local ? (input.mouse.z - focus.z) * 0.2 : 0);
  const k = 1 - Math.pow(0.002, dt);
  app.camTarget.x += (tx - app.camTarget.x) * k;
  app.camTarget.z += (tz - app.camTarget.z) * k;
  const d = app.camDist;
  const sh = app.view.shake;
  const sx = (Math.random() - 0.5) * sh, sz = (Math.random() - 0.5) * sh;
  camera.position.set(app.camTarget.x + sx, d * 0.95, app.camTarget.z + d * 0.55 + sz);
  camera.lookAt(app.camTarget.x + sx, 0, app.camTarget.z + sz);
  app.view.setListener(app.camTarget.x, app.camTarget.z);
  mouseWorld(focus.h || 0);
  return spect;
}

function showResults() {
  if (!app.result) return;
  UI.renderResults(app.result, app.mode === 'solo' || app.mode === 'host');
  setScreen('results');
}

const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta());
  const now = performance.now();
  if (!app.view || (app.screen !== 'playing' && app.screen !== 'pause' && app.screen !== 'results')) return;
  let st = null;
  const inp = buildInput();
  if (app.sim) {
    // solo or host: run the authoritative simulation
    const me = app.sim.unit(app.myId);
    if (app.screen === 'playing' && me) app.sim.applyInput(me, inp);
    if (app.mode === 'host') {
      for (const p of app.room.peers()) {
        if (p.isMe || !p.presence || p.presence.gid !== app.gid || !p.presence.in) continue;
        app.sim.applyInput(app.sim.humanUnit(p.peer), p.presence.in);
      }
      if ((app.dropT = (app.dropT || 0) - dt) <= 0) { app.dropT = 2; hostDropLeavers(); }
    }
    if (!app.paused) {
      const total = dt * (app.mode === 'solo' ? app.speed : 1);
      const steps = Math.max(1, Math.ceil(total / 0.034));
      for (let i = 0; i < steps; i++) app.sim.step(total / steps);
    }
    const evs = app.sim.events.splice(0);
    app.view.events(evs);
    for (const e of evs) if (e.k === 'msg') app.messages.push({ text: e.text, kind: e.kind, until: now + 3000 });
    if (app.mode === 'host') {
      app.pending.push(...evs);
      app.snapT -= dt; app.tilesT -= dt;
      if (app.snapT <= 0) {
        app.snapT = 1 / 12;
        const full = app.tilesT <= 0;
        if (full) app.tilesT = 1;
        app.room.emit('snap', fitSnapshot({ gid: app.gid, ...app.sim.snapshot(full) }, app.pending));
        app.pending = [];
      }
    }
    st = decodeSnap(app.sim.snapshot(false));
    if (app.sim.phase === 'over' && !app.result) { app.result = app.sim.result; setTimeout(showResults, 1200); }
  } else if (app.mode === 'client') {
    if (app.room && app.screen === 'playing' && app.myId) app.room.presence({ gid: app.gid, in: inp });
    st = interpState();
    if (st && app.myId) predict(st, inp, dt);
  }
  if (!st) { renderer.render(scene, camera); return; }
  app.lastState = st;
  const spect = updateCamera(st, dt);
  if (app.sim) {
    // local aim shows immediately
    const me = st.units.get(app.myId);
    if (me && me.alive) me.yaw = Math.atan2(input.mouse.x - me.x, input.mouse.z - me.z);
  }
  app.view.render(st, dt);
  app.hudT -= dt;
  if (app.hudT <= 0) {
    app.hudT = 1 / 15;
    app.messages = app.messages.filter((m) => m.until > now);
    const me = st.units.get(app.myId);
    UI.updateHUD(st, { watch: app.watch || !app.myId, cfg: app.gcfg, vision: app.vision, speed: app.mode === 'solo' ? app.speed : 1, canSpeed: app.mode === 'solo', following: spect, mission: app.gcfg.mission, mapName: MAPS[app.gcfg.mapId].name, diff: app.gcfg.difficulty, roster: app.roster, myId: app.myId, messages: app.messages, prompt: contextPrompt(st, me), spectating: spect });
  }
  renderer.render(scene, camera);
}

// ───────────────────────── buttons ─────────────────────────
const on = (id, fn) => $(id).addEventListener('click', fn);
on('btnSolo', startSolo);
on('btnHost', hostGame);
on('btnJoin', () => joinGame($('joinCode').value.trim()));
$('joinCode').addEventListener('keydown', (e) => { if (e.key === 'Enter') joinGame($('joinCode').value.trim()); });
on('btnLobbyStart', hostStart);
on('btnLobbyLeave', openMenu);
on('btnResume', () => { app.paused = false; setScreen('playing'); });
on('btnRestart', () => { if (app.mode === 'solo') startSolo(); else if (app.mode === 'host') hostStart(); });
on('btnQuit', openMenu);
on('btnAgain', () => { if (app.mode === 'solo') startSolo(); else if (app.mode === 'host') hostStart(); });
on('btnMenu', openMenu);

// ───────────────────────── boot ─────────────────────────
UI.renderControls();
setScreen('loading');
loadAssets((p) => {
  $('loadFill').style.width = `${Math.round(p * 100)}%`;
  $('loadText').textContent = `Loading assets… ${Math.round(p * 100)}%`;
}).then(async () => {
  renderMenu();
  UI.renderTraining();
  setScreen('menu');
  frame();
  app.net = await detectNet();
  $('netStatus').textContent = app.net
    ? (app.net.kind === 'room' ? 'Online play ready: host a room and share the code with people who can open this page.' : 'Online play ready via this server: share the room code.')
    : 'Online play unavailable here. Run "node server.js" (see README) or open the published artifact to host or join.';
  $('btnHost').disabled = !app.net;
  $('btnJoin').disabled = !app.net;
}).catch((err) => {
  console.error(err);
  $('loadText').textContent = 'Failed to load assets: ' + err.message + ' — serve this folder over HTTP (see README).';
});
void audio; void TILE;
