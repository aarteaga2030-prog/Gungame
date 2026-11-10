// Grid map: parsing, tile rules, line-of-sight, heights, collision and A* pathing.
// Pure logic (no rendering) so it can be shared by the sim, the AI and the fire planner.

export const TILE = 2; // metres per tile

export const T = {
  FLOOR: 0, WALL: 1, WINDOW: 2, DOOR: 3, BWALL: 4, IRON: 5, LOW: 6, SANDBAG: 7, CRATE: 8,
  WIRE: 9, PLATFORM: 10, STAIRS: 11, OPEN: 12, RUBBLE: 13,
};

const CHAR = {
  '.': T.FLOOR, '#': T.WALL, W: T.WINDOW, D: T.DOOR, B: T.BWALL, I: T.IRON, '-': T.LOW,
  S: T.SANDBAG, C: T.CRATE, w: T.WIRE, '=': T.PLATFORM, '^': T.STAIRS,
};

export const PLATFORM_H = 1.6;

export function blocksMove(t) {
  return t === T.WALL || t === T.WINDOW || t === T.DOOR || t === T.BWALL || t === T.IRON ||
    t === T.LOW || t === T.SANDBAG || t === T.CRATE;
}
export function blocksSight(t) {
  return t === T.WALL || t === T.DOOR || t === T.BWALL || t === T.IRON;
}
export function isLowCover(t) {
  return t === T.LOW || t === T.SANDBAG || t === T.CRATE || t === T.WINDOW;
}
export function isPortalType(t) {
  return t === T.DOOR || t === T.BWALL || t === T.IRON || t === T.OPEN || t === T.RUBBLE;
}
function levelOf(t) { return t === T.PLATFORM ? 2 : t === T.STAIRS ? 1 : 0; }

export class GameMap {
  constructor(level) {
    const rows = level.map;
    this.rows = rows.length;
    this.cols = Math.max(...rows.map((r) => r.length));
    this.w = this.cols * TILE;
    this.h = this.rows * TILE;
    const n = this.rows * this.cols;
    this.tiles = new Uint8Array(n);
    this.orig = null;
    this.mortar = new Uint8Array(n);
    this.portalFlag = new Uint8Array(n);
    this.stairDir = {};
    this.spawn = null;
    this.squadSpawns = [];
    this.defenders = [];
    this.attackerSpawns = [];
    this.objective = null;
    this.claymores = [];
    this.onChange = null;

    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        const ch = rows[r][c] || '.';
        const i = this.idx(c, r);
        let t = CHAR[ch];
        if (t === undefined) t = T.FLOOR;
        const p = this.center(c, r);
        switch (ch) {
          case 'P': this.spawn = p; break;
          case 'a': this.squadSpawns.push(p); break;
          case 'E': this.defenders.push({ type: 'rifle', c, r, ...p }); break;
          case 'G': this.defenders.push({ type: 'mg', c, r, ...p }); break;
          case 'H': t = T.PLATFORM; this.defenders.push({ type: 'rifle', c, r, ...p }); break;
          case 'J': t = T.PLATFORM; this.defenders.push({ type: 'mg', c, r, ...p }); break;
          case 'R': this.attackerSpawns.push(p); break;
          case 'X': this.objective = p; break;
          case 'c': this.claymores.push({ c, r, ...p }); break;
          case 'm': this.mortar[i] = 1; break;
          default: break;
        }
        this.tiles[i] = t;
        if (t === T.DOOR || t === T.BWALL || t === T.IRON) this.portalFlag[i] = 1;
      }
    }
    // Stair direction: toward the adjacent platform tile.
    for (let r = 0; r < this.rows; r++) {
      for (let c = 0; c < this.cols; c++) {
        if (this.get(c, r) !== T.STAIRS) continue;
        for (const [dc, dr] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) {
          if (this.get(c + dc, r + dr) === T.PLATFORM) { this.stairDir[this.idx(c, r)] = { dx: dc, dz: dr }; break; }
        }
      }
    }
    if (!this.spawn) this.spawn = this.center(1, this.rows - 2);
    this.orig = new Uint8Array(this.tiles);
  }

  idx(c, r) { return r * this.cols + c; }
  inb(c, r) { return c >= 0 && r >= 0 && c < this.cols && r < this.rows; }
  get(c, r) { return this.inb(c, r) ? this.tiles[this.idx(c, r)] : T.WALL; }
  center(c, r) { return { x: c * TILE + TILE / 2, z: r * TILE + TILE / 2 }; }
  toTile(x, z) { return { c: Math.floor(x / TILE), r: Math.floor(z / TILE) }; }
  tileAt(x, z) { return this.get(Math.floor(x / TILE), Math.floor(z / TILE)); }
  isMortar(x, z) {
    const c = Math.floor(x / TILE), r = Math.floor(z / TILE);
    return this.inb(c, r) && this.mortar[this.idx(c, r)] === 1;
  }

  set(c, r, t, variant) {
    if (!this.inb(c, r)) return;
    const i = this.idx(c, r);
    this.tiles[i] = t;
    if (this.onChange) this.onChange(c, r, t, variant);
  }

  /** All portals (doors / breach walls / barricades, intact or open) as world points. */
  portals() {
    const out = [];
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      if (this.portalFlag[this.idx(c, r)]) out.push({ c, r, ...this.center(c, r), type: this.get(c, r) });
    }
    return out;
  }
  windows() {
    const out = [];
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      if (this.get(c, r) === T.WINDOW) out.push({ c, r, ...this.center(c, r) });
    }
    return out;
  }
  /** Choke points for the bunching rule: portals and stairs (ATTP 3-06.11 7-173). */
  chokePoints() {
    if (this._chokes) return this._chokes;
    const out = this.portals();
    for (let r = 0; r < this.rows; r++) for (let c = 0; c < this.cols; c++) {
      if (this.get(c, r) === T.STAIRS) out.push({ c, r, ...this.center(c, r), type: T.STAIRS });
    }
    this._chokes = out;
    return out;
  }

  heightAt(x, z) {
    const c = Math.floor(x / TILE), r = Math.floor(z / TILE);
    const t = this.get(c, r);
    if (t === T.PLATFORM) return PLATFORM_H;
    if (t === T.STAIRS) {
      const d = this.stairDir[this.idx(c, r)];
      if (!d) return PLATFORM_H / 2;
      const cc = this.center(c, r);
      const s = ((x - cc.x) * d.dx + (z - cc.z) * d.dz) / TILE + 0.5;
      return PLATFORM_H * Math.min(1, Math.max(0, s));
    }
    return 0;
  }

  /** Can a circle of radius rad stand at (x,z) given it currently stands at height h? */
  canOccupy(x, z, rad, h) {
    const c0 = Math.floor((x - rad) / TILE), c1 = Math.floor((x + rad) / TILE);
    const r0 = Math.floor((z - rad) / TILE), r1 = Math.floor((z + rad) / TILE);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        const t = this.get(c, r);
        // circle vs AABB
        const nx = Math.max(c * TILE, Math.min(x, (c + 1) * TILE));
        const nz = Math.max(r * TILE, Math.min(z, (r + 1) * TILE));
        if ((nx - x) ** 2 + (nz - z) ** 2 >= rad * rad) continue;
        if (blocksMove(t)) return false;
        if (t === T.PLATFORM && h < 0.9) return false;
        if (t !== T.PLATFORM && t !== T.STAIRS && h > 0.9) return false;
      }
    }
    return true;
  }

  /** Grid DDA walk over tiles between two world points; cb(c,r,t) returning true stops. */
  walk(ax, az, bx, bz, cb) {
    let x = ax / TILE, z = az / TILE;
    const ex = bx / TILE, ez = bz / TILE;
    let c = Math.floor(x), r = Math.floor(z);
    const ec = Math.floor(ex), er = Math.floor(ez);
    const dx = ex - x, dz = ez - z;
    const sc = dx > 0 ? 1 : -1, sr = dz > 0 ? 1 : -1;
    const tdx = dx !== 0 ? Math.abs(1 / dx) : Infinity;
    const tdz = dz !== 0 ? Math.abs(1 / dz) : Infinity;
    let tmx = dx !== 0 ? (dx > 0 ? (c + 1 - x) : (x - c)) * tdx : Infinity;
    let tmz = dz !== 0 ? (dz > 0 ? (r + 1 - z) : (z - r)) * tdz : Infinity;
    let guard = 0;
    while (guard++ < 400) {
      if (cb(c, r, this.get(c, r))) return true;
      if (c === ec && r === er) return false;
      if (tmx < tmz) { if (tmx > 1) return false; tmx += tdx; c += sc; }
      else { if (tmz > 1) return false; tmz += tdz; r += sr; }
    }
    return false;
  }

  /** Line of sight. smokes: [{x,z,r}] block sight when passed. */
  los(ax, az, bx, bz, smokes) {
    const blocked = this.walk(ax, az, bx, bz, (c, r, t) => blocksSight(t));
    if (blocked) return false;
    if (smokes && smokeBlocks(ax, az, bx, bz, smokes)) return false;
    return true;
  }

  /** Distance along a ray until a sight/bullet-blocking tile (max maxd). */
  rayDist(ax, az, dx, dz, maxd) {
    const bx = ax + dx * maxd, bz = az + dz * maxd;
    let hit = maxd;
    this.walk(ax, az, bx, bz, (c, r, t) => {
      if (!blocksSight(t)) return false;
      // entry distance into this tile (slab test)
      const x0 = c * TILE, x1 = x0 + TILE, z0 = r * TILE, z1 = z0 + TILE;
      let tmin = 0, tmax = maxd;
      for (const [o, d, lo, hi] of [[ax, dx, x0, x1], [az, dz, z0, z1]]) {
        if (Math.abs(d) < 1e-9) { if (o < lo || o > hi) { tmin = Infinity; } continue; }
        let t1 = (lo - o) / d, t2 = (hi - o) / d;
        if (t1 > t2) [t1, t2] = [t2, t1];
        tmin = Math.max(tmin, t1); tmax = Math.min(tmax, t2);
      }
      hit = Math.min(maxd, Math.max(0, tmin));
      return true;
    });
    return hit;
  }

  /** Cover multiplier for a shot: low cover right next to the target, unless shooter has height. */
  coverFactor(ax, az, ah, bx, bz, bh) {
    if (ah - bh > 1.0) return 1; // plunging fire from elevation ignores low cover
    let f = 1;
    this.walk(ax, az, bx, bz, (c, r, t) => {
      if (!isLowCover(t)) return false;
      const p = this.center(c, r);
      const d = Math.hypot(p.x - bx, p.z - bz);
      if (d < TILE * 1.2) { f = t === T.WINDOW ? 0.35 : 0.3; return true; }
      return false;
    });
    return f;
  }

  passable(c, r, opts = {}) {
    const t = this.get(c, r);
    if (t === T.DOOR && opts.doors) return true;
    if ((t === T.BWALL || t === T.IRON) && opts.breach) return true;
    return !blocksMove(t);
  }

  /** A* on the tile grid. Returns array of world points (excluding start), or null. */
  path(from, to, opts = {}) {
    const s = this.toTile(from.x, from.z), g = this.toTile(to.x, to.z);
    if (!this.inb(g.c, g.r)) return null;
    const N = this.rows * this.cols;
    const gs = new Float32Array(N).fill(Infinity);
    const came = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const heap = new MinHeap();
    const si = this.idx(s.c, s.r), gi = this.idx(g.c, g.r);
    gs[si] = 0;
    heap.push(si, 0);
    const H = (c, r) => Math.hypot(c - g.c, r - g.r);
    const maxNodes = opts.maxNodes || 1e9;
    let expanded = 0;
    while (heap.size) {
      const cur = heap.pop();
      if (cur === gi) break;
      if (closed[cur]) continue;
      closed[cur] = 1;
      if (++expanded > maxNodes) return null;
      const cc = cur % this.cols, cr = (cur / this.cols) | 0;
      const ct = this.tiles[cur];
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) {
        if (!dc && !dr) continue;
        const nc = cc + dc, nr = cr + dr;
        if (!this.inb(nc, nr) || !this.passable(nc, nr, opts)) continue;
        if (dc && dr && (!this.passable(cc + dc, cr, opts) || !this.passable(cc, cr + dr, opts))) continue;
        const nt = this.get(nc, nr);
        if (Math.abs(levelOf(nt) - levelOf(ct)) > 1) continue;
        if (dc && dr && (nt === T.STAIRS || ct === T.STAIRS)) continue;
        const ni = this.idx(nc, nr);
        let cost = dc && dr ? 1.414 : 1;
        if (nt === T.WIRE) cost *= opts.wireCost || 5;
        if (nt === T.DOOR) cost += 3;
        if (opts.avoid && opts.avoid(nc, nr)) cost += 6;
        const ng = gs[cur] + cost;
        if (ng < gs[ni]) { gs[ni] = ng; came[ni] = cur; heap.push(ni, ng + H(nc, nr)); }
      }
    }
    if (came[gi] === -1 && gi !== si) return null;
    const out = [];
    let k = gi;
    while (k !== si && k !== -1) { out.push(this.center(k % this.cols, (k / this.cols) | 0)); k = came[k]; }
    out.reverse();
    if (out.length) out[out.length - 1] = { x: to.x, z: to.z };
    return out;
  }

  /** Flood fill of walkable tiles reachable from the spawn with doors closed = "outside". */
  outsideMask() {
    const m = new Uint8Array(this.rows * this.cols);
    const s = this.toTile(this.spawn.x, this.spawn.z);
    const q = [this.idx(s.c, s.r)];
    m[q[0]] = 1;
    while (q.length) {
      const k = q.pop();
      const c = k % this.cols, r = (k / this.cols) | 0;
      for (const [dc, dr] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const nc = c + dc, nr = r + dr;
        if (!this.inb(nc, nr)) continue;
        const ni = this.idx(nc, nr);
        if (m[ni]) continue;
        const t = this.tiles[ni];
        if (t === T.WALL || t === T.WINDOW || t === T.DOOR || t === T.BWALL || t === T.IRON) continue;
        m[ni] = 1;
        q.push(ni);
      }
    }
    return m;
  }
}

export function segPointDist(ax, az, bx, bz, px, pz) {
  const dx = bx - ax, dz = bz - az;
  const L = dx * dx + dz * dz;
  let t = L > 0 ? ((px - ax) * dx + (pz - az) * dz) / L : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(ax + dx * t - px, az + dz * t - pz);
}

export function smokeBlocks(ax, az, bx, bz, smokes) {
  for (const s of smokes) {
    if (s.r < 0.5) continue;
    if (segPointDist(ax, az, bx, bz, s.x, s.z) < s.r * 0.9) return true;
  }
  return false;
}

class MinHeap {
  constructor() { this.k = []; this.p = []; }
  get size() { return this.k.length; }
  push(k, p) {
    const a = this.k, b = this.p;
    let i = a.length; a.push(k); b.push(p);
    while (i > 0) {
      const j = (i - 1) >> 1;
      if (b[j] <= p) break;
      a[i] = a[j]; b[i] = b[j]; i = j;
    }
    a[i] = k; b[i] = p;
  }
  pop() {
    const a = this.k, b = this.p;
    const top = a[0];
    const lk = a.pop(), lp = b.pop();
    if (a.length) {
      let i = 0;
      const n = a.length;
      for (;;) {
        let l = 2 * i + 1, r = l + 1, m = i;
        let mp = lp;
        if (l < n && b[l] < mp) { m = l; mp = b[l]; }
        if (r < n && b[r] < mp) { m = r; mp = b[r]; }
        if (m === i) break;
        a[i] = a[m]; b[i] = b[m]; i = m;
      }
      a[i] = lk; b[i] = lp;
    }
    return top;
  }
}

/** Small deterministic RNG (mulberry32). */
export function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
