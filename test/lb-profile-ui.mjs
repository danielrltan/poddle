// The leaderboard profile (NOTES 140): web/profile.js + main.js + index.html against a fake game and a fake /api. Every row of the global leaderboard is
// a button that opens that player's profile card (#lbp-card, over the list in #acct-layer); keyboard, focus return, Esc / close / backdrop, the own row's
// Your stats, not found, error + Try again, stale answers, rows redrawn under the sheet, a guest viewer, fit at three sizes, reduced motion, the
// poddle.lbSeen '2' notice (on load and on turning Show me on), a touch tap on the backdrop, MATCH FOUND closing it. Usage: node test/lb-profile-ui.mjs      LB_PROFILE_UI_PORT=<base> moves the ports (default 9740:
// pages + /api, 9741: fake game, 9742: nothing = no AirPod). Last line: LB PROFILE UI PASSED or LB PROFILE UI FAIL.
import http from 'http'; import fs from 'fs'; import path from 'path';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
const P0 = +process.env.LB_PROFILE_UI_PORT || 9740, W = P0, G = P0 + 1, DEAD = P0 + 2, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
if ([8080, 8787, 3000].some(p => p >= P0 && p <= P0 + 2)) { console.log('refusing: that port range holds the player\'s own game'); process.exit(2); }
const J = o => JSON.stringify(o);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

// ---------- the fake /api ----------
const LABELS = [['Win rate vs people', 'Win rate'], ['Time on court', 'On court'], ['Best win streak vs people', 'Best streak'], ['Return rate', 'Returns'], ['Points won', 'Points won'], ['Longest rally', 'Rally', 'hits'], ['Fastest swing', 'Swing', '°/s'], ['Winners', 'Winners'], ['Aces', 'Aces'], ['Smashes', 'Smashes'], ['Tournament titles', 'Titles']];
// eleven(winRate, record, time, streak, returns, points, rally, swing, winners, aces, smashes, titles): server/api.js publicCard's stats, the share card's eleven (NOTES 145)
const eleven = (wr, rec, ...v) => LABELS.map(([label, tag, unit], i) => ({ label, tag, value: i ? v[i - 1] : wr, ...(unit ? { unit } : {}),
  ...(i === 0 ? { note: rec + ' vs people', hero: true } : i === 1 ? { note: 'all modes', hero: true } : i === 2 ? { note: v[1] === '1' ? 'win vs people' : 'wins vs people', hero: true } : {}) }));
const TAGS = LABELS.map(l => l[1]);
const NAMES = ['Dan', 'Kiko', 'Rallyqueen', 'Paddlebot', 'Mo', 'Ace_Vega', 'Lobster', 'Zed', 'Pickle_Rick', 'Nova', 'Dinkmaster', 'Juno'];
const ROWS = NAMES.map((name, i) => ({ rank: i + 1, name, v: 60 - i * 4, tier: i < 8 ? 8 - (i >> 1) : null, div: 1 + (i % 3) }));      // Pickle_Rick .. Juno: no trophies yet
const card = (name, rank, trophies, matt, stats) => ({ name, streak: name === 'Dan' ? 5 : 0, rank, trophies, matt, stats });      // streak: the current win streak (NOTES 164)
const PLAYERS = {
  Dan: { delay: 300, body: { ...card('Dan', { tier: 8, div: 1, label: 'Pro #1', pro: 1 }, 1180, 'Pro', eleven('81%', '42-7', '31h 12m', '12', '86%', '58%', '60', '1570', '318', '41', '97', '4')) , mattFlawless: true, mattScore: '11-0' } },
  Kiko: { body: { ...card('Kiko', { tier: 7, div: 2, label: 'Champion II', pro: null }, 964, 'Tour', eleven('67%', '18-9', '9h 40m', '5', '73%', '54%', '56', '1340', '140', '12', '33', '1')) , mattScore: '12-10' } },
  Juno: { body: card('Juno', null, 0, null, eleven('-', '0-0', '0m', '0', '-', '-', '0', '-', '0', '0', '0', '0')) },
  Pickle_Rick: { body: card('Pickle_Rick', null, 0, 'Rookie', eleven('78%', '4,321-1,234', '277h 46m', '1,234', '89%', '53%', '444', '2570', '88,888', '88,888', '88,888', '1,234')) },
  Lobster: { delay: 800, body: card('Lobster', { tier: 5, div: 1, label: 'Diamond I', pro: null }, 610, 'Club', eleven('50%', '7-7', '4h 2m', '3', '64%', '51%', '36', '1100', '60', '9', '14', '0')) },
  Nova: { delay: 50, body: card('Nova', null, 0, null, eleven('50%', '1-1', '<1m', '1', '71%', '49%', '32', '-', '12', '2', '3', '0')) },
  Mo: { status: 404 }, Zed: { status: 500 },
};
const ZED_OK = card('Zed', { tier: 5, div: 3, label: 'Diamond III', pro: null }, 700, 'Club', eleven('53%', '9-8', '5h 5m', '3', '61%', '52%', '40', '1200', '77', '8', '19', '0'));
const API = { signin: true, acct: { username: 'Kiko' }, mePlaces: { listed: true }, statsDelay: 0, zedOk: false, log: [] };      // log: [method, url, body, headers]
const PLACES = { listed: true, hidden: false, rally: { rank: 2, v: 56 }, trophies: { rank: 2, v: 964 }, streak: { rank: 2, v: 5 } };
const apiAnswer = (q, body, r) => { const u = q.url.split('?')[0], send = (s, o) => { if (r.writableEnded) return; r.writeHead(s, { 'content-type': 'application/json' }); r.end(o === undefined ? '' : J(o)); };
  API.log.push([q.method, q.url, body, q.headers]);
  if (u === '/api/me') return send(200, { db: true, signin: { enabled: API.signin, clientId: API.signin ? 'test-client.apps.googleusercontent.com' : null }, account: API.signin ? API.acct : null, places: API.acct ? API.mePlaces : null });
  if (u === '/api/stats') return setTimeout(() => send(200, { profile: { guest: !API.acct, played: 3, ladder: { tier: 7, div: 2, trophies: 964 }, places: API.acct ? PLACES : null } }), API.statsDelay);
  if (u === '/api/leaderboard') return send(200, { board: 'rally', total: ROWS.length, rows: ROWS });
  if (u === '/api/leaderboard/player') { const n = new URL(q.url, 'http://x').searchParams.get('u'), P = n === 'Zed' && API.zedOk ? { body: ZED_OK } : PLAYERS[n] || { status: 404 };
    return setTimeout(() => (P.status ? send(P.status, { error: P.status === 404 ? 'not_found' : 'internal' }) : send(200, P.body)), P.delay || 20); }
  if (u === '/api/leaderboard/hide') { let b = {}; try { b = JSON.parse(body); } catch {} PLACES.hidden = b.hidden === true; PLACES.listed = !PLACES.hidden; return send(200, { places: PLACES }); }
  if (u === '/api/signin/nonce') return send(200, { nonce: 'n'.repeat(32) });
  return send(404, { error: 'nope' }); };
const web = http.createServer((q, r) => {
  if (q.url.startsWith('/api/')) { let body = ''; q.on('data', c => { body += c; }); q.on('end', () => apiAnswer(q, body, r)); return; }
  let f = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (!f.startsWith(root)) { r.writeHead(403); return r.end(); } if (f.endsWith('/')) f += 'index.html';
  const serve = (g, next) => fs.readFile(g, (e, d) => { if (e && next) return next(); r.writeHead(e ? 404 : 200, { 'content-type': MIME[path.extname(g)] || 'application/octet-stream' }); r.end(e ? '' : d); });
  serve(f, () => serve(path.join(root, 'web', decodeURIComponent(q.url.split('?')[0])), null)); }).listen(W, '127.0.0.1');

// ---------- the fake game: a lobby list; push() sends the last socket a frame (MATCH FOUND) ----------
const LIST = { type: 'lobby', online: 3, rooms: [] }, socks = [];
const wss = new WebSocketServer({ port: G, host: '127.0.0.1' });
wss.on('connection', ws => { socks.push(ws); ws.send(J(LIST)); ws.on('message', raw => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.type === 'ping') ws.send(J({ type: 'pong', c: m.c })); }); });
const push = m => { const s = socks[socks.length - 1]; if (s && s.readyState === 1) s.send(J(m)); };

const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const out = [], errs = [], ok = (c, what) => { out.push((c ? 'PASS ' : 'FAIL ') + what); if (!c) console.log('FAIL', what); };
setTimeout(() => { console.log(out.join('\n')); console.log('LB PROFILE UI FAIL (timeout)'); process.exit(2); }, 360000);
const URL0 = `http://127.0.0.1:${W}/web/index.html?uitest=1&acctest=1&cam=0&game=${G}&bridge=${DEAD}`;
async function page(tag, { w = 1280, h = 720, seen = '3' } = {}) {
  const pg = await browser.newPage(); await pg.setViewport({ width: w, height: h }); await pg.setRequestInterception(true);
  pg.on('request', q => (/google\.com|gstatic\.com/.test(q.url()) ? q.abort() : q.continue()));
  pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`));
  pg.on('console', m => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|ERR_FAILED|WebSocket connection|Failed to load resource/.test(m.text())) errs.push(`[${tag}] ${m.text()}`); });
  await pg.evaluateOnNewDocument(s => { try { localStorage.setItem('poddle.name', 'Tester'); localStorage.setItem('poddle.camPrimer', 'allow'); if (s === null) localStorage.removeItem('poddle.lbSeen'); else localStorage.setItem('poddle.lbSeen', s); } catch {} }, seen);
  return pg;
}
const ev = (pg, fn, ...a) => pg.evaluate(fn, ...a);
async function toBoard(pg) { await pg.goto(URL0, { waitUntil: 'domcontentloaded' }); await sleep(2000); await pg.click('#btn-start').catch(() => {}); await sleep(800);
  await ev(pg, () => window.__ui.lobbyView('leaderboard')); await pg.waitForFunction(() => document.querySelectorAll('#lb-list button.lb-row').length === 12, { timeout: 8000 }).catch(() => {}); await sleep(300); }
const rowSel = n => `#lb-list button.lb-row[data-name="${n}"]`;      // test names only: plain letters
const sheet = pg => ev(pg, () => { const c = document.getElementById('lbp-card'), l = document.getElementById('acct-layer'), a = document.activeElement, g = id => document.getElementById(id);
  const vis = e => !!e && !e.closest('[hidden]') && getComputedStyle(e).display !== 'none';
  return { open: !!c && !c.hidden && !l.hidden, state: c?.dataset.state, name: g('lbp-name')?.textContent, badge: !!g('lbp-name')?.nextElementSibling?.classList.contains('reg-badge'), rank: g('lbp-rank')?.textContent,
    mscore: g('lbp-mscore') && !g('lbp-mscore').hidden ? g('lbp-mscore').textContent : null, mcls: g('lbp-matt')?.className, mtip: g('lbp-matt')?.dataset.tip || g('lbp-matt')?.title || '', em: !!g('lbp-em')?.querySelector('.rank-em'), emA11y: [g('lbp-em')?.getAttribute('role'), g('lbp-em')?.getAttribute('aria-label')].join('|'), tro: vis(g('lbp-tro')) ? g('lbp-trophies').textContent : null, mbest: g('lbp-mbest')?.textContent, statsShown: vis(g('lbp-stats')),
    stats: [...Array(11).keys()].map(i => ({ v: document.querySelector(`#lbp-stats [data-stat="${i}"]`)?.textContent, skel: g('lbp-stats').classList.contains('is-skel') })), rec: g('lbp-w').textContent + '-' + g('lbp-l').textContent, streak: vis(g('lbp-streak')) ? g('lbp-streak-n').textContent : null, friendFirst: g('lbp-friend').compareDocumentPosition(g('lbp-hero')) & 4 ? true : false,      // the eleven public figures by their [data-stat] index (server/card.js dataOf's order), in Your stats' layout (NOTES 164)
    msg: vis(g('lbp-msg')) ? g('lbp-msg').textContent : '', retry: vis(g('lbp-retry')), foot: vis(g('lbp-foot')) ? g('lbp-foot').textContent : '',
    inCard: !!c && c.contains(a), focusRow: a?.matches?.('button.lb-row') ? a.dataset.name : null, focusConnected: !!a?.isConnected, view: window.__ui.lobbyView(), path: location.pathname }; });

// ---------- 1-8: signed in as Kiko (listed) ----------
let pg = await page('main');
await toBoard(pg);
{ const r = await ev(pg, () => { const bs = [...document.querySelectorAll('#lb-list > li.lb-item > button.lb-row')];
    return { n: bs.length, all: bs.every(b => b.type === 'button' && b.getAttribute('aria-haspopup') === 'dialog' && b.getAttribute('aria-label').includes(b.dataset.name) && /\d+ hits?/.test(b.getAttribute('aria-label')) && getComputedStyle(b).cursor === 'pointer'),
      top1: !!document.querySelector('.lb-row.is-top1'), dan: bs.find(b => b.dataset.name === 'Dan')?.getAttribute('aria-label'), me: bs.find(b => b.classList.contains('is-me'))?.dataset.name }; });
  ok(r.n === 12 && r.all && r.top1, `12 rows, each li.lb-item > button.lb-row type=button, aria-haspopup=dialog, labelled with name and value, cursor pointer; .lb-row.is-top1 kept (${r.n})`);
  ok(/^1\. Dan, Developer, Pro, 60 hits\. Open profile$/.test(r.dan || '') && r.me === 'Kiko', `the developer's row says so ("${r.dan}"); my row is Kiko's`); }
await pg.focus(rowSel('Dan')); await pg.keyboard.press('Enter'); await sleep(120);
let s = await sheet(pg);
{ const w = await ev(pg, sel => { const b = document.querySelector(sel); return { busy: b.getAttribute('aria-busy'), cls: b.classList.contains('is-opening') }; }, rowSel('Dan'));
  ok(!s.open && w.busy === 'true' && w.cls, `Enter on Dan's row: no half-drawn card while the answers are on their way, the row is busy (NOTES 150: the card opens once, whole) (${J({ open: s.open, ...w })})`); }
await sleep(400); s = await sheet(pg);
ok(s.open && s.name === 'Dan' && s.badge && s.state === 'ok' && !(await ev(pg, sel => document.querySelector(sel).hasAttribute('aria-busy'), rowSel('Dan'))), `then the card opens already loaded (state ${s.state}), the hammer on the name, the row no longer busy`);
{ const a = await ev(pg, () => { const c = document.getElementById('lbp-card'); return { role: c.getAttribute('role'), modal: c.getAttribute('aria-modal'), by: document.getElementById(c.getAttribute('aria-labelledby'))?.textContent }; });
  ok(a.role === 'dialog' && a.modal === 'true' && a.by === 'Dan', `a modal dialog labelled by the name (${J(a)})`); }
await sleep(500); s = await sheet(pg);
await pg.screenshot({ path: new URL('./ui-shots/accounts/lbp-card-dan-1280x800.png', import.meta.url).pathname });      // the public card as a whole, for a look
ok(s.mcls === 'lbp-matt st-mbadge is-lv3 is-flawless' && s.mtip === 'Beaten 11-0' && s.mscore === 'Best 11\u201310'.replace('10', '0'), `Dan's Pro Matt was beaten 11-0: the badge wears the gold ring, the best score under the level (${s.mcls}, "${s.mtip}", "${s.mscore}")`);
ok(s.state === 'ok' && s.rank === 'Pro #1' && s.em && s.tro === '1,180' && s.mbest === 'Pro Matt' && s.stats.map(x => x.v).join() === '81%,31h 12m,12,86%,58%,60,1570,318,41,97,4' && !s.foot && s.rec === '42-7' && s.streak === '5' && s.friendFirst,
  `loaded: Pro #1, 1,180 trophies, Pro Matt, the eleven in Your stats' layout with the 42-7 record, the flame at 5, the friend row over the hero, no own-row footer (${J({ rank: s.rank, tro: s.tro, mbest: s.mbest, foot: s.foot, rec: s.rec, streak: s.streak, stats: s.stats.map(x => x.v) })})`);
ok(s.inCard, 'focus is inside the sheet');
{ let inside = true; for (let i = 0; i < 4; i++) { await pg.keyboard.press('Tab'); await sleep(60); if (!(await sheet(pg)).inCard) inside = false; }
  await pg.keyboard.down('Shift'); for (let i = 0; i < 3; i++) { await pg.keyboard.press('Tab'); await sleep(60); if (!(await sheet(pg)).inCard) inside = false; } await pg.keyboard.up('Shift');
  ok(inside, 'Tab and Shift+Tab stay inside the sheet'); }
await pg.keyboard.press('Escape'); await sleep(250); s = await sheet(pg);
ok(!s.open && s.focusRow === 'Dan' && s.view === 'leaderboard' && s.path === '/web/index.html', `Esc closes only the sheet: focus back on Dan's row, still the leaderboard, the URL unchanged (${J({ open: s.open, focus: s.focusRow, view: s.view, path: s.path })})`);
await pg.click(rowSel('Rallyqueen')); await sleep(500); await pg.click('#btn-lbp-close'); await sleep(250); s = await sheet(pg);
ok(!s.open && s.focusRow === 'Rallyqueen', `the close button closes it, focus back on the row (${s.focusRow})`);
await pg.click(rowSel('Kiko')); await sleep(600); await pg.mouse.click(5, 5); await sleep(250); s = await sheet(pg);
ok(!s.open && s.focusRow === 'Kiko', `a press on the backdrop closes it, focus back on the row (${s.focusRow})`);
{ await pg.click(rowSel('Kiko')); await sleep(600);      // a TOUCH tap on the veil over another row: the tap's click must not fall through to that row (the veil closes on click, not pointerdown)
  const pt = await ev(pg, () => { const c = document.getElementById('lbp-card').getBoundingClientRect();
    for (const b of document.querySelectorAll('#lb-list button.lb-row')) { const q = b.getBoundingClientRect(), y = q.top + q.height / 2;
      if (q.height && y > 0 && y < innerHeight && q.left + 12 < c.left - 4) return { x: q.left + 12, y, name: b.dataset.name };
      if (q.height && y > 0 && y < innerHeight && (y < c.top - 4 || y > c.bottom + 4)) return { x: q.left + q.width / 2, y, name: b.dataset.name }; } return { x: Math.max(6, c.left / 2), y: innerHeight / 2, name: null }; });      // the card (wider since NOTES 164) covers every row: any veil point
  if (pt) { await pg.touchscreen.tap(pt.x, pt.y); await sleep(400); s = await sheet(pg); }
  ok(!!pt && !s.open && s.focusRow === 'Kiko', `a touch tap on the backdrop over ${pt && pt.name}'s row closes the sheet and opens nothing: focus back on Kiko's row (${J({ pt, open: s.open, name: s.name, focus: s.focusRow })})`); }
await pg.click(rowSel('Kiko')); await sleep(500); s = await sheet(pg);
ok(s.open && s.state === 'ok' && /This is what other players see\./.test(s.foot) && /Your stats/.test(s.foot) && s.rank === 'Champion II', `my own row: the same public card, "This is what other players see." and Your stats (${J({ foot: s.foot, rank: s.rank })})`);
ok(s.emA11y === 'img|Rank: Champion II', `the sheet's medal is an image named for the rank (${s.emA11y})`);
await pg.click('#btn-lbp-mine'); await sleep(500); s = await sheet(pg);
ok(!s.open && s.view === 'profile', `Your stats closes the sheet and opens Your stats (${s.view})`);
await ev(pg, () => window.__ui.lobbyView('leaderboard')); await pg.waitForFunction(() => document.querySelectorAll('#lb-list button.lb-row').length === 12, { timeout: 8000 }).catch(() => {}); await sleep(300);
await pg.click(rowSel('Mo')); await sleep(400); s = await sheet(pg);
ok(s.open && s.state === 'gone' && s.msg === 'This player isn’t on the leaderboard any more' && !s.statsShown && !s.retry, `404: "${s.msg}", no stats, no Try again`);
await pg.keyboard.press('Escape'); await sleep(200);
API.zedOk = false; await pg.click(rowSel('Zed')); await sleep(400); s = await sheet(pg);
ok(s.open && s.state === 'error' && s.msg === 'Couldn’t load this player' && s.retry && !s.statsShown, `500: "${s.msg}" and Try again`);
{ const red = await ev(pg, () => getComputedStyle(document.getElementById('lbp-card')).borderTopColor); ok(!/255, 9|rgb\(2[0-9]{2}, [0-9]{1,2}, [0-9]{1,2}\)/.test(red), `the error state is not the red form nudge (${red})`); }
API.zedOk = true; await pg.click('#btn-lbp-retry'); await sleep(80); s = await sheet(pg);
ok(s.inCard, 'Try again keeps focus in the sheet');
await sleep(400); s = await sheet(pg);
ok(s.state === 'ok' && s.rank === 'Diamond III' && s.stats.length === 11 && !s.stats.some(x => x.skel) && !s.retry && !s.msg, `Try again: the card draws (${s.rank}, ${s.stats.map(x => x.v)})`);
await pg.keyboard.press('Escape'); await sleep(250); s = await sheet(pg); ok(s.focusRow === 'Zed', `and Esc hands focus back to Zed's row (${s.focusRow})`);

// ---------- 9: a stale answer never draws; a double click opens one sheet ----------
await pg.click(rowSel('Lobster')); await sleep(120); await pg.keyboard.press('Escape'); await sleep(100);
{ const v = await ev(pg, () => window.__ui.lobbyView()); ok(v === 'leaderboard' && !(await sheet(pg)).open, `Esc while Lobster's card is on its way: no card, and the view stays (not the lobby's Back) (${v})`); }
await sleep(900); ok(!(await sheet(pg)).open, "Lobster's answers arrive after the Esc: no card pops up");
await pg.click(rowSel('Nova')); await sleep(1200); s = await sheet(pg);
ok(s.open && s.name === 'Nova' && s.state === 'ok' && s.stats[0].v === '50%', `Lobster (800 ms) closed, Nova (50 ms) opened: the sheet shows Nova, never Lobster (${s.name} ${s.stats[0]?.v})`);
await pg.keyboard.press('Escape'); await sleep(200);
await pg.click(rowSel('Juno'), { clickCount: 2 }); await sleep(600); s = await sheet(pg);
ok(s.open && s.name === 'Juno' && s.state === 'ok', `a double click opens the sheet once and leaves it open (${J({ open: s.open, state: s.state })})`);
ok(s.mcls === 'lbp-matt st-mbadge is-none' && s.mtip === '' && s.mscore === null, `no Matt beaten: no ring, no tooltip, no score line (${s.mcls}, ${s.mscore})`);
ok(s.rank === 'No trophies yet' && !s.em && s.emA11y === '|' && s.tro === null && s.mbest === 'None yet' && s.stats.map(x => x.v).join() === '-,0m,0,-,-,0,-,0,0,0,0' && s.rec === '0-0' && s.streak === '0', `no trophies yet: no emblem, "No trophies yet", no trophies, the zeros and dashes as the card has them (${J({ rank: s.rank, v: s.stats.map(x => x.v) })})`);
await pg.keyboard.press('Escape'); await sleep(250); s = await sheet(pg); ok(!s.open && s.focusRow === 'Juno', `Esc after the double click: focus on Juno's row (${s.focusRow})`);

await pg.close();

// ---------- 10: the list redraws under the sheet (/api/stats answers late): focus finds the new row ----------
API.statsDelay = 1500; pg = await page('redraw');
await pg.goto(URL0, { waitUntil: 'domcontentloaded' }); await sleep(2000); await pg.click('#btn-start').catch(() => {}); await sleep(800);
await ev(pg, () => window.__ui.lobbyView('leaderboard')); await pg.waitForFunction(() => document.querySelectorAll('#lb-list button.lb-row').length === 12, { timeout: 4000 }).catch(() => {});
const oldRow = await pg.$(rowSel('Dan')); await oldRow.click(); await sleep(2000);
{ const gone = await ev(pg, b => !b.isConnected, oldRow); await pg.keyboard.press('Escape'); await sleep(250); s = await sheet(pg);
  ok(gone && !s.open && s.focusRow === 'Dan' && s.focusConnected, `the row clicked was replaced while the sheet was open (${gone}); Esc focuses Dan's new row (${s.focusRow}, connected ${s.focusConnected})`); }
await pg.close(); API.statsDelay = 0;

// ---------- 12: a guest viewer (sign-in off, nobody signed in): a plain GET, no device id, no body ----------
API.signin = false; pg = await page('guest'); API.log.length = 0;
await toBoard(pg); await pg.click(rowSel('Dan')); await sleep(700); s = await sheet(pg);
{ const reqs = API.log.filter(l => l[1].startsWith('/api/leaderboard/player'));
  ok(s.open && s.state === 'ok' && !s.foot && reqs.length === 1 && reqs[0][0] === 'GET' && reqs[0][1] === '/api/leaderboard/player?u=Dan' && reqs[0][2] === '' && !/dev/.test(reqs[0][1]),
    `a guest opens Dan: one GET /api/leaderboard/player?u=Dan, no body, no device id, no own-row footer (${J(reqs.map(l => [l[0], l[1], l[2]]))})`);
  ok(!API.log.some(l => /"dev"/.test(l[2] || '')), `no request from this page carried a device id (${J(API.log.map(l => l[1]))})`); }
await pg.keyboard.press('Escape'); await pg.close(); API.signin = true;

// ---------- 13: fit at three sizes, the longest name ----------
for (const [w, h] of [[1440, 900], [1280, 720], [390, 844]]) {
  pg = await page('fit' + w, { w, h }); await toBoard(pg);
  await ev(pg, n => [...document.querySelectorAll('button.lb-row')].find(b => b.dataset.name === n).click(), 'Pickle_Rick'); await sleep(600);
  const r = await ev(pg, () => { const c = document.getElementById('lbp-card'), b = c.getBoundingClientRect();
    return { in: b.left >= -0.5 && b.top >= -0.5 && b.right <= innerWidth + 0.5 && b.bottom <= innerHeight + 0.5, wide: [...c.querySelectorAll('*')].filter(e => { const q = e.getBoundingClientRect(); return q.width && (q.left < b.left - 1 || q.right > b.right + 1); }).map(e => e.id || e.className.baseVal || e.className).slice(0, 4),
      side: document.documentElement.scrollWidth > innerWidth, name: document.getElementById('lbp-name').textContent, state: c.dataset.state,
      clipped: [...c.querySelectorAll('#lbp-stats [data-stat], #lbp-stats dt, #lbp-stats .caps, #lbp-w, #lbp-l')].filter(e => { const box = e.closest('.st-fig, .st-tile, .st-ret, .st-people'), q = e.getBoundingClientRect(); return q.width && (q.right > box.getBoundingClientRect().right + 0.5 || q.left < box.getBoundingClientRect().left - 0.5 || (getComputedStyle(e).display !== 'inline' && e.scrollWidth > e.clientWidth + 1)); }).map(e => e.textContent) }; });
  ok(r.in && !r.wide.length && !r.side && !r.clipped.length && r.name === 'Pickle_Rick' && r.state === 'ok', `${w}x${h}: the sheet is inside the window, nothing pokes out, no sideways scroll, the widest figures ('277h 46m', '4,321-1,234 vs people', '88,888') uncut (${J(r)})`);
  await pg.close(); }

// ---------- 14: reduced motion: no lift on hover, nothing breaks ----------
pg = await page('calm'); await pg.emulateMediaFeatures([{ name: 'prefers-reduced-motion', value: 'reduce' }]); await toBoard(pg);
await pg.hover(rowSel('Kiko')); await sleep(300);
{ const t = await ev(pg, () => { const b = document.querySelector('button.lb-row[data-name="Kiko"]'); return { t: getComputedStyle(b).transform, a: getComputedStyle(b.parentElement).animationName }; });
  await pg.click(rowSel('Dan')); await sleep(700); s = await sheet(pg);
  ok(t.t === 'none' && t.a === 'none' && s.state === 'ok', `reduced motion: a hovered row does not lift, no entrance, the sheet still opens (${J(t)})`); }
await pg.close();

// ---------- 15: no notice about the leaderboard or the profile card, ever (NOTES 168): any old poddle.lbSeen value is deleted at load ----------
const notice = async (seen, listed) => { API.mePlaces = { listed, hidden: !listed }; const p = await page('notice-' + seen + listed, { seen }); await p.goto(URL0, { waitUntil: 'domcontentloaded' }); await sleep(1500); await p.click('#btn-start').catch(() => {}); await sleep(3200);
  const r = await ev(p, () => ({ toast: document.getElementById('toast')?.textContent || '', seen: localStorage.getItem('poddle.lbSeen') })); await p.close(); return r; };
{ const bad = []; for (const [seen, listed] of [[null, true], ['1', true], ['1', false], ['2', true], ['3', true]]) { const r = await notice(seen, listed); if (/leaderboard|profile card|your stats/i.test(r.toast) || r.seen !== null) bad.push(J([seen, listed, r])); }
  ok(!bad.length, `lbSeen unset, '1', '2' or '3', listed or hidden: no notice on load, and the key is gone${bad.length ? ' (' + bad.join('; ') + ')' : ''}`); }
API.mePlaces = { listed: true };

// ---------- 17: the Show me switch answers with its plain toasts only ----------
{ API.mePlaces = { listed: false }; PLACES.hidden = true; PLACES.listed = false;
  const p = await page('unhide', { seen: '1' }); await toBoard(p);
  const tog = async () => { await p.click('#tog-lb-show'); await sleep(400); return ev(p, () => ({ toast: document.getElementById('toast')?.textContent || '', seen: localStorage.getItem('poddle.lbSeen'), on: document.getElementById('tog-lb-show').getAttribute('aria-checked') })); };
  const a = await ev(p, () => document.getElementById('tog-lb-show')?.getAttribute('aria-checked'));
  let r = await tog(); const r1 = await tog();
  ok(a === 'false' && r.on === 'true' && r.toast === 'You’re on the global leaderboard' && r1.toast === 'You’re hidden from the global leaderboard' && r.seen === null, `Show me turned on, then off: the plain toasts, nothing about the profile card, no lbSeen written (${J([a, r, r1.toast])})`);
  await p.close(); API.mePlaces = { listed: true }; PLACES.hidden = false; PLACES.listed = true; }

const uniq = [...new Set(errs.map(e => e.split('\n')[0].slice(0, 220)))];
ok(!uniq.length, 'no page errors' + (uniq.length ? ':\n  ' + uniq.join('\n  ') : ''));
console.log(out.join('\n')); const bad = out.filter(l => l.startsWith('FAIL')).length;
console.log(`${out.length - bad} passed, ${bad} failed`); console.log(bad ? 'LB PROFILE UI FAIL' : 'LB PROFILE UI PASSED');
await browser.close(); web.close(); for (const c of wss.clients) c.terminate(); wss.close(); process.exit(bad ? 1 : 0);
