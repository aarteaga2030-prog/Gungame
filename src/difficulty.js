// ─────────────────────────────────────────────────────────────────────────────
// B. DIFFICULTY STATE MACHINE
//
// The DifficultyDirector is a small state machine that is run once when a level is
// loaded.  It walks   BOOT → CONFIGURE_AI → SHAPE_OBSTACLES → PLAN_FIRES → ARMED
// and in each state applies the parameters of the selected tier
// (EASY → MEDIUM → HARD → INSANE) to the simulation.  Every step is logged and
// the log is shown on the briefing screen ("SIM CONFIG").
// ─────────────────────────────────────────────────────────────────────────────
import { T, TILE, rng } from './map.js';

export const TIER_PARAMS = {
  EASY: {
    label: 'Basic Drills',
    reaction: 2.0,          // s between a defender seeing you and pulling the trigger
    accuracy: 0.16,         // base per-round hit probability at ideal range
    fov: 70,                // degrees; narrow = clear blind spots
    turnRate: 90,           // deg/s
    range: 22,
    blindSpotJitter: 25,    // random yaw error on sectors (sloppy sectors)
    crossfire: false,       // no interlocking: every door covered by at most one man
    crossAngle: null,
    minCoverPerPortal: 0,
    funnelLock: false, funnelMult: 1.0,
    hearing: false,
    shiftOnCompromise: false,
    sosraStrict: false,     // SOSRA violations cost a casualty instead of the mission
    obstacleDensity: 0, extraClaymores: 0, mortars: false,
    bunchAnywhere: false, followSpacing: 2.3,
    attackerSmokes: 0, attackerBound: false,
  },
  MEDIUM: {
    label: 'Coordinated Opposition',
    reaction: 1.0, accuracy: 0.24, fov: 100, turnRate: 180, range: 26, blindSpotJitter: 8,
    crossfire: true, crossAngle: [30, 110], minCoverPerPortal: 1,
    funnelLock: true, funnelMult: 1.7,
    hearing: true, shiftOnCompromise: false, sosraStrict: false,
    obstacleDensity: 0, extraClaymores: 0, mortars: false,
    bunchAnywhere: false, followSpacing: 2.3,
    attackerSmokes: 1, attackerBound: true,
  },
  HARD: {
    label: 'Fortified Strongholds',
    reaction: 0.55, accuracy: 0.32, fov: 110, turnRate: 300, range: 30, blindSpotJitter: 0,
    crossfire: true, crossAngle: [45, 90], minCoverPerPortal: 1,
    funnelLock: true, funnelMult: 1.8,
    hearing: true, shiftOnCompromise: true, sosraStrict: true,
    obstacleDensity: 0.08, extraClaymores: 1, mortars: false,
    bunchAnywhere: false, followSpacing: 2.4,
    attackerSmokes: 2, attackerBound: true,
  },
  INSANE: {
    label: 'The Meat Grinder',
    reaction: 0.3, accuracy: 0.42, fov: 120, turnRate: 500, range: 34, blindSpotJitter: 0,
    crossfire: true, crossAngle: [45, 90], minCoverPerPortal: 2, // overlapping: every approach covered twice
    funnelLock: true, funnelMult: 2.0,
    hearing: true, shiftOnCompromise: true, sosraStrict: true,
    obstacleDensity: 0.14, extraClaymores: 2, mortars: true,
    bunchAnywhere: true, followSpacing: 2.6,
    attackerSmokes: 3, attackerBound: true,
  },
};

// Rules that never change with difficulty (hard-coded doctrine constants).
export const RULES = {
  suppressedAccuracy: 0.05,   // suppression pins accuracy to 5 %
  reduceTime: 3.0,            // explosive / mechanical reduction channel
  ironReduceTime: 5.0,
  stunWindow: 1.5,            // overpressure stun after an explosive breach
  chargeFuse: 1.2,
  bunchCount: 3,              // ">2 units"
  bunchTime: 1.5,             // seconds
  chokeRadius: 2.0,
  wireSpeed: 0.2,             // 80 % speed reduction
  smokeRadius: 3.6,
  smokeLife: 15,
};

const ORDER = ['EASY', 'MEDIUM', 'HARD', 'INSANE'];

export class DifficultyDirector {
  constructor(level, map) {
    this.level = level;
    this.map = map;
    this.state = 'BOOT';
    this.log = [];
    this.params = null;
    this.plan = null;
  }

  /** Run the state machine to completion. */
  run() {
    while (this.state !== 'ARMED') this.step();
    return { params: this.params, plan: this.plan, log: this.log };
  }

  step() {
    switch (this.state) {
      case 'BOOT': {
        if (!ORDER.includes(this.level.tier)) throw new Error('Unknown tier ' + this.level.tier);
        this.say(`tier=${this.level.tier} (${TIER_PARAMS[this.level.tier].label})`);
        this.state = 'CONFIGURE_AI';
        break;
      }
      case 'CONFIGURE_AI': {
        // Base tier parameters, then a small ramp inside the tier (later levels of a tier are sharper).
        const base = TIER_PARAMS[this.level.tier];
        const k = this.level.id % 4; // position inside the tier
        this.params = {
          ...base,
          tier: this.level.tier,
          reaction: +(base.reaction * (1 - 0.06 * k)).toFixed(2),
          accuracy: +(base.accuracy * (1 + 0.05 * k)).toFixed(3),
        };
        const p = this.params;
        this.say(`AI reaction ${p.reaction.toFixed(2)}s · accuracy ${(p.accuracy * 100) | 0}% · FOV ${p.fov}° · turn ${p.turnRate}°/s`);
        this.say(`fatal funnel lock ${p.funnelLock ? 'ON x' + p.funnelMult : 'OFF'} · shift-when-compromised ${p.shiftOnCompromise ? 'ON' : 'OFF'} · SOSRA ${p.sosraStrict ? 'STRICT (violation = mission failure)' : 'casualty on violation'}`);
        this.state = 'SHAPE_OBSTACLES';
        break;
      }
      case 'SHAPE_OBSTACLES': {
        const added = this.level.mode === 'breach' ? shapeObstacles(this.map, this.params, this.level.id) : { wire: 0, claymores: 0 };
        this.say(`obstacle density ${(this.params.obstacleDensity * 100) | 0}% → +${added.wire} wire, +${added.claymores} claymores · mortars ${this.params.mortars ? 'ZEROED' : 'none'}`);
        if (!this.params.mortars) this.map.mortar.fill(0);
        this.state = 'PLAN_FIRES';
        break;
      }
      case 'PLAN_FIRES': {
        this.plan = buildFirePlan(this.map, this.params, (s) => this.say(s), this.level.id);
        this.state = 'ARMED';
        this.say('ARMED');
        break;
      }
      default: break;
    }
  }

  say(s) { this.log.push(`[${this.state}] ${s}`); }
}

/** Sprinkle extra wire / claymores in the approach band outside the objective (Hard+). */
function shapeObstacles(map, P, seed) {
  const R = rng(1000 + seed * 77);
  const out = { wire: 0, claymores: 0 };
  if (!P.obstacleDensity && !P.extraClaymores) return out;
  const outside = map.outsideMask();
  const sp = map.toTile(map.spawn.x, map.spawn.z);
  const near = (c, r, d) => {
    for (let rr = r - d; rr <= r + d; rr++) for (let cc = c - d; cc <= c + d; cc++) {
      const t = map.get(cc, rr);
      if (map.inb(cc, rr) && (t === T.WALL || t === T.WINDOW || t === T.DOOR || t === T.BWALL)) return true;
    }
    return false;
  };
  const occupied = new Set(map.defenders.map((d) => map.idx(d.c, d.r)).concat(map.claymores.map((d) => map.idx(d.c, d.r))));
  const cands = [];
  for (let r = 0; r < map.rows; r++) for (let c = 0; c < map.cols; c++) {
    const i = map.idx(c, r);
    if (!outside[i] || map.tiles[i] !== T.FLOOR || occupied.has(i)) continue;
    if (Math.hypot(c - sp.c, r - sp.r) < 5) continue;
    if (near(c, r, 1)) continue;          // keep doorsteps clear
    if (!near(c, r, 4)) continue;         // only the approach band
    if (r > sp.r - 2) continue;           // in front of the player, not behind
    cands.push({ c, r });
  }
  for (const t of cands) {
    if (R() < P.obstacleDensity) { map.tiles[map.idx(t.c, t.r)] = T.WIRE; out.wire++; }
  }
  for (let k = 0; k < P.extraClaymores && cands.length; k++) {
    const t = cands.splice((R() * cands.length) | 0, 1)[0];
    if (map.tiles[map.idx(t.c, t.r)] !== T.FLOOR) { k--; continue; }
    map.claymores.push({ c: t.c, r: t.r, ...map.center(t.c, t.r), auto: true });
    out.claymores++;
  }
  map.orig = new Uint8Array(map.tiles);
  return out;
}

const deg = (a) => (a * 180) / Math.PI;
function angleAt(K, A, B) {
  const ax = A.x - K.x, az = A.z - K.z, bx = B.x - K.x, bz = B.z - K.z;
  const d = (ax * bx + az * bz) / (Math.hypot(ax, az) * Math.hypot(bx, bz) || 1);
  const a = deg(Math.acos(Math.max(-1, Math.min(1, d))));
  return Math.min(a, 180 - a); // crossing angle between the two lines of fire (0–90°)
}
const yawTo = (from, to) => Math.atan2(to.x - from.x, to.z - from.z);

/**
 * Automated defensive fire plan (ATP 3-21.8):
 *  1. window guards face out of their window,
 *  2. machine guns are paired and given principal directions of fire that cross the
 *     friendly avenue of approach at 45–90° (interlocking),
 *  3. riflemen lock down portals (fatal funnels), preferring a second coverer whose
 *     line crosses the first at an interlocking angle.
 */
export function buildFirePlan(map, P, say, seed) {
  const R = rng(seed * 31 + 7);
  const defs = map.defenders.map((d, i) => ({ ...d, id: i, elevated: map.get(d.c, d.r) === T.PLATFORM }));
  const portals = map.portals();
  const windows = map.windows();
  const cover = new Map(); // portal index -> [defender]
  const interlocks = [];
  const eye = (d) => ({ x: d.x, z: d.z });

  // face points: the walkable tiles on each side of a portal
  const faces = portals.map((p) => {
    const f = [];
    for (const [dc, dr] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
      const t = map.get(p.c + dc, p.r + dr);
      if (t === T.FLOOR || t === T.WIRE || t === T.OPEN) f.push(map.center(p.c + dc, p.r + dr));
    }
    return f;
  });

  // Friendly avenue of approach: spawn → nearest portal face that is outside.
  const outside = map.outsideMask();
  let approach = [];
  let best = Infinity;
  portals.forEach((p, i) => faces[i].forEach((f) => {
    const t = map.toTile(f.x, f.z);
    if (!outside[map.idx(t.c, t.r)]) return;
    const d = Math.hypot(f.x - map.spawn.x, f.z - map.spawn.z);
    if (d < best) { best = d; approach = map.path(map.spawn, f, {}) || []; }
  }));
  approach = [map.spawn, ...approach];
  // Engagement-area candidates: the approach corridor (±2 tiles around the avenue).
  const corridor = [];
  const seen = new Set();
  for (const a of approach) {
    const t = map.toTile(a.x, a.z);
    for (let dr = -2; dr <= 2; dr++) for (let dc = -2; dc <= 2; dc++) {
      const c = t.c + dc, r = t.r + dr;
      const i = map.idx(c, r);
      if (!map.inb(c, r) || seen.has(i) || !outside[i] || !map.passable(c, r)) continue;
      seen.add(i);
      corridor.push(map.center(c, r));
    }
  }

  // 1. window guards
  for (const d of defs) {
    const w = windows.find((w) => Math.hypot(w.x - d.x, w.z - d.z) <= TILE * 1.6);
    if (!w) continue;
    const ox = w.x - d.x, oz = w.z - d.z, L = Math.hypot(ox, oz) || 1;
    d.aim = { x: w.x + (ox / L) * 10, z: w.z + (oz / L) * 10 };
    d.windowGuard = w;
    say(`window guard at (${d.c},${d.r}) overlooks window (${w.c},${w.r})`);
  }

  // 2. machine-gun pairs on the approach
  const mgs = defs.filter((d) => d.type === 'mg' && !d.aim);
  const used = new Set();
  if (P.crossfire && P.crossAngle) {
    for (const a of mgs) {
      if (used.has(a)) continue;
      let pair = null, pick = null, pickScore = Infinity;
      for (const b of mgs) {
        if (b === a || used.has(b)) continue;
        for (const K of corridor) {
          if (!map.los(a.x, a.z, K.x, K.z) || !map.los(b.x, b.z, K.x, K.z)) continue;
          const ang = angleAt(K, a, b);
          if (ang < P.crossAngle[0] || ang > P.crossAngle[1]) continue;
          const s = Math.abs(ang - 67.5) + Math.hypot(K.x - a.x, K.z - a.z) * 0.05;
          if (s < pickScore) { pickScore = s; pick = { K, ang }; pair = b; }
        }
      }
      if (pair) {
        a.aim = pick.K; pair.aim = pick.K;
        used.add(a); used.add(pair);
        interlocks.push({ a: a.id, b: pair.id, angle: pick.ang, at: pick.K });
        say(`MG pair (${a.c},${a.r})×(${pair.c},${pair.r}) interlocking at ${pick.ang.toFixed(0)}° over grid (${(pick.K.x / TILE) | 0},${(pick.K.z / TILE) | 0}) ✓`);
      }
    }
  }
  for (const m of mgs) {
    if (m.aim) continue;
    let K = null, bd = Infinity;
    for (const p of approach) {
      if (!map.los(m.x, m.z, p.x, p.z)) continue;
      const d = Math.abs(Math.hypot(p.x - m.x, p.z - m.z) - 14);
      if (d < bd) { bd = d; K = p; }
    }
    m.aim = K || map.spawn;
    say(`MG (${m.c},${m.r}) principal direction of fire on the approach${P.crossfire ? ' (no interlocking partner)' : ''}`);
  }

  // 3. riflemen lock down portals
  for (const d of defs) {
    if (d.aim) continue;
    const opts = [];
    portals.forEach((p, i) => {
      let fp = null, fd = Infinity;
      for (const f of faces[i]) {
        if (!map.los(d.x, d.z, f.x, f.z)) continue;
        const dd = Math.hypot(f.x - d.x, f.z - d.z);
        if (dd < fd && dd < P.range) { fd = dd; fp = f; }
      }
      if (fp) opts.push({ i, p, fp, dist: fd });
    });
    if (!opts.length) {
      d.aim = { x: map.spawn.x, z: map.spawn.z };
      say(`rifleman (${d.c},${d.r}) watches the approach`);
      continue;
    }
    let choice = null, cs = -Infinity;
    for (const o of opts) {
      const list = cover.get(o.i) || [];
      let s = -o.dist * 0.08;
      if (!P.crossfire) s += list.length ? -100 : 0;           // EASY: never double up
      else {
        if (list.length < P.minCoverPerPortal) s += 4;
        for (const other of list) {
          const ang = angleAt(o.p, d, other);
          if (ang >= P.crossAngle[0] && ang <= P.crossAngle[1]) s += 6; else s -= 1.5;
        }
        s -= list.length * 1.2;
      }
      if (s > cs) { cs = s; choice = o; }
    }
    if (!P.crossfire && cs < -50) {
      d.aim = { x: map.spawn.x, z: map.spawn.z };
      continue;
    }
    d.aim = { x: choice.p.x, z: choice.p.z };
    d.portal = choice.i;
    const list = cover.get(choice.i) || [];
    for (const other of list) {
      const ang = angleAt(choice.p, d, other);
      const ok = P.crossAngle && ang >= P.crossAngle[0] && ang <= P.crossAngle[1];
      if (ok) interlocks.push({ a: d.id, b: other.id, angle: ang, at: choice.p });
      say(`portal (${choice.p.c},${choice.p.r}) crossfire ${ang.toFixed(0)}° ${ok ? '✓ interlocking' : '✗ outside band'}`);
    }
    list.push(d);
    cover.set(choice.i, list);
  }

  // Sector yaw + sloppiness (EASY blind spots)
  for (const d of defs) {
    d.sectorYaw = yawTo(d, d.aim) + ((R() * 2 - 1) * P.blindSpotJitter * Math.PI) / 180;
    d.fov = d.type === 'mg' ? Math.max(50, P.fov - 30) : P.fov;
  }
  const covered = [...cover.values()].filter((l) => l.length >= 2).length;
  say(`${defs.length} defenders · ${interlocks.length} interlocking pairs · ${covered} portals under crossfire`);
  return { defs, interlocks, approach };
}

/** Defense-mode helper: interlocking check for the player's own sectors. */
export function sectorInterlocks(units, range = 26) {
  const pairs = [];
  for (let i = 0; i < units.length; i++) for (let j = i + 1; j < units.length; j++) {
    const a = units[i], b = units[j];
    const ax = Math.sin(a.sectorYaw), az = Math.cos(a.sectorYaw);
    const bx = Math.sin(b.sectorYaw), bz = Math.cos(b.sectorYaw);
    const den = ax * bz - az * bx;
    if (Math.abs(den) < 1e-4) continue;
    const dx = b.x - a.x, dz = b.z - a.z;
    const ta = (dx * bz - dz * bx) / den;
    const tb = (dx * az - dz * ax) / den;
    if (ta <= 0 || tb <= 0 || ta > range || tb > range) continue;
    const ang = deg(Math.acos(Math.max(-1, Math.min(1, ax * bx + az * bz))));
    const cross = Math.min(ang, 180 - ang); // angle between the two lines of fire (0–90°)
    if (cross >= 45) pairs.push({ a, b, angle: cross, at: { x: a.x + ax * ta, z: a.z + az * ta } });
  }
  return pairs;
}
