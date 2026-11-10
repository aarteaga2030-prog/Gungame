// App bootstrap: renderer, screens, input, and the frame loop.
import * as THREE from 'three';
import { loadAssets } from './assets.js';
import { LEVELS } from './levels.js';
import { Game } from './game.js';
import { GameMap } from './map.js';
import { DifficultyDirector } from './difficulty.js';
import { recordResult, isUnlocked, resetProgress } from './progression.js';
import * as UI from './ui.js';
import { ReelPlayer } from './replay.js';
import { buildScript } from './narrator.js';
import { audio, speak, stopSpeech } from './audio.js';

const canvas = document.getElementById('view');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: false });
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
camera.position.set(0, 40, 30);
camera.lookAt(0, 0, 0);

const app = { screen: 'loading', game: null, level: null, reel: null, result: null, unlock: null, reelHold: 0, hudT: 0 };
window.__app = app; // handy for debugging / automated tests

function setScreen(name) {
  app.screen = name;
  UI.show('loading', name === 'loading');
  UI.show('menu', name === 'menu');
  UI.show('briefing', name === 'briefing');
  UI.show('hud', name === 'playing' || name === 'paused');
  UI.show('pause', name === 'paused');
  UI.show('reel', name === 'reel');
  UI.show('results', name === 'results');
}

// ───────────────────────── flow ─────────────────────────
function openMenu() {
  disposeGame();
  stopSpeech();
  UI.renderMenu(openBriefing);
  setScreen('menu');
}

function openBriefing(level) {
  app.level = level;
  const map = new GameMap(level);
  const d = new DifficultyDirector(level, map).run();
  UI.renderBriefing(level, { log: d.log, plan: d.plan, mapRows: UI.previewRows(map) });
  setScreen('briefing');
}

function disposeGame() {
  if (app.game) { app.game.dispose(); app.game = null; }
  app.reel = null;
}

function startLevel(level) {
  disposeGame();
  stopSpeech();
  app.level = level;
  app.game = new Game({ scene, camera, level, ui: { onRoundEnd } });
  const m = app.game.map;
  const R = Math.max(m.w, m.h) * 0.75 + 6;
  sun.position.set(m.w / 2 - 18, 40, m.h / 2 + 24);
  sun.target.position.set(m.w / 2, 0, m.h / 2);
  Object.assign(sun.shadow.camera, { left: -R, right: R, top: R, bottom: -R, near: 1, far: 140 });
  sun.shadow.camera.updateProjectionMatrix();
  app.game.camTarget.set(m.spawn.x, 0, m.spawn.z);
  setScreen('playing');
}

function onRoundEnd(result) {
  if (!app.game || app.game.result !== result) return;
  const { newlyUnlocked } = recordResult(result.level.id, { win: result.win, grade: result.grade, time: result.time, perfect: result.perfect });
  app.result = result;
  app.unlock = newlyUnlocked;
  playReel();
}

function playReel() {
  const r = app.result;
  stopSpeech();
  app.script = app.script && app.scriptFor === r ? app.script : buildScript(r);
  app.scriptFor = r;
  app.reel = new ReelPlayer(app.game, r, app.script, document.getElementById('reelFrame'));
  document.getElementById('reelLevel').textContent = `L${r.level.number} · ${r.level.name.toUpperCase()}`;
  document.getElementById('reelCaption').dataset.key = '';
  app.reelHold = 0;
  setScreen('reel');
  speak(app.script.map((l) => l.text).join(' '));
}

function endReel() {
  if (app.screen !== 'reel') return;
  stopSpeech();
  const next = app.level.id + 1;
  UI.renderResults(app.result, app.unlock, next < LEVELS.length && isUnlocked(next));
  setScreen('results');
}

// ───────────────────────── buttons ─────────────────────────
const on = (id, fn) => document.getElementById(id).addEventListener('click', fn);
on('btnBack', openMenu);
on('btnStart', () => startLevel(app.level));
on('btnResume', () => setScreen('playing'));
on('btnRestart', () => startLevel(app.level));
on('btnQuit', openMenu);
on('btnReel', playReel);
on('btnRetry', () => startLevel(app.level));
on('btnNext', () => { const n = LEVELS[app.level.id + 1]; if (n && isUnlocked(n.id)) openBriefing(n); });
on('btnLevels', openMenu);
let resetArmed = 0;
on('btnReset', (e) => {
  const b = e.currentTarget;
  if (Date.now() - resetArmed < 4000) { resetArmed = 0; b.textContent = 'Reset progress'; resetProgress(); openMenu(); return; }
  resetArmed = Date.now();
  b.textContent = 'Click again to reset';
  setTimeout(() => { if (resetArmed && Date.now() - resetArmed >= 4000) { resetArmed = 0; b.textContent = 'Reset progress'; } }, 4100);
});
document.getElementById('optSound').addEventListener('change', (e) => { audio.enabled = e.target.checked; });
document.getElementById('optVoice').addEventListener('change', (e) => { audio.voice = e.target.checked; if (!audio.voice) stopSpeech(); });
document.getElementById('reel').addEventListener('click', endReel);

// ───────────────────────── input ─────────────────────────
const ray = new THREE.Raycaster();
const ground = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const ndc = new THREE.Vector2();
const hit = new THREE.Vector3();
let mouseX = 0, mouseY = 0;

function updateMouseWorld() {
  const g = app.game;
  if (!g) return;
  ndc.set((mouseX / window.innerWidth) * 2 - 1, -(mouseY / window.innerHeight) * 2 + 1);
  ray.setFromCamera(ndc, camera);
  ground.constant = g.state === 'prep' ? 0 : -(g.player ? g.player.h + 1.0 : 1.0);
  if (ray.ray.intersectPlane(ground, hit)) { g.input.mouse.x = hit.x; g.input.mouse.z = hit.z; }
}

window.addEventListener('mousemove', (e) => { mouseX = e.clientX; mouseY = e.clientY; });
canvas.addEventListener('mousedown', (e) => {
  const g = app.game;
  if (!g || app.screen !== 'playing') return;
  updateMouseWorld();
  if (g.state === 'prep') {
    if (e.button === 0) { ground.constant = 0; ndc.set((mouseX / window.innerWidth) * 2 - 1, -(mouseY / window.innerHeight) * 2 + 1); ray.setFromCamera(ndc, camera); if (ray.ray.intersectPlane(ground, hit)) g.prepClick(hit.x, hit.z); }
    if (e.button === 2) g.prepUndo();
    return;
  }
  if (e.button === 0) { g.input.fire = true; g.input.firePressed = true; }
});
window.addEventListener('mouseup', (e) => { if (app.game && e.button === 0) app.game.input.fire = false; });
canvas.addEventListener('contextmenu', (e) => e.preventDefault());
window.addEventListener('wheel', (e) => { if (app.game && app.screen === 'playing') app.game.camDist = Math.max(16, Math.min(50, app.game.camDist + Math.sign(e.deltaY) * 2)); }, { passive: true });
window.addEventListener('keydown', (e) => {
  if (app.screen === 'reel' && (e.code === 'Space' || e.code === 'Enter' || e.code === 'Escape')) { e.preventDefault(); endReel(); return; }
  const g = app.game;
  if (e.code === 'Escape') {
    if (app.screen === 'playing') setScreen('paused');
    else if (app.screen === 'paused') setScreen('playing');
    else if (app.screen === 'briefing') openMenu();
    return;
  }
  if (!g || app.screen !== 'playing') return;
  if (['Space', 'ArrowUp', 'ArrowDown', 'Backspace'].includes(e.code)) e.preventDefault();
  if (!e.repeat) g.onKey(e.code);
  g.input.keys[e.code] = true;
});
window.addEventListener('keyup', (e) => { if (app.game) app.game.input.keys[e.code] = false; });
window.addEventListener('blur', () => { if (app.game) { app.game.input.keys = {}; app.game.input.fire = false; } });

window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight, false);
});

// ───────────────────────── loop ─────────────────────────
const clock = new THREE.Clock();
function frame() {
  requestAnimationFrame(frame);
  const dt = Math.min(0.05, clock.getDelta());
  const g = app.game;
  const W = window.innerWidth, H = window.innerHeight;
  if (app.screen === 'reel' && app.reel) {
    app.reel.update(dt);
    UI.updateReel(app.reel, app.result);
    if (app.reel.done) { app.reelHold += dt; if (app.reelHold > 1.6) endReel(); }
    const r = document.getElementById('reelFrame').getBoundingClientRect();
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, W, H);
    renderer.setClearColor(0x0b0e14, 1);
    renderer.clear();
    camera.aspect = r.width / r.height;
    camera.updateProjectionMatrix();
    renderer.setScissorTest(true);
    renderer.setScissor(r.left, H - r.bottom, r.width, r.height);
    renderer.setViewport(r.left, H - r.bottom, r.width, r.height);
    renderer.render(scene, camera);
    renderer.setScissorTest(false);
    return;
  }
  renderer.setViewport(0, 0, W, H);
  if (Math.abs(camera.aspect - W / H) > 1e-3) { camera.aspect = W / H; camera.updateProjectionMatrix(); }
  if (g && (app.screen === 'playing' || app.screen === 'results' || app.screen === 'paused')) {
    if (app.screen === 'playing') {
      if (!app.lockMouse) updateMouseWorld();
      g.update(dt);
      app.hudT -= dt;
      if (app.hudT <= 0) { app.hudT = 1 / 20; UI.updateHUD(g); }
    }
    renderer.render(scene, camera);
  }
}

// ───────────────────────── boot ─────────────────────────
setScreen('loading');
loadAssets((p) => {
  document.getElementById('loadFill').style.width = `${Math.round(p * 100)}%`;
  document.getElementById('loadText').textContent = `Loading assets… ${Math.round(p * 100)}%`;
}).then(() => {
  openMenu();
  frame();
}).catch((err) => {
  console.error(err);
  document.getElementById('loadText').textContent = 'Failed to load assets: ' + err.message + ' — serve this folder over HTTP (see README).';
});
