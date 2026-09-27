// Shoots test/emblems.html (the rank emblems at 20/40/120 px, light and navy) to test/ui-shots/emblems.png. Fails on any console error.
// Usage: node test/emblems-shot.mjs        Serves the repo root in-process on 8471 (model: test/ui-shots/shoot.mjs).
import http from 'http'; import fs from 'fs'; import path from 'path';
import puppeteer from 'puppeteer-core';
const root = new URL('..', import.meta.url).pathname, PORT = +process.env.UI_PORT || 8471, out = root + 'test/ui-shots/emblems.png';
const MIME = { '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript', '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml' };
const srv = http.createServer((q, r) => {
  const f = path.join(root, decodeURIComponent(new URL(q.url, 'http://x').pathname)); if (!f.startsWith(root)) { r.writeHead(403); return r.end(); }
  fs.readFile(f, (e, d) => { if (e) { r.writeHead(404); return r.end('nf'); } r.writeHead(200, { 'content-type': MIME[path.extname(f)] || 'application/octet-stream' }); r.end(d); });
}).listen(PORT, '127.0.0.1');
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--hide-scrollbars'] });
const errs = [];
try {
  const page = await browser.newPage(); await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 });
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  page.on('pageerror', e => errs.push('PAGEERROR ' + e.message));
  page.on('requestfailed', q => errs.push('FAILED ' + q.url()));
  page.on('response', s => { if (s.status() >= 400) errs.push(`${s.status()} ${s.url()}`); });
  await page.goto(`http://127.0.0.1:${PORT}/test/emblems.html`, { waitUntil: 'networkidle0', timeout: 20000 });
  await page.waitForFunction(() => document.title.startsWith('ready'), { timeout: 10000 });
  await new Promise(r => setTimeout(r, 800));      // the .is-pop one-shot (600 ms) has landed
  const n = await page.evaluate(() => document.querySelectorAll('.rank-em:not([hidden])').length);
  if (n < 14 * 3) errs.push(`only ${n} emblems on the page`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  await page.screenshot({ path: out, fullPage: true });
  if (process.env.UI_ZOOM === '1') {      // UI_ZOOM=1: the Silver-vs-Platinum pairs at 4x device pixels, to inspect the 20 px read
    const zoom = await page.$$('[data-zoom]'); await page.setViewport({ width: 1440, height: 900, deviceScaleFactor: 4 });
    for (let i = 0; i < zoom.length; i++) await zoom[i].screenshot({ path: out.replace(/\.png$/, `-zoom-${i}.png`) });
  }
  console.log(errs.length ? 'PROBLEMS:\n' + errs.join('\n') : `ok, ${n} emblems, no console errors -> ${out}`);
} finally { await browser.close(); srv.close(); }
process.exit(errs.length ? 1 : 0);
