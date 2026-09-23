// Tournaments end to end (docs/COURTS-TOURNEY.md 4.6-4.8): the real client against the real server/game.js, fake AirPods, FOUR headless
// Chromes. Hana makes a tournament from Courts; Ben joins by its row in the list, Cy by typing the code, Di by the invite link; they warm up
// against Matt with the banner counting; Hana starts it from her code screen; VS cards, a round of short matches (first to 2, the final to 3), the bracket between
// rounds (the winners through, the losers out with Watch), the final, the champion card with confetti for everyone.
// Usage: node test/tourney-e2e.mjs      TOURNEY_E2E_PORT=<base> moves the ports (default 8622: game + page, 8623: AirPods, 8624: nothing)
// Screenshots land in test/ui-shots/tour-e2e-*.png (1280x720, 600x900 and 1440x900 for the screens).
import { spawn } from 'child_process'; import fs from 'fs';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
import { makeSynth, CALIBRATE, SESSION_LOOP } from './fake-bridge.mjs';
const P0 = +process.env.TOURNEY_E2E_PORT || 8622, G = P0, B = P0 + 1, DEAD = P0 + 2, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
const server = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: G, WIN_BY: 1, TOUR_WIN: 2, TOUR_FINAL: 3, TOUR_VS_S: 2, TOUR_ARRIVE_S: 40, TOUR_GAP_S: 4, TOUR_DONE_S: 60, READY_S: 0 }, stdio: ['ignore', 'pipe', 'inherit'] }), slog = []; server.stdout.on('data', d => slog.push(String(d)));

// ---- AirPods: one per tab, told apart by the path (as test/spectate-e2e.mjs). rest = lying still, go = calibrate then swing
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
const done = async code => { for (const b of browsers) await b.close().catch(() => {}); server.kill(); process.exit(code); };
setTimeout(() => { console.log('TOURNEY E2E FAIL (timeout)'); done(2); }, 600000);
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('TOURNEY E2E FAIL', e); done(2); });
server.on('exit', c => { console.log(`TOURNEY E2E FAIL: server/game.js stopped (${c}). Is port ${G} taken?`); done(2); });

// everything a check reads, in one round trip
const st = pg => pg.evaluate(() => { const t = id => document.getElementById(id), vis = id => { const e = t(id); if (!e || e.hidden) return false; const c = getComputedStyle(e), b = e.getBoundingClientRect(); return c.display !== 'none' && c.visibility !== 'hidden' && +c.opacity > 0.05 && b.width > 0; },
    tx = id => t(id) ? t(id).textContent.trim() : null, s = window.__stats, d = document.body.dataset;
  return { screen: d.screen, overlay: d.overlay || null, tourBody: d.tour || null, phase: s.phase, role: s.role, room: s.room, tour: s.tour, calibrated: s.calibrated, errors: s.errors, search: location.search,
    lview: [...document.querySelectorAll('#screen-lobby .lobby-view')].find(e => !e.hidden)?.dataset.view, title: tx('lobby-title'), toast: t('toast').classList.contains('on') ? tx('toast') : null,
    code: [...t('tour-code').children].map(e => e.textContent).join(''), n: tx('tour-n-num'), why: vis('tour-why') ? tx('tour-why') : null, start: vis('btn-tour-start') ? { on: !t('btn-tour-start').disabled, label: tx('btn-tour-start') } : null, wait: vis('tour-wait') ? tx('tour-wait') : null,
    names: [...document.querySelectorAll('#tour-names .tour-chip:not(.is-empty)')].map(e => e.textContent.trim()), pill: vis('tour-pill') ? tx('tour-pill-long') + ' | ' + tx('tour-pill-n') : null, hudStart: vis('btn-tour-go'), roomPill: vis('room-pill'),
    rows: [...document.querySelectorAll('#room-list li')].map(li => li.textContent.trim()), vs: d.overlay === 'tour-vs' ? tx('vs-round') + ' | ' + tx('vs-them') + ' | ' + tx('vs-target') : null,
    result: d.overlay === 'match' && vis('result') ? { title: tx('result-title'), note: tx('result-note'), champ: t('result').classList.contains('is-champion'), road: tx('result-road'), see: vis('btn-see-bracket'), back: vis('btn-champ-back'), vote: vis('rematch-btns') } : null,
    brYou: tx('br-you'), brNext: vis('br-next') ? tx('br-next-text') : null, brWatch: [...document.querySelectorAll('#bracket .br-watch')].map(b => b.dataset.room), brCols: [...document.querySelectorAll('#bracket .br-round')].map(e => e.firstChild.textContent),
    confetti: document.querySelectorAll('.confetti').length, keys: [...document.querySelectorAll('#keys li')].filter(e => !e.hidden).map(e => e.textContent.trim()).join(' | '), leaveBtn: tx('btn-leave-room'),
    clipped: [...document.querySelectorAll('.screen.is-active [data-fit], #hud [data-fit], #tour-card')].filter(e => { const b = e.getBoundingClientRect(), c = getComputedStyle(e); return b.width && !e.hidden && c.visibility !== 'hidden' && c.display !== 'none' && (b.left < -.5 || b.top < -.5 || b.right > innerWidth + .5 || b.bottom > innerHeight + .5); }).map(e => e.id || e.className) }; });
async function until(pg, test, ms, what) { const end = Date.now() + ms; let s; do { s = await st(pg); if (test(s)) return s; await sleep(150); } while (Date.now() < end); ok(false, `${pg.tag}: ${what} (gave up after ${ms / 1000} s: ${JSON.stringify(s)})`); return s; }
async function open(tag, name, query = '', w = 1280, h = 720) { const pg = (await (await launch()).pages())[0]; await pg.setViewport({ width: w, height: h }); pg.tag = tag;
  pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`)); pg.on('response', r => { if (r.status() >= 400) errs.push(`[${tag}] ${r.status()} ${r.url()}`); });
  pg.on('console', m => { if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION/.test(m.text())) errs.push(`[${tag}] ${m.text()}`); });
  await pg.evaluateOnNewDocument(name => { try { localStorage.setItem('poddle.name', name); } catch { /* */ } }, name);
  await pg.goto(`http://localhost:${G}/?bridge=${B}/${tag}&game=${G}&uitest=1${query}`); await sleep(1500); return pg; }
const shot = async (pg, n, sizes = [[1280, 720]]) => { const was = pg.viewport();
  for (const [w, h] of sizes) { if (pg.viewport().width !== w || pg.viewport().height !== h) { await pg.setViewport({ width: w, height: h }); await sleep(500); }
    await pg.screenshot({ path: `${root}test/ui-shots/tour-e2e-${n}-${w}x${h}.png` }); const c = (await st(pg)).clipped; ok(!c.length, `${pg.tag} ${n} ${w}x${h}: nothing off screen ${c}`); }
  if (pg.viewport().width !== was.width || pg.viewport().height !== was.height) { await pg.setViewport(was); await sleep(400); } };
const SIZES = [[1280, 720], [600, 900], [1440, 900]];
const toLobby = async pg => { await pg.click('#btn-start'); await sleep(300); await pg.evaluate(() => document.fullscreenElement && document.exitFullscreen()); return until(pg, s => s.screen === 'lobby', 4000, 'Play -> lobby'); };
const toCourt = async pg => { const s = await until(pg, s => s.screen === 'calibrate' || s.screen === 'connect' || s.calibrated && s.screen === 'hud', 10000, 'reaches set-up or the court'); if (!s.calibrated) go(pg.tag); return until(pg, s => s.calibrated && s.screen === 'hud', 40000, 'is on the court'); };

// =====================================================================================================================
// 1. Hana makes it: Courts -> Create tournament (the disclosure under it) -> the code screen
// =====================================================================================================================
const h = await open('h', 'Hana'); let s;
await toLobby(h); await h.click('#btn-courts'); s = await until(h, s => s.lview === 'courts', 3000, 'Courts');
ok(await h.evaluate(() => document.getElementById('tour-note').textContent.trim() === 'Needs at least 4 players. Up to 16.' && !document.getElementById('btn-tour').hasAttribute('aria-disabled')), 'Courts: Create tournament is live, with its disclosure "Needs at least 4 players. Up to 16."');
await h.click('#btn-tour'); s = await until(h, s => s.lview === 'tour' && s.code.length === 4, 5000, 'Create tournament -> the code screen');
const CODE = s.code;
ok(s.n === '1' && s.start && !s.start.on && /Needs at least 4 players · 3 more/.test(s.why) && s.names.length === 1 && /Hana/.test(s.names[0]), `the host's screen: code ${CODE}, 1 joined, Start disabled, "${s.why}", chips ${s.names}`);
ok(new URLSearchParams(s.search).get('court') === CODE, `the address bar carries the tournament's code (${s.search})`);
ok(await h.evaluate(() => document.activeElement?.id === 'btn-tour-copy' || document.activeElement?.id === 'tour-code'), 'first focus: Copy invite (a host shares first)');
await shot(h, '01-host-empty', SIZES);

// =====================================================================================================================
// 2. Three join, three ways: the list row (Tournament badge), the code boxes, the invite link. Each warms up against Matt with the banner
// =====================================================================================================================
const b = await open('b', 'Ben'); await toLobby(b); await b.click('#btn-courts');
s = await until(b, s => s.rows.some(r => r.includes(CODE) && r.includes('Tournament')), 8000, 'the tournament row is listed, with its badge');
ok(s.rows.some(r => r.includes(CODE) && /Hana’s tournament/.test(r) && /1 of 16 joined/.test(r)), `Ben's list: ${s.rows.find(r => r.includes(CODE))}`);
await b.click(`#room-list [data-code="${CODE}"]`); s = await toCourt(b);
s = await until(b, s => s.pill && /Waiting for the tournament to begin/.test(s.pill) && /2 joined/.test(s.pill), 6000, 'the banner in the warm-up');
ok(s.tourBody === 'warm' && !s.roomPill && s.tour && s.tour.kind === 'warm', `Ben warms up against Matt: pill "${s.pill}", no court pill (${s.roomPill})`);
s = await until(h, s => s.n === '2', 4000, 'Hana sees 2 joined'); ok(s.names.some(n => /Ben/.test(n)), `Hana's chips: ${s.names}`);

const c = await open('c', 'Cy'); await toLobby(c); await c.click('#btn-courts'); await until(c, s => s.lview === 'courts', 3000, 'Courts');
await c.click('#code-boxes .code-box'); await c.keyboard.type(CODE, { delay: 40 }); await c.click('#btn-join'); await toCourt(c);
const d = await open('d', 'Di', `&court=${CODE}`); await d.click('#btn-start'); await d.evaluate(() => document.fullscreenElement && document.exitFullscreen()); await toCourt(d);      // the invite link: Play joins it at once
for (const pg of [b, c, d]) { s = await until(pg, s => s.pill && /4 joined/.test(s.pill), 8000, 'the banner counts 4'); }
s = await until(h, s => s.n === '4' && s.start && s.start.on, 5000, 'Hana: 4 joined, Start on');
ok(/Start with 4 players/.test(s.start.label) && /Ready when you are/.test(s.why), `from 4: "${s.start.label}", "${s.why}"`);
await shot(h, '02-host-ready', SIZES); await shot(b, '03-banner', SIZES);

// =====================================================================================================================
// 3. Start: VS cards, the matches, a result, the bracket between rounds
// =====================================================================================================================
await h.click('#btn-tour-start');
const vs = await Promise.all([h, b, c, d].map(pg => until(pg, s => !!s.vs, 8000, 'the VS card')));
ok(vs.every(s => /Semifinal · Match [12] of 2/.test(s.vs) && /First to 2, win by 2/.test(s.vs)), `VS: ${vs.map(s => s.vs).join(' ;; ')}`);
await shot(h, '04-vs');
for (const pg of [h, b, c, d]) await toCourt(pg);
s = await until(h, s => s.tour && s.tour.kind === 'match' && s.pill || !!s.result, 8000, 'the match pill');
if (!s.result) ok(/Semifinal · vs /.test(s.pill) && s.leaveBtn === 'Forfeit' && !/1234/.test(s.keys.replace(/\s/g, '')), `in a match: pill "${s.pill}", Leave reads "${s.leaveBtn}", keys "${s.keys}"`);
const res = await Promise.all([h, b, c, d].map(pg => until(pg, s => !!s.result || s.lview === 'bracket' && s.screen === 'lobby', 90000, 'a result or the bracket')));
const cards = res.filter(s => s.result && !s.result.champ);
ok(cards.length && cards.every(s => !s.result.vote && s.result.see && /On to the Final|Out in the Semifinal|Through: /.test(s.result.note)), `results, no vote, See bracket: ${res.map(s => s.result ? s.result.note : s.lview).join(', ')}`);
const shotRes = [h, b, c, d].find((pg, i) => res[i].result && /Out in/.test(res[i].result.note)); if (shotRes && (await st(shotRes)).result) await shot(shotRes, '05-out');
const br = await Promise.all([h, b, c, d].map(pg => until(pg, s => s.tour && s.tour.phase !== 'reg' && (s.lview === 'bracket' && s.screen === 'lobby' || !!s.vs || s.tour.kind === 'match'), 30000, 'the bracket after the round')));
const outs = [h, b, c, d].filter((pg, i) => br[i].tour && br[i].tour.out), ins = [h, b, c, d].filter(pg => !outs.includes(pg));
ok(outs.length === 2 && ins.length === 2, `two out (${outs.map(p => p.tag)}), two through (${ins.map(p => p.tag)})`);
s = await until(outs[0], s => s.lview === 'bracket' && s.screen === 'lobby' && /You’re out/.test(s.brYou), 8000, 'the loser sees the bracket'); ok(s.brCols.join() === 'Semifinal,Final', `bracket columns: ${s.brCols}`);
await shot(outs[0], '06-bracket-out', SIZES);

// =====================================================================================================================
// 4. The final: the two winners play; a loser watches it from the bracket; then the champion card for everyone
// =====================================================================================================================
for (const pg of ins) await until(pg, s => !!s.vs || s.tour && s.tour.kind === 'match' && s.room, 20000, 'the final is drawn');
for (const pg of ins) await toCourt(pg);
s = await until(outs[0], s => s.brWatch.length === 1, 15000, 'the final is live on the bracket, with Watch');
await outs[0].click('#bracket .br-watch'); s = await until(outs[0], s => s.role === 'spectator' && s.phase === 'watch', 8000, 'Watch the final');
ok(s.tour.kind === 'match' && !s.roomPill, `watching the final (kind ${s.tour.kind})`);
const ch = await Promise.all([h, b, c, d].map(pg => until(pg, s => s.result && s.result.champ, 90000, 'the champion card')));
const champ = ch.find(s => s.result.title === 'You’re the champion!'), others = ch.filter(s => s !== champ);
ok(!!champ && others.every(s => / is the champion!$/.test(s.result.title)), `champion: ${ch.map(s => s.result.title).join(' ; ')}`);
ok(ch.every(s => s.result.back && /Semifinal/.test(s.result.road) && /Final/.test(s.result.road)), `the road to the title: ${ch[0].result.road}`);
ok(ch.some(s => s.confetti > 0), `confetti falls (${ch.map(s => s.confetti)})`);
const champPg = [h, b, c, d][ch.indexOf(champ)]; await sleep(1200); await shot(champPg, '07-champion', SIZES);
await champPg.click('#btn-champ-back'); s = await until(champPg, s => s.screen === 'lobby' && s.lview === 'courts' && !s.tour, 5000, 'Back to courts'); ok(!s.tour, 'Back to courts: out of the tournament');

ok(!errs.length, `no console errors${errs.length ? ': ' + errs.slice(0, 6).join(' | ') : ''}`);
const log = slog.join(''); ok(/tournament started: 4 players/.test(log) && /champion: /.test(log), 'the server logged the start and the champion');
const fails = out.filter(l => l.startsWith('FAIL')).length; console.log(fails ? `TOURNEY E2E FAIL (${fails})` : 'TOURNEY E2E PASS', `${out.length - fails} passed, ${fails} failed`);
await done(fails ? 1 : 0);
