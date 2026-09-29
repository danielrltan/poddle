// The global leaderboards (NOTES 126), no server, no port: server/db.js leaderboard / leaderPlaces / leaderHide on an in-memory database, and the
// /api/leaderboard routes through api.handle with a fake request. Who is on a board (accounts with a username that did not hide), the minimums, the order,
// ties sharing a number, a player's place equal to their row's rank, hiding and deleting taking the name off at once, and no owner id on the wire.
// The leaderboard profile (NOTES 140): GET /api/leaderboard/player?u=<name> answers the share card's subset for a player on any board at any place (NOTES 141; the top 100 only before),
// and the same 404 for everyone else; hide, rename and delete clear it at once; its own rate-limit bucket; 503 with the database closed.
// Last line: PASS or FAIL n.
import { createRequire } from 'module';
import { Readable } from 'node:stream';
const require = createRequire(import.meta.url);
process.env.RENAME_DAYS = '0';                                    // db.js reads it at open: Cato renames the day he claimed his name (NOTES 140 section)
const db = require('../server/db.js'), api = require('../server/api.js'), U = require('../server/usernames.js');
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const T0 = Date.UTC(2026, 8, 28, 12);
const dev = s => require('node:crypto').createHash('sha256').update(s).digest();

ok(db.open(':memory:'), 'the database opens (in memory)');
const acct = (sub, name) => { const a = db.createAccount(sub, T0); if (name) db.claimUsername(a.id, name, U.skeleton(name), T0); return a; };
const A = acct('s-a', 'Ace'), B = acct('s-b', 'Bree'), C = acct('s-c', 'Cato'), D = acct('s-d', 'Dino'), N = acct('s-n', null);
const G = db.ownerForDevice(dev('guest'), T0, { create: true });
const tro = (o, n) => db.ladderApply({ owner: o, delta: n, won: true, vsBot: false, now: T0 + 1 });
tro(A.owner_id, 1100); tro(B.owner_id, 400); tro(C.owner_id, 400); tro(N.owner_id, 1199); tro(G, 1199);   // D has never played Ranked; Ace is Pro (1050+ since Master, NOTES 124)
const match = (a, b, rallyA, rallyB, t) => db.recordMatch({ now: t, kind: 'human', ending: 'won', winner: 0, score: [11, 4], secs: 90,
  seats: [{ owner: a, record: true, bests: true, bestRally: rallyA }, { owner: b, record: true, bests: true, bestRally: rallyB }] });
match(D.owner_id, A.owner_id, 30, 30, T0 + 10); match(D.owner_id, B.owner_id, 2, 2, T0 + 20); match(C.owner_id, N.owner_id, 12, 40, T0 + 30); match(G, C.owner_id, 50, 9, T0 + 40);

console.log('trophies');
const t = db.leaderboard('trophies');
ok(t && t.rows.map(r => r.name).join(',') === 'Ace,Bree,Cato', `accounts with a username and trophies only, highest first, a tie by name (${t && t.rows.map(r => r.name + ':' + r.v).join(', ')})`);
ok(t.rows.map(r => r.rank).join(',') === '1,2,2' && t.total === 3, `a tie shares its number: ranks ${t.rows.map(r => r.rank)}; total ${t.total}`);
ok(t.rows[0].tier === 8 && t.rows[0].div === 1 && t.rows[1].tier === 3, `each row carries the emblem's tier and division, Pro with none (Ace ${t.rows[0].tier}/${t.rows[0].div})`);
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
ok(pa.listed && pa.trophies.rank === 1 && pa.trophies.v === 1100 && pa.rally.rank === 1 && pa.streak === null, `Ace: #1 in trophies and rally, no streak place (${JSON.stringify(pa)})`);
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

// ---------- the leaderboard profile (NOTES 140). Bree is hidden, sign-in is on ----------
console.log('the profile card');
const share = require('../server/share.js'), ENV = { GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com', RENAME_DAYS: '0' }, reinit = () => api.init({ env: ENV });   // init clears both caches and the limiter
const cookieOf = a => require('../server/auth.js').cookieNames().session + '=' + db.session.create(a.id, Date.now());
const pl = async u => { const r = await call('GET', '/api/leaderboard/player' + (u === undefined ? '' : '?u=' + encodeURIComponent(u))); return { ...r, j: r.body ? JSON.parse(r.body) : null }; };
const J = JSON.stringify, LABELS = 'Win rate vs people,Time on court,Best win streak vs people,Return rate,Points won,Longest rally,Fastest swing,Winners,Aces,Smashes,Tournament titles';
reinit();
let p = await pl('Ace');
ok(p.status === 200 && Object.keys(p.j).join(',') === 'name,rank,trophies,matt,stats', `Ace -> 200, exactly name, rank, trophies, matt, stats (${p.status} ${p.body})`);
ok(p.j.name === 'Ace' && p.j.rank.tier === 8 && p.j.rank.label === 'Pro #1' && p.j.rank.pro === 1 && p.j.trophies === 1100, `Ace is Pro #1 with 1100 trophies (${J(p.j.rank)} ${p.j.trophies})`);
ok(p.j.stats.map(s => s.label).join(',') === LABELS && J(p.j.stats[5]) === J({ label: 'Longest rally', tag: 'Rally', value: '30', unit: 'hits' }), `the eleven card stats in card order; rally 30 hits (${J(p.j.stats[5])})`);
ok(J(p.j.stats[0]) === J({ label: 'Win rate vs people', tag: 'Win rate', value: '0%', note: '0-1 vs people', hero: true }) && p.j.stats.map(s => !!s.hero).join() === 'true,true,true,false,false,false,false,false,false,false,false' && p.j.stats[1].note === 'all modes' && p.j.stats[2].note === 'wins vs people',
  `the three headline figures first, each with its note: Ace lost to Dino, 0% (0-1 vs people) (${J(p.j.stats.slice(0, 3))})`);
{ const d = share.dataOf(A.owner_id);
  ok(J(p.j.stats.map(s => s.value)) === J(d.big.map(b => b.value)) && p.j.rank.label === d.rank && p.j.matt === d.matt, `the same values as Ace's share card (${p.j.stats.map(s => s.value)})`); }
ok(!/owner|account|"sub"|google|device|"dev"|since|played|expires|slug|guest|"id"|mattI|"bar"|"em"|"v"/i.test(p.body), 'no owner, account, device, date, slug or card internals in the answer');
ok(p.head['Cache-Control'] === 'no-store' && p.head['X-Robots-Tag'] === 'noindex', 'no-store and noindex, like every /api answer');
p = await pl('Dino');
ok(p.status === 200 && p.j.rank === null && p.j.trophies === 0 && p.j.matt === null && p.j.stats.length === 11 && p.j.stats[0].value === '100%' && p.j.stats[0].note === '2-0 vs people', `Dino never played Ranked: rank null, 0 trophies, no Matt, still the eleven stats (2-0 vs people: 100%) (${p.body})`);
p = await pl('ACE'); ok(p.status === 200 && p.j.name === 'Ace', `u=ACE -> Ace (${p.status} ${p.j && p.j.name})`);
ok(U.skeleton('D1no') === U.skeleton('Dino'), 'D1no folds to the same key as Dino');
p = await pl('D1no'); ok(p.status === 200 && p.j.name === 'Dino', `u=D1no -> the canonical name Dino (${p.j && p.j.name})`);
{ const miss = [['hidden Bree', 'Bree'], ['unknown', 'Nobody1'], ['no u', undefined], ['empty u', ''], ['40 chars', 'a'.repeat(40)], ['<script>', '<script>'], ['%00', '\u0000'], ['a guest\'s typed name', 'Guesty'], ['spaces', '   ']];
  const got = []; for (const [what, u] of miss) { const r = await pl(u); got.push(r.status === 404 && r.body === '{"error":"not_found"}' ? '' : `${what}: ${r.status} ${r.body}`); }
  ok(got.every(g => !g), `hidden, unknown, missing, empty, too long, <script>, %00, a guest's name, spaces: the same 404 {"error":"not_found"} (${got.filter(Boolean).join('; ')})`); }
ok((await call('POST', '/api/leaderboard/player?u=Ace', {})).status === 405, 'POST -> 405');

console.log('the profile card: hide, rename, delete');
reinit();
const CA = cookieOf(A);
ok((await pl('Ace')).status === 200, 'Ace: 200, cached now');
ok((await call('POST', '/api/leaderboard/hide', { hidden: true }, CA)).status === 200 && (await pl('Ace')).status === 404, 'Ace hides: 404 at once, not after the cache');
ok((await call('POST', '/api/leaderboard/hide', { hidden: false }, CA)).status === 200 && (await pl('Ace')).status === 200, 'Ace shows again: 200 at once');
ok((await pl('Cato')).status === 200, 'Cato: 200, cached');
{ const r = await call('POST', '/api/username', { username: 'Cyan' }, cookieOf(C));
  ok(r.status === 200, `Cato renames to Cyan (${r.status} ${r.body})`);
  const a = await pl('Cato'), b = await pl('Cyan'), L = JSON.parse((await call('GET', '/api/leaderboard?b=trophies')).body);
  ok(a.status === 404 && a.body === '{"error":"not_found"}' && b.status === 200 && b.j.name === 'Cyan', `the old name 404s at once, the new one answers (${a.status}, ${b.status} ${b.j && b.j.name})`);
  ok(!L.rows.some(x => x.name === 'Cato') && L.rows.some(x => x.name === 'Cyan'), 'the board shows Cyan, not Cato'); }
ok((await pl('Dino')).status === 200, 'Dino: 200, cached');
{ const r = await call('DELETE', '/api/account', { confirm: 'delete' }, cookieOf(D)); ok(r.status === 200 && (await pl('Dino')).status === 404, `Dino deletes his account: 404 at once (${r.status})`); }

console.log('the profile card: the cache');
reinit();
ok((await pl('Ace')).status === 200, 'Ace: 200, cached');
db.leaderHide(A.owner_id, true);                                  // admin.js's kind of change: another process, no cache clear here
ok((await pl('Ace')).status === 200, 'a hide the route did not see answers from the cache inside the 30 s TTL (why every self-service route clears it)');
db.leaderHide(A.owner_id, false); reinit();

console.log('the profile card: db.leaderOwnerByKey');
{ const a = db.leaderOwnerByKey(U.skeleton('Ace'));
  ok(a && a.owner === A.owner_id && a.name === 'Ace' && a.ranked === true, `Ace -> { owner, name: Ace, ranked: true } (${J(a)})`);
  ok(db.leaderOwnerByKey(U.skeleton('Bree')) === null && db.leaderOwnerByKey('nobody') === null && db.leaderOwnerByKey('') === null && db.leaderOwnerByKey(null) === null && db.leaderOwnerByKey('x'.repeat(65)) === null, 'hidden, unknown, empty, null and too long -> null'); }

console.log('the profile card: every listed player, at any place (NOTES 141)');
{ const mkNamed = (name, trophies) => { const a = db.createAccount('s-' + name, T0); if (db.claimUsername(a.id, name, U.skeleton(name), T0) !== 'ok') return null; if (trophies) tro(a.owner_id, trophies); return a; };
  const ABC = 'bcdfghjkmnpqrstwxyz', fill = [];
  for (let i = 0; i < ABC.length && fill.length < 98; i++) for (let k = 0; k < ABC.length && fill.length < 98; k++) { const a = mkNamed('Fx' + ABC[i] + ABC[k], 1000 - fill.length); if (a) fill.push(a); }   // 1000 .. 903: not Pro (1050), above Bree and Cyan
  const ties = ['Tyeb', 'Tyem'].map(n => ({ n, a: mkNamed(n, 800), k: U.skeleton(n) })).sort((x, y) => (x.k < y.k ? -1 : 1)), low = mkNamed('Lowly', 5);   // Ace + 98 + the tie: the tie is rows 100 and 101, both ranked 100
  ok(fill.length === 98 && ties.every(t => t.a) && low, `98 fillers, a tie at 800 and Lowly made (${fill.length})`);
  const L = db.leaderboard('trophies'), inside = L.rows.map(r => r.name), lp = db.leaderPlaces(low.owner_id);
  ok(L.rows.length === 100 && inside.includes(ties[0].n) && !inside.includes(ties[1].n), `the board's LIMIT keeps the tie's smaller key (${ties[0].n}) and not ${ties[1].n}`);
  const a = await pl(ties[0].n), b = await pl(ties[1].n), c = await pl('Lowly'), cy = await pl('Cyan');
  ok(a.status === 200 && L.rows.find(r => r.name === ties[0].n).rank === 100, `${ties[0].n}, place 100 inside the LIMIT: 200 (${a.status})`);
  ok(b.status === 200, `${ties[1].n}, place 100 but outside the LIMIT: 200 all the same (${b.status})`);
  ok(c.status === 200 && lp && lp.listed === true && lp.trophies && lp.trophies.rank > 100, `Lowly is listed at place ${lp && lp.trophies && lp.trophies.rank}, outside every top 100: 200 (${c.status})`);
  ok(cy.status === 200, `Cyan is outside the trophies top 100 but on the rally board: 200 (${cy.status})`);
  ok((await pl('Ace')).status === 200, 'Ace: still 200'); }

console.log('the profile card: rate limit');
reinit();
{ let r = null, n = 0; for (; n < 61; n++) { r = await pl('Ace'); if (r.status === 429) break; }
  ok(r.status === 429 && n === 60 && Number(r.head['Retry-After']) > 0 && r.j.retryAfter > 0, `the 61st call a minute is 429 with Retry-After (${r.status} after ${n}, ${r.head['Retry-After']})`);
  ok((await call('GET', '/api/leaderboard?b=rally')).status === 200, 'the board list has its own bucket: still 200'); }

console.log('the profile card: database closed');
reinit(); db.close();
ok(db.leaderOwnerByKey(U.skeleton('Ace')) === undefined, 'closed: leaderOwnerByKey is undefined, not null (the route tells a failure from nobody)');
{ const r = await pl('Ace'); ok(r.status === 503 && r.j.error === 'db_unavailable', `closed: 503 db_unavailable (${r.status} ${r.body})`); }
console.log(fails ? `FAIL ${fails}` : 'PASS');
process.exit(fails ? 1 : 0);
