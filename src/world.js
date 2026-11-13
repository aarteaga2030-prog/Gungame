// Visual construction of a level: "killhouse blueprint" look — white floor with grid
// lines, light walls with dark tops and inked edges, amber doors, orange breach walls.
import * as THREE from 'three';
import { T, TILE, PLATFORM_H } from './map.js';
import { Assets } from './assets.js';

const COL = {
  wallSide: 0xdfe3e8, wallTop: 0x343b48, edge: 0x1c2230,
  low: 0xc9cfd7, lowTop: 0x8a95a5, door: 0xe3a53a, bwall: 0xd9622b, iron: 0x4b525c,
  crate: 0xb48a58, platform: 0xe9ecf1, platformTop: 0xf3f5f8, wire: 0x4a4f57,
  glass: 0x7fc4ff,
};

function gridTexture(size = 256, major = '#b9c0cb', minor = '#e3e7ec', bg = '#fbfbfc') {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  const g = c.getContext('2d');
  g.fillStyle = bg; g.fillRect(0, 0, size, size);
  g.strokeStyle = minor; g.lineWidth = 2;
  for (let i = 1; i < 4; i++) {
    const p = (i * size) / 4;
    g.beginPath(); g.moveTo(p, 0); g.lineTo(p, size); g.stroke();
    g.beginPath(); g.moveTo(0, p); g.lineTo(size, p); g.stroke();
  }
  g.strokeStyle = major; g.lineWidth = 3;
  g.strokeRect(0, 0, size, size);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

function hatchTexture(color) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  g.strokeStyle = color; g.lineWidth = 6;
  for (let i = -64; i < 128; i += 16) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 64, 64); g.stroke(); }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  return t;
}

const boxGeo = new THREE.BoxGeometry(1, 1, 1);
const edgeGeo = new THREE.EdgesGeometry(boxGeo);

export class World {
  constructor(scene, map) {
    this.scene = scene;
    this.map = map;
    this.group = new THREE.Group();
    scene.add(this.group);
    this.dynamic = new Map(); // tile idx -> Object3D (doors, breach walls, wire...)
    this.edgeMat = new THREE.LineBasicMaterial({ color: COL.edge, transparent: true, opacity: 0.55 });
    this.mats = {
      wall: [
        new THREE.MeshStandardMaterial({ color: COL.wallSide, roughness: 0.95 }),
        new THREE.MeshStandardMaterial({ color: COL.wallSide, roughness: 0.95 }),
        new THREE.MeshStandardMaterial({ color: COL.wallTop, roughness: 0.9 }),
        new THREE.MeshStandardMaterial({ color: COL.wallSide }),
        new THREE.MeshStandardMaterial({ color: COL.wallSide, roughness: 0.95 }),
        new THREE.MeshStandardMaterial({ color: COL.wallSide, roughness: 0.95 }),
      ],
      low: [0, 1, 2, 3, 4, 5].map((i) => new THREE.MeshStandardMaterial({ color: i === 2 ? COL.lowTop : COL.low, roughness: 0.95 })),
      door: new THREE.MeshStandardMaterial({ color: COL.door, roughness: 0.7 }),
      bwall: [0, 1, 2, 3, 4, 5].map((i) => new THREE.MeshStandardMaterial({ color: i === 2 ? COL.bwall : 0xe7c3b0, roughness: 0.9 })),
      iron: new THREE.MeshStandardMaterial({ color: COL.iron, metalness: 0.6, roughness: 0.45 }),
      crate: new THREE.MeshStandardMaterial({ color: COL.crate, roughness: 0.9 }),
      platform: [0, 1, 2, 3, 4, 5].map((i) => new THREE.MeshStandardMaterial({ color: i === 2 ? COL.platformTop : COL.platform, roughness: 0.95 })),
      glass: new THREE.MeshStandardMaterial({ color: COL.glass, transparent: true, opacity: 0.55, roughness: 0.1 }),
      sill: [0, 1, 2, 3, 4, 5].map((i) => new THREE.MeshStandardMaterial({ color: i === 2 ? 0x5fb2ff : COL.wallSide, roughness: 0.9 })),
      wire: new THREE.MeshStandardMaterial({ color: COL.wire, metalness: 0.7, roughness: 0.4 }),
      rubble: new THREE.MeshStandardMaterial({ color: 0x9aa0a8, roughness: 1 }),
    };
    this.build();
  }

  dispose() {
    this.scene.remove(this.group);
    this.group.traverse((o) => { if (o.geometry && o.geometry !== boxGeo && o.geometry !== edgeGeo) o.geometry.dispose(); });
  }

  box(w, h, d, x, y, z, mat, parent = this.group, edges = true) {
    const m = new THREE.Mesh(boxGeo, mat);
    m.scale.set(w, h, d);
    m.position.set(x, y + h / 2, z);
    m.castShadow = true;
    m.receiveShadow = true;
    parent.add(m);
    if (edges) {
      const e = new THREE.LineSegments(edgeGeo, this.edgeMat);
      e.scale.copy(m.scale);
      e.position.copy(m.position);
      parent.add(e);
    }
    return m;
  }

  build() {
    const map = this.map;
    // floor
    const tex = gridTexture();
    tex.repeat.set(map.cols, map.rows);
    const floor = new THREE.Mesh(new THREE.PlaneGeometry(map.w, map.h), new THREE.MeshStandardMaterial({ map: tex, roughness: 1 }));
    floor.rotation.x = -Math.PI / 2;
    floor.position.set(map.w / 2, 0, map.h / 2);
    floor.receiveShadow = true;
    this.group.add(floor);
    // outer apron
    const tex2 = gridTexture(256, '#d3d8df', '#e8ebef', '#eef0f3');
    tex2.repeat.set(map.cols + 40, map.rows + 40);
    const apron = new THREE.Mesh(new THREE.PlaneGeometry(map.w + 80, map.h + 80), new THREE.MeshStandardMaterial({ map: tex2, roughness: 1 }));
    apron.rotation.x = -Math.PI / 2;
    apron.position.set(map.w / 2, -0.02, map.h / 2);
    apron.receiveShadow = true;
    this.group.add(apron);
    // boundary tape
    const bpts = [[0, 0], [map.w, 0], [map.w, map.h], [0, map.h], [0, 0]].map(([x, z]) => new THREE.Vector3(x, 0.03, z));
    this.group.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(bpts), new THREE.LineBasicMaterial({ color: 0x2b6cff })));

    for (let r = 0; r < map.rows; r++) for (let c = 0; c < map.cols; c++) this.buildTile(c, r, map.get(c, r), true);

    // attackers' staging area
    const st = new THREE.Mesh(new THREE.CircleGeometry(16, 48), new THREE.MeshBasicMaterial({ color: 0x1f6fff, transparent: true, opacity: 0.05, depthWrite: false }));
    st.rotation.x = -Math.PI / 2;
    st.position.set(map.spawn.x, 0.012, map.spawn.z);
    this.group.add(st);
    // objective marker
    if (map.objective) {
      const o = map.objective;
      const ring = new THREE.Mesh(new THREE.RingGeometry(1.0, 1.25, 4, 1), new THREE.MeshBasicMaterial({ color: 0x1f6fff, side: THREE.DoubleSide }));
      ring.rotation.x = -Math.PI / 2; ring.rotation.z = Math.PI / 4;
      ring.position.set(o.x, 0.03, o.z);
      this.group.add(ring);
      this.group.add(textSprite('OBJ', '#1f6fff', o.x, 0.4, o.z, 1.6));
    }
  }

  orientAlongWall(c, r) {
    const m = this.map;
    const solid = (t) => t === T.WALL || t === T.WINDOW || t === T.DOOR || t === T.IRON;
    const ew = solid(m.get(c - 1, r)) || solid(m.get(c + 1, r));
    const ns = solid(m.get(c, r - 1)) || solid(m.get(c, r + 1));
    return ns && !ew ? 'z' : 'x';
  }

  /** (Re)build the visual for one tile. Dynamic tiles get their own group so they can change. */
  buildTile(c, r, t, initial = false, variant) {
    const map = this.map;
    const i = map.idx(c, r);
    const old = this.dynamic.get(i);
    if (old) { this.group.remove(old); this.dynamic.delete(i); }
    if (t === T.OPEN && variant === 'blown') t = T.RUBBLE;
    const { x, z } = map.center(c, r);
    const g = new THREE.Group();
    const S = TILE;
    switch (t) {
      case T.WALL: this.box(S, 3, S, x, 0, z, this.mats.wall, g); break;
      case T.WINDOW: {
        this.box(S, 0.95, S, x, 0, z, this.mats.sill, g);
        const ax = this.orientAlongWall(c, r);
        const pane = this.box(ax === 'x' ? S : 0.12, 1.6, ax === 'x' ? 0.12 : S, x, 0.95, z, this.mats.glass, g, false);
        pane.castShadow = false;
        break;
      }
      case T.DOOR: {
        const ax = this.orientAlongWall(c, r);
        this.box(ax === 'x' ? S * 0.86 : 0.22, 2.3, ax === 'x' ? 0.22 : S * 0.86, x, 0, z, this.mats.door, g);
        this.box(S, 0.7, S, x, 2.3, z, this.mats.wall, g);
        break;
      }
      case T.IRON: {
        const ax = this.orientAlongWall(c, r);
        this.box(ax === 'x' ? S : 0.5, 2.2, ax === 'x' ? 0.5 : S, x, 0, z, this.mats.iron, g);
        this.box(S, 0.8, S, x, 2.2, z, this.mats.wall, g);
        break;
      }
      case T.LOW: this.box(S, 1.0, S * 0.5, x, 0, z, this.mats.low, g); break;
      case T.CRATE: this.box(S * 0.8, 1.1, S * 0.8, x, 0, z, this.mats.crate, g); break;
      case T.SANDBAG: {
        if (Assets.sandbag) {
          const s = Assets.sandbag.clone();
          s.position.set(x, 0, z);
          // align with neighbours
          const n = (dc, dr) => map.get(c + dc, r + dr) === T.SANDBAG;
          if ((n(0, 1) || n(0, -1)) && !(n(1, 0) || n(-1, 0))) s.rotation.y = Math.PI / 2;
          g.add(s);
        } else this.box(S, 0.9, S * 0.6, x, 0, z, this.mats.crate, g);
        break;
      }
      case T.WIRE: g.add(wireCoil(x, z, this.mats.wire)); break;
      case T.PLATFORM: this.box(S, PLATFORM_H, S, x, 0, z, this.mats.platform, g); break;
      case T.STAIRS: {
        const d = map.stairDir[i] || { dx: 0, dz: -1 };
        const steps = 6;
        for (let k = 0; k < steps; k++) {
          const h = (PLATFORM_H * (k + 1)) / steps;
          const off = -S / 2 + (S / steps) * (k + 0.5);
          const sx = x + d.dx * off, sz = z + d.dz * off;
          const w = d.dx ? S / steps : S * 0.9, dd = d.dz ? S / steps : S * 0.9;
          this.box(w, h, dd, sx, 0, sz, this.mats.platform, g);
        }
        break;
      }
      case T.RUBBLE: {
        for (let k = 0; k < 5; k++) {
          const s = 0.25 + Math.random() * 0.35;
          this.box(s, s * 0.6, s, x + (Math.random() - 0.5) * 1.4, 0, z + (Math.random() - 0.5) * 1.4, this.mats.rubble, g, false);
        }
        break;
      }
      case T.OPEN: {
        // opened door: leaf swung open against the jamb + lintel
        const ax = this.orientAlongWall(c, r);
        this.box(S, 0.7, S, x, 2.3, z, this.mats.wall, g);
        if (ax === 'x') this.box(0.18, 2.3, S * 0.8, x - S * 0.45, 0, z + S * 0.4, this.mats.door, g);
        else this.box(S * 0.8, 2.3, 0.18, x + S * 0.4, 0, z - S * 0.45, this.mats.door, g);
        break;
      }
      default: break;
    }
    if (g.children.length) {
      this.group.add(g);
      this.dynamic.set(i, g);
    }
    return g;
  }
}

function wireCoil(x, z, mat) {
  const g = new THREE.Group();
  const tor = new THREE.TorusGeometry(0.38, 0.025, 4, 18);
  for (let k = 0; k < 5; k++) {
    const m = new THREE.Mesh(tor, mat);
    m.position.set(x - 0.8 + k * 0.4, 0.38, z);
    m.rotation.y = Math.PI / 2 + (k % 2 ? 0.25 : -0.25);
    g.add(m);
    const m2 = m.clone();
    m2.position.z = z + 0.5; m2.position.y = 0.3; m2.scale.setScalar(0.8);
    g.add(m2);
  }
  for (const dx of [-0.9, 0.9]) {
    const post = new THREE.Mesh(boxGeo, mat);
    post.scale.set(0.05, 0.9, 0.05);
    post.position.set(x + dx, 0.45, z + 0.2);
    g.add(post);
  }
  return g;
}

export function textSprite(text, color, x, y, z, scale = 1) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 96;
  const g = c.getContext('2d');
  g.font = 'bold 64px "Inter", system-ui, sans-serif';
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillStyle = color;
  g.fillText(text, 128, 50);
  const t = new THREE.CanvasTexture(c);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, depthTest: false, transparent: true }));
  s.scale.set(2.6 * scale, 1 * scale, 1);
  s.position.set(x, y, z);
  s.renderOrder = 10;
  return s;
}
