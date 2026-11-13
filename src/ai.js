// Doctrine-driven AI with perception-only knowledge.
//
// What the AI is given:   its training (doctrine.js), its own squad's positions (radio),
//                         and for an attack, the order "seize the objective at grid X".
// What it is NOT given:   the map layout, where you are, where you will come from.
// It learns the layout by LOOKING (vision rays fill a belief map), and learns about you by
//   - SEEING you (spotting takes time: distance, crouching, moving and firing all matter),
//   - HEARING gunfire / explosions (gives a rough position),
//   - BEING SHOT AT (gives the direction of the shooter).
// Everything it plans (paths, positions, sectors, breach points) uses only that belief map.
import { T, TILE, blocksMove, blocksSight, isLowCover, isBreachable, astar, segPointDist } from './map.js';
import { knows } from './doctrine.js';

const STAIRS_T = T.STAIRS;
import { gauss } from './sim.js';

const UNKNOWN = 255;
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= 2 * Math.PI; while (d < -Math.PI) d += 2 * Math.PI; return d; };
const yawTo = (a, b) => Math.atan2(b.x - a.x, b.z - a.z);
const dist = (a, b) => Math.hypot(a.x - b.x, a.z - b.z);
const OPENING = (t) => t === T.DOOR || t === T.OPEN || t === T.WINDOW || t === T.RUBBLE;

export class TeamAI {
  constructor(sim, team, profile, posture) {
    this.sim = sim;
    this.map = sim.map;
    this.team = team;
    this.P = profile;
    this.posture = posture; // defend | attack | escort
    this.know = new Uint8Array(this.map.rows * this.map.cols).fill(UNKNOWN);
    this.contacts = [];
    this.state = posture === 'defend' ? 'recon' : posture === 'attack' ? 'advance' : 'follow';
    this.stateT = 0;
    this.brainT = 0;
    this.percI = 0;
    this.rand = sim.rand;
    this.bound = 0; this.boundT = 0;
    this.breach = null;
    this.glReady = 0;
    const m = this.members;
    this.anchor = m.length ? { x: m.reduce((s, u) => s + u.x, 0) / m.length, z: m.reduce((s, u) => s + u.z, 0) / m.length } : { x: 0, z: 0 };
    for (const u of m) this.initUnit(u);
  }

  initUnit(u) {
    u.ai = { spot: {}, react: 0, target: null, path: null, pathT: 0, task: null, burst: 0, burstGap: 0, scan: this.rand() * 6, stuck: 0, last: { x: u.x, z: u.z } };
  }

  get members() { return this.sim.units.filter((u) => u.alive && u.team === this.team && !u.human); }
  get enemies() { return this.sim.units.filter((u) => u.alive && u.team !== this.team); }

  // ───────────────────────── belief map ─────────────────────────
  tileOf(c, r) {
    if (!this.map.inb(c, r)) return T.WALL;
    const k = this.know[this.map.idx(c, r)];
    return k === UNKNOWN ? T.FLOOR : k;
  }
  knownAt(x, z) { const t = this.map.toTile(x, z); return this.map.inb(t.c, t.r) && this.know[this.map.idx(t.c, t.r)] !== UNKNOWN; }
  beliefLos(ax, az, bx, bz) { return !this.map.walk(ax, az, bx, bz, (c, r) => blocksSight(this.tileOf(c, r))); }

  /** Look: fill the belief map along vision rays (true tiles, but only those actually seen). */
  look(u) {
    const m = this.map;
    const see = (a, range) => {
      const ex = u.x + Math.sin(a) * range, ez = u.z + Math.cos(a) * range;
      m.walk(u.x, u.z, ex, ez, (c, r, t) => {
        if (!m.inb(c, r)) return true;
        this.know[m.idx(c, r)] = t;
        if (blocksSight(t)) return true;
        const ctr = m.center(c, r);
        return this.sim.smokes.some((s) => s.r > 1 && Math.hypot(s.x - ctr.x, s.z - ctr.z) < s.r * 0.8);
      });
    };
    for (let i = 0; i <= 26; i++) see(u.yaw - 1.25 + (2.5 * i) / 26, 45);
    for (let i = 0; i < 10; i++) see((i / 10) * Math.PI * 2, 5);
  }

  /** Spot enemies: needs line of sight inside the field of view, and takes time. */
  spotCheck(u, dt) {
    const ai = u.ai;
    for (const e of this.enemies) {
      const d = dist(u, e);
      let vis = false;
      if (d < 60) {
        const inFov = d < 3 || Math.abs(angDiff(yawTo(u, e), u.yaw)) < 1.3;
        vis = inFov && this.sim.map.los(u.x, u.z, e.x, e.z, this.sim.smokes);
      }
      let acc = ai.spot[e.id] || 0;
      if (vis) {
        let rate = this.P.spot * Math.max(0.25, 1.5 - d / 45);
        if (e.crouch) rate *= 0.6;
        if (e.moveAmt > 0.3) rate *= 1.4;
        if (this.sim.t - e.lastFired < 1.5) rate *= 2.5;
        if (u.suppression > 0.6) rate *= 0.5;
        if (this.sim.t < u.stunUntil) rate *= 0.2;
        acc = Math.min(1.5, acc + rate * dt);
        if (acc >= 0.5) this.report(e.x, e.z, e.id, true);
      } else acc = Math.max(0, acc - dt * 0.5);
      ai.spot[e.id] = acc;
    }
  }

  /** Is enemy e currently seen by this unit (spotted and in line of sight)? */
  sees(u, e) {
    return (u.ai.spot[e.id] || 0) >= 0.5 && dist(u, e) < 60 && this.map.los(u.x, u.z, e.x, e.z, this.sim.smokes);
  }

  report(x, z, id, seen) {
    const now = this.sim.t;
    let c = (id != null && this.contacts.find((k) => k.id === id)) || this.contacts.find((k) => Math.hypot(k.x - x, k.z - z) < 5);
    if (!c) { c = { x, z, id, t: now, seen, first: now }; this.contacts.push(c); }
    if (seen || !c.seen || now - c.t > 2) { c.x = x; c.z = z; }
    c.t = now; c.seen = seen || (c.seen && now - c.t < 2);
    if (id != null) c.id = id;
  }

  /** Sound: a rough position, worse with distance. */
  hear(x, z, range, src) {
    if (!src || src.team === this.team) return;
    const r = Math.min(range, this.P.hearing);
    const listener = this.members.find((u) => dist(u, { x, z }) < r);
    if (!listener) return;
    const d = dist(listener, { x, z });
    this.report(x + gauss(this.rand) * d * 0.12, z + gauss(this.rand) * d * 0.12, null, false);
  }

  /** Incoming fire / being hit / a grenade landing nearby. */
  perceive(u, kind, data) {
    if (!u.ai) return;
    if (kind === 'grenade') { u.ai.evade = { x: data.x, z: data.z, until: this.sim.t + 2.6 }; return; }
    const f = data.from;
    const d = dist(u, f);
    const a = yawTo(u, f) + gauss(this.rand) * 0.12;
    const dd = d * (0.85 + this.rand() * 0.3);
    this.report(u.x + Math.sin(a) * dd, u.z + Math.cos(a) * dd, null, false);
    u.ai.underFire = this.sim.t;
    u.ai.threat = { x: f.x, z: f.z };
  }

  recentContacts(age = 8) { return this.contacts.filter((c) => this.sim.t - c.t < age); }

  // ───────────────────────── main ─────────────────────────
  update(dt) {
    const mem = this.members;
    if (!mem.length) return;
    // perception (staggered)
    for (let k = 0; k < Math.min(mem.length, 4); k++) {
      const u = mem[(this.percI++) % mem.length];
      this.look(u);
    }
    for (const u of mem) this.spotCheck(u, dt);
    this.contacts = this.contacts.filter((c) => this.sim.t - c.t < 45);
    // brain
    this.brainT -= dt;
    this.stateT += dt;
    if (this.brainT <= 0) {
      this.brainT = 0.4;
      if (this.posture === 'defend') this.thinkDefend(mem);
      else if (this.posture === 'attack') this.thinkAttack(mem);
      else this.thinkEscort(mem);
      this.casualtyCare(mem);
    }
    for (const u of mem) this.act(u, dt);
  }

  // ───────────────────────── DEFEND (ATP 3-21.8 ch.6, FM 5-102) ─────────────────────────
  thinkDefend(mem) {
    const sim = this.sim;
    const contact = this.recentContacts(6);
    if (this.state === 'recon') {
      // page 'defend': reconnoiter the position before occupying it
      const reconTime = Math.max(6, (sim.opts.mission === 'breach' ? 20 : 12) * 0.55);
      for (const u of mem) {
        if (!u.ai.task || u.ai.task.type !== 'move' || this.sim.t > u.ai.task.until) {
          const f = this.frontier(u, this.anchor, 16, false);
          u.ai.task = f ? { type: 'move', to: f, until: this.sim.t + 3, look: 'path' } : { type: 'hold', at: { x: u.x, z: u.z }, look: 'scan' };
        }
      }
      if (this.stateT > reconTime || contact.length) { this.state = 'occupy'; this.stateT = 0; this.planDefense(mem); }
      return;
    }
    if (this.state === 'occupy' || this.state === 'hold') {
      if (this.state === 'occupy' && mem.every((u) => !u.ai.task || u.ai.task.type !== 'move')) this.state = 'hold';
      for (const u of mem) {
        const ai = u.ai;
        // page 'alternate': displace when pinned at a position
        if (knows(this.P, 'alternate') && ai.alt && ai.task?.type === 'hold' && u.suppression > 0.75 && this.sim.t - (ai.lastDisplace || 0) > 8) {
          ai.lastDisplace = this.sim.t;
          [ai.pos, ai.alt] = [ai.alt, ai.pos];
          ai.task = { type: 'move', to: ai.pos.p, then: { type: 'hold', at: ai.pos.p, look: 'sector' }, sprint: true };
        }
      }
      // drill 'counterattack': an enemy foothold inside the position → a team throws him out
      // drill 'search': a heard-but-unseen contact nearby → the nearest pair re-establishes contact
      const blind = contact.filter((c) => !c.seen && dist(c, this.anchor) < 22);
      if (blind.length && (knows(this.P, 'search') || knows(this.P, 'counterattack'))) {
        const c = blind[0];
        const foothold = dist(c, this.anchor) < 12 && knows(this.P, 'counterattack') && mem.length >= 4;
        const n = foothold ? Math.min(4, mem.length - 2) : mem.length >= 6 ? 2 : 1;
        const free = mem.filter((u) => !u.ai.target && u.ai.task?.type !== 'clear' && !u.ai.wounded).sort((a, b) => dist(a, c) - dist(b, c)).slice(0, n);
        if (foothold && free.length) this.counterT = this.sim.t;
        for (const u of free) {
          if (dist(u, c) < 18 && this.sim.t - c.t < 4) u.ai.task = { type: 'clear', to: { x: c.x, z: c.z }, until: this.sim.t + 10 };
        }
      }
      for (const u of mem) {
        if (u.ai.task?.type === 'clear' && this.sim.t > u.ai.task.until && u.ai.pos) u.ai.task = { type: 'move', to: u.ai.pos.p, then: { type: 'hold', at: u.ai.pos.p, look: 'sector' } };
      }
    }
  }

  /** Choose fighting positions and sectors from what the squad has seen (page 'defend'). */
  planDefense(mem) {
    const m = this.map;
    // entry points the squad knows about
    const portals = [];
    const cands = [];
    for (let r = 0; r < m.rows; r++) for (let c = 0; c < m.cols; c++) {
      const k = this.know[m.idx(c, r)];
      if (k === UNKNOWN) continue;
      const p = m.center(c, r);
      if (dist(p, this.anchor) > 22) continue;
      if (OPENING(k) || (k === STAIRS_T && knows(this.P, 'stairs'))) portals.push({ ...p, c, r, t: k, cover: [] });
      else if (!blocksMove(k) && k !== T.WIRE && dist(p, this.anchor) < 16) cands.push({ ...p, c, r });
    }
    const doors = portals.filter((p) => p.t !== T.WINDOW);
    const chosen = [];
    const order = mem.slice().sort((a, b) => (a.role === 'AR' ? -1 : 0) - (b.role === 'AR' ? -1 : 0));
    for (const u of order) {
      let best = null, bs = -Infinity, alt = null, as = -Infinity;
      for (const cd of cands) {
        if (doors.some((d) => dist(d, cd) < 2.6)) continue; // never set up in the fatal funnel
        if (chosen.some((o) => dist(o.p, cd) < 3.2)) continue;
        let s = 0, primary = null, pw = 0;
        for (const p of portals) {
          const d = dist(p, cd);
          if (d < 3 || d > 26 || !this.beliefLos(cd.x, cd.z, p.x, p.z)) continue;
          let w = p.cover.length === 0 ? 3 : p.cover.length === 1 ? 1.5 : 0.3;
          if (p.t === T.WINDOW) w *= 0.6;
          // interlocking: cross an existing coverer's line at 45–90°
          for (const other of p.cover) {
            const a1 = yawTo(cd, p), a2 = yawTo(other, p);
            let x = Math.abs(angDiff(a1, a2)) * 180 / Math.PI; x = Math.min(x, 180 - x);
            if (x >= 45 && x <= 90) w += 2;
          }
          if (u.role === 'AR' && p.t !== T.WINDOW) w *= 1.4;
          s += w;
          if (w > pw) { pw = w; primary = p; }
        }
        if (!primary) continue;
        const backFromWindows = knows(this.P, 'windows');
        for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
          const t = this.tileOf(cd.c + dc, cd.r + dr);
          // drill 'windows': don't stand in the window — fight from back inside the room
          if (t === T.WINDOW) s += backFromWindows ? -2.5 : 1.2;
          else if (isLowCover(t)) s += 1.2; else if (t === T.WALL) s += 0.4;
        }
        if (this.tileOf(cd.c, cd.r) === T.PLATFORM && knows(this.P, 'windows')) s += 1.5; // upper level / elevated firing position
        s -= dist(u, cd) * 0.04;
        if (s > bs) { alt = best; as = bs; bs = s; best = { p: cd, primary }; } else if (s > as) { alt = { p: cd, primary }; as = s; }
      }
      if (!best) { best = { p: { x: u.x, z: u.z }, primary: portals[0] || this.anchor }; }
      chosen.push(best);
      if (best.primary && best.primary.cover) best.primary.cover.push(best.p);
      u.ai.pos = best;
      u.ai.alt = alt && dist(alt.p, best.p) > 2.5 ? alt : null;
      u.ai.sector = yawTo(best.p, best.primary);
      u.ai.task = { type: 'move', to: best.p, then: { type: 'hold', at: best.p, look: 'sector' } };
    }
    // page 'obstacles': claymores just inside covered doors, facing out, under a gun
    if (knows(this.P, 'obstacles')) {
      const layers = mem.filter((u) => u.claymores > 0);
      const covered = doors.filter((d) => d.cover.length);
      covered.forEach((d, i) => {
        const u = layers[i % Math.max(1, layers.length)];
        if (!u || u.claymores <= 0) return;
        const g = d.cover[0];
        const a = yawTo(d, g);
        const spot = { x: d.x + Math.sin(a) * 2.6, z: d.z + Math.cos(a) * 2.6 };
        if (!m.canOccupy(spot.x, spot.z, 0.3, 0) || !this.knownAt(spot.x, spot.z)) return;
        const back = u.ai.task;
        u.ai.task = { type: 'move', to: spot, then: { type: 'claymore', face: { x: d.x, z: d.z }, then: back } };
      });
    }
  }

  // ───────────────────────── ATTACK (ATP 3-21.8, FM 3-34.2, ATTP 3-06.11) ─────────────────────────
  thinkAttack(mem) {
    const sim = this.sim;
    if (sim.phase === 'prep') { for (const u of mem) u.ai.task = { type: 'hold', at: { x: u.x, z: u.z }, look: 'obj' }; return; }
    const obj = sim.map.objective; // the order: seize the objective at this grid
    const contact = this.recentContacts(6);
    const teams = groupBy(mem, (u) => (u.role === 'SL' ? 0 : u.fireTeam));
    const teamIds = [...teams.keys()];

    // page 'contact' → 'firemove': base of fire + maneuver
    if (contact.length && (this.state === 'advance' || this.state === 'contact') && knows(this.P, 'contact')) {
      if (this.state !== 'contact') { this.state = 'contact'; this.stateT = 0; this.flankTeam = null; }
      const c = contact.sort((a, b) => b.t - a.t)[0];
      const near = (tm) => Math.min(...teams.get(tm).map((u) => dist(u, c)));
      const base = teamIds.slice().sort((a, b) => near(a) - near(b))[0];
      const canFlank = knows(this.P, 'firemove') && teamIds.length >= 2;
      if (canFlank && this.flankTeam == null) {
        this.flankTeam = teamIds.find((t) => t !== base);
        this.flankPt = this.flankPoint(c, teams.get(this.flankTeam));
        // drill 'danger': screen the open ground the flank team must cross
        const ft = teams.get(this.flankTeam) || [];
        const sm = ft.find((x) => x.smokes > 0);
        if (sm && knows(this.P, 'danger') && this.flankPt) sm.ctl.smoke = { x: sm.x + (c.x - sm.x) * 0.4, z: sm.z + (c.z - sm.z) * 0.4 };
      }
      for (const [tm, us] of teams) {
        for (const u of us) {
          if (tm === this.flankTeam && this.flankPt) {
            const arrived = us.some((x) => dist(x, this.flankPt) < 3) || this.stateT > 25;
            u.ai.task = arrived ? { type: 'move', to: { x: c.x, z: c.z }, look: 'contact', assault: true }
              : { type: 'move', to: this.flankPt, look: 'contact', exposure: c, sprint: true };
          } else {
            u.ai.task = { type: 'cover', threat: { x: c.x, z: c.z }, suppress: u.role === 'AR' || (knows(this.P, 'suppress') && u.role !== 'GR') };
          }
        }
      }
      // grenadier: 40mm on a position rifles can't see
      for (const u of mem) {
        if (u.role === 'GR' && u.gl > 0 && this.sim.t > this.glReady && !c.seen && dist(u, c) > 15 && dist(u, c) < 140) {
          u.ctl.gl = { x: c.x + gauss(this.rand) * 2, z: c.z + gauss(this.rand) * 2 };
          this.glReady = this.sim.t + 5;
        }
      }
      if (this.stateT > 30 || (!contact.some((k) => this.sim.t - k.t < 3) && this.stateT > 6)) { this.state = 'advance'; this.flankTeam = null; }
      return;
    }
    if (this.state === 'contact' && !contact.length) this.state = 'advance';

    // page 'break': too many losses → pull back
    const lost = this.sim.units.filter((u) => u.team === this.team && !u.alive).length;
    if (knows(this.P, 'break') && lost > this.sim.units.filter((u) => u.team === this.team).length * 0.7 && this.state !== 'break') {
      this.state = 'break';
    }
    if (this.state === 'break') {
      for (const u of mem) {
        if (u.smokes > 0 && contact[0] && !u.ai.smoked) { u.ai.smoked = true; u.ctl.smoke = { x: (u.x + contact[0].x) / 2, z: (u.z + contact[0].z) / 2 }; }
        u.ai.task = { type: 'move', to: this.map.spawn, look: 'contact', sprint: true };
      }
      return;
    }

    if (this.state === 'advance') {
      // where does our route to the objective stop being open ground?
      const lead = mem.find((u) => u.role === 'SL') || mem[0];
      if (dist(lead, obj) < 4) { this.state = 'consolidate'; return; }
      if (!this.breach || this.sim.t > (this.breach.planned || 0) + 6) this.breach = this.sim.t < (this.noBreachUntil || 0) ? null : this.planBreach(lead, obj, mem);
      const b = this.breach;
      const near = b && dist(lead, b.stack) < (knows(this.P, 'movement') ? 22 : 6);
      if (b && near) { this.state = 'breach'; this.stateT = 0; b.step = 'setup'; return; }
      // movement: wedge per team, bounding overwatch when close (page 'movement')
      const goal = b ? b.stack : obj;
      const bounding = knows(this.P, 'movement') && teamIds.length >= 2 && dist(lead, goal) < 45;
      if (bounding) {
        this.boundT -= 0.4;
        if (this.boundT <= 0) { this.bound = (this.bound + 1) % teamIds.length; this.boundT = 6; }
      }
      teamIds.forEach((tm, i) => {
        const us = teams.get(tm);
        const tl = us.find((u) => u.role === 'TL' || u.role === 'SL') || us[0];
        us.forEach((u, k) => {
          if (bounding && i !== this.bound) {
            const rear = knows(this.P, 'security') && k === us.length - 1 && us.length > 2;
            u.ai.task = rear ? { type: 'hold', at: { x: u.x, z: u.z }, look: 'yaw', yaw: tl.yaw + Math.PI, crouch: true } : { type: 'hold', at: { x: u.x, z: u.z }, look: 'obj', crouch: true };
            return;
          }
          if (u === tl) u.ai.task = { type: 'move', to: goal, look: 'path', sprint: !bounding && dist(u, goal) > 20 };
          else {
            const side = k % 2 ? 1 : -1, back = 3 + Math.ceil(k / 2) * 3;
            const a = tl.yaw + Math.PI;
            const p = { x: tl.x + Math.sin(a) * back + Math.cos(a) * side * back * 0.8, z: tl.z + Math.cos(a) * back - Math.sin(a) * side * back * 0.8 };
            u.ai.task = { type: 'move', to: p, look: 'path', loose: true };
          }
        });
      });
      return;
    }

    if (this.state === 'breach') return this.runBreach(mem, teams);

    if (this.state === 'clear' || this.state === 'consolidate') {
      // page 'cqb': move as a file through the building toward the objective, clearing as we go
      const lead = mem.find((u) => u.ai.isPoint) || mem[0];
      lead.ai.isPoint = true;
      if (this.state === 'clear' && dist(lead, obj) < 3.5) this.state = 'consolidate';
      if (this.state === 'consolidate') {
        mem.forEach((u, i) => {
          const a = (i / mem.length) * Math.PI * 2;
          u.ai.task = { type: 'hold', at: { x: obj.x + Math.sin(a) * 2.5, z: obj.z + Math.cos(a) * 2.5 }, look: 'out', crouch: true };
        });
        return;
      }
      // an inner door, wall or barricade in the way → stack and breach it (page 'cqb' / 'sosra')
      if (this.sim.t > (this.clearPlanT || 0)) {
        this.clearPlanT = this.sim.t + 2;
        const b = this.sim.t < (this.noBreachUntil || 0) ? null : this.planBreach(lead, obj, mem, true);
        if (b && dist(lead, b.stack) < 25) { this.breach = b; b.step = 'setup'; this.state = 'breach'; this.stateT = 0; return; }
      }
      lead.ai.task = { type: 'move', to: obj, look: 'path', cqb: true };
      // the lead fire team clears in file; the rest trail well back and keep 360° security (drill 'security')
      const leadTeam = mem.filter((u) => u !== lead && u.fireTeam === lead.fireTeam && u.role !== 'SL').slice(0, 3);
      leadTeam.forEach((u, k) => { u.ai.task = { type: 'follow', who: lead.id, gap: 1.6 * (k + 1), look: 'path', cqb: true }; });
      mem.filter((u) => u !== lead && !leadTeam.includes(u)).forEach((u, k) => {
        u.ai.task = { type: 'follow', who: lead.id, gap: 8 + 2.2 * k, look: k % 3 === 2 ? 'out' : 'path', cqb: true };
      });
    }
  }

  /** Belief-map route to the objective; the first door or wall on it is our breach point. */
  planBreach(lead, obj, mem, insideBuilding) {
    const charges = mem.reduce((s, u) => s + u.charges, 0);
    const path = astar(this.map, lead, obj,
      (c, r) => { const t = this.tileOf(c, r); return !blocksMove(t) || t === T.DOOR || (charges > 0 && isBreachable(t)); },
      (c, r, t) => (this.know[this.map.idx(c, r)] === UNKNOWN ? 1.3 : 1) + (t === T.WIRE ? 3 : 0) + (t === T.DOOR ? 2 : 0) + (t === T.WALL || t === T.IRON ? 14 : 0),
      (c, r) => this.tileOf(c, r), 6000);
    if (!path) return null;
    for (let i = 0; i < path.length; i++) {
      const p = path[i];
      const t = this.tileOf(p.c, p.r);
      if (t === T.DOOR || t === T.WALL || t === T.IRON || t === T.WIRE) {
        const prev = path[Math.max(0, i - 1)];
        if (i === 0) return null;
        return { tile: p, kind: t === T.WIRE ? 'wire' : t === T.DOOR && (charges === 0 || insideBuilding) ? 'open' : 'charge', stack: { x: prev.x, z: prev.z }, planned: this.sim.t, inDir: yawTo(prev, p) };
      }
    }
    return null; // open route all the way
  }

  /** page 'sosra': Suppress, Obscure, Secure, Reduce, Assault. */
  runBreach(mem, teams) {
    const b = this.breach;
    const full = knows(this.P, 'sosra');
    const tileNow = this.map.get(b.tile.c, b.tile.r);
    const opened = !(tileNow === T.DOOR || tileNow === T.WALL || tileNow === T.IRON || tileNow === T.WIRE);
    const breachers = mem.filter((u) => u.charges > 0 || b.kind !== 'charge');
    const breacher = b.breacher ? this.sim.unit(b.breacher) : null;
    if (!breacher || !breacher.alive) b.breacher = (breachers.sort((x, y) => dist(x, b.stack) - dist(y, b.stack))[0] || mem[0]).id;
    const br = this.sim.unit(b.breacher);
    const threats = this.recentContacts(20).filter((c) => dist(c, b.tile) < 25);
    const windows = [];
    for (let r = b.tile.r - 6; r <= b.tile.r + 6; r++) for (let c = b.tile.c - 6; c <= b.tile.c + 6; c++) {
      if (this.map.inb(c, r) && this.know[this.map.idx(c, r)] === T.WINDOW) windows.push(this.map.center(c, r));
    }
    const watchPts = threats.length ? threats : windows;
    const teamIds = [...teams.keys()];
    const breachTeam = br ? (br.role === 'SL' ? 0 : br.fireTeam) : teamIds[0];
    if (opened && b.step !== 'assault') { b.step = 'assault'; b.openT = this.sim.t; }
    if (b.step === 'setup' || b.step === 'reduce') {
      // S: support element suppresses what can see the breach
      for (const [tm, us] of teams) {
        if (tm === breachTeam && teamIds.length > 1) continue;
        for (const u of us) {
          if (u === br) continue;
          const tgt = watchPts.length ? watchPts[(u.id) % watchPts.length] : b.tile;
          u.ai.task = full ? { type: 'cover', threat: tgt, suppress: watchPts.length > 0, hold: true } : { type: 'hold', at: { x: u.x, z: u.z }, look: 'obj' };
        }
      }
      const stackers = teams.get(breachTeam) || [];
      // O: smoke between the breach and the threats
      if (full && !b.smoked) {
        const sm = mem.find((u) => u.smokes > 0);
        if (sm && watchPts.length && dist(sm, b.stack) < 30) {
          const w = watchPts[0];
          sm.ctl.smoke = { x: (w.x + b.stack.x) / 2, z: (w.z + b.stack.z) / 2 };
          b.smoked = this.sim.t;
        } else if (!watchPts.length) b.smoked = -1;
      }
      // S: one man secures the flank; others stack beside the entry, off the line of the door
      const perp = b.inDir + Math.PI / 2;
      stackers.filter((u) => u !== br).forEach((u, k) => {
        if (full && k === stackers.length - 2 && stackers.length >= 3) {
          u.ai.task = { type: 'hold', at: { x: b.stack.x - Math.sin(b.inDir) * 4, z: b.stack.z - Math.cos(b.inDir) * 4 }, look: 'yaw', yaw: perp + Math.PI, crouch: true };
        } else {
          const off = 1.4 + k * 1.1;
          u.ai.task = { type: 'hold', at: { x: b.stack.x + Math.sin(perp) * off - Math.sin(b.inDir) * 0.6, z: b.stack.z + Math.cos(perp) * off - Math.cos(b.inDir) * 0.6 }, look: 'yaw', yaw: b.inDir };
        }
      });
      // R: reduce once suppression and smoke are in place (or straight away without the training)
      const ready = !full || ((b.smoked || !watchPts.length) && this.stateT > 3);
      if (br) {
        if (!ready) br.ai.task = { type: 'hold', at: { x: b.stack.x + Math.sin(perp) * 1.2, z: b.stack.z + Math.cos(perp) * 1.2 }, look: 'yaw', yaw: b.inDir, crouch: true };
        else { b.step = 'reduce'; br.ai.task = { type: 'reduce', at: b.stack, tile: b.tile, kind: b.kind }; }
      }
      if (this.stateT > 45) { this.state = 'advance'; this.breach = null; this.noBreachUntil = this.sim.t + 20; }
      return;
    }
    // A: assault through the breach immediately (inside the stun window)
    const dt = this.sim.t - b.openT;
    const entry = { x: b.tile.x, z: b.tile.z };
    const fragger = mem.find((u) => u.frags > 0 && dist(u, entry) < 6);
    if (knows(this.P, 'cqb') && fragger && !b.fragged && b.kind !== 'wire') {
      b.fragged = true;
      fragger.ctl.frag = { x: entry.x + Math.sin(b.inDir) * 4, z: entry.z + Math.cos(b.inDir) * 4 };
      b.goAt = this.sim.t + 2.6;
    }
    if (this.sim.t < (b.goAt || 0)) return;
    const entrants = (teams.get(breachTeam) || mem).slice(0, 4);
    const perpA = b.inDir + Math.PI / 2;
    entrants.forEach((u, k) => {
      // points of domination: alternate left and right along the inside wall
      const side = k % 2 ? 1 : -1, depth = 2.5 + Math.floor(k / 2) * 1.5;
      const p = { x: entry.x + Math.sin(b.inDir) * depth + Math.sin(perpA) * side * 2.2, z: entry.z + Math.cos(b.inDir) * depth + Math.cos(perpA) * side * 2.2 };
      u.ai.task = { type: 'move', to: p, look: 'yaw', yaw: b.inDir + side * 0.8, sprint: true, cqb: true };
    });
    if (dt > 6 || entrants.every((u) => dist(u, entry) > 2 && this.map.interior && dist(u, b.stack) > 3)) {
      if (dt > 3) { this.state = 'clear'; this.breach = null; }
    }
  }

  flankPoint(c, team) {
    const cx = team.reduce((s, u) => s + u.x, 0) / team.length, cz = team.reduce((s, u) => s + u.z, 0) / team.length;
    const a = yawTo({ x: cx, z: cz }, c);
    let best = null, bs = -Infinity;
    for (const side of [-1, 1]) {
      const p = { x: c.x + Math.sin(a + side * 1.4) * 14, z: c.z + Math.cos(a + side * 1.4) * 14 };
      p.x = Math.max(2, Math.min(this.map.w - 2, p.x)); p.z = Math.max(2, Math.min(this.map.h - 2, p.z));
      const t = this.map.toTile(p.x, p.z);
      let s = -dist(p, { x: cx, z: cz }) * 0.1;
      if (blocksMove(this.tileOf(t.c, t.r))) s -= 20;
      if (!this.beliefLos(p.x, p.z, c.x, c.z)) s -= 3;
      if (s > bs) { bs = s; best = p; }
    }
    return best;
  }

  // ───────────────────────── ESCORT (AI teammates of the players) ─────────────────────────
  thinkEscort(mem) {
    const humans = this.sim.units.filter((u) => u.team === this.team && u.human && u.alive);
    const lead = humans[0];
    mem.forEach((u, k) => {
      const c = this.recentContacts(4)[0];
      if (u.ai.underFire && this.sim.t - u.ai.underFire < 3 && c) { u.ai.task = { type: 'cover', threat: c, suppress: false }; return; }
      if (!lead) { u.ai.task = { type: 'hold', at: { x: u.x, z: u.z }, look: 'scan' }; return; }
      u.ai.task = { type: 'follow', who: lead.id, gap: 2.4 * (k + 1), look: 'path' };
    });
  }

  // ───────────────────────── per-unit execution ─────────────────────────
  act(u, dt) {
    const ai = u.ai;
    const c = u.ctl;
    c.fire = 0; c.hold = false; c.err = 0; c.sprint = false;
    let moveTo = null, look = null, crouch = false, sprint = false;
    const task = ai.task || { type: 'hold', at: { x: u.x, z: u.z }, look: 'scan' };

    // 1. grenade at my feet → get away
    if (ai.evade && this.sim.t < ai.evade.until) {
      const a = yawTo(ai.evade, u);
      moveTo = { x: u.x + Math.sin(a) * 6, z: u.z + Math.cos(a) * 6 };
      sprint = true;
    }

    // 2. tasks
    if (!moveTo) {
      switch (task.type) {
        case 'move': case 'clear': {
          moveTo = task.to; sprint = !!task.sprint;
          if (dist(u, task.to) < (task.loose ? 1.5 : 0.6)) {
            moveTo = null;
            if (task.then) ai.task = task.then;
          }
          if (task.type === 'clear') { sprint = false; const ct = this.recentContacts(5)[0]; if (ct) look = ct; if (u.frags > 0 && knows(this.P, 'cqb') && ct && !ct.seen && dist(u, ct) < 16 && dist(u, ct) > 5 && this.sim.t - (ai.lastFrag || 0) > 8) { ai.lastFrag = this.sim.t; c.frag = { x: ct.x, z: ct.z }; } }
          break;
        }
        case 'hold': moveTo = dist(u, task.at) > 0.6 ? task.at : null; crouch = !!task.crouch || (!moveTo && this.nearCover(u)); break;
        case 'follow': {
          const w = this.sim.unit(task.who);
          if (w && w.alive && dist(u, w) > task.gap) moveTo = w;
          sprint = w && dist(u, w) > task.gap + 4;
          break;
        }
        case 'cover': {
          // page 'contact': get to cover from the threat, then fight from it
          if (!ai.coverPt || this.sim.t - ai.coverT > 4) { ai.coverPt = this.coverFrom(u, task.threat) || { x: u.x, z: u.z }; ai.coverT = this.sim.t; }
          moveTo = dist(u, ai.coverPt) > 0.6 ? ai.coverPt : null;
          sprint = !!moveTo;
          crouch = !moveTo;
          look = task.threat;
          break;
        }
        case 'reduce': {
          if (dist(u, task.at) > 0.45) { moveTo = task.at; break; }
          look = task.tile;
          const tnow = this.map.get(task.tile.c, task.tile.r);
          const pending = this.sim.charges.some((k) => k.c === task.tile.c && k.r === task.tile.r);
          if (!u.channel && !pending) {
            if (task.kind === 'open' && tnow === T.DOOR) c.use = 1;
            else if (task.kind === 'wire' && tnow === T.WIRE) c.use = 1;
            else if (task.kind === 'charge' && u.charges > 0 && isBreachable(tnow)) c.charge = 1;
            else if (task.kind === 'charge' && u.charges <= 0 && tnow === T.DOOR) c.use = 1;
          }
          if (pending) { const a = yawTo(task.tile, u); moveTo = { x: task.at.x + Math.sin(a + 1.2) * 2.5, z: task.at.z + Math.cos(a + 1.2) * 2.5 }; }
          break;
        }
        case 'claymore': {
          look = task.face;
          if (Math.abs(angDiff(u.yaw, yawTo(u, task.face))) < 0.2) { c.clay = 1; ai.task = task.then; }
          break;
        }
        default: break;
      }
    }

    // 3. combat: engage what I see (page 'discipline')
    // drill 'targets': whoever is shooting at me first, then automatic weapons and leaders, then the nearest
    const prio = knows(this.P, 'targets');
    const score = (e) => dist(u, e) - (prio ? ((this.sim.t - e.lastFired < 2 && Math.abs(angDiff(e.yaw, yawTo(e, u))) < 0.35) ? 15 : 0) + (e.weapon === 'ar' ? 5 : 0) + (e.role === 'SL' || e.role === 'TL' ? 2 : 0) : 0);
    const vis = this.enemies.filter((e) => this.sees(u, e)).sort((a, b) => score(a) - score(b));
    const tgt = vis[0] || null;
    if (tgt) {
      if (ai.target !== tgt.id) { ai.target = tgt.id; ai.react = this.P.reaction * (0.8 + this.rand() * 0.5) + (u.suppression > 0.5 ? 0.4 : 0); }
      ai.react -= dt;
      look = tgt;
      if (task.type === 'move' && !task.assault && !task.cqb && this.posture !== 'escort') moveTo = null; // stop and fight
      // drill 'ambush': a concealed defender holds fire until the enemy is in the engagement area,
      // the position is compromised, or someone else has initiated
      const hold = this.posture === 'defend' && knows(this.P, 'ambush') && !this.initiated &&
        dist(u, tgt) > 22 && this.sim.t - (ai.underFire || -99) > 3 && this.sim.t - tgt.lastFired > 3;
      if (ai.react <= 0 && !hold && this.clearShot(u, tgt)) { this.fire(u, tgt, false, dt); this.initiated = true; }
    } else {
      ai.target = null;
      if (task.type === 'cover' && task.suppress && !moveTo && this.sim.t > (ai.supNext || 0)) {
        look = task.threat;
        this.fire(u, task.threat, true, dt);
      }
    }
    if (!tgt && u.ammo < u.mag * 0.35 && u.mags > 0 && !u.reloadUntil) c.reload = 1;

    // 4. look direction when not shooting
    if (!look) {
      const mode = task.look;
      if (mode === 'sector' && ai.sector != null) { ai.scan += dt * 0.6; const a = ai.sector + Math.sin(ai.scan) * 0.45; look = { x: u.x + Math.sin(a) * 5, z: u.z + Math.cos(a) * 5 }; }
      else if (mode === 'yaw') look = { x: u.x + Math.sin(task.yaw) * 5, z: u.z + Math.cos(task.yaw) * 5 };
      else if (mode === 'obj') look = this.sim.map.objective;
      else if (mode === 'contact' && this.recentContacts(10)[0]) look = this.recentContacts(10)[0];
      else if (mode === 'out') { const a = yawTo(this.sim.map.objective, u); look = { x: u.x + Math.sin(a) * 5, z: u.z + Math.cos(a) * 5 }; }
      else if (mode === 'scan') { ai.scan += dt * 0.8; look = { x: u.x + Math.sin(ai.scan) * 5, z: u.z + Math.cos(ai.scan) * 5 }; }
      const recent = this.recentContacts(4).find((k) => dist(k, u) < 35);
      if (recent && mode !== 'yaw' && !moveTo) look = recent; // watch where the enemy was last heard/seen
    }

    // 5. movement along a belief-map path
    if (moveTo) this.steer(u, moveTo, task, dt);
    else { c.mx = 0; c.mz = 0; ai.path = null; }
    c.sprint = sprint && !tgt;
    c.crouch = crouch && !moveTo;
    if (look) {
      // turn rate: trained men snap onto targets
      const want = yawTo(u, look);
      const maxTurn = (3 + this.P.spot * 3) * dt;
      const d = angDiff(want, u.yaw);
      const ny = u.yaw + Math.max(-maxTurn, Math.min(maxTurn, d));
      c.ax = u.x + Math.sin(ny) * 5; c.az = u.z + Math.cos(ny) * 5;
      if (tgt && Math.abs(d) < 0.08) { c.ax = tgt.x; c.az = tgt.z; }
    } else if (moveTo) { c.ax = moveTo.x; c.az = moveTo.z; }
  }

  /** drill 'casualty': the wounded get to cover; the nearest buddy covers them. */
  casualtyCare(mem) {
    if (!knows(this.P, 'casualty')) return;
    const threat = this.recentContacts(10)[0];
    this.buddies = (this.buddies || []).filter((k) => this.sim.t < k.until && k.buddy.alive);
    for (const u of mem) {
      if (u.hp >= 45 || !threat) continue;
      if (!u.ai.wounded) {
        u.ai.wounded = true;
        const buddy = mem.filter((b) => b !== u && !b.ai.wounded && dist(b, u) < 12).sort((a, b) => dist(a, u) - dist(b, u))[0];
        if (buddy) this.buddies.push({ buddy, until: this.sim.t + 8, back: buddy.ai.task });
      }
      // the task is re-applied every think, after the team's plan, so the plan can't pull him back out
      u.ai.task = { type: 'cover', threat: { x: threat.x, z: threat.z }, suppress: false };
    }
    for (const k of this.buddies) {
      if (threat) k.buddy.ai.task = { type: 'cover', threat: { x: threat.x, z: threat.z }, suppress: true };
      if (this.sim.t > k.until - 0.5 && this.posture === 'defend') k.buddy.ai.task = k.back;
    }
  }

  besideCover(c, r) {
    for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
      const t = this.tileOf(c + dc, r + dr);
      if (t === T.WALL || isLowCover(t) || t === T.IRON) return true;
    }
    return false;
  }

  /** Aimed fire at a seen enemy, or suppressive bursts into a suspected position. */
  fire(u, at, suppressive, dt) {
    const ai = u.ai, c = u.ctl;
    let err = this.P.aimErr * (1 + u.suppression * 1.5) * (u.moveAmt > 0.3 ? 1.7 : 1) * (this.sim.t < u.stunUntil ? 4 : 1);
    if (suppressive) err = 0.06;
    c.err = gauss(this.rand) * err;
    if (suppressive) { c.ax = at.x + gauss(this.rand) * 1.2; c.az = at.z + gauss(this.rand) * 1.2; }
    if (u.weapon === 'ar') {
      if (ai.burstGap > 0) { ai.burstGap -= dt; return; }
      c.hold = true;
      ai.burst++;
      if (ai.burst > (suppressive ? 9 : 6) * 4) { ai.burst = 0; ai.burstGap = suppressive ? 0.6 : 0.35; }
    } else {
      c.fire = 1;
      if (suppressive) ai.supNext = this.sim.t + 0.6 + this.rand() * 0.5;
    }
  }

  clearShot(u, tgt) {
    for (const f of this.sim.units) {
      if (!f.alive || f === u || f.team !== u.team) continue;
      if (dist(u, f) < dist(u, tgt) && segPointDist(u.x, u.z, tgt.x, tgt.z, f.x, f.z) < 0.9) return false;
    }
    return true;
  }

  nearCover(u) {
    const t = this.map.toTile(u.x, u.z);
    for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (isLowCover(this.tileOf(t.c + dc, t.r + dr))) return true;
    return false;
  }

  /** Nearest known tile within 7 m that the threat can't see, or with low cover toward it. */
  coverFrom(u, threat) {
    const m = this.map;
    const t0 = m.toTile(u.x, u.z);
    let best = null, bs = Infinity;
    for (let r = t0.r - 3; r <= t0.r + 3; r++) for (let c = t0.c - 3; c <= t0.c + 3; c++) {
      const i = m.idx(c, r);
      if (!m.inb(c, r) || this.know[i] === UNKNOWN || blocksMove(this.know[i]) || this.know[i] === T.WIRE) continue;
      const p = m.center(c, r);
      if (this.sim.units.some((o) => o !== u && o.alive && dist(o, p) < 1.2)) continue;
      let s = dist(u, p);
      if (this.beliefLos(p.x, p.z, threat.x, threat.z)) {
        let low = false;
        m.walk(p.x, p.z, threat.x, threat.z, (cc, rr) => { if (Math.hypot(cc - c, rr - r) > 1.6) return true; if (isLowCover(this.tileOf(cc, rr))) { low = true; return true; } return false; });
        s += low ? 2 : 12;
      }
      if (s < bs) { bs = s; best = p; }
    }
    return best;
  }

  /** Nearest frontier: a known walkable tile next to an unknown one, near an anchor. */
  frontier(u, anchor, radius, doorsOk) {
    const m = this.map;
    let best = null, bs = Infinity;
    for (let r = 0; r < m.rows; r++) for (let c = 0; c < m.cols; c++) {
      const i = m.idx(c, r);
      const k = this.know[i];
      if (k === UNKNOWN || blocksMove(k)) continue;
      const p = m.center(c, r);
      if (dist(p, anchor) > radius) continue;
      let unk = false;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) if (m.inb(c + dc, r + dr) && this.know[m.idx(c + dc, r + dr)] === UNKNOWN) unk = true;
      if (!unk) continue;
      if (this.members.some((o) => o !== u && o.ai.task?.to && dist(o.ai.task.to, p) < 4)) continue;
      const s = dist(u, p) + this.rand() * 3;
      if (s < bs) { bs = s; best = p; }
    }
    return best;
  }

  /** Follow a path planned on the belief map; open closed doors we reach; replan when stuck. */
  steer(u, to, task, dt) {
    const ai = u.ai, c = u.ctl;
    if (!ai.path || this.sim.t > ai.pathT || !ai.goal || dist(ai.goal, to) > 1.5) {
      const exp = task.exposure;
      const hug = this.posture === 'attack' && knows(this.P, 'urbanmove');
      const expCache = new Map();
      ai.path = astar(this.map, u, to,
        (cc, rr) => { const t = this.tileOf(cc, rr); return !blocksMove(t) || (t === T.DOOR && this.posture !== 'defend'); },
        (cc, rr, t) => {
          let k = (this.know[this.map.idx(cc, rr)] === UNKNOWN ? 1.3 : 1) + (t === T.WIRE ? 4 : 0) + (t === T.DOOR ? 2 : 0);
          if (hug && !this.besideCover(cc, rr)) k += 0.35; // drill 'urbanmove': move along walls
          if (exp) {
            const key = cc * 1000 + rr;
            if (!expCache.has(key)) { const p = this.map.center(cc, rr); expCache.set(key, dist(p, exp) < 30 && this.beliefLos(p.x, p.z, exp.x, exp.z)); }
            if (expCache.get(key)) k += 5;
          }
          return k;
        },
        (cc, rr) => this.tileOf(cc, rr), 3000) || [to];
      ai.pathI = 0;
      ai.pathT = this.sim.t + 1.2;
      ai.goal = { x: to.x, z: to.z };
    }
    let wp = ai.path[ai.pathI] || to;
    while (ai.pathI < ai.path.length - 1 && dist(u, wp) < 0.5) { ai.pathI++; wp = ai.path[ai.pathI]; }
    if (ai.pathI >= ai.path.length - 1) wp = to;
    // closed door ahead → open it (page 'cqb': then move through without stopping)
    const tw = this.map.toTile(wp.x, wp.z);
    if (this.map.get(tw.c, tw.r) === T.DOOR && dist(u, wp) < 2.2) { c.use = 1; }
    const dx = wp.x - u.x, dz = wp.z - u.z, L = Math.hypot(dx, dz) || 1;
    c.mx = dx / L; c.mz = dz / L;
    // don't linger in a doorway
    const here = this.map.tileAt(u.x, u.z);
    if ((task.cqb && OPENING(here)) || (here === STAIRS_T && knows(this.P, 'stairs'))) c.sprint = true;
    // stuck detection → replan
    if (dist(u, ai.last) < 0.05) { ai.stuck += dt; if (ai.stuck > 1) { ai.pathT = 0; ai.stuck = 0; c.mx += (this.rand() - 0.5); c.mz += (this.rand() - 0.5); } }
    else ai.stuck = 0;
    ai.last = { x: u.x, z: u.z };
  }
}

function groupBy(arr, f) {
  const m = new Map();
  for (const x of arr) { const k = f(x); if (!m.has(k)) m.set(k, []); m.get(k).push(x); }
  return m;
}
