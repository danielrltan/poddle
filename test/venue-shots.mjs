// The two venues, pictured: scene.setVenue('stadium') (ranked, web/scenery/stadium.js) next to the park, from the REAL page (?skiptitle=1&uitest=1,
// window.__scene) in the broadcast view and from test/scene-preview.html (deterministic frame) in the play and broadcast views. Also counts
// draw calls / triangles per venue. LOOK at the PNGs (test/ui-shots/venue-*.png): the numbers cannot tell an arena from a car park.
//   node test/venue-shots.mjs [port]   (8482 by default; it takes port..port+3)
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)), P0 = +process.argv[2] || 8482, WEB = P0, ROOT = P0 + 1, G = P0 + 2, B = P0 + 3, out = root + 'test/ui-shots/', sleep = ms => new Promise(r => setTimeout(r, ms));
const procs = [
  spawn('python3', ['-m', 'http.server', String(WEB), '--bind', '127.0.0.1', '-d', 'web'], { cwd: root, stdio: 'ignore' }),
  spawn('python3', ['-m', 'http.server', String(ROOT), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' }),
  spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: G }, stdio: 'ignore' }),
  spawn('node', ['test/fake-bridge.mjs', String(B)], { cwd: root, stdio: 'ignore' }),
];
let browser = null; const bye = async c => { if (browser) await browser.close().catch(() => {}); for (const p of procs) p.kill('SIGKILL'); process.exit(c); };   // (the game server shrugs off SIGTERM)
setTimeout(() => { console.log('VENUE SHOTS FAIL (timeout)'); bye(2); }, 180000);
await sleep(1500);
browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const errs = [], fails = [], ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails.push(m); };
async function open(url, w = 1440, h = 900) {
  const page = await browser.newPage(); await page.setViewport({ width: w, height: h });
  await page.evaluateOnNewDocument(() => { try { localStorage.setItem('poddle.camPrimer', 'allow'); } catch { /* */ } });
  page.on('console', m => { if (m.type() === 'error' || m.type() === 'warning') errs.push(m.text()); }); page.on('pageerror', e => errs.push(String(e)));
  await page.goto(url, { waitUntil: 'load' }); return page;
}
const waitVenue = (page, v) => page.waitForFunction(n => window.__scenery && window.__scenery.venue() === n, { timeout: 20000 }, v).then(() => true, () => false);
const cost = page => page.evaluate(() => { const sc = __scene, d = sc._dbg, R = d.renderer; let ms = 4e7; d.renderer.info.autoReset = false;   // three resets its counters AFTER the shadow pass: count by hand
  for (let i = 0; i < 10; i++) sc.render(ms += 40); let calls = 0, tris = 0; const N = 40, t0 = performance.now();
  for (let i = 0; i < N; i++) { R.info.reset(); sc.render(ms += 40); calls += R.info.render.calls; tris += R.info.render.triangles; }
  R.info.autoReset = true; const sy = window.__scenery; return { ms: +((performance.now() - t0) / N).toFixed(2), calls: calls / N, tris: Math.round(tris / N), scenery: sy ? { venue: sy.venue(), calls: sy.drawCalls(), tris: sy.triangles(), texMB: sy.textureMB(), census: sy.census(), quality: sy.quality } : null }; });

// ---------- 1. the real page: setVenue('stadium') then back to the park, broadcast view, 1440x900 ----------
console.log('real page');
{ const page = await open(`http://127.0.0.1:${WEB}/?bridge=${B}&game=${G}&skiptitle=1&uitest=1&autobot=1`);
  await page.waitForFunction(() => window.__scene && window.__scenery, { timeout: 20000 }).catch(() => errs.push('scenery never arrived on the real page'));
  const before = await page.evaluate(() => ({ venue: __scene.venue(), body: document.body.dataset.venue }));
  ok(before.venue === 'park' && before.body === 'park', `starts in the park (scene.venue() ${before.venue}, body[data-venue] ${before.body})`);
  const t0 = Date.now(); await page.evaluate(() => __scene.setVenue('stadium')); const arrived = await waitVenue(page, 'stadium'); const took = Date.now() - t0;
  const after = await page.evaluate(() => ({ venue: __scene.venue(), body: document.body.dataset.venue, sky: __scene._dbg.scene.children.filter(o => o.userData.sceneryRoot).map(o => o.name + ':' + o.visible).join(' ') }));
  ok(arrived && after.venue === 'stadium' && after.body === 'stadium', `setVenue('stadium'): scenery shown in ${took} ms, body[data-venue]=${after.body}, roots ${after.sky}`);
  // broadcast picture, the HUD out of the way (the page is on its calibrate screen: force the camera the way the tests do)
  const stage = async name => { await page.evaluate(() => { for (const el of document.body.children) if (el.id !== 'stage') el.style.visibility = 'hidden'; __scene.setSide(null); __scene.setView('broadcast'); __scene.setMenu(false); __scene.resize(); });
    await sleep(1200); await page.screenshot({ path: out + name }); };
  await stage('venue-stadium.png'); const cs = await cost(page); console.log('    stadium:', JSON.stringify(cs));
  await page.evaluate(() => __scene.setVenue('park')); const back = await waitVenue(page, 'park'); await stage('venue-park.png'); const cp = await cost(page); console.log('    park:   ', JSON.stringify(cp));
  ok(back && cp.scenery.venue === 'park', 'setVenue(\'park\') swaps back (both venues built: a one-frame swap)');
  ok(cs.calls <= cp.calls * 1.5 + 2, `stadium frame ${cs.calls} draws / ${cs.tris} tris vs park ${cp.calls} / ${cp.tris} (scenery alone: ${cs.scenery.calls} vs ${cp.scenery.calls} draws)`);
  const same = await page.evaluate(() => __scene.setVenue('park') === 'park' && __scene.setVenue('nope') === 'park' && __scene.venue() === 'park');
  ok(same, 'setVenue of the same or an unknown venue changes nothing and answers the venue in force');
  await page.close(); }

// ---------- 2. the harness: deterministic frames of both venues, play view and broadcast, and the low-quality path ----------
console.log('preview');
const VIEWQ = { play: 'side=0', broadcast: 'spectate=1&view=broadcast', menu: 'attract=1&menu=1', free: 'spectate=1&view=free' };
for (const [venue, q, views] of [['stadium', '', ['broadcast', 'play', 'menu', 'free']], ['park', '', ['broadcast', 'play']], ['stadium', 'low', ['broadcast', 'play']]]) for (const view of views) {
  const url = `http://127.0.0.1:${ROOT}/test/scene-preview.html?${VIEWQ[view]}&matt=1&opp=human&t=3.9&venue=${venue}${q ? '&q=' + q : ''}&clean=1&game=${ROOT}&bridge=${ROOT}`;
  const page = await open(url); await page.waitForFunction(() => document.title.startsWith('ready'), { timeout: 60000 }).catch(() => errs.push('never ready: ' + url));
  const arrived = await waitVenue(page, venue); await page.evaluate(() => { for (let i = 1; i <= 4; i++) __scene.render(1e7 + i * 40); });
  const name = `venue-${venue}${q ? '-low' : ''}-${view}.png`; await page.screenshot({ path: out + name }); const c = await cost(page);
  ok(arrived && c.scenery && c.scenery.venue === venue, `${name}: ${c.calls} draws / ${c.tris} tris a frame (${c.ms} ms), scenery ${c.scenery && c.scenery.calls} draws ${JSON.stringify(c.scenery && c.scenery.census)}`);
  await page.close();
}
// ---------- 3. the fallback path: web/scenery/ never loads (blocked), so scene.js's plain look must carry the venue on its own ----------
console.log('fallback (no scenery)');
{ const page = await browser.newPage(); await page.setViewport({ width: 1440, height: 900 }); await page.setRequestInterception(true);
  page.on('request', r => (/\/scenery\//.test(r.url()) ? r.abort() : r.continue())); page.on('pageerror', e => errs.push('fallback: ' + e));
  await page.goto(`http://127.0.0.1:${ROOT}/test/scene-preview.html?spectate=1&view=broadcast&matt=1&opp=human&t=3.9&clean=1&game=${ROOT}&bridge=${ROOT}`, { waitUntil: 'load' });
  await page.waitForFunction(() => document.title.startsWith('ready'), { timeout: 60000 }).catch(() => errs.push('fallback never ready'));
  const r = await page.evaluate(() => { const d = __scene._dbg; __scene.setVenue('stadium'); for (let i = 1; i <= 4; i++) __scene.render(1e7 + i * 40);
    return { venue: __scene.venue(), scenery: !!window.__scenery, fog: '#' + d.scene.fog.color.getHexString(), sun: d.scene.children.find(o => o.isDirectionalLight).intensity, body: document.body.dataset.venue }; });
  await page.screenshot({ path: out + 'venue-stadium-fallback.png' });
  ok(r.venue === 'stadium' && !r.scenery && r.fog === '#0b1222' && r.sun < 2 && r.body === 'stadium', `no scenery: setVenue('stadium') still gives the night plain look (fog ${r.fog}, sun ${r.sun}, body ${r.body})`);
  await page.close(); }
const bad = errs.filter(e => !/favicon|ERR_CONNECTION|WebSocket|ws:|net::|Autoplay|AudioContext/i.test(e));
ok(bad.length === 0, bad.length ? 'console errors: ' + bad.slice(0, 5).join(' | ') : 'no console errors');
console.log(fails.length ? `VENUE SHOTS FAIL (${fails.length})` : 'VENUE SHOTS OK');
await bye(fails.length ? 1 : 0);
