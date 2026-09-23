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
const SCREENS = ['title', 'lobby', 'lobby-first', 'lobby-bot', 'lobby-ask', 'connect', 'calibrate1', 'calibrate2', 'calibrate-error', 'calibrate-settle', 'calibrate-done', 'hud-airpod-lost', 'hud', 'hud-callout', 'hud-point-you', 'hud-point-enemy', 'hud-arrivals', 'serve-prompt', 'hud-stats',
  'hud&bg=grass', 'hud&bg=court', 'settings', 'settings-paused', 'settings-stats', 'settings-watch', 'hud-paused', 'hold', 'watch', 'watch-split', 'watch-pov', 'watch-point', 'watch&bg=court', 'match-win', 'match-voted', 'match-asked', 'match-left', 'match-lose', 'match-forfeit', 'match-watch', 'match-legacy', 'server-down', 'game-full',
  'lobby-courts', 'lobby-courts&tour=1', 'lobby-courts-full', 'lobby-courts-loading', 'lobby-courts-empty', 'lobby-courts-empty-full', 'lobby-courts-nomatch', 'lobby-courts-nomatch&q=KXQ8', 'lobby-courts-down', 'lobby-courts-err', 'lobby-courts-link', 'lobby-courts-many',
  'hud-ask', 'hud-ask-settings', 'match-ask', 'watch-ask', 'watch-ask&s=sent', 'watch-ask&s=no', 'watch-ask&s=expired', 'watch-ask&s=wait&busy=1',
  'tourney-courts', 'tourney-host-empty', 'tourney-host-3', 'tourney-host-ready', 'tourney-host-16', 'tourney-guest', 'tourney-warmfull', 'tourney-banner', 'tourney-banner-host', 'tourney-card', 'tourney-intro', 'tourney-intro&bot=1', 'tourney-intro&final=1', 'tourney-bracket', 'tourney-bracket&you=out&next=1', 'tourney-bracket&n=16&you=watching', 'tourney-bracket&n=16&you=through', 'tourney-win', 'tourney-out', 'tourney-champion', 'tourney-champion-watch', 'tourney-champion-watch&matt=1', 'tourney-ended', 'tourney-ended&why=empty',
  'tourney-match', 'tourney-match-settings', 'tourney-match-qq'];
const SIZES = (process.env.UI_SIZES || '1440x900,1280x720,600x900').split(',').map(s => s.split('x').map(Number));      // 600x900: the root font is at its 10px floor there, the layout no longer shrinks with the window
const args = process.argv.slice(2);
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--hide-scrollbars'] });
const errs = [];
async function shot(url, file, w, h, full) {
  const page = await browser.newPage(); await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
  if (process.env.UI_REDUCED === '1') { await page.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); file = file.replace(/\.png$/, '-reduced.png'); }      // UI_REDUCED=1: the reduced-motion pass (hud-ask, lobby-courts-loading)
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
  const OVERLAP = [['ask-card', 'keys'], ['ask-card', 'toast'], ['ask-card', 'settings'], ['ask-card', 'board'], ['ask-card', 'corner'], ['ask-card', 'watchers'], ['ask-card', 'camwrap'], ['ask-card', 'podwrap'], ['ask-card', 'result'], ['ask-card', 'notices'], ['btn-ask', 'emotes'], ['btn-ask', 'views'], ['btn-ask', 'toast'], ['tour-pill', 'board'], ['btn-tour-go', 'board'], ['tour-card', 'board'], ['tour-card', 'camwrap'], ['tour-pill', 'camwrap'], ['btn-tour-go', 'camwrap'], ['tour-pill', 'podwrap']];      // docs/COURTS-TOURNEY.md 2.11: the ask card and button never sit on what is already in those corners
  const hits = await page.evaluate(pairs => pairs.filter(([a, b]) => { const A = document.getElementById(a), B = document.getElementById(b); if (!A || !B) return false;
    const r = A.getBoundingClientRect(), q = B.getBoundingClientRect(), vis = e => e.getBoundingClientRect().width > 0 && getComputedStyle(e).visibility !== 'hidden' && +getComputedStyle(e).opacity > 0.05;
    return vis(A) && vis(B) && r.left < q.right && r.right > q.left && r.top < q.bottom && r.bottom > q.top; }).map(p => p.join(' x ')), OVERLAP);
  if (hits.length) errs.push(`${file}: OVERLAP ${hits.join(', ')}`);
  await page.screenshot({ path: out + file, fullPage: !!full }); await page.close();
}
try {
  const ui = args.indexOf('--url');
  if (ui >= 0) await shot(args[ui + 1], args[args.indexOf('--out') + 1] || 'page.png', 1440, 900, true);
  else {
    const list = args.length ? args : SCREENS;
    for (const [w, h] of SIZES) for (const s of list) await shot(`/test/ui-mock.html?screen=${s}&freeze=1`, `${s.replace(/&(\w+)=/g, '-$1-')}-${w}x${h}.png`, w, h);
    if (!args.length) await shot('/test/ui-mock.html?screen=all', 'contact-sheet.png', 1440, 900, true);
  }
  console.log(errs.length ? 'PROBLEMS:\n' + errs.join('\n') : 'ok, no console errors, nothing clipped');
} finally { await browser.close(); srv.close(); }
