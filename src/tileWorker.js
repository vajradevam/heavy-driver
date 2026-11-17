// Tile worker: fetches one OpenStreetMap vector tile and turns it into 3D geometry
// (ground, water, roads, buildings, trees) plus collision / lookup data.
// All output coordinates are metres relative to the tile's north-west corner:
// x = east, z = south, y = up.
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
import earcut from 'earcut';
import {
  CELL, PAD, KIND_ROAD, KIND_PATH, KIND_RAIL, KIND_RUNWAY,
  SEG_STRIDE, NAME_STRIDE, TREE_STRIDE,
} from './shared.js';

const E = 4096; // tile extent in tile units

self.onmessage = async (e) => {
  const job = e.data;
  try {
    const res = await fetch(job.url);
    let tile = null;
    if (res.ok) {
      const buf = new Uint8Array(await res.arrayBuffer());
      if (buf.length) tile = new VectorTile(new PbfReader(buf));
    } else if (res.status !== 404 && res.status !== 204) {
      throw new Error(`tile HTTP ${res.status}`);
    }
    const { data, transfer } = build(tile, job);
    self.postMessage({ id: job.id, ok: true, data }, transfer);
  } catch (err) {
    self.postMessage({ id: job.id, ok: false, error: String(err) });
  }
};

// ---------------------------------------------------------------- utilities

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const srgb = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const hex = (h) => [srgb(((h >> 16) & 255) / 255), srgb(((h >> 8) & 255) / 255), srgb((h & 255) / 255)];
const shade = (c, f) => [c[0] * f, c[1] * f, c[2] * f];

class Flat {
  constructor() { this.p = []; this.c = []; this.i = []; this.n = 0; }
  v(x, y, z, col) { this.p.push(x, y, z); this.c.push(col[0], col[1], col[2]); return this.n++; }
  tri(a, b, c) { this.i.push(a, b, c); }
  out(transfer) {
    const o = {
      position: new Float32Array(this.p),
      color: new Float32Array(this.c),
      index: new Uint32Array(this.i),
    };
    transfer.push(o.position.buffer, o.color.buffer, o.index.buffer);
    return o;
  }
}

class Walls {
  constructor() { this.p = []; this.nrm = []; this.uv = []; this.c = []; this.i = []; this.n = 0; }
  out(transfer) {
    const o = {
      position: new Float32Array(this.p),
      normal: new Float32Array(this.nrm),
      uv: new Float32Array(this.uv),
      color: new Float32Array(this.c),
      index: new Uint32Array(this.i),
    };
    transfer.push(o.position.buffer, o.normal.buffer, o.uv.buffer, o.color.buffer, o.index.buffer);
    return o;
  }
}

function ringArea(pts) {
  let a = 0;
  for (let i = 0, n = pts.length; i < n; i++) {
    const p = pts[i], q = pts[(i + 1) % n];
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

function bboxOf(pts) {
  let x0 = Infinity, z0 = Infinity, x1 = -Infinity, z1 = -Infinity;
  for (const p of pts) {
    if (p[0] < x0) x0 = p[0];
    if (p[0] > x1) x1 = p[0];
    if (p[1] < z0) z0 = p[1];
    if (p[1] > z1) z1 = p[1];
  }
  return [x0, z0, x1, z1];
}

// MVT polygons: outer rings have positive area (in tile coords), holes negative.
function readPolygons(feature, k) {
  const polys = [];
  let cur = null;
  for (const ring of feature.loadGeometry()) {
    const pts = [];
    for (const p of ring) {
      const x = p.x * k, z = p.y * k;
      const last = pts[pts.length - 1];
      if (!last || last[0] !== x || last[1] !== z) pts.push([x, z]);
    }
    if (pts.length > 1 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1]) pts.pop();
    if (pts.length < 3) continue;
    const a = ringArea(pts);
    if (Math.abs(a) < 1e-6) continue;
    if (a > 0 || !cur) {
      if (a < 0) pts.reverse();
      cur = { outer: pts, holes: [], bbox: bboxOf(pts), area: Math.abs(a) };
      polys.push(cur);
    } else {
      cur.holes.push(pts);
      cur.area -= Math.abs(a);
    }
  }
  return polys;
}

function inRing(pts, x, z) {
  let inside = false;
  for (let i = 0, n = pts.length, j = n - 1; i < n; j = i++) {
    const a = pts[i], b = pts[j];
    if ((a[1] > z) !== (b[1] > z) && x < ((b[0] - a[0]) * (z - a[1])) / (b[1] - a[1]) + a[0]) inside = !inside;
  }
  return inside;
}

function inPoly(poly, x, z) {
  const b = poly.bbox;
  if (x < b[0] || x > b[2] || z < b[1] || z > b[3]) return false;
  if (!inRing(poly.outer, x, z)) return false;
  for (const h of poly.holes) if (inRing(h, x, z)) return false;
  return true;
}

// Clip a polyline (tile units) to the tile box; returns an array of polylines.
function clipLine(line, lo, hi) {
  const out = [];
  let cur = null;
  for (let i = 0; i + 1 < line.length; i++) {
    const ax = line[i].x, ay = line[i].y, bx = line[i + 1].x, by = line[i + 1].y;
    const dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1, ok = true;
    const edges = [[-dx, ax - lo], [dx, hi - ax], [-dy, ay - lo], [dy, hi - ay]];
    for (const [p, q] of edges) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const r = q / p;
      if (p < 0) { if (r > t1) { ok = false; break; } if (r > t0) t0 = r; }
      else { if (r < t0) { ok = false; break; } if (r < t1) t1 = r; }
    }
    if (!ok || t0 >= t1) { cur = null; continue; }
    const s = [ax + dx * t0, ay + dy * t0], e = [ax + dx * t1, ay + dy * t1];
    if (!cur || t0 > 0) { cur = [s]; out.push(cur); }
    cur.push(e);
    if (t1 < 1) cur = null;
  }
  return out;
}

function toMetres(line, k) {
  const pts = [];
  for (const p of line) {
    const x = p[0] * k, z = p[1] * k;
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(last[0] - x, last[1] - z) > 0.05) pts.push([x, z]);
  }
  return pts;
}

// Uniform grid in CSR form: start[cell]..start[cell+1] index into items.
function makeGrid(count, bbox, size) {
  const N = Math.ceil((size + 2 * PAD) / CELL);
  const cell = (v) => Math.min(N - 1, Math.max(0, Math.floor((v + PAD) / CELL)));
  const ranges = new Int32Array(count * 4);
  const start = new Uint32Array(N * N + 1);
  for (let i = 0; i < count; i++) {
    const b = bbox(i);
    const x0 = cell(b[0]), z0 = cell(b[1]), x1 = cell(b[2]), z1 = cell(b[3]);
    ranges.set([x0, z0, x1, z1], i * 4);
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) start[z * N + x + 1]++;
  }
  for (let i = 0; i < N * N; i++) start[i + 1] += start[i];
  const fill = start.slice(0, N * N);
  const items = new Uint32Array(start[N * N]);
  for (let i = 0; i < count; i++) {
    const x0 = ranges[i * 4], z0 = ranges[i * 4 + 1], x1 = ranges[i * 4 + 2], z1 = ranges[i * 4 + 3];
    for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) items[fill[z * N + x]++] = i;
  }
  return { N, start, items, cell };
}

// ---------------------------------------------------------------- geometry

function flatPolygon(acc, poly, y, col) {
  const flat = [];
  const holes = [];
  for (const p of poly.outer) flat.push(p[0], p[1]);
  for (const h of poly.holes) {
    holes.push(flat.length / 2);
    for (const p of h) flat.push(p[0], p[1]);
  }
  const tris = earcut(flat, holes.length ? holes : undefined, 2);
  if (!tris.length) return;
  const base = acc.n;
  for (let i = 0; i < flat.length; i += 2) acc.v(flat[i], y, flat[i + 1], col);
  for (let i = 0; i < tris.length; i += 3) acc.tri(base + tris[i], base + tris[i + 1], base + tris[i + 2]);
}

function ribbon(acc, pts, hw, y, col) {
  const n = pts.length;
  if (n < 2) return;
  let pl = 0, pr = 0;
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    let ax, az, bx, bz;
    if (i > 0) { ax = p[0] - pts[i - 1][0]; az = p[1] - pts[i - 1][1]; const l = Math.hypot(ax, az) || 1; ax /= l; az /= l; }
    if (i < n - 1) { bx = pts[i + 1][0] - p[0]; bz = pts[i + 1][1] - p[1]; const l = Math.hypot(bx, bz) || 1; bx /= l; bz /= l; }
    if (i === 0) { ax = bx; az = bz; }
    if (i === n - 1) { bx = ax; bz = az; }
    let mx = -az - bz, mz = ax + bx;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { mx = -az; mz = ax; } else { mx /= ml; mz /= ml; }
    const s = hw / Math.max(mx * -az + mz * ax, 0.5);
    const l = acc.v(p[0] + mx * s, y, p[1] + mz * s, col);
    const r = acc.v(p[0] - mx * s, y, p[1] - mz * s, col);
    if (i > 0) { acc.tri(pl, pr, r); acc.tri(pl, r, l); }
    pl = l; pr = r;
  }
}

// A copy of the polyline shifted sideways by `off` metres (positive = left of travel).
function offsetLine(pts, off) {
  const n = pts.length, out = [];
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    let ax, az, bx, bz;
    if (i > 0) { ax = p[0] - pts[i - 1][0]; az = p[1] - pts[i - 1][1]; const l = Math.hypot(ax, az) || 1; ax /= l; az /= l; }
    if (i < n - 1) { bx = pts[i + 1][0] - p[0]; bz = pts[i + 1][1] - p[1]; const l = Math.hypot(bx, bz) || 1; bx /= l; bz /= l; }
    if (i === 0) { ax = bx; az = bz; }
    if (i === n - 1) { bx = ax; bz = az; }
    let mx = -az - bz, mz = ax + bx;
    const ml = Math.hypot(mx, mz);
    if (ml < 1e-6) { mx = -az; mz = ax; } else { mx /= ml; mz /= ml; }
    const s = off / Math.max(mx * -az + mz * ax, 0.5);
    out.push([p[0] + mx * s, p[1] + mz * s]);
  }
  return out;
}

function disc(acc, x, z, r, y, col) {
  const c = acc.v(x, y, z, col);
  const S = 10;
  let prev = acc.v(x + r, y, z, col);
  for (let i = 1; i <= S; i++) {
    const a = (i / S) * Math.PI * 2;
    const v = acc.v(x + Math.cos(a) * r, y, z + Math.sin(a) * r, col);
    acc.tri(c, prev, v);
    prev = v;
  }
}

function dashes(acc, pts, hw, y, col, on, off) {
  let phase = 0; // distance into the current on+off period
  const period = on + off;
  for (let i = 0; i + 1 < pts.length; i++) {
    const a = pts[i], b = pts[i + 1];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 1e-3) continue;
    const ux = dx / len, uz = dz / len, nx = -uz * hw, nz = ux * hw;
    let s = -phase;
    while (s < len) {
      const s0 = Math.max(s, 0), s1 = Math.min(s + on, len);
      if (s1 - s0 > 0.2) {
        const x0 = a[0] + ux * s0, z0 = a[1] + uz * s0, x1 = a[0] + ux * s1, z1 = a[1] + uz * s1;
        const v0 = acc.v(x0 + nx, y, z0 + nz, col), v1 = acc.v(x0 - nx, y, z0 - nz, col);
        const v2 = acc.v(x1 - nx, y, z1 - nz, col), v3 = acc.v(x1 + nx, y, z1 + nz, col);
        acc.tri(v0, v1, v2); acc.tri(v0, v2, v3);
      }
      s += period;
    }
    phase = (phase + len) % period;
  }
}

// Extrude one ring into walls. Rings must be normalised: outer area > 0, holes < 0.
function wallRing(w, ring, y0, y1, col, v0, v1) {
  let u = 0;
  for (let i = 0, n = ring.length; i < n; i++) {
    const a = ring[i], b = ring[(i + 1) % n];
    const dx = b[0] - a[0], dz = b[1] - a[1];
    const len = Math.hypot(dx, dz);
    if (len < 0.01) continue;
    const nx = dz / len, nz = -dx / len;
    const u0 = u / 3, u1 = (u + len) / 3;
    u += len;
    const base = w.n;
    // order: b-bottom, a-bottom, a-top, b-top  => front face points along (nx, nz)
    w.p.push(b[0], y0, b[1], a[0], y0, a[1], a[0], y1, a[1], b[0], y1, b[1]);
    w.uv.push(u1, v0, u0, v0, u0, v1, u1, v1);
    for (let j = 0; j < 4; j++) { w.nrm.push(nx, 0, nz); w.c.push(col[0], col[1], col[2]); }
    w.i.push(base, base + 1, base + 2, base, base + 2, base + 3);
    w.n += 4;
  }
}

// Baked sunlight for roof faces (roofs use an unlit material).
const SUN = (() => { const l = Math.hypot(-0.5, 1, 0.35); return [-0.5 / l, 1 / l, 0.35 / l]; })();
function litFace(acc, pts, col) {
  const [a, b, c] = pts;
  const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2], vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
  let nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
  const l = Math.hypot(nx, ny, nz) || 1;
  if (ny < 0) { nx = -nx; ny = -ny; nz = -nz; }
  const lit = shade(col, 0.55 + 0.5 * Math.max(0, (nx * SUN[0] + ny * SUN[1] + nz * SUN[2]) / l));
  const base = acc.n;
  for (const p of pts) acc.v(p[0], p[1], p[2], lit);
  for (let i = 1; i + 1 < pts.length; i++) acc.tri(base, base + i, base + i + 1);
}

// Gable / hip roof over a 4-corner footprint. hip = 0 gives a gable, up to ~0.8 a hip roof.
function pitchedRoof(acc, ring, y, col, hip) {
  let q = ring;
  const len = (a, b) => Math.hypot(b[0] - a[0], b[1] - a[1]);
  if (len(q[0], q[1]) < len(q[1], q[2])) q = [q[1], q[2], q[3], q[0]];
  const short = len(q[1], q[2]), rise = Math.min(4, short * 0.42);
  const mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  let A = mid(q[3], q[0]), B = mid(q[1], q[2]);
  const inset = Math.min(0.45, (hip * short) / 2 / Math.max(1, len(A, B)));
  const A2 = [A[0] + (B[0] - A[0]) * inset, A[1] + (B[1] - A[1]) * inset];
  const B2 = [B[0] + (A[0] - B[0]) * inset, B[1] + (A[1] - B[1]) * inset];
  A = A2; B = B2;
  const P = (p, h) => [p[0], y + h, p[1]];
  litFace(acc, [P(q[0], 0), P(q[1], 0), P(B, rise), P(A, rise)], col);
  litFace(acc, [P(q[2], 0), P(q[3], 0), P(A, rise), P(B, rise)], col);
  litFace(acc, [P(q[1], 0), P(q[2], 0), P(B, rise)], col);
  litFace(acc, [P(q[3], 0), P(q[0], 0), P(A, rise)], col);
}

// ---------------------------------------------------------------- styling

// Facade styles: one wall mesh (and texture) per style. Keep in sync with world.js.
const S_PLASTER = 0, S_GLASS = 1, S_BRICK = 2, S_BALCONY = 3, S_STRIP = 4, S_INDUSTRIAL = 5, S_SHOP = 6, STYLES = 7;

// Road classes. Lanes are [two-way, one-way]; total width = lanes * lane width + 2 * shoulder.
// The tiles carry no lane counts, so these are typical values per class.
const ROADS = {
  motorway: { lanes: [6, 3], lw: 3.7, sh: 2.4, rank: 9, edge: true, col: 0x303338 },
  trunk: { lanes: [4, 2], lw: 3.6, sh: 1.6, rank: 8, edge: true, col: 0x36393e },
  primary: { lanes: [4, 2], lw: 3.3, sh: 0.6, rank: 7, edge: true, col: 0x3d4045, walk: true },
  secondary: { lanes: [2, 2], lw: 3.5, sh: 0.5, rank: 6, col: 0x45484d, walk: true },
  tertiary: { lanes: [2, 1], lw: 3.2, sh: 0.4, rank: 5, col: 0x4c4f54, walk: true },
  minor: { lanes: [0, 0], w: 5.2, rank: 4, col: 0x5a5d61, walk: true },
  busway: { lanes: [0, 0], w: 6, rank: 4, col: 0x5a5d61 },
  bus_guideway: { lanes: [0, 0], w: 6, rank: 4, col: 0x5a5d61 },
  raceway: { lanes: [2, 2], lw: 4.5, sh: 1, rank: 4, edge: true, col: 0x3d4045 },
  service: { lanes: [0, 0], w: 3.2, rank: 3, col: 0x66696c },
  track: { lanes: [0, 0], w: 2.6, rank: 2, dirt: true },
  path: { lanes: [0, 0], w: 1.6, rank: 1, kind: KIND_PATH },
  pier: { lanes: [0, 0], w: 2.5, rank: 1, kind: KIND_PATH },
  rail: { lanes: [0, 0], w: 3, rank: 0, kind: KIND_RAIL },
  transit: { lanes: [0, 0], w: 3, rank: 0, kind: KIND_RAIL },
};

const COL = {
  ground: hex(0xbdbf9d),
  centre: hex(0xe3b93c),
  dirt: hex(0x9a8565),
  path: hex(0xcfc7b4),
  sidewalk: hex(0xb4b0a6),
  rail: hex(0x6b6257),
  mark: hex(0xe9e6da),
  runway: hex(0x55585c),
  water: hex(0x4f8fc0),
  pedestrian: hex(0xc9c5bb),
};

const LANDUSE = {
  residential: 0xcfcbbb, suburb: 0xcfcbbb, quarter: 0xcfcbbb, neighbourhood: 0xcfcbbb,
  commercial: 0xd3c8c0, retail: 0xd6c6bd, industrial: 0xbdb9b4, garages: 0xbdb9b4,
  railway: 0xa9a59d, military: 0xb8b3a0, school: 0xd6d0b4, college: 0xd6d0b4, university: 0xd6d0b4,
  kindergarten: 0xd6d0b4, hospital: 0xdccfc6, library: 0xd6d0b4, bus_station: 0xb9b6ae,
  cemetery: 0x9fb894, stadium: 0xa8c48f, pitch: 0x7fb86a, playground: 0xa7cf8f, track: 0xb7936f,
  theme_park: 0xb5cf9a, zoo: 0xb5cf9a, dam: 0x9c9c98, quarry: 0xa9a294,
};
const BUILDABLE = new Set(['residential', 'suburb', 'quarter', 'neighbourhood', 'commercial', 'retail', 'industrial', 'garages']);

// landcover class -> [colour, m² per tree (0 = none), tree scale]
const LANDCOVER = {
  wood: [0x4f8a4a, 36, 1.25],
  grass: [0x8fc46f, 420, 0.9],
  farmland: [0xc9c98a, 0, 0],
  wetland: [0x7fae9a, 1200, 0.7],
  sand: [0xe6d9a8, 0, 0],
  rock: [0x9d9a92, 0, 0],
  ice: [0xe8f1f5, 0, 0],
};
const GRASS_SUB = { park: 170, garden: 170, village_green: 200, recreation_ground: 400, scrub: 80, golf_course: 350, orchard: 50, vineyard: 0, meadow: 1500 };

const STYLE_COLORS = [
  [0xe8dfcf, 0xd9cdb8, 0xf0e6d2, 0xcfd6d0, 0xe6c9a8, 0xd8c2b0, 0xf2ead8, 0xc9d3dc, 0xe3d3c0, 0xf3d9b8],
  [0xa9c4d8, 0x8fb4c0, 0xc0d0dc, 0x86a6c2, 0x9fc0b8, 0xb8c8e0],
  [0xb5654a, 0xa0553f, 0xc27a5a, 0x8f5a48, 0xc9a98a, 0xb8846a],
  [0xe2ddd3, 0xd6cbb9, 0xcfd4d6, 0xe9dcc4, 0xd9c0aa, 0xc4cfc4],
  [0xe6e6e2, 0xd2d7da, 0xdccfb8, 0xc9d2d8, 0xeadfce],
  [0xb9c0c4, 0xa9b4a6, 0xc4b8a4, 0x9aa7b5, 0xcfc9bd],
  [0xf0ece4],
].map((list) => list.map(hex));
const PITCHED_ROOFS = [0xa5553f, 0x8f4a3a, 0xb86a4c, 0x6b6b70, 0x545a66, 0x7a5a48, 0x9a7b5c].map(hex);
const ROOFS = [0x8a8580, 0x9c938a, 0xa0705a, 0x77736f, 0xb09a84, 0x8c6f5e].map(hex);

const MAX_TREES = 12000;
const MAX_BUSHES = 5000;
const MAX_CANDIDATES = 90000;
const MAX_LABELS = 1400;
const MAX_GUESSED = 6000;

// ---------------------------------------------------------------- build

function build(tile, job) {
  const tm = job.tileMeters;
  const k = tm / E;
  const rng = mulberry32((job.tx * 73856093) ^ (job.ty * 19349663));
  const transfer = [];
  const land = new Flat(), road = new Flat(), roofs = new Flat();
  const wallsBy = Array.from({ length: STYLES }, () => new Walls());
  const L = (name) => (tile && tile.layers[name]) || null;
  const each = (name, fn) => {
    const layer = L(name);
    if (!layer) return;
    for (let i = 0; i < layer.length; i++) fn(layer.feature(i));
  };

  // --- ground base
  {
    const a = land.v(0, 0, 0, COL.ground), b = land.v(tm, 0, 0, COL.ground);
    const c = land.v(tm, 0, tm, COL.ground), d = land.v(0, 0, tm, COL.ground);
    land.tri(a, b, c); land.tri(a, c, d);
  }

  const noBuild = []; // polygons where guessed buildings must not go
  const urban = []; // polygons that mark built-up land
  const green = []; // [poly, m² per tree, scale]
  const waters = [];

  // --- landuse
  each('landuse', (f) => {
    if (f.type !== 3) return;
    const cls = f.properties.class;
    const col = LANDUSE[cls];
    for (const poly of readPolygons(f, k)) {
      if (col !== undefined) flatPolygon(land, poly, 0, hex(col));
      poly.cls = cls;
      if (BUILDABLE.has(cls)) urban.push(poly); else noBuild.push(poly);
      if (cls === 'cemetery') green.push([poly, 250, 0.9]);
      else if (cls === 'residential' || cls === 'suburb' || cls === 'neighbourhood' || cls === 'quarter') green.push([poly, 900, 0.85]);
      else if (cls === 'school' || cls === 'college' || cls === 'university' || cls === 'hospital') green.push([poly, 700, 0.9]);
    }
  });

  // --- landcover
  each('landcover', (f) => {
    if (f.type !== 3) return;
    const spec = LANDCOVER[f.properties.class];
    if (!spec) return;
    let per = spec[1], scale = spec[2];
    if (f.properties.class === 'grass') {
      const sub = GRASS_SUB[f.properties.subclass];
      if (sub !== undefined) per = sub;
      if (f.properties.subclass === 'scrub') scale = 0.5;
    }
    const col = hex(spec[0]);
    for (const poly of readPolygons(f, k)) {
      flatPolygon(land, poly, 0, col);
      noBuild.push(poly);
      if (per > 0) green.push([poly, per, scale]);
    }
  });

  // --- pedestrian areas (polygons in the transportation layer)
  each('transportation', (f) => {
    if (f.type !== 3 || f.properties.class === 'bridge') return;
    for (const poly of readPolygons(f, k)) { flatPolygon(land, poly, 0, COL.pedestrian); noBuild.push(poly); }
  });
  each('aeroway', (f) => {
    if (f.type !== 3) return;
    for (const poly of readPolygons(f, k)) { flatPolygon(land, poly, 0, hex(0xb0b0ac)); noBuild.push(poly); }
  });

  // --- water
  const WATERWAY = { river: 12, canal: 8, stream: 3, drain: 2, ditch: 1.5 };
  each('waterway', (f) => {
    if (f.type !== 2 || f.properties.brunnel === 'tunnel') return;
    const w = WATERWAY[f.properties.class];
    if (!w) return;
    for (const line of clipLine2(f, 0, E)) ribbon(land, toMetres(line, k), w / 2, 0, COL.water);
  });
  each('water', (f) => {
    if (f.type !== 3) return;
    for (const poly of readPolygons(f, k)) { flatPolygon(land, poly, 0, COL.water); noBuild.push(poly); waters.push(poly); }
  });

  // --- roads
  const roads = [];
  each('transportation', (f) => {
    if (f.type !== 2) return;
    const p = f.properties;
    let cls = p.class || '';
    let construction = false;
    if (cls.endsWith('_construction')) { cls = cls.slice(0, -13); construction = true; }
    const spec = ROADS[cls];
    if (!spec) return;
    const kind = spec.kind ?? KIND_ROAD;
    if (kind === KIND_RAIL && p.brunnel === 'tunnel') return;
    const oneway = !!p.oneway;
    let lanes = spec.lanes[oneway ? 1 : 0], hw;
    if (p.ramp && lanes) { lanes = 1; hw = (spec.lw + 1.6) / 2; }
    else hw = (lanes ? lanes * spec.lw + 2 * spec.sh : oneway ? spec.w * 0.85 : spec.w) / 2;
    let col = spec.col !== undefined ? hex(spec.col) : COL.dirt;
    if (kind === KIND_PATH) col = COL.path;
    else if (kind === KIND_RAIL) col = COL.rail;
    else if (spec.dirt || construction || p.surface === 'unpaved') col = COL.dirt;
    const marked = lanes > 0 && !construction && p.surface !== 'unpaved';
    for (const line of clipLine2(f, 0, E)) {
      const pts = toMetres(line, k);
      if (pts.length < 2) continue;
      roads.push({
        pts, hw, col, kind, cls, rank: spec.rank,
        brunnel: p.brunnel || '',
        lanes: marked ? lanes : 0, lw: spec.lw, oneway, edge: marked && !!spec.edge,
        walk: !!spec.walk && !p.brunnel && !construction,
      });
    }
  });
  each('aeroway', (f) => {
    if (f.type !== 2) return;
    const cls = f.properties.class;
    const w = cls === 'runway' ? 45 : cls === 'taxiway' ? 18 : 0;
    if (!w) return;
    for (const line of clipLine2(f, 0, E)) {
      const pts = toMetres(line, k);
      if (pts.length < 2) continue;
      roads.push({ pts, hw: w / 2, col: COL.runway, kind: KIND_RUNWAY, cls, rank: 3, brunnel: '', runway: cls === 'runway', lanes: 0, walk: false });
    }
  });
  roads.sort((a, b) => a.rank - b.rank);

  for (const r of roads) if (r.walk) ribbon(road, r.pts, r.hw + 1.6, 0, COL.sidewalk);
  for (const r of roads) {
    ribbon(road, r.pts, r.hw, 0, r.col);
    const a = r.pts[0], b = r.pts[r.pts.length - 1];
    const onEdge = (p) => p[0] < 0.01 || p[1] < 0.01 || p[0] > tm - 0.01 || p[1] > tm - 0.01;
    if (!onEdge(a)) disc(road, a[0], a[1], r.hw, 0, r.col);
    if (!onEdge(b)) disc(road, b[0], b[1], r.hw, 0, r.col);
  }
  for (const r of roads) {
    if (r.runway) dashes(road, r.pts, 0.45, 0, COL.mark, 30, 20);
    if (!r.lanes) continue;
    const half = (r.lanes * r.lw) / 2;
    if (r.edge) {
      ribbon(road, offsetLine(r.pts, half), 0.1, 0, COL.mark);
      ribbon(road, offsetLine(r.pts, -half), 0.1, 0, COL.mark);
    }
    for (let i = 1; i < r.lanes; i++) {
      const off = -half + i * r.lw;
      if (!r.oneway && i * 2 === r.lanes) {
        // centre line: double solid yellow on wide roads, dashed on two-lane roads
        if (r.lanes >= 4) {
          ribbon(road, offsetLine(r.pts, 0.16), 0.07, 0, COL.centre);
          ribbon(road, offsetLine(r.pts, -0.16), 0.07, 0, COL.centre);
        } else dashes(road, r.pts, 0.08, 0, COL.mark, 3, 4.5);
      } else dashes(road, offsetLine(r.pts, off), 0.07, 0, COL.mark, 3, 9);
    }
  }

  // --- road segments (collision, minimap, spawning) + grid
  let segCount = 0;
  for (const r of roads) segCount += r.pts.length - 1;
  const segs = new Float32Array(segCount * SEG_STRIDE);
  {
    let o = 0;
    for (const r of roads) {
      for (let i = 0; i + 1 < r.pts.length; i++) {
        segs[o++] = r.pts[i][0]; segs[o++] = r.pts[i][1];
        segs[o++] = r.pts[i + 1][0]; segs[o++] = r.pts[i + 1][1];
        segs[o++] = r.hw; segs[o++] = r.kind;
      }
    }
  }
  const segGrid = makeGrid(segCount, (i) => {
    const o = i * SEG_STRIDE, m = segs[o + 4] + 6;
    return [Math.min(segs[o], segs[o + 2]) - m, Math.min(segs[o + 1], segs[o + 3]) - m,
      Math.max(segs[o], segs[o + 2]) + m, Math.max(segs[o + 1], segs[o + 3]) + m];
  }, tm);

  // Distance from (x,z) to the nearest road edge (negative = on the road). Paths are ignored.
  const roadClearance = (x, z) => {
    const c = segGrid.cell(z) * segGrid.N + segGrid.cell(x);
    let best = 6;
    for (let j = segGrid.start[c]; j < segGrid.start[c + 1]; j++) {
      const o = segGrid.items[j] * SEG_STRIDE;
      if (segs[o + 5] === KIND_PATH) continue;
      const ax = segs[o], az = segs[o + 1], dx = segs[o + 2] - ax, dz = segs[o + 3] - az;
      const l2 = dx * dx + dz * dz;
      const t = l2 > 0 ? Math.min(1, Math.max(0, ((x - ax) * dx + (z - az) * dz) / l2)) : 0;
      const d = Math.hypot(x - ax - dx * t, z - az - dz * t) - segs[o + 4];
      if (d < best) best = d;
    }
    return best;
  };

  // --- buildings (mapped)
  const urbanGrid = makeGrid(urban.length, (i) => urban[i].bbox, tm);
  const landuseAt = (x, z) => {
    const c = urbanGrid.cell(z) * urbanGrid.N + urbanGrid.cell(x);
    for (let j = urbanGrid.start[c]; j < urbanGrid.start[c + 1]; j++) {
      const poly = urban[urbanGrid.items[j]];
      if (inPoly(poly, x, z)) return poly.cls;
    }
    return '';
  };
  const blds = []; // { ring, bbox }
  // o: { style, wallCol, roofCol, shop, pitched (-1 = flat, else hip amount), box }
  const addBuilding = (poly, y0, y1, o) => {
    const rings = [poly.outer, ...poly.holes];
    let yb = y0;
    if (o.shop && y0 === 0 && y1 >= 6.4) {
      for (const r of rings) wallRing(wallsBy[S_SHOP], r, 0, 3.4, o.wallCol, 0, 1);
      yb = 3.4;
    }
    const floors = Math.max(1, Math.round((y1 - yb) / 3.1));
    for (const r of rings) wallRing(wallsBy[o.style], r, yb, y1, o.wallCol, 0, floors);
    if (o.pitched >= 0 && poly.outer.length === 4 && !poly.holes.length) pitchedRoof(roofs, poly.outer, y1, o.roofCol, o.pitched);
    else flatPolygon(roofs, poly, y1, o.roofCol);
    if (y0 < 2.5) blds.push({ ring: poly.outer, bbox: poly.bbox });
    if (o.box) {
      const cx = (poly.bbox[0] + poly.bbox[2]) / 2, cz = (poly.bbox[1] + poly.bbox[3]) / 2, e = 1.2 + o.box * 1.4;
      const ring = [[cx - e, cz - e], [cx + e, cz - e], [cx + e, cz + e], [cx - e, cz + e]];
      if (ring.every((p) => inPoly(poly, p[0], p[1]))) {
        addBuilding({ outer: ring, holes: [], bbox: bboxOf(ring) }, y1, y1 + 1.8 + o.box, { style: S_INDUSTRIAL, wallCol: shade(o.wallCol, 0.85), roofCol: o.roofCol, pitched: -1 });
      }
    }
  };
  const pickCol = (style, n) => STYLE_COLORS[style][n % STYLE_COLORS[style].length];
  let mapped = 0;
  each('building', (f) => {
    if (f.type !== 3) return;
    if (f.properties.hide_3d) return;
    const h = Math.max(3, Number(f.properties.render_height) || 6);
    const h0 = Math.max(0, Math.min(h - 1, Number(f.properties.render_min_height) || 0));
    for (const poly of readPolygons(f, k)) {
      const cx = (poly.bbox[0] + poly.bbox[2]) / 2, cz = (poly.bbox[1] + poly.bbox[3]) / 2;
      if (cx < 0 || cz < 0 || cx >= tm || cz >= tm) continue; // owned by a neighbouring tile
      const seed = Math.abs(Math.floor(cx * 7.31 + cz * 3.17)) + job.tx * 31 + job.ty * 17;
      const use = landuseAt(cx, cz);
      let style;
      if (use === 'industrial' || use === 'garages' || (poly.area > 2500 && h < 14)) style = S_INDUSTRIAL;
      else if (h >= 36) style = seed % 3 === 0 ? S_STRIP : S_GLASS;
      else if (h >= 15) style = [S_GLASS, S_STRIP, S_BALCONY, S_PLASTER, S_BRICK, S_BALCONY][seed % 6];
      else style = [S_PLASTER, S_BRICK, S_BALCONY, S_PLASTER, S_STRIP, S_PLASTER, S_BRICK][seed % 7];
      const commercial = use === 'commercial' || use === 'retail';
      const shop = style !== S_INDUSTRIAL && h0 === 0 && (commercial || (seed >> 3) % 3 === 0);
      const small = poly.outer.length === 4 && !poly.holes.length && h <= 10.5 && poly.area < 420 && style !== S_INDUSTRIAL;
      const pitched = small && (seed >> 2) % 5 < 3 ? ((seed >> 5) % 3) * 0.4 : -1;
      const wallCol = shade(pickCol(style, seed >> 1), 0.9 + (seed % 7) * 0.025);
      const roofCol = pitched >= 0 ? PITCHED_ROOFS[(seed >> 4) % PITCHED_ROOFS.length] : shade(ROOFS[seed % ROOFS.length], 0.85 + (seed % 5) * 0.05);
      const box = pitched < 0 && h0 === 0 && poly.area > 160 && h >= 8 && (seed >> 6) % 2 ? 0.3 + ((seed >> 7) % 4) * 0.25 : 0;
      addBuilding(poly, h0, h, { style, wallCol, roofCol, shop, pitched, box });
      mapped++;
    }
  });

  // --- guessed buildings along streets where the map has none
  let guessed = 0;
  if (job.infill) {
    const mappedGrid = makeGrid(blds.length, (i) => {
      const b = blds[i].bbox; return [b[0] - 6, b[1] - 6, b[2] + 6, b[3] + 6];
    }, tm);
    const noBuildGrid = makeGrid(noBuild.length, (i) => noBuild[i].bbox, tm);
    const N = segGrid.N;
    const dens = new Float32Array(N * N);
    for (const r of roads) {
      if (r.kind !== KIND_ROAD || r.rank < 3 || r.rank > 7) continue;
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const a = r.pts[i], b = r.pts[i + 1];
        dens[segGrid.cell((a[1] + b[1]) / 2) * N + segGrid.cell((a[0] + b[0]) / 2)] += Math.hypot(b[0] - a[0], b[1] - a[1]);
      }
    }
    // Mapped buildings per grid cell: where the map already has buildings nearby,
    // the area is treated as fully mapped and nothing is guessed.
    const mappedDens = new Uint16Array(N * N);
    for (const b of blds) mappedDens[segGrid.cell((b.bbox[1] + b.bbox[3]) / 2) * N + segGrid.cell((b.bbox[0] + b.bbox[2]) / 2)]++;
    const isMapped = (x, z) => {
      const cx = segGrid.cell(x), cz = segGrid.cell(z);
      let sum = 0;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const X = cx + dx, Zc = cz + dz;
        if (X >= 0 && Zc >= 0 && X < N && Zc < N) sum += mappedDens[Zc * N + X];
      }
      return sum >= 4;
    };
    const isUrban = (x, z) => {
      const cx = urbanGrid.cell(x), cz = urbanGrid.cell(z), c = cz * N + cx;
      for (let j = urbanGrid.start[c]; j < urbanGrid.start[c + 1]; j++) if (inPoly(urban[urbanGrid.items[j]], x, z)) return true;
      let sum = 0;
      for (let dz = -2; dz <= 2; dz++) for (let dx = -2; dx <= 2; dx++) {
        const X = cx + dx, Zc = cz + dz;
        if (X >= 0 && Zc >= 0 && X < N && Zc < N) sum += dens[Zc * N + X];
      }
      return sum >= 520;
    };
    const blocked = (x, z) => {
      const c = noBuildGrid.cell(z) * N + noBuildGrid.cell(x);
      for (let j = noBuildGrid.start[c]; j < noBuildGrid.start[c + 1]; j++) if (inPoly(noBuild[noBuildGrid.items[j]], x, z)) return true;
      return false;
    };
    const nearMapped = (x, z, r) => {
      const c = mappedGrid.cell(z) * N + mappedGrid.cell(x);
      for (let j = mappedGrid.start[c]; j < mappedGrid.start[c + 1]; j++) {
        const b = blds[mappedGrid.items[j]].bbox;
        if (x + r > b[0] - 4 && x - r < b[2] + 4 && z + r > b[1] - 4 && z - r < b[3] + 4) return true;
      }
      return false;
    };
    const occ = new Map(); // coarse hash of guessed buildings: key -> [x, z, r, ...]
    const OC = 16;
    const overlaps = (x, z, r) => {
      const cx = Math.floor(x / OC), cz = Math.floor(z / OC);
      for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
        const list = occ.get((cx + dx) * 4096 + cz + dz);
        if (!list) continue;
        for (let i = 0; i < list.length; i += 3) if (Math.hypot(list[i] - x, list[i + 1] - z) < list[i + 2] + r) return true;
      }
      return false;
    };

    for (const r of roads) {
      if (guessed >= MAX_GUESSED) break;
      if (r.kind !== KIND_ROAD || r.brunnel || r.rank < 4 || r.rank > 7) continue;
      const big = r.rank >= 5;
      let carry = rng() * 8;
      for (let i = 0; i + 1 < r.pts.length; i++) {
        const a = r.pts[i], b = r.pts[i + 1];
        const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
        if (len < 0.5) continue;
        const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
        let s = carry;
        while (s < len) {
          const w = big ? 9 + rng() * 8 : 7 + rng() * 6;
          const px = a[0] + ux * s, pz = a[1] + uz * s;
          for (const side of [1, -1]) {
            const dep = big ? 9 + rng() * 6 : 7 + rng() * 5;
            const floors = big ? 2 + Math.floor(rng() * 4) : 1 + Math.floor(rng() * rng() * 3);
            const setback = big ? 1 + rng() * 2 : 1.5 + rng() * 4;
            const tint = rng(), roofPick = rng();
            const nx = -uz * side, nz = ux * side;
            const off = r.hw + 1.8 + setback + dep / 2;
            const cx = px + nx * off, cz = pz + nz * off;
            if (cx < 0 || cz < 0 || cx >= tm || cz >= tm) continue;
            const rad = Math.max(w, dep) / 2;
            if (overlaps(cx, cz, rad - 0.5) || nearMapped(cx, cz, rad) || isMapped(cx, cz)) continue;
            const hx = ux * w / 2, hz = uz * w / 2, dx = nx * dep / 2, dz = nz * dep / 2;
            const ring = [[cx - hx - dx, cz - hz - dz], [cx + hx - dx, cz + hz - dz], [cx + hx + dx, cz + hz + dz], [cx - hx + dx, cz - hz + dz]];
            let ok = roadClearance(cx, cz) > 1 && !blocked(cx, cz) && isUrban(cx, cz);
            for (let j = 0; ok && j < 4; j++) {
              const p = ring[j], q = ring[(j + 1) % 4];
              ok = roadClearance(p[0], p[1]) > 0.8 && roadClearance((p[0] + q[0]) / 2, (p[1] + q[1]) / 2) > 0.8 && !blocked(p[0], p[1]);
            }
            if (!ok) continue;
            if (ringArea(ring) < 0) ring.reverse();
            const pickN = Math.floor(tint * 997), roofN = Math.floor(roofPick * 991);
            const style = big ? [S_PLASTER, S_BALCONY, S_BRICK, S_STRIP, S_BALCONY][pickN % 5] : [S_PLASTER, S_BRICK, S_PLASTER, S_BALCONY][pickN % 4];
            const pitched = !big && floors <= 2 && roofN % 5 < 3 ? (roofN % 3) * 0.4 : -1;
            addBuilding({ outer: ring, holes: [], bbox: bboxOf(ring), area: w * dep }, 0, floors * 3.1 + 0.3, {
              style, pitched,
              wallCol: shade(pickCol(style, pickN >> 2), 0.9 + tint * 0.12),
              roofCol: pitched >= 0 ? PITCHED_ROOFS[roofN % PITCHED_ROOFS.length] : ROOFS[roofN % ROOFS.length],
              shop: big && floors >= 2 && roofN % 4 !== 0,
              box: 0,
            });
            const key = Math.floor(cx / OC) * 4096 + Math.floor(cz / OC);
            let list = occ.get(key);
            if (!list) occ.set(key, (list = []));
            list.push(cx, cz, rad);
            guessed++;
          }
          s += w + 0.5 + rng() * 4;
        }
        carry = s - len;
      }
    }
  }

  // --- building collision data
  let ptCount = 0;
  for (const b of blds) ptCount += b.ring.length;
  const bldPts = new Float32Array(ptCount * 2);
  const bldOff = new Uint32Array(blds.length + 1);
  const bldBox = new Float32Array(blds.length * 4);
  {
    let o = 0;
    blds.forEach((b, i) => {
      bldOff[i] = o / 2;
      for (const p of b.ring) { bldPts[o++] = p[0]; bldPts[o++] = p[1]; }
      bldBox.set(b.bbox, i * 4);
    });
    bldOff[blds.length] = o / 2;
  }
  const bldGrid = makeGrid(blds.length, (i) => {
    const b = blds[i].bbox; return [b[0] - 4, b[1] - 4, b[2] + 4, b[3] + 4];
  }, tm);
  const inBuilding = (x, z) => {
    const c = bldGrid.cell(z) * bldGrid.N + bldGrid.cell(x);
    for (let j = bldGrid.start[c]; j < bldGrid.start[c + 1]; j++) {
      const b = blds[bldGrid.items[j]].bbox;
      if (x > b[0] - 1.5 && x < b[2] + 1.5 && z > b[1] - 1.5 && z < b[3] + 1.5) return true;
    }
    return false;
  };

  // --- trees, scattered inside mapped woods / parks / gardens.
  // Candidates are sampled at the mapped density, then thinned to a per-tile budget,
  // keeping trees near roads (where the driver sees them) before trees deep in the woods.
  const nearRoad = (x, z) => {
    const cx = segGrid.cell(x), cz = segGrid.cell(z), N = segGrid.N;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const X = cx + dx, Zc = cz + dz;
      if (X >= 0 && Zc >= 0 && X < N && Zc < N && segGrid.start[Zc * N + X + 1] > segGrid.start[Zc * N + X]) return true;
    }
    return false;
  };
  let wanted = 0;
  const boxes = green.map(([poly, per]) => {
    const b = poly.bbox;
    const box = [Math.max(0, b[0]), Math.max(0, b[1]), Math.min(tm, b[2]), Math.min(tm, b[3])];
    const n = box[2] > box[0] && box[3] > box[1] ? ((box[2] - box[0]) * (box[3] - box[1])) / per : 0;
    wanted += n;
    return [box, n];
  });
  const thin = Math.min(1, MAX_CANDIDATES / Math.max(1, wanted));
  const inBuildingExact = (x, z) => {
    const c = bldGrid.cell(z) * bldGrid.N + bldGrid.cell(x);
    for (let j = bldGrid.start[c]; j < bldGrid.start[c + 1]; j++) {
      const b = blds[bldGrid.items[j]], bb = b.bbox;
      if (x > bb[0] - 1 && x < bb[2] + 1 && z > bb[1] - 1 && z < bb[3] + 1 && inRing(b.ring, x, z)) return true;
    }
    return false;
  };
  const inWater = (x, z) => waters.some((w) => inPoly(w, x, z));
  const near = [], far = [], bushNear = [], bushFar = [];
  // street trees along ordinary roads (not mapped individually; spacing is invented)
  for (const r of roads) {
    if (r.kind !== KIND_ROAD || r.brunnel || r.rank < 4 || r.rank > 8) continue;
    const off = r.hw + (r.walk ? 1.0 : 1.8);
    let carry = 4 + rng() * 14;
    for (let i = 0; i + 1 < r.pts.length; i++) {
      const a = r.pts[i], b = r.pts[i + 1];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      if (len < 0.5) continue;
      const ux = (b[0] - a[0]) / len, uz = (b[1] - a[1]) / len;
      let s = carry;
      for (; s < len; s += 15 + rng() * 12) {
        for (const side of [1, -1]) {
          const sc = 0.7 + rng() * 0.35, tint = rng();
          if (rng() < 0.2) continue;
          const x = a[0] + ux * s - uz * side * off, z = a[1] + uz * s + ux * side * off;
          if (x < 0 || z < 0 || x >= tm || z >= tm) continue;
          if (roadClearance(x, z) < 0.7 || inBuildingExact(x, z) || inWater(x, z)) continue;
          near.push(x, z, sc, tint);
        }
      }
      carry = s - len;
    }
  }
  green.forEach(([poly, , scale], gi) => {
    const [box, n] = boxes[gi];
    const tries = Math.round(n * thin + rng());
    for (let i = 0; i < tries; i++) {
      const x = box[0] + rng() * (box[2] - box[0]), z = box[1] + rng() * (box[3] - box[1]);
      const sc = scale * (0.7 + rng() * 0.7), tint = rng();
      if (!inPoly(poly, x, z) || roadClearance(x, z) < 2 || inBuilding(x, z)) continue;
      (nearRoad(x, z) ? near : far).push(x, z, sc, tint);
    }
    // undergrowth: bushes at roughly half the tree density
    for (let i = 0; i < tries * 0.5; i++) {
      const x = box[0] + rng() * (box[2] - box[0]), z = box[1] + rng() * (box[3] - box[1]);
      const sc = 0.6 + rng() * 0.9, tint = rng();
      if (!inPoly(poly, x, z) || roadClearance(x, z) < 1 || inBuilding(x, z)) continue;
      (nearRoad(x, z) ? bushNear : bushFar).push(x, z, sc, tint);
    }
  });
  const pick = (list, budget) => {
    const count = list.length / TREE_STRIDE;
    if (count <= budget) return list;
    const out = [], keep = budget / count;
    for (let i = 0; i < list.length; i += TREE_STRIDE) if (rng() < keep) out.push(list[i], list[i + 1], list[i + 2], list[i + 3]);
    return out;
  };
  const bushPicked = pick(bushNear, MAX_BUSHES - 1000);
  const bushes = bushPicked.concat(pick(bushFar, MAX_BUSHES - bushPicked.length / TREE_STRIDE));
  const nearPicked = pick(near, MAX_TREES - 2500);
  const trees = nearPicked.concat(pick(far, MAX_TREES - nearPicked.length / TREE_STRIDE));

  // --- street names
  const names = [];
  const nameIdx = new Map();
  const nameSegList = [];
  each('transportation_name', (f) => {
    if (f.type !== 2) return;
    const name = f.properties['name:latin'] || f.properties.name || f.properties.ref;
    if (!name) return;
    let idx = nameIdx.get(name);
    if (idx === undefined) { idx = names.length; names.push(name); nameIdx.set(name, idx); }
    for (const line of f.loadGeometry()) {
      for (let i = 0; i + 1 < line.length; i++) nameSegList.push(line[i].x * k, line[i].y * k, line[i + 1].x * k, line[i + 1].y * k, idx);
    }
  });
  const nameSegs = new Float32Array(nameSegList);
  const nameGrid = makeGrid(nameSegs.length / NAME_STRIDE, (i) => {
    const o = i * NAME_STRIDE;
    return [Math.min(nameSegs[o], nameSegs[o + 2]) - 20, Math.min(nameSegs[o + 1], nameSegs[o + 3]) - 20,
      Math.max(nameSegs[o], nameSegs[o + 2]) + 20, Math.max(nameSegs[o + 1], nameSegs[o + 3]) + 20];
  }, tm);

  // --- name boards: streets, places (suburbs, towns) and points of interest.
  // Each label: { x, z, a (board yaw), t (text), k (0 street, 1 poi, 2 place), c (class) }
  const labels = [];
  const taken = new Map();
  const free = (x, z, gap) => {
    const cx = Math.floor(x / 8), cz = Math.floor(z / 8);
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const list = taken.get((cx + dx) * 8192 + cz + dz);
      if (list) for (let i = 0; i < list.length; i += 2) if (Math.hypot(list[i] - x, list[i + 1] - z) < gap) return false;
    }
    return true;
  };
  const take = (x, z) => {
    const key = Math.floor(x / 8) * 8192 + Math.floor(z / 8);
    let list = taken.get(key);
    if (!list) taken.set(key, (list = []));
    list.push(x, z);
  };
  const boardOk = (x, z) => x >= 0 && z >= 0 && x < tm && z < tm && roadClearance(x, z) > 0.4 && !inBuildingExact(x, z);
  // nearest drivable road segment within ~2 grid cells
  const nearestSeg = (x, z) => {
    const cx = segGrid.cell(x), cz = segGrid.cell(z), N = segGrid.N;
    let best = null, bd = 70;
    for (let dz = -1; dz <= 1; dz++) for (let dx = -1; dx <= 1; dx++) {
      const X = cx + dx, Zc = cz + dz;
      if (X < 0 || Zc < 0 || X >= N || Zc >= N) continue;
      const c = Zc * N + X;
      for (let j = segGrid.start[c]; j < segGrid.start[c + 1]; j++) {
        const o = segGrid.items[j] * SEG_STRIDE;
        if (segs[o + 5] !== KIND_ROAD) continue;
        const ax = segs[o], az = segs[o + 1], ex = segs[o + 2] - ax, ez = segs[o + 3] - az;
        const l2 = ex * ex + ez * ez;
        if (l2 < 0.01) continue;
        const t = Math.min(1, Math.max(0, ((x - ax) * ex + (z - az) * ez) / l2));
        const px = ax + ex * t, pz = az + ez * t, d = Math.hypot(x - px, z - pz);
        if (d < bd) { bd = d; const l = Math.sqrt(l2); best = { px, pz, ux: ex / l, uz: ez / l, hw: segs[o + 4], d }; }
      }
    }
    return best;
  };
  const text = (p) => String(p['name:latin'] || p.name_en || p.name || '').trim().slice(0, 48);
  const roadside = (x, z, gap, extra, t, kind, cls) => {
    const s = nearestSeg(x, z);
    if (!s) {
      if (free(x, z, gap) && boardOk(x, z)) { labels.push({ x, z, a: (x * 0.37 + z * 0.71) % 3.14, t, k: kind, c: cls }); take(x, z); }
      return;
    }
    let nx = x - s.px, nz = z - s.pz;
    if (s.d < 0.05) { nx = -s.uz; nz = s.ux; } else { nx /= s.d; nz /= s.d; }
    for (const shift of [0, 8, -8, 16, -16, 24, -24]) {
      const bx = s.px + s.ux * shift + nx * (s.hw + extra), bz = s.pz + s.uz * shift + nz * (s.hw + extra);
      if (!free(bx, bz, gap) || !boardOk(bx, bz)) continue;
      labels.push({ x: bx, z: bz, a: Math.atan2(s.ux, s.uz), t, k: kind, c: cls });
      take(bx, bz);
      return;
    }
  };

  each('place', (f) => {
    if (f.type !== 1) return;
    const t = text(f.properties), pt = f.loadGeometry()[0][0];
    const x = pt.x * k, z = pt.y * k;
    if (!t || x < 0 || z < 0 || x >= tm || z >= tm) return;
    roadside(x, z, 30, 3.2, t, 2, f.properties.class || '');
  });

  const signSpots = new Map(); // street name -> [x, z, ...] of signs already placed
  each('transportation_name', (f) => {
    if (f.type !== 2) return;
    const t = text(f.properties) || String(f.properties.ref || '');
    let cls = f.properties.class || '';
    if (cls.endsWith('_construction')) cls = cls.slice(0, -13);
    const spec = ROADS[cls];
    if (!t || !spec || spec.kind !== undefined) return;
    const spots = signSpots.get(t) || [];
    signSpots.set(t, spots);
    for (const line of f.loadGeometry()) {
      let next = 10;
      let run = 0;
      for (let i = 0; i + 1 < line.length; i++) {
        const ax = line[i].x * k, az = line[i].y * k, ex = line[i + 1].x * k - ax, ez = line[i + 1].y * k - az;
        const len = Math.hypot(ex, ez);
        if (len < 0.5) continue;
        for (; next < run + len; next += 260) {
          const s = next - run, ux = ex / len, uz = ez / len;
          const px = ax + ux * s, pz = az + uz * s;
          let near = false;
          for (let j = 0; j < spots.length; j += 2) if (Math.hypot(spots[j] - px, spots[j + 1] - pz) < 170) { near = true; break; }
          if (near) continue;
          const ns = nearestSeg(px, pz);
          const signHw = ns && ns.d < 3 ? ns.hw : 3;
          for (const side of [1, -1]) {
            const bx = px - uz * side * (signHw + 1.1), bz = pz + ux * side * (signHw + 1.1);
            if (!free(bx, bz, 5) || !boardOk(bx, bz)) continue;
            labels.push({ x: bx, z: bz, a: Math.atan2(ux, uz), t, k: 0, c: cls });
            take(bx, bz);
            spots.push(px, pz);
            break;
          }
        }
        run += len;
      }
    }
  });

  const pois = [];
  each('poi', (f) => {
    if (f.type !== 1) return;
    const t = text(f.properties);
    if (t) pois.push([Number(f.properties.rank) || 99, t, f.properties.class || '', f.loadGeometry()[0][0]]);
  });
  pois.sort((a, b) => a[0] - b[0]);
  for (const [, t, cls, pt] of pois) {
    if (labels.length >= MAX_LABELS) break;
    const x = pt.x * k, z = pt.y * k;
    if (x < 0 || z < 0 || x >= tm || z >= tm) continue;
    roadside(x, z, 6.5, 2.4, t, 1, cls);
  }

  const treeArr = new Float32Array(trees);
  const bushArr = new Float32Array(bushes);
  const grid = (g) => { transfer.push(g.start.buffer, g.items.buffer); return { N: g.N, start: g.start, items: g.items }; };
  transfer.push(segs.buffer, bldPts.buffer, bldOff.buffer, bldBox.buffer, nameSegs.buffer, treeArr.buffer, bushArr.buffer);
  const data = {
    land: land.out(transfer),
    roads: road.out(transfer),
    walls: wallsBy.map((w) => w.out(transfer)),
    roofs: roofs.out(transfer),
    trees: treeArr,
    bushes: bushArr,
    labels,
    segs, segGrid: grid(segGrid),
    bldPts, bldOff, bldBox, bldGrid: grid(bldGrid),
    names, nameSegs, nameGrid: grid(nameGrid),
    stats: { mapped, guessed, trees: treeArr.length / TREE_STRIDE, bushes: bushArr.length / TREE_STRIDE, labels: labels.length, segs: segCount, empty: !tile },
  };
  return { data, transfer };
}

function clipLine2(feature, lo, hi) {
  const out = [];
  for (const line of feature.loadGeometry()) for (const part of clipLine(line, lo, hi)) out.push(part);
  return out;
}
