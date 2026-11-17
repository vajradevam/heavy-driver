// Usage: node scripts/road-props.mjs <lat> <lon> — lists which properties road features carry, per class.
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader } from 'pbf';
const [lat, lon] = process.argv.slice(2).map(Number);
const n = 2 ** 14;
const x = Math.floor(((lon + 180) / 360) * n);
const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
const tj = await (await fetch('https://tiles.openfreemap.org/planet')).json();
const buf = new Uint8Array(await (await fetch(tj.tiles[0].replace('{z}', 14).replace('{x}', x).replace('{y}', y))).arrayBuffer());
const layer = new VectorTile(new PbfReader(buf)).layers.transportation;
const out = {};
for (let i = 0; i < layer.length; i++) {
  const f = layer.feature(i);
  if (f.type !== 2) continue;
  const o = (out[f.properties.class] ??= { n: 0 });
  o.n++;
  for (const [k, v] of Object.entries(f.properties)) if (k !== 'class') (o[k] ??= new Set()).add(v);
}
for (const [c, o] of Object.entries(out)) console.log(c, o.n, Object.entries(o).filter(([k]) => k !== 'n').map(([k, v]) => `${k}=${[...v].slice(0, 6).join('|')}`).join('  '));
