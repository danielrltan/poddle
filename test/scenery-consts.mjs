// The scenery's two textures that were read back with getImageData on every load (sky.js sun halo, park.js ground grain): neither
// is read back now (a readback waits for everything queued in the GPU process), and this pins what replaced the readback:
//   1. in Node: park.js drawGrain(), run against a recording 2D context, hashes to GRAIN_SIG. A different grain (count, seed, colours,
//      sizes) fails here until GRAIN_LIN (park.js) is re-measured in Chrome: part 2 prints the measured value; paste it, then the new hash.
//   2. in real-GPU Chrome on test/scene-preview.html: the ground grain's mean linear red, read off the live canvas, is GRAIN_LIN (within
//      0.2 %: Chrome's CPU canvas lands 0.15 % off, a GPU canvas exactly), and the ground material's scalar is 1 / it; the sun halo's
//      alpha (dither included) is byte-for-byte Chrome's own radial gradient of sky.js SUN_STOPS, colour within 3 levels premultiplied.
//   3. a debug camera aimed at the sun (it is in no other shot: 117 deg off the menu's view): sun.png, plus sun-off.png without the sprite
//      (its footprint) and sun.json (where its centre and rim land on screen), in SCENERY_SHOTS (default test/ui-shots/scenery/).
// node test/scenery-consts.mjs   Env: SCENERY_PORT=8746 (one port: a static server)  SCENERY_ROOT=<a checkout> (what parts 2-3 serve,
// e.g. another tree for a before/after shot; part 1 always tests this one)  SCENERY_GPU=metal|swiftshader. Last line: SCENERY CONSTS PASS or N FAILURES.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { drawGrain, GRAIN_LIN } from '../web/scenery/park.js';
import { rng } from '../web/scenery/shared.js';

const GRAIN_SIG = '1c37208041e49f9d678d2c7424cdefc5e68a3a468dae6847e6945c8ef8966eff';   // sha256 of drawGrain's calls, below
const here = fileURLToPath(new URL('..', import.meta.url)), root = (process.env.SCENERY_ROOT || here).replace(/\/?$/, '/');
const port = +process.env.SCENERY_PORT || 8746, shots = process.env.SCENERY_SHOTS || here + 'test/ui-shots/scenery/', GPU = process.env.SCENERY_GPU || 'metal';
const sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; return c; };

// ---- 1. the grain's drawing, exactly
console.log('grain drawing');
{
  const log = [], ctx = { set fillStyle(v) { log.push('s' + v); }, fillRect(...a) { log.push('r' + a.join(',')); } };
  drawGrain(ctx, 256, 256, rng(3));
  const sig = crypto.createHash('sha256').update(log.join('\n')).digest('hex');
  ok(sig === GRAIN_SIG, `drawGrain is the drawing GRAIN_LIN was measured from (${log.length} calls, sha256 ${sig.slice(0, 16)}…)` + (sig === GRAIN_SIG ? '' : `: re-measure GRAIN_LIN (part 2 prints it), then GRAIN_SIG = '${sig}'`));
}

// ---- 2 + 3. in Chrome
const http = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
let browser = null; const bye = async c => { if (browser) await browser.close().catch(() => {}); http.kill(); process.exit(c); };
setTimeout(() => { console.log('SCENERY CONSTS FAIL (timeout)'); bye(2); }, 120000);
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('SCENERY CONSTS FAIL', e); bye(2); });
for (let i = 0; ; i++) { try { if ((await fetch(`http://127.0.0.1:${port}/test/scene-preview.html`)).ok) break; } catch {} if (i > 60) throw new Error('no static server on ' + port); await sleep(100); }
browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: true,
  args: GPU === 'swiftshader' ? ['--use-gl=angle', '--enable-unsafe-swiftshader'] : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage(); await page.setViewport({ width: 1280, height: 720, deviceScaleFactor: 1 });
const errs = []; page.on('pageerror', e => errs.push(String(e))); page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
await page.goto(`http://127.0.0.1:${port}/test/scene-preview.html?side=0&t=1&q=high&clean=1&game=${port}&bridge=${port}`, { waitUntil: 'load' });   // every page names its own ports
await page.waitForFunction(() => document.title.startsWith('ready'), { timeout: 60000 });
await page.waitForFunction(() => window.__scenery, { timeout: 30000 });
ok(!errs.length, 'the page runs clean' + (errs.length ? ': ' + errs.slice(0, 3).join(' | ') : ''));

console.log('ground grain (' + root + ', ' + GPU + ')');
const g = await page.evaluate(() => { let m = null; __scenery.root.traverse(o => { if (o.name === 'ground') m = o.material; });
  const c = m.map.image, d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let lin = 0;
  for (let i = 0; i < d.length; i += 4) lin += Math.pow(d[i] / 255, 2.2); lin /= c.width * c.height;   // the measurement park.js used to make on every load
  return { lin, scalar: m.color.r }; });
console.log(`  measured ${g.lin} (${g.lin === GRAIN_LIN ? 'exactly GRAIN_LIN' : ((g.lin / GRAIN_LIN - 1) * 100).toFixed(4) + ' % off GRAIN_LIN'}), material scalar ${g.scalar}`);
ok(Math.abs(g.lin / GRAIN_LIN - 1) < 0.002, `the grain's mean linear red is GRAIN_LIN ${GRAIN_LIN} within 0.2 %`);
ok(g.scalar === 1 / GRAIN_LIN || g.scalar === 1 / g.lin, 'the ground material is 1 / that mean (its own measurement in a tree that still reads back)');

console.log('sun halo');
const s = await page.evaluate(async () => {
  let sun = null; __scenery.root.traverse(o => { if (o.isSprite && o.material.map) sun = o; }); if (!sun) return null;
  const c = sun.material.map.image, w = c.width, tex = c.getContext('2d').getImageData(0, 0, w, w).data;
  let STOPS; try { STOPS = (await import('/web/scenery/sky.js')).SUN_STOPS; } catch {} if (!STOPS) return { w, skip: true };   // a tree from before the change: the shot only
  const { rng } = await import('/web/scenery/shared.js'), pal = __scenery.S.pal, h = w / 2;
  const r = document.createElement('canvas'); r.width = r.height = w; const x = r.getContext('2d'), gr = x.createRadialGradient(h, h, 0, h, h, h);
  for (const [o, k, al] of STOPS) gr.addColorStop(o, `rgba(${parseInt(pal[k].slice(1, 3), 16)},${parseInt(pal[k].slice(3, 5), 16)},${parseInt(pal[k].slice(5, 7), 16)},${al})`);
  x.fillStyle = gr; x.fillRect(0, 0, w, w); const im = x.getImageData(0, 0, w, w), d = im.data, rnd = rng(9);
  for (let i = 3; i < d.length; i += 4) if (d[i] > 0 && d[i] < 250) d[i] = Math.max(0, Math.min(255, d[i] + (rnd() * 2 - 1) * 1.2));   // the old sky.js, verbatim
  x.putImageData(im, 0, 0); const ref = x.getImageData(0, 0, w, w).data;   // through the canvas, as the texture went
  let alpha = 0, pm = 0; for (let i = 0; i < ref.length; i += 4) { if (ref[i + 3] !== tex[i + 3]) alpha++; for (let k = 0; k < 3; k++) pm = Math.max(pm, Math.abs(ref[i + k] * ref[i + 3] - tex[i + k] * tex[i + 3]) / 255); }
  return { w, alpha, pm };
});
if (!ok(s, 'the sun sprite is built (q=high)')) await bye(1);
if (s.skip) console.log('  (this tree has no SUN_STOPS: texture check skipped)');
else { ok(s.alpha === 0, `the halo's alpha is Chrome's own gradient + the same dither, byte for byte (${s.alpha} of ${s.w * s.w} differ)`);
  ok(s.pm <= 3, `its colour, premultiplied, within 3 levels of Chrome's (max ${s.pm.toFixed(2)}: Chrome dithers a gradient's colour by about a level, the computed halo does not)`); }

console.log('sun shot');
fs.mkdirSync(shots, { recursive: true });
const aim = on => page.evaluate(on => { const d = __scene._dbg, cam = d.camera; let sun = null; __scenery.root.traverse(o => { if (o.isSprite && o.material.map) sun = o; });
  cam.position.set(0, 1.7, 12); cam.fov = 70; cam.updateProjectionMatrix(); cam.lookAt(cam.position.clone().addScaledVector(__scenery.S.sunDir, 400));   // the sun dead centre
  __scenery.update(0, 10, cam); sun.visible = on; for (let i = 0; i < 3; i++) d.renderer.render(d.scene, cam);   // update(): the sprite and dome follow the camera
  const p = sun.getWorldPosition(new THREE.Vector3()).project(cam), H = d.renderer.domElement.clientHeight, W = d.renderer.domElement.clientWidth, f = (H / 2) / Math.tan(cam.fov * Math.PI / 360);
  return { ndc: [p.x, p.y, p.z], cx: (p.x + 1) / 2 * W, cy: (1 - p.y) / 2 * H, rimPx: f * (sun.scale.x / 2) / sun.position.distanceTo(cam.position), W, H }; }, on);
const on = await aim(true); await page.screenshot({ path: shots + 'sun.png' });
await aim(false); await page.screenshot({ path: shots + 'sun-off.png' }); await aim(true);
fs.writeFileSync(shots + 'sun.json', JSON.stringify(on));
ok(Math.abs(on.ndc[0]) < 0.01 && Math.abs(on.ndc[1]) < 0.01 && on.ndc[2] < 1, `the sun is in the shot, centred (halo radius ${on.rimPx.toFixed(1)} px): ${shots}sun.png`);

console.log(fails ? `SCENERY CONSTS ${fails} FAILURES` : 'SCENERY CONSTS PASS');
await bye(fails ? 1 : 0);
