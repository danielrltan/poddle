// End-to-end: own game server + fake AirPod + static server + headless Chrome. Usage: node test/e2e.mjs [two]
import { spawn } from 'child_process';
import puppeteer from 'puppeteer-core';
import fs from 'fs';
const TWO = process.argv[2] === 'two';
const P0 = +process.env.E2E_PORT || 8161, G = P0, B = P0 + 1, W = P0 + 2, DEAD = P0 + 3,          // E2E_PORT=<base> moves the whole block
  root = new URL('..', import.meta.url).pathname;
const procs = [
  spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: G } }),
  spawn('node', ['test/fake-bridge.mjs', B], { cwd: root }),
  spawn('python3', ['-m', 'http.server', W, '-d', 'web'], { cwd: root }),
];
const done = code => { for (const p of procs) p.kill(); process.exit(code); };
await new Promise(r => setTimeout(r, 1500));
fs.mkdirSync(root + 'test/shots', { recursive: true });
const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--window-size=1440,900', '--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'], defaultViewport: { width: 1440, height: 900 } });
const errs = [];
async function open(name, query) {
  const page = await browser.newPage();
  page.on('console', m => { if (m.type() === 'error') errs.push(`[${name}] ${m.text()}`); });
  page.on('pageerror', e => errs.push(`[${name}] PAGEERROR ${e.message}`));
  await page.goto(`http://localhost:${W}/?bridge=${B}&game=${G}${query}`);
  return page;
}
// ---- UI checks ride along: ?skiptitle=1 bypasses the title (nobody here to swing), ?uitest=1 exposes window.__ui for forcing states
const sleep = ms => new Promise(r => setTimeout(r, ms)), shot = (pg, name) => pg.screenshot({ path: root + 'test/shots/' + name });
const uiFails = [], check = (ok, what) => { if (!ok) uiFails.push(what); };
const ui = pg => pg.evaluate(() => { const t = id => document.getElementById(id), v = el => !!el && !el.hidden && getComputedStyle(el).visibility !== 'hidden' && +getComputedStyle(el).opacity > 0.5;
  return { screen: document.body.dataset.screen, overlay: document.body.dataset.overlay || null, calh: t('calh').textContent, calHidden: t('cal').hidden, hud: v(t('hud')), g: t('g').textContent,
    banner: t('banner').classList.contains('show') ? t('banner-text').textContent : null, callout: t('callout').classList.contains('go') ? t('callout').textContent : null,
    dev: v(t('dev')), keys: v(t('keys')) && !t('keys').classList.contains('is-idle'), toastOn: t('toast').classList.contains('on'), toastTop: t('toast').getBoundingClientRect().top / innerHeight,
    pod: (r => ({ top: r.top / innerHeight, bottom: r.bottom / innerHeight, w: r.width }))(t('podwrap').getBoundingClientRect()), meter: !!t('bar'), camCaption: t('camwrap').textContent.trim(), font: getComputedStyle(document.body).fontFamily, fontsLoaded: [...document.fonts].filter(f => f.status === 'loaded').map(f => f.family + ' ' + f.weight).join(', ') }; });
const a = await open('p0', '&skiptitle=1&uitest=1' + (TWO ? '' : '&autobot=1'));
const b = TWO ? await open('p1', '&skiptitle=1') : null;
await sleep(3000); await shot(a, '1-cal-hold.png'); await shot(a, 'ui-3-calibrate1.png');
{ const u = await ui(a); check(u.screen === 'calibrate' && /hold still/i.test(u.calh), `calibrate step 1 not showing (screen=${u.screen}, headline=${u.calh})`); check(!u.calHidden, '#cal hidden during calibration'); }
let ok = false; const seen = { tilt: false, done: false, banner: null, callout: null, rally: false, toastTop: null, keysOnBanner: null }, SHOT_NAMES = ['Dink', 'Lob', 'Tap', 'Drive', 'Smash', 'Block'];
for (let i = 0; i < 600; i++) {
  await sleep(100);
  const st = await a.evaluate(() => window.__stats), u = await ui(a);
  if (!seen.tilt && u.screen === 'calibrate' && u.calh === 'Tip it up') { seen.tilt = true; await shot(a, '2-cal-tilt.png'); await shot(a, 'ui-4-calibrate2.png'); }
  if (!seen.done && u.screen === 'calibrate' && u.calh === 'All set') { seen.done = true; await shot(a, 'ui-4b-cal-done.png'); }     // the success beat must be held long enough to see
  if (u.screen === 'hud' && u.toastOn && seen.toastTop == null) { seen.toastTop = u.toastTop; await shot(a, 'ui-5a-serve-toast.png'); }
  if (st.calibrated && !ok) { ok = true; console.log('calibrated at', (i / 10 + 3).toFixed(1), 's'); }
  if (u.banner && !seen.banner) { seen.banner = u.banner; seen.keysOnBanner = u.keys; await shot(a, 'ui-6-point-banner.png'); }
  if (u.callout && !seen.callout) { seen.callout = u.callout; await shot(a, 'ui-7-callout.png'); }
  if (ok && !seen.rally && st.hits >= 2 && !u.banner) { seen.rally = true; await shot(a, 'ui-5-hud-rally.png'); }
  if (st.myHits >= 3) break;
}
await a.screenshot({ path: root + 'test/shots/3-rally.png' });
{ const u = await ui(a);
  check(seen.tilt, 'never saw calibration step 2 ("Tip it up")'); check(seen.done, 'never saw the "All set" beat at the end of calibration');
  check(u.pod.w > 0 && u.pod.bottom < 0.55, `AirPod inset reaches into the near court (bottom at ${(u.pod.bottom * 100).toFixed(0)}% of the height)`); check(!u.meter, 'stats panel still has a meter bar');
  check(seen.toastTop == null || seen.toastTop > 0.88, `HUD toast sits over the court (top at ${(seen.toastTop * 100).toFixed(0)}% of the height)`); check(u.screen === 'hud' && u.hud, `HUD not showing after calibration (screen=${u.screen})`);
  check(u.g === 'live', `#g is "${u.g}", expected "live"`); check(!u.dev, 'stats panel visible by default'); check(u.camCaption === '', 'webcam inset has a caption');
  check(/Poddle Rounded/.test(u.font) && !/mono/i.test(u.font), 'body font is ' + u.font); check(/Poddle Rounded/.test(u.fontsLoaded), 'vendored font did not load: ' + u.fontsLoaded);
  check(!seen.banner || /^(Your point|Matt scores)$/.test(seen.banner), 'banner text was "' + seen.banner + '"');      // the point banner names who scored (docs/SPECTATE.md Names)
  check(!seen.callout || SHOT_NAMES.includes(seen.callout), 'callout text was "' + seen.callout + '"');
  await sleep(500); check((await ui(a)).calHidden, '#cal not hidden once calibrated');
  console.log('ui seen:', JSON.stringify(seen), '| fonts:', u.fontsLoaded); }
for (let i = 0; i < 25; i++) { await new Promise(r => setTimeout(r, 120)); const sw = await a.evaluate(() => document.getElementById('pw').textContent); if (+sw > 12) { await a.screenshot({ path: root + 'test/shots/4-midswing.png' }); break; } }
if (b) await b.screenshot({ path: root + 'test/shots/5-side1.png' });
// forced states (only what the rally did not happen to show), then the match result moment
if (!seen.rally) await shot(a, 'ui-5-hud-rally.png');
if (!seen.banner) { await a.evaluate(() => window.__ui.pointBanner(true)); await sleep(600); await shot(a, 'ui-6-point-banner.png'); }
if (!seen.callout) { await a.evaluate(() => window.__ui.callout('smash')); await sleep(500); await shot(a, 'ui-7-callout.png'); }
let matchShown = false;                                   // a live 'serve' closes the result card (by design), so retry until one survives the medal drop
for (let k = 0; k < 6 && !matchShown; k++) { await a.evaluate(() => { window.__ui.matchResult(true, 11, 7, 'Matt'); window.__ui.confetti(['#3aa0ff', '#ffd34a', '#ffffff'], 60); }); await sleep(1400);
  matchShown = (await ui(a)).overlay === 'match'; if (matchShown) await shot(a, 'ui-8-match-result.png'); }
check(matchShown, 'match result overlay did not open'); await a.evaluate(() => window.__ui.showOverlay(null));
const st = await a.evaluate(() => window.__stats), st1 = b ? await b.evaluate(() => window.__stats) : null;
console.log('p0', JSON.stringify(st)); console.log('camera', JSON.stringify(await a.evaluate(() => window.__stats.cam))); if (st1) console.log('p1', JSON.stringify(st1));
// title -> lobby -> connect, driven like a player would (after the match pages are done, so it cannot take a seat from them). No AirPod on this one.
{ await a.close(); if (b) await b.close();
  const pg = await browser.newPage();
  pg.on('console', m => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|WebSocket connection/.test(m.text())) errs.push(`[title] ${m.text()}`); });
  pg.on('pageerror', e => errs.push(`[title] PAGEERROR ${e.message}`));
  await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('poddle.name', 'Dan'); } catch { /* */ } });      // a returning player: the lobby asks a first visitor for a name before anything can be chosen (test/spectate-e2e.mjs walks that)
  await pg.goto(`http://localhost:${W}/?bridge=${DEAD}&game=${G}`); await sleep(1500);
  check((await ui(pg)).screen === 'title', 'title screen not showing on a plain load'); await shot(pg, 'ui-1-title.png');
  await pg.keyboard.press('Space'); await sleep(900);
  check((await ui(pg)).screen === 'lobby', 'Space on the title did not open the lobby');
  await pg.keyboard.press('Enter'); await sleep(1200);        // Quick play is focused
  check((await ui(pg)).screen === 'connect', 'Quick play did not reach the connect screen'); await shot(pg, 'ui-2-connect.png');
  await pg.keyboard.press('KeyC'); await sleep(700); check((await ui(pg)).screen === 'calibrate', 'C did not open calibration'); await pg.close(); }
console.log(errs.length ? 'CONSOLE ERRORS:\n' + errs.join('\n') : 'no console errors');
console.log(uiFails.length ? 'UI CHECKS FAILED:\n' + uiFails.join('\n') : 'ui checks ok');
await browser.close();
// two-player mode uses blind scripted players in a throttled background tab, so only require a clean session there
const pass = TWO ? (st.calibrated && st1.calibrated && st1.events.state > 100 && !errs.length)
                 : (st.calibrated && st.hits >= 3 && st.myHits + st.whiffs >= 3 && st.paddlePath > 1 && !errs.length && !uiFails.length)  // the scripted player swings blind, so its swings mostly whiff;
console.log(pass ? 'E2E PASS' : 'E2E FAIL'); done(pass ? 0 : 1);
