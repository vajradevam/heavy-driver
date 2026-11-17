// Car model (built from primitives) and arcade driving physics.
// Heading is a compass bearing in radians: 0 = north (-z), +90° = east (+x).
import * as THREE from 'three';

// Lamp and headlamp-beam materials are shared by every car so night mode switches them all at once.
const headMat = new THREE.MeshBasicMaterial({ color: 0xfff6d0 });
const tailMat = new THREE.MeshBasicMaterial({ color: 0xc81e1e });
const beamMat = (() => {
  const c = document.createElement('canvas');
  c.width = 64; c.height = 128;
  const g = c.getContext('2d');
  const along = g.createLinearGradient(0, 128, 0, 0); // bottom = at the bumper, top = far ahead
  along.addColorStop(0, 'rgba(255,244,214,0.0)');
  along.addColorStop(0.06, 'rgba(255,244,214,0.95)');
  along.addColorStop(0.45, 'rgba(255,244,214,0.45)');
  along.addColorStop(1, 'rgba(255,244,214,0)');
  g.fillStyle = along;
  g.fillRect(0, 0, 64, 128);
  g.globalCompositeOperation = 'destination-in';
  const across = g.createLinearGradient(0, 0, 64, 0);
  across.addColorStop(0, 'rgba(0,0,0,0)');
  across.addColorStop(0.3, 'rgba(0,0,0,1)');
  across.addColorStop(0.7, 'rgba(0,0,0,1)');
  across.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = across;
  g.fillRect(0, 0, 64, 128);
  return new THREE.MeshBasicMaterial({
    map: new THREE.CanvasTexture(c), transparent: true, blending: THREE.AdditiveBlending,
    depthWrite: false, opacity: 0, visible: false, fog: false,
  });
})();
// Pool of light on the road ahead: narrow at the bumper, wide 45 m out.
const beamGeo = (() => {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(new Float32Array([-1.6, 0.06, -1.8, 1.6, 0.06, -1.8, 9, 0.06, -47, -9, 0.06, -47]), 3));
  g.setAttribute('uv', new THREE.BufferAttribute(new Float32Array([0, 0, 1, 0, 1, 1, 0, 1]), 2));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
})();

// night: 0 (day) .. 1 (full night). Switches headlamp beams and lamp brightness on every car.
export function setCarNight(night) {
  beamMat.opacity = Math.min(1, night * 1.2) * 0.85;
  beamMat.visible = night > 0.03;
  headMat.color.setHex(night > 0.03 ? 0xffffff : 0xfff6d0);
  tailMat.color.setHex(night > 0.3 ? 0xff3838 : 0xc81e1e);
}

// A real spotlight for the player's own car, so walls, trees and other cars ahead light up too.
export function addHeadlight(model) {
  const spot = new THREE.SpotLight(0xfff0d0, 0, 150, 0.5, 0.7, 1.2);
  spot.position.set(0, 0.9, -2);
  spot.target.position.set(0, 0.4, -40);
  model.add(spot, spot.target);
  model.userData.spot = spot;
  return spot;
}

export function buildCar(color = 0xd43b3b) {
  const car = new THREE.Group();
  const paint = new THREE.MeshPhongMaterial({ color, shininess: 80 });
  const glass = new THREE.MeshPhongMaterial({ color: 0x1c2733, shininess: 120 });
  const dark = new THREE.MeshLambertMaterial({ color: 0x18181a });

  const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.55, 4.3), paint);
  body.position.y = 0.62;
  const cabin = new THREE.Mesh(new THREE.BoxGeometry(1.55, 0.5, 2.1), glass);
  cabin.position.set(0, 1.12, 0.25);
  const roof = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.06, 1.9), paint);
  roof.position.set(0, 1.4, 0.25);
  car.add(body, cabin, roof);

  const lampGeo = new THREE.BoxGeometry(0.42, 0.14, 0.06);
  const head = headMat, tail = tailMat;
  for (const x of [-0.6, 0.6]) {
    const h = new THREE.Mesh(lampGeo, head); h.position.set(x, 0.7, -2.16);
    const t = new THREE.Mesh(lampGeo, tail); t.position.set(x, 0.72, 2.16);
    car.add(h, t);
  }

  const wheelGeo = new THREE.CylinderGeometry(0.34, 0.34, 0.26, 14).rotateZ(Math.PI / 2);
  car.userData.wheels = [];
  car.userData.front = [];
  for (const [x, z, front] of [[-0.9, -1.35, true], [0.9, -1.35, true], [-0.9, 1.4, false], [0.9, 1.4, false]]) {
    const pivot = new THREE.Group();
    pivot.position.set(x, 0.34, z);
    const wheel = new THREE.Mesh(wheelGeo, dark);
    pivot.add(wheel);
    car.add(pivot);
    car.userData.wheels.push(wheel);
    if (front) car.userData.front.push(pivot);
  }

  // soft blob shadow
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d');
  const grad = g.createRadialGradient(32, 32, 4, 32, 32, 32);
  grad.addColorStop(0, 'rgba(0,0,0,0.55)');
  grad.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(3.4, 6).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c), transparent: true, depthWrite: false }),
  );
  shadow.position.y = 0.02;
  shadow.renderOrder = -5;
  car.add(shadow);

  const beam = new THREE.Mesh(beamGeo, beamMat);
  beam.renderOrder = -4;
  car.add(beam);

  car.userData.paint = paint;
  return car;
}

// Apply a pose to a car model (used for both the local and remote cars).
export function poseCar(model, x, z, heading, steer, speed, dt) {
  model.position.set(x, 0, z);
  model.rotation.y = -heading;
  for (const p of model.userData.front) p.rotation.y = -steer;
  for (const w of model.userData.wheels) w.rotation.x -= (speed * dt) / 0.34;
}

const MAX_SPEED = 52; // m/s on tarmac (~187 km/h)
const OFFROAD_SPEED = 17;
const WHEELBASE = 2.7;

export class Car {
  constructor() {
    this.x = 0; this.z = 0;
    this.heading = 0;
    this.vx = 0; this.vz = 0;
    this.steer = 0;
    this.speed = 0; // signed forward speed, m/s
    this.onRoad = true;
  }

  place(x, z, heading) {
    this.x = x; this.z = z; this.heading = heading;
    this.vx = this.vz = this.speed = this.steer = 0;
  }

  // input: { throttle 0..1, brake 0..1, steer -1..1, handbrake bool }
  update(dt, input, world) {
    const sin = Math.sin(this.heading), cos = Math.cos(this.heading);
    const fx = sin, fz = -cos, rx = cos, rz = sin;
    let vf = this.vx * fx + this.vz * fz;
    let vl = this.vx * rx + this.vz * rz;

    this.onRoad = world.roadClearance(this.x, this.z) <= 0.6;
    const top = this.onRoad ? MAX_SPEED : OFFROAD_SPEED;

    if (input.throttle > 0) {
      if (vf < -0.5) vf += 20 * dt;
      else vf += 10 * input.throttle * Math.max(0, 1 - vf / top) * dt;
    }
    if (input.brake > 0) {
      if (vf > 0.5) vf -= 22 * input.brake * dt;
      else vf -= 6 * input.brake * Math.max(0, 1 + vf / 12) * dt;
    }
    // rolling resistance + air drag (+ heavy drag when over the surface limit)
    let drag = 0.35 + 0.0007 * vf * vf + (this.onRoad ? 0 : 1.2);
    if (Math.abs(vf) > top) drag += 6;
    if (input.handbrake) drag += 9;
    const dv = drag * dt;
    vf = Math.abs(vf) <= dv ? 0 : vf - Math.sign(vf) * dv;

    // steering: less lock at speed
    const lock = 0.6 / (1 + Math.pow(Math.abs(vf) / 13, 1.4));
    this.steer += (input.steer * lock - this.steer) * Math.min(1, dt * 7);
    this.heading += (vf / WHEELBASE) * Math.tan(this.steer) * dt;

    // tyres resist sideways motion; the handbrake breaks them loose
    const grip = input.handbrake ? 1.6 : this.onRoad ? 9 : 5;
    vl *= Math.exp(-grip * dt);

    const s2 = Math.sin(this.heading), c2 = Math.cos(this.heading);
    this.vx = s2 * vf + c2 * vl;
    this.vz = -c2 * vf + s2 * vl;
    this.x += this.vx * dt;
    this.z += this.vz * dt;

    // collide front and rear circles with buildings
    for (const off of [1.25, -1.25]) {
      const px = this.x + s2 * off, pz = this.z - c2 * off;
      const hit = world.resolveCircle(px, pz, 1.0);
      if (!hit.hit) continue;
      this.x += hit.x - px;
      this.z += hit.z - pz;
      const vn = this.vx * hit.nx + this.vz * hit.nz;
      if (vn < 0) {
        this.vx -= vn * hit.nx * 1.3;
        this.vz -= vn * hit.nz * 1.3;
        this.vx *= 0.82;
        this.vz *= 0.82;
      }
    }
    this.speed = this.vx * s2 + this.vz * -c2;
  }
}
