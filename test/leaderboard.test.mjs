// The global leaderboards (NOTES 126), no server, no port: server/db.js leaderboard / leaderPlaces / leaderHide on an in-memory database, and the
// /api/leaderboard routes through api.handle with a fake request. Who is on a board (accounts with a username that did not hide), the minimums, the order,
// ties sharing a number, a player's place equal to their row's rank, hiding and deleting taking the name off at once, and no owner id on the wire.
// Last line: PASS or FAIL n.
import { createRequire } from 'module';
import { Readable } from 'node:stream';
const require = createRequire(import.meta.url);
const db = require('../server/db.js'), api = require('../server/api.js'), U = require('../server/usernames.js');
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const T0 = Date.UTC(2026, 8, 28, 12);
const dev = s => require('node:crypto').createHash('sha256').update(s).digest();

ok(db.open(':memory:'), 'the database opens (in memory)');
const acct = (sub, name) => { const a = db.createAccount(sub, T0); if (name) db.claimUsername(a.id, name, U.skeleton(name), T0); return a; };
const A = acct('s-a', 'Ace'), B = acct('s-b', 'Bree'), C = acct('s-c', 'Cato'), D = acct('s-d', 'Dino'), N = acct('s-n', null);
const G = db.ownerForDevice(dev('guest'), T0, { create: true });
const tro = (o, n) => db.ladderApply({ owner: o, delta: n, won: true, vsBot: false, now: T0 + 1 });
tro(A.owner_id, 960); tro(B.owner_id, 400); tro(C.owner_id, 400); tro(N.owner_id, 999); tro(G, 999);   // D has never played Ranked
const match = (a, b, rallyA, rallyB, t) => db.recordMatch({ now: t, kind: 'human', ending: 'won', winner: 0, score: [11, 4], secs: 90,
  seats: [{ owner: a, record: true, bests: true, bestRally: rallyA }, { owner: b, record: true, bests: true, bestRally: rallyB }] });
match(D.owner_id, A.owner_id, 30, 30, T0 + 10); match(D.owner_id, B.owner_id, 2, 2, T0 + 20); match(C.owner_id, N.owner_id, 12, 40, T0 + 30); match(G, C.owner_id, 50, 9, T0 + 40);

console.log('trophies');
const t = db.leaderboard('trophies');
ok(t && t.rows.map(r => r.name).join(',') === 'Ace,Bree,Cato', `accounts with a username and trophies only, highest first, a tie by name (${t && t.rows.map(r => r.name + ':' + r.v).join(', ')})`);
ok(t.rows.map(r => r.rank).join(',') === '1,2,2' && t.total === 3, `a tie shares its number: ranks ${t.rows.map(r => r.rank)}; total ${t.total}`);
ok(t.rows[0].tier === 7 && t.rows[0].div === 1 && t.rows[1].tier === 3, `each row carries the emblem's tier and division, Pro with none (Ace ${t.rows[0].tier}/${t.rows[0].div})`);
ok(t.rows.every(r => Object.keys(r).join(',') === 'rank,name,v,tier,div'), 'a row is rank, name, value, tier, div: no owner id, no account id');
console.log('rally and streak');
const r = db.leaderboard('rally');
ok(r.rows.map(x => x.name + ':' + x.v).join(',') === 'Ace:30,Dino:30,Cato:12', `rally: the guest's 50 and the unnamed 40 are off, 2 is under the minimum of 3 (${r.rows.map(x => x.name + ':' + x.v)})`);
ok(r.rows[1].tier === null && r.rows[1].rank === 1, 'a player who never played Ranked is listed with no emblem, tied first');
const s = db.leaderboard('streak');
ok(s.rows.map(x => x.name + ':' + x.v).join(',') === 'Dino:2,Cato:1', `streak: Dino won two, Cato one; losers (0) are off (${s.rows.map(x => x.name + ':' + x.v)})`);
ok(db.leaderboard('speed') === null && db.leaderboard('__proto__') === null, 'an unknown board (speed is phone-reported) is null');
console.log('places');
const pa = db.leaderPlaces(A.owner_id), pc = db.leaderPlaces(C.owner_id), pd = db.leaderPlaces(D.owner_id);
ok(pa.listed && pa.trophies.rank === 1 && pa.trophies.v === 960 && pa.rally.rank === 1 && pa.streak === null, `Ace: #1 in trophies and rally, no streak place (${JSON.stringify(pa)})`);
ok(pc.trophies.rank === 2 && pc.rally.rank === 3 && pc.streak.rank === 2, 'Cato: the same numbers as the rows (2, 3, 2)');
ok(pd.trophies === null && pd.rally.rank === 1 && pd.streak.rank === 1, 'Dino: no trophies, no trophy place');
for (const b of ['trophies', 'rally', 'streak']) { const L = db.leaderboard(b); ok(L.rows.every(x => { const o = { Ace: A, Bree: B, Cato: C, Dino: D }[x.name].owner_id, p = db.leaderPlaces(o)[b]; return p && p.rank === x.rank && p.v === x.v; }), `${b}: every row's rank is that player's place`); }
ok(db.leaderPlaces(G).listed === false && db.leaderPlaces(G).why === 'guest' && db.leaderPlaces(N.owner_id).why === 'noname', 'a guest and an account without a username are not listed, and say why');
console.log('hiding');
ok(db.leaderHide(A.owner_id, true) && db.leaderPlaces(A.owner_id).why === 'hidden' && db.leaderPlaces(A.owner_id).hidden, 'Ace hides');
ok(db.leaderboard('trophies').rows.map(x => x.name + '#' + x.rank).join(',') === 'Bree#1,Cato#1' && db.leaderPlaces(B.owner_id).trophies.rank === 1, 'the board and the places close up behind a hidden player');
ok(db.exportOf(A.owner_id, T0).account.globalLeaderboard === 'hidden', 'the export says the switch is off');
db.leaderHide(A.owner_id, false); ok(db.leaderboard('trophies').rows[0].name === 'Ace' && db.exportOf(A.owner_id, T0).account.globalLeaderboard === 'shown', 'and back on');
ok(db.leaderHide(G, true) === false, 'a guest has no switch');

console.log('the API');
function call(method, url, body, cookie) {
  return new Promise(res => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url, headers: { host: 'localhost:8080', origin: 'http://localhost:8080', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: '127.0.0.1' } });
    const out = { status: 0, head: {}, body: '' };
    const r = { headersSent: false, writableEnded: false, on() {}, setHeader() {}, writeHead(st, h) { out.status = st; out.head = h; this.headersSent = true; }, end(b) { out.body = b ? String(b) : ''; this.writableEnded = true; res(out); } };
    api.handle(req, r);
  });
}
api.init({ env: {} });
const g1 = await call('GET', '/api/leaderboard?b=rally'), j1 = JSON.parse(g1.body);
ok(g1.status === 200 && j1.board === 'rally' && j1.rows.length === 3 && j1.total === 3, `GET /api/leaderboard?b=rally -> 200, three rows (${g1.status})`);
ok(!/owner|account|sub|dev/i.test(g1.body.replace(/"board"/, '')), 'the answer names no owner, account, subject or device');
ok((await call('GET', '/api/leaderboard?b=speed')).status === 400 && JSON.parse((await call('GET', '/api/leaderboard')).body).board === 'trophies', 'an unknown board is 400; none is trophies');
const raw = db.session.create(B.id, Date.now()), COOKIE = require('../server/auth.js').cookieNames().session + '=' + raw;
ok((await call('POST', '/api/leaderboard/hide', { hidden: true }, COOKIE)).status === 404, 'the switch answers 404 while sign-in is off (like the other account routes)');
api.init({ env: { GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com' } });
await call('GET', '/api/leaderboard?b=trophies');
const h1 = await call('POST', '/api/leaderboard/hide', { hidden: true }, COOKIE);
ok(h1.status === 200 && JSON.parse(h1.body).hidden === true, `POST /api/leaderboard/hide with the session -> 200 (${h1.status} ${h1.body})`);
ok(!JSON.parse((await call('GET', '/api/leaderboard?b=trophies')).body).rows.some(x => x.name === 'Bree'), 'hiding clears the cache: Bree is gone at once');
ok((await call('POST', '/api/leaderboard/hide', { hidden: 'yes' }, COOKIE)).status === 400 && (await call('POST', '/api/leaderboard/hide', { hidden: true })).status === 401, 'a non-boolean is 400; no session is 401');
const st = JSON.parse((await call('POST', '/api/stats', {}, COOKIE)).body);
ok(st.profile && st.profile.places && st.profile.places.why === 'hidden', '/api/stats carries the places (hidden here)');
db.close();
console.log(fails ? `FAIL ${fails}` : 'PASS');
process.exit(fails ? 1 : 0);
