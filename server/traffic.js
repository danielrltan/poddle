// Page views, counted here and nowhere else (NOTES 219; privacy 2 and 7): per UTC day, per page, per source, two numbers, views and
// people. No cookie, no script, no third party. "People" is how many distinct network addresses saw that cell today: each address is
// keyed (HMAC, a random salt this process made for the day) and held in a Set in memory until the day ends; the key is never written
// anywhere, so a restart starts the day's people count over (a visitor who comes back after a deploy is two). Counts flush to the
// traffic table (server/db.js) once a minute as deltas. Source: ?ref= or ?utm_source= on the link (what we tag our own posts with),
// else the Referer's host (www. dropped; our own host is 'site': a click inside the game), else 'direct'. Crawlers and link
// previews land in 'bot' by user agent. Only a GET of an HTML page that was found counts: not HEAD, not a 404, not /api, not a share
// card (the slug would be a person), not a request with no client address (Fly's health check). `node server/admin.js traffic [days]` prints the table.
// Other sites (NOTES 233: danielrltan.com, which dropped Umami): perf.js counts each page load's beacon here with view(), the same way, into the
// site_traffic table, and the page's named events (src/analytics.ts track(): section_view, project_open, ...) with event() into site_events. The
// counts for poddleball.com never come from a beacon: its pages are counted by game.js as they are served.
const crypto = require('node:crypto');
const DAY = 86400e3, SOURCE_CAP = 200;                              // distinct sources a day before the rest fold into 'other': a Referer is anyone's string
const BOT = /bot|crawl|spider|slurp|fetch|preview|headless|curl|wget|python|java\/|go-http|health|consul|facebookexternalhit|whatsapp|telegram|discord|slack|skype|lighthouse|pagespeed|pingdom|uptime|monitor|validator|embedly|quora|twitterbot|linkedinbot|bingpreview/i;
const SAFE = /^[a-z0-9][a-z0-9_.-]{0,31}$/;                         // a ref tag or a host, as stored

let now = Date.now, site = 'poddleball.com', addrOf = () => 'local', dbh = null, log = console.log, timer = null;
let day = '', salt = null;
const cells = new Map();                                            // "site\0day\0page\0source" -> { site, day, page, source, views, people, dv, dp, seen: Set }
const sources = new Map();                                          // site -> distinct sources this day
const evs = new Map();                                              // "site\0day\0name\0detail" -> { site, day, name, detail, dn }; flushed as deltas, then dropped
const evKinds = new Map();                                          // site -> distinct name+detail this day
const EVENT_CAP = 500;                                              // distinct events a site a day before the rest fold into detail 'other'
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
  flush(); cells.clear(); sources.clear(); evKinds.clear(); day = d; salt = crypto.randomBytes(32);
}
function sourceOf(req, own = site) {
  const q = String(req.url || '').split('?')[1] || '', p = new URLSearchParams(q);
  return sourceFor({ ua: req.headers['user-agent'], tag: p.get('ref') || p.get('utm_source'), referer: req.headers.referer || req.headers.referrer }, own);
}
// { ua, tag (?ref= / ?utm_source=), referer } -> the source, for `own` site: our own host is 'site'
function sourceFor({ ua, tag, referer }, own = site) {
  ua = String(ua || '');
  if (!ua || BOT.test(ua)) return 'bot';
  tag = String(tag || '').trim().toLowerCase();
  if (tag) return SAFE.test(tag) ? tag : 'other';
  const ref = String(referer || '');
  if (!ref) return 'direct';
  let host; try { host = new URL(ref).hostname.toLowerCase().replace(/^www\./, ''); } catch { return 'other'; }
  if (!host) return 'other';
  if (host === own || host.endsWith('.' + own)) return 'site';
  return SAFE.test(host) ? host : 'other';
}
function pageOf(rel) {                                              // what game.js resolved: '/index.html' for the home and the menu views
  if (rel === '/index.html' || rel === '/' || rel === '') return '/';
  return rel.replace(/\.html$/, '').slice(0, 64);
}
function cell(st, d, page, source) {
  const k = st + '\0' + d + '\0' + page + '\0' + source; let c = cells.get(k);
  if (!c) { c = { site: st, day: d, page, source, views: 0, people: 0, dv: 0, dp: 0, seen: new Set() }; cells.set(k, c); }
  return c;
}
// one view of `page` on site `st` from `source` by the network address `addr`: the cell, its source total, its page total, the day total
function count(st, page, source, addr) {
  const t = now(); roll(t);
  if (source !== 'bot' && source !== 'direct' && source !== 'site' && !cells.has(st + '\0' + day + '\0\0' + source)) {
    const n = sources.get(st) || 0; if (n >= SOURCE_CAP) source = 'other'; else sources.set(st, n + 1);
  }
  const who = crypto.createHmac('sha256', salt).update(st + '\0' + addr).digest('base64').slice(0, 22);
  for (const [p, s] of [[page, source], ['', source], [page, ''], ['', '']]) {
    const c = cell(st, day, p, s); c.views++; c.dv++;
    if (!c.seen.has(who)) { c.seen.add(who); c.people++; c.dp++; }
  }
}
// game.js, once per HTML file it found and is sending (200 or 304) for a GET
function hit(req, rel) {
  try {
    if (!req || req.method !== 'GET') return;
    if (typeof rel !== 'string') rel = String(req.url || '/').split('?')[0];
    const addr = String(addrOf(req) || ''); if (!addr || addr === 'bad') return;   // no client address: Fly's health check (fly.toml, GET / every 15 s, not through the proxy), never a person
    count(site, pageOf(rel), sourceOf(req), addr);
  } catch (e) { if (!warned) { warned = true; log('traffic: count failed, ' + (e && e.message)); } }   // once: a count is never worth a request
}
// perf.js, once per page load's load beacon from another site: { page (a path, already stripped), ua, tag, referer, req }
function view(st, { page, ua, tag, referer, req }) {
  try {
    if (!st || st === site) return;                                 // poddleball.com is counted as it is served, never twice
    const addr = String(addrOf(req) || ''); if (!addr || addr === 'bad') return;
    const source = sourceFor({ ua, tag, referer }, st); if (source === 'bot') return;
    count(st, String(page || '/').slice(0, 64), source, addr);
  } catch (e) { if (!warned) { warned = true; log('traffic: count failed, ' + (e && e.message)); } }
}
// a named event on another site: name (a-z0-9_, 32), detail (what the page said it was about, 80), counted per UTC day
function event(st, name, detail) {
  try {
    if (!st || st === site || typeof name !== 'string' || !/^[a-z][a-z0-9_]{0,31}$/.test(name)) return;
    const t = now(); roll(t);
    detail = typeof detail === 'string' ? detail.replace(/[\u0000-\u001f]/g, '').slice(0, 80) : '';
    let k = st + '\0' + day + '\0' + name + '\0' + detail;
    if (!evs.has(k)) { const n = evKinds.get(st) || 0; if (n >= EVENT_CAP) { detail = 'other'; k = st + '\0' + day + '\0' + name + '\0other'; } else evKinds.set(st, n + 1); }
    let e = evs.get(k); if (!e) evs.set(k, e = { site: st, day, name, detail, dn: 0 }); e.dn++;
  } catch { /* a count is never worth a request */ }
}
function flush() {
  if (!dbh || !dbh.trafficAdd) return 0;
  const own = [], other = [];
  for (const c of cells.values()) if (c.dv || c.dp) (c.site === site ? own : other).push(c);
  const row = c => ({ site: c.site, day: c.day, page: c.page, source: c.source, views: c.dv, people: c.dp });
  let n = 0;
  if (own.length && dbh.trafficAdd(own.map(row))) { for (const c of own) { c.dv = 0; c.dp = 0; } n += own.length; }   // the database is away: keep the deltas for the next try
  if (other.length && dbh.siteTrafficAdd && dbh.siteTrafficAdd(other.map(row))) { for (const c of other) { c.dv = 0; c.dp = 0; } n += other.length; }
  const ev = [...evs.values()].filter(e => e.dn);
  if (ev.length && dbh.siteEventsAdd && dbh.siteEventsAdd(ev.map(e => ({ site: e.site, day: e.day, name: e.name, detail: e.detail, n: e.dn })))) {
    for (const [k, e] of evs) if (e.day !== day) evs.delete(k); else e.dn = 0;
  }
  return n;
}
// a report over the last `days` UTC days (today included), from the table plus what is not flushed yet: [{ day, views, people, sources: [...], pages: [...] }]
function report(days = 7, st = site) {
  flush();
  const from = dayOf(now() - (Math.max(1, days | 0) - 1) * DAY), own = st === site;
  const rows = (own ? dbh && dbh.trafficReport && dbh.trafficReport(from) : dbh && dbh.siteTrafficReport && dbh.siteTrafficReport(st, from)) || [];
  const out = new Map();
  const dayRow = k => { let d = out.get(k); if (!d) { d = { day: k, views: 0, people: 0, sources: [], pages: [], ...(own ? {} : { events: [] }) }; out.set(k, d); } return d; };
  if (!own) for (const e of (dbh && dbh.siteEventsReport && dbh.siteEventsReport(st, from)) || []) dayRow(e.day).events.push({ name: e.name, detail: e.detail, n: e.n });
  for (const r of rows) {
    const d = dayRow(r.day);
    if (r.page === '' && r.source === '') { d.views = r.views; d.people = r.people; }
    else if (r.page === '') d.sources.push({ source: r.source, views: r.views, people: r.people });
    else if (r.source === '') d.pages.push({ page: r.page, views: r.views, people: r.people });
  }
  const list = [...out.values()].sort((a, b) => b.day.localeCompare(a.day));
  for (const d of list) { d.sources.sort((a, b) => b.people - a.people || b.views - a.views || a.source.localeCompare(b.source)); d.pages.sort((a, b) => b.views - a.views); }
  return list;
}
module.exports = { init, stop, hit, view, event, flush, report, sourceOf, sourceFor, pageOf, BOT };   // BOT: perf.js drops the same crawlers
