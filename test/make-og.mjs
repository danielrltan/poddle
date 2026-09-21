// The share card and the icons, from scratch:   node test/make-og.mjs [port]   (9000 by default; needs Chrome, or CHROME=/path/to/chrome)
//   web/og.jpg               1200x630: the real scene (test/scene-preview.html driving web/scene.js, no servers) under the site's wordmark, with the game's own AirPod (web/podview.js) in its glass tile, composed in test/og-card.html
//   web/favicon.svg          the pickleball "o" of the logo, written from BALL below
//   web/favicon-32.png       the svg at 32, transparent
//   web/favicon.ico          32 and 48 px PNGs in an ICO container, for the unfurlers and feed readers that ask for /favicon.ico without reading the page
//   web/apple-touch-icon.png 180, opaque, the site's light background (iOS rounds the corners itself)
//   web/icon-192.png, web/icon-512.png   opaque and full bleed, the ball inside the centre 80 percent circle, so the 512 also works as a maskable icon
// Intermediates and the look-at-it checks (300 px wide, centre square, favicon on light and dark) land in test/ui-shots/seo/ (git-ignored). LOOK at them.
// Serves the repo itself on its own port, and every page carries &game= and &bridge= so nothing can reach a live server. After changing the picture, raise ?v= on og:image.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)), web = root + 'web/', seo = root + 'test/ui-shots/seo/', port = +process.argv[2] || 9000;
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- the shot. A rally against Matt seen from just behind the player's shoulder: t is a freeze-frame of the harness's fake rally (the player hits at 11.57 s),
//      look is px,py,pz,tx,ty,tz,fov. Env T= and LOOK= override them while hunting for an angle.
const SHOT = { t: process.env.T || '11.95', look: process.env.LOOK || '2.6,1.8,13.6,-1.55,1.8,0,30' };
const JPEG_QUALITY = +process.env.Q || 86, BG = '#dfeef6';       // BG: html,body in web/ui.css

// ---- the ball: web/ui.css .logo-ball, turned into circles. Its CSS gradients measure their radius to the farthest corner; these are about the same sizes as fractions of the width, evened out and a shade deeper so the holes survive at 16 px.
const BALL = { holes: [[.30, .32, .085], [.62, .24, .085], [.50, .52, .08], [.22, .62, .08], [.78, .54, .08], [.48, .82, .08]] };
function ballSvg() {
  const S = 64, R = 30.5, o = (S - 2 * R) / 2, f = v => +v.toFixed(2);
  const holes = BALL.holes.map(([x, y, r]) => `<circle cx="${f(o + x * 2 * R)}" cy="${f(o + y * 2 * R)}" r="${f(r * 2 * R)}"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${S} ${S}"><title>Poddle</title>
<defs><radialGradient id="b" cx=".34" cy=".28" r=".977"><stop offset="0" stop-color="#fbffa8"/><stop offset=".58" stop-color="#e6f03c"/><stop offset="1" stop-color="#c5d124"/></radialGradient>
<linearGradient id="s" x1="0" y1="0" x2="0" y2="1"><stop offset=".62" stop-color="#5a6e00" stop-opacity="0"/><stop offset="1" stop-color="#5a6e00" stop-opacity=".3"/></linearGradient></defs>
<circle cx="32" cy="32" r="${R}" fill="url(#b)"/><circle cx="32" cy="32" r="${R}" fill="url(#s)"/>
<g fill="#a9b912">${holes}</g>
<circle cx="32" cy="32" r="${R - .55}" fill="none" stroke="#a3b310" stroke-width="1.1"/>
</svg>
`;
}
const iconPage = (svg, size, mark, bg) => `<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;width:${size}px;height:${size}px;background:${bg || 'transparent'}}
svg{position:absolute;left:${(size - mark) / 2}px;top:${(size - mark) / 2}px;width:${mark}px;height:${mark}px}</style></head><body>${svg}</body></html>`;

fs.mkdirSync(seo, { recursive: true });
const http = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
let browser = null; const bye = async c => { if (browser) await browser.close().catch(() => {}); http.kill(); process.exit(c); };
setTimeout(() => { console.log('MAKE OG FAIL (timeout)'); bye(2); }, 180000);
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('MAKE OG FAIL', e); bye(2); });
await sleep(700);
browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--force-color-profile=srgb'] });
const errs = [];
async function open(url, w, h, scale = 1) {
  const page = await browser.newPage(); await page.setViewport({ width: w, height: h, deviceScaleFactor: scale });
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', e => errs.push(String(e)));
  if (url) await page.goto(url, { waitUntil: 'load' });
  return page;
}

// ---- 1. the scene, at 2x so the card downsamples it (smoother edges than the canvas's own antialiasing)
{
  const q = `spectate=1&matt=1&view=broadcast&t=${SHOT.t}&look=${SHOT.look}&clean=1&game=${port}&bridge=${port}`;
  const page = await open(`http://127.0.0.1:${port}/test/scene-preview.html?${q}`, 1200, 630, 2);
  await page.waitForFunction(() => document.title.startsWith('ready'), { timeout: 60000 });
  await page.waitForFunction(() => window.__scenery, { timeout: 20000 });            // the palms, the hills and the street arrive after the first frame
  await page.evaluate(look => { const d = __scene._dbg, L = look.split(',').map(Number);      // the harness aimed the camera before the scenery was in: draw that frame again
    d.camera.position.set(L[0], L[1], L[2]); d.camera.lookAt(L[3], L[4], L[5]); d.camera.fov = L[6]; d.camera.updateProjectionMatrix();
    for (let i = 0; i < 3; i++) d.renderer.render(d.scene, d.camera); }, SHOT.look);
  await page.screenshot({ path: seo + 'og-scene.png' }); await page.close();
}

// ---- 2. the card
{
  const page = await open(`http://127.0.0.1:${port}/test/og-card.html?game=${port}&bridge=${port}`, 1200, 630, 1);
  await page.waitForFunction(() => document.title !== 'og card', { timeout: 20000 });
  const title = await page.title(); if (title !== 'ready') throw new Error('og-card.html: ' + title);
  await page.screenshot({ path: web + 'og.jpg', type: 'jpeg', quality: JPEG_QUALITY });
  await page.screenshot({ path: seo + 'og-full.png' });
  // the checks: a chat-sized preview and a centre-square crop, both drawn by the browser from the jpeg itself
  const check = await open(null, 300, 158, 1), src = `http://127.0.0.1:${port}/web/og.jpg?${Date.now()}`;
  await check.setContent(`<body style="margin:0;background:#000"><img src="${src}" style="display:block;width:300px;height:158px">`, { waitUntil: 'load' });
  await check.screenshot({ path: seo + 'og-300.png' });
  await check.setViewport({ width: 630, height: 630, deviceScaleFactor: 1 });
  await check.setContent(`<body style="margin:0;overflow:hidden;background:#000"><img src="${src}" style="display:block;margin-left:-285px">`, { waitUntil: 'load' });
  await check.screenshot({ path: seo + 'og-square.png' });
  await check.setViewport({ width: 158, height: 158, deviceScaleFactor: 1 });
  await check.setContent(`<body style="margin:0;overflow:hidden;background:#000"><img src="${src}" style="display:block;height:158px;margin-left:-71.5px">`, { waitUntil: 'load' });
  await check.screenshot({ path: seo + 'og-square-158.png' });
  await check.close(); await page.close();
}

// ---- 3. the icons
{
  const svg = ballSvg(); fs.writeFileSync(web + 'favicon.svg', svg);
  const page = await open(null, 64, 64, 1);
  const shot = async (file, size, mark, bg) => { await page.setViewport({ width: size, height: size, deviceScaleFactor: 1 }); await page.setContent(iconPage(svg, size, mark, bg), { waitUntil: 'load' });
    await page.screenshot({ path: file, omitBackground: !bg }); };
  await shot(web + 'favicon-32.png', 32, 32, null);
  { // favicon.ico: a 6 byte header, one 16 byte entry per picture, then the PNGs as they are (every browser since Vista-era IE reads PNG inside ICO)
    await shot(seo + 'favicon-48.png', 48, 48, null);
    const pics = [[32, fs.readFileSync(web + 'favicon-32.png')], [48, fs.readFileSync(seo + 'favicon-48.png')]], head = Buffer.alloc(6 + 16 * pics.length); let at = head.length;
    head.writeUInt16LE(1, 2); head.writeUInt16LE(pics.length, 4);
    pics.forEach(([n, png], i) => { const o = 6 + 16 * i; head[o] = n; head[o + 1] = n; head.writeUInt16LE(1, o + 4); head.writeUInt16LE(32, o + 6); head.writeUInt32LE(png.length, o + 8); head.writeUInt32LE(at, o + 12); at += png.length; });
    fs.writeFileSync(web + 'favicon.ico', Buffer.concat([head, ...pics.map(p => p[1])]));
  }
  await shot(web + 'apple-touch-icon.png', 180, 126, BG);         // the ball at 70 percent
  await shot(web + 'icon-192.png', 192, 128, BG);                 // two thirds: inside the maskable safe circle (80 percent) with room to spare
  await shot(web + 'icon-512.png', 512, 340, BG);
  // the check: the favicon as a tab would draw it, 16 and 32 px, from the svg and from the png, on a light and a dark tab strip (each beside its own pixels at 5x)
  const uri = 'data:image/svg+xml;base64,' + Buffer.from(svg).toString('base64'), png = 'data:image/png;base64,' + fs.readFileSync(web + 'favicon-32.png').toString('base64');
  const row = bg => `<div style="background:${bg};padding:16px;display:flex;gap:20px;align-items:center">` + [[uri, 16], [uri, 32], [png, 16], [png, 32]].map(([u, s]) =>
    `<img src="${u}" width="${s}" height="${s}"><canvas data-src="${u}" width="${s}" height="${s}" style="width:${s * 5}px;height:${s * 5}px;image-rendering:pixelated"></canvas>`).join('') + '</div>';
  await page.setViewport({ width: 760, height: 390, deviceScaleFactor: 1 });
  await page.setContent(`<body style="margin:0">${row('#f1f3f4')}${row('#202124')}</body>`, { waitUntil: 'load' });
  await page.evaluate(() => Promise.all([...document.querySelectorAll('canvas')].map(c => new Promise(done => { const i = new Image(); i.onload = () => { c.getContext('2d').drawImage(i, 0, 0, c.width, c.height); done(); }; i.src = c.dataset.src; }))));      // the real pixels of each size, blown up 5x
  await page.screenshot({ path: seo + 'favicon-check.png' }); await page.close();
}

if (errs.length) console.log('page errors:\n  ' + errs.join('\n  '));
console.log(`shot t=${SHOT.t} look=${SHOT.look} jpeg q=${JPEG_QUALITY}`);
for (const f of ['og.jpg', 'favicon.svg', 'favicon-32.png', 'favicon.ico', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png']) { const n = fs.statSync(web + f).size; console.log(`  web/${f.padEnd(22)} ${String(n).padStart(7)} bytes  ${(n / 1024).toFixed(1)} KB`); }
const og = fs.statSync(web + 'og.jpg').size, bad = og > 500000 || errs.length;
console.log(og > 500000 ? 'MAKE OG FAIL: og.jpg is over 500 KB, lower Q' : og > 300000 ? 'og.jpg is over the 300 KB aim (under the 500 KB cap)' : 'og.jpg is under the 300 KB aim');
console.log('checks: test/ui-shots/seo/og-full.png og-300.png og-square.png og-square-158.png favicon-check.png');
await bye(bad ? 1 : 0);
