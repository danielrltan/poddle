// Page views, counted here and nowhere else (NOTES 219; privacy 2 and 7): per UTC day, per page, per source, two numbers, views and
// people. No cookie, no script, no third party. "People" is how many distinct network addresses saw that cell today: each address is
// keyed (HMAC, a random salt this process made for the day) and held in a Set in memory until the day ends; the key is never written
// anywhere, so a restart starts the day's people count over (a visitor who comes back after a deploy is two). Counts flush to the
// traffic table (server/db.js) once a minute as deltas. Source: ?ref= or ?utm_source= on the link (what we tag our own posts with),
// else the Referer's host (www. dropped; our own host is 'site': a click inside the game), else 'direct'. Crawlers and link
// previews land in 'bot' by user agent. Only a GET of an HTML page that was found counts: not HEAD, not a 404, not /api, not a share
// card (the slug would be a person). `node server/admin.js traffic [days]` prints the table.
const crypto = require('node:crypto');
const DAY = 86400e3, SOURCE_CAP = 200;                              // distinct sources a day before the rest fold into 'other': a Referer is anyone's string
const BOT = /bot|crawl|spider|slurp|fetch|preview|headless|curl|wget|python|java\/|go-http|facebookexternalhit|whatsapp|telegram|discord|slack|skype|lighthouse|pagespeed|pingdom|uptime|monitor|validator|embedly|quora|twitterbot|linkedinbot|bingpreview/i;
const SAFE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;                         // a ref tag or a host, as stored

let now = Date.now, site = 'poddleball.com', addrOf = () => 'local', dbh = null, log = console.log, timer = null;
let day = '', salt = null;
const cells = new Map();                                            // "day\0page\0source" -> { day, page, source, views, people, dv, dp, seen: Set }
let sources = 0;                                                    // distinct sources this day
let warned = false;

function init(o = {}) {
  if (o.now) now = o.now; if (o.site) site = String(o.site).toLowerCase(); if (o.addrOf) addrOf = o.addrOf; if (o.db) dbh = o.db; if (o.log) log = o.log;
  const ms = Math.max(50, Number(o.flushMs) || 60e3);
  if (timer) clearInterval(timer);
  timer = setInterval(() => { try { flush(); } catch (e) { log('traffic: flush failed ' + (e && e.code || '')); } }, ms); if (timer.unref) timer.unref();
}
function stop() { if (timer) clearInterval(timer); timer = null; flush(); }

const dayOf = t => new Date(t).toISOString().slice(0, 10);
function roll(t) {                                                  // a new UTC day: flush what the old one still holds, forget its people, new salt
  const d = dayOf(t); if (d === day) return;
  flush(); cells.clear(); sources = 0; day = d; salt = crypto.randomBytes(32);
}
function sourceOf(req) {
  const ua = String(req.headers['user-agent'] || '');
  if (!ua || BOT.test(ua)) return 'bot';
  const q = String(req.url || '').split('?')[1] || '';
  if (q) { const p = new URLSearchParams(q), tag = (p.get('ref') || p.get('utm_source') || '').trim().toLowerCase(); if (tag) return SAFE.test(tag) ? tag : 'other'; }
  const ref = String(req.headers.referer || req.headers.referrer || '');
  if (!ref) return 'direct';
  let host; try { host = new URL(ref).hostname.toLowerCase().replace(/^www\./, ''); } catch { return 'other'; }
  if (!host) return 'other';
  if (host === site || host.endsWith('.' + site)) return 'site';
  return SAFE.test(host) ? host : 'other';
}
function pageOf(rel) {                                              // what game.js resolved: '/index.html' for the home and the menu views
  if (rel === '/index.html' || rel === '/' || rel === '') return '/';
  return rel.replace(/\.html$/, '').slice(0, 64);
}
function cell(d, page, source) {
  const k = d + '\0' + page + '\0' + source; let c = cells.get(k);
  if (!c) { c = { day: d, page, source, views: 0, people: 0, dv: 0, dp: 0, seen: new Set() }; cells.set(k, c); }
  return c;
}
// game.js, once per HTML file it found and is sending (200 or 304) for a GET
function hit(req, rel) {
  try {
    if (!req || req.method !== 'GET') return;
    if (typeof rel !== 'string') rel = String(req.url || '/').split('?')[0];
    const t = now(); roll(t);
    let source = sourceOf(req);
    if (source !== 'bot' && source !== 'direct' && source !== 'site' && !cells.has(day + '\0\0' + source)) { if (sources >= SOURCE_CAP) source = 'other'; else sources++; }
    const page = pageOf(rel), who = crypto.createHmac('sha256', salt).update(String(addrOf(req))).digest('base64').slice(0, 22);
    for (const [p, s] of [[page, source], ['', source], [page, ''], ['', '']]) {   // the cell, its source total, its page total, the day total
      const c = cell(day, p, s); c.views++; c.dv++;
      if (!c.seen.has(who)) { c.seen.add(who); c.people++; c.dp++; }
    }
  } catch (e) { if (!warned) { warned = true; log('traffic: count failed, ' + (e && e.message)); } }   // once: a count is never worth a request
}
function flush() {
  if (!dbh || !dbh.trafficAdd) return 0;
  const rows = []; for (const c of cells.values()) if (c.dv || c.dp) rows.push({ day: c.day, page: c.page, source: c.source, views: c.dv, people: c.dp });
  if (!rows.length) return 0;
  if (!dbh.trafficAdd(rows)) return 0;                              // the database is away: keep the deltas for the next try
  for (const c of cells.values()) { c.dv = 0; c.dp = 0; }
  return rows.length;
}
// a report over the last `days` UTC days (today included), from the table plus what is not flushed yet: [{ day, views, people, sources: [...], pages: [...] }]
function report(days = 7) {
  flush();
  const rows = dbh && dbh.trafficReport ? dbh.trafficReport(dayOf(now() - (Math.max(1, days | 0) - 1) * DAY)) || [] : [];
  const out = new Map();
  for (const r of rows) {
    let d = out.get(r.day); if (!d) { d = { day: r.day, views: 0, people: 0, sources: [], pages: [] }; out.set(r.day, d); }
    if (r.page === '' && r.source === '') { d.views = r.views; d.people = r.people; }
    else if (r.page === '') d.sources.push({ source: r.source, views: r.views, people: r.people });
    else if (r.source === '') d.pages.push({ page: r.page, views: r.views, people: r.people });
  }
  const list = [...out.values()].sort((a, b) => b.day.localeCompare(a.day));
  for (const d of list) { d.sources.sort((a, b) => b.people - a.people || b.views - a.views || a.source.localeCompare(b.source)); d.pages.sort((a, b) => b.views - a.views); }
  return list;
}
module.exports = { init, stop, hit, flush, report, sourceOf, pageOf };
