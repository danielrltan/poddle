// Share links (docs/SHARE.md 2): one public link per owner, https://poddleball.com/c/<slug>, its page and its picture (server/card.js).
// The slug is 10 random [A-Za-z0-9] from crypto.randomBytes, never derived from an id. What a link shows is read from the owner's profile
// at request time: nothing from the query string. game.js hands every /c/ request to page(); api.js calls make/drop/linkOf.
// page() never throws or rejects, and nothing here logs a slug, a name, an id or an address.
const crypto = require('node:crypto'), fs = require('node:fs'), path = require('node:path');
const db = require('./db'), card = require('./card'), auth = require('./auth'), abuse = require('./abuse');

const SITE = 'https://poddleball.com', ABC = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789', SLUG = /^[A-Za-z0-9]{10}$/;
const ROUTE = /^\/c\/([^/]*?)(\.png)?$/;                          // /c/<slug> and /c/<slug>.png; anything else under /c/ is a plain 404
const OG = path.join(__dirname, '..', 'web', 'og.jpg');
let ogJpg; try { ogJpg = fs.readFileSync(OG); } catch { ogJpg = null; }   // the site's own share picture: what a card falls back to
const MIN = 60e3, DAY = 86400e3, KEYS_MAX = 20000;
const RENDERS = () => { const n = Math.floor(Number(process.env.SHARE_RENDERS)); return Number.isFinite(n) && n > 0 ? n : 30; };   // cache-miss renders per computer a minute (tests lower it)

function newSlug() {                                            // reject-sampled: 248 = 4 x 62, so every letter is equally likely
  let s = '';
  while (s.length < 10) for (const b of crypto.randomBytes(16)) { if (b < 248 && s.length < 10) s += ABC[b % 62]; }
  return s;
}
const hosted = () => !!process.env.FLY_APP_NAME;
function origin(req) {                                           // hosted: always the site's one name, never the Host header. Locally the test's own host, so links work
  if (hosted()) return SITE;
  const h = String(req && req.headers && req.headers.host || '');
  return /^(?:[A-Za-z0-9.-]{1,253}|\[[0-9A-Fa-f:.]{2,45}\])(?::\d{1,5})?$/.test(h) ? 'http://' + h : 'http://localhost';
}
// dataOf(ownerId) -> what the owner's card draws, or null when there is no profile (the play counters come with it as profile.play)
function dataOf(o) {
  const p = db.profileOf(o); if (!p) return null;
  return card.dataOf(p && p.ladder && p.ladder.tier === require('./ladder.js').TOP ? { ...p, places: db.leaderPlaces(o) } : p, db.usernameOf(o));   // Pro: its global leaderboard place for 'PRO #N' (NOTES 124/126); read only for Pro players
}
const links = (base, slug, d) => { const url = base + '/c/' + slug; return { url, image: url + '.png?v=' + card.hashOf(d) }; };
// linkOf(ownerId, req) -> { url, image } | null: the owner's live link (for /api/stats), null when none
function linkOf(o, req) { const s = db.shareOf(o), d = s && dataOf(o); return s && d ? links(origin(req), s.slug, d) : null; }
// make(ownerId, req, now) -> { url, image } | 'nothing' (no saved profile) | null (the database failed). An owner's existing link is returned as it is.
function make(o, req, now) {
  if (!dataOf(o)) return 'nothing';
  for (let i = 0; i < 5; i++) {                                   // a collision among 62^10 slugs is next to impossible; five tries, then give up
    const r = db.shareMake(o, newSlug(), now);
    if (r === 'made' || r === 'have') return linkOf(o, req);
    if (r !== 'taken') return null;
  }
  return null;
}
function forget(o) { try { const s = db.shareOf(o); if (s) card.forget(s.slug); } catch { /* memory only */ } }   // before a delete or a merge takes the row: its cached pictures go with it
const drop = o => { forget(o); return db.shareDrop(o); };        // stop sharing: the row goes, the old link is dead, the next make() is a new slug

// ---- the public routes ----
let salt = crypto.randomBytes(32), saltAt = Date.now(); const buckets = new Map();
function allowRender(req) {                                      // -> { wait (s), b: the bucket charged }. A per-computer budget for cache-miss renders (a keyed hash of the address, never the address; replaced daily)
  const t = Date.now(); if (t - saltAt >= DAY) { salt = crypto.randomBytes(32); saltAt = t; buckets.clear(); }
  const k = crypto.createHmac('sha256', salt).update(abuse.computerKey(auth.clientAddr(req).addr)).digest('base64').slice(0, 22);
  let b = buckets.get(k); if (!b || t - b.at >= MIN) { if (!b && buckets.size >= KEYS_MAX) buckets.clear(); b = { at: t, n: 0 }; buckets.set(k, b); }
  if (b.n >= RENDERS()) return { wait: Math.max(1, Math.ceil((b.at + MIN - t) / 1000)) };
  b.n++; return { wait: 0, b };
}
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
function blurb(d) {                                              // og:description: the same figures for everyone (no picking the flattering ones), then where to play
  const f = k => d.big.find(b => b.label === k) || { value: '-' };
  const v = (k, s) => (f(k).value === '-' ? null : s(f(k).value));   // no data yet: left out of the sentence (the picture shows '-')
  const bits = [`${d.rank} rank`, v('Return rate', x => `${x} return rate`), v('Longest rally', x => `${x}-hit rally`), v('Record vs people', x => `${x} vs people`), d.matt ? `beat ${d.matt} Matt (the bot)` : null].filter(Boolean);
  return bits.join(' · ') + '. Pickleball with your phone as the paddle. Play free at poddleball.com';   // what the game is: most people who see the preview never open the page
}
function html(d, url, image, img) {
  const title = d.guest ? 'A player on Poddle' : `${d.name} on Poddle`, desc = blurb(d), alt = `${d.guest ? 'A Poddle player card' : `${d.name}'s Poddle player card`}: ${[`${d.rank} rank`, d.trophies ? `${d.trophies} ${d.trophies === 1 ? 'trophy' : 'trophies'}` : '', ...d.big.map(b => `${b.label.toLowerCase()} ${b.value}${b.label === 'Fastest swing' ? ' degrees a second' : ''}`), d.matt ? `beat the ${d.matt} bot` : ''].filter(Boolean).join(', ')}`;   // what a screen reader hears in place of the picture
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<meta name="robots" content="noindex">
<meta name="description" content="${esc(desc)}">
<meta property="og:type" content="website">
<meta property="og:site_name" content="Poddle">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(desc)}">
<meta property="og:url" content="${esc(url)}">
<meta property="og:image" content="${esc(image)}">
<meta property="og:image:type" content="image/png">
<meta property="og:image:width" content="1200">
<meta property="og:image:height" content="630">
<meta property="og:image:alt" content="${esc(alt)}">
<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${esc(title)}">
<meta name="twitter:description" content="${esc(desc)}">
<meta name="twitter:image" content="${esc(image)}">
<meta name="twitter:image:alt" content="${esc(alt)}">
<meta name="theme-color" content="#3d9bf0">
<link rel="icon" href="/favicon.svg" type="image/svg+xml">
<link rel="apple-touch-icon" href="/apple-touch-icon.png">
<style>
@font-face{font-family:"Poddle Rounded";font-weight:800;font-style:normal;font-display:swap;src:url(/vendor/fonts/mplus-rounded-1c-800.woff2) format("woff2")}
@font-face{font-family:"Poddle Rounded";font-weight:900;font-style:normal;font-display:swap;src:url(/vendor/fonts/mplus-rounded-1c-900.woff2) format("woff2")}
:root{--ink:#555e67;--ink-strong:#39434d;--ink-soft:#65717b;--me:#3aa0ff;--me-deep:#1670d8;--me-navy:#0e3f8c;--gold-1:#fff1a6;--line-soft:#a9e0f6;--ball:#e6f03c;--ball-deep:#b9c916;
  --font:"Poddle Rounded",ui-rounded,"SF Pro Rounded","Hiragino Maru Gothic ProN","Arial Rounded MT Bold","Nunito","Helvetica Neue",Arial,sans-serif}
*{box-sizing:border-box}
html{background:#7cc6ff}
body{margin:0;min-height:100vh;min-height:100dvh;font-family:var(--font);color:var(--ink);-webkit-font-smoothing:antialiased;
  background:repeating-linear-gradient(135deg,rgba(255,255,255,.07) 0 12px,transparent 12px 28px),linear-gradient(180deg,#3d9bf0 0%,#7cc6ff 55%,#c4e8ff 100%) fixed;
  display:flex;flex-direction:column;align-items:center;padding:clamp(20px,4vh,48px) 16px calc(24px + env(safe-area-inset-bottom))}
main{width:100%;max-width:1000px;display:flex;flex-direction:column;align-items:center;gap:clamp(14px,2.4vh,24px);margin:auto 0}
.logo{display:flex;align-items:center;font-size:clamp(40px,7vw,56px);font-weight:900;line-height:1;letter-spacing:-.01em;color:var(--ink-strong);text-decoration:none;
  filter:drop-shadow(0 .05em 0 rgba(255,255,255,.9)) drop-shadow(0 .09em .12em rgba(30,70,100,.28))}
.logo i{display:inline-block;width:.62em;height:.62em;margin:.16em .035em 0;border-radius:50%;
  background:radial-gradient(circle at 30% 32%,var(--ball-deep) 0 8%,transparent 9%),radial-gradient(circle at 62% 24%,var(--ball-deep) 0 8%,transparent 9%),radial-gradient(circle at 50% 52%,var(--ball-deep) 0 8%,transparent 9%),
    radial-gradient(circle at 22% 62%,var(--ball-deep) 0 7%,transparent 8%),radial-gradient(circle at 78% 54%,var(--ball-deep) 0 7%,transparent 8%),radial-gradient(circle at 48% 82%,var(--ball-deep) 0 7%,transparent 8%),
    radial-gradient(circle at 34% 28%,#fbffa8,var(--ball) 58%,#c5d124 100%);box-shadow:inset 0 -.04em .08em rgba(90,110,0,.35)}
.card{display:block;width:min(100%,960px,max(440px,calc((100vh - 390px) * 1.905)));aspect-ratio:1200/630;border-radius:clamp(14px,2.4vw,28px);overflow:hidden;background:#dcecf6;border:4px solid #fff;box-shadow:0 3px 0 rgba(90,150,185,.25),0 18px 40px rgba(20,60,100,.28)}
.card img{display:block;width:100%;height:100%}
.card:focus-visible{outline:4px solid #fff;outline-offset:4px}
h1{margin:0;font-size:clamp(22px,3.4vw,30px);font-weight:900;line-height:1.25;color:var(--me-navy);text-align:center;text-shadow:0 2px 0 rgba(255,255,255,.8)}
.what{margin:-6px 0 0;font-size:clamp(16px,2.2vw,19px);font-weight:800;color:var(--me-navy);text-align:center}
.play{display:inline-flex;align-items:center;gap:12px;min-height:64px;padding:0 36px;border-radius:999px;font:900 clamp(22px,3vw,28px)/1 var(--font);color:#fff;text-decoration:none;
  background:linear-gradient(180deg,#5ab6ff 0%,var(--me) 50%,#2b8df2 52%,var(--me-deep) 100%);border:2px solid rgba(14,63,140,.25);
  box-shadow:inset 0 2px 0 rgba(255,255,255,.45),0 4px 0 var(--me-navy),0 10px 22px rgba(14,63,140,.3)}
.play:hover{filter:brightness(1.06)} .play:active{transform:translateY(3px);box-shadow:inset 0 2px 0 rgba(255,255,255,.45),0 1px 0 var(--me-navy),0 4px 10px rgba(14,63,140,.3)}
.play:focus-visible{outline:4px solid #fff;outline-offset:4px}
.play svg{width:26px;height:26px;fill:#fff}
.own{margin:0;font-size:clamp(15px,2vw,18px);font-weight:800;color:var(--ink-strong);text-align:center;background:rgba(255,255,255,.78);padding:10px 18px;border-radius:999px}
.own a{color:var(--me-deep)}
@media (prefers-reduced-motion:no-preference){.card{animation:up .6s cubic-bezier(.34,1.56,.64,1) both}@keyframes up{from{opacity:0;transform:translateY(16px) scale(.97)}}}
</style>
</head><body>
<main>
<a class="logo" href="/" aria-label="Poddle home">P<i></i>ddle</a>
<a class="card" href="/"><img src="${esc(img)}" width="1200" height="630" alt="${esc(alt)}"></a>
<h1>${d.guest ? 'This player' : esc(d.name)} plays pickleball with a phone for a paddle.</h1>
<p class="what">Free in your browser. Play with your phone or an AirPod.</p>
<a class="play" href="/"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.2-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5Z"/></svg>Play Poddle free</a>
<p class="own">Make your own card: <a href="/">play</a>, then open Your stats</p>
</main>
</body></html>`;
}
const HEAD = { 'Cache-Control': 'public, max-age=300', 'X-Robots-Tag': 'noindex' };
function empty404(res) { res.writeHead(404, { 'Content-Length': 0, 'Cache-Control': 'no-cache', 'X-Robots-Tag': 'noindex' }); res.end(); }
function send(req, res, status, head, body) { if (res.headersSent || res.writableEnded) return; res.writeHead(status, { ...head, 'Content-Length': body ? body.length : 0 }); res.end(req.method === 'HEAD' || !body ? undefined : body); }
function fallback(req, res) {                                    // no renderer (or a failed render): the site's own picture, briefly cached so the real card is fetched again soon
  if (!ogJpg) return empty404(res);
  send(req, res, 200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'public, max-age=60', 'X-Robots-Tag': 'noindex' }, ogJpg);
}
// page(req, res, rel, notFound) -> Promise, never rejects. rel: the decoded path, starting /c/. GET/HEAD only (game.js answered 405 already).
async function page(req, res, rel, notFound) {
  try {
    const m = ROUTE.exec(rel), slug = m && m[1], png = !!(m && m[2]);
    const o = slug && SLUG.test(slug) ? db.shareOwner(slug) : null, d = o != null ? dataOf(o) : null;   // unknown or malformed: a 404 and nothing rendered
    if (!d) return png ? empty404(res) : notFound(req, res);
    const hash = card.hashOf(d), etag = `"${hash}"`;
    if (!png) return send(req, res, 200, { 'Content-Type': 'text/html; charset=utf-8', ...HEAD }, Buffer.from(html(d, origin(req) + '/c/' + slug, origin(req) + `/c/${slug}.png?v=${hash}`, `/c/${slug}.png?v=${hash}`)));
    const inm = String(req.headers['if-none-match'] || '');
    if (inm && inm.split(',').some(t => t.trim().replace(/^W\//, '') === etag)) { res.writeHead(304, { ...HEAD, ETag: etag }); return res.end(); }
    const key = slug + ':' + hash;
    const charged = card.isCached(key) ? null : allowRender(req);
    if (charged && charged.wait) { res.writeHead(429, { 'Retry-After': String(charged.wait), 'Content-Length': 0, 'Cache-Control': 'no-store' }); return res.end(); }
    const buf = await card.png(key, d);
    if (buf === 'busy' && charged && charged.b.n > 0) charged.b.n--;   // nothing was drawn for it: the retry Retry-After asks for must not find the budget spent
    if (buf === 'busy') { res.writeHead(503, { 'Retry-After': '5', 'Content-Length': 0, 'Cache-Control': 'no-store' }); return res.end(); }
    if (!buf) return fallback(req, res);
    send(req, res, 200, { 'Content-Type': 'image/png', ...HEAD, ETag: etag }, buf);
  } catch {
    try { if (!res.headersSent) { res.writeHead(500, { 'Content-Length': 0 }); res.end(); } else res.destroy(); } catch { /* the socket is gone */ }
  }
}

module.exports = { make, drop, forget, linkOf, page, newSlug, origin, SLUG };
