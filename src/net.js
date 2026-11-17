// Multiplayer: peer-to-peer rooms via Trystero (WebRTC, no game server).
// Positions travel as Web-Mercator coordinates so every client can use its own local origin.
import * as THREE from 'three';
import { joinRoom } from 'trystero';
import { buildCar, poseCar } from './car.js';

const APP_ID = 'osm-drive-game-v1';
const SEND_HZ = 12;
const DELAY = 0.13; // render remote cars this far in the past, seconds

function nameSprite(text) {
  const c = document.createElement('canvas');
  c.width = 256; c.height = 64;
  const g = c.getContext('2d');
  g.font = '600 30px system-ui, sans-serif';
  const w = Math.min(248, g.measureText(text).width + 28);
  g.fillStyle = 'rgba(15,18,24,0.75)';
  g.beginPath();
  g.roundRect((256 - w) / 2, 10, w, 44, 12);
  g.fill();
  g.fillStyle = '#fff';
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.fillText(text, 128, 33, 240);
  const s = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false, transparent: true }));
  s.scale.set(8, 2, 1);
  s.position.y = 3.4;
  s.renderOrder = 10;
  return s;
}

export class Net {
  constructor(scene, world, roomId) {
    this.scene = scene;
    this.world = world;
    this.roomId = roomId;
    this.peers = new Map();
    this.sendTimer = 0;
    this.status = 'connecting';
    this.onFirstPeer = null;
    this.joinedAt = performance.now();
    try {
      this.room = joinRoom({ appId: APP_ID }, roomId);
      this.action = this.room.makeAction('state');
      this.action.onMessage((data, ctx) => this.receive(ctx.peerId, data));
      this.room.onPeerJoin(() => { this.status = 'connected'; this.sendTimer = 1; });
      this.room.onPeerLeave(({ peerId }) => this.remove(peerId));
      this.status = 'waiting';
    } catch (err) {
      this.status = 'offline';
      this.error = String(err);
    }
  }

  receive(id, s) {
    if (!s || typeof s.x !== 'number' || typeof s.y !== 'number') return;
    let p = this.peers.get(id);
    if (!p) {
      p = { id, snaps: [], name: '', color: -1, model: null, label: null, x: 0, z: 0, heading: 0, speed: 0 };
      this.peers.set(id, p);
    }
    const name = String(s.n || 'Player').slice(0, 20), color = Number(s.c) || 0x3b7dd4;
    if (!p.model || p.color !== color) {
      if (p.model) this.scene.remove(p.model);
      p.model = buildCar(color);
      p.label = null;
      this.scene.add(p.model);
    }
    if (!p.label || p.name !== name) {
      if (p.label) p.model.remove(p.label);
      p.label = nameSprite(name);
      p.model.add(p.label);
    }
    p.name = name; p.color = color;
    p.snaps.push({ t: performance.now() / 1000, mx: s.x, my: s.y, h: Number(s.h) || 0, v: Number(s.v) || 0, st: Number(s.s) || 0 });
    if (p.snaps.length > 30) p.snaps.shift();
    // Whoever arrived later jumps to whoever was already driving (compared by time-in-room, so clocks need not agree).
    if (this.onFirstPeer) {
      const fn = this.onFirstPeer;
      this.onFirstPeer = null;
      if ((Number(s.a) || 0) > (performance.now() - this.joinedAt) / 1000) fn(p);
    }
  }

  remove(id) {
    const p = this.peers.get(id);
    if (!p) return;
    if (p.model) this.scene.remove(p.model);
    this.peers.delete(id);
  }

  // Send our state (throttled) and move remote cars.
  update(dt, me) {
    this.sendTimer += dt;
    if (this.action && this.sendTimer >= 1 / SEND_HZ) {
      this.sendTimer = 0;
      const [mx, my] = this.world.toMerc(me.x, me.z);
      this.action.send({ x: mx, y: my, h: me.heading, v: me.speed, s: me.steer, n: me.name, c: me.color, a: (performance.now() - this.joinedAt) / 1000 }).catch(() => {});
    }
    const now = performance.now() / 1000, rt = now - DELAY;
    for (const p of this.peers.values()) {
      const sn = p.snaps;
      if (!sn.length) continue;
      if (now - sn[sn.length - 1].t > 8) { this.remove(p.id); continue; }
      let a = sn[0], b = sn[sn.length - 1];
      for (let i = sn.length - 1; i > 0; i--) {
        if (sn[i - 1].t <= rt) { a = sn[i - 1]; b = sn[i]; break; }
      }
      const span = b.t - a.t;
      let u = span > 1e-4 ? (rt - a.t) / span : 1;
      u = Math.max(0, Math.min(u, 1.5)); // allow a little extrapolation
      const mx = a.mx + (b.mx - a.mx) * u, my = a.my + (b.my - a.my) * u;
      let dh = b.h - a.h;
      dh = Math.atan2(Math.sin(dh), Math.cos(dh));
      const [x, z] = this.world.fromMerc(mx, my);
      p.x = x; p.z = z; p.heading = a.h + dh * u; p.speed = b.v;
      poseCar(p.model, x, z, p.heading, b.st, b.v, dt);
    }
  }

  // Latest known Mercator position of a peer (for teleporting to them).
  latest(p) {
    const s = p.snaps[p.snaps.length - 1];
    return s ? [s.mx, s.my] : null;
  }
}
