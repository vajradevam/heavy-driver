// Name boards: street signs, shop / place-of-interest boards and district boards.
// Tiles carry thousands of labels, so a fixed pool of board meshes is re-used for
// whichever labels are currently closest to the player.
import * as THREE from 'three';

const POOL = 120;
const RANGE = [240, 240, 750]; // visible range by kind: street, poi, place
const SIZE = [[3.4, 0.85, 2.9], [3.2, 0.8, 2.7], [8, 2, 5.6]]; // width, height, centre height by kind

const POI_COLORS = {
  food: '#c2452d', shop: '#2f6fb3', health: '#c0392b', school: '#b7791f', transport: '#4a5568',
  worship: '#6b46c1', park: '#2f855a', lodging: '#2c7a7b', money: '#276749', other: '#555b66',
};
const POI_GROUP = {
  restaurant: 'food', cafe: 'food', fast_food: 'food', bar: 'food', beer: 'food', bakery: 'food', ice_cream: 'food',
  shop: 'shop', grocery: 'shop', clothing_store: 'shop', alcohol_shop: 'shop', laundry: 'shop', butcher: 'shop', car: 'shop',
  hospital: 'health', pharmacy: 'health', doctors: 'health', dentist: 'health', veterinary: 'health',
  school: 'school', college: 'school', library: 'school',
  bus: 'transport', railway: 'transport', fuel: 'transport', parking: 'transport', aerialway: 'transport', ferry_terminal: 'transport',
  place_of_worship: 'worship', park: 'park', garden: 'park', stadium: 'park', pitch: 'park', golf: 'park', campsite: 'park',
  lodging: 'lodging', bank: 'money', atm: 'money', post: 'money',
};

function fitText(g, text, maxW, sizes) {
  for (const px of sizes) {
    g.font = `600 ${px}px system-ui, "Noto Sans", sans-serif`;
    if (g.measureText(text).width <= maxW) return [text];
  }
  // two lines at the last size, split near the middle
  const words = text.split(' ');
  if (words.length > 1) {
    let best = 1, bestDiff = Infinity;
    for (let i = 1; i < words.length; i++) {
      const diff = Math.abs(words.slice(0, i).join(' ').length - words.slice(i).join(' ').length);
      if (diff < bestDiff) { bestDiff = diff; best = i; }
    }
    return [words.slice(0, best).join(' '), words.slice(best).join(' ')];
  }
  return [text];
}

function draw(g, label) {
  const W = 256, H = 64;
  g.clearRect(0, 0, W, H);
  let fg = '#fff', left = 10;
  if (label.k === 0) { g.fillStyle = '#1f6b45'; fg = '#fff'; }
  else if (label.k === 2) { g.fillStyle = '#1d4f91'; fg = '#fff'; }
  else { g.fillStyle = '#fbf9f2'; fg = '#1d2229'; }
  g.fillRect(0, 0, W, H);
  if (label.k === 1) {
    g.fillStyle = POI_COLORS[POI_GROUP[label.c] || 'other'];
    g.fillRect(0, 0, 14, H);
    g.fillRect(0, H - 5, W, 5);
    left = 22;
  } else {
    g.strokeStyle = '#fff';
    g.lineWidth = 3;
    g.strokeRect(3.5, 3.5, W - 7, H - 7);
  }
  g.fillStyle = fg;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const maxW = W - left - 10;
  const lines = fitText(g, label.t, maxW, [32, 26, 21]);
  const cx = left + maxW / 2;
  if (lines.length === 1) g.fillText(lines[0], cx, H / 2 + 1, maxW);
  else {
    g.font = '600 21px system-ui, "Noto Sans", sans-serif';
    g.fillText(lines[0], cx, 20, maxW);
    g.fillText(lines[1], cx, 44, maxW);
  }
}

export class Signs {
  constructor(scene, world) {
    this.world = world;
    this.timer = 1;
    this.active = new Map(); // label key -> board
    this.idle = [];
    this.materials = [];
    const poleGeo = new THREE.CylinderGeometry(0.06, 0.06, 1, 6).translate(0, 0.5, 0);
    const poleMat = new THREE.MeshLambertMaterial({ color: 0x70757c });
    const plateGeo = new THREE.PlaneGeometry(1, 1);
    for (let i = 0; i < POOL; i++) {
      const canvas = document.createElement('canvas');
      canvas.width = 256; canvas.height = 64;
      const tex = new THREE.CanvasTexture(canvas);
      tex.colorSpace = THREE.SRGBColorSpace;
      tex.anisotropy = 4;
      const mat = new THREE.MeshBasicMaterial({ map: tex });
      this.materials.push(mat);
      const group = new THREE.Group();
      const pole = new THREE.Mesh(poleGeo, poleMat);
      const front = new THREE.Mesh(plateGeo, mat), back = new THREE.Mesh(plateGeo, mat);
      back.rotation.y = Math.PI;
      front.position.z = 0.03; back.position.z = -0.03;
      const plate = new THREE.Group();
      plate.add(front, back);
      group.add(pole, plate);
      group.visible = false;
      scene.add(group);
      this.idle.push({ group, pole, plate, tex, g: canvas.getContext('2d'), key: '' });
    }
  }

  // Boards are unlit; dim them at night (they stay a little brighter than the ground, like reflective signs).
  setNight(night) {
    const v = 1 - night * 0.5;
    for (const m of this.materials) m.color.setRGB(v, v, v);
  }

  update(dt, x, z) {
    this.timer += dt;
    if (this.timer < 0.35) return;
    this.timer = 0;
    const found = [];
    for (const t of this.world.tiles.values()) {
      if (!t.data || !t.group?.visible) continue;
      const labels = t.data.labels;
      for (let i = 0; i < labels.length; i++) {
        const l = labels[i];
        const d = Math.hypot(t.wx + l.x - x, t.wz + l.z - z);
        if (d < RANGE[l.k]) found.push([l.k === 2 ? d / 3 : d, t, i]);
      }
    }
    found.sort((a, b) => a[0] - b[0]);
    found.length = Math.min(found.length, POOL);
    const keep = new Set(found.map(([, t, i]) => `${t.key}:${i}`));
    for (const [key, b] of this.active) {
      if (keep.has(key)) continue;
      b.group.visible = false;
      this.active.delete(key);
      this.idle.push(b);
    }
    for (const [, t, i] of found) {
      const key = `${t.key}:${i}`, l = t.data.labels[i];
      let b = this.active.get(key);
      if (!b) {
        b = this.idle.pop();
        if (!b) break;
        draw(b.g, l);
        b.tex.needsUpdate = true;
        const [w, h, y] = SIZE[l.k];
        const lift = l.k === 1 ? ((i * 37) % 10) * 0.07 : 0;
        b.plate.scale.set(w, h, 1);
        b.plate.position.y = y + lift;
        b.pole.scale.set(l.k === 2 ? 2.2 : 1, y + lift, l.k === 2 ? 2.2 : 1);
        b.group.rotation.y = l.a;
        b.group.visible = true;
        this.active.set(key, b);
      }
      b.group.position.set(t.wx + l.x, 0, t.wz + l.z); // re-applied every pass so origin shifts are harmless
    }
  }
}
