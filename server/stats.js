// Player stats recording (docs/ACCOUNTS.md 3.2, 4): the per-match accumulator, seat identity (freeze, then compare), rally and swing
// bests, the paddle teleport sampler, and the one call at match end (onEnd) that asks abuse.judge and writes one db transaction.
// Nothing runs on require: init() wires the database, the knobs and the in-memory link map once at boot. Nothing here logs an
// identity, an address, a device id, an account or a token: game.js logs one line per recorded match with the court code only.
// NO function here may throw into the game loop: endMatch runs inside sim() on the 60 Hz interval (game.js wraps every hook too).
const abuse = require('./abuse');

const DAY = 24 * 3600e3;
const BOT_ORDER = abuse.BOT_ORDER;                                // ladder position -> wire level (Rookie 0, Club 1, Tour 3, Pro 2)
const HUMAN = new Set(['human', 'tour']);
const SET_MAX = 16;                                               // computers / cids remembered per seat or member: a reconnect loop must not grow them without end
// Swing caps (4.5, Q3). The recordings in data/ peak at 44.10 (live-play-1), 40.09 (live-play-3) and 37.88 (live-swings) rad/s, above the
// spec's guessed 35/40, so the caps sit above the observed maximum: a settled peak over SPEED_BAD is implausible, one over SPEED_CAP is kept at it.
const SPEED_CAP = 45, SPEED_BAD = 48;
const SMASH_N = 0.76, SMASH_PK = 12;                              // a settled smash (n >= SMASH, server/game.js) under 12 rad/s is a careless forgery (R15)
const FIX_AGREE = 0.15;                                           // a settled report within this of the bet that struck the ball speaks for that contact

let db = null, cfg = abuse.config({}), links = null, signin = false, sockets = () => [], seq = 0, pruner = null;
const live = new Set();                                           // matches still being played: forget() marks their seats, done/drop removes them

// init({ db, env, signinEnabled, sockets }) -> once at boot. sockets: () => iterable of the open game sockets (for forget).
function init(o = {}) {
  db = o.db || null; cfg = abuse.config(o.env || process.env); signin = !!o.signinEnabled;
  if (typeof o.sockets === 'function') sockets = o.sockets;
  links = abuse.createLinks();
  if (pruner) clearInterval(pruner);
  pruner = setInterval(() => { try { links.prune(); } catch { /* never breaks the server */ } }, 60e3); pruner.unref();   // 24 h hygiene (5.4)
}
const config = () => cfg;
const linkMap = () => links || (links = abuse.createLinks());

// ---- identity (3.2) ----
const eqHash = (a, b) => !!a && !!b && a.length === b.length && Buffer.compare(Buffer.from(a), Buffer.from(b)) === 0;
// identOf(ws) -> what this socket says it is right now: a signed-in account wins over the device id (3.2 step 4)
function identOf(ws) {                                           // a socket with Save my stats off (ws.statsOff) is anonymous, signed in or not (9.6)
  const off = !!(ws && ws.statsOff), acct = !off && ws && ws.acct || null, devHash = acct || off ? null : (ws && ws.devHash) || null;
  return { devHash, accountId: acct ? acct.accountId : null, ownerId: acct ? acct.ownerId : null, tokenHash: acct ? ws.tokenHash || null : null,
    computer: ws ? ws.computer || 'local' : 'local', cid: ws && typeof ws.cid === 'string' ? ws.cid : null, anon: !devHash && !acct };
}
const sameIdent = (a, b) => (a.accountId != null ? a.accountId === b.accountId : b.accountId == null && eqHash(a.devHash, b.devHash));
const addCapped = (set, v) => { if (v == null || set.has(v)) return; if (set.size >= SET_MAX) set.delete(set.values().next().value); set.add(v); };
// seen(ws): the link map learns that this socket's identities (device hash, account, cid) sit on its computer key (5.4)
function seen(ws) {
  try { if (!ws || ws.pad || !ws.computer) return; const a = ws.acct;
    linkMap().see({ devHash: ws.devHash || null, accountId: a ? a.accountId : null, cid: typeof ws.cid === 'string' ? ws.cid : null }, ws.computer);
  } catch { /* the link map is best effort */ }
}
// freeze-or-compare (3.2) on anything with { ident, computers, cids, identChanged, pendingAnon }
function compare(acc, id) {
  addCapped(acc.computers, id.computer); addCapped(acc.cids, id.cid);
  if (id.anon) { if (acc.ident) acc.pendingAnon = true; return; }   // a reconnect before its hello, or stats switched off: cleared if the same identity says hello
  if (!acc.ident) { acc.ident = id; acc.pendingAnon = false; return; }   // the first non-anonymous identify freezes it, before or after the first strike
  if (sameIdent(acc.ident, id)) acc.pendingAnon = false; else acc.identChanged = true;   // never cleared: R6b
}

// ---- the match accumulator (4.1) ----
// seatAcc(pl) -> the seat's accumulator; a new match starts from the identity of the socket holding the seat NOW (pl.sockIdent)
function seatAcc(pl) {
  if (!pl) return null;
  if (pl.bot) return { pl, bot: true };
  const id = pl.sockIdent || null;
  return { pl, bot: false, contacts: 0, held: 0, rallyReal: 0, rallyHeld: 0, bestRally: 0, bestHit: 0, bestSpeed: 0, swingBad: false,
    ident: id && !id.anon ? id : null, computers: new Set(id ? [id.computer] : []), cids: new Set(pl.cid ? [pl.cid] : []),
    identChanged: false, pendingAnon: false, gone: false, mv: { x: 0, y: 0, at: 0, fast: 0 }, teleport: false };
}
// newMatch({ revived, rank, seats: [pl|null, pl|null] }) -> the match object a room keeps in `match` (4.1)
function newMatch({ revived = false, rank = null, seats = [null, null] } = {}) {
  const m = { id: ++seq, done: false, t0: 0, revived: !!revived, rank, levelChanged: false, rally: 0, seats: [0, 1].map(i => seatAcc(seats[i] || null)) };
  live.add(m); return m;
}
const drop = m => { if (m) live.delete(m); };                     // the room closed or a new match replaced it
const accOf = (m, pl) => (m && !m.done && pl ? m.seats.find(s => s && s.pl === pl) || null : null);
// seatFill(m, side, pl): a seat that fills after the match was built (join, 4.1)
function seatFill(m, side, pl) { if (m && !m.done && !m.seats[side]) m.seats[side] = seatAcc(pl); }
// identify(m, pl, ws): join / retake / hello on a seated socket. Remembers the socket's identity on the seat and applies freeze-or-compare
function identify(m, pl, ws) {
  if (!pl || pl.bot) return;
  const id = identOf(ws); pl.sockIdent = id; seen(ws);
  const acc = accOf(m, pl); if (acc) compare(acc, id);
}
// member(m, ws): a tournament member seen on a socket (tourAdd, tourBind, tourRebind, hello). Same freeze rule as a seat (4.3)
function member(mem, ws) {
  if (!mem || !ws) return;
  if (!mem.computers) { mem.computers = new Set(); mem.cids = new Set(); mem.ident = null; mem.identChanged = false; mem.pendingAnon = false; mem.rankedWins = mem.rankedWins || 0; }
  const id = identOf(ws); seen(ws);
  if (id.anon) { addCapped(mem.computers, id.computer); return; }   // a reconnect before its hello never overwrites a good identity
  compare(mem, id);
}
// optOut(m, pl, ws, mem): Save my stats switched off on this socket (game.js noStats). The seat's match under way is recorded with no owner,
// like a deleted one (its frozen identity still judges the opponent), and a tournament member takes no title
function optOut(m, pl, ws, mem) {
  if (pl && !pl.bot && ws) { pl.sockIdent = identOf(ws); const s = accOf(m, pl); if (s) s.gone = true; }
  if (mem) mem.off = true;
}

// ---- during the match: rallies (4.4), swings (4.5), level (4.6), paddle (4.8) ----
function launched(m) { if (!m || m.done) return; if (!m.t0) m.t0 = Date.now(); m.rally++; }   // launch(): every struck ball
function rallyReset(m) { if (!m || m.done) return; m.rally = 0; for (const s of m.seats) if (s && !s.bot) s.rallyReal = s.rallyHeld = 0; }   // reset(): a fresh point
// contact(m, pl, sw) -> true when this contact recorded a settled swing itself (the caller marks pl.hit.statted)
function contact(m, pl, sw) {
  const s = accOf(m, pl); if (!s || s.bot || !sw) return false;
  if (sw.held) { s.held++; s.rallyHeld++; return false; }
  s.contacts++; s.rallyReal++;
  if (sw.sure) { swingBest(s, sw.n, sw.pk, sw.src); return true; }
  return false;
}
function pointEnd(m) {                                            // point(), before the score moves: a rally won by parking the paddle is not a best
  if (!m || m.done) return;
  for (const s of m.seats) if (s && !s.bot && m.rally >= 3 && s.rallyReal >= 1 && s.rallyReal >= s.rallyHeld) s.bestRally = Math.max(s.bestRally, m.rally);
}
// swingBest(s, n, pk, src): a settled, real contact (4.5). hit 0..100 from the server-clamped n; speed only with a finite pk and a known source
function swingBest(s, n, pk, src) {
  if (!s || s.bot || !Number.isFinite(n)) return;
  const hit = Math.round(Math.min(1, Math.max(0, n)) * 100); if (hit > s.bestHit) s.bestHit = hit;
  const p = Number.isFinite(pk) ? pk : null;
  if (p != null && (src === 'airpod' || src === 'phone')) {
    if (p > SPEED_BAD || p < 0) s.swingBad = true;
    else { const v = Math.min(p, SPEED_CAP); if (v > s.bestSpeed) s.bestSpeed = v; }
  }
  if (n >= SMASH_N && p != null && p < SMASH_PK) s.swingBad = true;
}
// fixRecords(hit, betN, pw, ran, t, win) -> does a settled correction (final) record this swing? (4.5) ran: fixBlock or the re-aim really moved
// the ball to this power. Otherwise only a report that agrees with the bet that struck (within FIX_AGREE) and lands inside the window.
function fixRecords(hit, betN, pw, ran, t, win) {
  if (!hit || hit.statted || !Number.isFinite(pw)) return false;
  return !!ran || (t - hit.at < win && Number.isFinite(betN) && Math.abs(pw - betN) <= FIX_AGREE);
}
// level(m, r): Matt's level moved to ladder position r while seated (botRequest). Free before the first strike; after it, the easiest used
function level(m, r) {
  if (!m || m.done || !Number.isInteger(r) || r < 0) return;
  if (!m.t0) { m.rank = r; return; }
  if (r !== m.rank) m.levelChanged = true;
  m.rank = m.rank == null ? r : Math.min(m.rank, r);
}
// sample(m, pl, x, y, ballLive): one paddle message (4.8). Only the last sample and the flag are kept
function sample(m, pl, x, y, ballLive) {
  const s = accOf(m, pl); if (!s || s.bot) return;
  const t = Date.now(), mv = s.mv;
  if (mv.at && ballLive && cfg.teleportMs > 0) {
    const dt = Math.max(0.05, (t - mv.at) / 1000), v = Math.max(Math.abs(x - mv.x), Math.abs(y - mv.y)) / dt;
    if (v > cfg.teleportMs) { if (++mv.fast >= 2) s.teleport = true; } else mv.fast = 0;
  } else mv.fast = 0;
  mv.x = x; mv.y = y; mv.at = t;
}

// ---- match end (4.7) ----
// owner(s, now, completed) -> { owner, created } for a human seat. A device gets a NEW owner only from a completed match and inside the
// new-guest caps (5.5); a gone seat (deleted mid-match, 3.3) is recorded with no owner, and its frozen identity still judges the opponent.
function ownerOf(s, now, completed) {
  const id = s.ident; if (!id || s.gone) return { owner: null, created: false };
  if (id.accountId != null) { const o = id.ownerId != null ? id.ownerId : (db.accountById && (db.accountById(id.accountId) || {}).owner_id) || null; return { owner: o, created: false }; }
  if (!id.devHash) return { owner: null, created: false };
  let owner = db.ownerForDevice(id.devHash, now, { create: false });
  if (owner != null || !completed || !db.ok()) return { owner, created: false };
  const keys = [...s.computers];
  if (!linkMap().guestOk(keys, cfg)) return { owner: null, created: false };   // the cap: this seat is saved:false, play is untouched
  const out = {}; owner = db.ownerForDevice(id.devHash, now, { create: true, out });
  if (out.created) linkMap().guestAdd(keys);
  return { owner, created: !!out.created };
}
// onEnd(m, { now, kind, winner, ending, score }) -> { logged, ranked, level, msgs: [profileMsg|null, x2], rankedWin: [bool, bool] } | null.
// kind 'bot'|'human'|'tour'|'tourbot'; winner 0|1|null (null: left/dropped vs Matt); ending 'won'|'forfeit'|'left'|'dropped'. Marks m done.
function onEnd(m, e) {
  if (!m || m.done) return null;
  m.done = true; live.delete(m);
  const now = e.now || Date.now(), kind = e.kind, human = HUMAN.has(kind), score = [e.score[0] | 0, e.score[1] | 0], pts = score[0] + score[1];
  const winner = e.winner === 0 || e.winner === 1 ? e.winner : null;
  const completed = e.ending === 'won' || (e.ending === 'forfeit' && pts >= cfg.forfeitMin);
  const L = linkMap(), store = db && db.ok ? db : null;
  const info = m.seats.map(s => {
    if (!s || s.bot) return null;
    const o = store ? ownerOf(s, now, completed) : { owner: null, created: false };
    const keys = [...s.computers];
    return { ...o, keys, groups: L.groups(keys), established: o.owner != null && store ? !!store.established(o.owner, now) : false };
  });
  const secs = m.t0 ? Math.max(0, Math.round((now - m.t0) / 1000)) : 0;
  const level = human ? null : BOT_ORDER[m.rank != null ? m.rank : kind === 'tourbot' ? 2 : 1];
  const facts = { now, kind, winner, ending: e.ending, score, secs, revived: m.revived, levelChanged: m.levelChanged,
    seats: m.seats.map((s, i) => !s ? null : s.bot ? { bot: true } : { bot: false, owner: info[i].owner, ident: s.ident, groups: info[i].groups,
      computers: s.computers, cids: s.cids, gone: s.gone, contacts: s.contacts, held: s.held, swingBad: s.swingBad, identChanged: s.identChanged,
      pendingAnon: s.pendingAnon, teleport: s.teleport, established: info[i].established }) };
  const history = {};
  if (human && winner != null && info[0] && info[1]) {
    const W = info[winner], Lo = info[1 - winner];
    if (store && W.owner != null && Lo.owner != null) { history.pairRanked24h = store.recentPairs(W.owner, Lo.owner, now - DAY); history.oneWay30d = store.oneWay(W.owner, Lo.owner, now - 30 * DAY); }
    if (store && Lo.owner != null) history.loserHuman7d = store.recentLosses(Lo.owner, now - 7 * DAY);
    if (store && W.owner != null) history.winnerWins24h = store.recentWins(W.owner, now - DAY);
    history.cpuPair24h = L.pair(W.keys, Lo.keys); history.cpuLoser24h = L.loser(Lo.keys);
  }
  const v = abuse.judge(facts, history, cfg);
  const rec = store ? store.recordMatch({ now, kind, level, winner, ending: e.ending, score, secs, ranked: v.ranked, flags: v.flags,
    seats: m.seats.map((s, i) => (!s || s.bot || info[i].owner == null ? null : { owner: info[i].owner, record: v.seats[i].record, bests: v.seats[i].bests,
      swingBad: !v.seats[i].swing, bestRally: s.bestRally, bestHit: s.bestHit, bestSpeed: s.bestSpeed })) }) : null;
  if (rec && rec.capped && human) { v.ranked = false; if (!v.flags.includes('daily_cap')) v.flags.push('daily_cap'); for (const x of v.seats) x.record = x.bests = x.swing = false; }   // past LOG_CAP_DAY: saved as played only (db.recordMatch), so it is not ranked either
  if (human && winner != null && info[0] && info[1]) L.result(info[winner].keys, info[1 - winner].keys, v.ranked);   // after the transaction, ranked or not (5.4)
  const msgs = m.seats.map((s, i) => {
    if (!s || s.bot) return null;
    const r = rec && rec.seats[i] && rec.seats[i].saved ? rec.seats[i] : null, won = winner === i && v.seats[i].record;
    return { type: 'profile', saved: !!r, ranked: v.ranked, why: abuse.why(v, facts, i), kind, level: level != null ? level : undefined,
      first: !!(r && r.first), bests: r ? r.bests : [], streak: r ? r.streak : 0, guest: r ? !!r.guest : undefined,
      nudge: !!(r && signin && r.guest && won && (!human || v.ranked)), created: info[i].created || undefined };
  });
  return { logged: !!(rec && rec.logged), ranked: v.ranked, level, msgs, rankedWin: [0, 1].map(i => human && winner === i && !!v.seats[i].record) };
}

// title(members, champ, now) -> true when the champion's owner got tour_titles + 1 (4.3, R16). members: the tournament's member objects
function title(members, champ, now = Date.now()) {
  if (!db || !champ || !champ.ident || champ.off) return false;
  const res = abuse.titleCounts([...members], champ, linkMap(), cfg); if (!res.ok) return false;
  const id = champ.ident, owner = id.accountId != null ? id.ownerId : db.ownerForDevice(id.devHash, now, { create: false });   // a title never creates a profile
  return owner != null ? !!db.addTitle(owner, now) : false;
}

// forget({ tokenHash, accountId, devHash, deleted }): sign-out, session eviction (a token) or deletion (an account and/or a device), 3.3.
// Sockets stop speaking for it at once; on deletion, live seats frozen on it are marked gone (no owner is written or re-created for them),
// and the sockets forget the device too, so a rematch that starts before the client reconnects is anonymous rather than a new guest.
function forget({ tokenHash = null, accountId = null, devHash = null, deleted = false } = {}) {
  for (const ws of sockets()) {
    try {
      const tok = !!tokenHash && eqHash(ws.tokenHash, tokenHash), acct = deleted && accountId != null && !!ws.acct && ws.acct.accountId === accountId;
      const dev = deleted && !!devHash && eqHash(ws.devHash, devHash);
      if (tok || acct) { ws.acct = null; ws.tokenHash = null; }
      if (dev || acct) ws.devHash = null;
      if ((tok || acct || dev) && ws.pl && !ws.pl.bot) ws.pl.sockIdent = identOf(ws);
    } catch { /* one odd socket never stops the rest */ }
  }
  if (!deleted) return;
  const hit = id => !!id && ((accountId != null && id.accountId === accountId) || (!!devHash && eqHash(id.devHash, devHash)));
  for (const m of live) for (const s of m.seats) if (s && !s.bot && hit(s.ident)) s.gone = true;
}

module.exports = { init, config, identOf, seen, seatAcc, newMatch, drop, accOf, seatFill, identify, member, optOut, launched, rallyReset, contact, pointEnd,
  swingBest, fixRecords, level, sample, onEnd, title, forget, SPEED_CAP, SPEED_BAD, _live: live };
