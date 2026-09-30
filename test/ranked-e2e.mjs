// Ranked end to end (docs/RANKED.md 8, 11.12): the real client against the real server/game.js, fake AirPods, TWO headless Chromes and a seeded
// ladder. Ann presses Ranked, Find a match: she stays on the Ranked view with the search bar at the top (OPTIONAL WARM-UP), presses Warm up with Matt
// and plays him in the stadium with the queue pill; Ben queues from the lobby and never warms up; both see MATCH FOUND with the emblems, the series
// court with the pips, a game, the GAME card, then the series card with the trophy roll and, from 140 trophies, a rank-up for the winner; Play again
// queues the winner in the lobby (the bar again, on the title too), the loser lands on the Ranked view. Codes only in the server log.
// Usage: node test/ranked-e2e.mjs      RANKED_E2E_PORT=<base> moves the ports (default 8625: game + page, 8626: AirPods, 8627: nothing)
// Screenshots land in test/ui-shots/ranked-e2e-*.png. Takes 2-5 minutes: run it in the background.
import { spawn } from 'child_process'; import fs from 'fs'; import os from 'os'; import path from 'path';
import { createRequire } from 'module';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
import { makeSynth, CALIBRATE, SESSION_LOOP } from './fake-bridge.mjs';
const require = createRequire(import.meta.url), db = require('../server/db.js');
const P0 = +process.env.RANKED_E2E_PORT || 8625, G = P0, B = P0 + 1, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
// the fixture: both devices at 140 trophies (Bronze III), one win from Silver. The device ids are set in each Chrome's localStorage below
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poddle-rke2e-')), DB = path.join(tmp, 'e2e.db'), DEV = { a: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', b: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
{ db.open(DB); const now = Date.now(); for (const d of Object.values(DEV)) { const owner = db.ownerForDevice(db.hash(d), now, { create: true }); const r = db.ladderApply({ owner, delta: 140, won: true, vsBot: false, now }); if (!r || r.trophies !== 140) { console.log('RANKED E2E FAIL: could not seed the ladder', r); process.exit(2); } } db.close(); }
const server = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, RK_GUESTS: '1', PORT: G, PODDLE_DB: DB, WIN_BY: 1, RK_WIN: 2, RK_BEST: 3, RK_VS_S: 2, RK_GAME_GAP_S: 3, RK_DONE_S: 9, RK_ARRIVE_S: 40, READY_S: 0, TOUR_WIN: 2, TOUR_FINAL: 3, TOUR_VS_S: 2, TOUR_ARRIVE_S: 40, TOUR_GAP_S: 4, TOUR_DONE_S: 60,
  STATS_FORFEIT_MIN: 1, STATS_AFK_MIN: 0, STATS_ESTABLISHED: 0, STATS_MIN_POINT_S: 0, RK_MATT_DAY: 1 }, stdio: ['ignore', 'pipe', 'inherit'] }), slog = []; server.stdout.on('data', d => slog.push(String(d)));

// ---- AirPods: one per tab, told apart by the path (as test/tourney-e2e.mjs). rest = lying still, go = calibrate then swing
const pods = {}, podOpts = { heading: 137, gyroNoise: 0.02, accNoise: 0.005, seed: 7 };
const rest = tag => { const p = pods[tag] ??= { t: 3580, socks: new Set() }; p.syn = makeSynth({ ...podOpts, script: [], t0: p.t + 0.02 }); return p; };
const go = tag => { const p = pods[tag] || rest(tag); p.syn = makeSynth({ ...podOpts, script: CALIBRATE, loop: SESSION_LOOP, t0: p.t + 0.02 }); };
new WebSocketServer({ port: B }).on('connection', (ws, req) => { const tag = req.url.slice(1), p = pods[tag] || rest(tag); p.socks.add(ws); ws.on('close', () => p.socks.delete(ws)); ws.on('error', () => p.socks.delete(ws)); });
{ const start = performance.now(); let sent = 0;
  setInterval(() => { const due = Math.floor((performance.now() - start) / 20);
    for (; sent <= due; sent++) for (const p of Object.values(pods)) { const m = p.syn.next(); delete m._t; p.t = m.t; const j = JSON.stringify(m); for (const ws of p.socks) if (ws.readyState === 1) ws.send(j); } }, 5); }

const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const browsers = [], launch = async () => { const b = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] }); browsers.push(b); return b; };
fs.mkdirSync(root + 'test/ui-shots', { recursive: true });
const out = [], errs = [], ok = (c, what) => { out.push((c ? 'PASS ' : 'FAIL ') + what); console.log(c ? 'PASS' : 'FAIL', what); return c; };
const done = async code => { for (const b of browsers) await b.close().catch(() => {}); server.kill(); fs.rmSync(tmp, { recursive: true, force: true }); process.exit(code); };
setTimeout(() => { console.log('RANKED E2E FAIL (timeout)'); done(2); }, 600000);
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('RANKED E2E FAIL', e); done(2); });
server.on('exit', c => { console.log(`RANKED E2E FAIL: server/game.js stopped (${c}). Is port ${G} taken?`); done(2); });

// everything a check reads, in one round trip
const st = pg => pg.evaluate(() => { const t = id => document.getElementById(id), vis = id => { const e = t(id); if (!e || e.hidden) return false; const c = getComputedStyle(e), b = e.getBoundingClientRect(); return c.display !== 'none' && c.visibility !== 'hidden' && +c.opacity > 0.05 && b.width > 0; },
    tx = id => t(id) ? t(id).textContent.trim() : null, s = window.__stats, d = document.body.dataset;
  return { screen: d.screen, overlay: d.overlay || null, venue: d.venue || null, rkBody: d.rk || null, phase: s.phase, role: s.role, room: s.room, rk: s.rk, calibrated: s.calibrated, errors: s.errors, search: location.search,
    lview: [...document.querySelectorAll('#screen-lobby .lobby-view')].find(e => !e.hidden)?.dataset.view, title: tx('lobby-title'), toast: t('toast').classList.contains('on') ? tx('toast') : null,
    tile: vis('btn-ranked'), tileLine: tx('ranked-line-text'), head: tx('rk-tier'), headN: tx('rk-trophies'), go: tx('btn-ranked-go'), goOff: !!t('btn-ranked-go')?.disabled, status: tx('rk-status'),
    bar: vis('rk-search') ? tx('rk-search-title') + ' ' + tx('rk-search-time') + ' | ' + tx('rk-search-sub') : null, focus: document.activeElement?.id || '',
    pill: vis('rk-pill') ? tx('rk-pill-text') + ' | ' + tx('rk-pill-sub') : null, roomPill: vis('room-pill'), leaveBtn: tx('btn-leave-room'), note: t('set-note') && !t('set-note').hidden ? tx('set-note') : '',
    names: tx('name-me') + ' / ' + tx('name-them'), emblems: document.querySelectorAll('#board .rank-badge .rank-em:not([hidden])').length, pips: vis('series') ? [...document.querySelectorAll('#series .pips')].map(o => o.querySelectorAll('li').length + ':' + o.querySelectorAll('.is-won').length).join(',') : null,
    banner: t('banner').classList.contains('show') ? tx('banner-text') : null, word: tx('rally-word'), keys: [...document.querySelectorAll('#keys li')].filter(e => !e.hidden).map(e => e.textContent.trim()).join(' | '),
    vs: d.overlay === 'rk-vs' ? { round: tx('vs-round'), them: tx('vs-them'), target: tx('vs-target'), ems: [...document.querySelectorAll('.vs-em:not([hidden]) .rank-card-em b')].map(e => e.textContent).join(','), ranked: t('vs-card').classList.contains('is-ranked') } : null,
    game: d.overlay === 'rk-game' ? { title: tx('game-title'), score: tx('game-sc-me') + '-' + tx('game-sc-them'), pips: [...document.querySelectorAll('#game-rows .pips')].map(o => o.querySelectorAll('.is-won').length).join('-'), left: tx('game-left'), serve: tx('game-serve'), deciding: vis('game-deciding') } : null,
    result: d.overlay === 'match' && vis('result') ? { title: tx('result-title'), note: tx('result-note'), rk: t('result').classList.contains('is-rk'), pips: document.querySelectorAll('#result-pips .is-won').length, games: t('tally-games').hidden ? '' : tx('tally-games'), tally: tx('tally-sc-me') + '-' + tx('tally-sc-them'), again: vis('btn-rk-again'), leave: vis('btn-rk-leave'), vote: vis('rematch-btns'), left: tx('rematch-left'), slam: tx('result-slam') } : null,
    trophy: vis('trophy') ? { n: tx('trophy-n'), pill: tx('trophy-d'), note: vis('trophy-note') ? tx('trophy-note') : '', em: document.querySelector('#trophy-em .rank-em use')?.getAttribute('href'), rays: !!document.querySelector('#trophy-em .medal-rays.is-on') } : null,
    confetti: document.querySelectorAll('.confetti').length,
    clipped: [...document.querySelectorAll('.screen.is-active [data-fit], #hud [data-fit]')].filter(e => { const b = e.getBoundingClientRect(), c = getComputedStyle(e); return b.width && !e.hidden && c.visibility !== 'hidden' && c.display !== 'none' && (b.left < -.5 || b.top < -.5 || b.right > innerWidth + .5 || b.bottom > innerHeight + .5); }).map(e => e.id || e.className) }; });
async function until(pg, test, ms, what) { const end = Date.now() + ms; let s; do { s = await st(pg); if (test(s)) return s; await sleep(150); } while (Date.now() < end); ok(false, `${pg.tag}: ${what} (gave up after ${ms / 1000} s: ${JSON.stringify(s)})`); return s; }
async function open(tag, name, query = '', w = 1280, h = 720) { const pg = (await (await launch()).pages())[0]; await pg.setViewport({ width: w, height: h }); pg.tag = tag;
  pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`)); pg.on('response', r => { if (r.status() >= 400) errs.push(`[${tag}] ${r.status()} ${r.url()}`); });
  pg.on('console', m => { if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION/.test(m.text())) errs.push(`[${tag}] ${m.text()}`); });
  await pg.evaluateOnNewDocument((name, dev) => { try { localStorage.setItem('poddle.name', name); localStorage.setItem('poddle.camPrimer', 'allow'); localStorage.setItem('poddle.device', dev); } catch { /* */ } }, name, DEV[tag]);
  await pg.goto(`http://localhost:${G}/?bridge=${B}/${tag}&game=${G}&uitest=1&acctest=1&move=auto&cam=0${query}`); await sleep(1500); return pg; }
const shot = async (pg, n, sizes = [[1280, 720]]) => { const was = pg.viewport();
  for (const [w, h] of sizes) { if (pg.viewport().width !== w || pg.viewport().height !== h) { await pg.setViewport({ width: w, height: h }); await sleep(500); }
    await pg.screenshot({ path: `${root}test/ui-shots/ranked-e2e-${n}-${w}x${h}.png` }); const c = (await st(pg)).clipped; ok(!c.length, `${pg.tag} ${n} ${w}x${h}: nothing off screen ${c}`); }
  if (pg.viewport().width !== was.width || pg.viewport().height !== was.height) { await pg.setViewport(was); await sleep(400); } };
const SIZES = [[1280, 720], [600, 900], [1440, 900]];
const toLobby = async pg => { await pg.click('#btn-start'); await sleep(300); await pg.evaluate(() => document.fullscreenElement && document.exitFullscreen()); return until(pg, s => s.screen === 'lobby', 4000, 'Play -> lobby'); };
const toCourt = async pg => { const s = await until(pg, s => s.screen === 'calibrate' || s.screen === 'connect' || s.calibrated && s.screen === 'hud', 15000, 'reaches set-up or the court'); if (!s.calibrated) go(pg.tag); return until(pg, s => s.calibrated && s.screen === 'hud', 40000, 'is on the court'); };
const findMatch = async pg => { s = await until(pg, s => s.tile, 6000, 'the Ranked tile (the server keeps stats)'); await pg.click('#btn-ranked'); s = await until(pg, s => s.lview === 'ranked' && s.headN === '140', 6000, 'the Ranked view with the seeded ladder'); await pg.click('#btn-ranked-go'); return s; };

// =====================================================================================================================
// 1. Ann: Ranked -> the view (Bronze III, 140) -> Find a match -> the warm-up court in the stadium with the queue pill
// =====================================================================================================================
const a = await open('a', 'Ann'); let s;
await toLobby(a); s = await findMatch(a);
ok(s.head === 'Bronze III' && s.venue === 'stadium' && s.go === 'Find a match' && s.status === 'You can warm up with Matt while you wait', `Ann's Ranked view: "${s.head}", ${s.headN} trophies, the stadium behind the glass, "${s.status}"`);
s = await until(a, s => s.bar && s.rk.queued, 6000, 'queued in the lobby, the search bar up');
ok(s.screen === 'lobby' && s.lview === 'ranked' && !s.room && /^Finding a match \d:\d\d \| Ranked · Bronze III$/.test(s.bar) && s.goOff && /^Finding a match\. Warm up with Matt/.test(s.status) && s.focus === 'btn-rk-warm' && s.rk.phase === 'queue' && s.rk.warm === false && s.rk.kind === null,
  `Ann queued and still on the Ranked view: bar "${s.bar}", Find a match off, "${s.status}", focus ${s.focus}, __stats.rk ${JSON.stringify(s.rk)}`);
await sleep(600); await shot(a, '00-queued', [...SIZES, [390, 844]]);
await a.click('#btn-rk-warm');
await toCourt(a);
s = await until(a, s => s.pill && s.rk.kind === 'warm', 10000, 'the warm-up court');
ok(s.rkBody === 'warm' && s.venue === 'stadium' && /Finding a match \| You stay in the queue if you leave/.test(s.pill) && !s.bar && !s.roomPill && s.leaveBtn === 'Stop warm-up' && s.rk.queued === true && s.rk.warm === true && s.rk.tier === 1 && s.rk.div === 3 && s.emblems === 1 && !/1234/.test(s.keys.replace(/\s/g, '')) && !s.pips,
  `Warm up with Matt: Ann plays him: pill "${s.pill}", no bar, no court pill, Leave reads "${s.leaveBtn}", __stats.rk ${JSON.stringify(s.rk)}, her emblem in the tab, no 1 2 3 4, no series pips`);
await sleep(1200); await shot(a, '01-warmup', SIZES);      // the calibration card's 'All set' has faded

// =====================================================================================================================
// 2. Ben queues: MATCH FOUND for both, with the emblems; then the series court
// =====================================================================================================================
const b = await open('b', 'Ben'); await toLobby(b); await findMatch(b);      // Ben queues from the lobby (Ann is waiting: paired at once, he never warms up)
s = await until(a, s => !!s.vs, 8000, 'MATCH FOUND (Ann)'); if (s.vs) { await sleep(1100); await shot(a, '02-found'); }      // the sides and the emblems have landed (the card is up for RK_VS_S = 2 s)
const vsA = s, vsB = await until(b, s => !!s.vs || s.rk.kind === 'match', 8000, 'MATCH FOUND (Ben)');
ok(!!vsA.vs && vsA.vs.round === 'MATCH FOUND' && vsA.vs.ranked && vsA.vs.them === 'Ben' && vsA.vs.ems === 'Bronze III,Bronze III' && /^Ranked · Best of 3 · First to 2, win by 2$/.test(vsA.vs.target) && vsA.rk.phase === 'vs', `Ann's card: ${JSON.stringify(vsA.vs)}`);
ok(!vsB.vs || vsB.vs.them === 'Ann' && vsB.vs.ems === 'Bronze III,Bronze III', `Ben's card: ${JSON.stringify(vsB.vs)}`);
ok(!vsB.bar && vsB.rk.kind !== 'warm' && !(vsA.bar), `neither shows the search bar under MATCH FOUND; Ben came from the lobby with no warm-up (${JSON.stringify(vsB.rk)})`);
for (const pg of [a, b]) await toCourt(pg);
s = await until(a, s => s.rk.kind === 'match' && s.rk.series && !s.overlay, 30000, 'the series court');
ok(s.venue === 'stadium' && s.rkBody === 'match' && s.pips === '2:0,2:0' && s.emblems === 2 && s.leaveBtn === 'Forfeit' && s.names === 'You / Ben' && !s.roomPill && s.rk.series.bestOf === 3, `the series court: stadium, pips ${s.pips}, both emblems, Leave reads "${s.leaveBtn}", "${s.names}", series ${JSON.stringify(s.rk.series)}`);
await shot(a, '03-court');

// =====================================================================================================================
// 3. A game: the GAME card with its pips for both; then the series card with the trophy roll, and the winner's rank-up
// =====================================================================================================================
s = await until(a, s => !!s.game || !!s.result, 240000, 'the GAME card (Ann)');
if (s.game) { await sleep(800); await shot(a, '04-game'); ok(/^(You|Ben) takes? game 1$/.test(s.game.title) && /^\d-\d$/.test(s.game.score) && /^(1-0|0-1)$/.test(s.game.pips) && /^Game 2 in [0-3]$/.test(s.game.left) && /serves? first$/.test(s.game.serve) && !s.game.deciding, `Ann's game card: ${JSON.stringify(s.game)}`);
  const gb = await until(b, s => !!s.game || !!s.result || s.rk.series && s.rk.series.game >= 2, 8000, 'the GAME card (Ben)'); if (gb.game) ok(/takes? game 1$/.test(gb.game.title) && gb.game.pips === s.game.pips.split('-').reverse().join('-'), `Ben's game card: ${JSON.stringify(gb.game)}`);
  s = await until(a, s => !s.game, 8000, 'rkgo closes the card'); ok(s.rk.series.game === 2 && /^2:[01],2:[01]$/.test(s.pips) && s.word === 'Rally', `game 2: series ${JSON.stringify(s.rk.series)}, pips ${s.pips}`); }
const res = await Promise.all([a, b].map(pg => until(pg, s => s.result && s.result.rk, 300000, 'the series card')));
const wi = res.findIndex(r => r.result.title === 'You win the match'), W = [a, b][wi], L = [a, b][1 - wi], rw = res[wi], rl = res[1 - wi];
ok(wi >= 0 && rl.result.title === `${W.tag === 'a' ? 'Ann' : 'Ben'} wins the match` && rw.result.rk && rl.result.rk, `series over: ${res.map(r => r.result.title).join(' ; ')}`);
ok(res.every(r => r.result.again && r.result.leave && !r.result.vote && /^Back in \d+$/.test(r.result.left) && /^\d-\d( · \d-\d)*$/.test(r.result.games) && /^\d-\d$/.test(r.result.tally) && r.result.pips >= 2 && /^\d-\d$/.test(r.result.note) && r.rk.series.done === true),
  `both cards: Play again + Leave, no vote, "${rw.result.left}", games "${rw.result.games}", tally ${rw.result.tally}, note "${rw.result.note}", __stats.rk.series ${JSON.stringify(rw.rk.series)}`);
ok(rw.result.slam == null, `no stamp on the series card (NOTES 104: the light sweep instead): "${rw.result.slam}"`);
s = await until(L, s => !!s.trophy, 4000, "the loser's trophy row");
ok(!!s.trophy && /^\u2212\d+$/.test(s.trophy.pill) && +s.trophy.n < 140 && s.trophy.em === '#rank-1' && s.rk.trophies === +s.trophy.n, `the loser's trophy roll: ${JSON.stringify(s.trophy)}, still Bronze, __stats.rk ${s.rk.trophies}`);
s = await until(W, s => s.trophy && s.trophy.em === '#rank-2', 6000, 'the rank-up ceremony (the emblem swaps after the count)');
ok(!!s.trophy && /^\+\d+$/.test(s.trophy.pill) && +s.trophy.n >= 150 && s.trophy.rays && /^Silver I/.test(s.result.note) && s.rk.tier === 2 && s.rk.trophies === +s.trophy.n, `the winner's trophy roll: ${JSON.stringify(s.trophy)}, Rank up to "${s.result.note}", __stats.rk tier ${s.rk.tier}, ${s.rk.trophies} trophies`);
ok(s.confetti > 0, `confetti for the rank-up (${s.confetti})`);
await shot(W, '05-series-win', SIZES); await shot(L, '06-series-lose');

// =====================================================================================================================
// 4. Play again queues the winner in the lobby (the search bar on the Ranked view and the title); the loser's card closes by itself onto the Ranked view
// =====================================================================================================================
await W.click('#btn-rk-again');
s = await until(W, s => s.screen === 'lobby' && s.lview === 'ranked' && s.bar && !s.overlay && !s.room, 12000, 'Play again: queued, on the Ranked view with the bar');
ok(s.rk.queued === true && s.rk.phase === 'queue' && s.rk.kind === null && s.rk.series === null && !s.pips && s.rk.tier === 2 && /Ranked · Silver I$/.test(s.bar) && !s.pill, `Play again: the winner is queued in the lobby (${JSON.stringify(s.rk)}, bar "${s.bar}")`);
rest(W.tag); await sleep(1500);      // the AirPod lies still: a swing on the title is a press of Play
await W.keyboard.press('Escape'); await sleep(500); await W.keyboard.press('Escape'); s = await until(W, s => s.screen === 'title', 4000, 'Esc Esc: the title');
ok(!!s.bar && s.rk.queued === true, `the bar hangs over the title too, still queued ("${s.bar}")`); await sleep(500); await shot(W, '08-title-bar', [[1280, 720], [390, 844]]);
await W.click('#btn-rk-cancel'); s = await until(W, s => !s.bar && !s.rk.on, 4000, 'Cancel: out of the queue');
ok(s.rk.phase === 'off' && s.screen === 'title', `Cancel on the bar: out of the queue, the bar gone, still on the title (${s.screen}, ${JSON.stringify(s.rk)})`);
s = await until(L, s => s.screen === 'lobby' && s.lview === 'ranked' && !s.room && s.headN !== '0', 12000, 'the loser lands on the Ranked view (the view draws Bronze 0 at once, then /api/stats answers)');
ok(s.rk.on === false && s.rk.phase === 'off' && /^Bronze (II|III)$/.test(s.head) && +s.headN < 140 && +s.headN >= 100, `the loser: the Ranked view, "${s.head}" ${s.headN} (out of the queue: ${s.rk.on === false}, phase ${s.rk.phase})`);
await shot(L, '07-view-after');

ok(!errs.length, `no console errors${errs.length ? ': ' + errs.slice(0, 6).join(' | ') : ''}`);
const log = slog.join(''); ok(/ranked series drawn/.test(log) && /ranked series over: side [01] (2-[01]|[01]-2) \(/.test(log) && !/Ann|Ben/.test(log), 'the server logged the draw and the result, with codes and numbers only');
ok((await st(a)).errors === 0 && (await st(b)).errors === 0, 'no page errors');
console.log('server log (Ranked lines):\n  ' + log.split('\n').filter(l => /ranked|recorded|series/.test(l)).join('\n  '));
const fails = out.filter(l => l.startsWith('FAIL')).length; console.log(fails ? `RANKED E2E FAIL (${fails})` : 'RANKED E2E PASS', `${out.length - fails} passed, ${fails} failed`);
await done(fails ? 1 : 0);
