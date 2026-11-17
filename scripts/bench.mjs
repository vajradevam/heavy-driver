// Usage: PORT=5199 node scripts/bench.mjs <lat> <lon> [quality ...]
// Measures frame time, draw calls and triangles in software rendering (a stand-in for a slow GPU).
import puppeteer from 'puppeteer-core';
const [lat, lon, ...qualities] = process.argv.slice(2);
const port = process.env.PORT || 5173;
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome-stable', headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
for (const q of qualities.length ? qualities : ['']) {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 720 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`http://localhost:${port}/?lat=${lat}&lon=${lon}`, { waitUntil: 'domcontentloaded' });
  await page.waitForFunction(() => window.__game, { timeout: 30000 });
  if (q) await page.select('#quality', q);
  await page.select('#timeMode', 'day');
  const t0 = Date.now();
  await page.waitForFunction(() => { const w = window.__game.world; return w.stats().tiles >= 1 && !w.pending; }, { timeout: 180000 }).catch(() => console.log('timeout'));
  const loadMs = Date.now() - t0;
  await new Promise((r) => setTimeout(r, 3000));
  const res = await page.evaluate(() => new Promise((resolve) => {
    const g = window.__game; const times = []; let last = performance.now();
    const step = (now) => {
      times.push(now - last); last = now;
      if (times.length < 40) requestAnimationFrame(step);
      else {
        times.sort((a, b) => a - b);
        const heap = performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : 0;
        resolve({ medianMs: +times[20].toFixed(1), calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles,
          tiles: g.world.stats().tiles, geometries: g.renderer.info.memory.geometries, heapMB: heap,
          canvas: `${g.renderer.domElement.width}x${g.renderer.domElement.height}` });
      }
    };
    requestAnimationFrame(step);
  }));
  console.log((q || 'current').padEnd(8), JSON.stringify({ loadMs, ...res }));
  await page.close();
}
await browser.close();
