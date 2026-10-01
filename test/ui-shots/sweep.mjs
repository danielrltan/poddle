// Spacing sweep screenshots (NOTES 134): the real index.html (?acctest=1) against a fake game socket and a fake /api, every lobby view
// and the leaderboard's You card in each state, the leaderboard profile sheet (NOTES 140: lbp-*, a hovered and a focused row: lb-hover-*, lb-focus-*),
// plus the static pages. Usage: node test/ui-shots/sweep.mjs [out-dir] [filter]
// SWEEP_PORT=<base> moves the ports (default 9460: pages + /api, 9461: fake game, 9462: nothing = no AirPod). SWEEP_SIZES=1440x900,...
import http from 'http'; import fs from 'fs'; import path from 'path';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
const P0 = +process.env.SWEEP_PORT || 9460, W = P0, G = P0 + 1, DEAD = P0 + 2, root = new URL('../..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
const OUT = path.resolve(process.argv[2] || path.join(root, 'test/ui-shots/sweep')), FILTER = process.argv[3] || '';
fs.mkdirSync(OUT, { recursive: true });
const J = o => JSON.stringify(o);
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.json': 'application/json', '.wasm': 'application/wasm', '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml' };

// ---------- the fake /api: STATE picks the account and the places ----------
const day = Date.UTC(2026, 8, 20), rung = (level, name, wins, losses, streak, bestStreak, firstWinAt) => ({ level, name, wins, losses, abandons: 0, streak, bestStreak, firstWinAt, bestMargin: 0 });
const PROFILE = { guest: false, since: day - 864e5, expiresAt: day + 90 * 864e5, played: 9,
  human: { wins: 3, losses: 2, streak: 1, bestStreak: 2, pointsWon: 50, pointsLost: 41 }, titles: 1,
  matt: [rung(0, 'Rookie', 3, 0, 3, 3, day), rung(1, 'Club', 1, 1, 0, 1, day + 3600e3), rung(3, 'Tour', 0, 2, 0, 0, null), rung(2, 'Pro', 0, 0, 0, 0, null)],
  bests: { rally: { v: 14, at: day }, hit: { v: 22, at: day }, speed: { v: 9.4, at: day } },
  play: { hits: 412, returns: 187, chances: 256, winners: 38, aces: 9, smashes: 21, pointsWon: 214, pointsLost: 173, secs: 4980 },
  ladder: { trophies: 240, tier: 2, div: 2, floor: 150, next: 250, bestTrophies: 240, bestTier: 2, bestDiv: 2, bestTierAt: day, wins: 3, losses: 1, streak: 1, botWins: 9, botLosses: 4, mattDayLeft: 32 },
  share: null };
const NAMES = ['Dan', 'Kiko', 'Rallyqueen', 'Paddlebot', 'Mo', 'Ace_Vega', 'Lobster', 'Zed', 'Pickle_Rick', 'Nova', 'Dinkmaster', 'Juno'];
const ROWS = NAMES.map((name, i) => ({ rank: i + 1, name, v: 60 - i * 4, tier: i < 8 ? 8 - (i >> 1) : undefined, div: 1 + (i % 3) }));
const STATES = {      // the You card's states (web/profile.js drawYou)
  guest: { acct: null, places: null },
  nouser: { acct: { username: null }, places: null },
  hidden: { acct: { username: 'Sam' }, places: { listed: false, hidden: true } },
  none: { acct: { username: 'Sam' }, places: { listed: true, hidden: false } },
  outside: { acct: { username: 'Sam' }, places: { listed: true, hidden: false, rally: { rank: 1234, v: 9 }, trophies: { rank: 301, v: 240 }, streak: { rank: 88, v: 2 } } },
  listed: { acct: { username: 'Kiko' }, places: { listed: true, hidden: false, rally: { rank: 2, v: 56 }, trophies: { rank: 2, v: 240 }, streak: { rank: 2, v: 5 } } },
};
let STATE = STATES.guest;
// the leaderboard profile (NOTES 140): GET /api/leaderboard/player?u=<name> as server/api.js publicCard answers it. status: 404 / 500; delay: ms before the answer
const LABELS = [['Win rate vs people', 'Win rate'], ['Time on court', 'On court'], ['Best win streak vs people', 'Best streak'], ['Return rate', 'Returns'], ['Points won', 'Points won'], ['Longest rally', 'Rally', 'hits'], ['Fastest swing', 'Swing', '°/s'], ['Winners', 'Winners'], ['Aces', 'Aces'], ['Smashes', 'Smashes'], ['Tournament titles', 'Titles']];
// eleven(winRate, record, time, streak, returns, points, rally, swing, winners, aces, smashes, titles): server/api.js publicCard's stats, the share card's eleven (NOTES 145)
const eleven = (wr, rec, ...v) => LABELS.map(([label, tag, unit], i) => ({ label, tag, value: i ? v[i - 1] : wr, ...(unit ? { unit } : {}),
  ...(i === 0 ? { note: rec + ' vs people', hero: true } : i === 1 ? { note: 'all modes', hero: true } : i === 2 ? { note: v[1] === '1' ? 'win vs people' : 'wins vs people', hero: true } : {}) }));
const PLAYERS = {
  Dan: { body: { name: 'Dan', rank: { tier: 8, div: 1, label: 'Pro #1', pro: 1 }, trophies: 1180, matt: 'Pro', stats: eleven('81%', '42-7', '31h 12m', '12', '86%', '58%', '60', '1570', '318', '41', '97', '4') } },
  Kiko: { body: { name: 'Kiko', rank: { tier: 7, div: 2, label: 'Champion II', pro: null }, trophies: 964, matt: 'Tour', stats: eleven('67%', '18-9', '9h 40m', '5', '73%', '54%', '56', '1340', '140', '12', '33', '1') } },
  Rallyqueen: { body: { name: 'Rallyqueen', rank: { tier: 7, div: 1, label: 'Champion I', pro: null }, trophies: 912, matt: 'Club', stats: eleven('65%', '11-6', '6h 18m', '4', '68%', '53%', '52', '1210', '97', '15', '21', '2') } },
  Pickle_Rick: { body: { name: 'Pickle_Rick', rank: null, trophies: 0, matt: 'Rookie', stats: eleven('78%', '4,321-1,234', '277h 46m', '1,234', '89%', '53%', '444', '2570', '88,888', '88,888', '88,888', '1,234') } },
  Juno: { body: { name: 'Juno', rank: null, trophies: 0, matt: null, stats: eleven('-', '0-0', '0m', '0', '-', '-', '0', '-', '0', '0', '0', '0') } },
  Mo: { status: 404 }, Zed: { status: 500 }, Lobster: { delay: 5000, body: { name: 'Lobster', rank: { tier: 5, div: 1, label: 'Diamond I', pro: null }, trophies: 610, matt: 'Club', stats: eleven('50%', '7-7', '4h 2m', '3', '64%', '51%', '36', '1100', '60', '9', '14', '0') } },
};
const apiAnswer = (q, body, r) => { const u = q.url.split('?')[0], send = (s, o) => { r.writeHead(s, { 'content-type': 'application/json' }); r.end(o === undefined ? '' : J(o)); };
  if (u === '/api/me') return send(200, { db: true, signin: { enabled: true, clientId: 'test-client.apps.googleusercontent.com' }, account: STATE.acct });
  if (u === '/api/stats') return send(200, { profile: { ...PROFILE, places: STATE.places } });
  if (u === '/api/leaderboard') return send(200, { rows: ROWS });
  if (u === '/api/leaderboard/player') { const P = PLAYERS[new URL(q.url, 'http://x').searchParams.get('u')] || { status: 404 };
    return setTimeout(() => (P.status ? send(P.status, { error: P.status === 404 ? 'not_found' : 'internal' }) : send(200, P.body)), P.delay || 60); }
  if (u === '/api/signin/nonce') return send(200, { nonce: 'n'.repeat(32) });
  return send(404, { error: 'nope' }); };
const web = http.createServer((q, r) => {
  if (q.url.startsWith('/api/')) { let body = ''; q.on('data', c => { body += c; }); q.on('end', () => apiAnswer(q, body, r)); return; }
  let f = path.join(root, decodeURIComponent(q.url.split('?')[0])); if (!f.startsWith(root)) { r.writeHead(403); return r.end(); } if (f.endsWith('/')) f += 'index.html';
  const serve = (g, next) => fs.readFile(g, (e, d) => { if (e && next) return next(); r.writeHead(e ? 404 : 200, { 'content-type': MIME[path.extname(g)] || 'application/octet-stream' }); r.end(e ? '' : d); });
  serve(f, () => serve(path.join(root, 'web', decodeURIComponent(q.url.split('?')[0])), null)); }).listen(W, '127.0.0.1');

// ---------- the fake game: a lobby list with two courts ----------
const LIST = { type: 'lobby', online: 5, rooms: [{ code: 'KXQ8', names: ['Kiko', null], state: 'waiting', public: true }, { code: 'PLM4', names: ['Mo', 'Zed'], score: [5, 3], state: 'playing', public: true }] };
const wss = new WebSocketServer({ port: G, host: '127.0.0.1' });
wss.on('connection', ws => { ws.send(J(LIST)); ws.on('message', raw => { let m; try { m = JSON.parse(raw); } catch { return; } if (m.type === 'ping') ws.send(J({ type: 'pong', c: m.c })); }); });

const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--hide-scrollbars', '--use-gl=angle', '--enable-unsafe-swiftshader', '--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream'] });
const SIZES = (process.env.SWEEP_SIZES || '1440x900,1280x720,390x844').split(',').map(s => s.split('x').map(Number));
const URL0 = `http://127.0.0.1:${W}/web/index.html?uitest=1&acctest=1&cam=0&game=${G}&bridge=${DEAD}`;
const report = [];
async function open(w, h) { const pg = await browser.newPage(); await pg.setViewport({ width: w, height: h, deviceScaleFactor: +process.env.SWEEP_DPR || 1 }); await pg.setRequestInterception(true);
  pg.on('request', q => (/google\.com|gstatic\.com/.test(q.url()) ? q.abort() : q.continue()));
  pg.on('pageerror', e => report.push(`PAGEERROR ${e.message}`)); return pg; }
// data-fit panels that leave the window, and any element wider than the page (horizontal scroll)
const fit = pg => pg.evaluate(() => { const bad = [...document.querySelectorAll('[data-fit]')].filter(e => { if (e.closest('[hidden]')) return false; const b = e.getBoundingClientRect(); return b.width && (b.left < -.5 || b.top < -.5 || b.right > innerWidth + .5 || b.bottom > innerHeight + .5); }).map(e => e.id || e.className);
  if (document.documentElement.scrollWidth > innerWidth + 1) bad.push('page scrolls sideways'); return bad; });
const want = n => !FILTER || n.includes(FILTER);
async function lobby(pg, view) { await pg.goto(URL0, { waitUntil: 'domcontentloaded' }); await sleep(2200); await pg.click('#btn-start').catch(() => {}); await sleep(900);
  await pg.evaluate(v => window.__ui.lobbyView(v), view); await sleep(1300); }
const VIEWS = ['home', 'courts', 'create', 'bot', 'profile', 'ranks', 'leaderboard'];
try {
  for (const [w, h] of SIZES) {
    const tag = `${w}x${h}`;
    // the title screen
    if (want('title')) { STATE = STATES.guest; const pg = await open(w, h); await pg.goto(URL0, { waitUntil: 'domcontentloaded' }); await sleep(2200); await pg.screenshot({ path: `${OUT}/title-${tag}.png` }); report.push(`title ${tag} ${J(await fit(pg))}`); await pg.close(); }
    // every lobby view, signed in with a username
    for (const v of VIEWS) { const n = `view-${v}-${tag}`; if (!want(n)) continue; STATE = STATES.listed; const pg = await open(w, h); await lobby(pg, v); await pg.screenshot({ path: `${OUT}/${n}.png` }); report.push(`${n} ${J(await fit(pg))}`); await pg.close(); }
    // the leaderboard You card in each state
    for (const s of Object.keys(STATES)) { const n = `lb-${s}-${tag}`; if (!want(n)) continue; STATE = STATES[s]; const pg = await open(w, h); await lobby(pg, 'leaderboard');
      const you = await pg.$('#lb-you'); if (you && await pg.evaluate(e => !e.hidden, you)) await you.screenshot({ path: `${OUT}/${n}-card.png` }); const top = await pg.$('.lb-row.is-top1'); if (top) await top.screenshot({ path: `${OUT}/${n}-top.png` });
      await pg.screenshot({ path: `${OUT}/${n}.png` }); report.push(`${n} ${J(await fit(pg))}`); await pg.close(); }
    // the leaderboard profile sheet (NOTES 140): a row clicked, the sheet shot. Lobster answers in 5 s: its loading face
    for (const [who, s, wait] of [['Dan', 'listed', 700], ['Kiko', 'listed', 700], ['Juno', 'listed', 700], ['Pickle_Rick', 'guest', 700], ['Mo', 'listed', 700], ['Zed', 'listed', 700], ['Lobster', 'listed', 400]]) {
      const n = `lbp-${who.toLowerCase()}-${tag}`; if (!want(n)) continue; STATE = STATES[s]; const pg = await open(w, h); await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('poddle.lbSeen', '2'); } catch {} }); await lobby(pg, 'leaderboard'); await sleep(600);      // no leaderboard notice toast over the sheet
      await pg.evaluate(x => [...document.querySelectorAll('button.lb-row')].find(b => b.dataset.name === x)?.click(), who); await sleep(wait);
      await pg.screenshot({ path: `${OUT}/${n}.png` }); report.push(`${n} ${J(await fit(pg))}`); await pg.close(); }
    for (const how of ['hover', 'focus']) { const n = `lb-${how}-${tag}`; if (!want(n)) continue; STATE = STATES.listed; const pg = await open(w, h); await pg.evaluateOnNewDocument(() => { try { localStorage.setItem('poddle.lbSeen', '2'); } catch {} }); await lobby(pg, 'leaderboard'); await sleep(600);
      if (how === 'hover') await pg.hover('button.lb-row.is-top2'); else { await pg.focus('button.lb-row.is-top2'); await pg.keyboard.press('Tab'); await pg.keyboard.down('Shift'); await pg.keyboard.press('Tab'); await pg.keyboard.up('Shift'); }      // Tab, Shift+Tab: a keyboard focus, so :focus-visible shows
      await sleep(400); await pg.screenshot({ path: `${OUT}/${n}.png` }); report.push(`${n} ${J(await fit(pg))}`); await pg.close(); }
    // settings sheet from the lobby
    if (want(`settings-${tag}`)) { STATE = STATES.listed; const pg = await open(w, h); await lobby(pg, 'home'); await pg.evaluate(() => window.__ui.settings?.(true)); await sleep(700); await pg.screenshot({ path: `${OUT}/settings-${tag}.png` }); report.push(`settings ${tag} ${J(await fit(pg))}`); await pg.close(); }
    // static pages, full length
    for (const p of ['how-to-play', 'changelog', 'privacy', 'terms', '404', 'pad']) { const n = `page-${p}-${tag}`; if (!want(n)) continue; const pg = await open(w, h); await pg.goto(`http://127.0.0.1:${W}/web/${p}.html`, { waitUntil: 'domcontentloaded' }); await sleep(900);
      await pg.screenshot({ path: `${OUT}/${n}.png`, fullPage: true }); report.push(`${n} ${J(await fit(pg))}`); await pg.close(); }
  }
} finally { console.log(report.join('\n')); await browser.close(); web.close(); wss.close(); }
