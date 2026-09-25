// Anti-abuse rules for player stats (docs/ACCOUNTS.md section 5). Pure functions, plus ONE stateful export: the in-memory
// link map and computer-keyed history (createLinks, 5.4), whose clock is injected so every rule is unit-testable.
// Nothing runs on require. No I/O, no timers, no logging of identities or addresses (the only log line is the new-guest
// cap, once an hour, with no values in it).
const crypto = require('node:crypto'), net = require('node:net');

const BOT_ORDER = [0, 1, 3, 2];                                // wire level -> ladder position: Rookie 0 < Club 1 < Tour 2 < Pro 3 (same as server/game.js). Never compare wire indexes: Tour (3) is easier than Pro (2)
const DAY = 24 * 3600 * 1000, HOUR = 3600 * 1000;
const HUMAN = new Set(['human', 'tour']), BOTK = new Set(['bot', 'tourbot']);
// Flags that unrank the whole match on their own. The per-seat ones (ident_changed, too_fast, afk, new_opponent,
// paddle_teleport) act only through each seat's `record`; level_changed and swing_implausible are informational.
const MATCH_WIDE = new Set(['legacy', 'revived', 'anon_opponent', 'same_computer', 'same_device', 'same_account', 'same_cid',
  'early_forfeit', 'leaver_ahead', 'pair_cap', 'feeder', 'one_way', 'daily_cap']);

// computerKey(addr) -> what "the same computer" means (3.5): IPv4 whole, IPv6 its /64 (first four hextets, canonical),
// IPv4-mapped IPv6 as the IPv4, 'bad' (the shared key for a rejected header) and anything unparseable -> 'bad', empty -> 'local'.
function computerKey(addr) {
  if (addr == null || addr === '') return 'local';
  if (typeof addr !== 'string' || addr.length > 64) return 'bad';                // bounded: an address is never longer than 45 chars (+ a zone)
  let a = addr.trim().toLowerCase();
  if (!a) return 'local';
  if (a === 'bad' || a === 'local' || /^[0-9a-f]{1,4}(:[0-9a-f]{1,4}){3}$/.test(a)) return a;   // already a key (idempotent: callers pass acc.computers back in); no real address has this shape
  const pct = a.indexOf('%'); if (pct >= 0) a = a.slice(0, pct);                  // fe80::1%en0: the zone is local to the peer, not part of the address
  if (a.startsWith('::ffff:') && net.isIPv4(a.slice(7))) a = a.slice(7);          // ::ffff:1.2.3.4 is 1.2.3.4
  if (net.isIPv4(a)) return a;
  if (!net.isIPv6(a)) return 'bad';
  const h = v6hextets(a);
  if (!h) return 'bad';
  if (h.slice(0, 5).every(x => x === 0) && h[5] === 0xffff)                       // ::ffff:7f00:1, the hex spelling of a mapped IPv4
    return [h[6] >> 8, h[6] & 255, h[7] >> 8, h[7] & 255].join('.');
  return h.slice(0, 4).map(x => x.toString(16)).join(':');                        // lowercase, no leading zeros: 2001:DB8::1 and 2001:0db8:0:0::2 are one /64
}
function v6hextets(a) {                                                           // a valid (net.isIPv6) address -> 8 numbers; a dotted tail counts as two hextets
  let s = a;
  const dot = s.lastIndexOf('.');
  if (dot >= 0) { const c = s.lastIndexOf(':'); const v4 = s.slice(c + 1).split('.').map(Number);
    s = s.slice(0, c + 1) + ((v4[0] << 8) | v4[1]).toString(16) + ':' + ((v4[2] << 8) | v4[3]).toString(16); }
  const [head, tail] = s.includes('::') ? s.split('::') : [s, null];
  const hs = head ? head.split(':') : [], ts = tail ? tail.split(':') : [];
  const fill = tail === null ? 0 : 8 - hs.length - ts.length;
  if (fill < 0) return null;
  const out = [...hs, ...Array(fill).fill('0'), ...ts].map(x => parseInt(x, 16));
  return out.length === 8 && out.every(x => Number.isInteger(x) && x >= 0 && x <= 0xffff) ? out : null;
}
const loopKey = k => k === 'local' || k === '0:0:0:0' || /^127\./.test(k);        // computer keys a loopback peer produces (127/8, ::1's /64, no address); only for STATS_SAME_IP=0 off production

// rank(level) -> ladder position of a wire bot level (BOT_ORDER.indexOf), -1 for anything else
const rank = level => BOT_ORDER.indexOf(level);

// config(env) -> the knobs of 5.3, read once at boot. NODE_ENV=production forces the safe values (R5 always on, FORFEIT_MIN
// from WIN_AT, and a 0 for AFK/teleport/established ignored).
function config(env = process.env) {
  const prod = env.NODE_ENV === 'production';
  const n = (k, d, min = 0, max = 1e6) => { const v = env[k]; if (v == null || v === '') return d; const x = +v;
    return Number.isFinite(x) && x >= min && x <= max ? x : d; };                 // junk or out of range -> the default, never NaN
  const autobot = env.AUTOBOT !== '0';
  const winAt = n('WIN_AT', autobot ? 11 : 0, 0, 1000);                           // mirrors server/game.js WIN_AT
  const forfeitDef = Math.ceil(winAt / 2);
  const afk = n('STATS_AFK_MIN', 2, 0, 1000), tele = n('STATS_TELEPORT_MS', 12, 0, 1000);
  return Object.freeze({
    production: prod,
    sameIp: prod ? true : env.STATS_SAME_IP !== '0',                               // '0' switches R5 off only when both seats are loopback (browser e2e)
    minPointS: n('STATS_MIN_POINT_S', 2.5, 0, 600),                                 // R8, honoured everywhere
    forfeitMin: prod ? forfeitDef : n('STATS_FORFEIT_MIN', forfeitDef, 0, 1000),   // R7
    pairDay: n('STATS_PAIR_DAY', 3, 0, 1e4),                                       // R10
    afkMin: prod && afk === 0 ? 2 : afk,                                           // R9 floor; 0 disables R9 (tests only)
    teleportMs: prod && tele === 0 ? 12 : tele,                                    // R18 (stats.js samples with it); 0 disables. 12 m/s: the recordings under data/ hold motion only, no paddle positions (Q16)
    established: prod ? true : env.STATS_ESTABLISHED !== '0',                      // R11c
    establishedMs: DAY, establishedMatches: 3,                                     // R11c: an owner is established at 24 h old OR 3 recorded matches (db computes it)
    newGuestDay: n('NEW_GUEST_DAY', 30, 0, 1e6), newGuestHour: n('NEW_GUEST_HOUR', 600, 0, 1e7),   // 5.5
    feederLosses: 6, feederShare: 0.8, feederWinShare: 0.2, feederWinners: 2,      // R11
    oneWayWins: 5,                                                                 // R11b
    dailyCap: 30,                                                                  // R12
  });
}

const hex = v => Buffer.isBuffer(v) ? v.toString('hex') : typeof v === 'string' && v ? v : null;
const setOf = v => v instanceof Set ? v : new Set(Array.isArray(v) ? v : []);
const meets = (a, b) => { for (const x of setOf(a)) if (setOf(b).has(x)) return true; return false; };
const num0 = v => (Number.isFinite(v) && v > 0 ? v : 0);

// judge(facts, history, cfg) -> { ranked, flags, seats: [{ record, bests, swing, idle }] } (5.2). Pure: facts carry `now`.
// record: this seat's result (W, L or abandon) moves W/L, streaks and firsts. bests: rally/hit/speed bests may save.
// swing: hit/speed bests may save (bests without R15). idle: this seat tripped R9 (for why()).
function judge(facts, history, cfg) {
  const f = facts || {}, h = history || {}, c = cfg || config({});
  const seats = [0, 1].map(i => (f.seats && f.seats[i]) || null);
  const out = seats.map(() => ({ record: false, bests: false, swing: false, idle: false }));
  const flags = [], flag = id => { if (!flags.includes(id)) flags.push(id); };
  if (f.legacy) { flag('legacy'); return { ranked: false, flags, seats: out }; }   // R0: the LOCAL room records nothing, ever

  const kind = f.kind, human = HUMAN.has(kind), bot = BOTK.has(kind);
  const isHuman = s => !!s && !s.bot;
  // R1 / R17 / R3: which seats exist. A pad socket or a bad Origin never has an identity; a seat with no frozen identity is ignored.
  const live = seats.map(s => {
    if (!isHuman(s)) return false;
    if (s.pad) { flag('pad'); return false; }
    if (s.originBad && !s.ident) { flag('origin_bad'); flag('anon'); return false; }
    if (!s.ident) { flag('anon'); return false; }
    return true;
  });
  const w = f.winner === 0 || f.winner === 1 ? f.winner : null;
  let l = w === null ? null : 1 - w;
  if (w === null) { const hs = [0, 1].filter(i => isHuman(seats[i])); if (bot && hs.length === 1) l = hs[0]; }   // left / dropped vs Matt: the human's loss or abandon
  if (l === null) return { ranked: false, flags, seats: out };                     // nothing to decide (a human match always has a winner)
  if (!human && !bot) return { ranked: false, flags, seats: out };

  const score = Array.isArray(f.score) ? f.score : [0, 0], pts = num0(score[0]) + num0(score[1]);
  const W = w === null ? null : seats[w], L = seats[l];
  // Match-wide or per seat, every kind: R2, R6b, R8, R9, R18.
  if (f.revived) flag('revived');                                                 // R2
  const changed = seats.map(s => isHuman(s) && !!(s.identChanged || s.pendingAnon));
  if (changed.some(Boolean)) flag('ident_changed');                               // R6b
  const tooFast = c.minPointS > 0 && num0(f.secs) < c.minPointS * pts;
  if (tooFast) flag('too_fast');                                                  // R8
  const idle = seats.map(s => isHuman(s) && c.afkMin > 0 && num0(s.contacts) < Math.max(c.afkMin, Math.ceil(pts / 4)));
  if (idle.some(Boolean)) flag('afk');                                            // R9
  const tele = seats.map(s => isHuman(s) && c.teleportMs > 0 && !!s.teleport);
  if (tele.some(Boolean)) flag('paddle_teleport');                                // R18
  if (bot && f.levelChanged) flag('level_changed');                               // R13, informational
  seats.forEach(s => { if (isHuman(s) && s.swingBad) flag('swing_implausible'); });   // R15, informational

  let newOpp = false;
  if (human) {
    const [A, B] = seats;
    if (!live[0] || !live[1]) flag('anon_opponent');                              // R4: a seat anonymous for the WHOLE match (a downgrade is R6b; `gone` keeps its frozen identity)
    if (A && B) {
      const loopOnly = s => { const k = setOf(s.computers); return k.size > 0 && [...k].every(loopKey); };
      if (meets(A.groups, B.groups) && (c.sameIp || !(loopOnly(A) && loopOnly(B)))) flag('same_computer');   // R5
      const ia = A.ident || {}, ib = B.ident || {};
      if (hex(ia.devHash) && hex(ia.devHash) === hex(ib.devHash)) flag('same_device');                         // R6
      if ((ia.accountId != null && ia.accountId === ib.accountId) || (A.owner != null && A.owner === B.owner)) flag('same_account');   // one account, or one owner (a device merged into the other seat's account)
      const ca = new Set([...setOf(A.cids), ...(ia.cid ? [ia.cid] : [])]), cb = new Set([...setOf(B.cids), ...(ib.cid ? [ib.cid] : [])]);
      if (meets(ca, cb)) flag('same_cid');
    }
    if (f.ending === 'forfeit') {
      if (pts < c.forfeitMin) flag('early_forfeit');                              // R7
      if (w !== null && num0(score[l]) - num0(score[w]) > 2) flag('leaver_ahead');   // R7b: the leaver (the loser) was ahead by more than 2
    }
    if (num0(h.pairRanked24h) >= c.pairDay || num0(h.cpuPair24h) >= c.pairDay) flag('pair_cap');   // R10, by owners AND by computer groups
    const lh = h.loserHuman7d || {}, lc = h.cpuLoser24h || {};
    const lost = num0(lh.losses), won = num0(lh.wins);
    const byOwner = lost >= c.feederLosses && num0(lh.topTwoShare) >= c.feederShare && won < c.feederWinShare * (lost + won);
    const byCpu = num0(lc.losses) >= c.feederLosses && num0(lc.distinctWinnerGroups) <= c.feederWinners;
    if (byOwner || byCpu) flag('feeder');                                         // R11 (all results, ranked or not)
    const ow = h.oneWay30d || {};
    if (num0(ow.aOverB) >= c.oneWayWins && num0(ow.bOverA) === 0) flag('one_way');   // R11b: a = the winner
    if (c.established && L && L.established !== true) { newOpp = true; flag('new_opponent'); }   // R11c: a loser not known to be established feeds no win
    if (num0(h.winnerWins24h) >= c.dailyCap) flag('daily_cap');                   // R12
  }

  const wide = flags.some(x => MATCH_WIDE.has(x));
  // Winner: credit withheld by R8, R11c, own R6b / R18, or R9 on EITHER seat.
  if (w !== null && live[w])
    out[w].record = !wide && !tooFast && !newOpp && !changed[w] && !tele[w] && !idle[0] && !idle[1];
  // Loser: withheld when the WINNER was idle and by every match-wide rule; kept for its own R9, R6b, R18 and for R8 / R11c.
  if (live[l]) out[l].record = !wide && !(w !== null && idle[w]);
  // Bests: only with a record, never after R2 / R8 / R9 (whole match), nor own R6b / R18. R15 withholds hit/speed only.
  for (const i of [0, 1]) {
    out[i].bests = out[i].record && !f.revived && !tooFast && !idle[0] && !idle[1] && !changed[i] && !tele[i];
    out[i].swing = out[i].bests && !(seats[i] && seats[i].swingBad);
    out[i].idle = idle[i];
  }
  const ranked = !flags.some(x => MATCH_WIDE.has(x) || x === 'anon' || x === 'pad' || x === 'origin_bad')
    && [0, 1].every(i => !isHuman(seats[i]) || out[i].record);
  return { ranked, flags, seats: out };
}

// why(verdict, facts, i) -> the user-facing reasons for seat i (8.3). Never names the opponent's network: human matches get
// 'self' (R6: one person), own 'restart' / 'too_short', and otherwise the single generic 'not_counted'.
function why(verdict, facts, i) {
  const v = verdict || { flags: [] }, f = facts || {}, fl = new Set(v.flags || []), out = [];
  if (HUMAN.has(f.kind)) {
    if (v.ranked) return out;
    if (fl.has('same_device') || fl.has('same_account') || fl.has('same_cid')) return ['self'];
    if (fl.has('revived')) out.push('restart');
    if ((fl.has('too_fast') && f.winner === i) || (v.seats && v.seats[i] && v.seats[i].idle)) out.push('too_short');
    if (!out.length) out.push('not_counted');
    return out;
  }
  if (fl.has('revived')) out.push('restart');
  if (!v.ranked && (fl.has('too_fast') || fl.has('afk'))) out.push('too_short');
  if (!v.ranked && !out.length) out.push('not_counted');
  if (fl.has('level_changed')) out.push('level');
  return out;
}

// titleCounts(members, champ, links, cfg) -> { people, ok } (R16, 4.3): distinct humans by computer GROUP and identity, and
// whether the champion may take the title (3+ people, one ranked human win, a frozen identity that never changed).
function titleCounts(members, champ, links, cfg) {
  const ms = (Array.isArray(members) ? members : []).filter(m => m && !m.bot && m.ident && (hex(m.ident.devHash) || m.ident.accountId != null) && !m.identChanged);
  const gs = ms.map(m => links && links.groups ? links.groups(m.computers || []) : setOf(m.computers));
  const par = ms.map((_, i) => i), find = i => (par[i] === i ? i : (par[i] = find(par[i])));
  for (let i = 0; i < ms.length; i++) for (let j = i + 1; j < ms.length; j++) {
    const a = ms[i].ident, b = ms[j].ident;
    const same = meets(gs[i], gs[j]) || (hex(a.devHash) && hex(a.devHash) === hex(b.devHash)) || (a.accountId != null && a.accountId === b.accountId);
    if (same) par[find(i)] = find(j);                                             // same computer group or same device/account: one person
  }
  const people = new Set(ms.map((_, i) => find(i))).size;
  const ok = !!champ && ms.includes(champ) && people >= 3 && num0(champ.rankedWins) >= 1;
  return { people, ok };
}

// createLinks({ now, ttlMs, maxEntries }) -> the in-memory link map, computer-keyed history and new-guest counter (5.4, 5.5).
// `now` is a clock function (default Date.now). Computer keys are only ever held as HMAC(salt, key) with a salt that lives in
// memory and is replaced every 24 h (the previous one kept a day more), so nothing held can be turned back into an address.
function createLinks({ now = Date.now, ttlMs = DAY, maxEntries = 50000, log = console.log } = {}) {
  const clock = typeof now === 'function' ? now : () => now;
  let salt = crypto.randomBytes(32), prev = null, saltAt = clock();
  const links = new Map();      // 'identityKey\n node' -> at (insertion order = age: a refresh moves it to the end)
  const bridges = new Map();    // 'newNode\n oldNode' -> at: one key under this and the previous salt is one computer
  const hist = [];              // { w: [nodes], l: [nodes], ranked, at } after every human result
  const guests = [];            // { nodes, at } per guest owner created
  let par = null, lastCapLog = -Infinity;

  const mac = (s, k) => crypto.createHmac('sha256', s).update(String(k)).digest().subarray(0, 16).toString('hex');
  function rotate() { const t = clock(); if (t - saltAt >= DAY) { prev = salt; salt = crypto.randomBytes(32); saltAt = t; par = null; } }
  // This key's node under the current salt, and under the previous one. Only the RECORDING calls (see, result, guestAdd)
  // pass bridge=true and store the pair; lookups never change the union-find, so two groups() taken one after the other
  // (seat A, then seat B) are always comparable. A root is the smallest node of its group, so a rebuild gives the same roots.
  function nodesOf(key, bridge) {
    rotate();
    const k = computerKey(key), cur = mac(salt, k);
    if (!prev) return [cur];
    const old = mac(prev, k), bk = cur + '\n' + old;
    if (bridge && !bridges.has(bk)) { bridges.set(bk, clock()); par = null; cap(bridges); }
    return [cur, old];
  }
  const cap = m => { while (m.size > maxEntries) m.delete(m.keys().next().value); };   // oldest first
  function prune() {
    rotate();
    const cut = clock() - ttlMs;
    for (const m of [links, bridges]) for (const [k, at] of m) { if (at >= cut) break; m.delete(k); }   // oldest first: refreshes move to the end
    let i = 0; while (i < hist.length && hist[i].at < cut) i++; if (i) hist.splice(0, i);
    i = 0; while (i < guests.length && guests[i].at < cut) i++; if (i) guests.splice(0, i);
    if (hist.length > maxEntries) hist.splice(0, hist.length - maxEntries);
    if (guests.length > maxEntries) guests.splice(0, guests.length - maxEntries);
    par = null;                                                                   // union-find is rebuilt lazily from what is left
  }
  const find = x => { if (!par.has(x)) return x; let r = x; while (par.get(r) !== r) r = par.get(r); par.set(x, r); return r; };
  function union(a, b) { if (!par.has(a)) par.set(a, a); if (!par.has(b)) par.set(b, b); const ra = find(a), rb = find(b); if (ra !== rb) par.set(ra < rb ? rb : ra, ra < rb ? ra : rb); }
  function build() {
    if (par) return;
    par = new Map(); const byId = new Map();
    for (const k of links.keys()) { const [id, node] = k.split('\n'); const first = byId.get(id); if (first) union(first, node); else { byId.set(id, node); union(node, node); } }
    for (const k of bridges.keys()) { const [a, b] = k.split('\n'); union(a, b); }
  }
  const groupsOfNodes = nodes => { build(); return new Set(nodes.map(find)); };
  const idKeys = ident => { const i = ident || {}, out = [], d = hex(i.devHash);
    if (d) out.push('d:' + d);
    if (i.accountId != null) out.push('a:' + i.accountId);
    if (typeof i.cid === 'string' && i.cid) out.push('c:' + crypto.createHash('sha256').update(i.cid).digest('hex'));   // a cid is kept only as its hash
    return out; };
  const nodesFor = (keys, bridge) => { const out = []; for (const k of keys instanceof Set || Array.isArray(keys) ? keys : []) out.push(...nodesOf(k, bridge)); return out; };

  return {
    // see(ident, computerKey): identify / tourAdd / hello / an /api call saw this identity ({ devHash, accountId, cid }) on this computer
    see(ident, key) {
      const ids = idKeys(ident); if (!ids.length) return;
      const [node] = nodesOf(key, true), t = clock();
      for (const id of ids) {
        const k = id + '\n' + node;
        if (links.has(k)) links.delete(k); else par = null;                       // a new pair may join two groups: rebuild the union-find lazily
        links.set(k, t);
      }
      if (links.size > maxEntries) { cap(links); par = null; }
    },
    // groups(computerKeys) -> Set of canonical roots (hashed): two seats are one computer when their groups meet (R5, R16)
    groups: keys => groupsOfNodes(nodesFor(keys)),
    // result(winnerKeys, loserKeys, ranked): remember a human result for R10 / R11 by computer (after the transaction, ranked or not)
    result(wk, lk, ranked) { hist.push({ w: nodesFor(wk, true), l: nodesFor(lk, true), ranked: !!ranked, at: clock() }); if (hist.length > maxEntries) hist.shift(); },
    // pair(keysA, keysB) -> ranked results in the last ttl between the two computer groups, either direction (R10 cpuPair24h)
    pair(ka, kb) {
      const ga = groupsOfNodes(nodesFor(ka)), gb = groupsOfNodes(nodesFor(kb)), cut = clock() - ttlMs; let n = 0;
      for (const e of hist) { if (e.at < cut || !e.ranked) continue; const w = groupsOfNodes(e.w), l = groupsOfNodes(e.l);
        if ((meets(w, ga) && meets(l, gb)) || (meets(w, gb) && meets(l, ga))) n++; }
      return n;
    },
    // loser(keys) -> { losses, distinctWinnerGroups } of this computer group in the last ttl, all results (R11 cpuLoser24h)
    loser(keys) {
      const g = groupsOfNodes(nodesFor(keys)), cut = clock() - ttlMs, winners = new Set(); let losses = 0;
      for (const e of hist) { if (e.at < cut || !meets(groupsOfNodes(e.l), g)) continue; losses++;
        const wg = [...groupsOfNodes(e.w)].sort(); if (wg.length) winners.add(wg[0]); }
      return { losses, distinctWinnerGroups: winners.size };
    },
    // guestOk(keys, cfg) -> may a NEW guest owner be created for this computer group now (5.5)? Checks only; guestAdd records.
    guestOk(keys, cfg) {
      const c = cfg || config({}), g = groupsOfNodes(nodesFor(keys)), t = clock(), cutDay = t - ttlMs, cutHour = t - HOUR;
      let day = 0, hour = 0;
      for (const e of guests) { if (e.at >= cutHour) hour++; if (e.at >= cutDay && meets(groupsOfNodes(e.nodes), g)) day++; }
      const ok = day < c.newGuestDay && hour < c.newGuestHour;
      if (!ok && t - lastCapLog >= HOUR) { lastCapLog = t; try { log('stats: new guest cap reached'); } catch { /* logging never breaks a match */ } }
      return ok;
    },
    // guestAdd(keys): a guest owner WAS created for this computer (call only when ownerForDevice reports created)
    guestAdd(keys) { guests.push({ nodes: nodesFor(keys, true), at: clock() }); if (guests.length > maxEntries) guests.shift(); },
    prune,                                                                        // drop entries past the ttl (game.js's once-a-minute tick); also rotates the salt when due
    size: () => ({ links: links.size, bridges: bridges.size, history: hist.length, guests: guests.length }),   // for tests
  };
}

module.exports = { BOT_ORDER, computerKey, rank, config, judge, why, titleCounts, createLinks };
