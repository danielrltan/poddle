// Screenshot helper for the UI mock. Serves the repo root on a port from the 8240 block (in-process, closed on exit).
// Usage: node test/ui-shots/shoot.mjs [screen ...]        (no args = every screen + the contact sheet, at both sizes)
//        node test/ui-shots/shoot.mjs --url /path.html --out name.png   (any page, 1440x900)
import http from 'http'; import fs from 'fs'; import path from 'path';
import puppeteer from 'puppeteer-core';
const root = new URL('../..', import.meta.url).pathname, PORT = +process.env.UI_PORT || 8240, out = root + 'test/ui-shots/';
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml', '.txt': 'text/plain' };
const EXTRA = process.env.UI_EXTRA_ROOT || '';
const srv = http.createServer((q, r) => {
  const u = decodeURIComponent(new URL(q.url, 'http://x').pathname);
  let f = path.join(root, u); if (!f.startsWith(root)) { r.writeHead(403); return r.end(); }
  if (EXTRA && u.startsWith('/_x/')) f = path.join(EXTRA, u.slice(4));
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end('nf'); } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
}).listen(PORT, '127.0.0.1');
const SCREENS = ['title', 'connect', 'calibrate1', 'calibrate2', 'calibrate-error', 'calibrate-settle', 'calibrate-done', 'hud-airpod-lost', 'hud', 'hud-callout', 'hud-point-you', 'hud-point-enemy', 'serve-prompt', 'match-win', 'match-lose', 'server-down', 'game-full', 'hud-stats'];
const SIZES = [[1440, 900], [1280, 720]];
const args = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--hide-scrollbars'] });
const errs = [];
async function shot(url, file, w, h, full) {
  const page = await browser.newPage(); await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  page.on('console', m => { if (m.type() === 'error') errs.push(`${file}: ${m.text()}`); });
  page.on('pageerror', e => errs.push(`${file}: PAGEERROR ${e.message}`));
  page.on('requestfailed', q => errs.push(`${file}: FAILED ${q.url()}`));
  page.on('response', s => { if (s.status() >= 400) errs.push(`${file}: ${s.status()} ${s.url()}`); });
  await page.goto(`http://127.0.0.1:${PORT}${url}`, { waitUntil: 'networkidle0', timeout: 20000 });
  await page.waitForFunction(() => document.title.startsWith('ready') || document.body.classList.contains('sheet'), { timeout: 10000 });
  await page.evaluate(() => document.fonts.ready);
  await new Promise(r => setTimeout(r, 350));
  // overflow check: anything marked data-fit must sit fully inside the viewport
  const clipped = await page.evaluate(() => [...document.querySelectorAll('[data-fit]')].filter(e => { const b = e.getBoundingClientRect(); return b.width && (b.left < 0 || b.top < 0 || b.right > innerWidth + .5 || b.bottom > innerHeight + .5); }).map(e => e.id || e.className));
  if (clipped.length) errs.push(`${file}: CLIPPED ${clipped.join(', ')}`);
  await page.screenshot({ path: out + file, fullPage: !!full }); await page.close();
}
try {
  const ui = args.indexOf('--url');
  if (ui >= 0) await shot(args[ui + 1], args[args.indexOf('--out') + 1] || 'page.png', 1440, 900, true);
  else {
    const list = args.length ? args : SCREENS;
    for (const [w, h] of SIZES) for (const s of list) await shot(`/test/ui-mock.html?screen=${s}&freeze=1`, `${s}-${w}x${h}.png`, w, h);
    if (!args.length) await shot('/test/ui-mock.html?screen=all', 'contact-sheet.png', 1440, 900, true);
  }
  console.log(errs.length ? 'PROBLEMS:\n' + errs.join('\n') : 'ok, no console errors, nothing clipped');
} finally { await browser.close(); srv.close(); }
