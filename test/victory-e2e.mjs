// The winner's shot (NOTES 165): real server/game.js, fake AirPods, real Chromes. Ann + Ben play to 3, Cat watches.
// The winner: VICTORY! holds the court for 2.6 s with no panel, then the cut: the result panel down the right two fifths, the winner in the left
// three fifths holding the trophy where the paddle was (it turns with the paddle), solid, looked at by one camera. The loser and the spectator get
// the cut at once. A tall window lays the panel along the bottom. A rematch puts the paddle back and the play camera with it.
// VICTORY_PORT=<base> moves the block (base .. base+2). Screenshots: test/ui-shots/victory-*.png. LOOK at them.
import { spawn } from 'child_process'; import fs from 'fs';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
import { makeSynth, CALIBRATE, SESSION_LOOP } from './fake-bridge.mjs';
const root = new URL('..', import.meta.url).pathname, SHOTS = root + 'test/ui-shots/', sleep = ms => new Promise(r => setTimeout(r, ms)), P0 = +process.env.VICTORY_PORT || 8470;
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
      await pg.screenshot({ path: `${SHOTS}victory-${n}-${w}x${h}.png` }); }
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


setTimeout(() => { console.log('VICTORY E2E FAIL (timeout)'); process.exit(2); }, 12 * 60000);
fs.mkdirSync(SHOTS, { recursive: true });
const R = rig({ WIN_AT: '3', WIN_BY: '1' }), { ok, st, until, open, shot, BOTH, type, play, toLobby, toCourt } = R; let s;
const a = await open('a', 'Ann'), b = await open('b', 'Ben');
await toLobby(a); await a.click('#btn-courts'); await sleep(300); await a.click('#btn-create'); await sleep(300); await a.click('#seg [data-public="0"]'); await a.click('#btn-create-go'); s = await until(a, s => s.lview === 'share' && s.share.length === 4, 3000, 'share view'); const CODE = s.share;
await toLobby(b); await b.click('#btn-courts'); await sleep(300); await b.click('#code-boxes input'); await type(b, CODE); await b.keyboard.press('Enter'); await a.click('#btn-share-go');
await Promise.all([toCourt(a), toCourt(b)]);
const c = await open('c', 'Cat', `&court=${CODE}&watch=1`); await play(c); await until(c, s => s.phase === 'watch', 6000, 'c watches'); await c.keyboard.press('Digit2');      // split: the shot must take the whole window back
// what the result looks like right now: the stamp, the panel's box, the scene's shot, and where the winner's head and the trophy land on screen
const look = pg => pg.evaluate(() => { const $ = id => document.getElementById(id), d = window.__scene._dbg, W = innerWidth, H = innerHeight, slam = $('result-slam'), card = $('result').getBoundingClientRect(), v = d.vic.side, pd = v >= 0 ? d.pads[v] : null;
  const at = p => { const q = p.clone().project(d.camera); return [+((q.x + 1) / 2 * W).toFixed(0), +((1 - q.y) / 2 * H).toFixed(0)]; }, head = pd ? pd.avatar.position.clone().setY(1.9) : null;
  return { W, H, overlay: document.body.dataset.overlay || null, beat: $('screen-match').dataset.beat, stamp: $('screen-match').classList.contains('is-stamp'), slam: slam.textContent, slamA: +(+getComputedStyle(slam).opacity).toFixed(2),
    card: [card.left, card.top, card.right, card.bottom].map(Math.round), vic: v, trophy: d.trophy.visible, paddle: pd ? pd.group.visible : null, solid: pd ? !pd.self && pd.avatar.visible : null,
    same: pd ? d.trophy.quaternion.angleTo(pd.group.quaternion) < 1e-6 && d.trophy.position.distanceTo(pd.group.position) < 1e-6 : null, head: head ? at(head) : null, cup: pd ? at(d.trophy.position) : null,
    focus: document.activeElement && document.activeElement.id, title: $('result-title').textContent, split: d.view().name, pods: d.pads.map(p => p.group.visible) }; });
s = await until(a, s => s.overlay === 'match', 240000, 'the match ends'); const t0 = Date.now();
const won = s.scMe > s.scThem, w = won ? a : b, l = won ? b : a, side = won ? 0 : 1; console.log('NOTE winner:', won ? 'Ann' : 'Ben');
await sleep(Math.max(0, 600 - (Date.now() - t0)));
let W1 = await look(w), L1 = await look(l), C1 = await look(c);
ok(W1.slam === 'VICTORY!' && W1.slamA > 0.9 && W1.stamp && W1.card[0] >= W1.W - 2 && W1.vic === -1 && !W1.trophy, `winner at 0.6 s: VICTORY! alone over the court, the panel off screen, no cut yet (${JSON.stringify({ slam: W1.slam, a: W1.slamA, card: W1.card, vic: W1.vic })})`);
ok(W1.focus !== 'btn-rematch', `nothing on the hidden panel has focus behind VICTORY! (${W1.focus})`); await w.keyboard.press('Enter');      // and Enter there votes for nothing
ok(L1.slam === '' && L1.vic === side && L1.trophy && L1.card[0] < L1.W * 0.7 && L1.paddle === false && L1.solid && L1.same, `loser at 0.6 s: no stamp, the cut at once: the winner (seat ${L1.vic}) holds the trophy, paddle gone (${JSON.stringify({ card: L1.card, paddle: L1.paddle, solid: L1.solid, same: L1.same })})`);
ok(C1.vic === side && C1.trophy && C1.split === 'split' && C1.title.endsWith('wins'), `spectator in split: one shot of the winner all the same (${C1.vic}, "${C1.title}")`);
s = await w.evaluate(() => { const scr = document.getElementById('screen-match'), t = performance.now(); new MutationObserver(() => { if (!scr.classList.contains('is-stamp') && !window.__drop) window.__drop = performance.now() - t; }).observe(scr, { attributes: true });
  return document.getElementById('result-slam').getAnimations().map(x => x.effect.getTiming().duration)[0]; }); ok(s === 2800, `VICTORY! plays for 2.8 s (it was 0.95 s): ${s} ms`);
await w.screenshot({ path: `${SHOTS}victory-stamp-1280x720.png` });
await sleep(Math.max(0, 4300 - (Date.now() - t0))); W1 = await look(w); L1 = await look(l);
const inPane = (o, x0, x1, y0, y1) => o.head && o.cup && [o.head, o.cup].every(p => p[0] > x0 && p[0] < x1 && p[1] > y0 && p[1] < y1);
s = await w.evaluate(() => window.__drop); ok(s > 1200 && s < 2400, `the panel waited behind VICTORY! until 2.6 s (the class dropped ${Math.round(s)} ms after the 0.6 s look)`);
ok(W1.slamA < 0.05 && !W1.stamp && W1.vic === side && W1.trophy && W1.paddle === false && W1.solid && W1.same, `winner at 4.3 s: VICTORY! gone, the cut: my own seat ${W1.vic} holds the trophy, solid, no paddle (${JSON.stringify({ a: W1.slamA, paddle: W1.paddle, solid: W1.solid, same: W1.same })})`);
ok(Math.abs(W1.card[0] - W1.W * 0.6) < 3 && W1.card[2] === W1.W && W1.card[1] === 0 && W1.card[3] === W1.H, `the panel is the right two fifths, full height (${W1.card})`);
ok(inPane(W1, 0, W1.W * 0.6, 0, W1.H) && inPane(L1, 0, L1.W * 0.6, 0, L1.H), `the winner's head and the trophy are inside the left three fifths (winner's view ${JSON.stringify([W1.head, W1.cup])}, loser's ${JSON.stringify([L1.head, L1.cup])})`);
ok(W1.focus === 'btn-rematch' && (await st(w)).result.btns, `Rematch has focus once the panel is in (${W1.focus}); the early Enter voted nothing`);
s = await w.evaluate(() => { const c = document.getElementById('result'); return { fit: c.scrollHeight <= c.clientHeight + 1, rows: ['result-title', 'tally-sc-me', 'btn-rematch', 'btn-leave'].every(id => { const r = document.getElementById(id).getBoundingClientRect(), p = c.getBoundingClientRect(); return r.left >= p.left && r.right <= p.right + 1 && r.top >= 0 && r.bottom <= innerHeight; }) }; });
ok(s.fit && s.rows, `the panel shows its title, score and both buttons without scrolling (${JSON.stringify(s)})`);
await shot(w, 'winner'); await shot(l, 'loser'); await shot(c, 'watch', BOTH);
await c.setViewport({ width: 600, height: 900 }); await sleep(900); C1 = await look(c);
ok(C1.card[0] === 0 && C1.card[2] === 600 && C1.card[3] === 900 && C1.card[1] > 900 * 0.4 && inPane(C1, 0, 600, 0, C1.card[1]), `600x900: the panel lies along the bottom (${C1.card}), the winner and the trophy above it (${JSON.stringify([C1.head, C1.cup])})`);
await c.setViewport({ width: 1280, height: 720 }); await sleep(400);
// the trophy is the paddle's: turn the hand, it turns
const q0 = await l.evaluate(() => window.__scene._dbg.trophy.quaternion.toArray()); R.swing(w.tag); await sleep(900); const q1 = await l.evaluate(() => window.__scene._dbg.trophy.quaternion.toArray());
ok(Math.hypot(...q0.map((v, i) => v - q1[i])) > 0.02, `the winner's hand turns the trophy on the loser's screen too (${q0.map(v => v.toFixed(2))} -> ${q1.map(v => v.toFixed(2))})`);
// rematch: the paddles and the game's own cameras come back
await w.click('#btn-rematch'); await l.click('#btn-rematch'); await until(w, s => s.overlay === null, 5000, 'rematch on'); await sleep(400);
W1 = await look(w); C1 = await look(c); ok(W1.vic === -1 && !W1.trophy && W1.pods.every(Boolean) && C1.vic === -1 && !C1.trophy, `rematch: no trophy, both paddles back (${JSON.stringify({ vic: W1.vic, trophy: W1.trophy, pods: W1.pods })})`);
await R.close();
const fails = out.filter(x => x.startsWith('FAIL')); if (errs.length) console.log('console/page errors:\n  ' + errs.join('\n  '));
console.log(fails.length || errs.length ? `VICTORY E2E FAIL (${fails.length} failed, ${errs.length} page errors)` : `VICTORY E2E PASSED (${out.filter(x => x.startsWith('PASS')).length} checks)`); process.exit(fails.length || errs.length ? 1 : 0);
