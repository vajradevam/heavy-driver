import * as THREE from 'three';
import { World } from './world.js';
import { Car, buildCar, poseCar, setCarNight, addHeadlight } from './car.js';
import { DayNight, localClock } from './sky.js';
import { Net } from './net.js';
import { Signs } from './signs.js';
import { mercToLonLat, KIND_PATH, KIND_RAIL, KIND_RUNWAY } from './shared.js';

const $ = (id) => document.getElementById(id);
const PRESETS = [
  ['Paris – Arc de Triomphe', 48.8738, 2.295],
  ['New York – Times Square', 40.758, -73.9855],
  ['London – Westminster', 51.5007, -0.1246],
  ['Tokyo – Shibuya', 35.6595, 139.7005],
  ['Chennai – Guindy', 13.0102, 80.2157],
  ['Mumbai – Marine Drive', 18.9432, 72.8231],
  ['Delhi – India Gate', 28.6129, 77.2295],
  ['San Francisco – Lombard St', 37.8021, -122.4187],
  ['Monaco', 43.7384, 7.4246],
];
const CAR_COLORS = [0xd43b3b, 0x3b7dd4, 0xe0a52a, 0x35a36b, 0x8a4fd1, 0xe8e8ea];

// ------------------------------------------------------------ saved settings
const store = {
  load() { try { return JSON.parse(localStorage.getItem('rmd') || '{}'); } catch { return {}; } },
  save(patch) { try { localStorage.setItem('rmd', JSON.stringify({ ...store.load(), ...patch })); } catch { /* storage unavailable */ } },
};
const saved = store.load();
const me = {
  name: saved.name || `Driver${Math.floor(Math.random() * 900 + 100)}`,
  color: saved.color ?? CAR_COLORS[Math.floor(Math.random() * CAR_COLORS.length)],
};

// ------------------------------------------------------------ scene
const SKY = 0xa9cdea;
// ------------------------------------------------------------ quality
// view: how far the world is drawn (m). marks / trees: how far road paint and plants are drawn.
// scale x min(devicePixelRatio, maxPR) is the rendering resolution relative to the window.
const QUALITY = {
  low: { view: 650, fogNear: 150, marks: 200, trees: 330, treeDensity: 0.45, treeBudget: 5000, bushBudget: 0, signs: 30, signRange: 0.6, scale: 0.7, maxPR: 1, spot: false, hud: 0.4 },
  medium: { view: 1300, fogNear: 320, marks: 450, trees: 750, treeDensity: 0.75, treeBudget: 9000, bushBudget: 2500, signs: 70, signRange: 0.85, scale: 1, maxPR: 1.5, spot: true, hud: 0.25 },
  high: { view: 2300, fogNear: 500, marks: 1300, trees: 2300, treeDensity: 1, treeBudget: 12000, bushBudget: 5000, signs: 120, signRange: 1, scale: 1, maxPR: 2, spot: true, hud: 0.2 },
};
let qualityMode = ['auto', 'low', 'medium', 'high'].includes(saved.quality) ? saved.quality : 'auto';
let tier = qualityMode === 'auto' ? 'medium' : qualityMode;
let resScale = qualityMode === 'auto' ? 0.7 : 1; // auto mode moves this between 0.5 and 1 to hold the frame rate

// Antialiasing can only be chosen when the renderer is created, so it follows the saved setting.
const renderer = new THREE.WebGLRenderer({ canvas: $('view'), antialias: qualityMode === 'high', powerPreference: 'high-performance' });
const scene = new THREE.Scene();
scene.background = new THREE.Color(SKY);
scene.fog = new THREE.Fog(SKY, 500, 2300);
const camera = new THREE.PerspectiveCamera(60, 1, 0.5, 2600);
const hemi = new THREE.HemisphereLight(0xffffff, 0x8c8676, 1.5);
scene.add(hemi);
const sun = new THREE.DirectionalLight(0xfff2dc, 2.0);
sun.position.set(-0.5, 1, 0.35);
scene.add(sun);

function resize() {
  const q = QUALITY[tier];
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, q.maxPR) * q.scale * resScale);
  renderer.setSize(window.innerWidth, window.innerHeight, false);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
}
window.addEventListener('resize', resize);
resize();

const world = new World(scene);
world.infill = saved.infill ?? true;
const signs = new Signs(scene, world);
const car = new Car();
let carModel = buildCar(me.color);
let headlight = addHeadlight(carModel);
scene.add(carModel);

const sky = new DayNight({
  scene, hemi, sun,
  flat: [world.mat.land, world.mat.roads],
  walls: [world.mat.buildings],
  onChange: (night) => { setCarNight(night); signs.setNight(night); headlight.intensity = night * 70; headlight.visible = QUALITY[tier].spot && night > 0.03; },
});
sky.mode = saved.timeMode || 'real';
let skyTimer = 99;

function applyQuality() {
  const q = QUALITY[tier];
  world.setQuality(q);
  signs.setLimits(q.signs, q.signRange);
  scene.fog.near = q.fogNear;
  scene.fog.far = q.view;
  camera.far = q.view + 150;
  skyTimer = 99; // re-applies the headlight setting
  resize();
}
applyQuality();

// Auto mode: hold a playable frame rate by lowering the rendering resolution first,
// then dropping to the low preset if that is not enough.
let fps = 60, govTimer = 0;
function govern(dt) {
  if (dt > 0 && dt < 0.5) fps += (1 / dt - fps) * 0.05;
  govTimer += dt;
  if (govTimer < 1.5) return;
  govTimer = 0;
  if (qualityMode !== 'auto' || world.pending || document.hidden) return;
  if (fps < 27) {
    const floor = tier === 'low' ? 0.75 : 0.5; // never go blurrier than about half resolution
    if (resScale > floor) { resScale = Math.max(floor, resScale - 0.1); resize(); }
    else if (tier !== 'low') { tier = 'low'; resScale = 0.8; applyQuality(); flash('Switched to low detail to keep the game smooth'); }
  } else if (fps > 52 && resScale < 1) {
    resScale = Math.min(1, resScale + 0.05);
    resize();
  }
}
let needSnap = true;

function teleport(lon, lat) {
  world.setOrigin(lon, lat);
  car.place(0, 0, 0);
  needSnap = true;
  camSnap = true;
  skyTimer = 99;
  store.save({ lon, lat });
}

// ------------------------------------------------------------ multiplayer
const hashRoom = new URLSearchParams(location.hash.slice(1)).get('room');
const roomId = hashRoom || Math.random().toString(36).slice(2, 10);
if (!hashRoom) history.replaceState(null, '', `#room=${roomId}`);
const net = new Net(scene, world, roomId);
const gotoPeer = (p) => {
  const m = net.latest(p);
  if (!m) return;
  const [lon, lat] = mercToLonLat(m[0], m[1]);
  teleport(lon, lat);
};
// Joined through an invite link: start next to whoever is already driving.
if (hashRoom) net.onFirstPeer = gotoPeer;

// ------------------------------------------------------------ input
const keys = new Set();
const touch = { left: false, right: false, gas: false, brake: false };
const typing = () => ['INPUT', 'SELECT', 'TEXTAREA'].includes(document.activeElement?.tagName);
window.addEventListener('keydown', (e) => {
  if (typing()) return;
  keys.add(e.code);
  if (e.code === 'KeyC') camMode = (camMode + 1) % CAMS.length;
  if (e.code === 'KeyR') needSnap = true;
  if (e.code.startsWith('Arrow') || e.code === 'Space') e.preventDefault();
});
window.addEventListener('keyup', (e) => keys.delete(e.code));
window.addEventListener('blur', () => keys.clear());
for (const b of document.querySelectorAll('#touch button')) {
  const k = b.dataset.k;
  const set = (v) => (e) => { e.preventDefault(); touch[k] = v; };
  b.addEventListener('pointerdown', set(true));
  b.addEventListener('pointerup', set(false));
  b.addEventListener('pointercancel', set(false));
  b.addEventListener('pointerleave', set(false));
}
const down = (...codes) => codes.some((c) => keys.has(c));
function readInput() {
  return {
    throttle: down('KeyW', 'ArrowUp') || touch.gas ? 1 : 0,
    brake: down('KeyS', 'ArrowDown') || touch.brake ? 1 : 0,
    steer: (down('KeyD', 'ArrowRight') || touch.right ? 1 : 0) - (down('KeyA', 'ArrowLeft') || touch.left ? 1 : 0),
    handbrake: down('Space'),
  };
}

// ------------------------------------------------------------ camera
const CAMS = [{ back: 9, up: 3.6, look: 5 }, { back: 22, up: 11, look: 8 }, { back: 0.01, up: 160, look: 0 }];
let camMode = 0, camSnap = true;
const camTarget = new THREE.Vector3(), lookAt = new THREE.Vector3(), lookTarget = new THREE.Vector3();
function updateCamera(dt) {
  const m = CAMS[camMode];
  const fx = Math.sin(car.heading), fz = -Math.cos(car.heading);
  camTarget.set(car.x - fx * m.back, m.up, car.z - fz * m.back);
  lookTarget.set(car.x + fx * m.look, 1, car.z + fz * m.look);
  const k = camSnap ? 1 : 1 - Math.exp(-dt * 5);
  camera.position.lerp(camTarget, k);
  lookAt.lerp(lookTarget, camSnap ? 1 : 1 - Math.exp(-dt * 9));
  camSnap = false;
  camera.up.set(camMode === 2 ? fx : 0, camMode === 2 ? 0 : 1, camMode === 2 ? fz : 0);
  camera.lookAt(lookAt);
  const fov = 60 + Math.min(14, Math.abs(car.speed) * 0.28);
  if (Math.abs(camera.fov - fov) > 0.1) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 3); camera.updateProjectionMatrix(); }
}

// ------------------------------------------------------------ interface
$('name').value = me.name;
$('color').value = `#${me.color.toString(16).padStart(6, '0')}`;
$('infill').checked = world.infill;
$('quality').value = qualityMode;
$('quality').addEventListener('change', (e) => {
  qualityMode = e.target.value;
  tier = qualityMode === 'auto' ? 'medium' : qualityMode;
  resScale = qualityMode === 'auto' ? 0.7 : 1;
  store.save({ quality: qualityMode });
  applyQuality();
  e.target.blur();
});
$('timeMode').value = sky.mode;
$('timeMode').addEventListener('change', (e) => { sky.mode = e.target.value; store.save({ timeMode: sky.mode }); skyTimer = 99; e.target.blur(); });
$('name').addEventListener('input', (e) => { me.name = e.target.value.trim().slice(0, 20) || 'Driver'; store.save({ name: me.name }); });
$('color').addEventListener('input', (e) => {
  me.color = parseInt(e.target.value.slice(1), 16);
  store.save({ color: me.color });
  scene.remove(carModel);
  carModel = buildCar(me.color);
  headlight = addHeadlight(carModel);
  scene.add(carModel);
  skyTimer = 99;
});
$('infill').addEventListener('change', (e) => { world.setInfill(e.target.checked); store.save({ infill: e.target.checked }); });
$('togglePanel').addEventListener('click', () => $('panel').classList.toggle('collapsed'));
if (matchMedia('(pointer: coarse)').matches) $('panel').classList.add('collapsed');

for (const [label, lat, lon] of PRESETS) {
  const o = document.createElement('option');
  o.textContent = label;
  o.value = `${lat},${lon}`;
  $('presets').append(o);
}
$('presets').addEventListener('change', (e) => {
  if (!e.target.value) return;
  const [lat, lon] = e.target.value.split(',').map(Number);
  teleport(lon, lat);
  e.target.value = '';
  e.target.blur();
});

let flashUntil = 0, flashText = '';
function flash(text, seconds = 4) { flashText = text; flashUntil = performance.now() + seconds * 1000; }

$('locate').addEventListener('click', () => {
  if (!navigator.geolocation) return flash('This browser cannot share its location');
  navigator.geolocation.getCurrentPosition(
    (p) => teleport(p.coords.longitude, p.coords.latitude),
    () => flash('Location permission was denied'),
  );
});

$('searchForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const q = $('search').value.trim();
  $('results').replaceChildren();
  if (!q) return;
  const m = q.match(/^\s*(-?\d+(?:\.\d+)?)\s*[, ]\s*(-?\d+(?:\.\d+)?)\s*$/);
  if (m && Math.abs(+m[1]) <= 85 && Math.abs(+m[2]) <= 180) {
    teleport(+m[2], +m[1]);
    $('search').blur();
    return;
  }
  try {
    const res = await fetch(`https://nominatim.openstreetmap.org/search?format=jsonv2&limit=5&q=${encodeURIComponent(q)}`);
    const list = await res.json();
    if (!list.length) return flash('No place found with that name');
    for (const r of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = r.display_name;
      b.addEventListener('click', () => { teleport(+r.lon, +r.lat); $('results').replaceChildren(); $('search').blur(); });
      $('results').append(b);
    }
  } catch {
    flash('Place search failed – try "lat, lon" instead');
  }
});

$('coordForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const lat = parseFloat($('lat').value.replace(',', '.')), lon = parseFloat($('lon').value.replace(',', '.'));
  if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 85 || Math.abs(lon) > 180) {
    return flash('Enter a latitude between -85 and 85 and a longitude between -180 and 180');
  }
  teleport(lon, lat);
  $('lat').blur(); $('lon').blur();
});

$('invite').addEventListener('click', async () => {
  const link = `${location.origin}${location.pathname}#room=${roomId}`;
  try { await navigator.clipboard.writeText(link); flash('Invite link copied – send it to your friend'); }
  catch { prompt('Copy this invite link:', link); }
});

$('players').addEventListener('click', (e) => {
  const id = e.target.dataset?.goto;
  const p = id && net.peers.get(id);
  if (p) gotoPeer(p);
});

function updatePlayers() {
  const rows = [];
  for (const p of net.peers.values()) {
    const dx = p.x - car.x, dz = p.z - car.z, dist = Math.hypot(dx, dz);
    const rel = Math.atan2(dx, -dz) - car.heading;
    const row = document.createElement('div');
    row.className = 'player';
    const dot = document.createElement('span');
    dot.className = 'dot';
    dot.style.background = `#${p.color.toString(16).padStart(6, '0')}`;
    const who = document.createElement('span');
    who.className = 'who';
    who.textContent = p.name;
    const arrow = document.createElement('span');
    arrow.className = 'arrow';
    arrow.textContent = '↑';
    arrow.style.transform = `rotate(${rel}rad)`;
    const d = document.createElement('span');
    d.className = 'dim';
    d.textContent = dist < 1000 ? `${Math.round(dist)} m` : `${(dist / 1000).toFixed(1)} km`;
    const go = document.createElement('button');
    go.textContent = 'Go to';
    go.dataset.goto = p.id;
    row.append(dot, who, arrow, d, go);
    rows.push(row);
  }
  $('players').replaceChildren(...rows);
  $('netStatus').textContent = net.status === 'offline'
    ? 'Multiplayer unavailable in this browser'
    : net.peers.size ? `${net.peers.size + 1} players in this room` : 'Nobody else here yet – share the invite link';
}

const mm = $('minimap').getContext('2d');
const MM_RANGE = 380;
function drawMinimap() {
  const W = 200, half = W / 2, sc = half / MM_RANGE;
  const sin = Math.sin(car.heading), cos = Math.cos(car.heading);
  const X = (x, z) => half + ((x - car.x) * cos + (z - car.z) * sin) * sc;
  const Y = (x, z) => half - ((x - car.x) * sin - (z - car.z) * cos) * sc;
  mm.fillStyle = '#20262f';
  mm.fillRect(0, 0, W, W);
  mm.lineCap = 'round';
  const passes = [[], [], []];
  world.segsNear(car.x, car.z, MM_RANGE * 1.42, (x1, z1, x2, z2, hw, kind) => {
    passes[kind === KIND_PATH || kind === KIND_RAIL ? 0 : hw < 4 ? 1 : 2].push(x1, z1, x2, z2, hw, kind);
  });
  passes.forEach((list, i) => {
    mm.strokeStyle = ['#4a5362', '#8d98a8', '#e9d9a0'][i];
    mm.lineWidth = [1, 2, 3.2][i];
    mm.beginPath();
    for (let j = 0; j < list.length; j += 6) {
      if (list[j + 5] === KIND_RUNWAY) continue;
      mm.moveTo(X(list[j], list[j + 1]), Y(list[j], list[j + 1]));
      mm.lineTo(X(list[j + 2], list[j + 3]), Y(list[j + 2], list[j + 3]));
    }
    mm.stroke();
  });
  for (const p of net.peers.values()) {
    let px = X(p.x, p.z) - half, py = Y(p.x, p.z) - half;
    const d = Math.hypot(px, py);
    if (d > half - 8) { px *= (half - 8) / d; py *= (half - 8) / d; }
    mm.fillStyle = `#${p.color.toString(16).padStart(6, '0')}`;
    mm.strokeStyle = '#fff';
    mm.lineWidth = 2;
    mm.beginPath();
    mm.arc(half + px, half + py, 5, 0, 6.3);
    mm.fill();
    mm.stroke();
  }
  mm.fillStyle = '#fff';
  mm.beginPath();
  mm.moveTo(half, half - 9);
  mm.lineTo(half + 6, half + 7);
  mm.lineTo(half, half + 3);
  mm.lineTo(half - 6, half + 7);
  mm.closePath();
  mm.fill();
}

function updateHud() {
  $('kmh').textContent = Math.round(Math.abs(car.speed) * 3.6);
  $('road').textContent = world.nameAt(car.x, car.z);
  const [hudLon, hudLat] = world.toLonLat(car.x, car.z);
  const clock = localClock(new Date(), hudLat, hudLon);
  $('coords').textContent = `${hudLat.toFixed(5)}, ${hudLon.toFixed(5)} · ${clock.time} ${clock.zone} · ${Math.round(fps)} fps`;
  let text = '';
  if (performance.now() < flashUntil) text = flashText;
  else if (fatal) text = fatal;
  else if (world.pending) text = `Building the world… ${world.pending} map tile${world.pending > 1 ? 's' : ''} to go`;
  else if (world.lastError && !world.stats().tiles) text = `Map data failed to load (${world.lastError})`;
  $('status').textContent = text;
  $('status').style.display = text ? 'block' : 'none';
  if (net.peers.size || shownPeers) updatePlayers();
  shownPeers = net.peers.size;
  drawMinimap();
}

// ------------------------------------------------------------ main loop
let fatal = '';
let last = performance.now(), hudTimer = 0, saveTimer = 0, shownPeers = -1;
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  if (needSnap && world.isLoadedAt(car.x, car.z)) {
    const r = world.nearestRoad(car.x, car.z);
    if (r) {
      car.place(r.x, r.z, r.heading);
      // don't spawn inside a friend's car: back up along the road until clear
      for (let i = 0; i < 6 && [...net.peers.values()].some((p) => Math.hypot(p.x - car.x, p.z - car.z) < 6); i++) {
        car.x -= Math.sin(car.heading) * 7;
        car.z += Math.cos(car.heading) * 7;
      }
    }
    needSnap = false;
    camSnap = true;
  }
  if (!needSnap) car.update(dt, readInput(), world);

  if (Math.hypot(car.x, car.z) > 8000) {
    world.rebase(car.x, car.z);
    camera.position.x -= car.x; camera.position.z -= car.z;
    lookAt.x -= car.x; lookAt.z -= car.z;
    car.x = 0; car.z = 0;
  }

  world.update(car.x, car.z, dt);
  govern(dt);
  poseCar(carModel, car.x, car.z, car.heading, car.steer, car.speed, dt);
  net.update(dt, { x: car.x, z: car.z, heading: car.heading, speed: car.speed, steer: car.steer, name: me.name, color: me.color });
  signs.update(dt, car.x, car.z);
  skyTimer += dt;
  if (skyTimer > 10) {
    skyTimer = 0;
    const [lon, lat] = world.toLonLat(car.x, car.z);
    sky.update(lat, lon);
  }
  updateCamera(dt);

  hudTimer += dt;
  if (hudTimer > QUALITY[tier].hud) { hudTimer = 0; updateHud(); }
  saveTimer += dt;
  if (saveTimer > 5 && !needSnap) {
    saveTimer = 0;
    const [lon, lat] = world.toLonLat(car.x, car.z);
    store.save({ lon, lat });
  }

  renderer.render(scene, camera);
  requestAnimationFrame(frame);
}

const params = new URLSearchParams(location.search);
const startLat = parseFloat(params.get('lat') ?? saved.lat ?? PRESETS[0][1]);
const startLon = parseFloat(params.get('lon') ?? saved.lon ?? PRESETS[0][2]);
world.setOrigin(startLon, startLat);
world.init().catch((err) => { fatal = `Could not reach the map server: ${err.message}`; });
requestAnimationFrame(frame);

// Handy for debugging from the browser console.
window.__game = { world, car, net, signs, sky, teleport, quality: () => ({ mode: qualityMode, tier, resScale, fps }), scene, camera, renderer };
