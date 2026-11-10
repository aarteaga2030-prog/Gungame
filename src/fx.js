// Visual effects: tracers, smoke, blasts, team rings, sight fans, warning rings.
import * as THREE from 'three';

const unitBox = new THREE.BoxGeometry(1, 1, 1);

function radialTexture(inner = 'rgba(255,255,255,1)', outer = 'rgba(255,255,255,0)') {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d');
  const gr = g.createRadialGradient(64, 64, 4, 64, 64, 62);
  gr.addColorStop(0, inner);
  gr.addColorStop(0.55, inner.replace(/[\d.]+\)$/, '0.75)'));
  gr.addColorStop(1, outer);
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  return new THREE.CanvasTexture(c);
}

export class FX {
  constructor(scene) {
    this.scene = scene;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.tracers = [];
    this.blasts = [];
    this.smokeVis = new Map();
    this.warnings = [];
    this.flashes = [];
    this.smokeTex = radialTexture('rgba(150,158,170,0.95)', 'rgba(150,158,170,0)');
    this.flashTex = radialTexture('rgba(255,220,140,1)', 'rgba(255,160,40,0)');
    this.tracerMat = {
      blue: new THREE.MeshBasicMaterial({ color: 0x2f8bff, transparent: true }),
      red: new THREE.MeshBasicMaterial({ color: 0xff3b2f, transparent: true }),
    };
  }

  clear() {
    this.scene.remove(this.group);
    this.group = new THREE.Group();
    this.scene.add(this.group);
    this.tracers = []; this.blasts = []; this.smokeVis = new Map(); this.warnings = []; this.flashes = [];
  }

  tracer(ax, ay, az, bx, by, bz, team) {
    const m = new THREE.Mesh(unitBox, this.tracerMat[team].clone());
    const dx = bx - ax, dy = by - ay, dz = bz - az;
    const len = Math.hypot(dx, dy, dz);
    m.scale.set(0.06, 0.06, len);
    m.position.set((ax + bx) / 2, (ay + by) / 2, (az + bz) / 2);
    m.lookAt(bx, by, bz);
    this.group.add(m);
    this.tracers.push({ m, life: 0.09 });
    // muzzle flash
    const f = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.flashTex, transparent: true, depthWrite: false }));
    f.position.set(ax, ay, az);
    f.scale.setScalar(0.7);
    this.group.add(f);
    this.flashes.push({ m: f, life: 0.05 });
  }

  blast(x, z, radius = 3, color = 0xffb347) {
    const s = new THREE.Mesh(new THREE.SphereGeometry(1, 20, 12), new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.85 }));
    s.position.set(x, 0.8, z);
    this.group.add(s);
    const ring = new THREE.Mesh(new THREE.RingGeometry(0.8, 1, 48), new THREE.MeshBasicMaterial({ color: 0x222222, transparent: true, opacity: 0.6, side: THREE.DoubleSide }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.05, z);
    this.group.add(ring);
    const light = new THREE.PointLight(0xffaa55, 60, radius * 6);
    light.position.set(x, 2, z);
    this.group.add(light);
    this.blasts.push({ s, ring, light, t: 0, life: 0.6, radius });
  }

  warning(x, z, radius, life) {
    const ring = new THREE.Mesh(new THREE.RingGeometry(radius - 0.2, radius, 48), new THREE.MeshBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthWrite: false }));
    ring.rotation.x = -Math.PI / 2;
    ring.position.set(x, 0.06, z);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(radius, 48), new THREE.MeshBasicMaterial({ color: 0xff2a2a, transparent: true, opacity: 0.12, depthWrite: false }));
    disc.rotation.x = -Math.PI / 2;
    disc.position.set(x, 0.05, z);
    this.group.add(ring, disc);
    this.warnings.push({ ring, disc, t: 0, life });
  }

  /** Sync smoke visuals to the sim's smoke list [{id,x,z,r,alpha}] */
  syncSmokes(smokes) {
    const live = new Set();
    for (const s of smokes) {
      live.add(s.id);
      let v = this.smokeVis.get(s.id);
      if (!v) {
        v = new THREE.Group();
        const n = 9;
        for (let k = 0; k < n; k++) {
          const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.smokeTex, transparent: true, depthWrite: false }));
          const a = (k / n) * Math.PI * 2, rr = k === 0 ? 0 : 0.55;
          sp.userData = { ox: Math.cos(a) * rr, oz: Math.sin(a) * rr, oy: 0.6 + (k % 3) * 0.7, spin: Math.random() };
          v.add(sp);
        }
        this.group.add(v);
        this.smokeVis.set(s.id, v);
      }
      v.position.set(s.x, 0, s.z);
      for (const sp of v.children) {
        const u = sp.userData;
        sp.position.set(u.ox * s.r, u.oy * Math.max(0.6, s.r / 3), u.oz * s.r);
        sp.scale.setScalar(Math.max(0.3, s.r * 1.25));
        sp.material.opacity = 0.82 * s.alpha;
      }
    }
    for (const [id, v] of this.smokeVis) {
      if (!live.has(id)) { this.group.remove(v); this.smokeVis.delete(id); }
    }
  }

  update(dt) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life -= dt;
      t.m.material.opacity = Math.max(0, t.life / 0.09);
      if (t.life <= 0) { this.group.remove(t.m); t.m.material.dispose(); this.tracers.splice(i, 1); }
    }
    for (let i = this.flashes.length - 1; i >= 0; i--) {
      const f = this.flashes[i];
      f.life -= dt;
      if (f.life <= 0) { this.group.remove(f.m); f.m.material.dispose(); this.flashes.splice(i, 1); }
    }
    for (let i = this.blasts.length - 1; i >= 0; i--) {
      const b = this.blasts[i];
      b.t += dt;
      const k = b.t / b.life;
      b.s.scale.setScalar(0.5 + k * b.radius);
      b.s.material.opacity = 0.85 * (1 - k);
      b.ring.scale.setScalar(0.5 + k * b.radius * 1.6);
      b.ring.material.opacity = 0.6 * (1 - k);
      b.light.intensity = 60 * (1 - k);
      if (k >= 1) { this.group.remove(b.s, b.ring, b.light); this.blasts.splice(i, 1); }
    }
    for (let i = this.warnings.length - 1; i >= 0; i--) {
      const w = this.warnings[i];
      w.t += dt;
      const pulse = 0.5 + 0.5 * Math.sin(w.t * 18);
      w.ring.material.opacity = 0.4 + 0.5 * pulse;
      w.disc.material.opacity = 0.08 + 0.12 * (w.t / w.life);
      if (w.t >= w.life) { this.group.remove(w.ring, w.disc); this.warnings.splice(i, 1); }
    }
  }
}

/** Ground ring under a unit (team colour) + facing chevron. */
export function makeRing(team) {
  const col = team === 'blue' ? 0x1f6fff : 0xff2d2d;
  const g = new THREE.Group();
  const ring = new THREE.Mesh(new THREE.RingGeometry(0.42, 0.55, 32), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.95, depthWrite: false }));
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.04;
  const disc = new THREE.Mesh(new THREE.CircleGeometry(0.42, 32), new THREE.MeshBasicMaterial({ color: col, transparent: true, opacity: 0.18, depthWrite: false }));
  disc.rotation.x = -Math.PI / 2;
  disc.position.y = 0.035;
  const chev = new THREE.Mesh(new THREE.ConeGeometry(0.16, 0.35, 3), new THREE.MeshBasicMaterial({ color: col }));
  chev.rotation.x = Math.PI / 2;
  chev.position.set(0, 0.05, 0.75);
  g.add(ring, disc, chev);
  return g;
}

/** Sight fan: a flat polygon on the floor, rebuilt from ray-cast distances. */
export class SightFan {
  constructor(color, opacity = 0.13) {
    this.rays = 22;
    this.geo = new THREE.BufferGeometry();
    this.pos = new Float32Array((this.rays + 2) * 3);
    this.geo.setAttribute('position', new THREE.BufferAttribute(this.pos, 3));
    const idx = [];
    for (let i = 1; i <= this.rays; i++) idx.push(0, i, i + 1);
    this.geo.setIndex(idx);
    this.mesh = new THREE.Mesh(this.geo, new THREE.MeshBasicMaterial({ color, transparent: true, opacity, depthWrite: false, side: THREE.DoubleSide }));
    this.mesh.renderOrder = 2;
    this.mesh.frustumCulled = false;
    this.edgeGeo = new THREE.BufferGeometry();
    this.edgePos = new Float32Array((this.rays + 3) * 3);
    this.edgeGeo.setAttribute('position', new THREE.BufferAttribute(this.edgePos, 3));
    this.edge = new THREE.Line(this.edgeGeo, new THREE.LineBasicMaterial({ color, transparent: true, opacity: Math.min(1, opacity * 4) }));
    this.edge.frustumCulled = false;
    this.group = new THREE.Group();
    this.group.add(this.mesh, this.edge);
  }

  /** map: GameMap, x/z origin, yaw centre, fov (deg), range, y height */
  update(map, x, z, yaw, fov, range, y, smokes) {
    const half = (fov * Math.PI) / 360;
    const P = this.pos, E = this.edgePos;
    P[0] = x; P[1] = y; P[2] = z;
    E[0] = x; E[1] = y; E[2] = z;
    for (let i = 0; i <= this.rays; i++) {
      const a = yaw - half + (2 * half * i) / this.rays;
      const dx = Math.sin(a), dz = Math.cos(a);
      let d = map.rayDist(x, z, dx, dz, range);
      if (smokes) for (const s of smokes) {
        // clip by smoke circle
        const fx = s.x - x, fz = s.z - z;
        const t = fx * dx + fz * dz;
        if (t < 0) continue;
        const perp2 = fx * fx + fz * fz - t * t;
        const rr = (s.r * 0.9) ** 2;
        if (perp2 < rr) { const ent = t - Math.sqrt(rr - perp2); if (ent < d) d = Math.max(0, ent); }
      }
      const o = (i + 1) * 3;
      P[o] = x + dx * d; P[o + 1] = y; P[o + 2] = z + dz * d;
      E[o] = P[o]; E[o + 1] = y; E[o + 2] = P[o + 2];
    }
    const last = (this.rays + 2) * 3;
    E[last] = x; E[last + 1] = y; E[last + 2] = z;
    this.geo.attributes.position.needsUpdate = true;
    this.edgeGeo.attributes.position.needsUpdate = true;
  }
}
