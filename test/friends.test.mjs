// Friends (docs/SOCIAL.md 2, 3, 8), no server, no port: server/db.js friendOp / friendsOf / friendSearch / playerByKey on an in-memory database, and the
// /api/friends, /api/friends/search and /api/player routes through api.handle with a fake request (the test/leaderboard.test.mjs pattern). The rules of 3
// (a silent decline, a removal's 30-day block, accept by adding back, expiry, the caps), the sweep, the export, the cascade, the search escaping and the
// confusable match, the profile card's (/api/player) lb_hidden rule, the per-account limits, the social hook's push lists, and no id on the wire. Last line: PASS or FAIL n.
import { createRequire } from 'module';
import { Readable } from 'node:stream';
const require = createRequire(import.meta.url);
process.env.FRIEND_MAX = '4'; process.env.REQ_OUT_MAX = '3';     // read by db.open (the caps are test knobs like the rest)
const db = require('../server/db.js'), api = require('../server/api.js'), U = require('../server/usernames.js'), auth = require('../server/auth.js');
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const DAY = 86400e3, T0 = Date.now() - 40 * DAY;                  // the API reads the real clock: the database's own clock sits in the past so both agree on expiry
const quietAsync = async f => { const e = console.error; console.error = () => {}; try { return await f(); } finally { console.error = e; } };

console.log('schema');
{ const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'poddle-fr-')), f = path.join(dir, 'f.db');
  ok(db.open(f), 'a file database opens'); db.close(); db.open(f); db.close();   // twice: EXTRA is idempotent
  const { DatabaseSync } = require('node:sqlite'), R = new DatabaseSync(f);
  const idx = t => R.prepare(`PRAGMA index_list(${t})`).all().map(i => R.prepare(`PRAGMA index_info(${i.name})`).all()[0].name);
  const fk = t => R.prepare(`PRAGMA foreign_key_list(${t})`).all().map(k => k.from + '->' + k.table + ':' + k.on_delete).sort().join(' ');
  ok(idx('friends').includes('a') && idx('friends').includes('b') && idx('friend_reqs').includes('from_id') && idx('friend_reqs').includes('to_id'), `both FK columns of both tables are indexed (${idx('friends')} / ${idx('friend_reqs')})`);
  ok(fk('friends') === 'a->accounts:CASCADE b->accounts:CASCADE' && fk('friend_reqs') === 'from_id->accounts:CASCADE to_id->accounts:CASCADE', `ON DELETE CASCADE to accounts (${fk('friends')} / ${fk('friend_reqs')})`);
  R.close(); fs.rmSync(dir, { recursive: true, force: true }); }
ok(db.open(':memory:'), 'the database opens (in memory)');
const acct = (sub, name) => { const a = db.createAccount(sub, T0); if (name) db.claimUsername(a.id, name, U.skeleton(name), T0); return a; };
const [A, B, C, D, E, F] = ['Ace', 'Bree', 'Cato', 'Dino', 'Esme', 'Finn'].map((n, i) => acct('s-' + i, n)), N = acct('s-n', null);
const op = (x, y, o, t = T0 + 1000) => db.friendOp(x.id, y.id, o, t);
const snap = (x, t = T0 + 1000) => db.friendsOf(x.id, t);
const names = l => l.map(r => r.name).sort().join(',');

{ const c = db.counts(); ok(c && c.friends === 0 && c.friend_reqs === 0, 'counts() lists friends and friend_reqs (admin.js counts)'); }

console.log('requests and accepting');
let r = op(A, B, 'add');
ok(r && r.r === 'requested' && r.rel === 'out' && r.other === true, `add -> requested, rel out, the other side is told (${JSON.stringify(r)})`);
ok(names(snap(B).inc) === 'Ace' && names(snap(A).out) === 'Bree' && snap(A).out[0].at === T0 + 1000, "Bree sees Ace's request, Ace sees it out (with its time)");
ok(db.friendRel(B.id, A.id, T0 + 1000) === 'in', "Bree's rel to Ace is in");
r = op(A, B, 'add'); ok(r.r === 'requested' && r.other === false, 'adding again: requested, nothing new reaches Bree');
r = op(B, A, 'add'); ok(r.r === 'friends' && r.rel === 'friend' && r.other, 'Bree adds Ace back: that accepts, friends');
ok(names(snap(A).friends) === 'Bree' && names(snap(B).friends) === 'Ace' && !snap(A).out.length && !snap(B).inc.length && db.counts().friend_reqs === 0, 'both list each other; no request row is left');
ok(op(A, B, 'add').r === 'friends' && op(A, B, 'accept').err === 'norequest', 'adding a friend is a no-op; accept with nothing incoming is norequest');
r = op(C, A, 'add'); ok(r.r === 'requested', 'Cato asks Ace'); r = op(A, C, 'accept'); ok(r.r === 'friends' && r.other, 'Ace accepts');
ok(op(A, A, 'add').err === 'self' && op(N, A, 'add').err === 'username' && db.friendOp(A.id, 999999, 'add', T0).err === 'notfound' && op(A, N, 'add').err === 'notfound', 'self, no username of my own, no such account, a target without a username');
ok(db.friendOp(A.id, B.id, 'poke', T0) === null, 'an unknown op is null');

console.log('decline is silent');
op(D, E, 'add'); r = op(E, D, 'decline');
ok(r.r === 'declined' && r.other === false, 'Esme declines Dino: declined, and Dino is NOT pushed anything');
ok(!snap(E).inc.length && names(snap(D).out) === 'Esme', "Esme's list loses it; Dino still sees it pending");
ok(db.friendRel(D.id, E.id, T0 + 1000) === 'out' && db.friendRel(E.id, D.id, T0 + 1000) === 'none', 'rel: Dino out, Esme none');
r = op(D, E, 'add'); ok(r.r === 'requested' && r.other === false && !snap(E).inc.length, 'Dino adds again: requested, nothing reaches Esme');
ok(op(E, D, 'decline').err === 'norequest' && op(E, D, 'accept').err === 'norequest', 'a declined request cannot be accepted or declined again');
const exE = () => JSON.stringify(db.exportOf(E.owner_id, T0 + 2000).friendRequests), exE0 = exE();
ok(JSON.parse(exE0).received.some(x => x.username === 'Dino' && x.declined), "Esme's export lists Dino's request as received, declined");
r = op(D, E, 'cancel', T0 + 5 * DAY); ok(r.r === 'cancelled' && r.other === false && !snap(D).out.length, 'Dino cancels the declined one: gone from his list, Esme not told');
const T6 = T0 + 6 * DAY; r = op(D, E, 'add', T6); ok(r.r === 'requested' && !snap(E).inc.length && names(snap(D).out) === 'Esme', 'and adding again still reaches nobody (the block stays until it expires), but he sees it again');
ok(snap(D, T6).out[0].at === T6 && snap(D, T6 + 29 * DAY).out.length === 1, `...as just sent (at ${snap(D, T6).out[0].at - T0} ms after T0, not day 0) with 30 days to live: exactly as a fresh request, so the decline stays silent`);
ok(exE() === exE0, "Esme's export is the same before and after Dino's cancel and re-add (she cannot tell either)");
r = op(E, D, 'add'); ok(r.r === 'friends' && r.other && names(snap(D).friends) === 'Esme' && !snap(D).out.length && !snap(E).inc.length, 'Esme changes her mind and adds Dino: friends at once, as if his request had been pending all along (he cannot tell it was declined)');

console.log('remove, and the 30-day block');
r = op(A, C, 'remove'); ok(r.r === 'removed' && r.other === true && r.rel === 'none', 'Ace removes Cato (Cato is pushed: his list changed)');
ok(names(snap(C).friends) === '' && !snap(C).out.length && !snap(C).inc.length && !snap(A).inc.length, 'Cato sees no friend, no request out or in; Ace sees nothing in');
ok(db.friendRel(C.id, A.id, T0 + 1000) === 'none', "Cato's rel to Ace is none (the block is never shown)");
const exA = () => JSON.stringify(db.exportOf(A.owner_id, T0 + 2000).friendRequests), exC = () => JSON.stringify(db.exportOf(C.owner_id, T0 + 2000).friendRequests.sent);
const exA0 = exA(); ok(exC() === '[]', "Cato's export lists no request sent (the block is not his)");
{ const x = JSON.parse(exA0); ok(!x.received.some(y => y.username === 'Cato') && x.removed.length === 1 && x.removed[0].username === 'Cato' && x.removed[0].when, `Ace's export lists the block as whom he removed, never as a request Cato sent (${exA0})`); }
const T20 = T0 + 20 * DAY; r = op(C, A, 'add', T20); ok(r.r === 'requested' && r.other === false && !snap(A, T20).inc.length && names(snap(C, T20).out) === 'Ace', "Cato re-adds on day 20: 'requested' as if sent, Ace sees nothing");
ok(snap(C, T20).out[0].at === T20 && names(snap(C, T0 + 38 * DAY).out) === 'Ace' && !snap(C, T20 + 30 * DAY + 1).out.length, "...shown as just sent (not the removal's day 0) and gone 30 days after it, not 30 after the removal: Cato cannot date the removal");
ok(exA() === exA0, "and Ace's export is the same before and after the re-add (it cannot tell either)");
ok(op(A, C, 'remove').r === 'removed' && op(A, C, 'remove').other === false, 'removing a non-friend is an idempotent no-op');
r = op(A, C, 'add', T20 + 1000); ok(r.r === 'requested' && r.other && names(snap(C).inc) === 'Ace', "Ace adds Cato back: the block goes, a normal request reaches Cato, exactly as if Cato had never re-added (Ace cannot tell he tried)");
ok(op(C, A, 'accept').r === 'friends', 'Cato accepts');
{ const [M, W] = [acct('m-1', 'Moe'), acct('m-2', 'Nia')]; op(M, W, 'add'); op(W, M, 'accept'); op(M, W, 'remove');
  r = op(M, W, 'add'); ok(r.r === 'requested' && r.other && names(snap(W).inc) === 'Moe' && !snap(W).friends.length, 'a remover adding back someone who has not re-added: the block goes, a normal request reaches them (3)');
  ok(op(W, M, 'accept').r === 'friends' && !db.friendsOf(M.id, T0 + 1000).out.length, 'Nia accepts: no request row left'); }
{ const [M, W] = [acct('m-3', 'Pip'), acct('m-4', 'Rue')]; op(M, W, 'add'); op(W, M, 'accept'); op(M, W, 'remove'); op(W, M, 'add', T20);   // Rue re-adds on day 20: the block lives on to day 50
  const rm = t => db.exportOf(M.owner_id, t).friendRequests.removed.map(x => x.username).join();
  ok(rm(T0 + 10 * DAY) === 'Rue' && rm(T0 + 35 * DAY) === '', `Pip's export lists the removal until its own 30 days are over, not while Rue's re-add keeps the row (day 10: "${rm(T0 + 10 * DAY)}", day 35: "${rm(T0 + 35 * DAY)}")`);
  op(M, W, 'add'); ok(op(W, M, 'accept').r === 'friends', 'Pip adds Rue back, Rue accepts: no row left'); }

console.log('expiry and the sweep');
op(F, B, 'add'); op(B, F, 'decline');
ok(db.friendRel(F.id, B.id, T0 + 1000) === 'out', 'Finn asked Bree, declined (silently)');
const T31 = T0 + 31 * DAY;
ok(!db.friendsOf(F.id, T31).out.length && db.friendRel(F.id, B.id, T31) === 'none', '31 days on, before any sweep: the request is expired everywhere');
r = db.friendOp(F.id, B.id, 'add', T31); ok(r.r === 'requested' && r.other && names(db.friendsOf(B.id, T31).inc) === 'Finn', 'and Finn may ask again: it reaches Bree');
op(E, F, 'add');                                                  // an old one to be swept
const n = await quietAsync(() => db.sweep(T0 + 1000 + 31 * DAY));
ok(n && n.friendreqs === 1 && db.counts().friend_reqs === 1, `the sweep deletes requests 30 days old (friendreqs ${n && n.friendreqs}), keeps the fresh one`);

console.log('caps (FRIEND_MAX 4, REQ_OUT_MAX 3 here)');
const X = ['Gus', 'Hal', 'Ivy', 'Jay', 'Kit'].map((nm, i) => acct('x-' + i, nm));
for (const x of X.slice(0, 3)) op(F, x, 'add');
ok(op(F, X[3], 'add').err === 'limit', 'a fourth request out: limit');
ok(op(F, X[0], 'add').r === 'requested', 'but re-adding one already out is fine');
op(X[0], F, 'decline'); ok(op(F, X[3], 'add').err === 'limit', 'a silently declined one still counts (its sender sees it pending)');
op(F, X[0], 'cancel'); ok(op(F, X[3], 'add').r === 'requested', 'cancelling it frees the place');
ok(op(F, X[0], 'add').err === 'limit', 'and re-adding the declined one answers limit exactly as a fresh request would');
const full = acct('x-full', 'Lee'); for (const x of [A, B, C, D]) { op(full, x, 'add'); op(x, full, 'accept'); }
ok(names(snap(full).friends) === 'Ace,Bree,Cato,Dino', 'Lee has 4 friends (the cap)');
ok(op(X[4], full, 'add').err === 'full' && op(full, X[4], 'add').err === 'full', 'a request to or from a full account: full');
op(X[3], A, 'add'); op(X[4], A, 'add'); ok(op(A, X[4], 'accept').r === 'friends' && snap(A).friends.length === 4, 'Ace accepts Kit: 4 friends (Bree, Cato, Lee, Kit)');
ok(op(A, X[3], 'accept').err === 'full' && db.friendRel(A.id, X[3].id, T0 + 1000) === 'in', 'accepting Jay now: full, and the request stays');
op(X[4], B, 'add');

console.log('rank on the list, the export, the cascade');
db.ladderApply({ owner: B.owner_id, delta: 400, won: true, vsBot: false, now: T0 + 5 });
const fa = snap(A).friends; const bree = fa.find(f => f.name === 'Bree'), cato = fa.find(f => f.name === 'Cato');
ok(bree.rank && bree.rank.tier === 3 && bree.rank.div >= 1 && cato.rank === null, `a friend's rank is {tier, div}, null if never ranked (${JSON.stringify(bree.rank)})`);
const ex = db.exportOf(A.owner_id, T0 + 2000);
ok(Array.isArray(ex.friends) && ex.friends.map(f => f.username).sort().join(',').includes('Bree') && ex.friends.every(f => Object.keys(f).join() === 'username,since'), 'the export lists friends by username and since');
ok(ex.friendRequests && Array.isArray(ex.friendRequests.received) && Array.isArray(ex.friendRequests.sent), 'and requests received and sent');
ok(!JSON.stringify(ex).includes('owner') && !/"id"/.test(JSON.stringify(ex.friends)) && /friends and friend requests are listed by username/.test(ex.notes) && !/Opponents are shown only as Matt or a player\./.test(ex.notes), 'no id, no owner; the notes no longer claim only Matt or a player is named');
const eh = op(E, X[1], 'add'); ok(eh && eh.r === 'requested', 'Esme asks Hal ' + JSON.stringify(eh)); const before = db.counts(); ok(db.deleteOwner(E.owner_id, T0 + 3000), 'Esme (a friend of Dino, a request out to Hal) deletes her account');
ok(db.counts().friends === before.friends - 1 && !names(snap(D).friends).includes('Esme'), 'her friendship goes by the cascade');
ok(db.counts().friend_reqs === before.friend_reqs - 1 && names(db.friendsOf(X[1].id, T0 + 1000).inc) === 'Finn', `her request too (Hal still has Finn's) ${db.counts().friend_reqs} ${before.friend_reqs}`);

console.log('search');
const u1 = acct('u-1', 'a_b1'), u2 = acct('u-2', 'axb1'), u3 = acct('u-3', 'Acey');
const like = q => q.replace(/[\\%_]/g, c => '\\' + c) + '%';
const sr = (me, q) => db.friendSearch(me.id, like(q), U.skeleton(q), T0 + 1000);
ok(names(sr(B, 'a_')) === 'a_b1', `'_' is a letter, not a wildcard: a_ finds a_b1, not axb1 (${names(sr(B, 'a_'))})`);
ok(names(sr(B, 'ACE')) === 'Ace,Acey', `a case-insensitive prefix (${names(sr(B, 'ACE'))})`);
ok(sr(B, 'Ac3')[0].name === 'Ace', 'the exact confusable key matches too (Ac3 -> Ace), listed first');
ok(!sr(A, 'Ace').some(r => r.name === 'Ace'), 'never self');
ok(sr(A, 'Bre')[0].rel === 'friend' && sr(X[4], 'Bre')[0].rel === 'out' && sr(B, 'Kit')[0].rel === 'in' && sr(B, 'Gus')[0].rel === 'none', 'each row carries rel friend / out / in / none');
db.leaderHide(D.owner_id, true); ok(names(sr(A, 'Dino')) === 'Dino', 'a hidden (lb_hidden) account is still searchable');
for (let i = 0; i < 25; i++) acct('z-' + i, 'Zed' + String(i).padStart(2, '0'));
ok(sr(A, 'Zed').length === 20, 'at most 20 rows');
ok(db.playerByKey(U.skeleton('dino')).hidden && db.playerByKey(U.skeleton('nobody')) === null, 'playerByKey: by key, with the hidden flag; null for no such name');

console.log('the API');
function call(method, url, body, cookie) {
  return new Promise(res => {
    const req = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
    Object.assign(req, { method, url, headers: { host: 'localhost:8080', origin: 'http://localhost:8080', 'content-type': 'application/json', ...(cookie ? { cookie } : {}) }, socket: { remoteAddress: '127.0.0.1' } });
    const out = { status: 0, head: {}, body: '', j: null };
    const r = { headersSent: false, writableEnded: false, on() {}, setHeader() {}, writeHead(st, h) { out.status = st; out.head = h; this.headersSent = true; }, end(b) { out.body = b ? String(b) : ''; try { out.j = JSON.parse(out.body); } catch { /* 204 */ } this.writableEnded = true; res(out); } };
    api.handle(req, r);
  });
}
const cookieOf = a => auth.cookieNames().session + '=' + db.session.create(a.id, Date.now());
const pushes = [], ST = new Map();
const hook = { status: id => ST.get(id) || 'off', changed: (push, drop) => pushes.push({ push: [...push], drop: [...(drop || [])] }) };
const env = { GOOGLE_CLIENT_ID: 'x.apps.googleusercontent.com', FRIEND_ADDS_HOUR: '5', FRIEND_SEARCH_10M: '4' };
api.init({ env: {}, social: hook });
ok((await call('GET', '/api/friends')).status === 404, 'sign-in off: the friends routes answer 404 like the other account routes');
api.init({ env, social: hook });
const P1 = acct('p-1', 'Pia'), P2 = acct('p-2', 'Quin'), P3 = acct('p-3', 'Ren'), P4 = acct('p-4', 'Sol');
const cP1 = cookieOf(P1), cP2 = cookieOf(P2), cP3 = cookieOf(P3), cN = cookieOf(N);
ok((await call('GET', '/api/friends')).status === 401 && (await call('GET', '/api/friends')).j.error === 'signin', 'no session: 401 signin');
ok((await call('GET', '/api/friends', null, cN)).status === 403 && (await call('GET', '/api/friends', null, cN)).j.error === 'username', 'no username: 403 username');
let g = await call('GET', '/api/friends', null, cP1);
ok(g.status === 200 && JSON.stringify(g.j) === '{"friends":[],"inc":[],"out":[]}', `GET /api/friends -> the empty snapshot (${g.body})`);
let p = await call('POST', '/api/friends', { op: 'add', name: 'quin' }, cP1);
ok(p.status === 200 && p.j.r === 'requested' && p.j.rel === 'out' && p.j.snap && p.j.snap.out[0].name === 'Quin', `POST add (any case) -> {r, rel, snap} (${p.body})`);
ok(Object.keys(p.j).join() === 'r,rel,snap' && pushes.at(-1).push.join() === [P1.id, P2.id].join(), 'the hook pushes both sides (a new request reaches Quin)');
ok((await call('POST', '/api/friends', { op: 'nope', name: 'Quin' }, cP1)).j.error === 'op' && (await call('POST', '/api/friends', { op: 'add', name: 'Nobody1' }, cP1)).status === 404
  && (await call('POST', '/api/friends', { op: 'add', name: 'Pia' }, cP1)).status === 409 && (await call('POST', '/api/friends', { op: 'accept', name: 'Ren' }, cP1)).j.error === 'norequest', '400 op, 404 notfound, 409 self, 409 norequest');
ok((await call('POST', '/api/friends', { op: 'add', name: ['Quin'] }, cP1)).status === 404, 'a name that is not a string: 404');
const n0 = pushes.length; p = await call('POST', '/api/friends', { op: 'decline', name: 'Pia' }, cP2);
ok(p.status === 200 && p.j.r === 'declined' && pushes.length === n0 + 1 && pushes.at(-1).push.join() === String(P2.id), 'a decline pushes only the decliner (Pia hears nothing, not even a push)');
p = await call('POST', '/api/friends', { op: 'add', name: 'Pia' }, cP3); p = await call('POST', '/api/friends', { op: 'accept', name: 'Ren' }, cP1);
ok(p.j.r === 'friends' && p.j.snap.friends[0].name === 'Ren' && p.j.snap.friends[0].st === 'off', 'Pia accepts Ren: friends, st off');
p = await call('POST', '/api/friends', { op: 'add', name: 'Sol' }, cP1); ok(p.j.r === 'requested', 'Pia asks Sol');
ok((await call('POST', '/api/friends', { op: 'add', name: 'Sol' }, cP1)).status === 429, 'the sixth add within the hour (FRIEND_ADDS_HOUR 5 here): 429 rate');
ok((await call('POST', '/api/friends', { op: 'cancel', name: 'Sol' }, cP1)).status === 200, 'other ops are not counted as adds');
console.log('sorting and status');
{ const Z = [acct('o-1', 'Ola'), acct('o-2', 'bob'), acct('o-3', 'Cyd')]; for (const z of Z) { op(P3, z, 'add', Date.now()); op(z, P3, 'accept', Date.now()); }
  ST.set(Z[2].id, 'ranked'); ST.set(Z[0].id, 'menu'); ST.set(P1.id, 'watching');
  const s = (await call('GET', '/api/friends', null, cP3)).j;
  ok(s.friends.map(f => f.name + ':' + f.st).join() === 'Cyd:ranked,Pia:watching,Ola:menu,bob:off', `online first by status weight, then by name, case-insensitive (${s.friends.map(f => f.name + ':' + f.st)})`);
  ST.set(P1.id, 'bogus'); ok((await call('GET', '/api/friends', null, cP3)).j.friends.find(f => f.name === 'Pia').st === 'off', 'an unknown status reads as off'); ST.clear(); }
console.log('search route');
ok((await call('GET', '/api/friends/search?q=R', null, cP1)).j.error === 'q' && (await call('GET', '/api/friends/search?q=R%25', null, cP1)).status === 400 && (await call('GET', '/api/friends/search?q=abcdefghijklm', null, cP1)).status === 400, '1 char, a %, 13 chars: 400 q');
let s1 = await call('GET', '/api/friends/search?q=re', null, cP1);
ok(s1.status === 200 && s1.j.rows.length === 1 && JSON.stringify(s1.j.rows[0]) === '{"name":"Ren","rel":"friend"}', `rows of {name, rel} (${s1.body})`);
await call('GET', '/api/friends/search?q=Pi', null, cP1); await call('GET', '/api/friends/search?q=Pi', null, cP1); await call('GET', '/api/friends/search?q=Pi', null, cP1);
ok((await call('GET', '/api/friends/search?q=Pi', null, cP1)).status === 429 && (await call('GET', '/api/friends/search?q=Pi', null, cP2)).status === 200, 'the fifth search in 10 min (FRIEND_SEARCH_10M 4 here): 429, per account');
console.log('profile card (/api/player)');
api.init({ env, social: hook });
db.ladderApply({ owner: P4.owner_id, delta: 200, won: true, vsBot: false, now: Date.now() });
let pc = await call('GET', '/api/player?name=sol');
ok(pc.status === 200 && pc.j.name === 'Sol' && pc.j.rank && pc.j.rank.tier === 2 && pc.j.places && pc.j.places.trophies.rank >= 1 && pc.j.rel === 'none' && pc.j.st === null, `no sign-in: name, rank, places, rel none, st null (${pc.body})`);
ok(Object.keys(pc.j).join() === 'name,rank,places,rel,st' && !/owner|account|"id"/.test(pc.body), 'no id on the wire');
ok(Object.keys(pc.j.places).join() === 'trophies,rally,streak' && Object.keys(pc.j.places.trophies).join() === 'rank' && !/"v"/.test(pc.body), 'a place is its number only: never the trophies, rally or streak under it (stats stay private)');
ok((await call('GET', '/api/player?name=Nobody9')).status === 404 && (await call('GET', '/api/player')).j.error === 'notfound', '404 notfound');
db.leaderHide(P4.owner_id, true);
pc = await call('GET', '/api/player?name=Sol', null, cP2); ok(pc.j.rank === null && pc.j.places === null, 'hidden (lb_hidden): no rank, no places for a stranger');
op(P2, P4, 'add', Date.now()); op(P4, P2, 'accept', Date.now()); ST.set(P4.id, 'matt');
pc = await call('GET', '/api/player?name=Sol', null, cP2); ok(pc.j.rank && pc.j.rank.tier === 2 && pc.j.places && pc.j.places.trophies && pc.j.places.trophies.rank >= 1 && pc.j.rel === 'friend' && pc.j.st === 'matt', `a friend of a hidden account sees rank, its places (where it would stand) and st (${pc.body})`);
pc = await call('GET', '/api/player?name=Sol', null, cookieOf(P4)); ok(pc.j.rank && pc.j.places && pc.j.places.trophies && pc.j.places.trophies.rank >= 1 && pc.j.rel === 'none' && pc.j.st === null, 'the player sees their own card whole, places too while hidden');
ok(!db.leaderPlaces(P4.owner_id).trophies && db.leaderPlaces(P4.owner_id).why === 'hidden', 'and leaderPlaces without evenHidden still gives a hidden account no places (/api/stats, the boards)');
console.log('rename');
pushes.length = 0; const rn = await call('POST', '/api/username', { username: 'Quinn' }, cP2);
ok(rn.status === 200 && pushes.length === 1 && [...pushes[0].push].sort().join() === [P1.id, P4.id].sort().join(), `a new username pushes its friend (Sol) and the requests' other sides that show it (Pia: her silently declined request) (${rn.status} ${JSON.stringify(pushes)})`);
ok(db.friendsOf(P1.id, Date.now()).out.some(x => x.name === 'Quinn'), "and Pia's list now names Quinn");
console.log('delete');
pushes.length = 0; const d = await call('DELETE', '/api/account', { confirm: 'delete' }, cP2);
ok(d.status === 200 && pushes.length === 1 && [...pushes[0].push].sort().join() === [P1.id, P4.id].sort().join() && pushes[0].drop.join() === String(P2.id), `deleting an account pushes its former friends and the requests' other sides (${JSON.stringify(pushes)})`);
ok(!db.friendsOf(P4.id, Date.now()).friends.length, 'and the cascade took the friendship');
console.log('no ids anywhere on the wire');
for (const body of [(await call('GET', '/api/friends', null, cP1)).body, (await call('POST', '/api/friends', { op: 'add', name: 'Gus' }, cP1)).body, (await call('GET', '/api/friends/search?q=Ga', null, cP3)).body])
  ok(!/"id"|owner|account|sub"/.test(body), 'no id / owner / account in ' + body.slice(0, 60));
db.close();
console.log(fails ? `FAIL ${fails}` : 'PASS');
process.exit(fails ? 1 : 0);
