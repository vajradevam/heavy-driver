// Usage: node scripts/inspect-tile.mjs <lat> <lon>  — prints what a z14 tile contains
import { VectorTile } from '@mapbox/vector-tile';
import { PbfReader as Pbf } from 'pbf';
const [lat, lon] = process.argv.slice(2).map(Number);
const z = 14, n = 2 ** z;
const x = Math.floor(((lon + 180) / 360) * n);
const y = Math.floor(((1 - Math.asinh(Math.tan((lat * Math.PI) / 180)) / Math.PI) / 2) * n);
const tj = await (await fetch('https://tiles.openfreemap.org/planet')).json();
const url = tj.tiles[0].replace('{z}', z).replace('{x}', x).replace('{y}', y);
const buf = new Uint8Array(await (await fetch(url)).arrayBuffer());
console.log(url, buf.length, 'bytes');
const tile = new VectorTile(new Pbf(buf));
for (const [name, layer] of Object.entries(tile.layers)) {
  const counts = {};
  let sample;
  for (let i = 0; i < layer.length; i++) {
    const f = layer.feature(i);
    const k = `${f.properties.class ?? ''}/${f.properties.subclass ?? ''}/t${f.type}`;
    counts[k] = (counts[k] || 0) + 1;
    sample ??= f.properties;
  }
  console.log(`\n== ${name} (${layer.length}, extent ${layer.extent})`, JSON.stringify(counts));
  console.log('   sample:', JSON.stringify(sample).slice(0, 300));
}
