// Page-load diagnostics for poddleball.com and the owner's danielrltan.com (NOTES 232; privacy 2, 5 and 7). web/rum.js sends, per page load:
// the browser's own timings (navigation phases, paints, the files it fetched, long main-thread frames with the scripts in them, how long
// clicks took to answer) and, for a sample of Chromium loads, a JS Self-Profiling trace of the load (the flame graph). This file checks and
// shapes every field (nothing is stored as sent), strips every query string and fragment from every URL (pad.html?k= is a pairing code, a
// share link /c/<slug> is a person), and keeps no address, no cookie and no identifier: a view's id is a random number the page made for
// that one load. The user agent becomes "Chrome 141 · macOS" and is dropped. Bots (traffic.js's list) are never stored.
// The owner reads it on danielrltan.com/stats through api.js (STATS_KEY). Limits: 4 KB-ish gzipped per view part, 400 views a site a day,
// 30 days, 8000 views and 200 profiles in all (the database's size cap is shared with player stats: this stays under ~60 MB at worst).
const zlib = require('node:zlib');
const db = require('./db'), traffic = require('./traffic');

const DAY = 86400e3, HOUR = 3600e3;
const LIMITS = { dayCap: 400, days: 30, views: 8000, profiles: 200, beacon: 65536, profileGz: 262144, profileRaw: 4 << 20 };
const SITES = { 'https://poddleball.com': 'poddleball.com', 'https://danielrltan.com': 'danielrltan.com', 'https://www.danielrltan.com': 'danielrltan.com' };
const NAMES = new Set(Object.values(SITES));
const LOCAL = /^http:\/\/(localhost|127\.0\.0\.1):\d{1,5}$/;
let hosted = false, timer = null;

function init(o = {}) {
  hosted = !!o.hosted;
  if (timer) clearInterval(timer);
  timer = setInterval(() => sweep(Date.now()), HOUR); if (timer.unref) timer.unref();
}
const sweep = now => db.perfSweep(now, LIMITS.days, LIMITS.views, LIMITS.profiles);

// the site a beacon is about, from its Origin header (never from the body), or null = refuse. A local dev server may name either site
function siteOf(origin, hint) {
  if (SITES[origin]) return SITES[origin];
  if (!hosted && LOCAL.test(origin || '')) return NAMES.has(hint) ? hint : 'localhost';
  return null;
}
const isBot = ua => !ua || traffic.BOT.test(ua);

// "Chrome 141 · macOS · mobile": the family, major version and platform, nothing finer
function uaOf(ua) {
  ua = String(ua || '');
  const m = /Edg\/(\d+)/.exec(ua) ? ['Edge', /Edg\/(\d+)/.exec(ua)[1]] : /OPR\/(\d+)/.exec(ua) ? ['Opera', /OPR\/(\d+)/.exec(ua)[1]]
    : /SamsungBrowser\/(\d+)/.exec(ua) ? ['Samsung', /SamsungBrowser\/(\d+)/.exec(ua)[1]] : /Firefox\/(\d+)/.exec(ua) ? ['Firefox', /Firefox\/(\d+)/.exec(ua)[1]]
    : /CriOS\/(\d+)/.exec(ua) ? ['Chrome', /CriOS\/(\d+)/.exec(ua)[1]] : /Chrome\/(\d+)/.exec(ua) ? ['Chrome', /Chrome\/(\d+)/.exec(ua)[1]]
    : /Version\/(\d+).*Safari/.exec(ua) ? ['Safari', /Version\/(\d+)/.exec(ua)[1]] : ['Other', ''];
  const os = /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Android/.test(ua) ? 'Android' : /CrOS/.test(ua) ? 'ChromeOS' : /Mac OS X|Macintosh/.test(ua) ? 'macOS' : /Windows/.test(ua) ? 'Windows' : /Linux/.test(ua) ? 'Linux' : 'Other';
  return (m[0] + (m[1] ? ' ' + m[1] : '')) + ' · ' + os + (/Mobi|iPhone|Android.*Mobile/.test(ua) ? ' · mobile' : '');
}

// ---- shaping: every field read by name, type-checked, clamped; anything else is dropped ----
const T_MAX = 600e3;                                                 // ms after navigation start: a later timing is a broken clock
const num = (v, lo = 0, hi = T_MAX) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(Math.min(hi, Math.max(lo, v)) * 10) / 10 : null);
const str = (v, n) => (typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, '').slice(0, n) : '');
const arr = (v, n) => (Array.isArray(v) ? v.slice(0, n) : []);
const obj = v => (v && typeof v === 'object' && !Array.isArray(v) ? v : {});
// a URL as stored: no query, no fragment, no user:pass; the page's own origin becomes a bare path; a share link's slug becomes *
function url(u, origin) {
  if (typeof u !== 'string' || !u) return '';
  let x; try { x = new URL(u, origin); } catch { return ''; }
  if (!/^https?:$/.test(x.protocol)) return x.protocol.replace(':', '');   // blob:, data:, chrome-extension: -> the scheme alone
  let p = x.pathname.slice(0, 160);
  if (x.hostname === 'poddleball.com' || x.origin === origin && origin === 'https://poddleball.com') p = p.replace(/^\/c\/[^/]*/, '/c/*');
  return x.origin === origin ? p : x.origin + p;
}
const pageOf = (p, origin) => { const u = url(p, origin); return u.startsWith('/') ? u.slice(0, 64) : '/'; };
// an element as the page described it: 'button', 'button#play', or a data-rum label. Site-authored names only, never text
const target = v => str(v, 48).replace(/[^\w#.:\-\s/]/g, '');
// a LoAF invoker can be a URL ('https://x/main.js') or 'BUTTON#id.onclick': URLs are stripped like any other
const invoker = (v, origin) => { const s = str(v, 200); return /^https?:\/\//.test(s) ? url(s, origin) : s.slice(0, 80); };

function shapeLoad(b, origin) {
  const n = obj(b.nav), env = obj(b.env);
  const nav = {}; for (const k of ['rs', 'ws', 'fs', 'ds', 'de', 'cs', 'ss', 'ce', 'qs', 'ps', 'pe', 'di', 'dc', 'dl', 'ls', 'le']) nav[k] = num(n[k]);
  nav.ty = str(n.ty, 12); nav.pr = str(n.pr, 8); nav.z = num(n.z, 0, 1e9); nav.eb = num(n.eb, 0, 1e9); nav.st = num(n.st, 0, 999);
  const res = arr(b.res, 150).map(r => { r = arr(r, 10); return [url(r[0], origin), str(r[1], 16), num(r[2]), num(r[3]), num(r[4], 0, 1e9), num(r[5], 0, 1e9), num(r[6]), str(r[7], 16), num(r[8], 0, 999)]; }).filter(r => r[0]);
  const loaf = arr(b.loaf, 40).map(shapeLoaf(origin));
  const marks = arr(b.marks, 40).map(m => { m = arr(m, 3); return [str(m[0], 48), num(m[1]), num(m[2])]; }).filter(m => m[0]);
  return {
    nav, fp: num(b.fp), fcp: num(b.fcp), lcp: shapeLcp(b.lcp, origin), res, loaf, marks,
    env: { w: num(env.w, 0, 20000), h: num(env.h, 0, 20000), dpr: num(env.dpr, 0, 10), mem: num(env.mem, 0, 1024), cpu: num(env.cpu, 0, 1024), net: str(env.net, 8), save: env.save === true },
    prof: b.prof === true, profErr: str(b.profErr, 60),
  };
}
const shapeLcp = (l, origin) => { l = obj(l); return { t: num(l.t), el: target(l.el), u: url(l.u, origin), z: num(l.z, 0, 1e8) }; };
const shapeLoaf = origin => f => { f = arr(f, 6); return [num(f[0]), num(f[1]), num(f[2]), num(f[3]), num(f[4]),
  arr(f[5], 8).map(s => { s = arr(s, 8); return [url(s[0], origin) || str(s[0], 0), str(s[1], 80), invoker(s[2], origin), str(s[3], 24), num(s[4]), num(s[5]), num(s[6]), num(s[7], -1, 1e7)]; })]; };
function shapeFin(b, origin, clicks) {
  return {
    lcp: shapeLcp(b.lcp, origin), cls: typeof b.cls === 'number' && Number.isFinite(b.cls) ? Math.round(Math.min(100, Math.max(0, b.cls)) * 1e4) / 1e4 : null, inp: num(b.inp, 0, 60e3), dur: num(b.dur, 0, 864e5),
    ev: arr(b.ev, 30).map(e => { e = arr(e, 7); return [str(e[0], 16), target(e[1]), num(e[2], 0, 864e5), num(e[3], 0, 60e3), num(e[4], 0, 60e3), num(e[5], 0, 60e3), num(e[6], 0, 60e3)]; }),
    loaf: arr(b.loaf, 30).map(shapeLoaf(origin)),
    clicks: clicks ? arr(b.clicks, 200).map(c => { c = arr(c, 2); return [target(c[0]), num(c[1], 0, 864e5)]; }).filter(c => c[0]) : [],   // poddleball.com never sends targets (privacy 2: latency only)
  };
}
// the sum of each long frame's blocking time during the load: the "total blocking time" column
const blockOf = loaf => Math.round(loaf.reduce((a, f) => a + (f[2] || 0), 0) * 10) / 10;

// a beacon body (text/plain JSON, either part) -> { ok, status }
function beacon({ origin, ua, body, now = Date.now() }) {
  const b0 = (() => { try { return JSON.parse(body); } catch { return null; } })(), b = obj(b0);
  const site = siteOf(origin, b.site);
  if (!site) return { status: 403 };
  if (isBot(ua)) return { status: 204 };
  const id = typeof b.id === 'string' && /^[0-9a-f]{16}$/.test(b.id) ? b.id : null;
  if (!id || (b.kind !== 'load' && b.kind !== 'fin')) return { status: 400 };
  if (db.nearFull()) return { status: 204 };                         // player stats come first
  const page = pageOf(b.page, origin), base = { id, site, page, at: now, ua: uaOf(ua) };
  if (b.kind === 'load') {
    const L = shapeLoad(b, origin), n = L.nav;
    const v = { ...base, ttfb: n.ps, fcp: L.fcp, lcp: L.lcp.t, dcl: n.dl, onload: n.le, inp: null, cls: null, block: blockOf(L.loaf), load: zlib.gzipSync(JSON.stringify(L)) };
    return { status: db.perfPut(v, LIMITS.dayCap) ? 204 : 429 };
  }
  const F = shapeFin(b, origin, site === 'danielrltan.com' || site === 'localhost');
  const v = { ...base, lcp: F.lcp.t, inp: F.inp, cls: F.cls, fin: zlib.gzipSync(JSON.stringify(F)) };
  return { status: db.perfFin(v, LIMITS.dayCap) ? 204 : 429 };
}

// a JS Self-Profiling trace (gzipped or plain JSON) for view `id` -> { status }. Frames' URLs are stripped like the rest; the trace is re-gzipped
function profile({ origin, ua, id, hint, body, now = Date.now() }) {
  const site = siteOf(origin, hint);
  if (!site) return { status: 403 };
  if (isBot(ua)) return { status: 204 };
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return { status: 400 };
  if (db.nearFull()) return { status: 204 };
  let raw = body;
  if (raw.length > 1 && raw[0] === 0x1f && raw[1] === 0x8b) { try { raw = zlib.gunzipSync(raw, { maxOutputLength: LIMITS.profileRaw }); } catch { return { status: 400 }; } }
  if (raw.length > LIMITS.profileRaw) return { status: 413 };
  let t; try { t = JSON.parse(raw.toString('utf8')); } catch { return { status: 400 }; }
  t = obj(t);
  const resources = arr(t.resources, 200).map(u => url(u, origin));
  const frames = arr(t.frames, 20000).map(f => { f = obj(f); const o = { name: str(f.name, 120) };
    if (Number.isInteger(f.resourceId) && f.resourceId >= 0 && f.resourceId < resources.length) o.resourceId = f.resourceId;
    if (Number.isInteger(f.line)) o.line = f.line; if (Number.isInteger(f.column)) o.column = f.column; return o; });
  const stacks = arr(t.stacks, 50000).map(s => { s = obj(s); const o = { frameId: Number.isInteger(s.frameId) && s.frameId >= 0 && s.frameId < frames.length ? s.frameId : 0 };
    if (Number.isInteger(s.parentId) && s.parentId >= 0) o.parentId = s.parentId; return o; });
  const samples = arr(t.samples, 20000).map(s => { s = obj(s); const o = { timestamp: num(s.timestamp, 0, 864e5) };
    if (Number.isInteger(s.stackId) && s.stackId >= 0 && s.stackId < stacks.length) o.stackId = s.stackId; return o; });
  if (!samples.length) return { status: 400 };
  const gz = zlib.gzipSync(JSON.stringify({ resources, frames, stacks, samples }));
  if (gz.length > LIMITS.profileGz) return { status: 413 };
  return { status: db.perfProfile(id, site, now, gz) ? 204 : 409 };
}

// ---- the owner's reads (api.js, behind STATS_KEY) ----
const unzip = b => { if (!b) return null; try { return JSON.parse(zlib.gunzipSync(b).toString('utf8')); } catch { return null; } };
const listOf = (site, days, now = Date.now()) => db.perfList(NAMES.has(site) || site === 'localhost' ? site : 'poddleball.com', now - Math.min(30, Math.max(1, days | 0)) * DAY, 2000);
function viewOf(id) {
  if (typeof id !== 'string' || !/^[0-9a-f]{16}$/.test(id)) return null;
  const r = db.perfGet(id); if (!r) return null;
  const { load, fin, ...row } = r;
  return { ...row, load: unzip(load), fin: unzip(fin) };
}
const profileOf = id => (typeof id === 'string' && /^[0-9a-f]{16}$/.test(id) ? db.perfProfileGet(id) : null);   // the stored gzip, sent as is
const profileIds = (site, page, days, now = Date.now()) => db.perfProfileIds(site, String(page || '/').slice(0, 64), now - Math.min(30, Math.max(1, days | 0)) * DAY, 30) || [];

module.exports = { init, sweep, beacon, profile, listOf, viewOf, profileOf, profileIds, siteOf, uaOf, url, LIMITS };
