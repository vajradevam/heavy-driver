// Usage: node scripts/shot.mjs <outDir> <lat> <lon>
// Loads the game headlessly, goes to lat/lon through the on-screen form, checks the
// road restriction with a simulated drive, and saves screenshots.
import puppeteer from 'puppeteer-core';
const [outDir, lat, lon] = process.argv.slice(2);
const browser = await puppeteer.launch({
  executablePath: '/usr/bin/google-chrome-stable', headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist', '--window-size=1280,720'],
});
const page = await browser.newPage();
await page.setViewport({ width: 1280, height: 720 });
page.on('console', (m) => { if ((m.type() === 'error' || m.type() === 'warn') && !/favicon|404|WebSocket|GL Driver|GPU stall/.test(m.text())) console.log('[console]', m.type(), m.text().slice(0, 300)); });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://localhost:${process.env.PORT || 5173}/`, { waitUntil: 'domcontentloaded' });
await page.waitForFunction(() => window.__game, { timeout: 30000 });
await page.type('#lat', String(lat));
await page.type('#lon', String(lon));
await page.click('#coordForm button');
const ready = () => page.waitForFunction(() => { const w = window.__game.world; return w.stats().tiles >= 9 && !w.pending; }, { timeout: 120000 }).catch(() => console.log('timeout waiting for tiles'));
await new Promise((r) => setTimeout(r, 500));
await ready();
const info = () => page.evaluate(() => {
  const g = window.__game;
  return { stats: g.world.stats(), err: g.world.lastError, hud: document.getElementById('coords').textContent, road: document.getElementById('road').textContent,
    signs: g.signs.active.size, calls: g.renderer.info.render.calls, tris: g.renderer.info.render.triangles };
});
await new Promise((r) => setTimeout(r, 2500));
console.log(JSON.stringify(await info()));
await page.screenshot({ path: `${outDir}/1-spawn.png` });
for (const mode of ['day', 'night']) {
  await page.select('#timeMode', mode);
  await new Promise((r) => setTimeout(r, 2500));
  await page.screenshot({ path: `${outDir}/2-${mode}.png` });
  await page.keyboard.press('KeyC');
  await new Promise((r) => setTimeout(r, 2000));
  await page.screenshot({ path: `${outDir}/3-${mode}-far.png` });
  await page.keyboard.press('KeyC'); await page.keyboard.press('KeyC');
  await new Promise((r) => setTimeout(r, 1500));
}
console.log(JSON.stringify(await info()), 'night', await page.evaluate(() => window.__game.sky.night));
await browser.close();
