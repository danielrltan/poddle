// Menu sounds, menu music and Settings from the menu (NOTES 181), against the real server/game.js.
// Checks: the title's and the lobby's settings button open the one #settings card (court-only rows hidden) without leaving the title;
// Music / Menu sounds step 0..10 and are kept; the music loads after the first gesture, plays on the title and the lobby and fades out
// for a court; hover / select / back / switch sounds fire; Sound off silences both. Screenshots go to SHOTS=<dir> when set.
// Usage: node test/menu-audio.mjs      MA_PORT=<port> moves the server (default 8970)
import { spawn } from 'child_process'; import fs from 'fs';
import puppeteer from 'puppeteer-core';
const PORT = +process.env.MA_PORT || 8970, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms)), SHOTS = process.env.SHOTS || '';
if ([8080, 8787, 3000].includes(PORT)) { console.log('refusing: that port holds the player\'s own game'); process.exit(2); }
const srv = spawn(process.execPath, ['server/game.js'], { cwd: root, env: { ...process.env, PORT: String(PORT), PODDLE_DB: ':memory:' }, stdio: 'ignore' });
const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const out = [], ok = (c, what) => { out.push((c ? 'PASS ' : 'FAIL ') + what); if (!c) console.log('FAIL', what); };
const done = code => { try { srv.kill(); } catch { } console.log(out.join('\n')); process.exit(code); };
setTimeout(() => { console.log('MENU-AUDIO FAIL (timeout)'); done(2); }, 120000);
await sleep(1200);
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--hide-scrollbars'] });
try {
  const pg = await browser.newPage(), errs = [];
  pg.on('pageerror', e => errs.push(String(e))); pg.on('console', m => { if (m.type() === 'error' && !/favicon|WebSocket|ERR_CONNECTION_REFUSED|localhost:8787/.test(m.text())) errs.push(m.text()); });
  await pg.setViewport({ width: 1440, height: 900 });
  await pg.evaluateOnNewDocument(() => { if (!localStorage.getItem('poddle.name')) localStorage.setItem('poddle.name', 'Tester'); });
  await pg.goto(`http://127.0.0.1:${PORT}/?uitest=1&mobile=0`, { waitUntil: 'networkidle2' }); await sleep(900);
  const ev = f => pg.evaluate(f), shot = async n => { if (SHOTS) await pg.screenshot({ path: `${SHOTS}/${n}.png` }); };
  const st = () => ev(() => ({ screen: document.body.dataset.screen, set: document.body.dataset.settings || null, open: !document.getElementById('settings').hidden, mau: window.__mau.state(), sfx: (window.__sfx || []).slice() }));
  await shot('1-title');
  ok(await ev(() => !!document.querySelector('#screen-title .foot-credit') && /Into the Blue by Gwamm Music/.test(document.querySelector('#screen-title .foot-credit').textContent)), 'the title credits the music');

  // the title's settings button: the card opens over the title, it does not start the game
  await pg.click('#btn-title-set'); await sleep(500);
  let s = await st();
  ok(s.screen === 'title' && s.set === 'menu' && s.open, `title: the settings button opens the card and stays on the title (${JSON.stringify([s.screen, s.set, s.open])})`);
  ok(s.sfx.includes('open'), 'opening plays its sound');
  const card = await ev(() => { const el = document.getElementById('settings'), r = el.getBoundingClientRect(), hit = document.elementFromPoint(r.left + r.width / 2, r.top + 40);
    const vis = id => { const e = document.getElementById(id); return !!(e && e.offsetParent); };
    return { onTop: el.contains(hit), right: innerWidth - r.right, top: r.top, music: vis('set-music'), ui: vis('set-uisfx'), sound: vis('tog-sound'), recenter: vis('btn-recenter'), leave: vis('btn-leave-room'), bot: vis('set-bot'), status: !!document.querySelector('.settings .set-status')?.offsetParent, move: vis('set-move') }; });
  ok(card.onTop, 'the card is drawn above the title');
  ok(card.right < 40 && card.top > 40, `the card sits top right under its button (${card.right}, ${card.top})`);
  ok(card.music && card.ui && card.sound && card.move, 'Music, Menu sounds, Sound and Move are there');
  ok(!card.recenter && !card.leave && !card.bot && !card.status, 'the court-only rows are hidden on the menu');
  await shot('2-title-settings');

  // the first click was a gesture: the music loads and plays on the title
  for (let i = 0; i < 40 && !(await st()).mau.playing; i++) await sleep(200);
  await sleep(1800); s = await st();
  ok(s.mau.ready && s.mau.playing && s.mau.t > 0.3 && s.mau.gain > 0.05, `music plays on the title after the first gesture (${JSON.stringify(s.mau)})`);

  // Music 5 -> 6, Menu sounds 6 -> 5; kept in poddle.settings
  await pg.click('#btn-music-more'); await pg.click('#btn-uisfx-less'); await sleep(200);
  const vals = await ev(() => ({ m: document.getElementById('set-music-val').textContent, u: document.getElementById('set-uisfx-val').textContent, kept: JSON.parse(localStorage.getItem('poddle.settings') || '{}') }));
  ok(vals.m === '6' && vals.u === '5' && vals.kept.music === 6 && vals.kept.menuSfx === 5, `the levels step and are kept (${JSON.stringify(vals)})`);
  ok((await st()).sfx.filter(k => k === 'step').length === 2, 'each step plays its note');

  // a switch: Sound off silences the music, back on brings it back
  await pg.click('#tog-sound'); await sleep(900); s = await st();
  ok(!s.mau.playing && s.sfx.includes('off'), `Sound off: the music stops (${JSON.stringify(s.mau)})`);
  await pg.click('#tog-sound'); await sleep(1500); s = await st();
  ok(s.mau.playing, 'Sound on: the music is back');

  // Esc closes the card and leaves the title where it was
  await pg.keyboard.press('Escape'); await sleep(400); s = await st();
  ok(s.screen === 'title' && !s.open && s.sfx.includes('close'), `Esc closes the card on the title (${JSON.stringify([s.screen, s.open])})`);

  // hover: a mouse over the Play button plinks once
  const n0 = (await st()).sfx.filter(k => k === 'hover').length;
  const b = await (await pg.$('#btn-start')).boundingBox(); await pg.mouse.move(b.x + 5, b.y + 5); await pg.mouse.move(b.x + 20, b.y + 10); await sleep(100);
  ok((await st()).sfx.filter(k => k === 'hover').length === n0 + 1, 'hovering a button plinks once, not once per move');

  // Play: the lobby, the music carries on; its own settings button opens the same card
  await pg.click('#btn-start'); await sleep(1200); s = await st();
  ok(s.screen === 'lobby' && s.mau.playing && s.sfx.includes('select'), `Play: the lobby, select sound, music carries on (${JSON.stringify([s.screen, s.mau.playing])})`);
  await pg.click('#btn-lobby-set'); await sleep(500); s = await st();
  ok(s.set === 'menu' && s.open, 'the lobby\'s settings button opens the card');
  await shot('3-lobby-settings');
  { const t = await (await pg.$('#btn-quick')).boundingBox(); await pg.mouse.click(t.x + t.width / 2, t.y + t.height / 2); } await sleep(800);      // over Quick play
  s = await st(); ok(!s.open && s.screen === 'lobby' && await ev(() => __stats.phase === 'lobby' && !__stats.room), `a click outside only closes the card: Quick play under it is not pressed (${JSON.stringify([s.open, s.screen])})`);
  await pg.click('#btn-lobby-set'); await sleep(400); await pg.click('#btn-lobby-set'); await sleep(400);
  ok(!(await st()).open, 'its button closes it again');

  // a narrow window: the card fits
  await pg.setViewport({ width: 390, height: 800 }); await sleep(400); await pg.click('#btn-lobby-set'); await sleep(500);
  const nar = await ev(() => { const r = document.getElementById('settings').getBoundingClientRect(); return { l: r.left, r: innerWidth - r.right, w: document.documentElement.scrollWidth <= innerWidth }; });
  ok(nar.l >= 0 && nar.r >= 0 && nar.w, `narrow: the card fits the width (${JSON.stringify(nar)})`);
  await shot('4-lobby-settings-narrow');
  await pg.keyboard.press('Escape'); await sleep(300); await pg.setViewport({ width: 1440, height: 900 }); await sleep(300);

  // Play a bot: on the way to the court the music fades out
  await pg.click('#btn-bot'); await sleep(1200); await ev(() => document.getElementById('btn-bot-0').click()); await sleep(2500); s = await st();
  ok(s.screen !== 'lobby' && s.screen !== 'title' && !s.mau.want && !s.mau.playing, `leaving the menu for a court: the music stops (${JSON.stringify([s.screen, s.mau])})`);
  // Back from the set-up screen leaves the court: the music comes back in the lobby
  await pg.keyboard.press('Escape'); await sleep(2200); s = await st();
  ok(s.screen === 'lobby' && s.mau.want && s.mau.playing, `back in the lobby the music plays again (${JSON.stringify([s.screen, s.mau])})`);
  ok(!errs.length, `no page errors (${errs.slice(0, 3).join(' | ')})`);
} catch (e) { ok(false, 'threw: ' + (e.stack || e)); }
await browser.close();
const fails = out.filter(l => l.startsWith('FAIL')).length;
console.log(fails ? `MENU-AUDIO FAIL (${fails})` : 'MENU-AUDIO OK'); done(fails ? 1 : 0);
