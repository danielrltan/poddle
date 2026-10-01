// Friends client (docs/SOCIAL.md 6, 8; slice A): web/social.js + ui.js + main.js + profile.js + index.html against a fake /api and a fake game socket.
// The real page runs with ?acctest=1 (the account features are off on localhost otherwise). The fake /api answers section 8's contract (friends,
// search, player, POST ops) from a small in-memory world, plus the leaderboard profile (NOTES 140: GET /api/leaderboard/player, Dan and Bea only); the fake game sends a {type:'social'} snapshot after a signed-in socket's hello, and
// pushes more on demand. Screenshots: test/ui-shots/social-*.png at 1440x900 and 390x844 (the app has no dark theme: light only).
// Usage: node test/social-ui.mjs      SOCIAL_UI_PORT=<base> moves the ports (default 9520: pages + /api, 9521: fake game, 9522: nothing = no AirPod).
import http from 'http'; import fs from 'fs'; import path from 'path';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
const P0 = +process.env.SOCIAL_UI_PORT || 9520, W = P0, G = P0 + 1, DEAD = P0 + 2, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
if ([8080, 8787, 3000].some(p => p >= P0 && p <= P0 + 2)) { console.log('refusing: that port range holds the player\'s own game'); process.exit(2); }
const J = o => JSON.stringify(o), SHOTS = path.join(root, 'test/ui-shots'), DEV = '1b4e28ba-2fa1-4d3b-9c5d-0a1b2c3d4e5f';
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.svg': 'image/svg+xml' };

// ---------- the fake world: usernames (lower-case keys), who I am, my friends and requests. The wire carries names only ----------
const now = Date.now(), HOSTILE = '<i>x</i>&lt;';      // a name no real username can be: it must come out as these very characters
const USERS = { sam: { name: 'Sam' }, bea: { name: 'Bea', rank: { tier: 3, div: 2 }, places: { listed: true, trophies: { rank: 12, v: 340 }, rally: { rank: 3, v: 41 }, streak: null } },
  cy: { name: 'Cy', rank: null }, dan: { name: 'Dan', rank: { tier: 8, div: 1 }, places: { listed: true, trophies: { rank: 1, v: 1400 } } }, eve: { name: 'Eve', rank: { tier: 6, div: 3 } },
  rex: { name: 'Rex', rank: { tier: 2, div: 1 } }, olga: { name: 'Olga' }, ann: { name: 'Ann', rank: { tier: 4, div: 1 }, places: { listed: true, streak: { rank: 40, v: 6 } } },
  alice: { name: 'alice', rank: { tier: 1, div: 3 } }, alvin: { name: 'Alvin' }, alba: { name: 'Alba' }, [HOSTILE.toLowerCase()]: { name: HOSTILE }, hidden_hal: { name: 'hidden_hal', hidden: true } };
const LABELS = [['Win rate vs people', 'Win rate'], ['Time on court', 'On court'], ['Best win streak vs people', 'Best streak'], ['Return rate', 'Returns'], ['Points won', 'Points won'], ['Longest rally', 'Rally', 'hits'], ['Fastest swing', 'Swing', '°/s'], ['Winners', 'Winners'], ['Aces', 'Aces'], ['Smashes', 'Smashes'], ['Tournament titles', 'Titles']];
// ELEVEN(winRate, record, time, streak, returns, points, rally, swing, winners, aces, smashes, titles): the share card's eleven (NOTES 145), as test/lb-profile-ui.mjs builds them
const ELEVEN = (wr, rec, ...v) => LABELS.map(([label, tag, unit], i) => ({ label, tag, value: i ? v[i - 1] : wr, ...(unit ? { unit } : {}),
  ...(i === 0 ? { note: rec + ' vs people', hero: true } : i === 1 ? { note: 'all modes', hero: true } : i === 2 ? { note: 'wins vs people', hero: true } : {}) }));
const LBP = { Dan: { name: 'Dan', rank: { tier: 8, div: 1, label: 'Pro #1', pro: 1 }, trophies: 1400, matt: 'Pro', stats: ELEVEN('86%', '42-7', '11h 6m', '12', '81%', '58%', '58', '1570', '318', '40', '22', '3') },
  Bea: { name: 'Bea', rank: { tier: 3, div: 2, label: 'Gold II', pro: null }, trophies: 340, matt: 'Club', stats: ELEVEN('50%', '7-7', '2h 5m', '3', '64%', '51%', '41', '1100', '60', '4', '9', '0') } };
const W0 = () => ({ friends: new Set(['bea', 'cy', 'dan', 'eve']), st: { bea: 'matt', cy: 'menu', dan: 'off', eve: 'playing' }, inc: [{ k: 'rex', at: now - 3 * 3600e3 }], out: [{ k: 'olga', at: now - 86400e3 }] });
let world = W0();
const API = { acct: { username: 'Sam', renameAt: null }, fail: null, slow: {}, meSlow: 0, log: [] };      // fail: the next POST answers { status, error }. slow: search q -> delay ms (the stale-answer test). meSlow: /api/me's delay
const WEIGHT = { tour: 6, playing: 5, matt: 4, watching: 3, menu: 1, off: 0 };      // docs/SOCIAL.md presence: no queue or ranked since docs/TROPHIES.md 2
const snap = () => ({ friends: [...world.friends].map(k => ({ name: USERS[k].name, st: world.st[k] || 'off', rank: USERS[k].rank || null })).sort((a, b) => WEIGHT[b.st] - WEIGHT[a.st] || a.name.localeCompare(b.name)),
  inc: world.inc.map(x => ({ name: USERS[x.k].name, at: x.at })), out: world.out.map(x => ({ name: USERS[x.k].name, at: x.at })) });
const relOf = k => world.friends.has(k) ? 'friend' : world.inc.some(x => x.k === k) ? 'in' : world.out.some(x => x.k === k) ? 'out' : 'none';
const apiAnswer = (q, body, r) => { const u = new URL(q.url, 'http://x'), send = (s, o) => { r.writeHead(s, { 'content-type': 'application/json' }); r.end(o === undefined ? '' : J(o)); };
  let b = null; try { b = body ? JSON.parse(body) : null; } catch { b = null; } API.log.push([q.method, u.pathname + u.search, b]);
  const who = API.acct, gate = () => (!who ? send(401, { error: 'signin' }) || true : !who.username ? send(403, { error: 'username' }) || true : false);
  if (u.pathname === '/api/me') return setTimeout(() => send(200, { db: true, signin: { enabled: true, clientId: 'test-client.apps.googleusercontent.com' }, account: API.acct }), API.meSlow);
  if (u.pathname === '/api/stats') return send(200, { profile: null });
  if (u.pathname === '/api/leaderboard') return send(200, { rows: [{ rank: 1, name: 'Dan', v: 58, tier: 8, div: 1 }, { rank: 2, name: 'Bea', v: 41, tier: 3, div: 2 }, { rank: 3, name: 'alice', v: 30, tier: 1, div: 3 }] });
  if (u.pathname === '/api/friends' && q.method === 'GET') { if (gate()) return; return send(200, snap()); }
  if (u.pathname === '/api/friends/search') { if (gate()) return; const s = u.searchParams.get('q') || ''; if (!/^[A-Za-z0-9_]{2,12}$/.test(s)) return send(400, { error: 'q' });
    const rows = Object.entries(USERS).filter(([k]) => k !== 'sam' && k.startsWith(s.toLowerCase())).slice(0, 20).map(([k, v]) => ({ name: v.name, rel: relOf(k) }));
    if (s.toLowerCase() === 'ho') rows.push({ name: HOSTILE, rel: 'none' });      // the hostile name, as if the server let it through
    return setTimeout(() => send(200, { rows }), API.slow[s] || 0); }
  if (u.pathname === '/api/leaderboard/player') { const n = u.searchParams.get('u'), b = LBP[n]; return b ? send(200, b) : send(404, { error: 'not_found' }); }      // the top-100 profile: only Dan and Bea are on a board
  if (u.pathname === '/api/player') { const k = (u.searchParams.get('name') || '').toLowerCase(), p = USERS[k]; if (!p) return send(404, { error: 'notfound' });
    const fr = !!who && world.friends.has(k), open = !p.hidden || fr; return send(200, { name: p.name, rank: open ? p.rank || null : null, places: open ? p.places || null : null, rel: who ? relOf(k) : 'none', st: fr ? world.st[k] || 'off' : null }); }
  if (u.pathname === '/api/friends' && q.method === 'POST') { if (gate()) return;
    if (API.fail) { const f = API.fail; API.fail = null; return send(f.status, { error: f.error }); }
    const op = b && b.op, k = String(b && b.name || '').toLowerCase(); if (!['add', 'accept', 'decline', 'cancel', 'remove'].includes(op)) return send(400, { error: 'op' }); if (!USERS[k]) return send(404, { error: 'notfound' }); if (k === 'sam') return send(409, { error: 'self' });
    let res = '';
    if (op === 'add') { if (world.friends.has(k)) res = 'friends'; else if (world.inc.some(x => x.k === k)) { world.inc = world.inc.filter(x => x.k !== k); world.friends.add(k); res = 'friends'; } else { if (!world.out.some(x => x.k === k)) world.out.push({ k, at: Date.now() }); res = 'requested'; } }
    else if (op === 'accept' || op === 'decline') { if (!world.inc.some(x => x.k === k)) return send(409, { error: 'norequest' }); world.inc = world.inc.filter(x => x.k !== k); if (op === 'accept') world.friends.add(k); res = op === 'accept' ? 'friends' : 'declined'; }
    else if (op === 'cancel') { world.out = world.out.filter(x => x.k !== k); res = 'cancelled'; }
    else { world.friends.delete(k); res = 'removed'; }
    return send(200, { r: res, rel: relOf(k), snap: snap() }); }
  return send(404, { error: 'nope' }); };
const web = http.createServer((q, r) => {
  if (q.url.startsWith('/api/')) { let body = ''; q.on('data', c => { body += c; }); q.on('end', () => apiAnswer(q, body, r)); return; }
  const p = decodeURIComponent(q.url.split('?')[0]), menu = ['/friends', '/play', '/leaderboard'].includes(p);      // the server's MENU_PATHS (docs/SOCIAL.md 8: /friends): the page itself
  let f = path.join(root, menu ? 'web/index.html' : p); if (!f.startsWith(root)) { r.writeHead(403); return r.end(); } if (f.endsWith('/')) f += 'index.html';
  const serve = (g, next) => fs.readFile(g, (e, d) => { if (e && next) return next(); r.writeHead(e ? 404 : 200, { 'content-type': MIME[path.extname(g)] || 'application/octet-stream' }); r.end(e ? '' : d); });
  serve(f, () => serve(path.join(root, 'web', p), null)); }).listen(W, '127.0.0.1');

// ---------- the fake game: a lobby list; Quick play seats me (side 0) beside Ann; a watch link watches Ann vs Rex. The social snapshot follows a signed-in hello ----------
const COURT = { halfW: 3.05, halfL: 6.7, kitchen: 2.13, net: 0.91 }, LIST = { type: 'lobby', online: 5, rooms: [] }, socks = [];
const PAD = (z, bot = false) => ({ x: 0, y: 1, z, q: [0, 0, 0, 1], bot });
const wss = new WebSocketServer({ port: G, host: '127.0.0.1' });
wss.on('connection', (ws, req) => { const s = { ws, url: req.url, frames: [] }; socks.push(s); ws.send(J(LIST));
  ws.on('message', raw => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.type === 'ping') return ws.send(J({ type: 'pong', c: m.c })); s.frames.push(m);
    if ((m.type === 'hello' || m.type === 'socialget') && API.acct && API.acct.username) { s.social = (s.social || 0) + 1; ws.send(J({ type: 'social', ...snap() })); }      // socialget: the server's own way to a first snapshot without a hello
    if (m.type === 'quick') { ws.send(J({ type: 'room', code: 'QQQQ', public: true, role: 'player' })); ws.send(J({ type: 'welcome', side: 0, role: 'player', court: COURT, names: ['Sam', 'Ann'], reg: [true, true] })); }
    if (m.type === 'watch') { ws.send(J({ type: 'room', code: m.code, public: true, role: 'spectator' })); ws.send(J({ type: 'welcome', side: 0, role: 'spectator', court: COURT, names: ['Ann', 'Rico'], reg: [true, false] }));
      ws.send(J({ type: 'state', t: 1, p: [0, 1, 0], v: [0, 0, 0], live: false, serving: 0, score: [4, 2], paddles: [PAD(6.5), PAD(-6.5)] })); } }); });
const pushAll = m => { for (const s of socks) if (s.ws.readyState === 1) s.ws.send(J(m)); };

const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
const out = [], errs = [], ok = (c, what) => { out.push((c ? 'PASS ' : 'FAIL ') + what); if (!c) console.log('FAIL', what); };
const bail = setTimeout(() => { console.log(out.join('\n')); console.log('SOCIAL UI FAIL (timeout)'); process.exit(2); }, 300000);
const DESK = { width: 1440, height: 900 }, PHONE = { width: 390, height: 844 };
async function page(tag, { device = true, seen = true, acct } = {}) {      // a fresh tab with its own storage: poddle.name, the camera answered, the leaderboard notice seen
  const ctx = await browser.createBrowserContext(), pg = await ctx.newPage(); await pg.setViewport(DESK); await pg.setRequestInterception(true);
  pg.on('request', q => { if (/^https:\/\/([a-z0-9-]+\.)*(accounts\.google\.com|gstatic\.com)\//.test(q.url())) return q.abort(); q.continue(); });
  pg.on('pageerror', e => errs.push(`[${tag}] PAGEERROR ${e.message}`));
  pg.on('console', m => { if (m.type() === 'error' && !/ERR_CONNECTION_REFUSED|ERR_FAILED|WebSocket connection|Failed to load resource/.test(m.text())) errs.push(`[${tag}] ${m.text()}`); });
  await pg.evaluateOnNewDocument((dev, seen) => { try { localStorage.setItem('poddle.name', 'Sam'); localStorage.setItem('poddle.camPrimer', 'allow'); localStorage.setItem('poddle.lbSeen', '1'); if (seen) localStorage.setItem('poddle.friendsSeen', '1'); if (dev) localStorage.setItem('poddle.device', dev); } catch {}
    window.__toasts = []; document.addEventListener('DOMContentLoaded', () => { const t = document.getElementById('toast'); new MutationObserver(() => { if (t.textContent && window.__toasts.at(-1) !== t.textContent) window.__toasts.push(t.textContent); }).observe(t, { childList: true, characterData: true, subtree: true }); }); }, device ? DEV : '', seen);
  if (acct !== undefined) API.acct = acct;
  pg.ctx = ctx; return pg; }
const URLQ = `?uitest=1&acctest=1&cam=0&game=${G}&bridge=${DEAD}`, HOME = `http://127.0.0.1:${W}/web/index.html${URLQ}`;
const ev = (pg, fn, ...a) => pg.evaluate(fn, ...a);
const shot = async (pg, name) => { await sleep(450); await pg.screenshot({ path: path.join(SHOTS, `social-${name}.png`) }); };
const toasts = pg => ev(pg, () => window.__toasts.slice());
const seenEl = (pg, sel) => ev(pg, s => { const e = document.querySelector(s); if (!e) return false; const r = e.getBoundingClientRect(), c = getComputedStyle(e); return !e.closest('[hidden]') && r.width > 0 && c.visibility !== 'hidden' && c.display !== 'none'; }, sel);
const texts = (pg, sel) => ev(pg, s => [...document.querySelectorAll(s)].filter(e => e.offsetParent).map(e => e.textContent), sel);
const clickText = (pg, scope, t) => ev(pg, (s, t) => { const b = [...document.querySelectorAll(s + ' button')].find(x => x.offsetParent && x.textContent.trim() === t); if (b) b.click(); return !!b; }, scope, t);
const rowBtn = (pg, scope, name, t) => ev(pg, (s, n, t) => { const li = [...document.querySelectorAll(s + ' .fr-row')].find(x => x.offsetParent && x.dataset.name === n); const b = li && [...li.querySelectorAll('button')].find(x => t === '...' ? x.classList.contains('fr-more') : x.textContent.trim() === t); if (b) b.click(); return !!b; }, scope, name, t);
const posts = () => API.log.filter(l => l[0] === 'POST' && l[1] === '/api/friends').map(l => l[2]);
const searches = () => API.log.filter(l => l[1].startsWith('/api/friends/search')).map(l => decodeURIComponent(l[1].split('q=')[1]));

// ---------- A. signed in with a device id: the socket's hello brings the first snapshot. The home tile, no notice (NOTES 147), the view ----------
let pg = await page('lobby', { seen: false });
await pg.goto(HOME); await sleep(1500); await pg.click('#btn-start'); await sleep(3200);
let r = await ev(pg, () => { const t = document.getElementById('btn-friends'); return { show: !!t && !t.hidden, n: document.querySelector('#lobby-home .tiles').dataset.n, line: document.getElementById('friends-line-text').textContent, badge: document.getElementById('friends-n').textContent, badgeOn: !document.getElementById('friends-n').classList.contains('is-off'), dot: !document.getElementById('friends-dot').hidden, seen: localStorage.getItem('poddle.friendsSeen') }; });
ok(r.show && r.n === '6' && r.line === '3 online' && r.badge === '1 request' && r.badgeOn && r.dot, `home: the Friends tile (6 tiles: docs/TROPHIES.md 4), "${r.line}" with the dot, badge "${r.badge}" (${J(r)})`);
let t = await toasts(pg);
ok(!t.some(x => /sent you a friend request/.test(x)), `the first snapshot after the hello is silent (toasts ${J(t)})`);
ok(!t.some(x => /^New\b|add friends and see/i.test(x)) && r.seen === null, `no feature-announcement toast on the home screen (NOTES 147), and no poddle.friendsSeen key (${J(t)}, ${r.seen})`);
ok(socks.some(s => s.frames.some(f => f.type === 'hello')), 'the socket said hello (the device id was there)');
await shot(pg, 'home-desktop');
// six tiles lay out as 2 over 4 (landscape), 2 / 2 / 2 (portrait) or one column (phone): never a lone straggler, never wider than the window
{ const SIZES = [[1920, 1080], [1440, 900], [1280, 720], [1024, 768], [900, 700], [760, 600], [1366, 500], [700, 900], [600, 900], [390, 844]], bad = [];
  for (const [w, h] of SIZES) { await pg.setViewport({ width: w, height: h }); await sleep(250);
    const x = await ev(pg, () => { const ts = [...document.querySelectorAll('#lobby-home .tile')].filter(e => !e.hidden), m = new Map(); for (const e of ts) m.set(e.offsetTop, (m.get(e.offsetTop) || 0) + 1);
      const cut = [...document.querySelectorAll('#lobby-home .tile b, #friends-line-text')].filter(e => e.offsetParent && e.scrollWidth > e.clientWidth + 1).map(e => e.textContent);
      return { rows: [...m.values()].join(), over: document.querySelector('#lobby-home .tiles').scrollWidth > innerWidth, cut }; });
    if (!['2,4', '2,2,2', '1,1,1,1,1,1'].includes(x.rows) || x.over || x.cut.length) bad.push(`${w}x${h}: ${J(x)}`); }
  ok(!bad.length, `home tiles: 2 over 4, 2 / 2 / 2 or one column at ${SIZES.length} sizes, no label cut${bad.length ? ' (' + bad.join('; ') + ')' : ''}`); }
await pg.setViewport(PHONE); await sleep(300); await shot(pg, 'home-phone'); await pg.setViewport(DESK); await sleep(300);

// the view: /friends in the address bar; requests, friends online first with their words, sent
await pg.click('#btn-friends'); await sleep(1200);
r = await ev(pg, () => ({ view: !document.getElementById('lobby-friends').hidden, title: document.getElementById('lobby-title').textContent, path: location.pathname, nameRow: !document.getElementById('name-row').hidden }));
ok(r.view && r.title === 'Friends' && !r.nameRow, `the Friends view opens (title "${r.title}", no name row) (${J(r)})`);
r = await ev(pg, () => { const V = document.getElementById('lobby-friends'), rows = s => [...V.querySelectorAll(s + ' .fr-row')].map(li => [li.dataset.name, li.querySelector('.fr-st')?.textContent || '', li.querySelector('.fr-dot')?.className || '', [...li.querySelectorAll('.fr-acts button, .fr-acts .fr-tag')].map(b => b.textContent.trim() || b.getAttribute('aria-label'))]);
  return { inc: rows('.fr-inc'), fr: rows('.fr-friends'), out: rows('.fr-out'), count: V.querySelector('.fr-inc .fr-count').textContent, online: V.querySelector('.fr-friends .fr-more-n').textContent, emblems: V.querySelectorAll('.fr-friends .rank-badge').length, dev: V.querySelectorAll('.fr-friends .reg-badge').length }; });
ok(J(r.fr.map(x => x[0])) === J(['Eve', 'Bea', 'Cy', 'Dan']) && r.fr[0][1] === 'In a game' && r.fr[1][1] === 'Playing Matt' && r.fr[2][1] === 'Online' && r.fr[3][1] === 'Offline', `friends: online first, busiest on top, the status words (${J(r.fr.map(x => x.slice(0, 2)))})`);
ok(/is-busy/.test(r.fr[0][2]) && /is-on/.test(r.fr[2][2]) && !/is-on|is-busy/.test(r.fr[3][2]) && r.online === '3 online', `dots: amber in a match, green online, a ring offline; "${r.online}"`);
ok(r.emblems === 3 && r.dev === 1, `rank emblems beside the three friends with a rank, the developer's hammer beside Dan (${r.emblems}, ${r.dev})`);
ok(J(r.inc.map(x => [x[0], x[3]])) === J([['Rex', ['Accept', 'Decline']]]) && r.count === '1' && /^Wants to be friends · 3 h ago$/.test(r.inc[0][1]), `requests: Rex with Accept / Decline, the count ${r.count}, "${r.inc[0] && r.inc[0][1]}"`);
ok(J(r.out.map(x => [x[0], x[3]])) === J([['Olga', ['Cancel']]]) && r.fr.every(x => J(x[3]) === J(['More for ' + x[0]])), `sent: Olga with Cancel; every friend row has only its ... menu (no one-click Remove) (${J(r.out)})`);
await shot(pg, 'view-desktop');
await pg.setViewport(PHONE); await sleep(400);
r = await ev(pg, () => { const v = document.getElementById('lobby-friends').getBoundingClientRect(), cut = [...document.querySelectorAll('#lobby-friends .fr-row')].filter(li => li.scrollWidth > li.clientWidth + 1 || li.getBoundingClientRect().right > innerWidth).map(li => li.dataset.name); return { l: v.left, r: v.right, w: innerWidth, cut }; });
ok(r.l >= 0 && r.r <= r.w && !r.cut.length, `the view fits at 390 px, no row overflows (${J(r)})`);
await shot(pg, 'view-phone'); await pg.setViewport(DESK); await sleep(300);

// search: nothing under 2 letters, one request 250 ms after the last key, a slower older answer never lands over a newer one, the hostile name as text
const q = () => pg.$('#lobby-friends .fr-q');
let n0 = searches().length; await (await q()).click(); await pg.keyboard.type('a'); await sleep(500);
r = await ev(pg, () => document.querySelector('#lobby-friends .fr-hint').textContent);
ok(searches().length === n0 && r === 'Type at least 2 letters', `one letter: no request, "${r}"`);
await pg.keyboard.type('lv', { delay: 60 }); await sleep(120); ok(searches().length === n0, 'typing: nothing sent before 250 ms of quiet');
await sleep(500); ok(J(searches().slice(n0)) === J(['alv']), `one request for the settled query (${J(searches().slice(n0))})`);
r = await texts(pg, '#lobby-friends .fr-results .fr-name'); ok(J(r) === J(['Alvin']), `results: ${J(r)}`);
API.slow.al = 900; n0 = searches().length; await pg.keyboard.press('Backspace'); await sleep(450); await pg.keyboard.type('b'); await sleep(1400);      // 'al' is slow, 'alb' is quick
r = await texts(pg, '#lobby-friends .fr-results .fr-name');
ok(J(searches().slice(n0)) === J(['al', 'alb']) && J(r) === J(['Alba']), `the slow answer for "al" came after "alb": the results stay "alb"'s (${J(r)})`);
await ev(pg, () => { const i = document.querySelector('#lobby-friends .fr-q'); i.value = ''; i.dispatchEvent(new Event('input')); }); await (await q()).type('al'); await sleep(1300);
r = await ev(pg, () => [...document.querySelectorAll('#lobby-friends .fr-results .fr-row')].map(li => [li.dataset.name, li.querySelector('.fr-acts').textContent.trim()]));
ok(J(r) === J([['alice', 'Add friend'], ['Alvin', 'Add friend'], ['Alba', 'Add friend']]), `"al": three players, each with Add friend (${J(r)})`);
await shot(pg, 'search-desktop');
await rowBtn(pg, '#lobby-friends .fr-results', 'alice', 'Add friend'); await sleep(700);
r = await ev(pg, () => ({ act: [...document.querySelectorAll('#lobby-friends .fr-results .fr-row')].find(li => li.dataset.name === 'alice').querySelector('.fr-acts').textContent.trim() }));
ok(J(posts().at(-1)) === J({ op: 'add', name: 'alice' }) && r.act === 'Requested' && (await toasts(pg)).includes('Request sent to alice'), `Add friend: POST { op: add, name }, the row says Requested, the toast (${J(posts().at(-1))}, ${r.act})`);
await ev(pg, () => { const i = document.querySelector('#lobby-friends .fr-q'); i.value = ''; i.dispatchEvent(new Event('input')); }); await (await q()).type('ho'); await sleep(700);
r = await ev(pg, () => { const b = [...document.querySelectorAll('#lobby-friends .fr-results .fr-name')]; return b.map(x => [x.textContent, x.children.length]); });
ok(r.some(x => x[0] === HOSTILE && x[1] === 0), `a hostile name is its characters, no markup (${J(r)})`);
await (await q()).focus(); await pg.keyboard.press('Escape'); await sleep(300);
r = await ev(pg, () => ({ q: document.querySelector('#lobby-friends .fr-q').value, view: !document.getElementById('lobby-friends').hidden }));
ok(r.q === '' && r.view, `Esc in the search clears it first, the view stays (${J(r)})`);
r = API.log.filter(l => l[1].startsWith('/api/friends') || l[1].startsWith('/api/player'));
ok(r.every(l => !l[2] || J(Object.keys(l[2]).sort()) === J(['name', 'op'])) && r.every(l => !/id=|owner|acct/i.test(l[1])), 'every friends request carries op + name or q only: no ids');

// accept, the ... menu's confirm (Keep / Esc / Remove), errors
await rowBtn(pg, '#lobby-friends .fr-inc', 'Rex', 'Accept'); await sleep(700);
r = await ev(pg, () => ({ inc: document.querySelector('#lobby-friends .fr-inc').hidden, rex: [...document.querySelectorAll('#lobby-friends .fr-friends .fr-row')].some(li => li.dataset.name === 'Rex'), badge: document.getElementById('friends-n').classList.contains('is-off') }));
ok(r.inc && r.rex && r.badge && (await toasts(pg)).includes('You and Rex are friends'), `Accept: Rex is a friend, the requests and the home badge go (${J(r)})`);
let p0 = posts().length; await rowBtn(pg, '#lobby-friends .fr-friends', 'Cy', '...'); await sleep(300);
r = await ev(pg, () => { const li = [...document.querySelectorAll('#lobby-friends .fr-friends .fr-row')].find(x => x.dataset.name === 'Cy'); return { confirm: li.classList.contains('is-confirm'), ask: li.querySelector('.fr-ask')?.textContent, focus: document.activeElement.textContent }; });
ok(r.confirm && r.ask === 'Remove Cy?' && r.focus === 'Keep' && posts().length === p0, `... asks "Remove Cy?" with Keep focused, nothing sent (${J(r)})`);
await shot(pg, 'confirm-desktop');
await pg.keyboard.press('Escape'); await sleep(300);
r = await ev(pg, () => ({ confirm: !!document.querySelector('#lobby-friends .fr-row.is-confirm'), view: !document.getElementById('lobby-friends').hidden, focus: document.activeElement.getAttribute('aria-label') }));
ok(!r.confirm && r.view && r.focus === 'More for Cy', `Esc on the confirm is Keep (the view stays, focus back on ...) (${J(r)})`);
await rowBtn(pg, '#lobby-friends .fr-friends', 'Cy', '...'); await sleep(200); await rowBtn(pg, '#lobby-friends .fr-friends', 'Cy', 'Remove'); await sleep(700);
r = await texts(pg, '#lobby-friends .fr-friends .fr-row .fr-name');
ok(J(posts().at(-1)) === J({ op: 'remove', name: 'Cy' }) && !r.includes('Cy'), `Remove after the confirm: POST remove, Cy is gone (${J(r)})`);
for (const [f, want] of [[{ status: 409, error: 'limit' }, 'You have 20 requests waiting. Cancel one first'], [{ status: 409, error: 'full' }, 'One of you already has 100 friends'], [{ status: 429, error: 'rate' }, 'Too many tries. Wait a minute, then try again'], [{ status: 500, error: 'internal' }, 'Couldn’t reach Poddle. Try again.']]) {
  API.fail = f; await ev(pg, () => { const i = document.querySelector('#lobby-friends .fr-q'); i.value = ''; i.dispatchEvent(new Event('input')); }); await (await q()).type('alv'); await sleep(700);
  await rowBtn(pg, '#lobby-friends .fr-results', 'Alvin', 'Add friend'); await sleep(600); t = await toasts(pg);
  ok(t.at(-1) === want, `${f.status} ${f.error}: "${t.at(-1)}"`); }
await ev(pg, () => { const i = document.querySelector('#lobby-friends .fr-q'); i.value = ''; i.dispatchEvent(new Event('input')); }); await sleep(200);

// live: a new request toasts once (and the badge), a repeat does not; socialoff clears
world.inc.push({ k: 'ann', at: Date.now() }); pushAll({ type: 'social', ...snap() }); await sleep(500);
pushAll({ type: 'social', ...snap() }); await sleep(400); t = await toasts(pg);
r = await ev(pg, () => ({ badge: document.getElementById('friends-n').textContent, rows: [...document.querySelectorAll('#lobby-friends .fr-inc .fr-row')].map(x => x.dataset.name) }));
ok(t.filter(x => x === 'Ann sent you a friend request').length === 1 && r.badge === '1 request' && J(r.rows) === J(['Ann']), `a push with a new request: one toast "Ann sent you a friend request", the badge, the row (${J(t.slice(-3))}, ${J(r)})`);
pushAll({ type: 'socialoff' }); await sleep(300);
r = await ev(pg, () => ({ rows: [...document.querySelectorAll('#lobby-friends .fr-row')].filter(li => li.offsetParent).length, all: document.querySelectorAll('#lobby-friends .fr-row').length, line: document.getElementById('friends-line-text').textContent }));
ok(r.rows === 0 && r.all === 0 && r.line === 'See who’s online', `socialoff: the lists go (${J(r)})`);
pushAll({ type: 'social', ...snap() }); await sleep(300);

// the profile card (#lbp-card, the leaderboard's, NOTES 140): from a friend's name. Both answers at once: the board's stats and /api/player's places, rel and
// status. The friend row: Friends, the status (live), Remove behind a confirm; Esc closes the card only
const card = () => ev(pg, () => { const g = id => document.getElementById(id), f = g('lbp-friend'), vis = e => !!e && !e.closest('[hidden]') && getComputedStyle(e).display !== 'none';
  return { open: !g('acct-layer').hidden && !g('lbp-card').hidden, state: g('lbp-card').dataset.state, name: g('lbp-name').textContent, dev: !!g('lbp-name').nextElementSibling?.classList.contains('reg-badge'), rank: g('lbp-rank').textContent, hero: vis(g('lbp-hero')),
    stats: vis(g('lbp-stats')) ? [...document.querySelectorAll('#lbp-stats dd b')].map(b => b.textContent) : null, places: vis(g('lbp-places')) ? [...document.querySelectorAll('#lbp-places li')].map(l => l.textContent) : [], msg: vis(g('lbp-msg')) ? g('lbp-msg').textContent : '',
    row: vis(f), line: [...f.querySelectorAll('.lbp-fr-line')].map(l => l.textContent).join('|'), dot: f.querySelector('.fr-dot')?.className || '', tag: f.querySelector('.lbp-fr-tag')?.textContent || '', acts: [...f.querySelectorAll('button')].map(b => b.textContent), foot: vis(g('lbp-foot')) }; });
const apiHits = p => API.log.filter(l => l[1].startsWith(p)).length;
{ const h0 = [apiHits('/api/leaderboard/player'), apiHits('/api/player')];
  await rowBtn(pg, '#lobby-friends .fr-friends', 'Bea', 'Bea'); await sleep(900); r = await card();
  ok(r.open && r.state === 'ok' && r.name === 'Bea' && r.rank === 'Gold II' && J(r.stats) === J(['50%', '2h 5m', '3', '64%', '51%', '41', '1100', '60', '4', '9', '0']) && J(r.places) === J(['#12Trophies', '#3Longest rally']) && !r.foot, `a friend's name opens THE profile card: the board's stats and /api/player's places (${J(r)})`);
  ok(apiHits('/api/leaderboard/player') === h0[0] + 1 && apiHits('/api/player') === h0[1] + 1, 'one GET of each, at once');
  ok(r.row && r.tag === 'Friends' && r.line === 'Playing Matt' && /is-busy/.test(r.dot) && J(r.acts) === J(['Remove']), `the friend row: Friends, "Playing Matt" with the amber dot, Remove (${J(r)})`); }
await shot(pg, 'card-desktop');
await pg.setViewport(PHONE); await sleep(300); await shot(pg, 'card-phone');
r = await ev(pg, () => { const c = document.getElementById('lbp-card').getBoundingClientRect(); return { in: c.left >= 0 && c.right <= innerWidth && c.top >= 0 && c.bottom <= innerHeight, side: document.documentElement.scrollWidth > innerWidth }; });
ok(r.in && !r.side, `the card with its friend row fits 390x844 (${J(r)})`);
await pg.setViewport(DESK); await sleep(200);
await clickText(pg, '#lbp-friend', 'Remove'); await sleep(200); r = await card();
ok(r.line === 'Remove Bea?' && J(r.acts) === J(['Remove', 'Keep']) && (await ev(pg, () => document.activeElement.textContent)) === 'Keep', `Remove asks first; Keep has the focus (${J(r)})`);
await shot(pg, 'card-confirm-desktop');
await clickText(pg, '#lbp-friend', 'Keep'); await sleep(200); r = await card();
ok(r.tag === 'Friends' && J(r.acts) === J(['Remove']) && world.friends.has('bea'), `Keep: still friends, nothing sent (${J(r)})`);
await pg.keyboard.press('Escape'); await sleep(300);
r = await ev(pg, () => ({ card: document.getElementById('acct-layer').hidden, view: !document.getElementById('lobby-friends').hidden }));
ok(r.card && r.view, `Esc closes the profile card only (the view stays) (${J(r)})`);
// pushes redraw only what changed: a row drawn the same stays the same node (a press or the focus on it survives), a changed one is replaced
const was = { friends: new Set(world.friends), st: { ...world.st } };      // put back after: the leaderboard checks below read the same world
await ev(pg, () => { const li = [...document.querySelectorAll('#lobby-friends .fr-friends .fr-row')].find(x => x.dataset.name === 'Bea'); window.__keep = [li.querySelector('.fr-more'), li.querySelector('.fr-name')]; });
{ const o = [...world.friends].find(k => k !== 'bea' && world.st[k] !== 'watching'); world.st[o] = 'watching'; pushAll({ type: 'social', ...snap() }); await sleep(400);
  r = await ev(pg, n => ({ kept: window.__keep.every(b => b.isConnected), o: [...document.querySelectorAll('#lobby-friends .fr-friends .fr-row')].find(x => x.dataset.name === n)?.dataset.st }), USERS[o].name);
  ok(r.kept && r.o === 'watching', `a push that changes ${USERS[o].name} leaves Bea's row (its buttons) in place (${J(r)})`); }
// Close gives the focus back to the name's row even when a push replaced it meanwhile; the card follows the lists (a removal elsewhere ends Friends there)
await ev(pg, () => { window.__keep[1].focus(); window.__keep[1].click(); }); await sleep(900);
world.st.bea = 'menu'; pushAll({ type: 'social', ...snap() }); await sleep(500);
r = await ev(pg, () => ({ st: document.querySelector('#lbp-friend .lbp-fr-line')?.textContent, old: window.__keep[1].isConnected }));
ok(r.st === 'Online' && !r.old, `Bea's status moves on her open card with the push (${J(r)})`);
await pg.keyboard.press('Escape'); await sleep(300);
r = await ev(pg, () => ({ cls: document.activeElement.className, name: document.activeElement.closest('.fr-row')?.dataset.name }));
ok(r.cls === 'fr-name' && r.name === 'Bea', `Close: the focus is back on Bea's name, on the row that replaced the one it came from (${J(r)})`);
await ev(pg, () => { const b = document.activeElement; window.__keep[1] = b; b.click(); }); await sleep(900);
world.friends.delete('bea'); pushAll({ type: 'social', ...snap() }); await sleep(500);
r = await ev(pg, () => ({ acts: document.querySelector('#lbp-friend .lbp-fr-acts')?.textContent, st: !!document.querySelector('#lbp-friend .fr-dot'), old: window.__keep[1].isConnected }));
ok(r.acts === 'Add friend' && !r.st && !r.old, `Bea removed me while her card was open: Add friend, no status (${J(r)})`);
await pg.keyboard.press('Escape'); await sleep(300);
r = await ev(pg, () => ({ cls: document.activeElement.className, name: document.activeElement.closest('.fr-row')?.dataset.name, inView: !!document.activeElement.closest('#lobby-friends') }));
ok(r.inView && (r.cls !== 'fr-name' || r.name !== 'Bea') && /fr-q/.test(r.cls), `Close: her row is gone, so the focus goes to the search, not the page (${J(r)})`);
Object.assign(world, was); pushAll({ type: 'social', ...snap() }); await sleep(300);
// the leaderboard: its rows open the same card (NOTES 140), with the friend row
await ev(pg, () => document.querySelector('#screen-lobby [data-back]').click()); await sleep(500); await pg.click('#btn-leaderboard'); await sleep(1200);
r = await ev(pg, () => [...document.querySelectorAll('#lb-list button.lb-row')].map(b => b.dataset.name));
ok(J(r) === J(['Dan', 'Bea', 'alice']), `leaderboard rows are the buttons (${J(r)})`);
await ev(pg, () => [...document.querySelectorAll('#lb-list button.lb-row')].find(b => b.dataset.name === 'Dan').click()); await sleep(900); r = await card();
ok(r.name === 'Dan' && r.dev && r.rank === 'Pro #1' && r.stats && r.stats.length === 11 && r.tag === 'Friends' && r.line === 'Offline' && J(r.acts) === J(['Remove']), `from the leaderboard: Dan's card with the hammer, Pro #1, the eleven stats, and the friend row (a friend, offline) (${J(r)})`);
await pg.keyboard.press('Escape'); await sleep(200);
await ev(pg, () => [...document.querySelectorAll('#lb-list button.lb-row')].find(b => b.dataset.name === 'alice').click()); await sleep(900); r = await card();
ok(r.state === 'part' && r.hero && r.rank === 'Bronze III' && r.stats === null && r.msg === 'Stats show for players on the global leaderboard' && r.line === 'Requested' && J(r.acts) === J(['Cancel']),
  `alice (not on the board's profile, requested earlier): her rank from /api/player, no stats but a quiet line, Requested + Cancel (${J(r)})`);
await shot(pg, 'card-part-desktop');
await clickText(pg, '#lbp-friend', 'Cancel'); await sleep(500); r = await card();
ok(r.line === 'Friends see when you’re online' && J(r.acts) === J(['Add friend']) && !world.out.some(x => x.k === 'alice'), `Cancel: the request goes, Add friend is back (${J(r)})`);
await clickText(pg, '#lbp-friend', 'Add friend'); await sleep(500); r = await card();
ok(r.line === 'Requested' && J(r.acts) === J(['Cancel']) && world.out.some(x => x.k === 'alice') && (await ev(pg, () => !!document.activeElement.closest('#lbp-card'))), `Add friend: Requested, the focus stays in the card (${J(r)})`);
await pg.keyboard.press('Escape'); await sleep(200);
// a hidden account (Show me off) that is not my friend: found by search, its card has no rank at all (never 'No trophies yet'), no stats, Add friend
await ev(pg, () => window.__ui.lobbyView('friends')); await sleep(600);
await (await pg.$('#lobby-friends .fr-q')).type('hidden'); await sleep(900);
await rowBtn(pg, '#lobby-friends .fr-results', 'hidden_hal', 'hidden_hal'); await sleep(900); r = await card();
ok(r.open && r.name === 'hidden_hal' && !r.hero && !r.places.length && r.stats === null && r.msg === 'Stats show for players on the global leaderboard' && J(r.acts) === J(['Add friend']), `a hidden stranger from search: no hero, no places, no stats, Add friend (${J(r)})`);
await shot(pg, 'card-hidden-desktop');
await pg.keyboard.press('Escape'); await sleep(200); await ev(pg, () => { const q = document.querySelector('#lobby-friends .fr-q'); q.value = ''; q.dispatchEvent(new Event('input')); }); await sleep(200);

// a reload on /friends comes back to the view
await pg.goto(`http://127.0.0.1:${W}/friends${URLQ}`); await sleep(2500);
r = await ev(pg, () => ({ view: !document.getElementById('lobby-friends').hidden, rows: document.querySelectorAll('#lobby-friends .fr-friends .fr-row').length }));
ok(r.view && r.rows === 4, `a reload on /friends: straight back to the view, the lists drawn (${J(r)})`);
r = await ev(pg, () => { document.querySelector('#screen-lobby [data-back]').click(); return new Promise(res => setTimeout(() => res(location.pathname), 400)); });
ok(r === '/play', `Back: home, the path follows (${r})`);
await pg.ctx.close();

// ---------- B. no device id: no hello, so no socket snapshot. The REST fetch fills the tile and the view anyway ----------
world = W0(); API.log.length = 0;
pg = await page('nodev', { device: false }); await pg.goto(HOME); await sleep(1500); await pg.click('#btn-start'); await sleep(1500);
r = await ev(pg, () => ({ line: document.getElementById('friends-line-text').textContent, dev: localStorage.getItem('poddle.device') }));
ok(r.line === '3 online' && !r.dev && API.log.some(l => l[0] === 'GET' && l[1] === '/api/friends'), `no device id: GET /api/friends draws the tile ("${r.line}")`);
ok(socks.at(-1).frames.some(f => f.type === 'socialget') && !socks.at(-1).frames.some(f => f.type === 'hello'), 'no hello, so the tab asks for its first snapshot (socialget)');
world.inc.push({ k: 'ann', at: Date.now() }); pushAll({ type: 'social', ...snap() }); await sleep(500);
ok((await toasts(pg)).includes('Ann sent you a friend request'), `no device id: a new request pushed later still toasts (${J(await toasts(pg))})`);
await pg.ctx.close();

// ---------- C. in a court: Settings > Friends, On this court (the registered seats only), Esc order, keys, Back, the outside click ----------
world = W0();
pg = await page('game'); await pg.goto(`http://127.0.0.1:${W}/web/index.html${URLQ}&court=WWWW&watch=1`); await sleep(1500); await pg.click('#btn-start'); await sleep(2500);
r = await ev(pg, () => ({ phase: window.__stats.phase, role: window.__stats.role, screen: document.body.dataset.screen }));
ok(r.phase === 'watch' && r.role === 'spectator' && r.screen === 'hud', `watching Ann vs Rico (${J(r)})`);
await pg.click('#btn-menu'); await sleep(500);
r = await ev(pg, () => ({ grp: !document.getElementById('grp-social').hidden, sub: document.getElementById('set-friends-sub').textContent, badge: document.getElementById('set-friends-n').textContent }));
ok(r.grp && r.sub === '3 online' && r.badge === '1', `Settings has Friends with its badge and "3 online" (${J(r)})`);
await shot(pg, 'settings-desktop');
await pg.click('#btn-set-friends'); await sleep(900);
r = await ev(pg, () => ({ card: !document.getElementById('friends-card').hidden, settings: !document.getElementById('settings').hidden, focus: document.activeElement.id, court: [...document.querySelectorAll('#fc-body .fr-court .fr-row')].map(li => [li.dataset.name, li.querySelector('.fr-acts').textContent.trim()]) }));
ok(r.card && !r.settings && r.focus === 'friends-card', `Friends opens the card in Settings' place, focused on the card (${J(r)})`);
ok(J(r.court) === J([['Ann', 'Add friend']]), `On this court: Ann (registered), not Rico (a guest), no spectators (${J(r.court)})`);
await shot(pg, 'game-desktop');
await pg.setViewport(PHONE); await sleep(500);
r = await ev(pg, () => { const c = document.getElementById('friends-card').getBoundingClientRect(); return { l: c.left, r: c.right, b: c.bottom, w: innerWidth, h: innerHeight }; });
ok(r.l >= 0 && r.r <= r.w && r.b <= r.h, `the card fits the phone (${J(r)})`);
await shot(pg, 'game-phone');
// an ask-to-play card arriving over the friends card, and the card over a paused match: the ask card and its buttons stay on screen at every width; the
// hamburger (the way back to Settings) stays sharp above the blur and the corner's Paused tag hides, as with Settings (the page state is set by hand: the fake game never pauses)
{ const ask = () => ev(pg, () => { const a = document.getElementById('ask-card'), bs = [...a.querySelectorAll('.btn')].map(b => b.getBoundingClientRect()), r = a.getBoundingClientRect(), W = innerWidth, H = innerHeight;
    return { l: Math.round(r.left), r: Math.round(r.right), t: Math.round(r.top), b: Math.round(r.bottom), W, H, btns: bs.length, btnsIn: bs.every(x => x.left >= 0 && x.right <= W && x.top >= 0 && x.bottom <= H) }; });
  await ev(pg, () => { const a = document.getElementById('ask-card'); a.hidden = false; a.classList.add('is-on'); document.body.dataset.paused = '1'; });
  const bad = [];
  for (const [w, h] of [[390, 844], [600, 900], [700, 500], [1024, 768], [1280, 720], [1440, 900]]) { await pg.setViewport({ width: w, height: h }); await sleep(250); const x = await ask(); if (x.l < 0 || x.r > x.W || x.t < 0 || x.b > x.H || !x.btnsIn) bad.push(`${w}x${h} ${J(x)}`); }
  await pg.setViewport(PHONE); await sleep(300); await shot(pg, 'game-ask-phone');
  ok(!bad.length, `the ask card and its buttons stay on screen beside / under the friends card at every width (${bad.join('; ') || 'all in'})`);
  r = await ev(pg, () => ({ corner: getComputedStyle(document.getElementById('corner')).zIndex, glass: getComputedStyle(document.querySelector('.glass')).zIndex, glassOn: getComputedStyle(document.querySelector('.glass')).opacity, tag: getComputedStyle(document.getElementById('paused-tag')).display }));
  ok(+r.corner > +r.glass && r.glassOn === '1' && r.tag === 'none', `paused behind the friends card: the corner (z ${r.corner}) sits above the blur (z ${r.glass}), no Paused tag (${J(r)})`);
  await ev(pg, () => { const a = document.getElementById('ask-card'); a.hidden = true; a.classList.remove('is-on'); delete document.body.dataset.paused; }); }
await pg.setViewport(DESK); await sleep(400);
// keys: the search takes letters (q, c) without leaving; Up / Down walk the card
let f0 = socks.at(-1).frames.length; await pg.click('#fc-body .fr-q'); await pg.keyboard.type('qc'); await sleep(500);
r = await ev(pg, () => ({ v: document.querySelector('#fc-body .fr-q').value, phase: window.__stats.phase }));
ok(r.v === 'qc' && r.phase === 'watch' && !socks.at(-1).frames.slice(f0).some(f => f.type === 'leave'), `typing q c in the card's search: letters, no leave (${J(r)})`);
await pg.keyboard.press('Escape'); await sleep(200); r = await ev(pg, () => ({ v: document.querySelector('#fc-body .fr-q').value, card: !document.getElementById('friends-card').hidden }));
ok(r.v === '' && r.card, `Esc in a typed search clears it, the card stays (${J(r)})`);
await ev(pg, () => document.getElementById('friends-card').focus()); await pg.keyboard.press('ArrowDown'); await pg.keyboard.press('ArrowDown'); await sleep(100);
r = await ev(pg, () => document.activeElement.className);
ok(/fr-q/.test(r), `Up / Down walk the card's controls (Back, then the search: ${r})`);
// a profile card over it: Esc closes the top one only, then the friends card
await rowBtn(pg, '#fc-body .fr-court', 'Ann', 'Ann'); await sleep(900);
r = await ev(pg, () => ({ pc: !document.getElementById('acct-layer').hidden, fc: !document.getElementById('friends-card').hidden, name: document.getElementById('lbp-name').textContent, acts: document.querySelector('#lbp-friend .lbp-fr-acts')?.textContent }));
ok(r.pc && r.fc && r.name === 'Ann' && r.acts === 'Add friend', `the profile card opens over the friends card (${J(r)})`);
await shot(pg, 'game-card-desktop');
await pg.keyboard.press('Escape'); await sleep(300);
r = await ev(pg, () => ({ pc: !document.getElementById('acct-layer').hidden, fc: !document.getElementById('friends-card').hidden }));
ok(!r.pc && r.fc, `Esc: the profile card closes, the friends card stays (${J(r)})`);
await pg.keyboard.press('Escape'); await sleep(300);
r = await ev(pg, () => ({ fc: !document.getElementById('friends-card').hidden, st: !document.getElementById('settings').hidden, phase: window.__stats.phase }));
ok(!r.fc && !r.st && r.phase === 'watch', `Esc again: the friends card closes, nothing else (${J(r)})`);
await pg.click('#btn-menu'); await sleep(300); await pg.click('#btn-set-friends'); await sleep(400); await pg.click('#btn-fc-back'); await sleep(400);
r = await ev(pg, () => ({ fc: !document.getElementById('friends-card').hidden, st: !document.getElementById('settings').hidden }));
ok(!r.fc && r.st, `Back: Settings again (${J(r)})`);
await pg.click('#btn-set-friends'); await sleep(400); await pg.mouse.click(720, 600); await sleep(400);
r = await ev(pg, () => ({ fc: !document.getElementById('friends-card').hidden }));
ok(!r.fc, 'a click on the court closes the card');
await pg.click('#btn-menu'); await sleep(300); await pg.click('#btn-set-friends'); await sleep(600); API.acct = null; await rowBtn(pg, '#fc-body .fr-court', 'Ann', 'Add friend'); await sleep(800);      // the session died (/api/me agrees)
r = await ev(pg, () => ({ t: document.querySelector('#fc-body .fr-gate-t').textContent, btn: !!document.querySelector('#fc-body .fr-gate-b:not([hidden])'), signin: !document.getElementById('acct-layer').hidden, phase: window.__stats.phase }));
ok(r.t === 'Sign in from the menu to add friends' && !r.btn && !r.signin && r.phase === 'watch' && (await toasts(pg)).includes('You’re signed out. Sign in again to add friends'), `a 401 in a court: the toast, then words only (no sign-in card, still watching) (${J(r)})`);
await pg.ctx.close(); API.acct = { username: 'Sam', renameAt: null };

// a player's own seat is never listed; a guest in a court sees words only (no sign-in there: a redial is a forfeit)
pg = await page('seat'); await pg.goto(HOME); await sleep(1500); await pg.click('#btn-start'); await sleep(800); await pg.click('#btn-quick'); await sleep(1500);
await ev(pg, () => { window.__ui.showScreen(null); }); await sleep(400); await ev(pg, () => window.__ui.friendsCard(true)); await sleep(700);
r = await ev(pg, () => [...document.querySelectorAll('#fc-body .fr-court .fr-row')].map(li => li.dataset.name));
ok(J(r) === J(['Ann']), `seated as Sam beside Ann: On this court lists Ann, never me (${J(r)})`);
await pg.ctx.close();
pg = await page('guest', { acct: null }); await pg.goto(`http://127.0.0.1:${W}/web/index.html${URLQ}&court=WWWW&watch=1`); await sleep(1500); await pg.click('#btn-start'); await sleep(2200);
await pg.click('#btn-menu'); await sleep(300); await pg.click('#btn-set-friends'); await sleep(600);
r = await ev(pg, () => ({ t: document.querySelector('#fc-body .fr-gate-t').textContent, btn: !!document.querySelector('#fc-body .fr-gate-b:not([hidden])'), search: !!document.querySelector('#fc-body .fr-search:not([hidden])') }));
ok(r.t === 'Sign in from the menu to add friends' && !r.btn && !r.search, `a guest in a court: "${r.t}", no button, no search (${J(r)})`);
await shot(pg, 'game-guest-desktop');
await pg.ctx.close();

// ---------- D. a session that died since /api/me (401): the gate comes back and its Sign in works. Then an account with no friends yet ----------
API.acct = { username: 'Sam', renameAt: null }; world = W0();
pg = await page('expired'); await pg.goto(`http://127.0.0.1:${W}/friends${URLQ}`); await sleep(2500);
await (await pg.$('#lobby-friends .fr-q')).type('alv'); await sleep(700);
// a 403 that is not about the username (origin), and a 401 while /api/me still knows the session (a busy database): a failed call, never a sign-out
for (const e of [{ status: 403, error: 'origin' }, { status: 401, error: 'signin' }]) { API.fail = e; await rowBtn(pg, '#lobby-friends .fr-results', 'Alvin', 'Add friend'); await sleep(800);
  r = await ev(pg, () => ({ gate: !document.querySelector('#lobby-friends .fr-gate').hidden, line: document.getElementById('friends-line-text').textContent, toast: window.__toasts.at(-1) }));
  ok(!r.gate && r.line !== 'Sign in to add friends' && r.line !== 'Pick a username first' && r.toast === 'Couldn’t do that. Try again.', `a ${e.status} ${e.error} that /api/me does not confirm: still signed in, a plain toast (${J(r)})`); }
API.fail = { status: 401, error: 'signin' }; API.acct = null; await rowBtn(pg, '#lobby-friends .fr-results', 'Alvin', 'Add friend'); await sleep(800);
r = await ev(pg, () => ({ t: document.querySelector('#lobby-friends .fr-gate-t').textContent, b: document.querySelector('#lobby-friends .fr-gate-b').textContent, line: document.getElementById('friends-line-text').textContent }));
ok(r.t === 'Sign in to add friends' && r.b === 'Sign in' && r.line === 'Sign in to add friends', `a 401 that /api/me confirms: the page is a guest's again (${J(r)})`);
await pg.click('#lobby-friends .fr-gate-b'); await sleep(500);
ok(await seenEl(pg, '#signin-card'), 'and its Sign in opens the sign-in card');
await pg.ctx.close();
// a reload on /friends while /api/me is slow: a neutral Loading, never 'Friends aren't available right now', then the lists
API.acct = { username: 'Sam', renameAt: null }; world = W0(); API.meSlow = 1800;
pg = await page('slowme'); await pg.goto(`http://127.0.0.1:${W}/friends${URLQ}`); await sleep(700);
r = await ev(pg, () => ({ t: document.querySelector('#lobby-friends .fr-gate-t')?.textContent, b: !!document.querySelector('#lobby-friends .fr-gate-b:not([hidden])') }));
ok(r.t === 'Loading' && !r.b, `before /api/me answers: "${r.t}", no button (${J(r)})`);
await sleep(2600); API.meSlow = 0;
r = await ev(pg, () => document.querySelectorAll('#lobby-friends .fr-friends .fr-row').length); ok(r === 4, `then the lists (${r} friends)`);
await pg.ctx.close();
world = { friends: new Set(), st: {}, inc: [], out: [] };
pg = await page('empty'); await pg.goto(HOME); await sleep(1500); await pg.click('#btn-start'); await sleep(1200);
r = await ev(pg, () => document.getElementById('friends-line-text').textContent); ok(r === 'Add your first friend', `no friends yet: the tile says "${r}"`);
await pg.click('#btn-friends'); await sleep(900);
r = await ev(pg, () => { const e = document.querySelector('#lobby-friends .fr-empty'); return { shown: !!e && !!e.offsetParent, text: e && e.textContent, sections: [...document.querySelectorAll('#lobby-friends .fr-sec')].filter(x => x.offsetParent).length }; });
ok(r.shown && /^No friends yet/.test(r.text) && r.sections === 1, `no friends yet: the empty state points at the search (${J(r)})`);
await shot(pg, 'empty-desktop'); await pg.setViewport(PHONE); await sleep(300); await shot(pg, 'empty-phone');
await pg.ctx.close(); world = W0();

// ---------- E. the gates in the lobby: a guest (Sign in), an account with no username (Pick a username) ----------
pg = await page('guest-lobby', { acct: null }); await pg.goto(HOME); await sleep(1500); await pg.click('#btn-start'); await sleep(800);
r = await ev(pg, () => ({ line: document.getElementById('friends-line-text').textContent, n: document.querySelector('#lobby-home .tiles').dataset.n }));
ok(r.line === 'Sign in to add friends' && r.n === '6', `a guest's tile: "${r.line}" (${J(r)})`);
await pg.click('#btn-friends'); await sleep(900);
r = await ev(pg, () => ({ t: document.querySelector('#lobby-friends .fr-gate-t').textContent, b: document.querySelector('#lobby-friends .fr-gate-b').textContent, bv: !document.querySelector('#lobby-friends .fr-gate-b').hidden }));
ok(r.t === 'Sign in to add friends' && r.b === 'Sign in' && r.bv, `a guest's view: the gate with Sign in (${J(r)})`);
await shot(pg, 'guest-desktop'); await pg.setViewport(PHONE); await sleep(300); await shot(pg, 'guest-phone');
await pg.click('#lobby-friends .fr-gate-b'); await sleep(500);
ok(await seenEl(pg, '#signin-card'), 'Sign in opens the sign-in card');
await pg.keyboard.press('Escape'); await sleep(300);
// a guest opens a profile card from the leaderboard: only the public board answer is asked, the friend row is a quiet Sign in to add friends
{ const n0 = apiHits('/api/player'); await ev(pg, () => window.__ui.lobbyView('leaderboard')); await sleep(1000);
  await ev(pg, () => [...document.querySelectorAll('#lb-list button.lb-row')].find(b => b.dataset.name === 'Bea').click()); await sleep(900);
  const c = await ev(pg, () => ({ state: document.getElementById('lbp-card').dataset.state, go: document.querySelector('#lbp-friend .lbp-fr-go')?.textContent, btns: document.querySelectorAll('#lbp-friend .btn').length }));
  ok(c.state === 'ok' && c.go === 'Sign in to add friends' && !c.btns && apiHits('/api/player') === n0, `a guest's profile card: the stats, a quiet "Sign in to add friends", no /api/player (${J(c)})`);
  await shot(pg, 'card-guest-desktop'); await pg.setViewport(PHONE); await sleep(300); await shot(pg, 'card-guest-phone'); await pg.setViewport(DESK); await sleep(300);
  await pg.click('#lbp-friend .lbp-fr-go'); await sleep(500);
  ok(await seenEl(pg, '#signin-card') && !(await seenEl(pg, '#lbp-card')), 'and it opens the sign-in card in its place (in the lobby)'); }
await pg.ctx.close();
pg = await page('noname', { acct: { username: null, renameAt: null } }); await pg.goto(`http://127.0.0.1:${W}/friends${URLQ}`); await sleep(2500);
r = await ev(pg, () => ({ t: document.querySelector('#lobby-friends .fr-gate-t').textContent, b: document.querySelector('#lobby-friends .fr-gate-b').textContent }));
ok(r.t === 'Pick a username to add friends' && r.b === 'Pick a username', `no username: "${r.t}" / ${r.b} (${J(r)})`);
await ev(pg, () => window.__ui.lobbyView('leaderboard')); await sleep(1000);
await ev(pg, () => [...document.querySelectorAll('#lb-list button.lb-row')].find(b => b.dataset.name === 'Dan').click()); await sleep(900);
r = await ev(pg, () => document.querySelector('#lbp-friend .lbp-fr-go')?.textContent);
ok(r === 'Pick a username to add friends', `no username: the card's friend row says "${r}"`);
await pg.ctx.close();

clearTimeout(bail); await browser.close(); wss.close(); web.close();
console.log(out.join('\n'));
if (errs.length) console.log('page errors:\n' + errs.join('\n'));
const fails = out.filter(l => l.startsWith('FAIL')).length + errs.length;
console.log(fails ? `SOCIAL UI FAIL (${fails})` : `SOCIAL UI PASS (${out.length} checks)`);
process.exit(fails ? 1 : 0);
