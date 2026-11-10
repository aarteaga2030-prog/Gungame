// Round recorder + the 10-second stylised "Shorts" breakdown reel.
import * as THREE from 'three';

export class Recorder {
  constructor(game) {
    this.g = game;
    this.frames = [];
    this.events = [];
  }
  start() { this.frame(); }
  frame() {
    const g = this.g;
    this.frames.push({
      t: g.t,
      u: g.units.map((u) => [u.id, u.x, u.z, u.yaw, u.alive ? 1 : 0, u.h, u.moveAmt, u.stunned ? 1 : 0]),
      s: g.smokes.map((s) => [s.id, s.x, s.z, s.r, s.alpha]),
      c: g.claymores.map((c) => (c.alive ? 1 : 0)),
    });
  }
  event(type, data) { this.events.push({ t: this.g.t, type, ...data }); }
  finish() {}
}

const REEL = 10;

export class ReelPlayer {
  constructor(game, result, script, el) {
    this.g = game;
    this.result = result;
    this.script = script;
    this.el = el;
    this.rec = game.rec;
    this.reelT = 0;
    this.gameT = 0;
    this.evI = 0;
    this.done = false;
    this.focus = new THREE.Vector3(game.player.x, 0, game.player.z);
    const T = Math.max(0.1, result.time);
    this.T = T;
    // fast-forward everything up to the last 3.5 s, then play the finale in real time
    this.split = T > 8 ? 6.5 : REEL;
    this.key = [...this.rec.events].reverse().find((e) => e.type === 'key') || null;
    if (!this.key && result.win) {
      const lastKill = [...this.rec.events].reverse().find((e) => e.type === 'death' && e.team === 'red');
      if (lastKill) this.key = { x: lastKill.x, z: lastKill.z, label: 'FINAL KILL', good: true };
    }
    this.keyShown = false;
    this.unitMap = new Map(game.units.map((u) => [u.id, u]));
    this.reset();
  }

  mapTime(rt) {
    const T = this.T;
    if (T <= 8) return Math.min(T, rt * (T / 8));
    if (rt <= this.split) return (rt / this.split) * (T - 3.5);
    return Math.min(T, T - 3.5 + (rt - this.split) * (3.5 / (REEL - 1.5 - this.split)));
  }

  reset() {
    const g = this.g;
    g.world.resetTiles();
    g.fx.clear();
    for (const u of g.units) if (u.fan) u.fan.group.visible = false;
    for (const c of g.claymores) if (!c.mesh.parent) g.scene.add(c.mesh);
    for (const p of g.projectiles) g.scene.remove(p.mesh);
    for (const c of g.charges) g.scene.remove(c.mesh);
    this.reelT = 0; this.gameT = 0; this.evI = 0; this.keyShown = false; this.done = false;
    this.applyFrame(0);
  }

  frameAt(t) {
    const F = this.rec.frames;
    let lo = 0, hi = F.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (F[mid].t <= t) lo = mid; else hi = mid - 1; }
    return [F[lo], F[Math.min(F.length - 1, lo + 1)]];
  }

  applyFrame(t) {
    const [a, b] = this.frameAt(t);
    const k = b.t > a.t ? Math.min(1, Math.max(0, (t - a.t) / (b.t - a.t))) : 0;
    const bm = new Map(b.u.map((r) => [r[0], r]));
    const present = new Set();
    for (const r of a.u) {
      const u = this.unitMap.get(r[0]);
      if (!u) continue;
      present.add(u.id);
      const n = bm.get(r[0]) || r;
      u.x = r[1] + (n[1] - r[1]) * k;
      u.z = r[2] + (n[2] - r[2]) * k;
      let dy = n[3] - r[3];
      while (dy > Math.PI) dy -= 2 * Math.PI;
      while (dy < -Math.PI) dy += 2 * Math.PI;
      u.yaw = r[3] + dy * k;
      u.alive = !!r[4];
      u.h = r[5];
      u.moveAmt = r[6];
      u.vis.root.visible = true;
    }
    for (const u of this.g.units) if (!present.has(u.id)) u.vis.root.visible = false;
    this.g.smokes = a.s.map((s) => ({ id: s[0], x: s[1], z: s[2], r: s[3], alpha: s[4] }));
    a.c.forEach((alive, i) => {
      const c = this.g.claymores[i];
      if (!c) return;
      c.mesh.visible = !!alive;
    });
  }

  update(dt) {
    const g = this.g;
    if (this.done) { g.fx.update(dt); g.syncVisuals(dt); return; }
    this.reelT += dt;
    const prev = this.gameT;
    this.gameT = this.mapTime(this.reelT);
    // events in (prev, gameT]
    const ev = this.rec.events;
    let tracers = 0;
    while (this.evI < ev.length && ev[this.evI].t <= this.gameT) {
      const e = ev[this.evI++];
      if (e.t < prev - 1e-6) continue;
      switch (e.type) {
        case 'shot': if (tracers++ < 24) g.fx.tracer(e.ax, e.ay, e.az, e.bx, e.by, e.bz, e.team); break;
        case 'blast': g.fx.blast(e.x, e.z, e.r); g.shake = 1; break;
        case 'tile': g.world.buildTile(e.c, e.r, e.t, false, e.variant); break;
        case 'mortarWarn': g.fx.warning(e.x, e.z, 3.5, 1.6); break;
        default: break;
      }
    }
    this.applyFrame(this.gameT);
    if (!this.keyShown && this.key && this.reelT > REEL - 2.2) {
      this.keyShown = true;
      g.fx.warning(this.key.x, this.key.z, 2.2, 3);
    }
    // camera: steep, follows the lead (or the key moment at the end)
    const p = g.player;
    let fx = p.x, fz = p.z;
    if (this.key && this.reelT > REEL - 3) { fx = this.key.x; fz = this.key.z; }
    const kk = 1 - Math.pow(0.02, dt);
    this.focus.x += (fx - this.focus.x) * kk;
    this.focus.z += (fz - this.focus.z) * kk;
    const zoom = this.reelT > REEL - 3 ? 20 : 27;
    g.shake = Math.max(0, g.shake - dt * 2.5);
    const sx = (Math.random() - 0.5) * g.shake;
    g.camera.position.set(this.focus.x + sx, zoom, this.focus.z + zoom * 0.28);
    g.camera.lookAt(this.focus.x + sx, 0, this.focus.z);
    g.syncVisuals(dt);
    for (const u of g.units) if (u.fan) u.fan.group.visible = false;
    g.fx.update(dt);
    if (this.reelT >= REEL) this.done = true;
  }

  /** caption state for the UI: which line and how many words are revealed */
  caption() {
    const slot = REEL / this.script.length;
    const i = Math.min(this.script.length - 1, Math.floor(this.reelT / slot));
    const line = this.script[i];
    const local = (this.reelT - i * slot) / (slot * 0.6);
    const n = Math.min(line.words.length, Math.ceil(local * line.words.length));
    return { i, words: line.words, n, progress: Math.min(1, this.reelT / REEL) };
  }
}
