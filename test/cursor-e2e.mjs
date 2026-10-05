// The paddle cursor (NOTES 215; web/cursor.js + cursor.css) against the real server/game.js.
// Checks: the paddle shows on the title under a mouse and the native cursor is hidden there; it winds up (is-ready) over Play and
// over a lobby tile, swings and bursts on a press (is-down + is-hit), springs back on release; it hides over the name field (is-off,
// the field keeps its native text cursor); a wheel rolls the ball and nods the paddle; the hot spot is exactly the mouse point;
// the phone home never shows it (a coarse pointer never builds it: the media query is the first line of paddleCursor). Screenshots go to SHOTS=<dir> when set.
// Usage: node test/cursor-e2e.mjs      CUR_PORT=<port> moves the server (default 8973)
import { spawn } from 'child_process'; import fs from 'fs';
import puppeteer from 'puppeteer-core';
const PORT = +process.env.CUR_PORT || 8973, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms)), SHOTS = process.env.SHOTS || '';
if ([8080, 8787, 3000].includes(PORT)) { console.log('refusing: that port holds the player\'s own game'); process.exit(2); }
const srv = spawn(process.execPath, ['server/game.js'], { cwd: root, env: { ...process.env, PORT: String(PORT), PODDLE_DB: ':memory:' }, stdio: 'ignore' });
const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const out = [], ok = (c, what) => { out.push((c ? 'PASS ' : 'FAIL ') + what); if (!c) console.log('FAIL', what); };
const done = code => { try { srv.kill(); } catch { } console.log(out.join('\n')); process.exit(code); };
setTimeout(() => { console.log('CURSOR FAIL (timeout)'); done(2); }, 90000);
await sleep(1200);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--hide-scrollbars'] });
try {
  const pg = await browser.newPage(), errs = [];
  pg.on('pageerror', e => errs.push(String(e))); pg.on('console', m => { if (m.type() === 'error' && !/favicon|WebSocket|ERR_CONNECTION_REFUSED|localhost:8080/.test(m.text())) errs.push(m.text()); });
  await pg.setViewport({ width: 1440, height: 900 });
  await pg.evaluateOnNewDocument(() => { if (!localStorage.getItem('poddle.name')) localStorage.setItem('poddle.name', 'Tester'); });
  await pg.goto(`http://127.0.0.1:${PORT}/?uitest=1&mobile=0&game=${PORT}`, { waitUntil: 'networkidle2' }); await sleep(900);
  const ev = (f, a) => pg.evaluate(f, a), shot = async n => { if (SHOTS) await pg.screenshot({ path: `${SHOTS}/${n}.png` }); };
  const st = () => ev(() => window.__cur.state());
  const cursorAt = (x, y) => ev(([x, y]) => getComputedStyle(document.elementFromPoint(x, y)).cursor, [x, y]);
  const glide = async (x, y) => { await pg.mouse.move(x - 20, y - 10); await sleep(40); await pg.mouse.move(x, y); await sleep(350); };      // two moves: a velocity, then a rest

  ok(await ev(() => !!window.__cur && !!document.getElementById('cur')), 'the paddle is built for a fine pointer');
  ok(!(await st()).on, 'nothing shows before the mouse has moved');
  await glide(700, 300);
  let s = await st();
  ok(s.on && !s.off && !s.ready && s.native, `on the title under a mouse: shown, at rest, the native cursor hidden (${JSON.stringify(s)})`);
  ok(await cursorAt(700, 300) === 'none', 'the page under it says cursor:none');
  const hot = await ev(() => { const r = document.querySelector('#cur .cur-ball').getBoundingClientRect(), b = document.getElementById('cur').getBoundingClientRect(); return { bx: b.left, by: b.top, w: r.width, left: r.left, top: r.top }; });
  ok(Math.abs(hot.bx - 700) < 1 && Math.abs(hot.by - 300) < 1, `the box's origin is the mouse point (${hot.bx}, ${hot.by})`);
  ok(Math.abs(hot.left + hot.w * 10 / 64 - 700) < 1.5 && Math.abs(hot.top + hot.w * 10 / 64 - 300) < 1.5, `the ball's centre is the hot spot (${(hot.left + hot.w * 10 / 64).toFixed(1)}, ${(hot.top + hot.w * 10 / 64).toFixed(1)})`);
  await shot('1-title');

  // a fast move leans the paddle around the ball; it settles back
  await pg.mouse.move(600, 400); await sleep(16); await pg.mouse.move(900, 420); await sleep(20);
  s = await st(); ok(s.lean > 1, `a fast move to the right leans the paddle (${s.lean.toFixed(2)}deg)`);
  const spin0 = s.spin; await sleep(700); s = await st(); ok(Math.abs(s.lean) < 0.01, `and it settles (${s.lean.toFixed(3)}deg)`);
  ok(spin0 !== 0, `the ball rolled with the travel (${spin0.toFixed(0)}deg)`);

  // over Play: ready; a press: down + hit; release: back to ready
  const b = await (await pg.$('#btn-start')).boundingBox(), bx = b.x + b.width / 2, by = b.y + b.height / 2;
  await glide(bx, by);
  s = await st(); ok(s.on && s.ready, `over Play the paddle winds up (${JSON.stringify([s.on, s.ready])})`);
  const pose = await ev(() => ({ pad: getComputedStyle(document.querySelector('#cur .cur-pad')).rotate, glow: document.querySelector('#cur .cur-ring').classList.contains('is-glow') }));
  ok(/^-?2[0-9](\.\d+)?deg$/.test(pose.pad) && pose.pad.startsWith('-') && pose.glow, `the face is wound back and the ring glows (${JSON.stringify(pose)})`);
  await shot('2-ready');
  await pg.mouse.down(); await sleep(60);
  s = await st(); ok(s.down && !s.plain, `the press swings through (${JSON.stringify([s.down, s.plain])})`);
  const hit = await ev(() => ({ hit: document.getElementById('cur').classList.contains('is-hit'), fx: getComputedStyle(document.querySelector('#cur .cur-fx')).opacity, pad: getComputedStyle(document.querySelector('#cur .cur-pad')).rotate }));
  ok(hit.hit && +hit.fx > 0.3 && !hit.pad.startsWith('-'), `the burst is playing and the face is through (${JSON.stringify(hit)})`);
  await shot('3-hit');
  await pg.mouse.up(); await sleep(400);
  s = await st(); ok(!s.down, 'release lets go');
  ok(await ev(() => document.body.dataset.screen) === 'lobby', 'that press opened the lobby');

  // a press on nothing: a half swing, no burst
  await glide(200, 450); await pg.mouse.down(); await sleep(60);
  s = await st(); ok(s.down && s.plain && !s.ready, `a press on the ground is a plain half swing (${JSON.stringify([s.down, s.plain])})`);
  ok(await ev(() => getComputedStyle(document.querySelector('#cur .cur-fx')).opacity) === '0', 'with no burst');
  await pg.mouse.up(); await sleep(300);

  // a lobby tile: ready. The name field: hidden, native text cursor
  const tr = await ev(() => { for (const t of document.querySelectorAll('.tile')) { const r = t.getBoundingClientRect(); if (r.width) return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; } return null; });
  await glide(tr.x, tr.y); s = await st(); ok(s.ready, 'a lobby tile winds it up');
  await shot('4-tile');
  const ir = await ev(() => { const i = document.getElementById('name-input'); const r = i.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 }; });
  await glide(ir.x, ir.y); s = await st();
  ok(!s.on && s.off && !s.ready, `over the name field the paddle hides (${JSON.stringify([s.on, s.off])})`);
  ok(await cursorAt(ir.x, ir.y) === 'text', 'and the field keeps its text cursor');
  await ev(() => document.activeElement.blur());

  // a wheel: the ball rolls, the paddle nods
  await glide(720, 520); const before = (await st()).spin;
  await pg.mouse.wheel({ deltaY: 120 }); await sleep(30);
  const roll = await ev(() => ({ s: window.__cur.state().spin, roll: document.getElementById('cur').classList.contains('is-roll'), y: document.getElementById('cur').style.getPropertyValue('--roll-y') }));
  ok(roll.s - before > 60 && roll.roll && roll.y === '1.5px', `a wheel down rolls the ball and nods the paddle down (${JSON.stringify(roll)})`);
  await sleep(250); ok(!(await ev(() => document.getElementById('cur').classList.contains('is-roll'))), 'the nod is over in a blink');

  // out of the window: gone; back: shown
  await ev(() => document.dispatchEvent(new PointerEvent('pointerout', { pointerType: 'mouse', relatedTarget: null, bubbles: true })));
  await sleep(50); s = await st(); ok(!s.on && !s.native, 'leaving the window hides it and frees the native cursor');
  await glide(640, 480); s = await st(); ok(s.on && s.native, 'coming back shows it');

  // the phone home (html[data-mobile], NOTES 149) never shows it, even to a mouse
  const pg2 = await browser.newPage(); await pg2.setViewport({ width: 1440, height: 900 });
  await pg2.goto(`http://127.0.0.1:${PORT}/?uitest=1&mobile=1&game=${PORT}`, { waitUntil: 'networkidle2' }); await sleep(600);
  await pg2.mouse.move(400, 300); await sleep(40); await pg2.mouse.move(420, 320); await sleep(200);
  ok(await pg2.evaluate(() => document.documentElement.hasAttribute('data-mobile') && !window.__cur.state().on && !document.documentElement.classList.contains('has-cur')), 'the phone home keeps the native cursor'); await pg2.close();

  ok(errs.length === 0, `no page errors (${errs.join(' | ').slice(0, 300)})`);
} catch (e) { ok(false, 'threw: ' + (e.stack || e)); }
await browser.close();
done(out.some(l => l.startsWith('FAIL')) ? 1 : 0);
