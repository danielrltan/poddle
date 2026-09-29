// The share card (docs/SHARE.md 2): a player's Ranked rank (its emblem from web/emblems.js), Matt badge and best stats drawn as a 1200x630 SVG,
// turned into a PNG by @resvg/resvg-js.
// Pure until png(): dataOf picks exactly what is drawn (nothing from a request), hashOf names that picture, svgOf draws it. png() renders one
// card at a time in a worker thread, keeps the last 64 in memory, and answers null when the renderer is missing or fails, so
// the caller serves web/og.jpg. Nothing here throws out of png(), and nothing logs a name, a slug or an id.
const crypto = require('node:crypto'), path = require('node:path');

const CARD_V = 8;                                                // the design's version: part of every hash, so a new look gets a new ?v= and unfurlers fetch it again
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

// rankOf(profile) -> { name: 'Gold II', tier (1..7), div (1..3), trophies }: the Ranked ladder, exactly what Your stats' hero shows (web/profile.js
// drawRoad, docs/RANKED.md 2: one rank per player). No ladder (never played Ranked, an older server) is Bronze I with 0 trophies, as there
const int = (v, a, b) => Number.isInteger(v) && v >= a && v <= b ? v : a;
function rankOf(p) {
  const L = p && p.ladder && typeof p.ladder === 'object' ? p.ladder : {}, tier = int(L.tier, 1, TOP), div = int(L.div, 1, 3), E = emblems();
  const pro = tier === TOP && p && p.places && p.places.trophies && Number.isInteger(p.places.trophies.rank) ? p.places.trophies.rank : null;   // Pro's global leaderboard place (NOTES 126), when the owner is listed
  return { name: tier === TOP ? `${RANK_NAME[TOP - 1]}${pro ? ' #' + pro : ''}` : E ? E.label(tier, div) : `${RANK_NAME[tier - 1]} ${ROMAN[div]}`, tier, div: tier === TOP ? 1 : div, pro, trophies: num(L.trophies) };
}
const mattOf = p => rows(p).map(beaten).lastIndexOf(true);      // the toughest Matt beaten, in difficulty order (0 Rookie .. 3 Pro), -1 for none

// dataOf(profile, username, play?) -> exactly what the card draws (the hash is taken over this object). play: defaults to profile.play
// (db.profileOf; the tests pass their own). Every card draws the same six figures (zeros too).
function dataOf(p, username, play) {
  p = p && typeof p === 'object' ? p : {};
  const P = play && typeof play === 'object' ? play : p.play && typeof p.play === 'object' ? p.play : {};
  const Hm = p.human && typeof p.human === 'object' ? p.human : {}, B = p.bests && typeof p.bests === 'object' ? p.bests : {};
  const best = k => B[k] && typeof B[k] === 'object' && Number.isFinite(B[k].v) && B[k].v > 0 ? B[k].v : 0;
  const rank = rankOf(p), w = num(Hm.wins), l = num(Hm.losses), streak = Math.max(num(Hm.bestStreak), ...rows(p).map(r => num(r.bestStreak)));
  const chances = num(P.chances), returns = Math.min(num(P.returns), chances), rally = Math.round(best('rally')), speed = best('speed') ? degs(best('speed')) : 0;
  const titles = num(p.titles), aces = num(P.aces), winners = num(P.winners), smashes = num(P.smashes), played = num(p.played);
  // The SAME six figures on every card, in the same places, zeros included (the owner: no selective stats, so cards compare at a glance).
  // label: the long name (share.js words the og tags from it); tag + cap: what the tile draws. '-' only where there is no data at all
  // (no chance to return a ball yet, no measured swing), never for a real zero.
  const rate = chances ? Math.round(100 * returns / chances) : null;
  const all = [
    { label: 'Return rate', tag: 'Returns', value: rate == null ? '-' : rate + '%', bar: rate == null ? 0 : rate },
    { label: 'Longest rally', tag: 'Rally', value: String(rally), cap: 'hits' },
    { label: 'Fastest swing', tag: 'Swing', value: speed ? String(speed) : '-', cap: '°/s' },
    { label: 'Record vs people', tag: 'Vs people', value: `${w}-${l}` },
    { label: 'Best streak', tag: 'Best streak', value: String(streak) },
    { label: 'Winners', tag: 'Winners', value: String(winners) },
  ];
  void titles; void aces; void smashes; void played;               // on Your stats, not on the card: six fixed figures fit the panel legibly
  const top = mattOf(p);
  const E = emblems();
  return { v: CARD_V, em: E ? E.v : null, name: username || 'Poddle player', guest: !username, rank: rank.name, tier: rank.tier, div: rank.div, pro: rank.pro, trophies: rank.trophies,
    matt: top < 0 ? null : LEVEL[ORDER[top]], mattI: top, big: all };
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
const MATT = '<circle cx="12" cy="8.25" r="4.25"/><path d="M5 20.5c.5-4.75 3.25-6.75 7-6.75s6.5 2 7 6.75Z"/>';   // web/index.html .st-mdisc, the Matt head
const LV = [['#3ecf72', '#13803f', '#e2f8ea'], ['#3aa0ff', '#1b63b8', '#e3f1ff'], ['#a77bf3', '#6a3fc2', '#f1e9ff'], ['#ffd34a', '#a86400', '#fff4c9']];   // .st-matt Rookie green, Club blue, Tour purple, Pro gold

function ball(cx, cy, r) {                                       // web/favicon.svg, the Poddle ball, centred at cx,cy with radius r
  const k = r / 30.5, at = (x, y) => `${r2(cx + (x - 32) * k)}" cy="${r2(cy + (y - 32) * k)}`;
  const holes = [[32, 32, 4.7], [32.0, 15.0, 4.7], [46.72, 23.5, 4.7], [46.72, 40.5, 4.7], [32.0, 49.0, 4.7], [17.28, 40.5, 4.7], [17.28, 23.5, 4.7]];      // web/favicon.svg's seven even holes: one centred, six a ring apart
  return `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}" fill="url(#ball)"/><circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r)}" fill="url(#ballS)"/>` +
    `<g fill="#a9b912">${holes.map(([x, y, rr]) => `<circle cx="${at(x, y)}" r="${r2(rr * k)}"/>`).join('')}</g>` +
    `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(r * 0.982)}" fill="none" stroke="#a3b310" stroke-width="${r2(1.1 * k)}"/>`;
}
function wordmark(x, base, S, fill) {                            // web/ui.css .logo-mark: P, the ball as the o, ddle. -> [svg, width]
  const P = measure('P', 900, S), d = measure('ddle', 900, S), br = 0.31 * S, gap = 0.035 * S, bx = x + P + gap + br;
  const svg = text(x, base, 'P', { size: S, wt: 900, fill }) + ball(bx, base - 0.35 * S, br) + text(bx + br + gap, base, 'ddle', { size: S, wt: 900, fill });
  return [svg, P + 2 * gap + 2 * br + d];
}
const inkOf = tier => { const E = emblems(), c = E ? E.ranks[tier - 1].colour.deep : INK[tier - 1] || INK[0];   // the rank's rim colour 15% darker, as text (web/ui.css --rank-ink mixed with black)
  return '#' + [1, 3, 5].map(k => Math.round(parseInt(c.slice(k, k + 2), 16) * 0.85).toString(16).padStart(2, '0')).join(''); };
function emblem(cx, top, S, tier, div, pro) {                         // the rank's emblem (web/emblems.js, the symbol inlined, S px square from top), a glow behind it, rays from Platinum up, the division on a pill over its lower edge
  const E = emblems(), cy = top + S / 2, ink = inkOf(tier);
  let rays = '';
  if (tier >= 4) { const n = 18, R2 = S * 0.74; for (let i = 0; i < n; i++) { const a0 = (i / n) * 2 * Math.PI - Math.PI / 2, a1 = a0 + Math.PI / n * 0.8;
    rays += `M${r2(cx)} ${r2(cy)}L${r2(cx + R2 * Math.cos(a0))} ${r2(cy + R2 * Math.sin(a0))}L${r2(cx + R2 * Math.cos(a1))} ${r2(cy + R2 * Math.sin(a1))}Z`; } }
  const art = E ? `<g transform="translate(${r2(cx - S / 2)} ${r2(top)}) scale(${r2(S / 64)})" filter="url(#emsh)">${E.sym(tier, div)}</g>` : '';
  if (tier === TOP && !pro) return `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(S * 0.72)}" fill="url(#glow)"/>` + (rays ? `<clipPath id="rays"><rect x="0" y="${r2(top - 2)}" width="${r2(2 * cx)}" height="${r2(S + 60)}"/></clipPath><path d="${rays}" fill="#ffffff" opacity=".45" clip-path="url(#rays)"/>` : '') + art;   // Pro has no divisions (NOTES 126): no numeral; its leaderboard place goes on the pill when known (below)
  const R = tier === TOP ? '#' + pro : ROMAN[div] || 'I', fs = 30, pw = Math.max(52, measure(R, 900, fs, 2) + 30), ph = 42, py = top + S * 0.86 - ph / 2;   // .st-em[data-div]: a white pill over the lower edge, the numeral in the rank's ink
  return `<circle cx="${r2(cx)}" cy="${r2(cy)}" r="${r2(S * 0.72)}" fill="url(#glow)"/>` +
    (rays ? `<clipPath id="rays"><rect x="0" y="${r2(top - 2)}" width="${r2(2 * cx)}" height="${r2(S + 60)}"/></clipPath><path d="${rays}" fill="#ffffff" opacity=".45" clip-path="url(#rays)"/>` : '') + art +   // the rays stop under the PICKLEBALL tagline and above the rank's name
    `<rect x="${r2(cx - pw / 2)}" y="${r2(py)}" width="${r2(pw)}" height="${ph}" rx="${ph / 2}" fill="#ffffff" stroke="#143c64" stroke-opacity=".14" stroke-width="2" filter="url(#sh)"/>` +
    text(cx, py + ph / 2 + fs * 0.36, R, { size: fs, wt: 900, fill: ink, anchor: 'middle', ls: 2 });
}

// svgOf(data) -> the SVG text, 1200x630. Everything drawn comes from `data`.
function svgOf(d) {
  const E = emblems(), ink = inkOf(d.tier), out = [];
  out.push(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}">`);
  out.push(`<defs>
<linearGradient id="sky" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#3d9bf0"/><stop offset=".55" stop-color="#7cc6ff"/><stop offset="1" stop-color="#c4e8ff"/></linearGradient>
<pattern id="diag" width="28" height="28" patternUnits="userSpaceOnUse" patternTransform="rotate(-45)"><rect width="12" height="28" fill="#ffffff" opacity=".07"/></pattern>
<radialGradient id="glow"><stop offset="0" stop-color="#ffffff" stop-opacity=".75"/><stop offset=".55" stop-color="#ffffff" stop-opacity=".22"/><stop offset="1" stop-color="#ffffff" stop-opacity="0"/></radialGradient>
<linearGradient id="panel" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset=".6" stop-color="#f7fbfd"/><stop offset="1" stop-color="#eaf3f8"/></linearGradient>
<linearGradient id="tile" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#f2f8fc"/><stop offset="1" stop-color="#e2eff7"/></linearGradient>
<linearGradient id="bar" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="#7cc6ff"/><stop offset="1" stop-color="#1670d8"/></linearGradient>
<linearGradient id="cta" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#5ab6ff"/><stop offset=".5" stop-color="#3aa0ff"/><stop offset=".52" stop-color="#2b8df2"/><stop offset="1" stop-color="#1670d8"/></linearGradient>
<linearGradient id="gold" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff1a6"/><stop offset=".5" stop-color="#ffd34a"/><stop offset="1" stop-color="#f2a81d"/></linearGradient>
<radialGradient id="ball" cx=".34" cy=".28" r=".977"><stop offset="0" stop-color="#fbffa8"/><stop offset=".58" stop-color="#e6f03c"/><stop offset="1" stop-color="#c5d124"/></radialGradient>
<linearGradient id="ballS" x1="0" y1="0" x2="0" y2="1"><stop offset=".62" stop-color="#5a6e00" stop-opacity="0"/><stop offset="1" stop-color="#5a6e00" stop-opacity=".3"/></linearGradient>
<filter id="sh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="6" stdDeviation="8" flood-color="#143c64" flood-opacity=".26"/></filter>
<filter id="lift" x="-10%" y="-20%" width="120%" height="160%"><feDropShadow dx="0" dy="4" stdDeviation="0" flood-color="#ffffff" flood-opacity=".85"/></filter>
<filter id="emsh" x="-20%" y="-20%" width="140%" height="150%"><feDropShadow dx="0" dy="2.5" stdDeviation="2.5" flood-color="#143c64" flood-opacity=".3"/></filter>
${E ? E.defs : ''}
</defs>`);
  out.push(`<rect width="${W}" height="${H}" fill="url(#sky)"/><rect width="${W}" height="${H}" fill="url(#diag)"/>`);
  // left: the wordmark and what the game is (a stranger in a feed has never heard of Poddle), the rank emblem, the rank, the trophies, the Matt badge
  const cx = 198, [wm, ww] = wordmark(0, 0, 60, '#39434d');
  out.push(`<g transform="translate(${r2(cx - ww / 2)} 82)" filter="url(#lift)">${wm}</g>`);
  out.push(text(cx + 3, 124, 'PICKLEBALL', { size: 28, wt: 900, fill: '#0e3f8c', anchor: 'middle', ls: 6, extra: ' filter="url(#lift)"' }));   // +3: half the trailing letter-spacing, so it centres on the wordmark
  const lh = 330 + 70 + 64, top = 132 + Math.max(0, (474 - lh) / 2);   // the trophies and the bot badge always show: every card's left column is laid out the same   // the emblem, the rank and its pills, centred under the tagline
  out.push(emblem(cx, top + 4, 222, d.tier, d.div, d.pro));
  const rk = d.rank.toUpperCase();
  out.push(text(cx, top + 290, rk, { size: fit(rk, 900, 58, 340, 3), wt: 900, fill: '#ffffff', anchor: 'middle', ls: 3, extra: ' stroke="#0e3f8c" stroke-width="10" stroke-linejoin="round" paint-order="stroke"' }));
  let ly = top + 314;
  {
    const tro = String(d.trophies), nw = measure(tro, 800, 28), IC = 34, tw = nw + 8 + IC + 44, x0 = cx - tw / 2 + 22;      // the number, then the gold trophy for the word (NOTES 138, web/ui.js CUP_SVG)
    out.push(`<rect x="${r2(cx - tw / 2)}" y="${ly}" width="${r2(tw)}" height="46" rx="23" fill="url(#gold)" stroke="#c97f08" stroke-width="2"/>`);
    out.push(text(x0, ly + 33, tro, { size: 28, wt: 800, fill: '#7a4a00' }));
    out.push(`<g transform="translate(${r2(x0 + nw + 8)} ${ly + 6}) scale(${IC / 24})"><path d="M7 5.5H4.5a1 1 0 0 0-1 1V8a4 4 0 0 0 4 4M17 5.5h2.5a1 1 0 0 1 1 1V8a4 4 0 0 1-4 4" fill="none" stroke="#c97f08" stroke-width="2" stroke-linecap="round"/><path d="M6.5 3h11v6.5a5.5 5.5 0 0 1-11 0Z" fill="#fff1a6" stroke="#c97f08" stroke-width="1.2" stroke-linejoin="round"/><path d="M10.5 14.5h3v3h-3Z" fill="#c97f08"/><rect x="7" y="17" width="10" height="4" rx="1.2" fill="#7a4a00"/></g>`); ly += 70;
  }
  {
    const lv = d.matt ? LV[d.mattI] || LV[0] : ['#c3dbe8', '#65717b'], s = d.matt ? `Beat the ${d.matt} bot` : 'No bot beaten yet', fs = fit(s, 900, 30, 262), sw = measure(s, 900, fs) + 98, x0 = cx - sw / 2;   // "bot", not "Matt": a stranger does not know Matt is the AI. At most 360 px wide: clear of the edge and the panel
    out.push(`<rect x="${r2(x0)}" y="${ly}" width="${r2(sw)}" height="64" rx="32" fill="#ffffff" filter="url(#sh)"/>`);
    out.push(`<circle cx="${r2(x0 + 34)}" cy="${ly + 32}" r="24" fill="${lv[0]}" stroke="${lv[1]}" stroke-width="3"/><g transform="translate(${r2(x0 + 34 - 15)} ${ly + 16}) scale(1.25)" fill="#ffffff">${MATT}</g>`);
    out.push(text(x0 + 70, ly + 32 + fs * 0.36, s, { size: fs, wt: 900, fill: lv[1] }));
  }
  // right: the panel with the name, the big figures, the chips and the call to action
  const px = 388, py = 36, pw = 776, ph = 558, x0 = px + 36, iw = pw - 72;
  out.push(`<rect x="${px}" y="${py}" width="${pw}" height="${ph}" rx="40" fill="url(#panel)" stroke="#ffffff" stroke-width="4" filter="url(#sh)"/>`);
  out.push(text(x0, py + 52, 'PLAYER CARD', { size: 24, wt: 800, fill: ink, ls: 4 }));
  if (d.guest) out.push(text(x0, py + 122, d.name, { size: 56, wt: 900, fill: '#65717b' }));   // no username: the generic words stay small and grey, the stats are the hero
  else out.push(text(x0, py + 124, d.name, { size: fit(d.name, 900, 78, iw), wt: 900, fill: '#39434d' }));   // its descenders (p, g, y) clear the tiles at py + 150
  // six equal tiles, two rows of three, the same on every card; the call to action on the panel's floor
  const gap = 16, cols = 3, tw1 = (iw - gap * (cols - 1)) / cols, pad = 20, bh = 94, by = py + ph - 34 - bh, ty = py + 150, th = (by - 20 - ty - gap) / 2;
  const vs = Math.min(...d.big.map(b => fit(b.value, 900, 58, tw1 - 2 * pad - (b.cap ? measure(b.cap, 800, 26) + 8 : 0))), 58);   // one figure size for all six: they read as a set
  d.big.forEach((b, i) => {
    const x = x0 + (i % cols) * (tw1 + gap), y = ty + Math.floor(i / cols) * (th + gap), lab = (b.tag || b.label).toUpperCase(), fy = y + th - 30;
    out.push(`<rect x="${r2(x)}" y="${r2(y)}" width="${r2(tw1)}" height="${r2(th)}" rx="24" fill="url(#tile)" stroke="#d6f0fa" stroke-width="2"/>`);
    out.push(text(x + pad, y + 38, lab, { size: fit(lab, 800, 26, tw1 - 2 * pad, 1.5), wt: 800, fill: '#65717b', ls: 1.5 }));
    out.push(text(x + pad, fy, b.value, { size: vs, wt: 900, fill: '#1b63b8' }));
    if (b.bar != null) { const bw = tw1 - 2 * pad, f = Math.max(0, Math.min(1, b.bar / 100));
      out.push(`<rect x="${r2(x + pad)}" y="${r2(y + th - 20)}" width="${r2(bw)}" height="8" rx="4" fill="#cfe3ef"/>` + (f ? `<rect x="${r2(x + pad)}" y="${r2(y + th - 20)}" width="${r2(Math.max(8, bw * f))}" height="8" rx="4" fill="url(#bar)"/>` : '')); }
    else if (b.cap) out.push(text(x + pad + measure(b.value, 900, vs) + 8, fy, b.cap, { size: 26, wt: 800, fill: '#1b63b8' }));   // short units only (hits, °/s): a long caption would shrink all six figures
  });
  out.push(`<rect x="${x0}" y="${by}" width="${iw}" height="${bh}" rx="32" fill="url(#cta)" stroke="#0e3f8c" stroke-opacity=".22" stroke-width="2"/>`);
  out.push(`<rect x="${x0 + 14}" y="${by + 6}" width="${iw - 28}" height="${bh / 2 - 8}" rx="${bh / 2 - 12}" fill="#ffffff" opacity=".14"/>`);
  out.push(ball(x0 + 48, by + bh / 2, 30));
  const q = 'Play free at poddleball.com', q2 = 'Pickleball in your browser · your phone is the paddle';   // where to play, then how it is played: the hook a stranger clicks for (no taunt line: the owner found it corny, NOTES 118)
  out.push(text(x0 + 92, by + 42, q, { size: fit(q, 900, 32, iw - 116), wt: 900, fill: '#ffffff' }));
  out.push(text(x0 + 92, by + 79, q2, { size: fit(q2, 800, 30, iw - 116), wt: 800, fill: '#ffffff' }));   // white: the old pale gold was ~3.5:1 on the blue and went first when shrunk
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
