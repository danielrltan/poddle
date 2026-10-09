// Page-load diagnostics (NOTES 232; privacy 2 and 7). One copy serves poddleball.com, another danielrltan.com (public/rum.js there): keep them the same.
// Loaded with <script async> first in <head>: it never holds up the parser, and the profiler still starts before most of the page's code. It reads what the browser already measured
// (navigation phases, paints, the files fetched, long main-thread frames and the scripts in them, how long each click took to answer) and sends it
// twice to the collector: the load part once the page has settled, the fin part when the tab is hidden or closed. For a sample of Chromium loads it
// also records a JS Self-Profiling trace from here to 3 s after load (the page must be served with Document-Policy: js-profiling) and uploads it gzipped.
// Nothing is stored in the browser; the id is random per load. URLs leave without their query string or fragment. data-clicks="targets" adds which
// element was clicked (by data-rum, id or class, never its text); without it a click is described by its tag alone.
// The load part also names where the visit came from (the referrer's origin only, and a ?ref= / ?utm_source= tag): the collector counts other sites'
// page views from it (NOTES 233). Named events: the page pushes [name, { props }] onto window.rumEvents (danielrltan.com's src/analytics.ts track());
// each fin part carries the ones not sent yet, as [name, detail], detail = the props' values in key order, URLs without query.
// <script async src="/rum.js" data-endpoint="https://poddleball.com/api/perf" data-profile="0.5" data-clicks="targets"></script>
(function () {
  'use strict';
  var me = document.currentScript, ds = (me && me.dataset) || {};
  var END = ds.endpoint || '/api/perf', SITE = ds.site || '', TARGETS = ds.clicks === 'targets', RATE = Math.min(1, Math.max(0, window.__rumProfile != null ? +window.__rumProfile : parseFloat(ds.profile) || 0));
  var P = window.performance;
  if (!P || !P.getEntriesByType || !window.JSON) return;
  var host = location.hostname;
  if (!window.__rumForce && (navigator.webdriver || host === 'localhost' || host === '127.0.0.1' || location.protocol === 'file:')) return;   // tests and dev servers are not visitors (a test sets window.__rumForce)

  var id = (function () { var a = new Uint8Array(8); (window.crypto || window.msCrypto).getRandomValues(a); var s = ''; for (var i = 0; i < 8; i++) s += (a[i] < 16 ? '0' : '') + a[i].toString(16); return s; })();
  var page = location.pathname;
  var r1 = function (v) { return typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : null; };
  var bare = function (u) { if (!u) return ''; var i = u.search(/[?#]/); return i < 0 ? u : u.slice(0, i); };
  var qs = (function () { try { var p = new URLSearchParams(location.search); return (p.get('ref') || p.get('utm_source') || '').slice(0, 40); } catch (e) { return ''; } })();
  var from = (function () { try { return document.referrer ? new URL(document.referrer).origin : ''; } catch (e) { return ''; } })();
  var evq = window.rumEvents = window.rumEvents || [], evSent = 0;
  function detail(d) {
    if (!d || typeof d !== 'object') return '';
    return Object.keys(d).sort().map(function (k) { var v = d[k]; return typeof v === 'string' ? (/^https?:/.test(v) ? bare(v) : v) : typeof v === 'number' || typeof v === 'boolean' ? String(v) : ''; })
      .filter(Boolean).join(' · ').slice(0, 80);
  }

  // ---- the profiler: a sample of loads, Chromium only ----
  var prof = null, profErr = '';
  if (RATE > 0 && Math.random() < RATE) {
    if (typeof window.Profiler !== 'function') profErr = 'unsupported';
    else try { prof = new window.Profiler({ sampleInterval: 10, maxBufferSize: 10000 }); } catch (e) { profErr = String(e && e.name || 'error').slice(0, 40); }
  }

  // ---- observers ----
  var lcp = null, cls = 0, loafLoad = [], loafLater = [], ev = {}, clicks = [], loaded = false;
  function observe(type, fn, opts) { try { var o = new PerformanceObserver(function (l) { l.getEntries().forEach(fn); }); o.observe(Object.assign({ type: type, buffered: true }, opts || {})); return o; } catch (e) { return null; } }
  function describe(el) {                                           // site-authored names only, never the element's text
    if (!el || el.nodeType !== 1) return '';
    var tag = el.tagName.toLowerCase();
    if (!TARGETS) return tag;
    for (var n = el, i = 0; n && n.nodeType === 1 && i < 6; n = n.parentElement, i++) {
      if (n.dataset && n.dataset.rum) return n.dataset.rum;
      if (n.id) return n.tagName.toLowerCase() + '#' + n.id;
    }
    var c = typeof el.className === 'string' && el.className.trim().split(/\s+/)[0];
    return c ? tag + '.' + c : tag;
  }
  // LCP stops at the first scroll or input, as Chromium does on its own: Safari keeps reporting, so a title scrolled into view seconds later became its "LCP"
  // (user input only: a programmatic scroll such as scroll restoration does not end it). Compared by time, since buffered entries can arrive after the input.
  var lcpEnd = Infinity, lcpStop = function () { if (lcpEnd === Infinity) lcpEnd = P.now(); };
  ['wheel', 'touchstart', 'keydown', 'pointerdown'].forEach(function (t) { addEventListener(t, lcpStop, { passive: true, capture: true }); });
  observe('largest-contentful-paint', function (e) { if (e.startTime <= lcpEnd) lcp = { t: r1(e.startTime), el: describe(e.element), u: bare(e.url), z: e.size }; });
  observe('layout-shift', function (e) { if (!e.hadRecentInput) cls += e.value; });
  function loafRow(f) {
    var scripts = (f.scripts || []).slice().sort(function (a, b) { return b.duration - a.duration; }).slice(0, 8).map(function (s) {
      return [bare(s.sourceURL), s.sourceFunctionName || '', s.invoker || '', s.invokerType || '', r1(s.startTime), r1(s.duration), r1(s.forcedStyleAndLayoutDuration), s.sourceCharPosition];
    });
    return [r1(f.startTime), r1(f.duration), r1(f.blockingDuration), r1(f.renderStart), r1(f.styleAndLayoutStart), scripts];
  }
  var haveLoaf = PerformanceObserver.supportedEntryTypes && PerformanceObserver.supportedEntryTypes.indexOf('long-animation-frame') >= 0;
  if (haveLoaf) observe('long-animation-frame', function (f) { (loaded ? loafLater : loafLoad).push(loafRow(f)); });
  else observe('longtask', function (t) { (loaded ? loafLater : loafLoad).push([r1(t.startTime), r1(t.duration), r1(Math.max(0, t.duration - 50)), null, null, []]); });
  // interactions: one row per interaction (its slowest event), INP = the slowest of all (close enough for a handful per page)
  observe('event', function (e) {
    if (!e.interactionId) return;
    var row = ev[e.interactionId];
    if (row && row[3] >= e.duration) return;
    ev[e.interactionId] = [e.name, describe(e.target), r1(e.startTime), r1(e.duration), r1(e.processingStart - e.startTime), r1(e.processingEnd - e.processingStart), r1(e.startTime + e.duration - e.processingEnd)];
  }, { durationThreshold: 16 });
  if (TARGETS) document.addEventListener('click', function (e) { if (clicks.length < 200) clicks.push([describe(e.target), r1(P.now())]); }, true);

  // ---- sending ----
  function post(body) {
    var s = JSON.stringify(body);
    try { if (navigator.sendBeacon && navigator.sendBeacon(END, new Blob([s], { type: 'text/plain' }))) return; } catch (e) { /* fall through */ }
    try { fetch(END, { method: 'POST', body: s, keepalive: s.length < 60000, mode: 'no-cors', headers: { 'Content-Type': 'text/plain' } }); } catch (e) { /* nothing to do */ }
  }
  function navPart() {
    var n = P.getEntriesByType('navigation')[0]; if (!n) return {};
    return { rs: r1(n.redirectEnd), ws: r1(n.workerStart), fs: r1(n.fetchStart), ds: r1(n.domainLookupStart), de: r1(n.domainLookupEnd), cs: r1(n.connectStart), ss: r1(n.secureConnectionStart), ce: r1(n.connectEnd),
      qs: r1(n.requestStart), ps: r1(n.responseStart), pe: r1(n.responseEnd), di: r1(n.domInteractive), dc: r1(n.domContentLoadedEventStart), dl: r1(n.domContentLoadedEventEnd), ls: r1(n.loadEventStart), le: r1(n.loadEventEnd),
      ty: n.type, pr: n.nextHopProtocol, z: n.transferSize, eb: n.encodedBodySize, st: n.responseStatus };
  }
  var sentLoad = false;
  function sendLoad() {
    if (sentLoad) return; sentLoad = true;
    var paint = {}; P.getEntriesByType('paint').forEach(function (p) { paint[p.name] = r1(p.startTime); });
    var res = P.getEntriesByType('resource').filter(function (r) { return r.name.indexOf(END) !== 0; }).sort(function (a, b) { return b.duration - a.duration; }).slice(0, 150).map(function (r) {
      return [bare(r.name), r.initiatorType, r1(r.startTime), r1(r.duration), r.transferSize, r.encodedBodySize, r1(r.responseStart), r.renderBlockingStatus || '', r.responseStatus || 0];
    });
    var marks = P.getEntriesByType('mark').concat(P.getEntriesByType('measure')).slice(0, 40).map(function (m) { return [m.name, r1(m.startTime), r1(m.duration)]; });
    var c = navigator.connection || {};
    post({ id: id, kind: 'load', site: SITE, page: page, tag: qs, ref: from, nav: navPart(), fp: paint['first-paint'], fcp: paint['first-contentful-paint'], lcp: lcp || {}, res: res,
      loaf: loafLoad.slice(0, 40), marks: marks, prof: !!prof, profErr: profErr,
      env: { w: innerWidth, h: innerHeight, dpr: window.devicePixelRatio || 1, mem: navigator.deviceMemory, cpu: navigator.hardwareConcurrency, net: c.effectiveType, save: c.saveData === true } });
  }
  function sendFin() {
    var rows = Object.keys(ev).map(function (k) { return ev[k]; }), inp = 0;
    rows.forEach(function (r) { if (r[3] > inp) inp = r[3]; });
    rows.sort(function (a, b) { return b[3] - a[3]; });
    var evs = evq.slice(evSent, evSent + 50).map(function (e) { return [String(e[0]).slice(0, 32), detail(e[1])]; }); evSent += evs.length;
    post({ id: id, kind: 'fin', site: SITE, page: page, lcp: lcp || {}, cls: Math.round(cls * 1e4) / 1e4, inp: rows.length ? inp : null, dur: r1(P.now()),
      ev: rows.slice(0, 30), evs: evs, loaf: loafLater.slice().sort(function (a, b) { return b[1] - a[1]; }).slice(0, 30), clicks: clicks });
  }
  function stopProfile() {
    if (!prof) return; var p = prof; prof = null;
    p.stop().then(function (trace) {
      var body = JSON.stringify(trace), url = END + '/profile?v=' + id + (SITE ? '&s=' + encodeURIComponent(SITE) : '');
      var go = function (b) { try { fetch(url, { method: 'POST', body: b, mode: 'no-cors', headers: { 'Content-Type': 'text/plain' } }); } catch (e) { /* gone */ } };
      if (typeof CompressionStream !== 'function') return void setTimeout(function () { go(body); }, 500);
      new Response(new Blob([body]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer().then(function (b) { setTimeout(function () { go(b); }, 500); }, function () { go(body); });
    }, function () { /* the trace was lost */ });
  }
  function settled() { loaded = true; sendLoad(); stopProfile(); }
  if (document.readyState === 'complete') setTimeout(settled, 3000);
  else addEventListener('load', function () { setTimeout(settled, 3000); });
  setTimeout(function () { if (!sentLoad) settled(); }, 30000);    // a load that never finishes is the slowest of all: send what there is
  var fins = 0;
  function hidden() { if (fins >= 5) return; fins++; if (!sentLoad) { sendLoad(); if (prof) { var p = prof; prof = null; try { p.stop(); } catch (e) { /* gone */ } } } sendFin(); }
  addEventListener('visibilitychange', function () { if (document.visibilityState === 'hidden') hidden(); });
  addEventListener('pagehide', hidden);
})();
