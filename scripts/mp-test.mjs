// Usage: node scripts/mp-test.mjs <outDir> — two separate browsers join one room; checks they see each other.
import puppeteer from 'puppeteer-core';
const outDir = process.argv[2];
const launch = () => puppeteer.launch({
  executablePath: '/usr/bin/google-chrome-stable', headless: 'new',
  args: ['--no-sandbox', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'],
});
const room = 'test' + Math.random().toString(36).slice(2, 8);
const open = async (browser, query) => {
  const page = await browser.newPage();
  await page.setViewport({ width: 1000, height: 600 });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto(`http://localhost:${process.env.PORT || 5173}/${query}#room=${room}`, { waitUntil: 'domcontentloaded' });
  return page;
};
const b1 = await launch(), b2 = await launch();
const p1 = await open(b1, '?lat=48.8738&lon=2.295');
await p1.waitForFunction(() => window.__game?.world.stats().tiles >= 9, { timeout: 90000 });
const p2 = await open(b2, '?lat=40.758&lon=-73.9855'); // starts in New York, should jump to player 1
const t0 = Date.now();
const ok = await p2.waitForFunction(() => window.__game?.net.peers.size > 0, { timeout: 60000 }).then(() => true, () => false);
console.log('peer connected:', ok, 'after', Date.now() - t0, 'ms');
if (ok) {
  await p2.waitForFunction(() => window.__game.world.stats().tiles >= 9 && !window.__game.world.pending, { timeout: 90000 }).catch(() => {});
  await new Promise((r) => setTimeout(r, 3000));
  await p1.bringToFront();
  const view = (p) => p.evaluate(() => {
    const g = window.__game, [lon, lat] = g.world.toLonLat(g.car.x, g.car.z);
    return { me: [lat.toFixed(4), lon.toFixed(4)], peers: [...g.net.peers.values()].map((q) => ({ name: q.name, dist: Math.hypot(q.x - g.car.x, q.z - g.car.z).toFixed(1) })), status: document.getElementById('netStatus').textContent };
  });
  console.log('p1', JSON.stringify(await view(p1)));
  console.log('p2', JSON.stringify(await view(p2)));
  // player 1 drives; player 2 should see the distance change
  await p1.evaluate(() => { const c = window.__game.car; c.x += Math.sin(c.heading) * 12; c.z -= Math.cos(c.heading) * 12; });
  await new Promise((r) => setTimeout(r, 4000));
  console.log('p2 after p1 moved 12 m ahead', JSON.stringify(await view(p2)));
  await p2.keyboard.press('KeyC');
  await new Promise((r) => setTimeout(r, 1500));
  await p2.screenshot({ path: `${outDir}/mp-p2.png` });
}
await b1.close(); await b2.close();
