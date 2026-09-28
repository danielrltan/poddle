// Rank emblems for Ranked: the seven tiers (Bronze .. Pro), their trophy floors, and the SVG sprite they are drawn from.
// No DOM at import time: call installSprite() once (ui.js, which owns the DOM) before any <use href="#rank-N"> is rendered. Sprite colours are
// literal hexes; where a ui.css token exists it is that value (--ball/-deep, --gold-1..4, --silver-1..4, --line/-deep, --good).

/** Trophy floors, one per rank (tier 1..7), low to high: 150 trophies a rank. Retune here only (server/ladder.js TIERS must agree: test/ladder.test.mjs). */
export const THRESHOLDS = [0, 150, 300, 450, 600, 750, 900];
/** Three divisions a rank, 50 trophies each: I (the rank's floor), II, III; past III of the top rank there is no cap. */
export const DIV_W = 50;
const ROMAN = ['', 'I', 'II', 'III'];
export const romanOf = div => ROMAN[div === 2 ? 2 : div === 3 ? 3 : 1];
/** The division (1..3) of a trophy count inside its rank (tier 1..7; unknown = the count's own rank). */
export function divOf(trophies, tier) { const t = +trophies || 0, k = tier >= 1 && tier <= 7 ? tier | 0 : rankOf(t).id; return k === 7 ? 1 : 1 + Math.min(2, Math.max(0, Math.floor((t - THRESHOLDS[k - 1]) / DIV_W))); }
/** Pro (tier 7) has no divisions (NOTES 126): its players are told apart by their global leaderboard place, 'Pro #12'. */
export const hasDivs = tier => (tier | 0) >= 1 && (tier | 0) < 7;
/** The player-facing rank string: 'Gold II', and plain 'Pro'. tier 1..7, div 1..3 (a missing div reads as I). */
export function rankLabel(tier, div) { const r = RANKS[(tier | 0) - 1]; return r ? (hasDivs(tier) ? `${r.name} ${romanOf(div)}` : r.name) : ''; }

/** The seven tiers, low to high. `colour.deep` is the frame's dark rim (label ink), `colour.mid` its body tone. */
export const RANKS = [
  { id: 1, key: 'bronze',   name: 'Bronze',   colour: { deep: '#7e4512', mid: '#d98f47' } },
  { id: 2, key: 'silver',   name: 'Silver',   colour: { deep: '#6d7f8c', mid: '#d8e2ea' } },
  { id: 3, key: 'gold',     name: 'Gold',     colour: { deep: '#b8720a', mid: '#ffd34a' } },
  { id: 4, key: 'platinum', name: 'Platinum', colour: { deep: '#1f7a86', mid: '#a8ece8' } },      // aqua-tinted (the owner): greener and paler than Diamond's sky blue
  { id: 5, key: 'diamond',  name: 'Diamond',  colour: { deep: '#0f7fae', mid: '#34beed' } },
  { id: 6, key: 'champion', name: 'Champion', colour: { deep: '#4f23a8', mid: '#8a5cf0' } },
  { id: 7, key: 'pro',      name: 'Pro',      colour: { deep: '#4a2f8a', mid: '#3ecf72' } },      // the top rank
];

/** The rank a trophy count sits in, with its division: { id, key, name, colour, div } (the highest floor reached; unparseable = Bronze I). */
export function rankOf(trophies) {
  const t = +trophies || 0; let i = 0;
  while (i + 1 < THRESHOLDS.length && t >= THRESHOLDS[i + 1]) i++;
  return { ...RANKS[i], div: 1 + Math.min(2, Math.max(0, Math.floor((t - THRESHOLDS[i]) / DIV_W))) };
}

// a rank is an id (1..7), a RANKS entry, or null/0 for none
const idOf = rank => { const n = rank && typeof rank === 'object' ? rank.id : +rank || 0; return n >= 1 && n <= 7 ? n | 0 : 0; };
const klass = cls => 'rank-em' + (cls ? ' ' + cls : '');

/** HTML for one emblem: `<svg class="rank-em cls" aria-hidden="true"><use href="#rank-N"/></svg>` (hidden for null/0). */
export function emblem(rank, cls = '') {
  const id = idOf(rank);
  return `<svg class="${klass(cls)}" aria-hidden="true"${id ? '' : ' hidden'}><use href="#rank-${id || 1}"/></svg>`;
}

/** The same emblem as a DOM element. */
export function emblemEl(rank, cls = '') {
  const NS = 'http://www.w3.org/2000/svg', svg = document.createElementNS(NS, 'svg'), use = document.createElementNS(NS, 'use');
  svg.setAttribute('class', klass(cls)); svg.setAttribute('aria-hidden', 'true'); svg.appendChild(use);
  setEmblem(svg, rank);
  return svg;
}

/** Point an existing `.rank-em` at another rank (null/0 hides it, a rank shows it again). Returns el. */
export function setEmblem(el, rank) {
  const id = idOf(rank), use = el.querySelector('use');
  if (use) use.setAttribute('href', `#rank-${id || 1}`);
  if (id) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
  return el;
}

/** The emblem with its rank name under it (`.rank-card-em > svg.rank-em + b`) for the rank card and the VS card: the name is DOM text,
    never inside the SVG. `cls` sizes the emblem (default is-lg; is-xl for the hero); add .is-inverse on a dark ground. Hidden and empty for null/0.
    `div` 1..3 puts the division's roman numeral in the label ('Gold II') and on the wrapper as data-div, which ui.css draws as a small tag
    over the emblem's lower edge at .is-md and larger (a CSS overlay, never text inside the SVG). */
export function emblemCard(rank, cls = 'is-lg', div = 0) {
  const id = idOf(rank), r = id ? RANKS[id - 1] : null, el = document.createElement('div'), b = document.createElement('b'), d = div >= 1 && div <= 3 && hasDivs(id) ? div | 0 : 0;
  el.className = 'rank-card-em'; el.appendChild(emblemEl(id, cls)); b.textContent = r ? (d ? rankLabel(id, d) : r.name) : ''; el.appendChild(b);
  if (r) { el.style.setProperty('--rank-ink', r.colour.deep); el.style.setProperty('--rank-mid', r.colour.mid); if (d) el.dataset.div = String(d); } else el.setAttribute('hidden', '');
  return el;
}

/** Put the sprite (shared parts + the seven symbols) at the start of <body>, once. Returns it. */
export function installSprite() {
  const have = document.querySelector('svg.rank-sprite'); if (have) return have;
  const t = document.createElement('template'); t.innerHTML = SPRITE;
  const el = t.content.firstElementChild; (document.body || document.documentElement).prepend(el);
  return el;
}

// The sprite. Parts: ball pb, frames f2 shield / f4 hexagon / f5 gem / f6 star / f7 crest / f8 octagon (+ clips c*), sheens sh and shc
// (cool), ramps g2..g8, wing wg, laurel lf, sparkle sp, crown cr. Each tier: dark rim, gradient body, white ring, clipped sheen, ball.
// Exported for server/card.js, which draws the same artwork on the share card (docs/SHARE.md): change it here and both follow.
// each medal's pickleball in its own rank's tones (the owner: no neon yellow): [ball, holes and rim]
const BALLS = [['#f3c9a0', '#a5591f'], ['#f5f8fb', '#8fa2b0'], ['#ffe391', '#c98a12'], ['#e6fbfa', '#2f9ea6'], ['#d2f4ff', '#1a8fbd'], ['#e9dcff', '#6d43c9'], ['#fff0c2', '#b07a10']];
export const SPRITE = `<svg class="rank-sprite" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><defs>
${BALLS.map(([f, d], k) => { const i = k + 1; return `<g id="pb${i}"><circle cx="32" cy="32" r="12.5" fill="${f}" stroke="${d}" stroke-width="2"/><g fill="${d}"><circle cx="32" cy="32" r="2.3"/><circle cx="32" cy="24.6" r="2"/><circle cx="32" cy="39.4" r="2"/><circle cx="25.6" cy="28.3" r="2"/><circle cx="38.4" cy="28.3" r="2"/><circle cx="25.6" cy="35.7" r="2"/><circle cx="38.4" cy="35.7" r="2"/></g><path d="M23.5 27a10 10 0 0 1 6-5.5" fill="none" stroke="#fff" stroke-width="2.2" stroke-linecap="round" opacity=".9"/></g>`; }).join('')}
<path id="f2" d="M32 5 52 11v18c0 13-8 22-20 29C20 51 12 42 12 29V11Z"/>
<path id="f4" d="M32 6l23 13v26L32 58 9 45V19Z"/>
<path id="f5" d="M17 9h30l11 14-26 34L6 23Z"/>
<path id="f6" d="M32 6l8.8 10.8L54.5 19 49.5 32l5 13-13.7 2.2L32 58l-8.8-10.8L9.5 45l5-13-5-13 13.7-2.2Z"/>
<path id="f7" d="M32 11 50 17v14c0 11-7 20-18 26C21 51 14 42 14 31V17Z"/>
<path id="f8" d="M22 8h20l14 14v20L42 56H22L8 42V22Z"/>
<clipPath id="c2"><use href="#f2"/></clipPath><clipPath id="c4"><use href="#f4"/></clipPath><clipPath id="c5"><use href="#f5"/></clipPath><clipPath id="c6"><use href="#f6"/></clipPath><clipPath id="c7"><use href="#f7"/></clipPath><clipPath id="c8"><use href="#f8"/></clipPath>
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
<path id="wg" d="M20 18C11 11 3 13 1.5 20c5-1 8 1 9 5-5 0-8.5 4-8.5 9 5-2 8-1 10 2-4 2-5 6-4 10 6-3 10-7 13-13Z"/>
<g id="lf"><path d="M17 16c-10 8-12 24-3 38" fill="none" stroke-width="2.6" stroke-linecap="round"/><ellipse cx="13" cy="52" rx="2.8" ry="6.5" transform="rotate(-25 13 52)"/><ellipse cx="7.5" cy="43" rx="2.8" ry="6.5" transform="rotate(-45 7.5 43)"/><ellipse cx="5.5" cy="32" rx="2.8" ry="6.5" transform="rotate(-20 5.5 32)"/><ellipse cx="8" cy="21" rx="2.8" ry="6.5" transform="rotate(20 8 21)"/><ellipse cx="15" cy="13" rx="2.6" ry="6" transform="rotate(60 15 13)"/></g>
<path id="sp" d="M0-5l1.4 3.6L5 0 1.4 1.4 0 5-1.4 1.4-5 0l3.6-1.4Z"/>
<path id="cr" d="M22 12l1.5-8 6 5.2L32 3l2.5 6.2 6-5.2 1.5 8Z"/>
</defs>
<symbol id="rank-1" viewBox="0 0 64 64"><use href="#f2" fill="#7e4512" stroke="#7e4512" stroke-width="5" stroke-linejoin="round"/><use href="#f2" fill="url(#g2)" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><use href="#sh" clip-path="url(#c2)" opacity=".75"/><use href="#pb1" transform="translate(0 -2)"/></symbol>
<symbol id="rank-2" viewBox="0 0 64 64"><use href="#f2" fill="#6d7f8c" stroke="#6d7f8c" stroke-width="5" stroke-linejoin="round"/><use href="#f2" fill="url(#g3)" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><path d="M32 11 47 15.5v13c0 10-6 16.5-15 22-9-5.5-15-12-15-22v-13Z" fill="none" stroke="#8093a1" stroke-width="1.6" stroke-linejoin="round" opacity=".8"/><use href="#sh" clip-path="url(#c2)" opacity=".85"/><use href="#pb2" transform="translate(0 -2)"/></symbol>
<symbol id="rank-3" viewBox="0 0 64 64"><use href="#f4" fill="#b8720a" stroke="#b8720a" stroke-width="5" stroke-linejoin="round"/><use href="#f4" fill="url(#g4)" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><path d="M32 12l17.5 10v20L32 52 14.5 42V22Z" fill="none" stroke="#c97f08" stroke-width="1.6" stroke-linejoin="round" opacity=".7"/><g fill="#fff6c9" stroke="#c97f08" stroke-width="1.2"><circle cx="32" cy="12" r="1.9"/><circle cx="49.5" cy="22" r="1.9"/><circle cx="49.5" cy="42" r="1.9"/><circle cx="32" cy="52" r="1.9"/><circle cx="14.5" cy="42" r="1.9"/><circle cx="14.5" cy="22" r="1.9"/></g><use href="#sh" clip-path="url(#c4)" opacity=".8"/><use href="#pb3"/></symbol>
<symbol id="rank-4" viewBox="0 0 64 64"><use href="#f8" fill="#1f7a86" stroke="#1f7a86" stroke-width="5"/><use href="#f8" fill="url(#g8)" stroke="#fff" stroke-width="2.2"/><path d="M24.5 14h15l10.5 10.5v15L39.5 50h-15L14 39.5v-15Z" fill="none" stroke="#fff" stroke-width="1.8" opacity=".95"/><path d="M26 17.5h12l8.5 8.5v12L38 46.5H26L17.5 38V26Z" fill="none" stroke="#2f9ea6" stroke-width="1.6" opacity=".85"/><use href="#shc" clip-path="url(#c8)" opacity=".85"/><use href="#pb4"/></symbol>
<symbol id="rank-5" viewBox="0 0 64 64"><use href="#f5" fill="#0f7fae" stroke="#0f7fae" stroke-width="5" stroke-linejoin="round"/><use href="#f5" fill="url(#g5)" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><path d="M17 9l7 14M47 9l-7 14M6 23h52M24 23 32 57 40 23" fill="none" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" opacity=".55"/><use href="#sh" clip-path="url(#c5)" opacity=".8"/><use href="#pb5" transform="translate(0 -4)"/><use href="#sp" fill="#fff" transform="translate(52 7)"/></symbol>
<symbol id="rank-6" viewBox="0 0 64 64"><g fill="#f3ecff" stroke="#4f23a8" stroke-width="2.4" stroke-linejoin="round"><use href="#wg"/><use href="#wg" transform="matrix(-1 0 0 1 64 0)"/></g><use href="#f6" fill="#4f23a8" stroke="#4f23a8" stroke-width="5" stroke-linejoin="round"/><use href="#f6" fill="url(#g6)" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><use href="#sh" clip-path="url(#c6)" opacity=".8"/><use href="#pb6"/></symbol>
<symbol id="rank-7" viewBox="0 0 64 64"><g fill="#ffd34a" stroke="#b8720a" stroke-width="1.6" stroke-linejoin="round"><use href="#lf"/><use href="#lf" transform="matrix(-1 0 0 1 64 0)"/></g><use href="#f7" fill="#4a2f8a" stroke="#4a2f8a" stroke-width="5" stroke-linejoin="round"/><use href="#f7" fill="url(#g7)" stroke="#fff" stroke-width="2.2" stroke-linejoin="round"/><use href="#sh" clip-path="url(#c7)" opacity=".7"/><use href="#cr" fill="#ffd34a" stroke="#b8720a" stroke-width="2" stroke-linejoin="round"/><use href="#pb7" transform="translate(0 2)"/><use href="#sp" fill="#fff" transform="translate(45 17) scale(.75)"/></symbol>
</svg>`;
