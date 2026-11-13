// Renders a game from snapshots (the same format on the host and on clients).
// Fog of war: enemies are drawn only while someone on your side has line of sight to them.
import * as THREE from 'three';
import { GameMap, T } from './map.js';
import { MAPS } from './maps.js';
import { World, textSprite } from './world.js';
import { FX, makeRing } from './fx.js';
import { makeSoldier } from './assets.js';
import { sfx, audio } from './audio.js';

const RED_SEEN_FADE = 2.5;

export class View {
  /** roster: [[id, isRed, role, name, humanPeer, isAR]] */
  constructor(scene, mapId, roster, localTeam, localUnitId) {
    this.scene = scene;
    this.map = new GameMap(MAPS[mapId]);
    this.world = new World(scene, this.map);
    this.map.onChange = (c, r, t, v) => this.world.buildTile(c, r, t, false, v);
    this.fx = new FX(scene);
    this.localTeam = localTeam;
    this.localId = localUnitId;
    this.units = new Map();
    for (const [id, isRed, role, name, human] of roster) {
      const team = isRed ? 'red' : 'blue';
      const vis = makeSoldier(team);
      const ring = makeRing(team);
      vis.root.add(ring);
      const tag = textSprite(human ? name : role, team === 'blue' ? '#1f6fff' : '#ff2d2d', 0, 2.35, 0, 0.55);
      vis.root.add(tag);
      scene.add(vis.root);
      this.units.set(id, { id, team, role, name, human, vis, ring, tag, s: null, phase: Math.random() * 6, deadT: 0, seenUntil: -1, ghost: null });
    }
    this.claymores = new Map();
    this.projs = new Map();
    this.chargeMeshes = new Map();
    this.smokes = [];
    this.t = 0;
    this.shake = 0;
  }

  dispose() {
    for (const u of this.units.values()) { this.scene.remove(u.vis.root); if (u.ghost) this.scene.remove(u.ghost); }
    for (const m of [...this.claymores.values(), ...this.projs.values(), ...this.chargeMeshes.values()]) this.scene.remove(m);
    this.world.dispose();
    this.fx.clear();
    this.scene.remove(this.fx.group);
  }

  applyTiles(list) {
    for (let i = 0; i < list.length; i += 2) {
      const idx = list[i], t = list[i + 1];
      const c = idx % this.map.cols, r = (idx / this.map.cols) | 0;
      if (this.map.get(c, r) !== t) this.map.set(c, r, t, t === T.RUBBLE ? 'blown' : undefined);
    }
  }

  /** Visual reactions to sim events. */
  events(evs) {
    for (const e of evs) {
      if (e.k === 'shot') {
        const a = e.a;
        this.fx.tracer(a[0], a[1], a[2], a[3], a[4], a[5], e.tm);
        sfx.shot(e.tm, a[0], a[2], false);
      } else if (e.k === 'blast') {
        this.fx.blast(e.x, e.z, e.r, e.c === 'claymore' ? 0xffd27a : 0xffaa55);
        sfx.boom(e.x, e.z, e.c === 'grenade' ? 0.8 : 1.1);
        this.shake = Math.max(this.shake, 1.0);
      } else if (e.k === 'tile') {
        this.map.set(e.c, e.r, e.t, e.v);
      }
    }
  }

  /** Is this point seen by anyone on the local team right now? */
  seen(x, z, units) {
    for (const f of units) {
      if (f.team !== this.localTeam || !f.s || !f.s.alive) continue;
      const d = Math.hypot(f.s.x - x, f.s.z - z);
      if (d < 2.5) return true;
      if (d < 70 && this.map.los(f.s.x, f.s.z, x, z, this.smokes)) return true;
    }
    return false;
  }

  /** snap: decoded state { units: Map id→{x,z,yaw,hp,alive,crouch,stun,moveAmt,...}, smokes, claymores, projs, charges } */
  render(snap, dt) {
    this.t += dt;
    this.smokes = snap.smokes;
    const list = [...this.units.values()];
    for (const u of list) {
      const s = snap.units.get(u.id);
      if (!s) continue;
      s.h = this.map.heightAt(s.x, s.z);
      u.s = s;
    }
    for (const u of list) {
      const s = u.s;
      if (!s) continue;
      const v = u.vis;
      v.root.position.set(s.x, s.h, s.z);
      v.root.rotation.y = s.yaw;
      let visible = true;
      if (u.tag) u.tag.visible = this.localTeam === 'all' || u.team === this.localTeam;
      if (this.localTeam !== 'all' && u.team !== this.localTeam && s.alive) {
        visible = this.seen(s.x, s.z, list);
        if (visible) u.seenUntil = this.t + RED_SEEN_FADE;
      }
      v.root.visible = visible;
      // last-known marker for enemies that dropped out of sight
      if (u.ghost && (this.localTeam === 'all' || u.team === this.localTeam)) u.ghost.visible = false;
      if (u.team !== this.localTeam && this.localTeam !== 'all') {
        const showGhost = !visible && s.alive && this.t < u.seenUntil;
        if (showGhost && !u.ghost) {
          u.ghost = new THREE.Mesh(new THREE.RingGeometry(0.35, 0.5, 24), new THREE.MeshBasicMaterial({ color: 0xff2d2d, transparent: true, depthWrite: false }));
          u.ghost.rotation.x = -Math.PI / 2;
          this.scene.add(u.ghost);
          u.ghost.position.set(s.x, 0.05, s.z);
        }
        if (u.ghost) {
          u.ghost.visible = showGhost;
          if (showGhost) u.ghost.material.opacity = (u.seenUntil - this.t) / RED_SEEN_FADE;
          else if (visible) u.ghost.position.set(s.x, 0.05, s.z);
        }
      }
      if (!s.alive) {
        u.deadT = Math.min(1, u.deadT + dt * 4);
        v.tilt.rotation.x = -Math.PI / 2 * u.deadT;
        v.tilt.position.y = 0.15 * u.deadT;
        v.tilt.scale.y = 1;
        u.ring.visible = false;
        if (u.tag) u.tag.visible = false;
        continue;
      }
      u.deadT = 0;
      v.tilt.rotation.x = 0; v.tilt.position.y = 0;
      v.tilt.scale.y = s.crouch ? 0.72 : 1;
      u.ring.visible = true;
      const local = u.id === this.localId;
      u.ring.scale.setScalar(local ? 1.4 : 1);
      u.ring.children[1].material.opacity = local ? 0.45 : 0.18;
      u.ring.children[0].material.opacity = s.stun ? 0.3 + 0.7 * Math.abs(Math.sin(this.t * 30)) : 0.95;
      u.phase += dt * 9 * s.moveAmt;
      if (visible) v.pose(u.phase, s.moveAmt);
    }
    // claymores: yours always, the enemy's only when seen
    const liveC = new Set();
    for (const [id, x, z, yaw, isRed] of snap.claymores) {
      liveC.add(id);
      let m = this.claymores.get(id);
      if (!m) { m = claymoreMesh(isRed ? 'red' : 'blue'); m.position.set(x, 0, z); m.rotation.y = yaw; this.scene.add(m); this.claymores.set(id, m); }
      const mine = this.localTeam === 'all' || (isRed ? 'red' : 'blue') === this.localTeam;
      m.visible = mine || this.seenClose(x, z, list);
    }
    for (const [id, m] of this.claymores) if (!liveC.has(id)) { this.scene.remove(m); this.claymores.delete(id); }
    // projectiles
    const liveP = new Set();
    for (const [id, x, y, z, kind] of snap.projs) {
      liveP.add(id);
      let m = this.projs.get(id);
      if (!m) { m = new THREE.Mesh(new THREE.SphereGeometry(kind === 'g' ? 0.09 : 0.12, 10, 8), new THREE.MeshStandardMaterial({ color: kind === 's' ? 0x8a9a60 : 0x3a4030 })); this.scene.add(m); this.projs.set(id, m); }
      m.position.set(x, y, z);
    }
    for (const [id, m] of this.projs) if (!liveP.has(id)) { this.scene.remove(m); this.projs.delete(id); }
    // placed charges
    const liveB = new Set();
    for (const [id, x, z] of snap.charges) {
      liveB.add(id);
      let m = this.chargeMeshes.get(id);
      if (!m) { m = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), new THREE.MeshStandardMaterial({ color: 0xff3300, emissive: 0x661100 })); m.position.set(x, 1, z); this.scene.add(m); this.chargeMeshes.set(id, m); }
      m.visible = Math.sin(this.t * 30) > 0;
    }
    for (const [id, m] of this.chargeMeshes) if (!liveB.has(id)) { this.scene.remove(m); this.chargeMeshes.delete(id); }
    this.fx.syncSmokes(snap.smokes);
    this.fx.update(dt);
    this.shake = Math.max(0, this.shake - dt * 2.5);
  }

  seenClose(x, z, list) {
    for (const f of list) {
      if (f.team !== this.localTeam || !f.s || !f.s.alive) continue;
      const d = Math.hypot(f.s.x - x, f.s.z - z);
      if (d < 12 && this.map.los(f.s.x, f.s.z, x, z, this.smokes)) return true;
    }
    return false;
  }

  setListener(x, z) { audio.listener.x = x; audio.listener.z = z; }
}

function claymoreMesh(team) {
  const g = new THREE.Group();
  const body = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.18, 0.08), new THREE.MeshStandardMaterial({ color: 0x55603a }));
  body.position.y = 0.2;
  g.add(body);
  const col = team === 'red' ? 0xff2020 : 0x2f7bff;
  const pts = [];
  for (const a of [-0.9, -0.45, 0, 0.45, 0.9]) pts.push(new THREE.Vector3(0, 0.12, 0), new THREE.Vector3(Math.sin(a) * 3, 0.12, Math.cos(a) * 3));
  g.add(new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: col })));
  return g;
}

/** Decode a network snapshot (sim.snapshot format) into the render state. */
export function decodeSnap(s) {
  const units = new Map();
  for (const a of s.u) {
    units.set(a[0], {
      id: a[0], x: a[1], z: a[2], yaw: a[3], hp: a[4], alive: !!(a[5] & 1), crouch: !!(a[5] & 2), stun: !!(a[5] & 4),
      reloading: !!(a[5] & 8), channel: !!(a[5] & 16), moveAmt: a[6], ammo: a[7], mags: a[8], frags: a[9], smokes: a[10],
      charges: a[11], clay: a[12], supp: a[13], chanP: a[14], h: 0,
    });
  }
  return { ai: s.ai, t: s.t, phase: s.ph, prepLeft: s.pl, timeLeft: s.tl, units, smokes: s.s.map((k) => ({ id: k[0], x: k[1], z: k[2], r: k[3], alpha: k[4] })), claymores: s.c, projs: s.p, charges: s.b };
}
