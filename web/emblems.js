// Rank emblems for Ranked: the eight tiers (Bronze .. Pro), their trophy floors, and the SVG sprite they are drawn from (docs/RANK8.md 1, 3, 6).
// No DOM at import time: call installSprite() once (ui.js, which owns the DOM) before any <use href="#rank-..."> is rendered. Sprite colours are
// literal hexes; where a ui.css token exists it is that value (--ball/-deep, --gold-1..4, --silver-1..4, --line/-deep, --good).

/** Trophy floors, one per rank (tier 1..8), low to high: 150 trophies a rank. Retune here only (server/ladder.js TIERS must agree: test/ladder.test.mjs). */
export const THRESHOLDS = [0, 150, 300, 450, 600, 750, 900, 1050];
/** Three divisions a rank, 50 trophies each: I (the rank's floor), II, III; the top rank (Pro) has none: its div is always 1 and never shown (NOTES 126). */
export const DIV_W = 50;
const ROMAN = ['', 'I', 'II', 'III'];
export const romanOf = div => ROMAN[div === 2 ? 2 : div === 3 ? 3 : 1];
/** The division (1..3) of a trophy count inside its rank (tier 1..8; unknown = the count's own rank). Always 1 in the top rank. */
export function divOf(trophies, tier) { const t = +trophies || 0, k = tier >= 1 && tier <= TOP ? tier | 0 : rankOf(t).id; return k === TOP ? 1 : 1 + Math.min(2, Math.max(0, Math.floor((t - THRESHOLDS[k - 1]) / DIV_W))); }
/** The player-facing rank string: 'Gold II'; the top rank has no division: 'Pro', or 'Pro #4' given its global leaderboard place `pro` (NOTES 126).
    tier 1..8, div 1..3 (a missing div reads as I). */
export function rankLabel(tier, div, pro) { const r = RANKS[(tier | 0) - 1]; return !r ? '' : r.id === TOP ? (pro >= 1 ? `${r.name} #${pro | 0}` : r.name) : `${r.name} ${romanOf(div)}`; }

/** The eight tiers, low to high. `colour.deep` is the frame's dark rim (label ink), `colour.mid` its body tone. The names live here and in server/ladder.js TIERS only. */
export const RANKS = [
  { id: 1, key: 'bronze',   name: 'Bronze',   colour: { deep: '#7e4512', mid: '#d98f47' } },
  { id: 2, key: 'silver',   name: 'Silver',   colour: { deep: '#6d7f8c', mid: '#d8e2ea' } },
  { id: 3, key: 'gold',     name: 'Gold',     colour: { deep: '#b8720a', mid: '#ffd34a' } },
  { id: 4, key: 'platinum', name: 'Platinum', colour: { deep: '#1f7a86', mid: '#a8ece8' } },      // aqua-tinted (the owner): greener and paler than Diamond's sky blue
  { id: 5, key: 'diamond',  name: 'Diamond',  colour: { deep: '#0f7fae', mid: '#34beed' } },
  { id: 6, key: 'master',   name: 'Master',   colour: { deep: '#9b1c3a', mid: '#ff6f8e' } },      // ruby / crimson (docs/RANK8.md 3): between Diamond's sky and Champion's purple
  { id: 7, key: 'champion', name: 'Champion', colour: { deep: '#4f23a8', mid: '#8a5cf0' } },
  { id: 8, key: 'pro',      name: 'Pro',      colour: { deep: '#4a2f8a', mid: '#3ecf72' } },      // the top rank: no divisions, a numbered leaderboard
];
/** The top tier (Pro): 8. Written from the table, never as a literal. */
export const TOP = RANKS.length;
/** Pro (the top tier) has no divisions (NOTES 126): its players are told apart by their global leaderboard place, 'Pro #12'. */
export const hasDivs = tier => (tier | 0) >= 1 && (tier | 0) < TOP;

/** The rank a trophy count sits in, with its division: { id, key, name, colour, div } (the highest floor reached; unparseable = Bronze I; Pro is always div 1). */
export function rankOf(trophies) {
  const t = +trophies || 0; let i = 0;
  while (i + 1 < THRESHOLDS.length && t >= THRESHOLDS[i + 1]) i++;
  return { ...RANKS[i], div: i + 1 === TOP ? 1 : 1 + Math.min(2, Math.max(0, Math.floor((t - THRESHOLDS[i]) / DIV_W))) };
}

// a rank is an id (1..8), a RANKS / rankOf() entry, or null/0 for none; its division is the one passed, else a rankOf() entry's own, else I
const idOf = rank => { const n = rank && typeof rank === 'object' ? rank.id : +rank || 0; return n >= 1 && n <= TOP ? n | 0 : 0; };
const divIn = (rank, div) => { const d = div >= 1 && div <= 3 ? div | 0 : rank && typeof rank === 'object' && rank.div >= 1 && rank.div <= 3 ? rank.div | 0 : 1; return d; };
const klass = cls => 'rank-em' + (cls ? ' ' + cls : '');

/** The sprite symbol id of a rank's medal at a division: 'rank-3-2' (Gold II) for tiers 1..7, 'rank-8' for Pro (one medal, no divisions).
    An unknown tier is Bronze I (the hidden emblem's placeholder), an unknown div is I. server/card.js parses the sprite by these ids. */
export function emblemId(tier, div) { const t = idOf(tier) || 1; return t === TOP ? `rank-${t}` : `rank-${t}-${div === 2 || div === 3 ? div : 1}`; }

/** HTML for one emblem: `<svg class="rank-em cls" aria-hidden="true"><use href="#rank-T-D"/></svg>` (hidden for null/0). `div` 1..3 picks the evolved medal. */
export function emblem(rank, cls = '', div) {
  const id = idOf(rank);
  return `<svg class="${klass(cls)}" aria-hidden="true"${id ? '' : ' hidden'}><use href="#${emblemId(id, divIn(rank, div))}"/></svg>`;
}

/** The same emblem as a DOM element. */
export function emblemEl(rank, cls = '', div) {
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), use = document.createElementNS(NS, 'use');
  svg.setAttribute('class', klass(cls)); svg.setAttribute('aria-hidden', 'true'); svg.appendChild(use);
  setEmblem(svg, rank, div);
  return svg;
}

/** Point an existing `.rank-em` at another rank and division (null/0 hides it, a rank shows it again). Returns el. */
export function setEmblem(el, rank, div) {
  const id = idOf(rank), use = el.querySelector('use');
  if (use) use.setAttribute('href', `#${emblemId(id, divIn(rank, div))}`);
  if (id) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
  return el;
}

/** The emblem with its rank name under it (`.rank-card-em > svg.rank-em + b`) for the rank card and the VS card: the name is DOM text,
    never inside the SVG. `cls` sizes the emblem (default is-lg; is-xl for the hero); add .is-inverse on a dark ground. Hidden and empty for null/0.
    `div` 1..3 draws that division's medal, puts its roman numeral in the label ('Gold II') and on the wrapper as data-div, which ui.css draws as a
    small tag over the emblem's lower edge at .is-md and larger (a CSS overlay, never text inside the SVG). Pro has no division: no numeral, no
    data-div; `pro` (its leaderboard position) makes the label 'Pro #4'. Without `div`, a rankOf() entry's own division still picks the medal. */
export function emblemCard(rank, cls = 'is-lg', div = 0, pro = 0) {
  const id = idOf(rank), r = id ? RANKS[id - 1] : null, el = document.createElement('div'), b = document.createElement('b'), d = id === TOP ? 0 : div >= 1 && div <= 3 ? div | 0 : 0;
  el.className = 'rank-card-em'; el.appendChild(emblemEl(id, cls, d || divIn(rank))); b.textContent = r ? (id === TOP ? rankLabel(id, 1, pro) : d ? rankLabel(id, d) : r.name) : ''; el.appendChild(b);
  if (r) { el.style.setProperty('--rank-ink', r.colour.deep); el.style.setProperty('--rank-mid', r.colour.mid); if (d) el.dataset.div = String(d); } else el.setAttribute('hidden', '');
  return el;
}

/** Put the sprite (shared parts + the 22 symbols) at the start of <body>, once. Returns it. */
export function installSprite() {
  const have = document.querySelector('svg.rank-sprite'); if (have) return have;
  const t = document.createElement('template'); t.innerHTML = SPRITE;
  const el = t.content.firstElementChild; (document.body || document.documentElement).prepend(el);
  return el;
}

// The sprite (docs/RANK8.md 3, 6). One <defs> of shared parts, then 22 symbols: rank-<tier>-<div> for Bronze..Champion (I, II, III) and rank-8 (Pro).
// Parts: balls pb1..pb7 + pbm (Master), frames f2 shield / f4 hexagon / f5 gem / f6 star / f7 crest / f8 octagon / fm seal (+ clips c*, cm), sheens sh
// and shc (cool), ramps g2..g8 + gm, wing wg, laurel lf, sparkle sp, crown cr; and per rank (by key, never a tier number): its medal as it has always
// been (b-<key>, division I), its metal trim (t-<key>, II and III), its glow (h-<key>, III), rays ry, gem gq. II = trim + studs around the medal;
// III = glow + rays behind, trim, gems (in the next rank's colour: one step from ranking up) and a crowning gem on top. Glows are radial gradients,
// not filters, and everything stays inside the 64 box (server/card.js inlines these symbols into the share card, rendered by resvg).
// Exported for server/card.js, which draws the same artwork on the share card (docs/SHARE.md): change it here and both follow.
// each medal's pickleball in its own rank's tones (the owner: no neon yellow): [id, ball, holes and rim]
const BALLS = [['pb1', '#f3c9a0', '#a5591f'], ['pb2', '#f5f8fb', '#8fa2b0'], ['pb3', '#ffe391', '#c98a12'], ['pb4', '#e6fbfa', '#2f9ea6'], ['pb5', '#d2f4ff', '#1a8fbd'], ['pbm', '#ffe1e8', '#b3264a'], ['pb6', '#e9dcff', '#6d43c9'], ['pb7', '#fff0c2', '#b07a10']];
const f1 = n => +n.toFixed(2);
const star = (n, R, r, cx = 32, cy = 32) => 'M' + Array.from({ length: 2 * n }, (_, k) => { const a = (k / n - .5) * Math.PI, q = k % 2 ? r : R; return `${f1(cx + q * Math.cos(a))} ${f1(cy + q * Math.sin(a))}`; }).join('L') + 'Z';
const rays = (n, R) => Array.from({ length: n }, (_, k) => { const a = (k / n) * 2 * Math.PI - Math.PI / 2, b = a + Math.PI / n * .9; return `M32 32L${f1(32 + R * Math.cos(a))} ${f1(32 + R * Math.sin(a))}L${f1(32 + R * Math.cos(b))} ${f1(32 + R * Math.sin(b))}Z`; }).join('');
// scale about (32, cy): the matrix for a transform attribute
const sc = (sx, sy = sx, cy = 32) => `matrix(${f1(sx)} 0 0 ${f1(sy)} ${f1(32 * (1 - sx))} ${f1(cy * (1 - sy))})`;
// per rank, the evolutions: frame, rim, trim metal [light, mid, dark], glow, gem (the next rank's colour), where the studs / gems sit (on the trim),
// the top (crowning gem), the trim's scale [x, y], the medal's scale inside it and the centre both scale about
const EVO = [
  { key: 'bronze',   f: 'f2', rim: '#7e4512', metal: ['#ffe6c9', '#e0a061', '#a5591f'], lit: '#ffd9a8', glow: '#ff7a1a', gem: '#eef3f7', at: [[10.5, 13], [53.5, 13], [11.5, 36], [52.5, 36]], top: [32, 6], t: [1.2, 1.1], s: .86, cy: 31.5 },
  { key: 'silver',   f: 'f2', rim: '#6d7f8c', metal: ['#ffffff', '#cdd8e1', '#8497a5'], lit: '#eaf4ff', glow: '#4f9cf0', gem: '#ffc928', at: [[10.5, 13], [53.5, 13], [11.5, 36], [52.5, 36]], top: [32, 6], t: [1.2, 1.1], s: .86, cy: 31.5 },
  { key: 'gold',     f: 'f4', rim: '#b8720a', metal: ['#fff8d0', '#ffcf3a', '#c98a12'], lit: '#fff6c0', glow: '#ffb300', gem: '#39d3c6', at: [[6.5, 17.5], [57.5, 17.5], [6.5, 46.5], [57.5, 46.5]], top: [32, 6], t: [1.15, 1.1], s: .86, cy: 32 },
  { key: 'platinum', f: 'f8', rim: '#1f7a86', metal: ['#f2fffe', '#96e6e1', '#2f9ea6'], lit: '#dbfff7', glow: '#19e3c4', gem: '#1fa8e0', at: [[13, 13], [51, 13], [13, 51], [51, 51]], top: [32, 6], t: [1.13, 1.13], s: .86, cy: 32 },
  { key: 'diamond',  f: 'f5', rim: '#0f7fae', metal: ['#eafaff', '#6fd4f8', '#1a8fbd'], lit: '#e2f7ff', glow: '#1fb0f5', gem: '#e8295a', at: [[3.5, 23], [60.5, 23], [15, 6], [49, 6]], top: [32, 6], t: [1.1, 1.1], s: .84, cy: 31 },
  { key: 'master',   f: 'fm', rim: '#9b1c3a', metal: ['#ffe6ec', '#ff8aa4', '#b3264a'], lit: '#ffd9e4', glow: '#ff2d6f', gem: '#8f52f5', at: [[5.5, 32], [58.5, 32], [13, 13], [51, 13]], top: [32, 6], t: [1.12, 1.12], s: .86, cy: 32 },
  { key: 'champion', f: 'f6', rim: '#4f23a8', metal: ['#f4ebff', '#b894ff', '#5c2fc0'], lit: '#f0e4ff', glow: '#9a5cff', gem: '#ffc928', at: [[7, 18], [57, 18], [7, 46], [57, 46]], top: [32, 6], t: [1.12, 1.1], s: .86, cy: 32 },
];
const bases = {      // the medal as it has always been (division I): dark rim, gradient body, white ring, clipped sheen, ball (Champion's wings are its own part, wc)
  bronze: `<use href="#f2" fill="#7e4512" stroke="#7e4512" stroke-width="5" stroke-linejoin="round"/><use href="#f2" fill="url(#g2)" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><use href="#sh" clip-path="url(#c2)" opacity=".75"/><use href="#pb1" transform="translate(0 -2)"/>`,
  silver: `<use href="#f2" fill="#6d7f8c" stroke="#6d7f8c" stroke-width="5" stroke-linejoin="round"/><use href="#f2" fill="url(#g3)" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><path d="M32 11 47 15.5v13c0 10-6 16.5-15 22-9-5.5-15-12-15-22v-13Z" fill="none" stroke="#8093a1" stroke-width="1.6" stroke-linejoin="round" opacity=".8"/><use href="#sh" clip-path="url(#c2)" opacity=".85"/><use href="#pb2" transform="translate(0 -2)"/>`,
  gold: `<use href="#f4" fill="#b8720a" stroke="#b8720a" stroke-width="5" stroke-linejoin="round"/><use href="#f4" fill="url(#g4)" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><path d="M32 12l17.5 10v20L32 52 14.5 42V22Z" fill="none" stroke="#c97f08" stroke-width="1.6" stroke-linejoin="round" opacity=".7"/><g fill="#fff6c9" stroke="#c97f08" stroke-width="1.2"><circle cx="32" cy="12" r="1.9"/><circle cx="49.5" cy="22" r="1.9"/><circle cx="49.5" cy="42" r="1.9"/><circle cx="32" cy="52" r="1.9"/><circle cx="14.5" cy="42" r="1.9"/><circle cx="14.5" cy="22" r="1.9"/></g><use href="#sh" clip-path="url(#c4)" opacity=".8"/><use href="#pb3"/>`,
  platinum: `<use href="#f8" fill="#1f7a86" stroke="#1f7a86" stroke-width="5"/><use href="#f8" fill="url(#g8)" stroke="#fff" stroke-width="2.2"/><path d="M24.5 14h15l10.5 10.5v15L39.5 50h-15L14 39.5v-15Z" fill="none" stroke="#fff" stroke-width="1.8" opacity=".95"/><path d="M26 17.5h12l8.5 8.5v12L38 46.5H26L17.5 38V26Z" fill="none" stroke="#2f9ea6" stroke-width="1.6" opacity=".85"/><use href="#shc" clip-path="url(#c8)" opacity=".85"/><use href="#pb4"/>`,
  diamond: `<use href="#f5" fill="#0f7fae" stroke="#0f7fae" stroke-width="5" stroke-linejoin="round"/><use href="#f5" fill="url(#g5)" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><path d="M17 9l7 14M47 9l-7 14M6 23h52M24 23 32 57 40 23" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" opacity=".55"/><use href="#sh" clip-path="url(#c5)" opacity=".8"/><use href="#pb5" transform="translate(0 -4)"/>`,
  master: `<use href="#fm" fill="#9b1c3a" stroke="#9b1c3a" stroke-width="5" stroke-linejoin="round"/><use href="#fm" fill="url(#gm)" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><path d="${rays(12, 21).replace(/Z/g, '')}" fill="none" stroke="#fff" stroke-width="1.2" opacity=".35"/><circle cx="32" cy="32" r="18" fill="none" stroke="#fff" stroke-width="1.8" opacity=".9"/><circle cx="32" cy="32" r="15.6" fill="#c8284f" stroke="#9b1c3a" stroke-width="1.4"/><use href="#sh" clip-path="url(#cm)" opacity=".7"/><use href="#pbm"/>`,
  champion: `<use href="#f6" fill="#4f23a8" stroke="#4f23a8" stroke-width="5" stroke-linejoin="round"/><use href="#f6" fill="url(#g6)" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><use href="#sh" clip-path="url(#c6)" opacity=".8"/><use href="#pb6"/>`,
};
const wings = `<g id="wc" fill="#f3ecff" stroke="#4f23a8" stroke-width="2.4" stroke-linejoin="round"><use href="#wg"/><use href="#wg" transform="matrix(-1 0 0 1 64 0)"/></g>`;
const defsOf = e => `<g id="b-${e.key}">${bases[e.key]}</g>` +
  `<linearGradient id="m-${e.key}" x1="0" y1="0" x2=".7" y2="1"><stop offset="0" stop-color="${e.metal[0]}"/><stop offset=".3" stop-color="${e.metal[1]}"/><stop offset=".5" stop-color="${e.metal[0]}"/><stop offset=".78" stop-color="${e.metal[1]}"/><stop offset="1" stop-color="${e.metal[2]}"/></linearGradient>` +
  `<radialGradient id="h-${e.key}" gradientUnits="userSpaceOnUse" cx="32" cy="32" r="32"><stop offset=".55" stop-color="${e.lit}"/><stop offset=".8" stop-color="${e.glow}"/><stop offset=".9" stop-color="${e.glow}" stop-opacity=".5"/><stop offset="1" stop-color="${e.glow}" stop-opacity="0"/></radialGradient>` +
  `<g id="t-${e.key}"><use href="#${e.f}" transform="${sc(e.t[0], e.t[1], e.cy)}" fill="url(#m-${e.key})" stroke="${e.rim}" stroke-width="${f1(2.5 / e.t[0])}" stroke-linejoin="round"/><use href="#${e.f}" transform="${sc((e.t[0] + e.s) / 2 + .1, (e.t[1] + e.s) / 2 + .1, e.cy)}" fill="none" stroke="#fff" stroke-width="1" stroke-linejoin="round" opacity=".85"/></g>`;
const behind = e => e.key === 'champion' ? '<use href="#wc"/>' : '';      // Champion's wings sit behind its trim
const spark = (e, d) => e.key !== 'diamond' ? '' : d === 1 ? '<use href="#sp" fill="#fff" transform="translate(52 7)"/>' : '<use href="#sp" fill="#fff" transform="translate(57 6) scale(.8)"/>';
const framed = e => `${behind(e)}<use href="#t-${e.key}"/><use href="#b-${e.key}" transform="${sc(e.s, e.s, e.cy)}"/>`;
const studs = e => `<g fill="${e.metal[0]}" stroke="${e.rim}" stroke-width="1.2">${e.at.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="2.3"/>`).join('')}</g>`;
const gems = e => `<g fill="${e.gem}" stroke="${e.rim}" stroke-width="1" stroke-linejoin="round">${e.at.map(([x, y]) => `<use href="#gq" x="${x}" y="${y}"/>`).join('')}<use href="#gq" transform="translate(${e.top[0]} ${e.top[1]}) scale(1.45)"/></g>`;
const symbolsOf = (e, i) => [
  `<symbol id="rank-${i + 1}-1" viewBox="0 0 64 64">${behind(e)}<use href="#b-${e.key}"/>${spark(e, 1)}</symbol>`,
  `<symbol id="rank-${i + 1}-2" viewBox="0 0 64 64">${framed(e)}${studs(e)}${spark(e, 2)}</symbol>`,
  `<symbol id="rank-${i + 1}-3" viewBox="0 0 64 64"><rect width="64" height="64" fill="url(#h-${e.key})" opacity=".85"/><use href="#ry" fill="url(#h-${e.key})"/><g transform="${sc(.92)}">${framed(e)}${gems(e)}${spark(e, 3)}</g></symbol>`,
].join('\n');
export const SPRITE = `<svg class="rank-sprite" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs>
${BALLS.map(([id, f, d]) => `<g id="${id}"><circle cx="32" cy="32" r="12.5" fill="${f}" stroke="${d}" stroke-width="2"/><g fill="${d}"><circle cx="32" cy="32" r="2.3"/><circle cx="32" cy="24.6" r="2"/><circle cx="32" cy="39.4" r="2"/><circle cx="25.6" cy="28.3" r="2"/><circle cx="38.4" cy="28.3" r="2"/><circle cx="25.6" cy="35.7" r="2"/><circle cx="38.4" cy="35.7" r="2"/></g><path d="M23.5 27a10 10 0 0 1 6-5.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" opacity=".9"/></g>`).join('')}
<path id="f2" d="M32 5 52 11v18c0 13-8 22-20 29C20 51 12 42 12 29V11Z"/>
<path id="f4" d="M32 6l23 13v26L32 58 9 45V19Z"/>
<path id="f5" d="M17 9h30l11 14-26 34L6 23Z"/>
<path id="f6" d="M32 6l8.8 10.8L54.5 19 49.5 32l5 13-13.7 2.2L32 58l-8.8-10.8L9.5 45l5-13-5-13 13.7-2.2Z"/>
<path id="f7" d="M32 11 50 17v14c0 11-7 20-18 26C21 51 14 42 14 31V17Z"/>
<path id="f8" d="M22 8h20l14 14v20L42 56H22L8 42V22Z"/>
<path id="fm" d="${star(12, 26.5, 23)}"/>
<clipPath id="c2"><use href="#f2"/></clipPath><clipPath id="c4"><use href="#f4"/></clipPath><clipPath id="c5"><use href="#f5"/></clipPath><clipPath id="c6"><use href="#f6"/></clipPath><clipPath id="c7"><use href="#f7"/></clipPath><clipPath id="c8"><use href="#f8"/></clipPath><clipPath id="cm"><use href="#fm"/></clipPath>
<linearGradient id="gl" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#fff" stop-opacity=".9"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>
<linearGradient id="glc" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#eaf8ff" stop-opacity=".95"/><stop offset="1" stop-color="#d6f0fa" stop-opacity="0"/></linearGradient>
<rect id="sh" x="0" y="0" width="64" height="28" fill="url(#gl)"/>
<rect id="shc" x="0" y="0" width="64" height="30" fill="url(#glc)"/>
<linearGradient id="g2" gradientUnits="userSpaceOnUse" x1="0" y1="6" x2="0" y2="58"><stop offset="0" stop-color="#f8d3a8"/><stop offset=".5" stop-color="#d98f47"/><stop offset=".85" stop-color="#b56a25"/><stop offset="1" stop-color="#d38b45"/></linearGradient>
<linearGradient id="g3" gradientUnits="userSpaceOnUse" x1="0" y1="6" x2="0" y2="58"><stop offset="0" stop-color="#fbfdff"/><stop offset=".45" stop-color="#d8e2ea"/><stop offset=".8" stop-color="#a9b8c4"/><stop offset="1" stop-color="#cfdae3"/></linearGradient>
<linearGradient id="g4" gradientUnits="userSpaceOnUse" x1="0" y1="6" x2="0" y2="58"><stop offset="0" stop-color="#fff1a6"/><stop offset=".45" stop-color="#ffd34a"/><stop offset=".85" stop-color="#f2a81d"/><stop offset="1" stop-color="#ffcf4a"/></linearGradient>
<linearGradient id="g5" gradientUnits="userSpaceOnUse" x1="0" y1="6" x2="0" y2="58"><stop offset="0" stop-color="#cdf2ff"/><stop offset=".45" stop-color="#5fd0f7"/><stop offset=".85" stop-color="#1a9fd0"/><stop offset="1" stop-color="#4cc6f2"/></linearGradient>
<linearGradient id="g6" gradientUnits="userSpaceOnUse" x1="0" y1="6" x2="0" y2="58"><stop offset="0" stop-color="#eddcff"/><stop offset=".45" stop-color="#b58cff"/><stop offset=".85" stop-color="#7d44e6"/><stop offset="1" stop-color="#a672ff"/></linearGradient>
<linearGradient id="g7" gradientUnits="userSpaceOnUse" x1="10" y1="6" x2="54" y2="58"><stop offset="0" stop-color="#ff7aa2"/><stop offset=".28" stop-color="#ffd34a"/><stop offset=".52" stop-color="#3ecf72"/><stop offset=".76" stop-color="#34beed"/><stop offset="1" stop-color="#9b5cf0"/></linearGradient>
<linearGradient id="g8" gradientUnits="userSpaceOnUse" x1="0" y1="6" x2="0" y2="58"><stop offset="0" stop-color="#effffd"/><stop offset=".4" stop-color="#a8ece8"/><stop offset=".8" stop-color="#4fc4c4"/><stop offset="1" stop-color="#7fd9d6"/></linearGradient>
<linearGradient id="gm" gradientUnits="userSpaceOnUse" x1="0" y1="6" x2="0" y2="58"><stop offset="0" stop-color="#ffd3de"/><stop offset=".42" stop-color="#ff6f8e"/><stop offset=".82" stop-color="#c8284f"/><stop offset="1" stop-color="#f0527a"/></linearGradient>
<path id="wg" d="M20 18C11 11 3 13 1.5 20c5-1 8 1 9 5-5 0-8.5 4-8.5 9 5-2 8-1 10 2-4 2-5 6-4 10 6-3 10-7 13-13Z"/>
<g id="lf"><path d="M17 16c-10 8-12 24-3 38" fill="none" stroke-width="2.6" stroke-linecap="round"/><ellipse cx="13" cy="52" rx="2.8" ry="6.5" transform="rotate(-25 13 52)"/><ellipse cx="7.5" cy="43" rx="2.8" ry="6.5" transform="rotate(-45 7.5 43)"/><ellipse cx="5.5" cy="32" rx="2.8" ry="6.5" transform="rotate(-20 5.5 32)"/><ellipse cx="8" cy="21" rx="2.8" ry="6.5" transform="rotate(20 8 21)"/><ellipse cx="15" cy="13" rx="2.6" ry="6" transform="rotate(60 15 13)"/></g>
<path id="sp" d="M0-5l1.4 3.6L5 0 1.4 1.4 0 5-1.4 1.4-5 0l3.6-1.4Z"/>
<path id="cr" d="M22 12l1.5-8 6 5.2L32 3l2.5 6.2 6-5.2 1.5 8Z"/>
<path id="ry" d="${rays(16, 46)}"/>
<g id="gq"><path d="M0-3.4 3 0 0 3.4-3 0Z"/><path d="M-3 0 0-3.4 3 0Z" fill="#fff" stroke="none" opacity=".6"/></g>
${wings}
${EVO.map(defsOf).join('\n')}
<radialGradient id="h-pro" gradientUnits="userSpaceOnUse" cx="32" cy="32" r="34"><stop offset=".3" stop-color="#fff4b8"/><stop offset=".52" stop-color="#ffc21a"/><stop offset=".74" stop-color="#ffa800" stop-opacity=".8"/><stop offset=".87" stop-color="#ffa800" stop-opacity=".32"/><stop offset=".96" stop-color="#ffa800" stop-opacity="0"/></radialGradient>
<radialGradient id="h-prow" gradientUnits="userSpaceOnUse" cx="32" cy="32" r="34"><stop offset=".4" stop-color="#fff" stop-opacity=".8"/><stop offset=".85" stop-color="#fff" stop-opacity=".25"/><stop offset=".96" stop-color="#fff" stop-opacity="0"/></radialGradient>
<radialGradient id="dk-pro" cx=".5" cy=".4" r=".6"><stop offset="0" stop-color="#6a45c0"/><stop offset="1" stop-color="#2b1760"/></radialGradient><clipPath id="cd-pro"><circle cx="32" cy="32" r="27"/></clipPath>
<linearGradient id="m-pro" x1="0" y1="0" x2=".7" y2="1"><stop offset="0" stop-color="#fff8d0"/><stop offset=".38" stop-color="#ffcf3a"/><stop offset=".55" stop-color="#fff3b0"/><stop offset=".8" stop-color="#ffc21a"/><stop offset="1" stop-color="#b8720a"/></linearGradient>
</defs>
${EVO.map(symbolsOf).join('\n')}
<symbol id="rank-8" viewBox="0 0 64 64"><rect width="64" height="64" fill="url(#h-pro)" opacity=".6"/><use href="#ry" fill="url(#h-pro)"/><circle cx="32" cy="32" r="28.6" fill="url(#dk-pro)" stroke="url(#g7)" stroke-width="3"/><use href="#ry" fill="url(#h-prow)" transform="rotate(11.25 32 32)" clip-path="url(#cd-pro)"/><g transform="${sc(.92)}"><g fill="#ffd34a" stroke="#b8720a" stroke-width="1.6" stroke-linejoin="round"><use href="#lf"/><use href="#lf" transform="matrix(-1 0 0 1 64 0)"/></g><use href="#f7" transform="${sc(1.14, 1.08, 36)}" fill="url(#m-pro)" stroke="#4a2f8a" stroke-width="2.2" stroke-linejoin="round"/><use href="#f7" fill="#4a2f8a" stroke="#4a2f8a" stroke-width="5" stroke-linejoin="round"/><use href="#f7" fill="url(#g7)" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><use href="#sh" clip-path="url(#c7)" opacity=".7"/><use href="#cr" fill="#ffd34a" stroke="#b8720a" stroke-width="1.6" stroke-linejoin="round" transform="${sc(1.5, 1.5, 9)}"/><g stroke="#4a2f8a" stroke-width=".8" stroke-linejoin="round"><use href="#gq" x="23" y="11" fill="#34beed"/><use href="#gq" transform="translate(32 8) scale(1.35)" fill="#ff3d6e"/><use href="#gq" x="41" y="11" fill="#3ecf72"/></g><use href="#pb7" transform="translate(0 2)"/><use href="#sp" fill="#fff" transform="translate(45 21) scale(.75)"/></g><use href="#sp" fill="#fff" transform="translate(8 8) scale(.85)"/><use href="#sp" fill="#fff" transform="translate(56.5 55) scale(.7)"/></symbol>
</svg>`;
