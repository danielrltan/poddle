// The share card (docs/SHARE.md 2): a player's rank (its emblem from web/emblems.js), Matt badge and best stats drawn as a 1200x630 SVG,
// turned into a PNG by @resvg/resvg-js.
// Pure until png(): dataOf picks exactly what is drawn (nothing from a request), hashOf names that picture, svgOf draws it. png() renders one
// card at a time in a worker thread, keeps the last 64 in memory, and answers null when the renderer is missing or fails, so
// the caller serves web/og.jpg. Nothing here throws out of png(), and nothing logs a name, a slug or an id.
const crypto = require('node:crypto'), path = require('node:path');

const CARD_V = 11;                                              // the design's version: part of every hash, so a new look gets a new ?v= and unfurlers fetch it again
const W = 1200, H = 630;
const FONTS = ['500', '800', '900'].map(w => path.join(__dirname, 'fonts', `mplus-rounded-1c-${w}.ttf`));   // latin subsets of the site's font (web/vendor/fonts), as TTF: resvg reads no woff2
const F = { 500: 'Rounded Mplus 1c Medium', 800: 'Rounded Mplus 1c ExtraBold', 900: 'Rounded Mplus 1c Black' };   // each weight is its own family in these files
const LEVEL = ['Rookie', 'Club', 'Pro', 'Tour'], ORDER = [0, 1, 3, 2];   // wire level -> name; the ladder in difficulty order (Tour is 3 on the wire, between Club and Pro)
// The rank emblems are the browser's own artwork: web/emblems.js (an ES module, loaded here through require(esm), Node 22.12+) exports the
// SVG sprite, the eight ranks and their colours (NOTES 124: a medal per division below Pro, `rank-<tier>-<div>`, and Pro's one, `rank-8`). Loaded once, lazily: if it ever fails, the card still renders, with the rank's name and no emblem
let EMB;
function emblems() {
  if (EMB !== undefined) return EMB;
  try {
    const E = require('../web/emblems.js');
    // every id in the sprite gets a prefix: the card's own defs have ids too (its drop-shadow filter is `sh`, as is the sprite's sheen)
    const pre = t => t.replace(/\bid="([^"]+)"/g, 'id="em-$1"').replace(/href="#([^"]+)"/g, 'href="#em-$1"').replace(/url\(#([^)]+)\)/g, 'url(#em-$1)');
    const S = pre(E.SPRITE), defs = (S.match(/<defs>([\s\S]*?)<\/defs>/) || [])[1];
    const top = E.RANKS.length, idOf = typeof E.emblemId === 'function' ? E.emblemId : (t, d) => (t === top ? `rank-${t}` : `rank-${t}-${d}`);   // the medal of a tier and division (Pro has one)
    const sym = {}; for (const r of E.RANKS) for (let d = 1; d <= (r.id === top ? 1 : 3); d++) { const id = idOf(r.id, d), m = S.match(new RegExp(`<symbol id="em-${id}" viewBox="0 0 64 64">([\\s\\S]*?)</symbol>`)); if (!m) throw new Error('sprite ' + id); sym[r.id + ':' + d] = m[1]; }
    if (!defs || top !== RANK_NAME.length) throw new Error('sprite');   // the table this file falls back on must agree with the art's
    EMB = { defs, sym: (t, d) => sym[t + ':' + (t === top ? 1 : d)] || sym[t + ':1'], ranks: E.RANKS, label: E.rankLabel, v: crypto.createHash('sha256').update(E.SPRITE + JSON.stringify(E.RANKS)).digest('hex').slice(0, 8) };   // v: a redrawn emblem is a new picture URL too
  } catch { EMB = null; }
  return EMB;
}
const RANK_NAME = require('./ladder.js').NAMES, ROMAN = ['', 'I', 'II', 'III'], TOP = RANK_NAME.length;   // server/ladder.js NAMES (eight: Master is tier 6, Pro tier 8); the names used if web/emblems.js did not load
const INK = ['#7e4512', '#6d7f8c', '#b8720a', '#1f7a86', '#0f7fae', '#9b1c3a', '#4f23a8', '#4a2f8a'];   // web/emblems.js RANKS colour.deep, the same fallback

const num = v => Number.isFinite(v) && v > 0 ? Math.floor(v) : 0;
const degs = v => Math.round(v * 180 / Math.PI / 10) * 10;      // rad/s -> deg/s rounded to 10, as Your stats shows it
const rows = p => ORDER.map(lv => (p && Array.isArray(p.matt) ? p.matt : []).find(x => x && x.level === lv) || {});   // the four Matt rows in difficulty order
const beaten = r => Number.isFinite(r.firstWinAt) && r.firstWinAt > 0;

// rankOf(profile) -> { name: 'Gold II', tier (1..7), div (1..3), trophies }: the trophy ladder, exactly what Your stats' hero shows (web/profile.js
// drawRoad, docs/RANKED.md 2: one rank per player). No ladder (no trophies yet, an older server) is Bronze I with 0 trophies, as there
const int = (v, a, b) => Number.isInteger(v) && v >= a && v <= b ? v : a;
function rankOf(p) {
  const L = p && p.ladder && typeof p.ladder === 'object' ? p.ladder : {}, tier = int(L.tier, 1, TOP), div = int(L.div, 1, 3), E = emblems();
  const pro = tier === TOP && p && p.places && p.places.trophies && Number.isInteger(p.places.trophies.rank) ? p.places.trophies.rank : null;   // Pro's global leaderboard place (NOTES 126), when the owner is listed
  return { name: tier === TOP ? `${RANK_NAME[TOP - 1]}${pro ? ' #' + pro : ''}` : E ? E.label(tier, div) : `${RANK_NAME[tier - 1]} ${ROMAN[div]}`, tier, div: tier === TOP ? 1 : div, pro, trophies: num(L.trophies) };
}
const mattOf = p => rows(p).map(beaten).lastIndexOf(true);      // the toughest Matt beaten, in difficulty order (0 Rookie .. 3 Pro), -1 for none
const FLAWLESS = 11, flawlessOf = (p, top) => top >= 0 && num(rows(p)[top].bestMargin) >= FLAWLESS;      // the toughest Matt beaten 11-0 at least once: bestMargin reaches WIN_AT only that way (web/profile.js FLAWLESS, NOTES 182)
// scoreOf(profile, top) -> '11-3': the best win's score against the toughest Matt beaten (db.js levelRow bestScore), null when none (NOTES 183)
const scoreOf = (p, top) => { const b = top >= 0 ? rows(p)[top].bestScore : null; return Array.isArray(b) && Number.isInteger(b[0]) && Number.isInteger(b[1]) && b[0] > b[1] && b[1] >= 0 && b[0] <= 99 ? `${b[0]}-${b[1]}` : null; };

// dataOf(profile, username, play?) -> exactly what the card draws (the hash is taken over this object). play: defaults to profile.play
// (db.profileOf; the tests pass their own). Every card draws the same eleven figures, in the same places, zeros included.
const clock = s => s >= 3600 ? `${Math.floor(s / 3600)}h ${Math.floor(s % 3600 / 60)}m` : s >= 60 ? `${Math.floor(s / 60)}m` : s ? '<1m' : '0m';   // web/profile.js clock: Your stats' "On court"
function dataOf(p, username, play) {
  p = p && typeof p === 'object' ? p : {};
  const P = play && typeof play === 'object' ? play : p.play && typeof p.play === 'object' ? p.play : {};
  const Hm = p.human && typeof p.human === 'object' ? p.human : {}, B = p.bests && typeof p.bests === 'object' ? p.bests : {};
  const best = k => B[k] && typeof B[k] === 'object' && Number.isFinite(B[k].v) && B[k].v > 0 ? B[k].v : 0;
  const rank = rankOf(p), w = num(Hm.wins), l = num(Hm.losses), streak = num(Hm.bestStreak);   // people only (kinds human + tour, db.js HUMAN): the global leaderboard's Win streak board, so the card and the board agree. Matt games are the badge's
  const chances = num(P.chances), returns = Math.min(num(P.returns), chances), rally = Math.round(best('rally')), speed = best('speed') ? degs(best('speed')) : 0;
  const pw = num(P.pointsWon), pl = num(P.pointsLost), titles = num(p.titles), secs = num(P.secs);
  const n3 = v => v.toLocaleString('en-US');   // 1,200 as Your stats shows counts
  const pct = (a, n) => n ? Math.round(100 * a / n) + '%' : '-';   // '-' only where there is nothing to divide yet, never for a real 0%
  // The SAME figures on every card, in the same places, zeros included (the owner: no selective stats, so cards compare at a glance).
  // hero: the three drawn big, each with its sub line; the rest are the detail grid. label: the long name (share.js words the og tags
  // from it, api.js playerRoute sends it); tag: the tile's short caps; cap: a short unit after the figure.
  const all = [
    { label: 'Win rate vs people', tag: 'Win rate', value: pct(w, w + l), sub: `${n3(w)}-${n3(l)} vs people`, hero: true },
    { label: 'Time on court', tag: 'On court', value: clock(secs), sub: 'all modes', hero: true },   // every counted match of every kind (people, Matt, tournaments): what Your stats' "On court" adds up
    { label: 'Best win streak vs people', tag: 'Best streak', value: n3(streak), sub: streak === 1 ? 'win vs people' : 'wins vs people', hero: true },
    { label: 'Return rate', tag: 'Returns', value: pct(returns, chances) },
    { label: 'Points won', tag: 'Points won', value: pct(pw, pw + pl) },
    { label: 'Longest rally', tag: 'Rally', value: String(rally), cap: 'hits' },
    { label: 'Fastest swing', tag: 'Swing', value: speed ? String(speed) : '-', cap: '°/s' },
    { label: 'Winners', tag: 'Winners', value: n3(num(P.winners)) },
    { label: 'Aces', tag: 'Aces', value: n3(num(P.aces)) },
    { label: 'Smashes', tag: 'Smashes', value: n3(num(P.smashes)) },
    { label: 'Tournament titles', tag: 'Titles', value: n3(titles) },
  ];
  const top = mattOf(p);
  const E = emblems();
  return { v: CARD_V, em: E ? E.v : null, name: username || 'Poddle player', guest: !username, rank: rank.name, tier: rank.tier, div: rank.div, pro: rank.pro, trophies: rank.trophies,
    matt: top < 0 ? null : LEVEL[ORDER[top]], mattI: top, mattFlawless: flawlessOf(p, top), mattScore: scoreOf(p, top), big: all,
    wl: [w, l], ret: chances ? returns / chances : 0 };   // the people strip's W and L and the return ring's arc (0..1), as Your stats draws them (api.js publicCard leaves both out: the eleven carry the words)
}
const hashOf = d => crypto.createHash('sha256').update(JSON.stringify(d)).digest('hex').slice(0, 12);   // ?v= and the ETag: a stat change is a new picture URL

// ---- text measure: advance widths (per 1000 em) of chars 32..126, then % ° · × –, from the TTFs' hmtx (no DOM here to measure with) ----
const XTRA = '%°·×–';
const ADV = {
  500: '277,350,428,684,584,844,702,258,380,379,508,734,303,474,314,493,630,630,630,630,630,630,630,630,630,630,394,392,674,754,674,624,824,642,609,624,669,594,579,694,694,334,539,604,589,824,694,724,614,728,616,564,634,664,642,863,616,617,624,484,493,484,612,576,260,544,589,494,589,529,509,574,584,324,364,538,324,789,579,564,584,584,464,504,509,574,522,769,502,521,544,524,364,524,675,844,404,314,578,472',
  800: '291,410,513,701,602,906,748,311,412,412,512,736,341,488,362,524,650,650,650,650,650,650,650,650,650,650,442,435,689,756,689,645,812,664,631,646,690,608,594,715,716,368,574,656,611,852,716,746,642,754,652,598,662,692,664,892,648,648,638,518,524,518,653,602,318,579,623,522,623,564,544,609,619,352,402,588,352,851,613,586,619,619,505,532,537,609,560,806,547,561,572,546,398,546,694,906,406,362,595,472',
  900: '298,440,556,709,611,936,772,336,430,430,506,736,359,496,386,542,660,660,660,660,660,660,660,660,660,660,466,457,696,756,696,656,806,676,641,656,701,616,601,726,726,386,591,682,621,866,726,756,656,767,669,616,676,706,676,906,665,662,646,536,542,536,675,616,348,596,641,536,641,581,561,626,636,366,421,613,366,881,631,596,636,636,526,546,551,626,577,824,570,582,586,556,416,556,709,936,406,386,605,472',
};
for (const k in ADV) ADV[k] = ADV[k].split(',').map(Number);
function measure(s, wt, size, ls = 0) {                         // -> px width of s at size, letter-spacing ls px
  const a = ADV[wt] || ADV[800]; let u = 0;
  for (const ch of String(s)) { const c = ch.codePointAt(0), x = XTRA.indexOf(ch); u += c >= 32 && c <= 126 ? a[c - 32] : x >= 0 ? a[95 + x] : 700; }
  return u * size / 1000 + ls * Math.max(0, [...String(s)].length - 1);
}
const fit = (s, wt, size, max, ls = 0) => Math.min(size, Math.floor(size * max / Math.max(1, measure(s, wt, size, ls))));   // the largest size up to `size` that fits `max` px

// ---- SVG ----
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const r2 = n => Math.round(n * 100) / 100;
function text(x, y, s, { size = 32, wt = 800, fill = '#39434d', anchor = 'start', ls = 0, extra = '' } = {}) {
  return `<text x="${r2(x)}" y="${r2(y)}" font-family="${F[wt]}" font-weight="${wt}" font-size="${r2(size)}"${ls ? ` letter-spacing="${r2(ls)}"` : ''} text-anchor="${anchor}" fill="${fill}"${extra}>${esc(s)}</text>`;
}
// The card is Your stats' public profile card (web/index.html #lbp-card, NOTES 164) drawn at 1200x630: the same sections in the same order, the
// same icons, web/ui.css's tokens at 1rem = 24px (K). A stranger reads the name, the figures and the one place to play: poddleball.com, small, in the corner.
const K = 24, C = { ink: '#4b535b', soft: '#65717b', faint: '#a7b2bb', me: '#3aa0ff', meDeep: '#1670d8', meInk: '#1b63b8', meTint: '#e3f1ff', them: '#ff9440', themDeep: '#e6561a', themInk: '#c4490f',
  sky1: '#f6fafd', sky2: '#eaf3f8', sky3: '#d9e9f2', sky4: '#c3dbe8', lineDeep: '#1a9fd0', lineSoft: '#a9e0f6', lineFaint: '#d6f0fa', gold1: '#fff1a6', gold2: '#ffd34a', gold3: '#f2a81d', gold4: '#c97f08', warnDeep: '#a86400' };   // web/ui.css :root
const MATT = '<circle cx="12" cy="8.25" r="4.25"/><path d="M5 20.5c.5-4.75 3.25-6.75 7-6.75s6.5 2 7 6.75Z"/><path d="M10.25 8.5v.75M13.75 8.5v.75M10.5 17.25h3" stroke-width="2.5"/>';   // web/index.html .st-mdisc: the Matt head, eyes and smile
const LV = [['#3ecf72', '#13803f'], ['#3aa0ff', '#1b63b8'], ['#a77bf3', '#6a3fc2'], [C.gold2, C.warnDeep]];   // .st-matt --lv / --lv-deep: Rookie green, Club blue, Tour purple, Pro gold
const ICON = {   // web/index.html's own paths (24-box, stroked): the people strip's header, the return ring, the three tiles' badges
  people: '<circle cx="9" cy="8" r="3.5"/><path d="M2.5 20a6.5 6.5 0 0 1 13 0M16 4.5a3.5 3.5 0 0 1 0 7M18 13.5a6 6 0 0 1 3.5 6.5"/>',
  ret: '<path d="M9.5 14.5 4.5 9.5l5-5M4.5 9.5h10a5 5 0 0 1 0 10H11"/>',
  cup: '<path d="M7 4h10v5a5 5 0 0 1-10 0Z"/><path d="M7 6H4v1.5A3.5 3.5 0 0 0 7.5 11M17 6h3v1.5a3.5 3.5 0 0 1-3.5 3.5M12 14v3M8.5 20h7M10 17h4v3h-4Z"/>',
  rally: '<rect x="4.5" y="2.5" width="11" height="13" rx="5.5"/><path d="M10 15.5v6"/><circle cx="19" cy="17.5" r="2.5"/>',
  swing: '<path d="M4 17a8 8 0 0 1 16 0"/><path d="M12 17l4.5-6"/><circle cx="12" cy="17" r="1.25"/>',
  flame: '<path d="M12 2c1 4.5 5.5 5.5 5.5 10.5a5.5 5.5 0 0 1-11 0c0-2 1-3.2 2.2-4.2 0 2 1 3.2 2.3 3.2 0-3.5-1-5.5 1-9.5Z"/>',
};
const icon = (x, y, S, body, stroke, w = 2.5, extra = '') => `<g transform="translate(${r2(x)} ${r2(y)}) scale(${r2(S / 24)})" fill="none" stroke="${stroke}" stroke-width="${w}" stroke-linecap="round" stroke-linejoin="round"${extra}>${body}</g>`;   // a 24-box icon, S px square, its top-left at x,y
const CUP = `<path d="M7 5.5H4.5a1 1 0 0 0-1 1V8a4 4 0 0 0 4 4M17 5.5h2.5a1 1 0 0 1 1 1V8a4 4 0 0 1-4 4" fill="none" stroke="${C.gold3}" stroke-width="2" stroke-linecap="round"/><path d="M6.5 3h11v6.5a5.5 5.5 0 0 1-11 0Z" fill="${C.gold2}" stroke="${C.gold3}" stroke-width="1.2" stroke-linejoin="round"/><path d="M10.5 14.5h3v3h-3Z" fill="${C.gold3}"/><rect x="7" y="17" width="10" height="4" rx="1.2" fill="${C.gold4}"/><path d="M9 5.5v3.8a3.2 3.2 0 0 0 1.4 2.6" fill="none" stroke="#fff" stroke-width="1.3" stroke-linecap="round" opacity=".75"/>`;   // web/ui.js CUP_SVG with .cup-ic's colours
const cup = (x, y, S) => `<g transform="translate(${r2(x)} ${r2(y)}) scale(${r2(S / 24)})">${CUP}</g>`;
const caps = (x, y, s, { size = 19.5, fill = C.soft, anchor = 'start' } = {}) => text(x, y, s.toUpperCase(), { size, wt: 800, fill, ls: size * 0.16, anchor });   // .caps: 800 (the subsets have no 700), tracked .16em

function ball(cx, cy, r) {                                       // web/favicon.svg, the Poddle ball, centred at cx,cy with radius r
  const k = r / 30.5, at = (x, y) => `${r2(cx + (x - 32) * k)}" cy="${r2(cy + (y - 32) * k)}`;
  const holes = [[32, 32, 4.7], [32.0, 15.0, 4.7], [46.72, 23.5, 4.7], [46.72, 40.5, 4.7], [32.0, 49.0, 4.7], [17.28, 40.5, 4.7], [17.28, 23.5, 4.7]];      // web/favicon.svg's seven even holes: one centred, six a ring apart
  return `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}" fill="url(#ball)"/><circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}" fill="url(#ballS)"/>` +
    `<g fill="#cfae00">${holes.map(([x, y, rr]) => `<circle cx="${at(x, y)}" r="${r2(rr * k)}"/>`).join('')}</g>` +
    `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r * 0.982)}" fill="none" stroke="#dcbc00" stroke-width="${r2(1.1 * k)}"/>`;
}
const inkOf = tier => { const E = emblems(), c = E ? E.ranks[tier - 1].colour.deep : INK[tier - 1] || INK[0];   // the rank's rim colour 15% darker, as text (web/ui.css --rank-ink mixed with black)
  return '#' + [1, 3, 5].map(k => Math.round(parseInt(c.slice(k, k + 2), 16) * 0.85).toString(16).padStart(2, '0')).join(''); };
const midOf = tier => { const E = emblems(); return E ? E.ranks[tier - 1].colour.mid : C.sky3; };   // the rank's own colour: .lbp-em's halo behind the medal
function emblem(cx, top, S, tier, div, pro) {                    // the rank's emblem (web/emblems.js, the symbol inlined, S px square from top) on its halo, the division on a pill over its lower edge (.st-em[data-div])
  const E = emblems(), cy = top + S / 2, ink = inkOf(tier);
  const art = E ? `<g transform="translate(${r2(cx - S / 2)} ${r2(top)}) scale(${r2(S / 64)})" filter="url(#emsh)">${E.sym(tier, div)}</g>` : '';
  const halo = `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(S * 0.66)}" fill="url(#halo)"/>`;
  if (tier === TOP && !pro) return halo + art;   // Pro has no divisions (NOTES 126): no numeral; its leaderboard place goes on the pill when known
  const R = tier === TOP ? '#' + pro : ROMAN[div] || 'I', fs = Math.round(S * 0.17), ph = Math.round(S * 0.25), pw = Math.max(ph * 1.3, measure(R, 900, fs, 1) + ph * 0.7), py = top + S * 0.86 - ph / 2;
  return halo + art +
    `<rect x="${r2(cx - pw / 2)}" y="${r2(py)}" width="${r2(pw)}" height="${ph}" rx="${ph / 2}" fill="#ffffff" stroke="#143c64" stroke-opacity=".14" stroke-width="1.5" filter="url(#sh1)"/>` +
    text(cx, py + ph / 2 + fs * 0.36, R, { size: fs, wt: 900, fill: ink, anchor: 'middle', ls: 1 });
}
// the tile surface (.st-people, .st-tile, .st-play, .st-matt): white to #eef5f9, a white rim, the gloss over its top half, the --sh-2 shadow
const tile = (x, y, w, h, rx = 36) => `<rect x="${r2(x)}" y="${r2(y)}" width="${r2(w)}" height="${r2(h)}" rx="${rx}" fill="url(#tile)" stroke="#ffffff" stroke-opacity=".9" stroke-width="3" filter="url(#sh2)"/>` +
  `<rect x="${r2(x + 6)}" y="${r2(y + 6)}" width="${r2(w - 12)}" height="${r2(h * 0.46)}" rx="${rx - 9}" fill="url(#gloss)"/>`;
// a figure's digits at the full size, its units (% h m) smaller, then the unit caption; no data ('-') is a grey en dash
const runs = s => String(s) === '-' ? ['–'] : String(s).match(/\d[\d,-]*|[^\d]+/g) || [''];
const small = (r, s) => r === '–' || /^\d/.test(r) ? s : Math.round(s * 0.6);
const widthOf = (v, s, cap) => runs(v).reduce((a, r) => a + measure(r, 900, small(r, s)), 0) + (cap && v !== '-' ? 6 + measure(cap, 800, Math.round(s * 0.55)) : 0);
function figure(x, y, v, s, fill, cap, anchor = 'start') {        // -> svg; anchor 'middle' centres the whole run on x
  let cx = anchor === 'middle' ? x - widthOf(v, s, cap) / 2 : x, o = '';
  for (const r of runs(v)) { const z = small(r, s); o += text(cx, y, r, { size: z, wt: 900, fill: r === '–' ? C.faint : fill }); cx += measure(r, 900, z); }
  if (cap && v !== '-') o += text(cx + 6, y, cap, { size: Math.round(s * 0.55), wt: 800, fill: C.soft });
  return o;
}

// svgOf(data) -> the SVG text, 1200x630. Everything drawn comes from `data`.
function svgOf(d) {
  const E = emblems(), out = [], mid = midOf(d.tier);
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  out.push(`<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3d9bf0"/><stop offset=".55" stop-color="#7cc6ff"/><stop offset="1" stop-color="#c4e8ff"/></linearGradient>
<pattern id="diag" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="12" height="28" fill="#ffffff" opacity=".07"/></pattern>
<pattern id="tex" width="21" height="21" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="9" height="21" fill="#34beed" opacity=".09"/></pattern>
<linearGradient id="panel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f6fafc"/><stop offset=".45" stop-color="#f3f8fb"/><stop offset="1" stop-color="#e7f1f6"/></linearGradient>
<linearGradient id="well" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${C.sky1}"/><stop offset="1" stop-color="${C.sky2}"/></linearGradient>
<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#f7fbfd"/><stop offset="1" stop-color="#eef5f9"/></linearGradient>
<linearGradient id="gloss" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#ffffff" stop-opacity=".3"/></linearGradient>
<linearGradient id="barMe" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#8fdcf7"/><stop offset=".5" stop-color="${C.me}"/><stop offset="1" stop-color="${C.meDeep}"/></linearGradient>
<linearGradient id="barThem" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffc98a"/><stop offset=".5" stop-color="${C.them}"/><stop offset="1" stop-color="${C.themDeep}"/></linearGradient>
<radialGradient id="halo"><stop offset="0" stop-color="${mid}" stop-opacity=".45"/><stop offset=".7" stop-color="${mid}" stop-opacity="0"/></radialGradient>
<radialGradient id="disc" cx=".35" cy=".3" r=".55"><stop offset="0" stop-color="#ffffff" stop-opacity=".55"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
<radialGradient id="ball" cx=".34" cy=".28" r=".977"><stop offset="0" stop-color="#fbffd6"/><stop offset=".58" stop-color="#e8fb2a"/><stop offset="1" stop-color="#ffe01a"/></radialGradient>
<linearGradient id="ballS" x1="0" y1="0" x2="0" y2="1"><stop offset=".62" stop-color="#ffcc00" stop-opacity="0"/><stop offset="1" stop-color="#ffcc00" stop-opacity=".42"/></linearGradient>
<filter id="sh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#143c64" flood-opacity=".26"/></filter>
<filter id="sh1" x="-20%" y="-20%" width="140%" height="160%"><feDropShadow dx="0" dy="2" stdDeviation="2" flood-color="#285070" flood-opacity=".14"/></filter>
<filter id="sh2" x="-5%" y="-10%" width="110%" height="130%"><feDropShadow dx="0" dy="3" stdDeviation="0" flood-color="#5a96b9" flood-opacity=".22"/><feDropShadow dx="0" dy="6" stdDeviation="6" flood-color="#285070" flood-opacity=".12"/></filter>
<filter id="emsh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="2.5" stdDeviation="2.5" flood-color="#143c64" flood-opacity=".3"/></filter>
${E ? E.defs : ''}
</defs>`);
  out.push(`<rect width="${W}" height="${H}" fill="url(#sky)"/><rect width="${W}" height="${H}" fill="url(#diag)"/>`);
  // the panel (.panel-sm): the card itself, over the game's sky
  const px = 24, py = 24, pw = W - 48, ph = H - 48, x0 = px + 30, iw = pw - 60, xr = x0 + iw;
  out.push(`<rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="36" fill="url(#panel)" stroke="${C.lineSoft}" stroke-width="3" filter="url(#sh)"/>`);
  // the head: the name, and poddleball.com with the ball in the corner (the whole brand: small, like a footer, never a button)
  const site = 'poddleball.com', sw = measure(site, 800, 28), sx = xr - sw;
  out.push(ball(sx - 14 - 17, 76, 17) + text(sx, 86, site, { size: 28, wt: 800, fill: C.meInk }));
  out.push(text(x0, 90, d.name, { size: fit(d.name, 900, 45, sx - 48 - x0), wt: 900, fill: d.guest ? C.soft : C.ink }));   // no username: the generic words in grey
  // row 1: the hero well (the emblem on its halo, the rank, the trophies) and the Matt tile (the toughest level beaten on a disc in its colour)
  const y1 = 108, h1 = 132, hw = 620;
  out.push(`<rect x="${x0}" y="${y1}" width="${hw}" height="${h1}" rx="36" fill="url(#well)" stroke="${C.lineFaint}" stroke-width="3"/><rect x="${x0}" y="${y1}" width="${hw}" height="${h1}" rx="36" fill="url(#tex)"/>`);
  const ES = 104, ex = x0 + 16 + 69;
  out.push(emblem(ex, y1 + (h1 - ES) / 2, ES, d.tier, d.div, d.pro));
  const rx0 = x0 + 16 + 138 + 28;
  out.push(text(rx0, y1 + 60, d.rank, { size: fit(d.rank, 900, 48, hw - (rx0 - x0) - 20, 1), wt: 900, fill: C.meInk, ls: 1 }));
  { const tro = String(d.trophies), nw = measure(tro, 900, 26);   // the count, then the gold trophy for the word (NOTES 136, web/ui.js CUP_SVG)
    out.push(text(rx0, y1 + 102, tro, { size: 26, wt: 900, fill: C.ink })); out.push(cup(rx0 + nw + 8, y1 + 102 - 25, 32)); }
  const mx = x0 + hw + 12, mw = xr - mx;
  out.push(tile(mx, y1, mw, h1));
  { const lv = d.matt ? LV[d.mattI] || LV[0] : null, cx = mx + 20 + 42, cy = y1 + h1 / 2, R = 42;
    if (!lv) out.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="${C.sky3}" stroke="#ffffff" stroke-width="6"/><circle cx="${cx}" cy="${cy}" r="${R + 4.5}" fill="none" stroke="${C.sky4}" stroke-width="3"/>`);   // .st-mbadge.is-none: a quiet disc
    else if (d.mattFlawless) out.push(`<circle cx="${cx}" cy="${cy}" r="${R + 10.5}" fill="none" stroke="${C.gold1}" stroke-width="4.5"/><circle cx="${cx}" cy="${cy}" r="${R + 5.25}" fill="none" stroke="${C.gold3}" stroke-width="4.5"/><circle cx="${cx}" cy="${cy}" r="${R}" fill="${lv[0]}" stroke="${C.gold1}" stroke-width="6"/>`);   // beaten 11-0: the gold rings (NOTES 182)
    else out.push(`<circle cx="${cx}" cy="${cy}" r="${R + 4.5}" fill="none" stroke="${lv[1]}" stroke-width="3"/><circle cx="${cx}" cy="${cy}" r="${R}" fill="${lv[0]}" stroke="#ffffff" stroke-width="6"/>`);
    if (lv) out.push(`<circle cx="${cx}" cy="${cy}" r="${R - 3}" fill="url(#disc)"/>`);
    out.push(icon(cx - 25, cy - 25, 50, MATT, lv ? '#ffffff' : C.soft, 2.25, lv ? ' filter="url(#sh1)"' : ''));
    const tx = cx + R + 24, s = d.matt || 'None yet', fs = fit(s, 900, 42, xr - 20 - tx);      // the level alone under 'Highest Matt level passed', as Your stats and the public card (NOTES 185)
    const sc = d.mattScore || (d.mattFlawless ? '11-0' : null);   // the best score against that Matt (NOTES 183), under the level as #lbp-mscore: "Best 11–7"
    out.push(caps(tx, y1 + (sc ? 42 : 50), 'Highest Matt level passed'));
    out.push(text(tx, y1 + (sc ? 88 : 100), s, { size: fs, wt: 900, fill: lv ? lv[1] : C.soft }));
    if (sc) out.push(text(tx, y1 + 116, `Best ${sc.replace('-', '\u2013')}`, { size: 19.5, wt: 800, fill: d.mattFlawless ? C.warnDeep : C.soft }));
  }
  // row 2: the people strip: the W-L in the two sides' colours, the bar between them, the best streak chip
  const y2 = y1 + h1 + 12, h2 = 108, win = d.big[0], streak = d.big[2];
  out.push(tile(x0, y2, iw, h2));
  out.push(icon(x0 + 20, y2 + 14, 30, ICON.people, C.lineDeep) + caps(x0 + 20 + 38, y2 + 36, 'Online multiplayer'));
  { const [w, l] = d.wl, W3 = w.toLocaleString('en-US'), L3 = l.toLocaleString('en-US'), nb = y2 + 88, wx = x0 + 20, ww = measure(W3, 900, 54), lx = wx + ww + 12 + 24 + 12, lw = measure(L3, 900, 54);
    out.push(text(wx, nb, W3, { size: 54, wt: 900, fill: C.meInk }) + `<rect x="${r2(wx + ww + 12)}" y="${nb - 22}" width="24" height="9" rx="4.5" fill="${C.faint}"/>` + text(lx, nb, L3, { size: 54, wt: 900, fill: C.themInk }));
    out.push(text(lx + lw + 10, nb, 'W-L', { size: 19.5, wt: 800, fill: C.soft, ls: 1.2 }));
    // the chip: Best (flame) n
    const cl = 'Best', n3 = streak.value, cwid = 24 + measure(cl, 800, 19.5) + 6 + 24 + 4 + measure(n3, 900, 19.5) + 24, chx = xr - 20 - cwid, chy = y2 + 48;
    out.push(`<rect x="${r2(chx)}" y="${chy}" width="${r2(cwid)}" height="42" rx="21" fill="${C.sky2}"/>` + text(chx + 24, chy + 28, cl, { size: 19.5, wt: 800, fill: C.soft }));
    const fx = chx + 24 + measure(cl, 800, 19.5) + 6;
    out.push(`<g transform="translate(${r2(fx)} ${chy + 9}) scale(1)" fill="${C.them}" stroke="${C.themDeep}" stroke-width="1.5" stroke-linejoin="round">${ICON.flame}</g>` + text(fx + 28, chy + 28, n3, { size: 19.5, wt: 900, fill: C.ink }));
    // the bar: the won share in blue, the rest in orange, its label under the left end
    const bx = lx + lw + 10 + measure('W-L', 800, 19.5, 1.2) + 28, bw = chx - 28 - bx, by = y2 + 50, bh = 21, n = w + l;
    out.push(`<rect x="${r2(bx)}" y="${by}" width="${r2(bw)}" height="${bh}" rx="${bh / 2}" fill="${C.sky3}"/>`);
    if (n) { const mw2 = Math.round(bw * w / n);
      out.push(`<clipPath id="bar"><rect x="${r2(bx)}" y="${by}" width="${r2(bw)}" height="${bh}" rx="${bh / 2}"/></clipPath><g clip-path="url(#bar)"><rect x="${r2(bx)}" y="${by}" width="${r2(bw)}" height="${bh}" fill="url(#barThem)"/><rect x="${r2(bx)}" y="${by}" width="${r2(mw2)}" height="${bh}" rx="${bh / 2}" fill="url(#barMe)"/></g>`);
      out.push(text(bx, by + bh + 24, `${win.value} won`, { size: 19.5, wt: 800, fill: C.meInk })); }
  }
  // row 3: the play row: the return rate on its ring, a hairline, then five figures in Your stats' order
  const y3 = y2 + h2 + 12, h3 = 108, ret = d.big[3];
  out.push(tile(x0, y3, iw, h3));
  { const cx = x0 + 20 + 48, cy = y3 + h3 / 2, R = 39;
    out.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${C.sky3}" stroke-width="10"/>`);
    if (d.ret > 0) { const L = 2 * Math.PI * R; out.push(`<circle cx="${cx}" cy="${cy}" r="${R}" fill="none" stroke="${C.me}" stroke-width="10" stroke-linecap="round" stroke-dasharray="${r2(L * Math.min(1, d.ret))} ${r2(L)}" transform="rotate(-90 ${cx} ${cy})" filter="url(#sh1)"/>`); }   // .st-ring.is-zero draws no arc: a round cap would still be a dot
    out.push(icon(cx - 19.5, cy - 19.5, 39, ICON.ret, C.meInk));
    const tx = cx + R + 18;
    out.push(caps(tx, y3 + 40, 'Return rate'));
    out.push(figure(tx, y3 + 86, ret.value, 48, C.meInk));
    const hx = tx + Math.max(measure('RETURN RATE', 800, 19.5, 3.1), widthOf('100%', 48)) + 24;
    out.push(`<rect x="${r2(hx)}" y="${y3 + 16}" width="3" height="${h3 - 32}" rx="1.5" fill="${C.sky2}"/>`);
    const figs = [7, 8, 9, 4, 1].map(i => d.big[i]), fx0 = hx + 24, fw = (xr - 20 - fx0 - 9 * 4) / 5, fy = y3 + 16, fh = h3 - 32;
    const fs = Math.min(32, ...figs.map(b => Math.floor(32 * (fw - 16) / Math.max(1, widthOf(b.value, 32)))));   // one size for the five
    figs.forEach((b, i) => { const x = fx0 + i * (fw + 9);
      out.push(`<rect x="${r2(x)}" y="${fy}" width="${r2(fw)}" height="${fh}" rx="24" fill="${C.sky1}" stroke="${C.sky2}" stroke-width="3"/>`);
      out.push(figure(x + fw / 2, fy + 40, b.value, fs, C.meInk, null, 'middle'));
      out.push(text(x + fw / 2, fy + 64, b.tag.toUpperCase(), { size: fit(b.tag.toUpperCase(), 800, 16.5, fw - 16, 0.6), wt: 800, fill: C.soft, anchor: 'middle', ls: 0.6 })); });
  }
  // row 4: the three tiles (personal bests), each with its badge icon in the corner
  const y4 = y3 + h3 + 12, h4 = H - 24 - 22 - y4, tw = (iw - 24) / 3;
  [[d.big[10], 'Tournaments won', ICON.cup], [d.big[5], 'Longest rally', ICON.rally], [d.big[6], 'Fastest swing', ICON.swing]].forEach(([b, label, ic], i) => {
    const x = x0 + i * (tw + 12);
    out.push(tile(x, y4, tw, h4));
    out.push(caps(x + 20, y4 + 32, label));
    out.push(figure(x + 20, y4 + 80, b.value, 48, C.meInk, b.cap));
    const bx = x + tw - 20 - 27, by = y4 + 12 + 27;   // .st-badge: a disc in the player's tint, the icon in the player's ink
    out.push(`<circle cx="${r2(bx)}" cy="${by}" r="27" fill="${C.meTint}" stroke="#ffffff" stroke-width="3" filter="url(#sh1)"/>` + icon(bx - 15, by - 15, 30, ic, C.meInk));
  });
  out.push('</svg>');
  return out.join('\n');
}

// ---- rendering: in one worker thread (resvg's render AND its PNG encode would otherwise take the 60 Hz loop's time), one card at a time, the last 64 kept ----
const OPTS = { fitTo: { mode: 'original' }, font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: F[800] } };
const JOB_MS = 15e3, RESPAWN_MS = 60e3;                           // a card that takes longer is abandoned (the worker with it); a dead worker is replaced at most once a minute
// gc after every job: each render leaves ~3.5 MB of NATIVE memory (resvg's pixmap, tree and PNG) that is freed only when V8 collects its
// handles, and the worker's JS heap stays near 4 MB, so V8 almost never does: a burst of renders took the process past the 256 MB VM
const WORKER = `const { parentPort, workerData } = require('node:worker_threads'); let gc = () => {}; try { require('node:v8').setFlagsFromString('--expose-gc'); gc = require('node:vm').runInNewContext('gc'); } catch { /* no gc: renders still work */ }
let R = null; try { R = require(workerData.lib); } catch { /* answered as null below */ }
parentPort.on('message', ({ id, svg }) => { let buf = null; try { if (R) buf = new R.Resvg(svg, workerData.opts).render().asPng(); } catch { buf = null; } parentPort.postMessage({ id, buf }); buf = null; setImmediate(() => { try { gc(); } catch { /* next time */ } }); });`;
let libPath, worker = null, diedAt = -Infinity, jobN = 0, failAt = -Infinity;
const jobs = new Map();                                          // job id -> { done, timer }
const lib = () => { if (libPath !== undefined) return libPath; try { libPath = require.resolve('@resvg/resvg-js'); } catch { libPath = null; } return libPath; };   // resolved here, loaded in the worker
function say(line) { const t = Date.now(); if (t - failAt < 3600e3) return; failAt = t; console.log(line); }   // one line an hour, never a name or a slug
function kill() { const w = worker; worker = null; diedAt = Date.now(); for (const [id, j] of jobs) { clearTimeout(j.timer); jobs.delete(id); j.done(null); } try { if (w) w.terminate().catch(() => {}); } catch { /* gone */ } }
function spawn() {
  if (worker) return worker; if (Date.now() - diedAt < RESPAWN_MS) return null;
  try {
    const { Worker } = require('node:worker_threads');
    const w = new Worker(WORKER, { eval: true, workerData: { lib: libPath, opts: OPTS }, resourceLimits: { maxOldGenerationSizeMb: 64 } });
    w.on('message', m => { const j = m && jobs.get(m.id); if (!j) return; jobs.delete(m.id); clearTimeout(j.timer); j.done(m.buf ? Buffer.from(m.buf.buffer, m.buf.byteOffset, m.buf.byteLength) : null); });
    w.on('error', () => { if (worker === w) kill(); }); w.on('exit', () => { if (worker === w) kill(); });
    w.unref(); worker = w; return w;
  } catch { diedAt = Date.now(); return null; }
}
function inWorker(svg) {                                         // -> Promise<Buffer | null>, never rejects
  return new Promise(done => {
    const w = spawn(); if (!w) return done(null);
    const id = ++jobN, timer = setTimeout(() => { if (jobs.has(id)) kill(); }, JOB_MS); if (timer.unref) timer.unref();
    jobs.set(id, { done, timer });
    try { w.postMessage({ id, svg }); } catch { jobs.delete(id); clearTimeout(timer); done(null); }
  });
}
const cache = new Map(), CACHE_MAX = 64, inflight = new Map();
let chain = Promise.resolve(), pending = 0;
const QUEUE_MAX = 16;
const cached = key => { const b = cache.get(key); if (b) { cache.delete(key); cache.set(key, b); } return b || null; };   // LRU: a hit moves to the back
// png(key, data) -> Promise<Buffer | null | 'busy'>, never rejects. null: no renderer or a failed render (serve web/og.jpg); 'busy': the queue is full.
function png(key, data) {
  const hit = cached(key); if (hit) return Promise.resolve(hit);
  if (inflight.has(key)) return inflight.get(key);
  if (!lib()) { say('card: renderer unavailable, serving og.jpg'); return Promise.resolve(null); }
  if (pending >= QUEUE_MAX) return Promise.resolve('busy');
  pending++;
  const p = chain.then(async () => {
    let svg; try { svg = svgOf(data); } catch { return null; }
    const buf = await inWorker(svg);
    if (!buf) { say('card: render failed, serving og.jpg'); return null; }
    cache.set(key, buf); while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value); return buf;
  }).catch(() => null).finally(() => { pending--; inflight.delete(key); });
  chain = p; inflight.set(key, p);
  return p;
}
const isCached = key => cache.has(key);
function forget(slug) { for (const k of [...cache.keys()]) if (k.startsWith(slug + ':')) cache.delete(k); }   // a link that went: its pictures leave memory too (never served anyway: share.page() checks the owner first)

module.exports = { rankOf, mattOf, dataOf, hashOf, svgOf, png, isCached, forget, measure, CARD_V, FONTS, F, W, H };
