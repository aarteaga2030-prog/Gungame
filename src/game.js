// The tactical simulation: units, defender/attacker AI, SOSRA breaching, fatal errors.
import * as THREE from 'three';
import { GameMap, T, TILE, segPointDist, isPortalType } from './map.js';
import { DifficultyDirector, RULES, sectorInterlocks } from './difficulty.js';
import { World } from './world.js';
import { FX, makeRing, SightFan } from './fx.js';
import { makeSoldier } from './assets.js';
import { sfx, audio } from './audio.js';

const UNIT_R = 0.36;
const DMG = 55;
const PLAYER_DMG = 60;
const D2R = Math.PI / 180;

const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const yawTo = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

let UID = 0;

export class Unit {
  constructor(game, team, role, x, z) {
    this.id = UID++;
    this.game = game;
    this.team = team;
    this.role = role;          // lead | saw | rfl | sec | rifle | mg
    this.x = x; this.z = z; this.h = 0;
    this.yaw = team === 'blue' ? Math.PI : 0;
    this.hp = 100; this.alive = true;
    this.moveAmt = 0; this.phase = Math.random() * 6;
    this.mode = 'hold';
    this.state = 'hold';
    this.sectorYaw = this.yaw;
    this.fov = 110; this.range = 30;
    this.reactT = 0; this.target = null; this.lastSeen = -99; this.lastPos = null;
    this.burstLeft = 0; this.nextShot = 0;
    this.suppressedUntil = -1; this.stunUntil = -1; this.suppressedFor = 0;
    this.shifts = 0; this.shiftReadyAt = 0;
    this.path = null; this.pathI = 0;
    this.mortarObs = 0;
    this.killedBy = null; this.deathCause = null; this.deathT = null;
    this.mg = role === 'mg';
    this.label = { lead: 'LEAD', saw: 'SAW', rfl: 'RFL', sec: 'SEC' }[role] || (this.mg ? 'MG' : 'RFL');
    // visuals
    this.vis = makeSoldier(team);
    this.ring = makeRing(team);
    this.vis.root.add(this.ring);
    game.scene.add(this.vis.root);
    this.fan = null;
    this.fanT = Math.random() * 0.2;
    this.deadT = 0;
  }
  get suppressed() { return this.game.t < this.suppressedUntil; }
  get stunned() { return this.game.t < this.stunUntil; }

  syncVisual(dt) {
    const v = this.vis;
    v.root.position.set(this.x, this.h, this.z);
    v.root.rotation.y = this.yaw;
    if (!this.alive) {
      this.deadT = Math.min(1, this.deadT + dt * 4);
      v.tilt.rotation.x = -Math.PI / 2 * this.deadT;
      v.tilt.position.y = 0.15 * this.deadT;
      this.ring.visible = false;
      if (this.fan) this.fan.group.visible = false;
      return;
    }
    this.deadT = 0;
    v.tilt.rotation.x = 0; v.tilt.position.y = 0;
    this.ring.visible = true;
    this.phase += dt * 9 * this.moveAmt;
    v.pose(this.phase, this.moveAmt);
    // suppressed / stunned feedback: ring flicker
    const ctl = this.game.player === this;
    this.ring.scale.setScalar(ctl ? 1.45 : 1);
    this.ring.children[1].material.opacity = ctl ? 0.45 : 0.18;
    const r = this.ring.children[0].material;
    r.opacity = this.stunned ? 0.3 + 0.7 * Math.abs(Math.sin(this.game.t * 30)) : this.suppressed ? 0.5 : 0.95;
  }

  dispose() {
    this.game.scene.remove(this.vis.root);
    if (this.fan) this.game.scene.remove(this.fan.group);
  }
}

export class Game {
  constructor({ scene, camera, level, ui }) {
    this.scene = scene;
    this.camera = camera;
    this.level = level;
    this.ui = ui;
    this.mode = level.mode;
    this.map = new GameMap(level);
    const dir = new DifficultyDirector(level, this.map).run();
    this.P = dir.params;
    this.plan = dir.plan;
    this.configLog = dir.log;
    this.world = new World(scene, this.map);
    this.fx = new FX(scene);
    this.map.onChange = (c, r, t, variant) => {
      this.world.buildTile(c, r, t, false, variant);
    };
    this.t = 0;
    this.state = this.mode === 'defense' ? 'prep' : 'live';
    this.units = [];
    this.smokes = [];
    this.smokeId = 0;
    this.projectiles = [];
    this.charges = [];
    this.mortarRounds = [];
    this.mortarNext = 0;
    this.claymores = [];
    this.breaches = [];
    this.events = [];
    this.stats = { shots: 0, kills: 0, casualties: 0, smokesUsed: 0, stunKills: 0, overwatchCasualties: 0, sosraViolations: 0, suppressionTime: 0, claymoreKills: 0, mortarKills: 0, wireTime: 0, bunchWarnings: 0, funnelDeaths: 0 };
    this.smokesLeft = level.smokes || 0;
    this.chargesLeft = level.charges || 0;
    this.claymoresLeft = level.claymores || 0;
    this.result = null;
    this.bunchTimers = new Map();
    this.bunchMax = 0;
    this.clusterT = 0;
    this.showFans = true;
    this.shake = 0;
    this.camTarget = new THREE.Vector3();
    this.camDist = level.mode === 'defense' ? 42 : 34;
    this.sosraLive = null;
    this.sosraT = 0;
    this.messages = [];
    this.waveI = 0; this.waveTimer = 3; this.wavesDone = false; this.waveBanner = null;
    this.attackerSmokes = 0;
    this.objectiveContested = false;
    this.interlocks = [];
    this.prepStep = 0;
    this.input = { keys: {}, mouse: { x: 0, z: 0 }, firePressed: false };
    this.player = null;
    this.spawnUnits();
  }

  // ───────────────────────────── setup ─────────────────────────────
  spawnUnits() {
    const m = this.map;
    const sp = m.spawn;
    this.player = this.addUnit('blue', 'lead', sp.x, sp.z);
    this.player.yaw = Math.PI;
    const roles = ['saw', 'rfl', 'sec'];
    let prev = sp;
    const placed = [{ x: sp.x, z: sp.z }];
    roles.forEach((role, k) => {
      let p = m.squadSpawns[k];
      if (!p) {
        // stack behind the lead, away from the objective side (south if there is room, else sideways)
        const cands = [[0, 1], [1, 0], [-1, 0], [0, -1]].map(([dx, dz]) => ({ x: prev.x + dx * this.P.followSpacing, z: prev.z + dz * this.P.followSpacing }))
          .filter((q) => q.x > 1 && q.z > 1 && q.x < m.w - 1 && q.z < m.h - 1 && m.canOccupy(q.x, q.z, UNIT_R + 0.1, 0) && !placed.some((t) => Math.hypot(t.x - q.x, t.z - q.z) < 1));
        p = cands[0] || this.findFree(prev.x, prev.z + this.P.followSpacing, 6);
      }
      placed.push({ x: p.x, z: p.z });
      prev = p;
      const u = this.addUnit('blue', role, p.x, p.z);
      u.mode = 'hold';
      u.yaw = Math.PI;
    });
    if (this.mode === 'breach') {
      for (const d of this.plan.defs) {
        const u = this.addUnit('red', d.type === 'mg' ? 'mg' : 'rifle', d.x, d.z);
        u.sectorYaw = d.sectorYaw; u.yaw = d.sectorYaw; u.fov = d.fov;
        u.range = this.P.range + (u.mg ? 8 : 0);
        u.windowGuard = d.windowGuard || null;
        u.plan = d;
        u.home = { x: d.x, z: d.z };
        this.attachFan(u);
      }
    }
    for (const c of this.map.claymores) this.addClaymore('red', c.x, c.z, yawTo(c, this.map.spawn));
    for (const u of this.units) { u.h = this.map.heightAt(u.x, u.z); u.syncVisual(0); }
    for (const u of this.units) if (u.team === 'blue') { u.mag = 30; u.ammo = 30; u.reloadUntil = -1; u.sectorYaw = u.yaw; }
    this.player.mode = 'controlled';
  }

  findFree(x, z, maxR = 6) {
    const m = this.map;
    for (let r = 0; r <= maxR; r += 0.5) {
      for (let a = 0; a < 16; a++) {
        const px = x + Math.sin((a / 16) * Math.PI * 2) * r, pz = z + Math.cos((a / 16) * Math.PI * 2) * r;
        if (px < 1 || pz < 1 || px > m.w - 1 || pz > m.h - 1) continue;
        if (m.canOccupy(px, pz, UNIT_R + 0.1, 0) && m.heightAt(px, pz) === 0) return { x: px, z: pz };
      }
    }
    return { x, z };
  }

  addUnit(team, role, x, z) {
    const u = new Unit(this, team, role, x, z);
    this.units.push(u);
    return u;
  }

  attachFan(u) {
    const col = u.team === 'red' ? (u.mg ? 0xff1a1a : 0xff4040) : 0x2f7bff;
    u.fan = new SightFan(col, u.mg ? 0.17 : 0.11);
    this.scene.add(u.fan.group);
  }

  addClaymore(team, x, z, yaw) {
    const g = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.08), new THREE.MeshStandardMaterial({ color: 0x55603a }));
    body.position.y = 0.2;
    g.add(body);
    const lineMat = new THREE.LineBasicMaterial({ color: team === 'red' ? 0xff2020 : 0x2f7bff });
    const pts = [];
    for (const a of [-0.9, -0.45, 0, 0.45, 0.9]) {
      pts.push(new THREE.Vector3(0, 0.12, 0), new THREE.Vector3(Math.sin(a) * 3, 0.12, Math.cos(a) * 3));
    }
    g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), lineMat));
    const wedge = new THREE.Mesh(new THREE.CircleGeometry(3.2, 20, Math.PI / 2 - 1.05, 2.1), new THREE.MeshBasicMaterial({ color: team === 'red' ? 0xff2020 : 0x2f7bff, transparent: true, opacity: 0.1, depthWrite: false, side: THREE.DoubleSide }));
    wedge.rotation.x = -Math.PI / 2;
    wedge.rotation.z = Math.PI;
    wedge.position.y = 0.03;
    g.add(wedge);
    g.position.set(x, 0, z);
    g.rotation.y = yaw;
    this.scene.add(g);
    const c = { id: this.claymores.length, team, x, z, yaw, alive: true, mesh: g };
    this.claymores.push(c);
    return c;
  }

  dispose() {
    for (const u of this.units) u.dispose();
    for (const c of this.claymores) this.scene.remove(c.mesh);
    for (const p of this.projectiles) this.scene.remove(p.mesh);
    for (const c of this.charges) this.scene.remove(c.mesh);
    this.world.dispose();
    this.fx.clear();
    this.scene.remove(this.fx.group);
  }

  get blues() { return this.units.filter((u) => u.team === 'blue' && u.alive); }
  get reds() { return this.units.filter((u) => u.team === 'red' && u.alive); }
  unitByRole(role) { return this.units.find((u) => u.team === 'blue' && u.role === role); }

  msg(text, kind = 'info', dur = 2.5) {
    this.messages.push({ text, kind, until: this.t + dur });
  }

  // ───────────────────────────── main update ─────────────────────────────
  update(dt) {
    if (this.state === 'prep') { this.updatePrep(dt); this.syncVisuals(dt); this.updateCamera(dt); return; }
    if (this.state !== 'live') { this.syncVisuals(dt); this.fx.update(dt); return; }
    this.t += dt;
    this.updatePlayer(dt);
    for (const u of this.units) {
      if (!u.alive) continue;
      if (u.team === 'blue' && u !== this.player) this.updateSquad(u, dt);
      else if (u.team === 'red') (this.mode === 'breach' ? this.updateDefender(u, dt) : this.updateAttacker(u, dt));
      if (u.suppressed) { u.suppressedFor += dt; if (u.team === 'red') this.stats.suppressionTime += dt; } else u.suppressedFor = 0;
      if (this.map.tileAt(u.x, u.z) === T.WIRE && u.team === 'blue') this.stats.wireTime += dt;
    }
    this.separate();
    this.updateSmokes(dt);
    this.updateProjectiles(dt);
    this.updateCharges(dt);
    this.updateClaymores();
    if (this.P.mortars) this.updateMortars(dt);
    this.checkBunching(dt);
    this.updateBreachAssault();
    if (this.mode === 'defense') this.updateWaves(dt);
    this.checkEnd();
    this.sosraT -= dt;
    if (this.sosraT <= 0) { this.sosraT = 0.15; this.sosraLive = this.mode === 'breach' ? this.contextSOSRA() : null; }
    this.messages = this.messages.filter((m) => m.until > this.t);
    this.syncVisuals(dt);
    this.fx.update(dt);
    this.updateCamera(dt);
  }

  syncVisuals(dt) {
    for (const u of this.units) {
      u.syncVisual(dt);
      if (u.fan) {
        u.fan.group.visible = this.showFans && u.alive && this.state !== 'over';
        u.fanT -= dt;
        if (u.fan.group.visible && u.fanT <= 0) {
          u.fanT = 0.12;
          const fov = u.team === 'red' && u.state !== 'hold' && u.state !== 'shift' ? Math.max(u.fov, 60) : u.fov;
          const yaw = u.team === 'blue' ? u.sectorYaw : u.yaw;
          u.fan.update(this.map, u.x, u.z, yaw, fov, u.range, u.h + 0.05, this.smokes);
          const mat = u.fan.mesh.material;
          mat.opacity = u.stunned ? 0.03 : u.suppressed ? 0.05 : (u.mg ? 0.17 : 0.11);
        }
      }
    }
    this.fx.syncSmokes(this.smokes);
  }

  updateCamera(dt) {
    let tx, tz;
    if (this.state === 'prep') { tx = this.map.w / 2; tz = this.map.h / 2 - 2; }
    else {
      const p = this.player;
      tx = p.x + (this.input.mouse.x - p.x) * 0.18;
      tz = p.z + (this.input.mouse.z - p.z) * 0.18;
    }
    const k = 1 - Math.pow(0.002, dt);
    this.camTarget.x += (tx - this.camTarget.x) * k;
    this.camTarget.z += (tz - this.camTarget.z) * k;
    const d = this.state === 'prep' ? Math.max(this.map.w, this.map.h) * 0.92 : this.camDist;
    this.shake = Math.max(0, this.shake - dt * 2.5);
    const sx = (Math.random() - 0.5) * this.shake, sz = (Math.random() - 0.5) * this.shake;
    this.camera.position.set(this.camTarget.x + sx, d * 0.95, this.camTarget.z + d * 0.55 + sz);
    this.camera.lookAt(this.camTarget.x + sx, 0, this.camTarget.z + sz);
    audio.listener.x = this.camTarget.x; audio.listener.z = this.camTarget.z;
  }

  // ───────────────────────────── movement ─────────────────────────────
  moveUnit(u, dx, dz, speed, dt) {
    const L = Math.hypot(dx, dz);
    if (L < 1e-4) { u.moveAmt = Math.max(0, u.moveAmt - dt * 6); return 0; }
    let sp = speed;
    if (this.map.tileAt(u.x, u.z) === T.WIRE) sp *= RULES.wireSpeed;
    const step = Math.min(L, sp * dt);
    const mx = (dx / L) * step, mz = (dz / L) * step;
    const m = this.map;
    let moved = 0;
    if (m.canOccupy(u.x + mx, u.z, UNIT_R, u.h)) { u.x += mx; moved += Math.abs(mx); }
    if (m.canOccupy(u.x, u.z + mz, UNIT_R, u.h)) { u.z += mz; moved += Math.abs(mz); }
    u.h = m.heightAt(u.x, u.z);
    u.moveAmt = Math.min(1, u.moveAmt + dt * 6) * (moved > 1e-4 ? 1 : 0);
    if (sp < speed) u.moveAmt = Math.min(u.moveAmt, 0.35);
    return moved;
  }

  separate() {
    const us = this.units.filter((u) => u.alive);
    for (let i = 0; i < us.length; i++) for (let j = i + 1; j < us.length; j++) {
      const a = us[i], b = us[j];
      const dx = b.x - a.x, dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.72 || d < 1e-4 || Math.abs(a.h - b.h) > 0.8) continue;
      const push = (0.72 - d) / 2;
      const nx = dx / d, nz = dz / d;
      if (a !== this.player && this.map.canOccupy(a.x - nx * push, a.z - nz * push, UNIT_R, a.h)) { a.x -= nx * push; a.z -= nz * push; }
      if (b !== this.player && this.map.canOccupy(b.x + nx * push, b.z + nz * push, UNIT_R, b.h)) { b.x += nx * push; b.z += nz * push; }
    }
  }

  followPath(u, speed, dt) {
    if (!u.path || u.pathI >= u.path.length) { u.moveAmt = Math.max(0, u.moveAmt - dt * 6); return true; }
    const p = u.path[u.pathI];
    const dx = p.x - u.x, dz = p.z - u.z;
    if (Math.hypot(dx, dz) < 0.35) { u.pathI++; return u.pathI >= u.path.length; }
    this.moveUnit(u, dx, dz, speed, dt);
    u.yaw = rotateTo(u.yaw, Math.atan2(dx, dz), 8 * dt);
    return false;
  }

  // ───────────────────────────── perception ─────────────────────────────
  canSee(a, b, fovOverride) {
    if (!b.alive) return false;
    const d = dist(a, b);
    if (d > a.range) return false;
    const fov = fovOverride != null ? fovOverride : a.fov;
    if (fov < 360 && Math.abs(angDiff(yawTo(a, b), a.yaw)) > (fov * D2R) / 2) return false;
    return this.map.los(a.x, a.z, b.x, b.z, this.smokes);
  }

  inSmoke(u) { return this.smokes.some((s) => s.r > 1 && Math.hypot(s.x - u.x, s.z - u.z) < s.r + 0.6); }

  nearPortal(p, r = 2.2) {
    for (const c of this.map.chokePoints()) if (Math.hypot(c.x - p.x, c.z - p.z) < r) return c;
    return null;
  }

  // ───────────────────────────── combat ─────────────────────────────
  hitChance(s, tg) {
    if (s.suppressed) return RULES.suppressedAccuracy;
    const d = dist(s, tg);
    let p = s.team === 'red' ? this.P.accuracy * (this.mode === 'defense' ? 0.7 : 1) : (this.mode === 'defense' ? 0.38 : 0.22);
    p *= clamp(1.25 - d / s.range, 0.25, 1.15);
    if (tg.moveAmt > 0.5) p *= 0.75;
    p *= this.map.coverFactor(s.x, s.z, s.h, tg.x, tg.z, tg.h);
    if (s.team === 'red' && this.P.funnelLock && this.mode === 'breach' && this.nearPortal(tg, 2.2)) p *= this.P.funnelMult;
    if (s.mg) p *= 0.75;
    if (tg === this.player) p *= 0.85;
    return clamp(p, 0, 0.95);
  }

  muzzle(u) {
    return { x: u.x + Math.sin(u.yaw) * 0.6, y: u.h + 1.3, z: u.z + Math.cos(u.yaw) * 0.6 };
  }

  fireAt(s, tg) {
    const m = this.muzzle(s);
    const p = this.hitChance(s, tg);
    s.yaw = yawTo(s, tg);
    let ex, ez, ey = tg.h + 1.1;
    if (Math.random() < p) {
      ex = tg.x; ez = tg.z;
      this.damage(tg, DMG, s, s.mg ? 'mg' : 'rifle');
    } else {
      const a = yawTo(s, tg) + (Math.random() - 0.5) * 0.12;
      const d = dist(s, tg) + 2 + Math.random() * 6;
      const L = this.map.rayDist(s.x, s.z, Math.sin(a), Math.cos(a), d);
      ex = s.x + Math.sin(a) * L; ez = s.z + Math.cos(a) * L; ey = 0.6 + Math.random();
    }
    this.afterShot(s, m, ex, ey, ez);
  }

  afterShot(s, m, ex, ey, ez) {
    this.fx.tracer(m.x, m.y, m.z, ex, ey, ez, s.team);
    sfx.shot(s.team, s.x, s.z, s.mg || s.role === 'saw');
    // near misses suppress the other side
    for (const u of this.units) {
      if (!u.alive || u.team === s.team) continue;
      if (segPointDist(m.x, m.z, ex, ez, u.x, u.z) < 1.5) this.suppress(u, 0.8);
    }
    // gunfire alerts (hearing)
    if (s.team === 'blue' && this.P.hearing && this.mode === 'breach') {
      for (const r of this.reds) {
        if (r.state === 'hold' && dist(r, s) < 16 && !r.stunned) { r.state = 'search'; r.lookYaw = yawTo(r, s); r.searchUntil = this.t + 3; }
      }
    }
  }

  suppress(u, dur) { u.suppressedUntil = Math.max(u.suppressedUntil, this.t + dur); }

  damage(u, amt, src, cause) {
    if (!u.alive) return;
    u.hp -= amt;
    if (u.hp <= 0) this.kill(u, src, cause);
  }

  kill(u, src, cause) {
    if (!u.alive) return;
    u.alive = false; u.hp = 0;
    u.killedBy = src ? src.id : null;
    u.deathCause = cause;
    u.deathT = this.t;
    u.deathTile = this.map.tileAt(u.x, u.z);
    u.deathInFunnel = !!this.nearPortal(u, 2.2);
    u.deathInMortar = this.map.isMortar(u.x, u.z);
    if (u.team === 'red') {
      this.stats.kills++;
      if (this.t - (u.stunStart || -99) < RULES.stunWindow + 0.3) this.stats.stunKills++;
      if (cause === 'claymore') this.stats.claymoreKills++;
      // compromise neighbours
      for (const r of this.reds) if (dist(r, u) < 8) r.compromised = true;
    } else {
      this.stats.casualties++;
      if (u.deathInFunnel) this.stats.funnelDeaths++;
      if (cause === 'mortar') this.stats.mortarKills++;
      this.msg(`${u.label} DOWN`, 'bad');
      if (u === this.player) {
        const next = this.units.find((o) => o.team === 'blue' && o.alive);
        if (next) { this.player = u; this.selectUnit(next); }
      }
    }
  }

  // ───────────────────────────── player ─────────────────────────────
  updatePlayer(dt) {
    const p = this.player;
    if (!p.alive) return;
    const k = this.input.keys;
    let mx = 0, mz = 0;
    if (k.KeyW || k.ArrowUp) mz -= 1;
    if (k.KeyS || k.ArrowDown) mz += 1;
    if (k.KeyA || k.ArrowLeft) mx -= 1;
    if (k.KeyD || k.ArrowRight) mx += 1;
    const moving = mx || mz;
    if (p.channel && moving) { this.msg('Reduction aborted', 'warn'); p.channel = null; }
    if (!p.channel) this.moveUnit(p, mx, mz, k.ShiftLeft ? 2.0 : 4.3, dt);
    else p.moveAmt = 0;
    p.yaw = Math.atan2(this.input.mouse.x - p.x, this.input.mouse.z - p.z);
    // weapon: one click = one round
    if (p.reloadUntil > 0 && this.t >= p.reloadUntil) { p.ammo = p.mag; p.reloadUntil = -1; }
    if (!p.channel && p.reloadUntil < 0 && this.input.firePressed && this.t >= p.nextShot) {
      if (p.ammo <= 0) this.reload();
      else { this.playerShoot(); p.nextShot = this.t + 0.12; }
    }
    this.input.firePressed = false;
    // reduction channel
    if (p.channel) {
      p.channel.t += dt;
      if (p.channel.t >= p.channel.dur) this.completeReduce(p.channel);
    }
  }

  reload() {
    const p = this.player;
    if (p.reloadUntil > 0 || p.ammo === p.mag) return;
    p.reloadUntil = this.t + 2.1;
    sfx.click();
  }

  playerShoot() {
    const p = this.player;
    p.ammo--;
    this.stats.shots++;
    const spread = 0.012 * (p.suppressed ? 2.5 : 1) * (p.moveAmt > 0.3 ? 1.7 : 1);
    const a = p.yaw + gauss() * spread;
    const dx = Math.sin(a), dz = Math.cos(a);
    const m = this.muzzle(p);
    let maxd = this.map.rayDist(p.x, p.z, dx, dz, 70);
    let hit = null;
    for (const u of this.units) {
      if (u === p || !u.alive) continue;
      const fx = u.x - p.x, fz = u.z - p.z;
      const t = fx * dx + fz * dz;
      if (t < 0 || t > maxd) continue;
      const perp = Math.abs(fx * dz - fz * dx);
      if (perp < 0.45 && t < maxd) { maxd = t; hit = u; }
    }
    let ex = p.x + dx * maxd, ez = p.z + dz * maxd, ey = hit ? hit.h + 1.1 : 1.1;
    if (hit) {
      const cf = this.map.coverFactor(p.x, p.z, p.h, hit.x, hit.z, hit.h);
      if (Math.random() < cf) this.damage(hit, PLAYER_DMG, p, hit.team === 'blue' ? 'fratricide' : 'rifle');
      else ey = 0.7;
      if (hit.team === 'blue') this.msg('FRIENDLY FIRE!', 'bad');
    }
    this.afterShot(p, m, ex, ey, ez);
  }

  /** What the player could reduce right now. */
  reduceTarget() {
    const p = this.player;
    const m = this.map;
    let best = null, bd = 2.4;
    const tc = m.toTile(p.x, p.z);
    for (let r = tc.r - 2; r <= tc.r + 2; r++) for (let c = tc.c - 2; c <= tc.c + 2; c++) {
      const t = m.get(c, r);
      if (![T.DOOR, T.BWALL, T.IRON, T.WIRE].includes(t)) continue;
      const ce = m.center(c, r);
      // distance to tile edge
      const nx = clamp(p.x, c * TILE, (c + 1) * TILE), nz = clamp(p.z, r * TILE, (r + 1) * TILE);
      const d = Math.hypot(nx - p.x, nz - p.z) + (t === T.WIRE ? 0 : 0.2);
      if (d < bd) { bd = d; best = { kind: t === T.WIRE ? 'cut' : 'charge', c, r, t, x: ce.x, z: ce.z }; }
    }
    for (const c of this.claymores) {
      if (!c.alive || c.team !== 'red') continue;
      const d = Math.hypot(c.x - p.x, c.z - p.z);
      if (d < 1.8 && d < bd + 0.5) { best = { kind: 'disarm', clay: c, x: c.x, z: c.z }; bd = d; }
    }
    return best;
  }

  /** SOSRA check against a reduction point. */
  evalSOSRA(pt, obstacle) {
    // The reduction area = the breach point plus the approach just behind it.
    const pts = [pt];
    if (obstacle) {
      const dx = pt.x - obstacle.x, dz = pt.z - obstacle.z, L = Math.hypot(dx, dz) || 1;
      pts.push({ x: pt.x + (dx / L) * 2.5, z: pt.z + (dz / L) * 2.5 });
    }
    const sees = (r, smokes) => pts.some((q) => this.map.los(r.x, r.z, q.x, q.z, smokes));
    const over = [];
    for (const r of this.reds) {
      if (r.stunned) continue;
      if (Math.hypot(r.x - pt.x, r.z - pt.z) > r.range + 6) continue;
      if (!sees(r)) continue;
      over.push(r);
    }
    const unsup = over.filter((r) => !r.suppressed && sees(r, this.smokes));
    const smokeNear = this.smokes.some((s) => s.r > 1.5 && Math.hypot(s.x - pt.x, s.z - pt.z) < 12);
    const obscured = over.some((r) => !sees(r, this.smokes));
    // Secure: a teammate near the breach holding a sector that faces away from it (a flank).
    const sec = this.units.some((u) => u.alive && u.team === 'blue' && u !== this.player && u.mode === 'hold' &&
      Math.hypot(u.x - pt.x, u.z - pt.z) < 14 && Math.abs(angDiff(u.sectorYaw, yawTo(u, pt))) > Math.PI / 4);
    return {
      over, unsup,
      s: unsup.length === 0,
      o: over.length === 0 || smokeNear || obscured,
      sec,
      secRequired: this.P.sosraStrict,
    };
  }

  contextSOSRA() {
    const tg = this.reduceTarget();
    const p = this.player;
    const pt = tg ? { x: p.x, z: p.z } : null;
    const ev = pt ? this.evalSOSRA(pt, tg) : null;
    const lastB = this.breaches[this.breaches.length - 1];
    return { target: tg, ev, channel: p.channel, lastBreach: lastB };
  }

  startReduce() {
    const p = this.player;
    if (!p.alive || p.channel) return;
    const tg = this.reduceTarget();
    if (!tg) { this.msg('Nothing to reduce here', 'warn', 1.2); return; }
    if (tg.kind === 'charge' && this.chargesLeft <= 0) { this.msg('No breaching charges left', 'warn'); return; }
    const pt = { x: p.x, z: p.z };
    const ev = this.evalSOSRA(pt, tg);
    const entry = { t: this.t, kind: tg.kind, c: tg.c, r: tg.r, x: tg.x, z: tg.z, tile: tg.t, s: ev.s, o: ev.o, sec: ev.sec, overwatch: ev.over.length, unsup: ev.unsup.length, blastT: null, assaultDelay: null };
    this.breaches.push(entry);
    const missing = [];
    if (!ev.s) missing.push('SUPPRESS');
    if (this.P.sosraStrict && !ev.o) missing.push('OBSCURE');
    if (this.P.sosraStrict && !ev.sec) missing.push('SECURE');
    if (missing.length) {
      this.stats.sosraViolations++;
      const shooter = ev.unsup[0] || ev.over[0] || null;
      if (this.P.sosraStrict) {
        if (shooter) { this.burstVisual(shooter, p, 4); }
        this.kill(p, shooter, 'sosra');
        this.fatal('sosra', { missing, shooter: shooter ? { x: shooter.x, z: shooter.z, window: !!shooter.windowGuard } : null, at: pt });
        return;
      }
      if (!ev.s && shooter) {
        // FATAL ERROR (casualty): blowing a door under an unsuppressed overwatch
        const others = this.blues.filter((u) => u !== p).sort((a, b) => dist(a, pt) - dist(b, pt));
        const victim = others[0] || p;
        this.burstVisual(shooter, victim, 4);
        this.kill(victim, shooter, 'overwatch');
        this.stats.overwatchCasualties++;
        this.msg(`UNSUPPRESSED ${shooter.windowGuard ? 'WINDOW' : 'OVERWATCH'} — ${victim.label} hit`, 'bad', 3.5);
        if (victim === p) return;
      }
    }
    const dur = tg.kind === 'charge' ? (tg.t === T.IRON ? RULES.ironReduceTime : RULES.reduceTime) : RULES.reduceTime;
    p.channel = { ...tg, t: 0, dur, entry };
    sfx.beep(false);
  }

  burstVisual(s, tg, n) {
    for (let i = 0; i < n; i++) {
      const m = this.muzzle(s);
      this.fx.tracer(m.x, m.y, m.z, tg.x + (Math.random() - 0.5) * 0.5, tg.h + 1.1, tg.z + (Math.random() - 0.5) * 0.5, s.team);
    }
    s.yaw = yawTo(s, tg);
    sfx.shot(s.team, s.x, s.z, true);
  }

  completeReduce(ch) {
    const p = this.player;
    p.channel = null;
    if (ch.kind === 'charge') {
      this.chargesLeft--;
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial({ color: 0xff3300, emissive: 0x661100 }));
      mesh.position.set(ch.x, 1.0, ch.z);
      this.scene.add(mesh);
      this.charges.push({ ...ch, fuse: RULES.chargeFuse, mesh });
      this.msg('CHARGE SET — STAND CLEAR', 'warn', RULES.chargeFuse);
      sfx.beep(true);
    } else if (ch.kind === 'cut') {
      this.map.set(ch.c, ch.r, T.FLOOR);
      this.msg('Lane cut through the wire', 'good');
    } else if (ch.kind === 'disarm') {
      ch.clay.alive = false;
      this.scene.remove(ch.clay.mesh);
      this.msg('Claymore disarmed', 'good');
    }
  }

  updateCharges(dt) {
    for (let i = this.charges.length - 1; i >= 0; i--) {
      const c = this.charges[i];
      c.fuse -= dt;
      c.mesh.visible = Math.sin(this.t * 30) > 0;
      if (c.fuse > 0) continue;
      this.scene.remove(c.mesh);
      this.charges.splice(i, 1);
      this.detonate(c);
    }
  }

  detonate(c) {
    this.map.set(c.c, c.r, T.RUBBLE, 'blown');
    this.fx.blast(c.x, c.z, 3.2);
    sfx.boom(c.x, c.z);
    this.shake = 1.2;
    for (const u of this.units) {
      if (!u.alive) continue;
      const d = Math.hypot(u.x - c.x, u.z - c.z);
      if (d < 1.4) this.kill(u, this.player, 'blast');
      else if (d < 2.6) this.damage(u, 40, this.player, 'blast');
    }
    let stunned = 0;
    for (const r of this.reds) {
      const d = Math.hypot(r.x - c.x, r.z - c.z);
      if (d < 10 && this.map.los(c.x, c.z, r.x, r.z)) {
        r.stunUntil = this.t + RULES.stunWindow;
        r.stunStart = this.t;
        r.compromised = true;
        this.suppress(r, RULES.stunWindow + 0.5);
        stunned++;
      }
    }
    c.entry.blastT = this.t;
    c.entry.stunned = stunned;
    this.msg(stunned ? `OVERPRESSURE: ${stunned} stunned — ${RULES.stunWindow}s window, GO!` : 'Breach open', 'good', RULES.stunWindow);
  }

  updateBreachAssault() {
    const p = this.player;
    for (const b of this.breaches) {
      if (b.blastT == null || b.assaultDelay != null) continue;
      if (Math.hypot(p.x - b.x, p.z - b.z) < 1.3) {
        b.assaultDelay = this.t - b.blastT;
        if (b.assaultDelay <= RULES.stunWindow) this.msg(`ASSAULT IN WINDOW (+${b.assaultDelay.toFixed(2)}s)`, 'good');
      }
    }
  }

  openDoor() {
    const p = this.player;
    const tg = this.reduceTarget();
    if (!tg || tg.t !== T.DOOR) { this.msg('No door within reach', 'warn', 1.2); return; }
    this.map.set(tg.c, tg.r, T.OPEN);
    sfx.click();
    this.msg('Door opened (no overpressure — no stun)', 'info', 1.6);
  }

  throwSmoke(from, tx, tz, team) {
    const dx = tx - from.x, dz = tz - from.z;
    const L = Math.hypot(dx, dz);
    const maxd = 20;
    if (L > maxd) { tx = from.x + (dx / L) * maxd; tz = from.z + (dz / L) * maxd; }
    const mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.08, 0.3, 8), new THREE.MeshStandardMaterial({ color: team === 'blue' ? 0x7a8a50 : 0x8a5050 }));
    this.scene.add(mesh);
    this.projectiles.push({ mesh, ax: from.x, az: from.z, bx: tx, bz: tz, t: 0, dur: 0.75 });
    if (team === 'blue') this.stats.smokesUsed++;
  }

  updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.t += dt;
      const k = Math.min(1, p.t / p.dur);
      p.mesh.position.set(p.ax + (p.bx - p.ax) * k, 1.2 + Math.sin(k * Math.PI) * 3, p.az + (p.bz - p.az) * k);
      p.mesh.rotation.x += dt * 12;
      if (k >= 1) {
        this.scene.remove(p.mesh);
        this.projectiles.splice(i, 1);
        this.smokes.push({ id: this.smokeId++, x: p.bx, z: p.bz, r: 0, age: 0, alpha: 1 });
        sfx.pop(p.bx, p.bz);
      }
    }
  }

  updateSmokes(dt) {
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.age += dt;
      s.r = RULES.smokeRadius * Math.min(1, s.age / 1.3);
      const rem = RULES.smokeLife - s.age;
      if (rem < 3) { s.alpha = Math.max(0, rem / 3); s.r *= 0.6 + 0.4 * s.alpha; }
      if (rem <= 0) this.smokes.splice(i, 1);
    }
  }

  // ───────────────────────────── squad AI ─────────────────────────────
  /** Hand control to another squad member. The one you leave keeps its standing order. */
  selectUnit(u) {
    if (!u || !u.alive || u.team !== 'blue' || u === this.player) return;
    const old = this.player;
    if (old && old.alive) {
      old.channel = null;
      old.sectorYaw = old.yaw;
      old.mode = old.sbf ? 'support' : 'hold';
      old.burstLeft = 0;
    }
    this.player = u;
    u.mode = 'controlled';
    u.target = null;
    this.input.firePressed = false;
    this.msg(`Controlling ${u.label}`, 'info', 1.1);
  }

  cycleUnit() {
    const bl = this.units.filter((u) => u.team === 'blue');
    const i = bl.indexOf(this.player);
    for (let k = 1; k <= bl.length; k++) {
      const u = bl[(i + k) % bl.length];
      if (u.alive) { this.selectUnit(u); return; }
    }
  }

  /** Standing order for the soldier you control: keep suppressing the cursor point after you switch away. */
  toggleSuppressOrder(x, z) {
    const u = this.player;
    if (u.sbf) { u.sbf = null; this.msg(`${u.label}: suppress order cleared — will hold sector`, 'info', 1.6); return; }
    u.sbf = { x, z };
    const bk = Math.hypot(x - u.x, z - u.z) || 1;
    if (!this.map.los(u.x, u.z, x - ((x - u.x) / bk) * 1.2, z - ((z - u.z) / bk) * 1.2)) this.msg(`${u.label}: NO LINE OF SIGHT to that point`, 'warn');
    else this.msg(`${u.label}: will suppress that point when you switch away`, 'good', 2);
  }

  updateSquad(u, dt) {
    // target acquisition
    const fov = 120, react = 0.3;
    const lookYaw = u.sectorYaw;
    let best = null, bd = Infinity;
    u.range = 26;
    for (const r of this.reds) {
      const d = dist(u, r);
      if (d > u.range || d > bd) continue;
      if (Math.abs(angDiff(yawTo(u, r), lookYaw)) > (fov * D2R) / 2) continue;
      if (!this.map.los(u.x, u.z, r.x, r.z, this.smokes)) continue;
      best = r; bd = d;
    }
    if (u.mode === 'support' && u.sbf) {
      // support by fire: sustained fire into the designated area
      u.moveAmt = Math.max(0, u.moveAmt - dt * 6);
      u.yaw = rotateTo(u.yaw, yawTo(u, u.sbf), 10 * dt);
      const bk = Math.hypot(u.sbf.x - u.x, u.sbf.z - u.z) || 1;
      const lx = u.sbf.x - ((u.sbf.x - u.x) / bk) * 1.2, lz = u.sbf.z - ((u.sbf.z - u.z) / bk) * 1.2;
      const los = this.map.los(u.x, u.z, lx, lz);
      u.sbfLos = los;
      if (los && this.t >= u.nextShot) {
        const saw = u.role === 'saw';
        if (u.burstLeft <= 0) u.burstLeft = saw ? 8 : 3;
        u.burstLeft--;
        u.nextShot = this.t + (u.burstLeft > 0 ? (saw ? 0.085 : 0.15) : (saw ? 0.45 : 0.6));
        const ex = u.sbf.x + (Math.random() - 0.5) * 2.4, ez = u.sbf.z + (Math.random() - 0.5) * 2.4;
        const m = this.muzzle(u);
        const L = this.map.rayDist(u.x, u.z, Math.sin(yawTo(u, { x: ex, z: ez })), Math.cos(yawTo(u, { x: ex, z: ez })), Math.hypot(ex - u.x, ez - u.z) + 1);
        const a = yawTo(u, { x: ex, z: ez });
        const bx = u.x + Math.sin(a) * L, bz = u.z + Math.cos(a) * L;
        for (const r of this.reds) {
          if (Math.hypot(r.x - u.sbf.x, r.z - u.sbf.z) < 3.2) {
            this.suppress(r, 0.7);
            if (Math.random() < 0.025 && this.map.coverFactor(u.x, u.z, u.h, r.x, r.z, r.h) > 0.5) this.damage(r, DMG, u, 'rifle');
          }
        }
        this.afterShot(u, m, bx, 1.0, bz);
      }
      return;
    }
    if (best) {
      if (u.target !== best) { u.target = best; u.reactT = react; }
      u.reactT -= dt;
      u.yaw = rotateTo(u.yaw, yawTo(u, best), 9 * dt);
      if (u.reactT <= 0 && this.t >= u.nextShot) {
        if (u.burstLeft <= 0) u.burstLeft = u.role === 'saw' ? 5 : 3;
        u.burstLeft--;
        u.nextShot = this.t + (u.burstLeft > 0 ? (u.role === 'saw' ? 0.08 : 0.11) : 0.45);
        this.fireAt(u, best);
      }
    } else u.target = null;

    u.moveAmt = Math.max(0, u.moveAmt - dt * 6);
    if (!best) u.yaw = rotateTo(u.yaw, u.sectorYaw, 6 * dt);
  }

  // ───────────────────────────── defender AI (ATP 3-21.8) ─────────────────────────────
  updateDefender(u, dt) {
    const P = this.P;
    if (u.stunned) { u.moveAmt = 0; return; }
    const turn = P.turnRate * D2R * dt;
    // compromise → shift (HARD+)
    if (P.shiftOnCompromise && u.state !== 'shift' && this.t >= u.shiftReadyAt && u.shifts < 2 && !u.mg) {
      if (u.compromised || u.suppressedFor > 1.2) {
        u.compromised = false;
        if (this.beginShift(u)) return;
      }
    }
    u.compromised = false;
    if (u.state === 'shift') {
      const done = this.followPath(u, 3.8, dt);
      if (done) { u.state = 'hold'; u.sectorYaw = u.shiftFace; }
      return;
    }
    u.moveAmt = Math.max(0, u.moveAmt - dt * 6);
    // look for targets: hold uses sector FOV; engaged units track freely
    const fov = u.state === 'hold' ? u.fov : u.state === 'search' ? Math.max(u.fov, 120) : 200;
    let best = null, bd = Infinity;
    for (const b of this.blues) {
      if (!this.canSee(u, b, fov)) continue;
      const d = dist(u, b);
      if (d < bd) { bd = d; best = b; }
    }
    if (best) {
      if (u.state === 'hold' || u.state === 'search' || u.target !== best) {
        if (u.state !== 'acquire' && u.state !== 'engage') {
          let rt = P.reaction;
          if (P.funnelLock && this.nearPortal(best, 2.2)) rt *= 0.5;   // fatal funnel is pre-aimed
          if (u.suppressed) rt *= 1.5;
          u.reactT = rt;
          u.state = 'acquire';
        }
        u.target = best;
      }
      u.lastSeen = this.t;
      u.lastPos = { x: best.x, z: best.z };
      u.yaw = rotateTo(u.yaw, yawTo(u, best), turn);
      if (u.state === 'acquire') {
        u.reactT -= dt;
        if (u.reactT <= 0) u.state = 'engage';
      }
      if (u.state === 'engage' && Math.abs(angDiff(u.yaw, yawTo(u, best))) < 0.25 && this.t >= u.nextShot) {
        if (u.burstLeft <= 0) u.burstLeft = u.mg ? 6 : 3;
        u.burstLeft--;
        u.nextShot = this.t + (u.burstLeft > 0 ? (u.mg ? 0.075 : 0.12) : (u.mg ? 0.35 : 0.6)) * (u.suppressed ? 1.8 : 1);
        this.fireAt(u, best);
      }
    } else {
      if ((u.state === 'engage' || u.state === 'acquire') && this.t - u.lastSeen > 1.0) {
        u.state = 'search';
        u.lookYaw = u.lastPos ? yawTo(u, u.lastPos) : u.sectorYaw;
        u.searchUntil = this.t + 3;
      }
      if (u.state === 'search') {
        u.yaw = rotateTo(u.yaw, u.lookYaw, turn);
        if (this.t > u.searchUntil) u.state = 'hold';
      } else if (u.state === 'hold') {
        u.yaw = rotateTo(u.yaw, u.sectorYaw, turn);
      }
    }
  }

  beginShift(u) {
    const m = this.map;
    const bl = this.blues;
    if (!bl.length) return false;
    const threat = u.lastPos || { x: bl.reduce((s, b) => s + b.x, 0) / bl.length, z: bl.reduce((s, b) => s + b.z, 0) / bl.length };
    const t0 = m.toTile(u.x, u.z);
    let best = null, bs = -Infinity;
    for (let r = t0.r - 5; r <= t0.r + 5; r++) for (let c = t0.c - 5; c <= t0.c + 5; c++) {
      if (!m.inb(c, r) || !m.passable(c, r)) continue;
      if (m.get(c, r) !== m.get(t0.c, t0.r) && (m.get(c, r) === T.PLATFORM) !== (m.get(t0.c, t0.r) === T.PLATFORM)) continue;
      const p = m.center(c, r);
      const dT = Math.hypot(p.x - threat.x, p.z - threat.z);
      if (dT < 5) continue;
      if (this.units.some((o) => o !== u && o.alive && Math.hypot(o.x - p.x, o.z - p.z) < 1.5)) continue;
      let s = 0;
      if (!m.los(threat.x, threat.z, p.x, p.z)) s += 10;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) { const t = m.get(c + dc, r + dr); if (t === T.LOW || t === T.SANDBAG || t === T.CRATE) s += 2; if (t === T.WALL) s += 0.5; }
      s -= Math.hypot(c - t0.c, r - t0.r) * 0.4;
      if (s > bs) { bs = s; best = p; }
    }
    if (!best || bs < 5) return false;
    const path = m.path(u, best, { maxNodes: 600 });
    if (!path) return false;
    u.path = path; u.pathI = 0;
    u.state = 'shift';
    u.shifts++;
    u.shiftReadyAt = this.t + 6;
    u.shiftFace = yawTo(best, threat);
    return true;
  }

  // ───────────────────────────── attacker AI (defense levels) ─────────────────────────────
  updateAttacker(u, dt) {
    const P = this.P;
    if (u.stunned) return;
    const obj = this.map.objective;
    if (!u.path || this.t > (u.repath || 0)) {
      u.path = this.map.path(u, obj, { doors: true, wireCost: 2 });
      u.pathI = 0;
      u.repath = this.t + 2;
    }
    let best = null, bd = Infinity;
    for (const b of this.blues) {
      if (!this.canSee(u, b, u.state === 'engage' ? 220 : 140)) continue;
      const d = dist(u, b);
      if (d < bd) { bd = d; best = b; }
    }
    if (best) {
      if (u.state === 'advance' || u.state === 'hold') { u.state = 'acquire'; u.reactT = P.reaction * 0.8; }
      u.target = best; u.lastSeen = this.t;
      if (u.state === 'acquire') { u.reactT -= dt; u.yaw = rotateTo(u.yaw, yawTo(u, best), 6 * dt); if (u.reactT <= 0) { u.state = 'engage'; u.boundAt = this.t + 2.5 + Math.random() * 2; } }
      if (u.state === 'engage') {
        // screening smoke on first contact
        if (!u.threwSmoke && this.attackerSmokes < P.attackerSmokes * (this.waveI) && Math.random() < 0.5) {
          u.threwSmoke = true;
          this.attackerSmokes++;
          this.throwSmoke(u, u.x + (best.x - u.x) * 0.45, u.z + (best.z - u.z) * 0.45, 'red');
        }
        u.threwSmoke = true;
        u.yaw = rotateTo(u.yaw, yawTo(u, best), 8 * dt);
        u.moveAmt = Math.max(0, u.moveAmt - dt * 6);
        if (this.t >= u.nextShot) {
          if (u.burstLeft <= 0) u.burstLeft = u.mg ? 7 : 3;
          u.burstLeft--;
          u.nextShot = this.t + (u.burstLeft > 0 ? (u.mg ? 0.075 : 0.12) : (u.mg ? 0.4 : 0.7)) * (u.suppressed ? 1.8 : 1);
          this.fireAt(u, best);
        }
        if (P.attackerBound && !u.mg && this.t > u.boundAt && !u.suppressed) { u.state = 'bound'; u.boundUntil = this.t + 1.4; }
      }
    } else if (u.state === 'engage' || u.state === 'acquire') {
      if (this.t - u.lastSeen > 1.5) u.state = 'advance';
    }
    if (u.state === 'bound') {
      this.followPath(u, 4.2, dt);
      if (this.t > u.boundUntil) { u.state = best ? 'engage' : 'advance'; u.boundAt = this.t + 2.5 + Math.random() * 2.5; }
    } else if (u.state === 'advance' || u.state === 'hold') {
      u.state = 'advance';
      if (u.mg && this.blues.some((b) => dist(b, u) < 22)) { u.moveAmt = 0; u.yaw = rotateTo(u.yaw, yawTo(u, obj), 3 * dt); return; }
      this.followPath(u, u.suppressed ? 1.4 : 2.8, dt);
      if (Math.random() < dt * 0.6 && this.map.tileAt(u.x, u.z) !== T.DOOR) {
        // open doors on the way
        const t = this.map.toTile(u.x + Math.sin(u.yaw) * 1.2, u.z + Math.cos(u.yaw) * 1.2);
        if (this.map.get(t.c, t.r) === T.DOOR) this.map.set(t.c, t.r, T.OPEN);
      }
    }
    if (obj && dist(u, obj) < 6) this.objectiveContested = true;
    if (obj && dist(u, obj) < 1.6) this.fatal('overrun', { x: obj.x, z: obj.z });
  }

  updateWaves(dt) {
    const waves = this.level.waves;
    if (this.waveI >= waves.length) { this.wavesDone = true; return; }
    this.waveTimer -= dt;
    if (this.waveI > 0 && this.reds.length === 0 && this.waveTimer > 4) {
      this.waveTimer = 4;
      this.msg(`WAVE ${this.waveI + 1} INBOUND`, 'warn', 3);
    }
    if (this.waveTimer <= 0) {
      const w = waves[this.waveI];
      const spawns = this.map.attackerSpawns;
      for (let i = 0; i < w.count; i++) {
        const s = spawns[i % spawns.length];
        const p = this.findFree(s.x + (Math.random() - 0.5) * 3, s.z + (Math.random() - 0.5) * 2, 4);
        const isMg = i < (w.mg || 0);
        const u = this.addUnit('red', isMg ? 'mg' : 'rifle', p.x, p.z);
        u.state = 'advance'; u.fov = 140; u.range = this.P.range; u.yaw = 0;
        u.vis.root.position.set(u.x, 0, u.z);
      }
      this.waveI++;
      this.waveTimer = 35;
      this.msg(`WAVE ${this.waveI}/${waves.length}`, 'warn', 2);
    }
  }

  // ───────────────────────────── obstacles ─────────────────────────────
  updateClaymores() {
    for (const c of this.claymores) {
      if (!c.alive) continue;
      for (const u of this.units) {
        if (!u.alive || u.team === c.team) continue;
        const d = Math.hypot(u.x - c.x, u.z - c.z);
        const inArc = Math.abs(angDiff(yawTo(c, u), c.yaw)) < 1.05;
        if ((d < 3.0 && inArc) || d < 0.9) { this.claymoreBlast(c); break; }
      }
    }
  }

  claymoreBlast(c) {
    c.alive = false;
    this.scene.remove(c.mesh);
    const fx = c.x + Math.sin(c.yaw) * 2, fz = c.z + Math.cos(c.yaw) * 2;
    this.fx.blast(fx, fz, 2.8, 0xffd27a);
    sfx.boom(c.x, c.z, 0.7);
    this.shake = 0.8;
    for (const u of this.units) {
      if (!u.alive) continue;
      const d = Math.hypot(u.x - c.x, u.z - c.z);
      const inArc = Math.abs(angDiff(yawTo(c, u), c.yaw)) < 1.1;
      if ((inArc && d < 6) || d < 1.2) this.kill(u, null, 'claymore');
      else if (inArc && d < 9) this.damage(u, 60, null, 'claymore');
    }
  }

  updateMortars(dt) {
    const anyRed = this.reds.length > 0;
    for (const u of this.blues) {
      if (anyRed && this.map.isMortar(u.x, u.z) && !this.inSmoke(u)) u.mortarObs += dt;
      else u.mortarObs = Math.max(0, u.mortarObs - dt * 2);
      if (u.mortarObs > 1.0 && this.t >= this.mortarNext) {
        u.mortarObs = 0;
        this.mortarNext = this.t + 1.1;
        const x = u.x + (Math.random() - 0.5) * 1.6, z = u.z + (Math.random() - 0.5) * 1.6;
        this.mortarRounds.push({ x, z, at: this.t + 1.6 });
        this.fx.warning(x, z, 3.5, 1.6);
        sfx.whistle();
        if (!this.mortarWarned) { this.mortarWarned = true; this.msg('INCOMING — pre-registered mortar zone!', 'bad', 2.5); }
      }
    }
    for (let i = this.mortarRounds.length - 1; i >= 0; i--) {
      const m = this.mortarRounds[i];
      if (this.t < m.at) continue;
      this.mortarRounds.splice(i, 1);
      this.fx.blast(m.x, m.z, 3.5, 0xff8844);
      sfx.boom(m.x, m.z, 1.2);
      this.shake = 1.4;
      for (const u of this.units) {
        if (u.alive && Math.hypot(u.x - m.x, u.z - m.z) < 3.5) this.kill(u, null, 'mortar');
      }
    }
  }

  // ───────────────────────────── fatal errors ─────────────────────────────
  checkBunching(dt) {
    const bl = this.blues;
    let worst = 0, worstPt = null;
    if (this.reds.length) {
      for (const c of this.map.chokePoints()) {
        const n = bl.filter((u) => Math.hypot(u.x - c.x, u.z - c.z) < RULES.chokeRadius).length;
        const key = c.c + ',' + c.r;
        let tm = this.bunchTimers.get(key) || 0;
        if (n >= RULES.bunchCount && this.reds.some((r) => !r.stunned && dist(r, c) < r.range && this.map.los(r.x, r.z, c.x, c.z, this.smokes))) tm += dt;
        else tm = 0;
        this.bunchTimers.set(key, tm);
        if (tm > worst) { worst = tm; worstPt = c; }
      }
      if (this.P.bunchAnywhere) {
        let clustered = null;
        for (const u of bl) {
          const near = bl.filter((o) => o !== u && dist(o, u) < 2.0).length;
          if (near >= RULES.bunchCount - 1) { clustered = u; break; }
        }
        this.clusterT = clustered ? this.clusterT + dt : 0;
        if (this.clusterT > worst) { worst = this.clusterT; worstPt = clustered && { x: clustered.x, z: clustered.z, open: true }; }
      }
    }
    if (worst > 0 && this.bunchMax === 0) this.stats.bunchWarnings++;
    this.bunchMax = worst;
    if (worst >= RULES.bunchTime && worstPt) {
      // automatic crossfire wipe
      const victims = bl.filter((u) => Math.hypot(u.x - worstPt.x, u.z - worstPt.z) < 3.2);
      for (const r of this.reds) {
        for (const v of victims) if (this.map.los(r.x, r.z, v.x, v.z)) this.burstVisual(r, v, 2);
      }
      if (worstPt.open) { this.fx.blast(worstPt.x, worstPt.z, 4, 0xff8844); sfx.boom(worstPt.x, worstPt.z, 1.3); }
      for (const v of victims) this.kill(v, null, 'crossfire');
      this.fatal(worstPt.open ? 'bunch_open' : 'bunch', { x: worstPt.x, z: worstPt.z, count: victims.length });
    }
  }

  fatal(kind, info) {
    if (this.state !== 'live') return;
    this.endRound(false, kind, info);
  }

  checkEnd() {
    if (this.state !== 'live') return;
    if (!this.blues.length) {
      const p = this.player;
      return this.endRound(false, 'squad_killed', { cause: p.deathCause, funnel: p.deathInFunnel, mortar: p.deathInMortar, wire: p.deathTile === T.WIRE, by: this.units.find((u) => u.id === p.killedBy) });
    }
    if (this.mode === 'breach' && this.reds.length === 0) return this.endRound(true, 'cleared');
    if (this.mode === 'defense' && this.wavesDone && this.reds.length === 0) return this.endRound(true, 'held');
  }

  endRound(win, reason, info = {}) {
    if (this.state === 'over') return;
    this.state = 'over';
    this.player.channel = null;
    const blueAll = this.units.filter((u) => u.team === 'blue');
    const cas = blueAll.filter((u) => !u.alive).length;
    let perfect = false, grade = 'F';
    if (win) {
      if (this.mode === 'breach') {
        const sosraOK = this.breaches.every((b) => b.s && b.o && b.sec && (b.kind !== 'charge' || (b.assaultDelay != null && b.assaultDelay <= RULES.stunWindow + 0.3)));
        perfect = cas === 0 && sosraOK && this.stats.overwatchCasualties === 0;
      } else {
        perfect = cas === 0 && !this.objectiveContested && this.interlocks.length > 0;
      }
      grade = perfect ? 'S' : cas === 0 ? 'A' : cas <= 1 ? 'B' : 'C';
    }
    this.result = {
      win, reason, info, perfect, grade,
      time: this.t, casualties: cas, level: this.level, mode: this.mode,
      stats: { ...this.stats }, breaches: this.breaches.map((b) => ({ ...b })), interlocks: this.interlocks.length,
      tier: this.level.tier, objectiveContested: this.objectiveContested,
      rating: win ? (perfect ? (this.mode === 'breach' ? 'PERFECT BREACH' : 'FLAWLESS DEFENSE') : (this.mode === 'breach' ? 'BREACH COMPLETE' : 'POSITION HELD')) : 'MISSION FAILED',
    };
    setTimeout(() => this.ui.onRoundEnd(this.result), 1200);
  }

  // ───────────────────────────── defense prep ─────────────────────────────
  prepSequence() {
    const seq = [];
    for (const role of ['saw', 'rfl', 'sec']) { seq.push({ kind: 'pos', role }); seq.push({ kind: 'dir', role }); }
    for (let i = 0; i < this.claymoresLeft; i++) { seq.push({ kind: 'clay', i }); seq.push({ kind: 'claydir', i }); }
    return seq;
  }

  prepPrompt() {
    const seq = this.prepSequence();
    const s = seq[this.prepStep];
    if (!s) return 'All set. Press ENTER (or BEGIN) to start the defense.';
    const names = { saw: 'SAW gunner', rfl: 'Rifleman', sec: 'Security' };
    if (s.kind === 'pos') return `Click to place the ${names[s.role]}`;
    if (s.kind === 'dir') return `Click to set the ${names[s.role]}'s SECTOR OF FIRE`;
    if (s.kind === 'clay') return `Click to emplace claymore ${s.i + 1}/${this.claymoresLeft} (or ENTER to skip)`;
    return 'Click to aim the claymore';
  }

  prepCanBegin() { return this.prepStep >= 6; }

  prepClick(x, z) {
    const seq = this.prepSequence();
    const s = seq[this.prepStep];
    if (!s) return;
    const m = this.map;
    if (s.kind === 'pos' || s.kind === 'clay') {
      if (!m.canOccupy(x, z, UNIT_R, 0) || m.heightAt(x, z) > 0) { this.msg('Invalid position', 'warn', 1); return; }
      if (m.attackerSpawns.some((r) => Math.hypot(r.x - x, r.z - z) < 12)) { this.msg('Too close to the enemy', 'warn', 1.2); return; }
    }
    if (s.kind === 'pos') {
      const u = this.unitByRole(s.role);
      u.x = x; u.z = z; u.h = 0;
      if (!u.fan) this.attachFan(u);
    } else if (s.kind === 'dir') {
      const u = this.unitByRole(s.role);
      u.sectorYaw = yawTo(u, { x, z }); u.yaw = u.sectorYaw; u.fov = 110; u.range = 30;
      this.interlocks = sectorInterlocks(this.blues.filter((b) => b !== this.player && b.fan));
    } else if (s.kind === 'clay') {
      this.pendingClay = { x, z };
    } else if (s.kind === 'claydir') {
      const c = this.pendingClay;
      this.addClaymore('blue', c.x, c.z, yawTo(c, { x, z }));
      this.pendingClay = null;
    }
    this.prepStep++;
    sfx.click();
  }

  prepUndo() {
    if (this.prepStep <= 0) return;
    const seq = this.prepSequence();
    const s = seq[this.prepStep - 1];
    if (s.kind === 'claydir') {
      const c = this.claymores.filter((k) => k.team === 'blue').pop();
      if (c) { this.scene.remove(c.mesh); this.claymores.splice(this.claymores.indexOf(c), 1); }
      this.prepStep -= 2;
      return;
    }
    this.prepStep--;
  }

  updatePrep(dt) {
    // preview the pending sector direction
    const seq = this.prepSequence();
    const s = seq[this.prepStep];
    if (s && s.kind === 'dir') {
      const u = this.unitByRole(s.role);
      u.sectorYaw = yawTo(u, this.input.mouse); u.yaw = u.sectorYaw; u.fov = 110; u.range = 30;
    }
    if (s && s.kind === 'pos') {
      const u = this.unitByRole(s.role);
      u.x = this.input.mouse.x; u.z = this.input.mouse.z;
      if (!u.fan) this.attachFan(u);
    }
    this.interlocks = sectorInterlocks(this.blues.filter((b) => b !== this.player && b.fan));
    for (const u of this.units) u.moveAmt = 0;
  }

  beginDefense() {
    if (!this.prepCanBegin()) return;
    // INSANE: bunching anywhere is fatal — warn on placement
    this.state = 'live';
    this.waveTimer = 3;
    this.msg('DEFEND — hold your sectors', 'good', 2);
  }

  // ───────────────────────────── input hooks ─────────────────────────────
  onKey(code) {
    if (this.state === 'prep') {
      if (code === 'Enter' || code === 'Space') {
        if (this.prepCanBegin()) this.beginDefense();
      }
      if (code === 'Backspace') this.prepUndo();
      return;
    }
    if (this.state !== 'live') return;
    const p = this.player;
    const mp = this.input.mouse;
    switch (code) {
      case 'KeyE': this.startReduce(); break;
      case 'KeyF': this.openDoor(); break;
      case 'KeyQ':
        if (this.smokesLeft > 0 && p.alive) { this.smokesLeft--; this.throwSmoke(p, mp.x, mp.z, 'blue'); }
        else this.msg('No smoke left', 'warn', 1);
        break;
      case 'Digit1': case 'Digit2': case 'Digit3': case 'Digit4':
        this.selectUnit(this.units.filter((u) => u.team === 'blue')[+code.slice(5) - 1]);
        break;
      case 'Tab': this.cycleUnit(); break;
      case 'KeyG': this.toggleSuppressOrder(mp.x, mp.z); break;
      case 'KeyR': this.reload(); break;
      case 'KeyV': this.showFans = !this.showFans; break;
      default: break;
    }
  }
}

function rotateTo(a, b, maxStep) {
  const d = angDiff(b, a);
  if (Math.abs(d) <= maxStep) return b;
  return a + Math.sign(d) * maxStep;
}

function gauss() {
  let u = 0, v = 0;
  while (!u) u = Math.random();
  while (!v) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v) * 0.5;
}

export { isPortalType };

