// World: streams map tiles around the player, turns worker output into meshes,
// and answers spatial queries (collision, road lookup, street names).
import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import {
  Z, EARTH, CELL, PAD, KIND_ROAD, KIND_PATH, KIND_RAIL,
  SEG_STRIDE, NAME_STRIDE, TREE_STRIDE, lonLatToMerc, mercToLonLat,
} from './shared.js';

const TILEJSON = 'https://tiles.openfreemap.org/planet';
const N_TILES = 2 ** Z;
const LOAD_RING = 1; // load a (2*1+1)² block around the player
const KEEP_RING = 2; // drop tiles outside this ring
const WORKERS = 3;

// Facade textures, one per building style (order matches the S_* constants in tileWorker.js).
// Each texture is one 3 m wide x one-storey bay; it is multiplied by the building's wall colour.
function facadeTextures() {
  const make = (paint) => {
    const c = document.createElement('canvas');
    c.width = c.height = 128;
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, 128, 128);
    paint(g);
    const t = new THREE.CanvasTexture(c);
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    // Night glow: the same window openings over a 4 x 4 block of bays, each lit or dark at random.
    const e = document.createElement('canvas');
    e.width = e.height = 256;
    const eg = e.getContext('2d');
    eg.fillStyle = '#000';
    eg.fillRect(0, 0, 256, 256);
    let seed = rects.length * 7919 + 13;
    for (let by = 0; by < 4; by++) for (let bx = 0; bx < 4; bx++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      const r = (seed >> 8) % 100;
      if (r < 45) continue;
      eg.fillStyle = r < 70 ? '#ffd98a' : r < 88 ? '#fff1c9' : '#b9d4ff';
      eg.globalAlpha = 0.55 + (r % 5) * 0.1;
      for (const [x, y, w, h] of rects) eg.fillRect(bx * 64 + x / 2, by * 64 + y / 2, w / 2, h / 2);
    }
    const glow = new THREE.CanvasTexture(e);
    glow.wrapS = glow.wrapT = THREE.RepeatWrapping;
    glow.colorSpace = THREE.SRGBColorSpace;
    glow.repeat.set(0.25, 0.25);
    rects = [];
    return { map: t, glow };
  };
  let rects = [];
  const glass = (g, x, y, w, h) => {
    rects.push([x, y, w, h]);
    g.fillStyle = '#4c5d70'; g.fillRect(x, y, w, h);
    g.fillStyle = '#7e93a8'; g.fillRect(x, y, w, h * 0.3);
    g.fillStyle = 'rgba(255,255,255,0.18)';
    g.beginPath(); g.moveTo(x, y + h); g.lineTo(x + w * 0.45, y); g.lineTo(x + w * 0.7, y); g.lineTo(x + w * 0.25, y + h); g.fill();
  };
  const win = (g, x, y, w, h) => {
    g.fillStyle = '#f6f6f6'; g.fillRect(x - 4, y - 4, w + 8, h + 8);
    glass(g, x, y, w, h);
    g.fillStyle = '#f6f6f6'; g.fillRect(x + w / 2 - 1.5, y, 3, h);
    g.fillStyle = '#c9c9c9'; g.fillRect(x - 7, y + h + 4, w + 14, 5);
  };
  return [
    // 0 plaster with a framed window
    make((g) => { g.fillStyle = '#e6e6e6'; g.fillRect(0, 0, 128, 5); win(g, 36, 34, 56, 58); }),
    // 1 glass curtain wall
    make((g) => {
      for (let i = 0; i < 2; i++) { g.fillStyle = i ? '#d3e0ec' : '#e2ecf5'; g.fillRect(i * 64, 0, 64, 128); }
      g.fillStyle = 'rgba(255,255,255,0.35)'; g.fillRect(0, 8, 128, 30);
      g.fillStyle = '#8fa2b5'; g.fillRect(0, 100, 128, 28);
      g.fillStyle = '#56636f'; g.fillRect(0, 0, 128, 4); g.fillRect(0, 98, 128, 3);
      g.fillRect(0, 0, 3, 128); g.fillRect(62, 0, 4, 128); g.fillRect(125, 0, 3, 128);
    }),
    // 2 brick with a window
    make((g) => {
      g.fillStyle = '#c9c9c9'; g.fillRect(0, 0, 128, 128);
      for (let row = 0; row < 16; row++) for (let col = -1; col < 4; col++) {
        const v = 225 + ((row * 7 + col * 13) % 5) * 7;
        g.fillStyle = `rgb(${v},${v},${v})`;
        g.fillRect(col * 32 + (row % 2) * 16 + 1, row * 8 + 1, 30, 6);
      }
      win(g, 38, 32, 52, 60);
    }),
    // 3 apartment bay with balcony
    make((g) => {
      g.fillStyle = '#e9e9e9'; g.fillRect(0, 0, 128, 5);
      g.fillStyle = '#f6f6f6'; g.fillRect(22, 22, 84, 84);
      glass(g, 26, 26, 76, 80);
      g.fillStyle = '#f6f6f6'; g.fillRect(62, 26, 4, 80);
      g.fillStyle = '#b9b9b9'; g.fillRect(8, 104, 112, 8);
      g.fillStyle = '#6d7379';
      g.fillRect(8, 72, 112, 3);
      for (let x = 10; x < 120; x += 9) g.fillRect(x, 72, 2, 32);
    }),
    // 4 ribbon windows
    make((g) => {
      g.fillStyle = '#ececec'; g.fillRect(0, 0, 128, 28);
      glass(g, 0, 30, 128, 56);
      g.fillStyle = '#39444f';
      for (let x = 0; x < 128; x += 32) g.fillRect(x, 30, 3, 56);
      g.fillStyle = '#d9d9d9'; g.fillRect(0, 86, 128, 4);
    }),
    // 5 corrugated industrial cladding
    make((g) => {
      for (let x = 0; x < 128; x += 8) { g.fillStyle = (x / 8) % 2 ? '#e2e2e2' : '#f7f7f7'; g.fillRect(x, 0, 8, 128); }
      g.fillStyle = '#d0d0d0'; g.fillRect(0, 0, 128, 4);
      glass(g, 40, 18, 48, 22);
    }),
    // 6 ground-floor shopfront
    make((g) => {
      g.fillStyle = '#f2f2f2'; g.fillRect(0, 0, 128, 24);
      g.fillStyle = '#d5d5d5'; g.fillRect(8, 6, 112, 12);
      for (let x = 0; x < 128; x += 16) { g.fillStyle = (x / 16) % 2 ? '#b9463a' : '#e9e2d6'; g.fillRect(x, 24, 16, 14); }
      g.fillStyle = '#8c8c8c'; g.fillRect(0, 112, 128, 16);
      glass(g, 6, 42, 74, 70);
      g.fillStyle = '#3a4550'; g.fillRect(86, 42, 36, 86);
      glass(g, 90, 46, 28, 60);
      g.fillStyle = '#d9d9d9'; g.fillRect(80, 38, 4, 90);
    }),
  ];
}

export class World {
  constructor(scene) {
    this.scene = scene;
    this.tiles = new Map();
    this.gen = 0;
    this.infill = true;
    this.urlTemplate = null;
    this.origin = { ox: 0.5, oy: 0.5, S: EARTH };
    this.tileMeters = EARTH / N_TILES;
    this.jobs = new Map();
    this.queue = [];
    this.jobId = 0;
    this.stamp = 1;
    this.lastError = '';

    const flat = { vertexColors: true, side: THREE.DoubleSide, depthTest: false, depthWrite: false };
    this.mat = {
      land: new THREE.MeshBasicMaterial(flat),
      roads: new THREE.MeshBasicMaterial(flat),
      walls: facadeTextures().map(({ map, glow }) => new THREE.MeshLambertMaterial({ vertexColors: true, map, emissive: 0xffffff, emissiveMap: glow, emissiveIntensity: 0 })),
      roofs: new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.DoubleSide }),
      tree: new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true }),
    };
    // One low-poly tree (trunk + canopy) about 1 unit wide; instances scale it up.
    const tint = (geo, r, g, b) => {
      const n = geo.attributes.position.count, c = new Float32Array(n * 3);
      for (let i = 0; i < n; i++) c.set([r, g, b], i * 3);
      geo.setAttribute('color', new THREE.BufferAttribute(c, 3));
      geo.deleteAttribute('uv');
      return geo;
    };
    const trunk = tint(new THREE.CylinderGeometry(0.05, 0.08, 1, 4, 1, true).translate(0, 0.5, 0).toNonIndexed(), 0.45, 0.3, 0.2);
    const canopy = tint(new THREE.IcosahedronGeometry(0.55, 0).scale(1, 1.15, 1).translate(0, 1.35, 0), 1, 1, 1);
    this.treeGeo = mergeGeometries([trunk, canopy]);
    this.bushGeo = tint(new THREE.IcosahedronGeometry(0.5, 0).scale(1, 0.62, 1).translate(0, 0.24, 0), 1, 1, 1);

    this.workers = [];
    for (let i = 0; i < WORKERS; i++) {
      const w = new Worker(new URL('./tileWorker.js', import.meta.url), { type: 'module' });
      w.busy = false;
      w.onmessage = (e) => this.onWorker(w, e.data);
      w.onerror = (e) => { this.lastError = e.message || 'worker error'; w.busy = false; };
      this.workers.push(w);
    }
  }

  async init() {
    const res = await fetch(TILEJSON);
    if (!res.ok) throw new Error(`Map server returned ${res.status}`);
    const json = await res.json();
    this.urlTemplate = json.tiles[0];
  }

  // ---------------------------------------------------------------- origin

  setOrigin(lon, lat) {
    const [ox, oy] = lonLatToMerc(lon, lat);
    this.origin = { ox, oy, S: EARTH * Math.cos((lat * Math.PI) / 180) };
    this.tileMeters = this.origin.S / N_TILES;
    this.clear();
  }

  // Shift the origin to world point (x, z) without rebuilding anything.
  rebase(x, z) {
    this.origin.ox += x / this.origin.S;
    this.origin.oy += z / this.origin.S;
    for (const t of this.tiles.values()) this.placeTile(t);
  }

  toLonLat(x, z) {
    return mercToLonLat(this.origin.ox + x / this.origin.S, this.origin.oy + z / this.origin.S);
  }
  toMerc(x, z) {
    return [this.origin.ox + x / this.origin.S, this.origin.oy + z / this.origin.S];
  }
  fromMerc(mx, my) {
    return [(mx - this.origin.ox) * this.origin.S, (my - this.origin.oy) * this.origin.S];
  }

  clear() {
    this.gen++;
    for (const t of this.tiles.values()) this.disposeTile(t);
    this.tiles.clear();
    this.queue.length = 0;
  }

  setInfill(on) {
    if (on === this.infill) return;
    this.infill = on;
    this.clear();
  }

  // ---------------------------------------------------------------- streaming

  get pending() {
    let n = 0;
    for (const t of this.tiles.values()) if (!t.data && !t.failed) n++;
    return n;
  }

  update(x, z) {
    if (!this.urlTemplate) return;
    const { ox, oy, S } = this.origin;
    const ptx = Math.floor((ox + x / S) * N_TILES), pty = Math.floor((oy + z / S) * N_TILES);
    this.center = [ptx, pty];
    for (let dy = -LOAD_RING; dy <= LOAD_RING; dy++) {
      for (let dx = -LOAD_RING; dx <= LOAD_RING; dx++) {
        const tx = ptx + dx, ty = pty + dy;
        if (ty < 0 || ty >= N_TILES) continue;
        const key = `${tx}/${ty}`;
        if (this.tiles.has(key)) continue;
        const t = { key, tx, ty, data: null, group: null, failed: false, gen: this.gen };
        this.placeTile(t);
        this.tiles.set(key, t);
        this.queue.push(t);
      }
    }
    for (const t of this.tiles.values()) {
      const ring = Math.max(Math.abs(t.tx - ptx), Math.abs(t.ty - pty));
      if (ring > KEEP_RING) {
        this.disposeTile(t);
        this.tiles.delete(t.key);
      } else if (t.group) {
        t.group.visible = ring <= LOAD_RING; // farther tiles are fully hidden by fog
      }
    }
    this.pump();
  }

  pump() {
    if (!this.queue.length) return;
    const [cx, cy] = this.center;
    for (const w of this.workers) {
      if (w.busy) continue;
      this.queue = this.queue.filter((t) => this.tiles.get(t.key) === t);
      if (!this.queue.length) return;
      this.queue.sort((a, b) => Math.hypot(a.tx - cx, a.ty - cy) - Math.hypot(b.tx - cx, b.ty - cy));
      const t = this.queue.shift();
      const wrapped = ((t.tx % N_TILES) + N_TILES) % N_TILES;
      const id = ++this.jobId;
      this.jobs.set(id, t);
      w.busy = true;
      w.postMessage({
        id, tx: t.tx, ty: t.ty, tileMeters: this.tileMeters, infill: this.infill,
        url: this.urlTemplate.replace('{z}', Z).replace('{x}', wrapped).replace('{y}', t.ty),
      });
    }
  }

  onWorker(w, msg) {
    w.busy = false;
    const t = this.jobs.get(msg.id);
    this.jobs.delete(msg.id);
    if (t && this.tiles.get(t.key) === t && t.gen === this.gen) {
      if (msg.ok) this.buildTile(t, msg.data);
      else { t.failed = true; this.lastError = msg.error; }
    }
    this.pump();
  }

  placeTile(t) {
    const { ox, oy, S } = this.origin;
    t.wx = (t.tx / N_TILES - ox) * S;
    t.wz = (t.ty / N_TILES - oy) * S;
    if (t.group) t.group.position.set(t.wx, 0, t.wz);
  }

  buildTile(t, d) {
    const group = new THREE.Group();
    const mesh = (part, mat, attrs, order) => {
      if (!part.index.length) return;
      const g = new THREE.BufferGeometry();
      for (const [name, size] of attrs) g.setAttribute(name, new THREE.BufferAttribute(part[name], size));
      g.setIndex(new THREE.BufferAttribute(part.index, 1));
      g.computeBoundingSphere();
      const m = new THREE.Mesh(g, mat);
      m.renderOrder = order;
      m.matrixAutoUpdate = false;
      group.add(m);
    };
    const pc = [['position', 3], ['color', 3]];
    mesh(d.land, this.mat.land, pc, -20);
    mesh(d.roads, this.mat.roads, pc, -10);
    d.walls.forEach((w, i) => mesh(w, this.mat.walls[i], [['position', 3], ['normal', 3], ['uv', 2], ['color', 3]], 0));
    mesh(d.roofs, this.mat.roofs, pc, 0);

    const n = d.trees.length / TREE_STRIDE;
    if (n) {
      const trees = new THREE.InstancedMesh(this.treeGeo, this.mat.tree, n);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
      for (let i = 0; i < n; i++) {
        const o = i * TREE_STRIDE;
        const sc = d.trees[o + 2] * 4.2, tint = d.trees[o + 3];
        q.setFromAxisAngle(up, tint * 6.283);
        m.compose(p.set(d.trees[o], 0, d.trees[o + 1]), q, s.set(sc, sc * (0.85 + tint * 0.4), sc));
        trees.setMatrixAt(i, m);
        trees.setColorAt(i, col.setHSL(0.26 + tint * 0.1, 0.45 + tint * 0.2, 0.3 + tint * 0.12));
      }
      trees.computeBoundingSphere();
      group.add(trees);
    }

    const nb = d.bushes.length / TREE_STRIDE;
    if (nb) {
      const bushes = new THREE.InstancedMesh(this.bushGeo, this.mat.tree, nb);
      const m = new THREE.Matrix4(), q = new THREE.Quaternion(), p = new THREE.Vector3(), s = new THREE.Vector3();
      const up = new THREE.Vector3(0, 1, 0), col = new THREE.Color();
      for (let i = 0; i < nb; i++) {
        const o = i * TREE_STRIDE;
        const sc = d.bushes[o + 2] * 1.9, tint = d.bushes[o + 3];
        q.setFromAxisAngle(up, tint * 6.283);
        m.compose(p.set(d.bushes[o], 0, d.bushes[o + 1]), q, s.set(sc, sc * (0.8 + tint * 0.5), sc));
        bushes.setMatrixAt(i, m);
        bushes.setColorAt(i, col.setHSL(0.24 + tint * 0.1, 0.4 + tint * 0.2, 0.22 + tint * 0.1));
      }
      bushes.computeBoundingSphere();
      group.add(bushes);
    }

    group.position.set(t.wx, 0, t.wz);
    group.updateMatrixWorld(true);
    this.scene.add(group);
    t.group = group;
    t.data = d;
    t.segStamp = new Uint32Array(d.segs.length / SEG_STRIDE);
  }

  disposeTile(t) {
    if (!t.group) return;
    this.scene.remove(t.group);
    t.group.traverse((o) => {
      if (o.isInstancedMesh) o.dispose();
      else if (o.geometry) o.geometry.dispose();
    });
    t.group = null;
    t.data = null;
  }

  // ---------------------------------------------------------------- queries

  // Calls fn(tile, localX, localZ) for every loaded tile whose padded area contains (x, z).
  tilesAt(x, z, fn) {
    const { ox, oy, S } = this.origin;
    const tx = Math.floor((ox + x / S) * N_TILES), ty = Math.floor((oy + z / S) * N_TILES);
    const tm = this.tileMeters;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const t = this.tiles.get(`${tx + dx}/${ty + dy}`);
        if (!t || !t.data) continue;
        const lx = x - t.wx, lz = z - t.wz;
        if (lx < -PAD || lz < -PAD || lx > tm + PAD || lz > tm + PAD) continue;
        fn(t, lx, lz);
      }
    }
  }

  static cell(grid, lx, lz) {
    const c = (v) => Math.min(grid.N - 1, Math.max(0, Math.floor((v + PAD) / CELL)));
    return c(lz) * grid.N + c(lx);
  }

  isLoadedAt(x, z) {
    let ok = false;
    const tm = this.tileMeters;
    this.tilesAt(x, z, (t, lx, lz) => { if (lx >= 0 && lz >= 0 && lx < tm && lz < tm) ok = true; });
    return ok;
  }

  // Distance to the nearest road edge at (x, z); <= 0 means on a road.
  roadClearance(x, z) {
    let best = Infinity;
    this.tilesAt(x, z, (t, lx, lz) => {
      const d = t.data, g = d.segGrid, c = World.cell(g, lx, lz), segs = d.segs;
      for (let j = g.start[c]; j < g.start[c + 1]; j++) {
        const o = g.items[j] * SEG_STRIDE;
        if (segs[o + 5] === KIND_RAIL) continue;
        const ax = segs[o], az = segs[o + 1], dx = segs[o + 2] - ax, dz = segs[o + 3] - az;
        const l2 = dx * dx + dz * dz;
        const u = l2 > 0 ? Math.min(1, Math.max(0, ((lx - ax) * dx + (lz - az) * dz) / l2)) : 0;
        const dist = Math.hypot(lx - ax - dx * u, lz - az - dz * u) - segs[o + 4];
        if (dist < best) best = dist;
      }
    });
    return best;
  }

  nameAt(x, z) {
    let best = 18, name = '';
    this.tilesAt(x, z, (t, lx, lz) => {
      const d = t.data, g = d.nameGrid, c = World.cell(g, lx, lz), segs = d.nameSegs;
      for (let j = g.start[c]; j < g.start[c + 1]; j++) {
        const o = g.items[j] * NAME_STRIDE;
        const ax = segs[o], az = segs[o + 1], dx = segs[o + 2] - ax, dz = segs[o + 3] - az;
        const l2 = dx * dx + dz * dz;
        const u = l2 > 0 ? Math.min(1, Math.max(0, ((lx - ax) * dx + (lz - az) * dz) / l2)) : 0;
        const dist = Math.hypot(lx - ax - dx * u, lz - az - dz * u);
        if (dist < best) { best = dist; name = d.names[segs[o + 4]]; }
      }
    });
    return name;
  }

  // Nearest drivable road point to (x, z) among loaded tiles: { x, z, heading } or null.
  nearestRoad(x, z) {
    let best = Infinity, out = null;
    for (const t of this.tiles.values()) {
      if (!t.data) continue;
      const segs = t.data.segs, lx = x - t.wx, lz = z - t.wz;
      for (let o = 0; o < segs.length; o += SEG_STRIDE) {
        if (segs[o + 5] !== KIND_ROAD || segs[o + 4] < 1.5) continue;
        const ax = segs[o], az = segs[o + 1], dx = segs[o + 2] - ax, dz = segs[o + 3] - az;
        const l2 = dx * dx + dz * dz;
        if (l2 < 1) continue;
        const u = Math.min(1, Math.max(0, ((lx - ax) * dx + (lz - az) * dz) / l2));
        const px = ax + dx * u, pz = az + dz * u;
        const dist = Math.hypot(lx - px, lz - pz);
        if (dist < best) { best = dist; out = { x: px + t.wx, z: pz + t.wz, heading: Math.atan2(dx, -dz) }; }
      }
    }
    return out;
  }

  // Push a circle out of any building it overlaps. Returns { x, z, hit, nx, nz }.
  resolveCircle(x, z, r) {
    const res = { x, z, hit: false, nx: 0, nz: 0 };
    this.tilesAt(x, z, (t) => {
      const d = t.data, g = d.bldGrid;
      let lx = res.x - t.wx, lz = res.z - t.wz;
      const c = World.cell(g, lx, lz);
      for (let j = g.start[c]; j < g.start[c + 1]; j++) {
        const b = g.items[j], bb = b * 4;
        if (lx < d.bldBox[bb] - r || lx > d.bldBox[bb + 2] + r || lz < d.bldBox[bb + 1] - r || lz > d.bldBox[bb + 3] + r) continue;
        const s = d.bldOff[b], e = d.bldOff[b + 1], pts = d.bldPts;
        let inside = false, bestD = Infinity, cx = 0, cz = 0;
        for (let i = s, k = e - 1; i < e; k = i++) {
          const ax = pts[i * 2], az = pts[i * 2 + 1], bx = pts[k * 2], bz = pts[k * 2 + 1];
          if ((az > lz) !== (bz > lz) && lx < ((bx - ax) * (lz - az)) / (bz - az) + ax) inside = !inside;
          const dx = bx - ax, dz = bz - az, l2 = dx * dx + dz * dz;
          const u = l2 > 0 ? Math.min(1, Math.max(0, ((lx - ax) * dx + (lz - az) * dz) / l2)) : 0;
          const px = ax + dx * u, pz = az + dz * u;
          const dist = Math.hypot(lx - px, lz - pz);
          if (dist < bestD) { bestD = dist; cx = px; cz = pz; }
        }
        if (!inside && bestD >= r) continue;
        let nx = lx - cx, nz = lz - cz;
        const len = Math.hypot(nx, nz) || 1;
        nx /= len; nz /= len;
        if (inside) { nx = -nx; nz = -nz; }
        lx = cx + nx * r; lz = cz + nz * r;
        res.x = lx + t.wx; res.z = lz + t.wz;
        res.hit = true; res.nx = nx; res.nz = nz;
      }
    });
    return res;
  }

  // Calls fn(x1, z1, x2, z2, halfWidth, kind) once for each road segment near (x, z).
  segsNear(x, z, radius, fn) {
    const stamp = ++this.stamp;
    const tm = this.tileMeters;
    for (const t of this.tiles.values()) {
      if (!t.data) continue;
      const lx = x - t.wx, lz = z - t.wz;
      if (lx < -radius || lz < -radius || lx > tm + radius || lz > tm + radius) continue;
      const g = t.data.segGrid, segs = t.data.segs;
      const c = (v) => Math.min(g.N - 1, Math.max(0, Math.floor((v + PAD) / CELL)));
      const x0 = c(lx - radius), x1 = c(lx + radius), z0 = c(lz - radius), z1 = c(lz + radius);
      for (let cz = z0; cz <= z1; cz++) {
        for (let cx = x0; cx <= x1; cx++) {
          const ci = cz * g.N + cx;
          for (let j = g.start[ci]; j < g.start[ci + 1]; j++) {
            const s = g.items[j];
            if (t.segStamp[s] === stamp) continue;
            t.segStamp[s] = stamp;
            const o = s * SEG_STRIDE;
            fn(segs[o] + t.wx, segs[o + 1] + t.wz, segs[o + 2] + t.wx, segs[o + 3] + t.wz, segs[o + 4], segs[o + 5]);
          }
        }
      }
    }
  }

  stats() {
    const s = { tiles: 0, mapped: 0, guessed: 0, trees: 0, bushes: 0, labels: 0 };
    for (const t of this.tiles.values()) {
      if (!t.data) continue;
      s.tiles++;
      s.mapped += t.data.stats.mapped;
      s.guessed += t.data.stats.guessed;
      s.trees += t.data.stats.trees;
      s.bushes += t.data.stats.bushes;
      s.labels += t.data.stats.labels;
    }
    return s;
  }
}

export { KIND_ROAD, KIND_PATH, KIND_RAIL };
