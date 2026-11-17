// Day / night: the sun's real position for the place being driven through, from the
// current UTC time plus latitude and longitude. Drives sky colour, lighting, window
// glow and car headlamps.
import * as THREE from 'three';
import tzlookup from 'tz-lookup';

const RAD = Math.PI / 180;

// Sun elevation and azimuth (radians; azimuth clockwise from north) — low-precision almanac formula.
export function sunPosition(date, lat, lon) {
  const d = date.getTime() / 86400000 - 10957.5; // days since J2000.0
  const g = (357.529 + 0.98560028 * d) * RAD;
  const q = 280.459 + 0.98564736 * d;
  const L = (q + 1.915 * Math.sin(g) + 0.02 * Math.sin(2 * g)) * RAD;
  const e = (23.439 - 0.00000036 * d) * RAD;
  const ra = Math.atan2(Math.cos(e) * Math.sin(L), Math.cos(L));
  const dec = Math.asin(Math.sin(e) * Math.sin(L));
  const gmst = (18.697374558 + 24.06570982441908 * d) * 15 * RAD;
  const ha = gmst + lon * RAD - ra;
  const la = lat * RAD;
  const elevation = Math.asin(Math.sin(la) * Math.sin(dec) + Math.cos(la) * Math.cos(dec) * Math.cos(ha));
  const azimuth = Math.atan2(-Math.sin(ha), Math.tan(dec) * Math.cos(la) - Math.sin(la) * Math.cos(ha));
  return { elevation, azimuth };
}

// Real clock time and zone name at a place, from an offline timezone map.
let zoneKey = '', zone = 'UTC';
export function localClock(date, lat, lon) {
  const key = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  if (key !== zoneKey) {
    zoneKey = key;
    try { zone = tzlookup(lat, lon); } catch { zone = 'UTC'; }
  }
  try {
    const time = new Intl.DateTimeFormat('en-GB', { timeZone: zone, hour: '2-digit', minute: '2-digit', hour12: false }).format(date);
    return { time, zone };
  } catch {
    return { time: date.toISOString().slice(11, 16), zone: 'UTC' };
  }
}

const smooth = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };

const DAY = new THREE.Color(0xa9cdea), DUSK = new THREE.Color(0xe59a6a), NIGHT = new THREE.Color(0x070b18);
const WHITE = new THREE.Color(0xffffff), DARK = new THREE.Color(0x353c54), WARM = new THREE.Color(0xffd9b0);

export class DayNight {
  // targets: { scene, hemi, sun, flat: [unlit materials], walls: [lit facade materials], onChange(night) }
  constructor(targets) {
    this.t = targets;
    this.mode = 'real'; // 'real' | 'day' | 'night'
    this.night = 0;
    this.sky = new THREE.Color();
    this.tint = new THREE.Color();
  }

  update(lat, lon, date = new Date()) {
    let { elevation, azimuth } = sunPosition(date, lat, lon);
    if (this.mode === 'day') { elevation = 50 * RAD; azimuth = 150 * RAD; }
    if (this.mode === 'night') elevation = -40 * RAD;
    const deg = elevation / RAD;
    const day = smooth(-5, 8, deg);
    const dusk = Math.exp(-((deg / 7) ** 2));
    this.night = 1 - day;

    this.sky.copy(NIGHT).lerp(DAY, day).lerp(DUSK, dusk * 0.55);
    const { scene, hemi, sun, flat, walls } = this.t;
    scene.background.copy(this.sky);
    scene.fog.color.copy(this.sky);

    hemi.intensity = 0.2 + 1.3 * day;
    hemi.color.setHex(0x8fa0d0).lerp(WHITE, day);
    if (deg > -2) {
      // sun: x east, y up, z south
      sun.position.set(Math.cos(elevation) * Math.sin(azimuth), Math.max(0.08, Math.sin(elevation)), -Math.cos(elevation) * Math.cos(azimuth));
      sun.intensity = 2 * smooth(-2, 12, deg);
      sun.color.copy(WARM).lerp(WHITE, smooth(4, 25, deg));
    } else {
      sun.position.set(-0.4, 0.8, 0.3); // moonlight
      sun.intensity = 0.22;
      sun.color.setHex(0x9db4ff);
    }

    this.tint.copy(DARK).lerp(WHITE, day).lerp(WARM, dusk * 0.25 * day);
    for (const m of flat) m.color.copy(this.tint);
    for (const m of walls) m.emissiveIntensity = this.night * this.night * 1.1;
    this.t.onChange(this.night);
  }
}
