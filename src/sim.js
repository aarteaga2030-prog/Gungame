// Authoritative simulation. Runs on the solo player's machine or on the multiplayer host.
// No rendering here and no scripted outcomes: everything that happens is the result of
// someone (a player or an AI) moving, shooting, throwing or blowing something up.
import { GameMap, T, TILE, segPointDist, isLowCover, isBreachable, rng } from './map.js';
import { MAPS } from './maps.js';
import { PROFILES, rolesFor } from './doctrine.js';
import { TeamAI } from './ai.js';

export const R_UNIT = 0.36;
export const CFG = {
  stunWindow: 1.5, reduceTime: 3, ironTime: 5, fuse: 1.2, smokeR: 3.6, smokeLife: 16, wireSpeed: 0.2,
  prep: { breach: 20, defense: 45 }, timeLimit: { breach: 600, defense: 300 },
  walk: 4.0, sprint: 5.8, crouchSpeed: 2.0, seizeTime: 8,
};

const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const yawTo = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);

let UID = 1;

export class Sim {
  /**
   * opts: { mapId, mission: 'breach'|'defense', difficulty, humans: [{peer, name}], aiMates, seed }
   * Blue = the players' side (+ AI teammates). Red = the AI opposing force.
   * Breach: blue attacks, red defends the building. Defense: blue holds the building, red attacks.
   */
  constructor(opts) {
    this.opts = opts;
    this.def = MAPS[opts.mapId];
    this.map = new GameMap(this.def);
    this.mission = opts.mission;
    this.profile = PROFILES[opts.difficulty];
    // AI vs AI: blue is a full AI force too (no players)
    this.matchup = !!opts.blueForce;
    this.blueProfile = this.matchup ? PROFILES[opts.blueForce] : PROFILES.VETERAN;
    this.rand = rng(opts.seed || 1);
    this.t = 0;
    this.phase = 'prep';
    this.prepLeft = CFG.prep[this.mission];
    this.timeLeft = CFG.timeLimit[this.mission];
    this.units = [];
    this.smokes = [];
    this.projectiles = [];
    this.charges = [];
    this.claymores = [];
    this.events = [];
    this.result = null;
    this.seizeT = 0;
    this.stats = { blueKills: 0, redKills: 0, shots: 0 };
    this.blueAttacks = this.mission === 'breach';
    this.map.onChange = (c, r, t, variant) => this.events.push({ k: 'tile', c, r, t, v: variant });
    this.spawnForces();
    this.ai = {
      red: new TeamAI(this, 'red', this.profile, this.blueAttacks ? 'defend' : 'attack'),
      blue: new TeamAI(this, 'blue', this.blueProfile, this.matchup ? (this.blueAttacks ? 'attack' : 'defend') : 'escort'),
    };
  }

  // ───────────── spawning ─────────────
  spawnForces() {
    const m = this.map;
    const atk = m.attackSpawns.slice();
    const inside = m.interior.slice().sort(() => this.rand() - 0.5);
    const blueSpots = this.blueAttacks ? atk : this.insideSpots(inside, true);
    const redSpots = this.blueAttacks ? this.insideSpots(inside) : atk;
    let bi = 0;
    for (const h of this.opts.humans) {
      const p = blueSpots[bi++ % blueSpots.length];
      this.addUnit({ team: 'blue', role: 'OP', human: h.peer, name: h.name, ...p });
    }
    if (this.matchup) {
      const blueSpread = this.blueAttacks ? blueSpots : this.insideSpots(inside, false);
      rolesFor(this.blueProfile.size).forEach((r, i) => {
        const p = blueSpread[(i * 3) % blueSpread.length];
        this.addUnit({ team: 'blue', role: r.role, fireTeam: r.team, name: `${r.role}${r.team >= 0 ? r.team + 1 : ''}`, ...p });
      });
    } else {
      for (let i = 0; i < (this.opts.aiMates || 0); i++) {
        const p = blueSpots[bi++ % blueSpots.length];
        this.addUnit({ team: 'blue', role: 'RF', name: `AI ${i + 1}`, ...p });
      }
    }
    const roles = rolesFor(this.profile.size);
    roles.forEach((r, i) => {
      const p = redSpots[(i * 3) % redSpots.length];
      this.addUnit({ team: 'red', role: r.role, fireTeam: r.team, name: `${r.role}${r.team >= 0 ? r.team + 1 : ''}`, ...p });
    });
  }

  insideSpots(inside, nearObjective) {
    const ground = inside.filter((p) => this.map.heightAt(p.x, p.z) === 0);
    if (nearObjective) {
      const o = this.map.objective;
      return ground.sort((a, b) => Math.hypot(a.x - o.x, a.z - o.z) - Math.hypot(b.x - o.x, b.z - o.z)).filter((p, i) => i % 2 === 0);
    }
    return ground.concat(inside); // AI defenders spread over the interior
  }

  addUnit(o) {
    const p = this.free(o.x, o.z);
    const ar = o.role === 'AR';
    const prof = o.team === 'red' ? this.profile : this.blueProfile;
    const isHuman = !!o.human;
    const defending = (o.team === 'blue') !== this.blueAttacks;
    const u = {
      id: UID++, team: o.team, role: o.role, fireTeam: o.fireTeam ?? 0, human: o.human || null, name: o.name,
      x: p.x, z: p.z, h: 0, yaw: o.team === 'blue' === this.blueAttacks ? Math.PI : 0,
      hp: 100, alive: true, crouch: false, moveAmt: 0,
      weapon: ar ? 'ar' : 'rifle', mag: ar ? 100 : 30, ammo: ar ? 100 : 30, mags: ar ? 3 : 6, reloadUntil: 0, nextShot: 0,
      frags: isHuman ? 2 : prof.frags, smokes: isHuman ? 2 : (o.role === 'SL' || o.role === 'TL' ? prof.smokes : 0),
      charges: defending ? 0 : (isHuman ? 2 : (o.role === 'TL' || o.role === 'SL' ? prof.charges : 0)),
      claymores: defending ? (isHuman ? 2 : (o.role === 'TL' || o.role === 'SL' ? prof.claymores : 0)) : 0,
      gl: o.role === 'GR' ? prof.gl : 0,
      suppression: 0, stunUntil: 0, channel: null, lastFired: -99,
      ctl: blankCtl(), seq: {},
    };
    this.units.push(u);
    return u;
  }

  free(x, z) {
    for (let r = 0; r <= 6; r += 0.5) {
      for (let a = 0; a < 12; a++) {
        const px = x + Math.sin((a / 12) * 6.283) * r, pz = z + Math.cos((a / 12) * 6.283) * r;
        if (px < 1 || pz < 1 || px > this.map.w - 1 || pz > this.map.h - 1) continue;
        const h = this.map.heightAt(px, pz);
        if (this.map.canOccupy(px, pz, R_UNIT + 0.05, h) && !this.units.some((u) => Math.hypot(u.x - px, u.z - pz) < 0.9)) return { x: px, z: pz };
      }
    }
    return { x, z };
  }

  /** A player disconnected: an AI teammate takes over their soldier. */
  dropHuman(peer) {
    const u = this.humanUnit(peer);
    if (!u) return;
    u.human = null;
    u.ctl = blankCtl();
    this.ai[u.team].initUnit(u);
    this.events.push({ k: 'msg', text: `${u.name} left — AI took over`, kind: '' });
  }

  get alive() { return this.units.filter((u) => u.alive); }
  team(t) { return this.units.filter((u) => u.alive && u.team === t); }
  unit(id) { return this.units.find((u) => u.id === id); }
  humanUnit(peer) { return this.units.find((u) => u.human === peer); }

  // ───────────── main step ─────────────
  step(dt) {
    if (this.phase === 'over') return;
    this.t += dt;
    if (this.phase === 'prep') {
      this.prepLeft -= dt;
      if (this.prepLeft <= 0) { this.phase = 'live'; this.events.push({ k: 'msg', text: 'GO — mission live', kind: 'good' }); }
    } else this.timeLeft -= dt;
    this.ai.red.update(dt);
    this.ai.blue.update(dt);
    for (const u of this.units) if (u.alive) this.applyControl(u, dt);
    this.separate();
    this.updateSmokes(dt);
    this.updateProjectiles(dt);
    this.updateCharges(dt);
    this.updateClaymores();
    for (const u of this.units) {
      u.suppression = Math.max(0, u.suppression - dt * 0.35);
      if (u.reloadUntil && this.t >= u.reloadUntil) { u.ammo = u.mag; u.mags--; u.reloadUntil = 0; }
    }
    this.checkEnd(dt);
  }

  // ───────────── control (players and AI use the same path) ─────────────
  applyControl(u, dt) {
    const c = u.ctl;
    u.crouch = !!c.crouch;
    // staging-area limit for attackers during the defenders' prep
    let mx = c.mx || 0, mz = c.mz || 0;
    const L = Math.hypot(mx, mz);
    if (L > 1) { mx /= L; mz /= L; }
    if (u.channel) {
      if (L > 0.1) { u.channel = null; }
      else {
        u.channel.t += dt;
        u.moveAmt = 0;
        if (u.channel.t >= u.channel.dur) this.completeChannel(u);
      }
    }
    if (!u.channel) {
      let sp = c.sprint && !u.crouch ? CFG.sprint : u.crouch ? CFG.crouchSpeed : CFG.walk;
      if (this.map.tileAt(u.x, u.z) === T.WIRE) sp *= CFG.wireSpeed;
      if (this.t < u.stunUntil) sp *= 0.5;
      this.moveUnit(u, mx * sp * dt, mz * sp * dt);
      if (this.phase === 'prep' && u.team === (this.blueAttacks ? 'blue' : 'red')) {
        const s = this.map.spawn;
        const d = Math.hypot(u.x - s.x, u.z - s.z);
        if (d > 16) { u.x = s.x + ((u.x - s.x) / d) * 16; u.z = s.z + ((u.z - s.z) / d) * 16; }
      }
      u.moveAmt = Math.min(1, L) * (c.sprint ? 1 : 0.7);
    }
    if (c.ax != null) u.yaw = Math.atan2(c.ax - u.x, c.az - u.z);
    // weapon
    if (!u.channel && !u.reloadUntil) {
      if (c.reload && u.ammo < u.mag && u.mags > 0) { u.reloadUntil = this.t + (u.weapon === 'ar' ? 4 : 2.2); c.reload = 0; }
      else if (c.fire > 0 || c.hold) {
        const rof = u.weapon === 'ar' ? 0.085 : u.human ? 0.11 : 0.22;
        if (this.t >= u.nextShot) {
          if (u.ammo <= 0) { if (u.mags > 0) u.reloadUntil = this.t + (u.weapon === 'ar' ? 4 : 2.2); }
          else {
            this.shoot(u, c.err || 0);
            u.nextShot = this.t + rof;
            if (c.fire > 0) c.fire--;
          }
        }
      }
    }
    c.reload = 0;
    // actions
    if (c.use) { c.use = 0; this.use(u); }
    if (c.charge) { c.charge = 0; this.startCharge(u); }
    if (c.frag) { const p = c.frag; c.frag = null; if (u.frags > 0) { u.frags--; this.throwProj(u, 'frag', p.x, p.z); } }
    if (c.smoke) { const p = c.smoke; c.smoke = null; if (u.smokes > 0) { u.smokes--; this.throwProj(u, 'smoke', p.x, p.z); } }
    if (c.gl) { const p = c.gl; c.gl = null; if (u.gl > 0) { u.gl--; this.throwProj(u, 'gl', p.x, p.z); } }
    if (c.clay) { c.clay = 0; this.placeClaymore(u); }
  }

  /** Map a player's network input (absolute state + action counters) onto their control block. */
  applyInput(u, inp) {
    if (!u || !inp) return;
    const c = u.ctl;
    c.mx = clampNum(inp.mx); c.mz = clampNum(inp.mz);
    c.ax = num(inp.ax, u.x); c.az = num(inp.az, u.z);
    c.sprint = !!inp.sp; c.crouch = !!inp.cr;
    const take = (key) => {
      const v = inp[key] | 0;
      const prev = u.seq[key];
      u.seq[key] = v;
      if (prev === undefined) return 0;
      return Math.max(0, Math.min(3, v - prev));
    };
    c.fire = Math.min(3, (c.fire || 0) + take('fs'));
    if (take('rs')) c.reload = 1;
    if (take('us')) c.use = 1;
    if (take('cs')) c.charge = 1;
    if (take('gs')) c.frag = { x: c.ax, z: c.az };
    if (take('ss')) c.smoke = { x: c.ax, z: c.az };
    if (take('ys')) c.clay = 1;
  }

  moveUnit(u, mx, mz) {
    const m = this.map;
    if (m.canOccupy(u.x + mx, u.z, R_UNIT, u.h)) u.x += mx;
    if (m.canOccupy(u.x, u.z + mz, R_UNIT, u.h)) u.z += mz;
    u.h = m.heightAt(u.x, u.z);
  }

  separate() {
    const us = this.alive;
    for (let i = 0; i < us.length; i++) for (let j = i + 1; j < us.length; j++) {
      const a = us[i], b = us[j];
      const dx = b.x - a.x, dz = b.z - a.z;
      const d = Math.hypot(dx, dz);
      if (d > 0.72 || d < 1e-4 || Math.abs(a.h - b.h) > 0.8) continue;
      const push = (0.72 - d) / 2, nx = dx / d, nz = dz / d;
      if (this.map.canOccupy(a.x - nx * push, a.z - nz * push, R_UNIT, a.h)) { a.x -= nx * push; a.z -= nz * push; }
      if (this.map.canOccupy(b.x + nx * push, b.z + nz * push, R_UNIT, b.h)) { b.x += nx * push; b.z += nz * push; }
    }
  }

  // ───────────── shooting ─────────────
  muzzle(u) { return { x: u.x + Math.sin(u.yaw) * 0.55, z: u.z + Math.cos(u.yaw) * 0.55, y: u.h + (u.crouch ? 0.9 : 1.3) }; }

  /** A physical round: travels along the aim line (plus error) and hits the first thing in its way. */
  shoot(u, extraErr) {
    u.ammo--;
    u.lastFired = this.t;
    this.stats.shots++;
    let spread = u.human ? 0.012 : 0;
    if (u.human) {
      spread *= (u.moveAmt > 0.3 ? 2.2 : 1) * (u.crouch ? 0.7 : 1) * (1 + u.suppression * 2) * (this.t < u.stunUntil ? 4 : 1);
    }
    if (u.weapon === 'ar') spread += 0.02;
    const a = u.yaw + gauss(this.rand) * spread + (extraErr || 0);
    const dx = Math.sin(a), dz = Math.cos(a);
    const m = this.muzzle(u);
    let maxd = this.map.rayDist(m.x, m.z, dx, dz, 80);
    let hit = null;
    for (const o of this.units) {
      if (o === u || !o.alive) continue;
      const fx = o.x - m.x, fz = o.z - m.z;
      const t = fx * dx + fz * dz;
      if (t < 0 || t > maxd) continue;
      const rad = o.crouch ? 0.32 : 0.42;
      if (Math.abs(fx * dz - fz * dx) < rad) { maxd = t; hit = o; }
    }
    // low cover right in front of the target soaks rounds (more if the target is crouched)
    if (hit && u.h - hit.h < 1.0) {
      let blocked = false;
      this.map.walk(m.x, m.z, hit.x, hit.z, (c, r, t) => {
        if (!isLowCover(t)) return false;
        const p = this.map.center(c, r);
        if (Math.hypot(p.x - hit.x, p.z - hit.z) < TILE * 1.25) {
          blocked = this.rand() < (hit.crouch ? 0.85 : 0.4);
          if (blocked) maxd = Math.max(0, Math.hypot(p.x - m.x, p.z - m.z) - 0.8);
          return true;
        }
        return false;
      });
      if (blocked) hit = null;
    }
    const ex = m.x + dx * maxd, ez = m.z + dz * maxd;
    if (hit) this.damage(hit, 33 + this.rand() * 12, u, 'gunshot');
    this.events.push({ k: 'shot', a: [r1(m.x), r1(m.y), r1(m.z), r1(ex), hit ? r1(hit.h + 1.1) : 0.8, r1(ez)], tm: u.team, u: u.id });
    // what everybody else perceives: near misses suppress, the shot is heard
    for (const o of this.units) {
      if (!o.alive || o === u || o === hit) continue;
      if (o.team !== u.team && segPointDist(m.x, m.z, ex, ez, o.x, o.z) < 1.8) {
        o.suppression = Math.min(1, o.suppression + 0.22);
        this.notifyAI(o, 'incoming', { from: { x: u.x, z: u.z }, by: u });
      }
    }
    this.sound(u.x, u.z, u.weapon === 'ar' ? 70 : 55, u);
  }

  sound(x, z, range, src) {
    for (const team of ['red', 'blue']) this.ai[team]?.hear(x, z, range, src);
  }

  notifyAI(u, kind, data) {
    if (u.human) return;
    this.ai[u.team]?.perceive(u, kind, data);
  }

  damage(u, amt, src, cause) {
    if (!u.alive) return;
    u.hp -= amt;
    u.suppression = Math.min(1, u.suppression + 0.5);
    if (src && src.team !== u.team) this.notifyAI(u, 'hit', { from: { x: src.x, z: src.z }, by: src });
    if (u.hp <= 0) {
      u.hp = 0; u.alive = false; u.channel = null;
      u.killedBy = src ? src.id : null;
      u.cause = cause;
      if (u.team === 'red') this.stats.blueKills++; else this.stats.redKills++;
      this.events.push({ k: 'death', u: u.id, cause });
      if (u.human) this.events.push({ k: 'msg', text: `${u.name} is down`, kind: 'bad' });
    }
  }

  // ───────────── interactions ─────────────
  adjacentTile(u, pred, reach = 2.2) {
    const tc = this.map.toTile(u.x, u.z);
    let best = null, bd = reach;
    for (let r = tc.r - 2; r <= tc.r + 2; r++) for (let c = tc.c - 2; c <= tc.c + 2; c++) {
      const t = this.map.get(c, r);
      if (!this.map.inb(c, r) || !pred(t)) continue;
      const nx = Math.max(c * TILE, Math.min(u.x, (c + 1) * TILE)), nz = Math.max(r * TILE, Math.min(u.z, (r + 1) * TILE));
      // prefer what the soldier is facing
      const ctr = this.map.center(c, r);
      const facing = Math.abs(angDiff(yawTo(u, ctr), u.yaw)) < 1.2 ? 0 : 0.6;
      const d = Math.hypot(nx - u.x, nz - u.z) + facing;
      if (d < bd) { bd = d; best = { c, r, t, ...ctr }; }
    }
    return best;
  }

  /** E: open/close a door, cut wire, disarm a claymore. */
  use(u) {
    const clay = this.claymores.find((k) => k.alive && k.team !== u.team && dist(k, u) < 1.6);
    if (clay) { u.channel = { kind: 'disarm', clay, t: 0, dur: CFG.reduceTime }; return; }
    const door = this.adjacentTile(u, (t) => t === T.DOOR || t === T.OPEN, 1.8);
    if (door) {
      if (door.t === T.DOOR) this.map.set(door.c, door.r, T.OPEN);
      else if (!this.units.some((o) => o.alive && this.map.toTile(o.x, o.z).c === door.c && this.map.toTile(o.x, o.z).r === door.r)) this.map.set(door.c, door.r, T.DOOR);
      this.sound(u.x, u.z, 10, u);
      return;
    }
    const wire = this.adjacentTile(u, (t) => t === T.WIRE, 1.9);
    if (wire) u.channel = { kind: 'cut', ...wire, t: 0, dur: CFG.reduceTime };
  }

  startCharge(u) {
    if (u.charges <= 0) return;
    const tg = this.adjacentTile(u, isBreachable, 1.9);
    if (!tg) return;
    u.channel = { kind: 'charge', ...tg, t: 0, dur: tg.t === T.IRON ? CFG.ironTime : CFG.reduceTime };
  }

  completeChannel(u) {
    const ch = u.channel;
    u.channel = null;
    if (ch.kind === 'charge') {
      if (!isBreachable(this.map.get(ch.c, ch.r)) || u.charges <= 0) return;
      u.charges--;
      this.charges.push({ id: UID++, c: ch.c, r: ch.r, x: ch.x, z: ch.z, fuse: CFG.fuse, owner: u.id, team: u.team });
    } else if (ch.kind === 'cut') {
      if (this.map.get(ch.c, ch.r) === T.WIRE) this.map.set(ch.c, ch.r, T.FLOOR);
    } else if (ch.kind === 'disarm') {
      ch.clay.alive = false;
    }
  }

  updateCharges(dt) {
    for (let i = this.charges.length - 1; i >= 0; i--) {
      const c = this.charges[i];
      c.fuse -= dt;
      if (c.fuse > 0) continue;
      this.charges.splice(i, 1);
      this.map.set(c.c, c.r, T.RUBBLE, 'blown');
      this.explode(c.x, c.z, 4.5, 80, this.unit(c.owner), 'breach', 10);
    }
  }

  placeClaymore(u) {
    if (u.claymores <= 0) return;
    const x = u.x + Math.sin(u.yaw) * 0.8, z = u.z + Math.cos(u.yaw) * 0.8;
    if (!this.map.canOccupy(x, z, 0.1, u.h)) return;
    u.claymores--;
    this.claymores.push({ id: UID++, team: u.team, owner: u.id, x, z, yaw: u.yaw, alive: true });
  }

  updateClaymores() {
    for (const k of this.claymores) {
      if (!k.alive) continue;
      for (const o of this.units) {
        if (!o.alive || o.team === k.team) continue;
        const d = dist(o, k);
        if ((d < 3.2 && Math.abs(angDiff(yawTo(k, o), k.yaw)) < 1.05) || d < 0.8) {
          k.alive = false;
          const owner = this.unit(k.owner);
          this.explode(k.x + Math.sin(k.yaw) * 1.5, k.z + Math.cos(k.yaw) * 1.5, 8, 85, owner, 'claymore', 8, { yaw: k.yaw, from: k });
          break;
        }
      }
    }
  }

  /** Blast with distance falloff; walls shield; arc-limited for claymores. */
  explode(x, z, radius, maxDmg, src, cause, stunR, arc) {
    this.events.push({ k: 'blast', x: r1(x), z: r1(z), r: radius, c: cause });
    for (const o of this.units) {
      if (!o.alive) continue;
      const d = Math.hypot(o.x - x, o.z - z);
      if (arc && Math.abs(angDiff(yawTo(arc.from, o), arc.yaw)) > 1.1) continue;
      if (!this.map.los(x, z, o.x, o.z)) continue;
      if (d < radius) this.damage(o, maxDmg * Math.pow(1 - d / radius, 1.1), src, cause);
      if (o.alive && d < stunR) {
        o.suppression = 1;
        if (cause === 'breach' || d < radius * 0.8) o.stunUntil = Math.max(o.stunUntil, this.t + CFG.stunWindow);
      }
    }
    this.sound(x, z, 120, src);
  }

  // ───────────── grenades & smoke ─────────────
  throwProj(u, kind, tx, tz) {
    const maxd = kind === 'gl' ? 150 : 22;
    let dx = tx - u.x, dz = tz - u.z;
    const L = Math.hypot(dx, dz) || 1;
    if (L > maxd) { tx = u.x + (dx / L) * maxd; tz = u.z + (dz / L) * maxd; }
    // a thrown/launched object stops at the first wall in its path (it can go through open doors/windows)
    const d = Math.min(Math.hypot(tx - u.x, tz - u.z), this.map.rayDist(u.x, u.z, dx / L, dz / L, maxd) - 0.4);
    tx = u.x + (dx / L) * Math.max(0.5, d); tz = u.z + (dz / L) * Math.max(0.5, d);
    const flight = kind === 'gl' ? 0.25 + d / 75 : 0.5 + d / 30;
    this.projectiles.push({ id: UID++, kind, ax: u.x, az: u.z, bx: tx, bz: tz, t: 0, dur: flight, fuse: kind === 'frag' ? 2.4 : 0, owner: u.id, team: u.team });
    this.sound(u.x, u.z, kind === 'gl' ? 25 : 8, u);
  }

  updateProjectiles(dt) {
    for (let i = this.projectiles.length - 1; i >= 0; i--) {
      const p = this.projectiles[i];
      p.t += dt;
      const k = Math.min(1, p.t / p.dur);
      p.x = p.ax + (p.bx - p.ax) * k; p.z = p.az + (p.bz - p.az) * k;
      p.y = 0.2 + Math.sin(k * Math.PI) * (p.kind === 'gl' ? 2 : 3);
      const landed = k >= 1;
      if (p.kind === 'smoke' && landed) {
        this.projectiles.splice(i, 1);
        this.smokes.push({ id: p.id, x: p.bx, z: p.bz, r: 0, age: 0, alpha: 1 });
      } else if (p.kind === 'gl' && landed) {
        this.projectiles.splice(i, 1);
        this.explode(p.bx, p.bz, 5, 80, this.unit(p.owner), 'grenade', 8);
      } else if (p.kind === 'frag' && p.t >= p.fuse) {
        this.projectiles.splice(i, 1);
        this.explode(p.bx, p.bz, 6.5, 90, this.unit(p.owner), 'grenade', 9);
      } else if (p.kind === 'frag' && landed && !p.warned) {
        p.warned = true;
        for (const o of this.units) if (o.alive && dist(o, { x: p.bx, z: p.bz }) < 8 && this.map.los(o.x, o.z, p.bx, p.bz)) this.notifyAI(o, 'grenade', { x: p.bx, z: p.bz });
      }
    }
  }

  updateSmokes(dt) {
    for (let i = this.smokes.length - 1; i >= 0; i--) {
      const s = this.smokes[i];
      s.age += dt;
      s.r = CFG.smokeR * Math.min(1, s.age / 1.3);
      const rem = CFG.smokeLife - s.age;
      if (rem < 3) { s.alpha = Math.max(0, rem / 3); s.r *= 0.6 + 0.4 * s.alpha; }
      if (rem <= 0) this.smokes.splice(i, 1);
    }
  }

  // ───────────── outcome ─────────────
  checkEnd(dt) {
    if (this.phase !== 'live') return;
    const blue = this.team('blue'), red = this.team('red');
    const end = (win, reason) => {
      this.phase = 'over';
      this.result = { win, reason, time: this.t, stats: { ...this.stats }, mission: this.mission, map: this.def.name, difficulty: this.opts.difficulty,
        blueLost: this.units.filter((u) => u.team === 'blue' && !u.alive).length, blueTotal: this.units.filter((u) => u.team === 'blue').length,
        redLost: this.units.filter((u) => u.team === 'red' && !u.alive).length, redTotal: this.units.filter((u) => u.team === 'red').length,
        matchup: this.matchup, blueForce: this.opts.blueForce || null };
      this.events.push({ k: 'end', result: this.result });
    };
    const side = (b) => (this.matchup ? (b ? 'Blue' : 'Red') : (b ? 'Your side' : 'The enemy'));
    if (!blue.length) return end(false, this.matchup ? 'Red wins — the blue force was wiped out.' : 'Your side was wiped out.');
    if (!red.length) return end(true, (this.matchup ? 'Blue wins — ' : '') + (this.blueAttacks ? 'building cleared, every defender is down.' : 'the assault is broken, every attacker is down.'));
    const obj = this.map.objective;
    if (this.blueAttacks) {
      if (this.timeLeft <= 0) return end(false, (this.matchup ? 'Red wins — ' : '') + 'out of time, the building was not cleared.');
    } else {
      const redOn = red.some((u) => dist(u, obj) < 4);
      const blueNear = blue.some((u) => dist(u, obj) < 10);
      this.seizeT = redOn && !blueNear ? this.seizeT + dt : 0;
      if (this.seizeT >= CFG.seizeTime) return end(false, this.matchup ? 'Red wins — the objective was seized.' : 'The enemy seized the objective.');
      if (this.timeLeft <= 0) return end(true, (this.matchup ? 'Blue wins — ' : '') + 'held until the clock ran out.');
      void side;
    }
  }

  // ───────────── network snapshot ─────────────
  snapshot(fullTiles) {
    const s = {
      t: r1(this.t), ph: this.phase, pl: r1(this.prepLeft), tl: r1(this.timeLeft),
      u: this.units.map((u) => [u.id, r1(u.x), r1(u.z), r2(u.yaw), Math.ceil(u.hp), (u.alive ? 1 : 0) | (u.crouch ? 2 : 0) | (this.t < u.stunUntil ? 4 : 0) | (u.reloadUntil ? 8 : 0) | (u.channel ? 16 : 0), r1(u.moveAmt), u.ammo, u.mags, u.frags, u.smokes, u.charges, u.claymores, r1(u.suppression), u.channel ? r1(u.channel.t / u.channel.dur) : 0]),
      s: this.smokes.map((k) => [k.id, r1(k.x), r1(k.z), r1(k.r), r1(k.alpha)]),
      c: this.claymores.filter((k) => k.alive).map((k) => [k.id, r1(k.x), r1(k.z), r2(k.yaw), k.team === 'red' ? 1 : 0]),
      p: this.projectiles.map((p) => [p.id, r1(p.x), r1(p.y), r1(p.z), p.kind[0]]),
      b: this.charges.map((c) => [c.id, c.x, c.z]),
      ai: [this.ai.blue.state, this.ai.red.state],
    };
    if (fullTiles) s.tiles = [...this.map.changes].flat();
    return s;
  }

  /** Static roster the clients need once (names/roles/teams). */
  roster() { return this.units.map((u) => [u.id, u.team === 'red' ? 1 : 0, u.role, u.name, u.human || '', u.weapon === 'ar' ? 1 : 0]); }
}

export function blankCtl() { return { mx: 0, mz: 0, ax: null, az: null, sprint: false, crouch: false, fire: 0, hold: false, err: 0 }; }
function r1(v) { return Math.round(v * 10) / 10; }
function r2(v) { return Math.round(v * 100) / 100; }
function num(v, d) { return Number.isFinite(v) ? v : d; }
function clampNum(v) { return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0; }
export function gauss(rand) {
  let u = 0, v = 0;
  while (!u) u = rand();
  while (!v) v = rand();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}
