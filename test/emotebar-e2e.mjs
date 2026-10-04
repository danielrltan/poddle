// The emote bar (NOTES 205): real server/game.js, fake AirPods, real Chromes. Ann and Ben play, Cat watches.
// Everyone on the court gets the small bar bottom-right: GG and nine emoji, keys 1 to 0 under them, the player's key strip above it, nothing
// overlapping. A key sends one to the whole court (a short pop with the sender's name, gone in about two seconds); the bar then rests a
// second (dimmed; a second key does nothing). The spectator emotes too, and V steps through the views (1-4 did, before they were emotes).
// EMOTEBAR_PORT=<base> moves the block (base .. base+2). Screenshots: test/ui-shots/emotes-*.png. LOOK at them.
import { spawn } from 'child_process'; import fs from 'fs';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
import { makeSynth, CALIBRATE, SESSION_LOOP } from './fake-bridge.mjs';
const root = new URL('..', import.meta.url).pathname, SHOTS = root + 'test/ui-shots/', sleep = ms => new Promise(r => setTimeout(r, ms)), P0 = +process.env.EMOTEBAR_PORT || 8490;
if ([8080, 8787, 3000].some(p => p >= P0 && p <= P0 + 2)) { console.log("refusing: that port range holds the player's own game"); process.exit(2); }
const out = [], errs = [];                                  // one tally across the three sessions
function rig(env = {}) {
  const G = P0, B = P0 + 1, DEAD = P0 + 2;
  const server = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: G, ...env }, stdio: ['ignore', 'pipe', 'pipe'] }), slog = []; server.stdout.on('data', d => slog.push(String(d))); server.stderr.on('data', d => slog.push('ERR ' + d));
  const pods = {}, podOpts = { heading: 137, gyroNoise: 0.02, accNoise: 0.005, seed: 7 };
  const rest = tag => { const p = pods[tag] ??= { t: 3580, socks: new Set() }; p.syn = makeSynth({ ...podOpts, script: [], t0: p.t + 0.02 }); return p; };
  const go = tag => { const p = pods[tag] || rest(tag); p.syn = makeSynth({ ...podOpts, script: CALIBRATE, loop: SESSION_LOOP, t0: p.t + 0.02 }); };
  const swing = tag => { const p = pods[tag] || rest(tag); p.syn = makeSynth({ ...podOpts, script: [{ T: 0.4 }], loop: SESSION_LOOP, t0: p.t + 0.02 }); };
  const wss = new WebSocketServer({ port: B }); wss.on('connection', (ws, req) => { const tag = req.url.slice(1), p = pods[tag] || rest(tag); p.socks.add(ws); ws.on('close', () => p.socks.delete(ws)); ws.on('error', () => p.socks.delete(ws)); });
  const start = performance.now(); let sent = 0;
  const iv = setInterval(() => { const due = Math.floor((performance.now() - start) / 20);
    for (; sent <= due; sent++) for (const p of Object.values(pods)) { const m = p.syn.next(); delete m._t; p.t = m.t; const j = JSON.stringify(m); for (const ws of p.socks) if (ws.readyState === 1) ws.send(j); } }, 5);
  const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
  const browsers = [];
  const launch = async () => { const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }); browsers.push(b); return b; };
  const ok = (c, what) => { out.push((c ? 'PASS ' : 'FAIL ') + what); console.log(c ? 'PASS' : 'FAIL', what); return c; };
  const note = what => { out.push('NOTE ' + what); console.log('NOTE', what); };
  const close = async () => { clearInterval(iv); for (const b of browsers.splice(0)) await b.close().catch(() => {}); server.kill(); wss.close(); await sleep(400); };
  const done = async code => { clearInterval(iv); for (const b of browsers) await b.close().catch(() => {}); server.kill(); wss.close(); const f = out.filter(l => l.startsWith('FAIL')); console.log(`${out.filter(l => l.startsWith('PASS')).length} passed, ${f.length} failed`); if (errs.length) console.log('console/page errors:\n  ' + errs.join('\n  ')); if (f.length) console.log('server log tail:\n' + slog.join('').split('\n').slice(-15).join('\n')); process.exit(code ?? (f.length ? 1 : 0)); };
  for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('CRASH', e); done(2); });
  const st = pg => pg.evaluate(() => { const t = id => document.getElementById(id), vis = id => { const e = t(id); if (!e || e.hidden) return false; const c = getComputedStyle(e), b = e.getBoundingClientRect(); return c.display !== 'none' && c.visibility !== 'hidden' && +c.opacity > 0.05 && b.width > 0; },
      tx = id => t(id) ? t(id).textContent.trim() : null, s = window.__stats, d = document.body.dataset, sc = window.__scene, v = sc ? sc._dbg.view() : {}, bm = sc ? sc._dbg.ballMesh : null;
    return { screen: d.screen, overlay: d.overlay || null, role: d.role || null, dview: d.view || null, paused: d.paused === '1', settings: d.settings === 'open', phase: s.phase, srole: s.role, room: s.room,
      lview: [...document.querySelectorAll('#screen-lobby .lobby-view')].find(e => !e.hidden)?.dataset.view, share: (tx('share-code') || '').replace(/\s/g, ''), pill: t('room-pill').hidden ? null : tx('room-code'), chip: t('title-room').hidden ? null : tx('title-room'),
      err: tx('code-err'), toast: t('toast').classList.contains('on') ? tx('toast') : null, ask: vis('ask-watch') ? tx('ask-title') : null, gated: [...document.querySelectorAll('#lobby-home .tile')].every(e => e.getAttribute('aria-disabled') === 'true'), nameVal: t('name-input') ? t('name-input').value : null,
      rows: [...document.querySelectorAll('#room-list li')].map(li => li.textContent.trim()), me: tx('name-me'), meSub: tx('sub-me'), them: tx('name-them'), themSub: tx('sub-them'), scMe: +tx('sc-me'), scThem: +tx('sc-them'),
      svMe: t('sv-me').classList.contains('on'), svThem: t('sv-them').classList.contains('on'), banner: tx('banner-text'), keys: vis('keys') ? [...document.querySelectorAll('#keys li')].filter(e => !e.hidden).map(e => e.textContent.trim()).join(' | ') : null, menuBtn: vis('btn-menu'), views: vis('views'), watchTag: vis('watch-tag'), pausedTag: vis('paused-tag'),
      watchers: vis('watchers') ? +tx('watch-n') : 0, pov: tx('view-pov'), glass: +getComputedStyle(t('glass')).opacity, setTitle: tx('set-title'), note: vis('set-note') ? tx('set-note') : null,
      hold: vis('hold') ? tx('hold-text') + '|' + tx('hold-left') : null, result: d.overlay === 'match' && vis('result') ? { title: tx('result-title'), note: tx('result-note'), me: tx('tally-name-me'), them: tx('tally-name-them'), sc: tx('tally-sc-me') + '-' + tx('tally-sc-them'), btns: vis('rematch-btns'), rnote: tx('rematch-note'), left: tx('rematch-left') } : null,
      search: location.search, calibrated: s.calibrated, hits: s.hits, myHits: s.myHits, swings: s.swings, ev: { ...s.events }, errors: s.errors,
      tags: sc ? sc._dbg.pads.map(p => p.tag.visible ? p.status : null) : [], ghost: sc ? sc._dbg.pads.map(p => +p.ghost.toFixed(2)) : [],
      scene: { name: v.name, side: v.side, menu: v.menu, attract: v.attract, frozen: v.frozen, spectator: v.spectator, pr: v.pixelRatio, drawn: v.drawn }, ball: bm ? [bm.position.x, bm.position.y, bm.position.z, bm.visible ? 1 : 0] : null }; });
  async function until(pg, test, ms, what) { const end = Date.now() + ms; let s; do { s = await st(pg); if (test(s)) return s; await sleep(120); } while (Date.now() < end); const { ev, scene, ...brief } = s; ok(false, `${what} (gave up after ${ms / 1000} s: ${JSON.stringify(brief)})`); return s; }
  const url = (tag, query = '') => `http://localhost:${G}/?bridge=${B}/${tag}&game=${G}&uitest=1${query}`;
  async function open(tag, name, query = '', w = 1280, h = 720) { const pg = (await (await launch()).pages())[0]; await pg.setViewport({ width: w, height: h }); pg.tag = tag;
    pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`)); pg.on('response', r => { if (r.status() >= 400) errs.push(`[${tag}] ${r.status()} ${r.url()}`); });
    pg.on('console', m => { if (m.type() === 'error' && !(pg.cutting && /WebSocket|ERR_CONNECTION/.test(m.text()))) errs.push(`[${tag}] ${m.text()}`); });
    await pg.evaluateOnNewDocument((name, dead) => { try { if (name && !localStorage.getItem('poddle.name')) localStorage.setItem('poddle.name', name); localStorage.setItem('poddle.camPrimer', 'allow'); } catch { /* */ }
      const WS = window.WebSocket, socks = []; let cut = false;
      window.WebSocket = class extends WS { constructor(u, p) { const game = /[?&]cid=/.test(u); super(game && cut ? `ws://localhost:${dead}` : u, p); if (game) socks.push(this); } };
      window.__cut = on => { cut = on; if (on) for (const s of socks.splice(0)) s.close(); }; }, name, DEAD);
    await pg.goto(url(tag, query)); await sleep(1500); return pg; }
  const shot = async (pg, n, sizes = [[1280, 720]]) => { const was = pg.viewport();
    for (const [w, h] of sizes) { if (pg.viewport().width !== w || pg.viewport().height !== h) { await pg.setViewport({ width: w, height: h }); await sleep(500); } await pg.mouse.move(w / 2, h / 2 + 3); await sleep(450);
      await pg.screenshot({ path: `${SHOTS}emotes-${n}-${w}x${h}.png` }); }
    if (pg.viewport().width !== was.width || pg.viewport().height !== was.height) { await pg.setViewport(was); await sleep(400); } };
  const BOTH = [[1280, 720], [600, 900]];
  const type = async (pg, text) => { for (const c of text) await pg.keyboard.type(c, { delay: 25 }); await sleep(150); };
  const play = async pg => { if ((await st(pg)).screen !== 'title') { note(pg.tag + ': Play not pressed, already at ' + (await st(pg)).screen); return; } await pg.click('#btn-start'); await sleep(300); await pg.evaluate(() => document.fullscreenElement && document.exitFullscreen()); };
  const toLobby = async pg => { await play(pg); return until(pg, s => s.screen === 'lobby', 3000, `${pg.tag} Play -> lobby`); };
  async function toCourt(pg, ms = 30000) { const s = await until(pg, s => s.screen === 'calibrate' || s.calibrated && s.screen === 'hud', 8000, `${pg.tag} reaches calibration`);
    if (s.screen === 'calibrate') go(pg.tag); else swing(pg.tag); return until(pg, s => s.calibrated && s.screen === 'hud', ms, `${pg.tag} is on the court`); }
  const reload = async pg => { await pg.reload(); await sleep(1500); };
  // rectangles of everything visible in the HUD corners, to find overlaps
  const boxes = (pg, ids) => pg.evaluate(ids => Object.fromEntries(ids.map(id => { const e = document.getElementById(id) || document.querySelector(id); if (!e) return [id, null]; const c = getComputedStyle(e), b = e.getBoundingClientRect(); return [id, e.hidden || c.display === 'none' || c.visibility === 'hidden' || +c.opacity < 0.05 || !b.width ? null : [Math.round(b.left), Math.round(b.top), Math.round(b.right), Math.round(b.bottom)]]; })), ids);
  const overlaps = bx => { const k = Object.keys(bx).filter(i => bx[i]), hit = []; for (let i = 0; i < k.length; i++) for (let j = i + 1; j < k.length; j++) { const a = bx[k[i]], b = bx[k[j]]; if (a[0] < b[2] - 1 && b[0] < a[2] - 1 && a[1] < b[3] - 1 && b[1] < a[3] - 1) hit.push(`${k[i]} x ${k[j]}`); } return hit; };
  return { G, B, DEAD, server, slog, pods, rest, go, swing, ok, note, done, close, st, until, open, shot, BOTH, type, play, toLobby, toCourt, reload, url, errs, out, boxes, overlaps };
}

setTimeout(() => { console.log('EMOTEBAR E2E FAIL (timeout)'); process.exit(2); }, 6 * 60000);
fs.mkdirSync(SHOTS, { recursive: true });
const R = rig({ WIN_AT: '11' }), { ok, done, until, open, shot, type, play, toLobby, toCourt, boxes, overlaps } = R; let s; const J = JSON.stringify;
const a = await open('a', 'Ann'), b = await open('b', 'Ben');
await toLobby(a); await a.click('#btn-courts'); await sleep(300); await a.click('#btn-create'); await sleep(300); await a.click('#seg [data-public="0"]'); await a.click('#btn-create-go'); s = await until(a, s => s.lview === 'share' && s.share.length === 4, 3000, 'share view'); const CODE = s.share;
await toLobby(b); await b.click('#btn-courts'); await sleep(300); await b.click('#code-boxes input'); await type(b, CODE); await b.keyboard.press('Enter'); await a.click('#btn-share-go');
await Promise.all([toCourt(a), toCourt(b)]);
const c = await open('c', 'Cat', `&court=${CODE}&watch=1`); await play(c); await until(c, s => s.phase === 'watch', 6000, 'c watches');
const bar = pg => pg.evaluate(() => { const box = document.getElementById('emotes'), r = box.getBoundingClientRect(), cs = getComputedStyle(box);
  return { shown: cs.display !== 'none' && +cs.opacity > 0.9 && r.width > 0, right: Math.round(innerWidth - r.right), bottom: Math.round(innerHeight - r.bottom), w: Math.round(r.width), h: Math.round(r.height), cool: box.classList.contains('is-cool'),
    keys: [...box.querySelectorAll('.emote-key')].map(k => getComputedStyle(k).display === 'none' ? '' : k.textContent).join(''), first: box.firstElementChild?.textContent.replace(/\d/g, ''), n: box.childElementCount,
    pops: [...document.querySelectorAll('#emote-layer .emote-pop, #emote-layer .emote-bub')].map(p => (p.querySelector('img')?.alt || p.querySelector('.emote-gg')?.textContent) + ':' + (p.classList.contains('emote-bub') ? '@' + (p.classList.contains('is-me') ? 'me' : 'them') : p.querySelector('span')?.textContent || '')) }; });
// a player's bubble: where it sits against its scoreboard tab, the corner's pills and the insets (NOTES 207)
const bub = pg => pg.evaluate(() => { const b = document.querySelector('#emote-layer .emote-bub'); if (!b) return null; const r = b.getBoundingClientRect(), tab = document.querySelector(`#board .score-tab.${b.classList.contains('is-me') ? 'is-me' : 'is-them'}`).getBoundingClientRect();
  const hit = [...document.querySelectorAll('#corner > *, #board, #camwrap, #podwrap')].filter(e => !e.hidden && e.getBoundingClientRect().width).some(e => { const q = e.getBoundingClientRect(); return r.left < q.right - 1 && q.left < r.right - 1 && r.top < q.bottom - 1 && q.top < r.bottom - 1; });
  return { where: b.classList.contains('is-side') ? 'side' : 'below', next: b.classList.contains('is-side') ? (b.classList.contains('is-me') ? Math.round(tab.left - r.right) : Math.round(r.left - tab.right)) : Math.round(r.top - tab.bottom), hit, inside: r.left >= 0 && r.right <= innerWidth }; });
const SIZES = [[1280, 720], [900, 700], [700, 900], [390, 844]];
for (const [pg, who] of [[a, 'player'], [c, 'spectator']]) for (const [w, h] of SIZES) { await pg.setViewport({ width: w, height: h }); await sleep(600); await pg.mouse.move(w / 2, h / 2 + 3); await sleep(300); await pg.waitForFunction(() => !document.body.classList.contains('has-toast'), { timeout: 8000 }).catch(() => {}); await sleep(600);      // a toast (Your serve) hides the bar a moment
  s = await bar(pg); const bx = await boxes(pg, ['emotes', 'keys', 'views', 'btn-ask', 'toast']), hit = overlaps(bx);
  ok(s.shown && s.n === 10 && s.first === 'GG' && s.keys === '1234567890' && s.right >= 8 && s.bottom >= 8 && s.w <= 340, `${who} ${w}x${h}: the bar shows, GG first, keys 1-0, ${s.w}x${s.h} px, ${s.right}/${s.bottom} px off the corner`);
  ok(!hit.length, `${who} ${w}x${h}: nothing overlaps the bar (${hit.join(', ') || 'clear'})`);
  await pg.screenshot({ path: `${SHOTS}emotes-${who}-${w}x${h}.png` }); }
for (const [w, h] of SIZES) { for (const pg of [a, b]) { await pg.setViewport({ width: w, height: h }); } await sleep(1200);
  await a.keyboard.press('Digit3'); await sleep(450); const mine = await bub(a), theirs = await bub(b);
  for (const [k, v] of [['Ann (her own, left)', mine], ['Ben (Ann\'s, right)', theirs]]) ok(v && !v.hit && v.inside && v.next >= 4 && v.next <= 14, `${w}x${h} ${k}: the bubble sits ${v?.where} its tab (${v?.next} px off), clear of the board, the corner and the insets`);
  await a.screenshot({ path: `${SHOTS}emotes-bubble-me-${w}x${h}.png` }); await b.screenshot({ path: `${SHOTS}emotes-bubble-them-${w}x${h}.png` }); await sleep(2400); }
for (const pg of [a, b, c]) { await pg.setViewport({ width: 1280, height: 720 }); } await sleep(600);
await a.keyboard.press('Digit1'); await sleep(250);
for (const [pg, who, at] of [[a, 'Ann', '@me'], [b, 'Ben', '@them'], [c, 'Cat', '@me']]) { s = await bar(pg); ok(J(s.pops) === J(['GG' + ':' + at]), `${who} sees Ann's GG in a bubble out of her tab, the ${at === '@me' ? 'left' : 'right'} one (${s.pops})`); }
s = await bar(a); ok(s.cool, 'the bar rests after a pick');
await a.keyboard.press('Digit2'); await sleep(300); s = await bar(b); ok(J(s.pops) === J(['GG:@them']), `a second key inside the second does nothing (${s.pops})`);
await a.screenshot({ path: `${SHOTS}emotes-pop-player-1280x720.png` }); await c.screenshot({ path: `${SHOTS}emotes-pop-spectator-1280x720.png` });
await sleep(1000); s = await bar(a); ok(!s.cool, 'the bar is back after a second');
await a.keyboard.press('Digit0'); await sleep(300); s = await bar(b); ok(J(s.pops) === J(['😢:@them']), `0 is the tenth, 😢, and it replaces her last bubble (${s.pops})`);
await c.keyboard.press('Digit3'); await sleep(300); s = await bar(a); ok(s.pops.includes('💚:Cat'), `the spectator's 3 reaches the player: 💚 (${s.pops})`);
await sleep(2600); s = await bar(b); ok(s.pops.length === 0, `the pops are gone within about two seconds (${s.pops})`);
const v = pg => pg.evaluate(() => { const x = window.__scene._dbg.view(); return x.name + (x.name === 'pov' ? x.side : ''); });
const seen = []; for (let i = 0; i < 5; i++) { await c.keyboard.press('KeyV'); await sleep(250); seen.push(await v(c)); }
ok(seen.join(' ') === 'split pov0 pov1 free broadcast', `V steps through the views: ${seen.join(' ')}`);
s = await bar(c); ok(s.pops.length === 0, 'V sends no emote');
await c.keyboard.press('Digit2'); await sleep(250); ok((await v(c)) === 'broadcast', 'a number no longer changes the view');
// against Matt: his difficulty row has the bottom-left corner (NOTES 204), the bar the bottom-right; they never meet, however narrow
const d = await open('d', 'Dot'); await toLobby(d); await d.click('#btn-bot'); await sleep(300); await d.click('#btn-bot-1'); await toCourt(d); await until(d, s => s.them === 'Matt', 6000, 'Matt sits down');
for (const [w, h] of SIZES) { await d.setViewport({ width: w, height: h }); await sleep(600); await d.mouse.move(w / 2, h / 2 + 3); await d.waitForFunction(() => !document.body.classList.contains('has-toast'), { timeout: 8000 }).catch(() => {}); await sleep(600);
  const bx = await boxes(d, ['emotes', '#keys li', '#key-bot', 'bot-pick']), hit = overlaps(bx); ok(bx.emotes && bx['bot-pick'] && !hit.length, `against Matt ${w}x${h}: the bar and the difficulty row both show, apart (${hit.join(', ') || JSON.stringify(bx)})`);
  await d.screenshot({ path: `${SHOTS}emotes-matt-${w}x${h}.png` }); }
// a toast (the longest: a mid-match level change) never moves Matt's row, and never lands on it (NOTES 206)
for (const [w, h] of SIZES) { await d.setViewport({ width: w, height: h }); await sleep(500); const at = async () => (await boxes(d, ['bot-pick']))['bot-pick'];
  const was = await at(); await d.evaluate(() => window.__ui.toast('Matt · Rookie · counts as Pro · Rookie again restarts at 0-0', 4000)); await sleep(700);
  const now = await at(), bx = await boxes(d, ['bot-pick', 'toast']), hit = overlaps(bx);
  ok(JSON.stringify(was) === JSON.stringify(now) && !hit.length, `toast up ${w}x${h}: the difficulty row stays put (${was} -> ${now}) and clear of the toast (${hit.join(', ') || JSON.stringify(bx.toast)})`);
  await d.screenshot({ path: `${SHOTS}emotes-matt-toast-${w}x${h}.png` }); await d.evaluate(() => window.__ui.toastOff()); await sleep(300); }
await done();
