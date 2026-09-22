// The ball trail at five powers, rendered by the real scene (test/scene-preview.html, no servers) in headless Chrome.
// Usage: node test/trail-shots.mjs [tag] [port]   -> test/ui-shots/trail-<tag>.png (a contact sheet) and one line per shot:
// how many pixels the trail changes, how far (mean |dRGB|, 0-255) and the mean colour it leaves there. LOOK at the sheet too.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)), tag = process.argv[2] || 'now', port = +process.argv[3] || 8741, out = root + 'test/ui-shots/';
const sleep = ms => new Promise(r => setTimeout(r, ms)), NS = [0.15, 0.35, 0.55, 0.75, 0.95], SPIN = +process.env.SPIN || 0;   // SPIN=0.8: a sliced ball (the spin streaks must still read over the trail)
fs.mkdirSync(out, { recursive: true });
const http = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
await sleep(700);
const browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader'] });
const VIEWS = { pov: 'side=0&opp=human', broadcast: 'spectate=1&opp=human&view=broadcast' }, tiles = [];
try {
  for (const [vn, q] of Object.entries(VIEWS)) for (const n of NS) {
    const page = await browser.newPage(); await page.setViewport({ width: 640, height: 400 });
    page.on('pageerror', e => console.log('pageerror', String(e)));
    await page.goto(`http://127.0.0.1:${port}/test/scene-preview.html?${q}&t=0.02&clean=1&game=${port}&bridge=${port}`, { waitUntil: 'load' });
    await page.waitForFunction(() => document.title.startsWith('ready'), { timeout: 60000 });
    await page.waitForFunction(() => window.__scenery, { timeout: 20000 }).catch(() => {});
    const r = await page.evaluate((n, vn, spin) => {
      const sc = __scene, d = sc._dbg, G = 9.81, R = 0.11, lerp = (a, b, t) => a + (b - a) * t;
      const p0 = [vn === 'pov' ? 2.4 : 0.7, 1.0, -6.3], tx = vn === 'pov' ? -2.4 : -0.6, tz = lerp(4.7, 3.4, n), T = lerp(1.15, 0.78, n);           // side 1 drives it at side 0 (server/game.js solve, roughly); cross-court in the player's view, or its trail is end-on
      const v0 = [(tx - p0[0]) / T, (R - p0[1]) / T + 0.5 * G * T, (tz - p0[2]) / T], at = t => [p0[0] + v0[0] * t, p0[1] + v0[1] * t - 0.5 * G * t * t, p0[2] + v0[2] * t], vel = t => [v0[0], v0[1] - G * t, v0[2]];
      let ms = 1e6; for (let i = 0; i < 30; i++) { ms += 1000 / 60; sc.updateBall(p0, [0, 0, 0], true, ms); sc.render(ms); }
      sc.onEvent({ type: 'hit', side: 1, n, p: p0, kind: n >= 0.76 ? 'smash' : 'drive', spin });
      const until = (vn === "pov" ? 0.5 : 0.55) * T; for (let t = 0; t <= until; t += 1 / 60) { ms += 1000 / 60; sc.updateBall(at(t), vel(t), true, ms); sc.render(ms); }
      const trail = []; d.scene.traverse(o => { if (o.isMesh && (/^trail/.test(o.name) || (o.geometry.index && o.geometry.index.count === 126 && o.geometry.attributes.color))) trail.push(o); });
      const cv = d.renderer.domElement, grab = () => { const c = document.createElement('canvas'); c.width = cv.width; c.height = cv.height; const x = c.getContext('2d'); x.drawImage(cv, 0, 0); return x.getImageData(0, 0, c.width, c.height).data; };
      d.renderer.render(d.scene, d.camera); const A = grab();
      trail.forEach(o => (o.userData.v = o.visible, o.visible = false)); d.renderer.render(d.scene, d.camera); const B = grab();
      trail.forEach(o => (o.visible = o.userData.v)); d.renderer.render(d.scene, d.camera);
      let cnt = 0, dsum = 0; const col = [0, 0, 0], bg = [0, 0, 0];
      for (let i = 0; i < A.length; i += 4) { const dd = (Math.abs(A[i] - B[i]) + Math.abs(A[i + 1] - B[i + 1]) + Math.abs(A[i + 2] - B[i + 2])) / 3;
        if (dd > 6) { cnt++; dsum += dd; for (let k = 0; k < 3; k++) { col[k] += A[i + k]; bg[k] += B[i + k]; } } }
      const m = a => a.map(x => Math.round(x / Math.max(1, cnt)));
      return { meshes: trail.length, px: cnt, dRGB: +(dsum / Math.max(1, cnt)).toFixed(1), col: m(col), bg: m(bg), hot: +(d.ball.hot || 0).toFixed(2),
        at: (() => { const v = d.ballMesh.position.clone().project(d.camera); return [(v.x + 1) / 2 * cv.width, (1 - v.y) / 2 * cv.height]; })() };
    }, n, vn, SPIN);
    const file = `${out}trail-${tag}-${vn}-${n}.png`; await page.screenshot({ path: file });
    console.log(`${tag} ${vn.padEnd(9)} n ${n.toFixed(2)}  hot ${r.hot.toFixed(2)}  trail px ${String(r.px).padStart(5)}  mean |dRGB| ${String(r.dRGB).padStart(5)}  colour rgb(${r.col}) over rgb(${r.bg})  (${r.meshes} mesh)`);
    const prev = tiles[tiles.length - 1];
    if (prev && prev.vn === vn) console.log(`${' '.repeat(tag.length)} ${vn.padEnd(9)} ${prev.n} -> ${n}: trail colour moved ${r.col.map((x, k) => x - prev.col[k]).join(',')} (mean |d| ${(r.col.reduce((s, x, k) => s + Math.abs(x - prev.col[k]), 0) / 3).toFixed(0)})`);
    tiles.push({ vn, n, file, col: r.col, at: r.at }); await page.close();
  }
  // contact sheet: a row per view, a column per power
  const sheet = await browser.newPage(); await sheet.setViewport({ width: 5 * 640, height: 2 * 630 });
  const img = f => 'data:image/png;base64,' + fs.readFileSync(f).toString('base64');
  await sheet.setContent(`<body style="margin:0;background:#111;display:grid;grid-template-columns:repeat(5,640px);font:bold 22px system-ui;color:#fff">${tiles.map(t =>
    `<div style="position:relative;height:630px"><img src="${img(t.file)}" style="display:block;height:400px"><div style="height:200px;margin-top:2px;background:url(${img(t.file)}) no-repeat;background-size:${640 * 2.5}px ${400 * 2.5}px;background-position:${-(t.at[0] * 2.5 - 320)}px ${-(t.at[1] * 2.5 - 100)}px"></div><div style="position:absolute;left:10px;bottom:2px">${tag} ${t.vn} n=${t.n}</div></div>`).join('')}</body>`);
  await sheet.screenshot({ path: `${out}trail-${tag}.png` }); console.log('sheet', `${out}trail-${tag}.png`);
} finally { await browser.close(); http.kill(); }
