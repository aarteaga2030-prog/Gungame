// Loads the provided GLB assets and builds reusable prototypes:
//  - blue soldier  (german_bundeswehr_soldier_-_rigged.glb)  → player squad
//  - red soldier   (rigged_and_textured_mid-poly_soldier.glb) → opposing force
//  - rifle         (nemesis_sniper_rifle.glb) — used as a semi/full-auto service rifle
//  - sandbags      (sandbags_-_defense_line.glb) — one segment per sandbag tile
//  - helmet        (military_helmet.glb) — worn by the opposing force
import * as THREE from 'three';
import { GLTFLoader } from '../lib/addons/loaders/GLTFLoader.js';
import * as SU from '../lib/addons/utils/SkeletonUtils.js';

export const Assets = { blue: null, red: null, rifle: null, sandbag: null, helmet: null };

const base = (n) => n.replace(/^mixamorig:?/, '').replace(/_\d+$/, '');

export async function loadAssets(onProgress = () => {}) {
  const loader = new GLTFLoader();
  const files = {
    blue: 'assets/german_bundeswehr_soldier_-_rigged.glb',
    red: 'assets/rigged_and_textured_mid-poly_soldier.glb',
    rifle: 'assets/nemesis_sniper_rifle.glb',
    sandbag: 'assets/sandbags_-_defense_line.glb',
    helmet: 'assets/military_helmet.glb',
  };
  const keys = Object.keys(files);
  const progress = {};
  const report = () => onProgress(keys.reduce((s, k) => s + (progress[k] || 0), 0) / keys.length);
  const gl = {};
  await Promise.all(keys.map(async (k) => {
    gl[k] = await loader.loadAsync(files[k], (e) => {
      if (e.lengthComputable) { progress[k] = e.loaded / e.total; report(); }
    });
    progress[k] = 1; report();
  }));

  const idle = gl.blue.animations[0];
  Assets.blue = prepSoldier(gl.blue.scene, idle, 1.74, 0x0b2a66);
  Assets.red = prepSoldier(gl.red.scene, idle, 1.74, 0x5a0d0d);
  Assets.rifle = prepRifle(gl.rifle.scene);
  Assets.sandbag = prepSandbag(gl.sandbag.scene);
  Assets.helmet = prepHelmet(gl.helmet.scene);
  // OPFOR wears the helmet asset.
  attachHelmet(Assets.red);
}

/** Retarget the mixamo idle frame onto any mixamo rig (by bone base-name). */
function applyIdle(model, clip) {
  const bones = {};
  model.traverse((n) => { if (n.isBone) bones[base(n.name)] = n; });
  const tracks = [];
  for (const t of clip.tracks) {
    const [nm, prop] = t.name.split('.');
    if (prop !== 'quaternion') continue;
    const b = bones[base(nm)];
    if (!b) continue;
    const nt = t.clone();
    nt.name = b.name + '.' + prop;
    tracks.push(nt);
  }
  const mixer = new THREE.AnimationMixer(model);
  mixer.clipAction(new THREE.AnimationClip('idle', clip.duration, tracks)).play();
  mixer.update(0.5);
  mixer.stopAllAction();
  return bones;
}

function prepSoldier(scene, idleClip, height, emissive) {
  const model = scene;
  let bones = applyIdle(model, idleClip);
  model.updateMatrixWorld(true);
  const wp = (b) => b.getWorldPosition(new THREE.Vector3());
  const top = wp(bones.HeadTop_End).y;
  const foot = Math.min(wp(bones.LeftFoot).y, wp(bones.RightFoot).y);
  const k = height / (top - foot + 0.08);
  model.scale.multiplyScalar(k);
  model.updateMatrixWorld(true);
  const hips = wp(bones.Hips);
  const foot2 = Math.min(wp(bones.LeftFoot).y, wp(bones.RightFoot).y);
  model.position.x -= hips.x;
  model.position.z -= hips.z;
  model.position.y -= foot2 - 0.07;
  const wrap = new THREE.Group();
  wrap.add(model);
  wrap.traverse((o) => {
    if (o.isMesh) {
      o.castShadow = true;
      o.frustumCulled = false;
      const mats = Array.isArray(o.material) ? o.material : [o.material];
      const nm = mats.map((m) => {
        const c = m.clone();
        if (c.emissive) { c.emissive = new THREE.Color(emissive); c.emissiveIntensity = 0.6; }
        return c;
      });
      o.material = Array.isArray(o.material) ? nm : nm[0];
    }
  });
  return { scene: wrap };
}

function prepRifle(scene) {
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const ctr = box.getCenter(new THREE.Vector3());
  const k = 0.95 / Math.max(size.x, size.y, size.z);
  scene.position.sub(ctr);
  const g = new THREE.Group();
  const s = new THREE.Group();
  s.scale.setScalar(k);
  s.add(scene);
  g.add(s);
  g.traverse((o) => { if (o.isMesh) o.castShadow = true; });
  return g;
}

function prepSandbag(scene) {
  let piece = scene.getObjectByName('Sandbags_Line_1') || scene;
  piece = piece.clone();
  piece.position.set(0, 0, 0);
  piece.updateMatrixWorld(true);
  const holder = new THREE.Group();
  holder.add(piece);
  holder.updateMatrixWorld(true);
  let box = new THREE.Box3().setFromObject(holder);
  let size = box.getSize(new THREE.Vector3());
  // Find the "up" axis = smallest extent of the three, longest horizontal goes along x.
  const ext = [size.x, size.y, size.z];
  const up = ext.indexOf(Math.min(...ext));
  if (up === 2) piece.rotation.x = -Math.PI / 2;
  else if (up === 0) piece.rotation.z = Math.PI / 2;
  holder.updateMatrixWorld(true);
  box = new THREE.Box3().setFromObject(holder);
  size = box.getSize(new THREE.Vector3());
  if (size.z > size.x) { piece.rotation.y += Math.PI / 2; holder.updateMatrixWorld(true); box = new THREE.Box3().setFromObject(holder); size = box.getSize(new THREE.Vector3()); }
  const outer = new THREE.Group();
  const ctr = box.getCenter(new THREE.Vector3());
  holder.position.set(-ctr.x, -box.min.y, -ctr.z);
  const sc = new THREE.Group();
  sc.add(holder);
  sc.scale.set(2.05 / size.x, 0.95 / size.y, 1.1 / size.z);
  outer.add(sc);
  outer.traverse((o) => { if (o.isMesh) { o.castShadow = true; o.receiveShadow = true; } });
  return outer;
}

function prepHelmet(scene) {
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  const ctr = box.getCenter(new THREE.Vector3());
  scene.position.sub(ctr);
  const g = new THREE.Group();
  const s = new THREE.Group();
  s.scale.setScalar(0.3 / Math.max(size.x, size.y, size.z));
  s.add(scene);
  g.add(s);
  return g;
}

function attachHelmet(proto) {
  let head = null;
  proto.scene.traverse((o) => { if (o.isBone && base(o.name) === 'Head') head = o; });
  // hide the original cap
  proto.scene.traverse((o) => { if (o.isMesh && /Hats|Hair/.test(o.name)) o.visible = false; });
  if (!head) return;
  proto.scene.updateMatrixWorld(true);
  const h = Assets.helmet.clone();
  // place in world at head top, then convert to head-local
  const top = new THREE.Vector3();
  head.getWorldPosition(top);
  top.y += 0.12;
  head.add(h);
  const inv = new THREE.Matrix4().copy(head.matrixWorld).invert();
  h.position.copy(top.applyMatrix4(inv));
  const hs = new THREE.Vector3();
  head.getWorldScale(hs);
  h.scale.setScalar(1 / hs.x);
  const hq = head.getWorldQuaternion(new THREE.Quaternion()).invert();
  h.quaternion.copy(hq);
}

// ────────────────────────── per-unit soldier instance ──────────────────────────
const _v1 = new THREE.Vector3(), _v2 = new THREE.Vector3(), _q1 = new THREE.Quaternion(), _q2 = new THREE.Quaternion(), _q3 = new THREE.Quaternion();

export function makeSoldier(team) {
  const proto = team === 'blue' ? Assets.blue : Assets.red;
  const body = SU.clone(proto.scene);
  const root = new THREE.Group();
  const tilt = new THREE.Group(); // used for the death fall
  tilt.add(body);
  root.add(tilt);
  const bones = {};
  body.traverse((o) => { if (o.isBone) bones[base(o.name)] = o; });
  const rest = {};
  for (const k of ['RightArm', 'RightForeArm', 'LeftArm', 'LeftForeArm', 'LeftUpLeg', 'RightUpLeg', 'LeftLeg', 'RightLeg', 'Spine1']) {
    if (bones[k]) rest[k] = bones[k].quaternion.clone();
  }
  const rifle = Assets.rifle.clone();
  rifle.position.set(-0.13, 1.22, 0.32);
  tilt.add(rifle);
  const muzzle = new THREE.Object3D();
  muzzle.position.set(-0.13, 1.25, 0.85);
  tilt.add(muzzle);

  function point(bone, child, dir) {
    if (!bone || !child) return;
    bone.getWorldPosition(_v1);
    child.getWorldPosition(_v2);
    _v2.sub(_v1).normalize();
    _q1.setFromUnitVectors(_v2, dir);
    bone.getWorldQuaternion(_q2);
    bone.parent.getWorldQuaternion(_q3);
    bone.quaternion.copy(_q3.invert().multiply(_q1.multiply(_q2)));
    bone.updateMatrixWorld(true);
  }
  const D = (x, y, z) => new THREE.Vector3(x, y, z).normalize();
  const dRA = D(-0.25, -0.8, 0.3), dRF = D(0.35, 0.15, 0.9), dLA = D(0.2, -0.55, 0.8), dLF = D(-0.25, 0.1, 1);
  const wq = new THREE.Quaternion();
  const tmp = new THREE.Vector3();

  return {
    root, tilt, body, rifle, muzzle,
    /** Procedural pose: walk cycle on the legs, rifle-ready arms. */
    pose(phase, moveAmt) {
      for (const k in rest) bones[k].quaternion.copy(rest[k]);
      const sw = Math.sin(phase) * 0.55 * moveAmt;
      if (bones.LeftUpLeg) bones.LeftUpLeg.rotateX(-sw);
      if (bones.RightUpLeg) bones.RightUpLeg.rotateX(sw);
      if (bones.LeftLeg) bones.LeftLeg.rotateX(Math.max(0, sw) * 0.9);
      if (bones.RightLeg) bones.RightLeg.rotateX(Math.max(0, -sw) * 0.9);
      root.updateMatrixWorld(true);
      tilt.getWorldQuaternion(wq);
      point(bones.RightArm, bones.RightForeArm, tmp.copy(dRA).applyQuaternion(wq));
      point(bones.RightForeArm, bones.RightHand, tmp.copy(dRF).applyQuaternion(wq));
      point(bones.LeftArm, bones.LeftForeArm, tmp.copy(dLA).applyQuaternion(wq));
      point(bones.LeftForeArm, bones.LeftHand, tmp.copy(dLF).applyQuaternion(wq));
    },
  };
}
