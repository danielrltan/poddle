// Home page ('/') load performance, measured the same way every time, so a change can be compared with the numbers before it.
//   node test/perf-load.mjs
// Env:
//   RUNS=5                 runs (0 = the screenshot pass only); each run is a FRESH Chrome (new temp profile: empty HTTP cache AND empty GPU shader cache) doing
//                          cold   first visit, nothing cached: load metrics, then (after the 8 s window) the settled interactions
//                          warm   a second visit in the same browser (HTTP cache and GPU program cache warm): load metrics only
//                          early  a third visit (warm) that clicks Play and types the name as soon as it can: interaction latency during the load
//   PERF_LOAD_PORT=9100    the block PORT .. PORT+2: the game server, a fake AirPod bridge (screenshot pass only), a dead bridge port
//   PERF_LOAD_OUT=...      JSON summary (median/min/max per metric, plus every run). Screenshots go beside it as <PERF_LOAD_SHOTS>-*.png
//   PERF_LOAD_SHOTS=baseline   screenshot name prefix ('' or 0 skips the screenshot pass)
//   PERF_LOAD_RTT=100      ms of added latency per request (CDP network emulation; 0 = none). Production median TTFB is ~350 ms
//   PERF_LOAD_KBPS=0       download throughput cap in kB/s (0 = none). Local files are served uncompressed (fly compresses in production)
//   PERF_LOAD_SETTLE=8000  ms after navigation that count as "the load" (long frames, requests)
//   PERF_LOAD_GPU=metal    metal (real GPU via ANGLE/Metal) | swiftshader (software; much slower, not comparable)
//   PERF_LOAD_GLWRAP=1     time three's synchronous shader checks by wrapping 4 WebGL getters (0 = leave WebGL untouched)
//   PERF_LOAD_MATCH=1      also screenshot the court in a match against Matt (fake bridge calibration, ~20 s), and count its links (below) up to
//                          PERF_LOAD_MATCH_MS=8000 after it reaches the court (the screenshot stays at +4.5 s). Needs the screenshot pass
//   PERF_LOAD_QUERY=       more query for the home page loads and the menu shots, e.g. '&padtest=1': the phone pairing the hosted page has (its QR), which localhost
//                          otherwise leaves out
//   PERF_LOAD_ROOT=<dir>   serve ANOTHER checkout's server/ and web/ with this harness (an A/B on one instrument: PERF_LOAD_ROOT=~/poddle-perf-base)
// What is measured, per load: FCP, LCP, DCL, load, TTFB; long animation frames in the first PERF_LOAD_SETTLE ms (sum of blockingDuration,
// sum of duration, count, max, top scripts); from the JS Self-Profiling trace web/rum.js records (window.__rumProfile = 1 forces it on every
// load; this file catches the trace in-page instead of the upload): three.min.js's WebGLProgram first-use check (function D at line 7,
// the sync link/compile status check: shaderCheckInclMs = samples with D anywhere on the stack, which holds the native GL wait
// whether or not GLWRAP's wrappers sit between; the trace stops 3 s after the load event), self time in web/scenery/*.js, scene.js canvasTex inclusive;
// the exact time spent blocked in getProgramInfoLog / getShaderInfoLog / LINK_STATUS / COMPILE_STATUS (GLWRAP); renderer.info.programs
// after settle (through ?uitest=1's window.__scene); requests, bytes, 304s, emoji requests. Program links per phase (GLWRAP): home (the load),
// lobby (the settled clicks, which never join a court: no row = no links; in the match pass: Play to the Matt pick), join (the pick to the court: welcome, setCourt, calibration), match
// (the first PERF_LOAD_MATCH_MS on court): made, sync (the main thread waited at the program's first use: COMPLETION_STATUS never said done
// before it) with blocking ms, async (polled done first), del (released); the scene's own context only, every other one (podview, MediaPipe)
// summed under 'other'. Timing marks the page itself makes (gl:first-frame, gl:ready, scenery:reveal: what rum.js uploads live). Interactions: Event Timing (>= 16 ms only:
// the browser drops faster ones, so "seen" counts how many reached 16 ms), per interaction, slowest event of it.
// Nothing here changes the game: ?uitest=1 only publishes test handles. rum.js beacons are swallowed in-page (never reach the server).
// Screenshots (1440x900, DPR 1): the frame clock is virtualised in that pass only (requestAnimationFrame timestamps advance 1/30 s per
// frame, frozen at frame PERF_LOAD_SHOT_FRAME=600; Math.random seeded) so the menu's attract rally and drifting camera are at the same
// moment every time; CSS animations are set to a fixed time (looping: paused at 1 s; finite: finished). Two passes gave pixel-identical
// home/court/lobby shots on an M4. The match shot is NOT deterministic (the server plays it); it is for eyeballing only.
import { spawn, execSync } from 'child_process'; import fs from 'fs'; import path from 'path';
import { WebSocketServer } from 'ws';
import puppeteer from 'puppeteer-core';
import { makeSynth, CALIBRATE, SESSION_LOOP } from './fake-bridge.mjs';

const root = process.env.PERF_LOAD_ROOT ? path.resolve(process.env.PERF_LOAD_ROOT) + '/' : new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
const env = process.env, P0 = +env.PERF_LOAD_PORT || 9100, RUNS = env.RUNS != null && env.RUNS !== '' ? +env.RUNS : 5, SETTLE = +env.PERF_LOAD_SETTLE || 8000;
const OUT = env.PERF_LOAD_OUT || '/private/tmp/claude-501/-Users-danieltan/0840f13e-98f6-42a7-b6da-24efe28b0ae9/scratchpad/perfwf/baseline.json';
const SHOTS = env.PERF_LOAD_SHOTS == null ? 'baseline' : env.PERF_LOAD_SHOTS === '0' ? '' : env.PERF_LOAD_SHOTS;
const RTT = env.PERF_LOAD_RTT != null ? +env.PERF_LOAD_RTT : 100, KBPS = +env.PERF_LOAD_KBPS || 0, GPU = env.PERF_LOAD_GPU || 'metal';
const GLWRAP = env.PERF_LOAD_GLWRAP !== '0', MATCH = env.PERF_LOAD_MATCH !== '0', SHOT_FRAME = +env.PERF_LOAD_SHOT_FRAME || 600;
const G = P0, BR = P0 + 1, DEAD = P0 + 2, MATCH_MS = +env.PERF_LOAD_MATCH_MS || 8000; let matchRun = null;
if ([8080, 8787, 3000].some(p => p >= P0 && p <= P0 + 2)) { console.log("refusing: that port range holds the player's own game"); process.exit(2); }
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const GPU_ARGS = GPU === 'swiftshader' ? ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] : ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'];
const url = (q = '') => `http://localhost:${G}/?uitest=1&game=${G}&bridge=${DEAD}${env.PERF_LOAD_QUERY || ''}${q}`;      // PERF_LOAD_QUERY='&padtest=1': the hosted page's phone pairing (its QR) on localhost
fs.mkdirSync(path.dirname(OUT), { recursive: true });

// where three's shader check lives: 'function D(e){if(t.debug.checkShaderErrors)' on line 7 of the vendored build (profile columns are 1-based)
const THREE_L7 = fs.readFileSync(root + 'web/vendor/three.min.js', 'utf8').split('\n')[6] || '';
const D_COL = THREE_L7.indexOf('function D(e){if(t.debug.checkShaderErrors)') + 1 + 'function '.length;
if (D_COL <= 9) console.log('NOTE three.min.js has no "function D(e){if(t.debug.checkShaderErrors)" on line 7: shaderCheck will read 0');

// ---- the game server ----
const server = spawn('node', ['server/game.js'], { cwd: root, env: { ...env, PORT: String(G), FLY_APP_NAME: '' }, stdio: ['ignore', 'pipe', 'pipe'] }), slog = [];
server.stdout.on('data', d => slog.push(String(d))); server.stderr.on('data', d => slog.push('ERR ' + String(d)));
const browsers = new Set(); let wss = null;
async function finish(code) { for (const b of browsers) await b.close().catch(() => {}); try { server.kill(); } catch { /* gone */ } if (wss) wss.close(); process.exit(code); }
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('CRASH', e && e.stack || e); console.log(slog.join('').split('\n').slice(-15).join('\n')); finish(2); });
setTimeout(() => { console.log('PERF-LOAD FAIL (timeout)'); finish(2); }, (RUNS * 75 + 180) * 1000).unref();
for (let i = 0; ; i++) { try { const r = await fetch(`http://localhost:${G}/status.json`); if (r.ok) break; } catch { /* not up yet */ } if (i > 60) throw new Error('server did not start: ' + slog.join('')); await sleep(150); }

async function launch(extra = []) {
  const b = await puppeteer.launch({ executablePath: CHROME, headless: true, defaultViewport: null,
    args: [...GPU_ARGS, '--window-size=1440,900', '--disable-background-timer-throttling', '--disable-renderer-backgrounding', '--disable-backgrounding-occluded-windows', ...extra] });
  browsers.add(b); b.UA = (await b.userAgent()).replace('HeadlessChrome', 'Chrome');      // a headless UA is a bot to rum.js's collector and to traffic counts
  return b;
}
async function close(b) { browsers.delete(b); await b.close().catch(() => {}); }

// ---- in-page instrumentation (before any of the page's scripts) ----
function inject(opts) {
  window.__rumForce = 1; window.__rumProfile = 1;
  const H = window.__perf = { loaf: [], ev: [], lcp: null, paint: {}, trace: null, beacons: 0, gl: { syncMs: 0, syncN: 0, first: null, last: null, maxMs: 0, pollN: 0 } };
  // rum.js's beacons and its trace upload never leave the page; the trace is kept here
  try { navigator.sendBeacon = function (u) { if (String(u).indexOf('/api/perf') >= 0) { H.beacons++; return true; } return false; }; } catch (e) { /* */ }
  const f0 = window.fetch; window.fetch = function (u, o) { if (String(u && u.url || u).indexOf('/api/perf') >= 0) { H.beacons++; return Promise.resolve(new Response(null, { status: 204 })); } return f0.apply(this, arguments); };
  if (typeof window.Profiler === 'function') { const stop = window.Profiler.prototype.stop; window.Profiler.prototype.stop = function () { return stop.call(this).then(t => { H.trace = t; return t; }); }; }
  const obs = (type, fn, o) => { try { new PerformanceObserver(l => l.getEntries().forEach(fn)).observe({ type, buffered: true, ...(o || {}) }); } catch (e) { /* unsupported */ } };
  obs('paint', e => { H.paint[e.name] = e.startTime; });
  obs('largest-contentful-paint', e => { H.lcp = { t: e.startTime, el: e.element ? e.element.tagName.toLowerCase() + (e.element.id ? '#' + e.element.id : '') : '', size: e.size }; });
  obs('long-animation-frame', f => H.loaf.push({ start: f.startTime, dur: f.duration, block: f.blockingDuration, render: f.renderStart,
    scripts: (f.scripts || []).map(s => ({ url: String(s.sourceURL || '').replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, ''), fn: s.sourceFunctionName || '', inv: s.invokerType || '', invoker: String(s.invoker || '').slice(0, 60), dur: s.duration, layout: s.forcedStyleAndLayoutDuration })) }));
  obs('event', e => { if (e.interactionId) H.ev.push({ id: e.interactionId, name: e.name, target: e.target ? e.target.tagName.toLowerCase() + (e.target.id ? '#' + e.target.id : '') : '', start: e.startTime, dur: e.duration, delay: e.processingStart - e.startTime, proc: e.processingEnd - e.processingStart }); }, { durationThreshold: 16 });
  // Every program linked, per phase (the harness moves H.links.phase: home -> lobby -> join -> match): a link is SYNC when the program's first
  // blocking use (link status, info log, uniforms, attributes: whichever three asks first, checkShaderErrors on or off) came before
  // KHR_parallel_shader_compile's COMPLETION_STATUS ever said done, so the main thread waited for the link there; ASYNC when it was polled
  // done first (compileAsync, or a gate that waits for isReady()). A fix that only moves links (into the lobby, the first rally) shows
  // up as sync links in a later phase; one that removes them shows fewer made. del: programs released (a rebuilt material).
  const L = H.links = { phase: 'home', rows: [] }, rowOf = new WeakMap();
  if (opts.glwrap) for (const C of [window.WebGL2RenderingContext, window.WebGLRenderingContext]) {           // the synchronous waits three's D() makes on a program's first use
    if (!C) continue; const P = C.prototype, LINK = 0x8B82, COMPILE = 0x8B81, DONE = 0x91B1;
    const use = (p, t, d) => { const r = rowOf.get(p); if (!r) return; if (r.use == null) { r.use = t; r.usePhase = L.phase; r.sync = !r.ready; } r.blockMs += d; };
    const time = (fn, sync, prog) => function () { const p = prog ? arguments[0] : null;
      if (!sync(arguments)) { if (arguments[1] === DONE) { H.gl.pollN++; const v = fn.apply(this, arguments), r = p && rowOf.get(p); if (v && r) r.ready = true; return v; } }
      const t = performance.now(), v = fn.apply(this, arguments), d = performance.now() - t; if (p) use(p, t, d); if (!sync(arguments)) return v;
      const g = H.gl; g.syncMs += d; g.syncN++; if (d > g.maxMs) g.maxMs = d; if (g.first == null) g.first = t; g.last = t + d; return v; };
    P.getProgramInfoLog = time(P.getProgramInfoLog, () => true, true); P.getShaderInfoLog = time(P.getShaderInfoLog, () => true);
    P.getProgramParameter = time(P.getProgramParameter, a => a[1] === LINK, true); P.getShaderParameter = time(P.getShaderParameter, a => a[1] === COMPILE);
    for (const k of ['getActiveUniform', 'getUniformLocation', 'getActiveAttrib', 'getAttribLocation']) P[k] = time(P[k], () => false, true);      // blocking too (uniform setup waits for the link): first use only, not in gl.syncMs
    const link = P.linkProgram; P.linkProgram = function (p) { if (!rowOf.has(p)) { const r = { ctx: this, phase: L.phase, t: performance.now(), ready: false, use: null, usePhase: null, sync: null, blockMs: 0, del: null }; rowOf.set(p, r); L.rows.push(r); } return link.apply(this, arguments); };
    const del = P.deleteProgram; P.deleteProgram = function (p) { const r = p && rowOf.get(p); if (r && r.del == null) r.del = L.phase; return del.apply(this, arguments); };
  }
  if (opts.freeze) {                                                       // screenshot pass only: one virtual frame clock, frozen on demand
    let a = 0x2F6B2A1 >>> 0; Math.random = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
    let f = 0, stopAt = opts.freeze; const raf = window.requestAnimationFrame.bind(window);
    window.__frames = { get f() { return f; }, set stopAt(n) { stopAt = n; } };
    let real = -1; window.requestAnimationFrame = cb => raf(ts => { if (ts !== real) { real = ts; if (f < stopAt) f++; } cb(f * 1000 / 30); });      // one tick per real frame, however many callbacks
  }
}

async function newPage(b, opts = {}) {
  const pg = await b.newPage(); await pg.setViewport({ width: 1440, height: 900, deviceScaleFactor: 1 }); await pg.setUserAgent(b.UA);
  pg.errs = []; pg.on('pageerror', e => pg.errs.push('PAGEERROR ' + e.message));
  pg.on('console', m => { if (m.type() === 'error' && !/WebSocket|ERR_CONNECTION|Failed to load resource/.test(m.text())) pg.errs.push(m.text().slice(0, 200)); });
  const cdp = pg.cdp = await pg.createCDPSession(); await cdp.send('Network.enable');
  if (RTT || KBPS) await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: RTT, downloadThroughput: KBPS ? KBPS * 1024 : -1, uploadThroughput: -1 });
  const reqs = pg.reqs = new Map();                                        // requestId -> { url, t, status, cached, bytes }
  cdp.on('Network.requestWillBeSent', e => { if (!/^https?:/.test(e.request.url) || /\/api\/perf/.test(e.request.url)) return; reqs.set(e.requestId, { url: e.request.url.replace(/^https?:\/\/[^/]+/, ''), t: e.timestamp, status: 0, cached: false, bytes: 0, type: e.type }); });
  cdp.on('Network.responseReceivedExtraInfo', e => { const r = reqs.get(e.requestId); if (r) r.wire = e.statusCode; });      // the status on the wire: a revalidated file is a 304 here, a 200 in responseReceived
  cdp.on('Network.requestServedFromCache', e => { const r = reqs.get(e.requestId); if (r) r.cached = true; });
  cdp.on('Network.responseReceived', e => { const r = reqs.get(e.requestId); if (r) { r.status = e.response.status; if (e.response.fromDiskCache || e.response.fromMemoryCache) r.cached = true; } });
  cdp.on('Network.loadingFinished', e => { const r = reqs.get(e.requestId); if (r) { r.bytes = e.encodedDataLength; r.done = e.timestamp; } });
  await pg.evaluateOnNewDocument(inject, { glwrap: GLWRAP, freeze: opts.freeze || 0 });
  return pg;
}

// ---- reading a load back ----
const r1 = v => (typeof v === 'number' && isFinite(v) ? Math.round(v * 10) / 10 : null);
const phase = (pg, name) => pg.evaluate(n => { if (window.__perf && window.__perf.links) window.__perf.links.phase = n; }, name).catch(() => {});
// per phase, the scene's own context: made (linked in that phase), sync / async / syncMs (by the phase of the first use: where the wait
// landed), del; other: every other context (podview.js's pod, MediaPipe) summed; pending: linked, never used yet
const linksOf = pg => pg.evaluate(() => {
  const L = window.__perf && window.__perf.links, sc = window.__scene, gl = sc && sc._dbg.renderer.getContext(); if (!L || !L.rows.length) return null;      // GLWRAP=0: nothing was counted
  const out = {}, at = (k) => (out[k] = out[k] || { made: 0, sync: 0, syncMs: 0, async: 0, del: 0 });
  for (const r of L.rows) {
    const mine = r.ctx === gl, k = p => (mine ? p : 'other');
    at(k(r.phase)).made++; if (r.del) at(k(r.del)).del++;
    if (r.use == null) { at('pending').made++; continue; }
    const u = at(k(r.usePhase)); if (r.sync) { u.sync++; u.syncMs += r.blockMs; } else u.async++;
  }
  for (const k in out) out[k].syncMs = Math.round(out[k].syncMs * 10) / 10;
  return out;
}).catch(() => null);
const marksOf = pg => pg.evaluate(() => Object.fromEntries(performance.getEntriesByType('measure').concat(performance.getEntriesByType('mark'))     // the page's own timing marks (web/scene.js): what rum.js uploads
  .filter(e => /^(gl|scenery):/.test(e.name)).map(e => [e.name, { at: Math.round(e.startTime * 10) / 10, dur: Math.round(e.duration * 10) / 10 }]))).catch(() => ({}));
function traceStats(t) {                                                   // the same sample weighting as the live analysis: gap to the next sample, capped at 50 ms
  if (!t || !t.samples || !t.samples.length) return null;
  const res = t.resources || [], frame = id => { const f = t.frames[id] || {}; return { name: f.name || '', file: f.resourceId != null ? String(res[f.resourceId] || '') : '', line: f.line, col: f.column }; };
  const memo = new Map(), stackOf = sid => { if (sid == null || !t.stacks[sid]) return []; if (memo.has(sid)) return memo.get(sid); const out = [];
    for (let s = sid, g = 0; s != null && t.stacks[s] && g < 512; s = t.stacks[s].parentId, g++) out.push(frame(t.stacks[s].frameId)); out.reverse(); memo.set(sid, out); return out; };
  const isD = f => f.name === 'D' && /three\.min\.js$/.test(f.file.replace(/[?#].*$/, '')) && f.line === 7 && Math.abs(f.col - D_COL) <= 60;
  const o = { jsMs: 0, shaderCheckSelfMs: 0, shaderCheckInclMs: 0, shaderCheckAt: [], sceneryMs: 0, sceneryByFile: {}, canvasTexMs: 0, threeSelfMs: 0, traceEndMs: r1(t.samples[t.samples.length - 1].timestamp), top: {} };
  const xs = t.samples;
  for (let i = 0; i < xs.length; i++) {
    const ms = i + 1 < xs.length ? Math.min(50, Math.max(0, xs[i + 1].timestamp - xs[i].timestamp)) : 10, st = stackOf(xs[i].stackId); if (!st.length) continue;
    const leaf = st[st.length - 1], file = leaf.file.replace(/^https?:\/\/[^/]+/, '').replace(/[?#].*$/, '');
    o.jsMs += ms;
    if (isD(leaf)) { o.shaderCheckSelfMs += ms; }
    if (st.some(isD)) { o.shaderCheckInclMs += ms; o.shaderCheckAt.push(xs[i].timestamp); }
    if (/\/scenery\//.test(file)) { o.sceneryMs += ms; const k = file.replace(/^.*\/scenery\//, ''); o.sceneryByFile[k] = (o.sceneryByFile[k] || 0) + ms; }
    if (st.some(f => f.name === 'canvasTex' && /\/scene\.js/.test(f.file))) o.canvasTexMs += ms;
    if (/three\.min\.js$/.test(file)) o.threeSelfMs += ms;
    const k = `${leaf.name || '(anon)'} ${file || '(native)'}:${leaf.line}:${leaf.col}`; o.top[k] = (o.top[k] || 0) + ms;
  }
  const at = o.shaderCheckAt; o.shaderCheckFirstAt = at.length ? r1(at[0]) : null; o.shaderCheckLastAt = at.length ? r1(at[at.length - 1]) : null; delete o.shaderCheckAt;
  o.top = Object.entries(o.top).sort((a, b) => b[1] - a[1]).slice(0, 12).map(([k, v]) => [k, Math.round(v)]);
  for (const k of ['jsMs', 'shaderCheckSelfMs', 'shaderCheckInclMs', 'sceneryMs', 'canvasTexMs', 'threeSelfMs']) o[k] = Math.round(o[k]);
  for (const k in o.sceneryByFile) o.sceneryByFile[k] = Math.round(o.sceneryByFile[k]);
  return o;
}

async function settle(pg, t0) {                                            // load fired, scenery revealed, SETTLE ms since navigation, rum.js's trace in hand
  const end = Date.now() + SETTLE + 20000;
  while (Date.now() < end) {
    const s = await pg.evaluate(() => ({ now: performance.now(), loaded: document.readyState === 'complete', scenery: !!window.__scenery, trace: !!window.__perf.trace, sceneOk: !!window.__scene })).catch(() => null);
    if (s && s.loaded && s.scenery && s.now >= SETTLE && (s.trace || s.now >= SETTLE + 6000)) return s;
    await sleep(100);
  }
  return null;
}

async function readLoad(pg, navT) {
  const s = await settle(pg);
  const d = await pg.evaluate(SET => {
    const H = window.__perf, n = performance.getEntriesByType('navigation')[0] || {}, sc = window.__scene, r = sc && sc._dbg.renderer;
    let gpu = ''; try { const gl = r.getContext(), e = gl.getExtension('WEBGL_debug_renderer_info'); gpu = e ? gl.getParameter(e.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER); } catch (e) { /* */ }
    const lo = H.loaf.filter(f => f.start < SET), by = {};
    for (const f of lo) for (const x of f.scripts) { const k = `${x.url || '(none)'} ${x.inv}${x.fn ? ' ' + x.fn : ''}`; by[k] = (by[k] || 0) + x.dur; }
    const res = performance.getEntriesByType('resource');
    return { ttfb: n.responseStart, di: n.domInteractive, dcl: n.domContentLoadedEventStart, load: n.loadEventStart, fcp: H.paint['first-contentful-paint'], fp: H.paint['first-paint'], lcp: H.lcp && H.lcp.t, lcpEl: H.lcp && H.lcp.el,
      loafN: lo.length, loafBlockMs: lo.reduce((a, f) => a + f.block, 0), loafMs: lo.reduce((a, f) => a + f.dur, 0), loafMaxMs: lo.reduce((a, f) => Math.max(a, f.dur), 0),
      loafTop: Object.entries(by).sort((a, b) => b[1] - a[1]).slice(0, 8).map(([k, v]) => [k, Math.round(v)]),
      loafFrames: lo.sort((a, b) => b.dur - a.dur).slice(0, 6).map(f => [Math.round(f.start), Math.round(f.dur), Math.round(f.block), f.scripts.sort((a, b) => b.dur - a.dur).slice(0, 2).map(x => `${x.url} ${x.inv} ${Math.round(x.dur)}`).join(' | ')]),
      programs: r ? r.info.programs.length : null, gpu, gl: H.gl, beacons: H.beacons, trace: H.trace, scenery: !!window.__scenery, resCount: res.length,
      emojiRT: res.filter(e => /\/emoji\//.test(e.name)).length };
  }, SETTLE);
  d.marks = await marksOf(pg);
  const reqs = [...pg.reqs.values()], inWin = reqs.filter(r => (r.t - navT) * 1000 <= SETTLE);
  const ts = traceStats(d.trace); delete d.trace;
  const net = { requests: inWin.length, bytes: inWin.reduce((a, r) => a + (r.bytes || 0), 0), n304: inWin.filter(r => r.wire === 304 || r.status === 304).length, cached: inWin.filter(r => r.cached).length,
    emoji: inWin.filter(r => /\/emoji\//.test(r.url)).length, emojiBytes: inWin.filter(r => /\/emoji\//.test(r.url)).reduce((a, r) => a + (r.bytes || 0), 0),
    big: inWin.sort((a, b) => b.bytes - a.bytes).slice(0, 6).map(r => [r.url, r.wire || r.status, r.bytes]) };
  return { settled: !!s, ...d, net, trace: ts, errs: pg.errs.slice(0, 10) };
}

// ---- interactions ----
const evRows = async pg => pg.evaluate(() => window.__perf.ev);
function interactions(rows, from = 0) {                                    // one row per interaction: its slowest event
  const by = new Map(); for (const e of rows) { if (e.start < from) continue; const r = by.get(e.id); if (!r || e.dur > r.dur) by.set(e.id, e); }
  return [...by.values()].sort((a, b) => a.start - b.start).map(e => ({ name: e.name, target: e.target, at: Math.round(e.start), dur: e.dur, delay: r1(e.delay), proc: r1(e.proc) }));
}
async function clickVisible(pg, sel) {                                      // the first visible match (several screens have a [data-back])
  const ok = await pg.evaluate(sel => { const e = [...document.querySelectorAll(sel)].find(e => { const b = e.getBoundingClientRect(), c = getComputedStyle(e); return !e.hidden && b.width > 0 && b.height > 0 && c.visibility !== 'hidden' && c.display !== 'none'; });
    if (!e) return false; e.setAttribute('data-perf-click', '1'); return true; }, sel);
  if (!ok) return false; await pg.click('[data-perf-click="1"]'); await pg.evaluate(() => document.querySelector('[data-perf-click]')?.removeAttribute('data-perf-click')); return true;
}
const exitFs = pg => pg.evaluate(() => document.fullscreenElement && document.exitFullscreen()).catch(() => {});
const NAME = 'Perftester1';                                               // 10 characters typed after the field is cleared
async function typeName(pg, delay = 120) {                                // the field focused before every key: the lobby moves focus to its first tile as it opens
  await pg.evaluate(() => { const e = document.getElementById('name-input'); e.value = ''; e.dispatchEvent(new Event('input', { bubbles: true })); }); let refocus = 0;
  for (const c of NAME.slice(0, 10)) { if (!(await pg.evaluate(() => document.activeElement && document.activeElement.id === 'name-input'))) { refocus++; await pg.click('#name-input'); } await pg.keyboard.type(c, { delay: 30 }); await sleep(delay); }
  return { typed: await pg.evaluate(() => document.getElementById('name-input').value), refocus }; }
async function settledInteractions(pg) {
  const from = await pg.evaluate(() => performance.now()), steps = [];
  const step = async (what, fn, wait = 900) => { const t = await pg.evaluate(() => performance.now()); const ok = await fn(); await sleep(wait); steps.push({ what, ok: ok !== false, at: Math.round(t) }); };
  await phase(pg, 'lobby');
  await step('click Play (#btn-start)', async () => { await pg.click('#btn-start'); await sleep(200); await exitFs(pg); }, 1200);
  let typed = null; await step('type 10 chars in #name-input', async () => { typed = await typeName(pg); }, 600);
  await step('click #btn-courts', () => clickVisible(pg, '#btn-courts'));
  await step('click Back', () => clickVisible(pg, '[data-back]'));
  await step('click #btn-bot', () => clickVisible(pg, '#btn-bot'));
  await step('click Back', () => clickVisible(pg, '[data-back]'));
  await sleep(400);
  return { steps, typed, rows: interactions(await evRows(pg), from) };
}
async function earlyInteractions(pg) {                                    // as soon as Play can be clicked: what a player does during the load
  const t0 = Date.now(); let clickAt = null;
  while (Date.now() - t0 < 15000) { const ok = await pg.evaluate(() => { const e = document.getElementById('btn-start'); if (!e) return false; const b = e.getBoundingClientRect(); return b.width > 0 && getComputedStyle(e).visibility !== 'hidden' && document.body.dataset.screen === 'title'; }).catch(() => false);
    if (ok) { clickAt = await pg.evaluate(() => performance.now()); await pg.click('#btn-start'); break; } await sleep(30); }
  await exitFs(pg);
  const ready = Date.now(); while (Date.now() - ready < 8000 && !(await pg.evaluate(() => { const e = document.getElementById('name-input'); return !!e && e.getBoundingClientRect().width > 0; }).catch(() => false))) await sleep(30);
  const typed = await typeName(pg, 60); await sleep(Math.max(0, SETTLE + 1500 - (await pg.evaluate(() => performance.now()))));
  const rows = interactions(await evRows(pg));
  return { clickAt: r1(clickAt), typed, rows };
}

// ---- one run: a fresh Chrome ----
async function run(i) {
  const b = await launch(), out = { run: i + 1 };
  out.chrome = await b.version(); let pg = await newPage(b), navT;
  const tNav = async (p, u) => { let t = null; const h = e => { if (t == null && e.type === 'Document') t = e.timestamp; }; p.cdp.on('Network.requestWillBeSent', h); await p.goto(u, { waitUntil: 'load', timeout: 60000 }); p.cdp.off('Network.requestWillBeSent', h); return t; };
  navT = await tNav(pg, url()); out.cold = await readLoad(pg, navT);
  out.cold.interactions = await settledInteractions(pg); out.cold.links = await linksOf(pg);      // home, then lobby (the settled clicks)
  await pg.close();
  pg = await newPage(b); navT = await tNav(pg, url()); out.warm = await readLoad(pg, navT); out.warm.links = await linksOf(pg); await pg.close();
  pg = await newPage(b); const go = pg.goto(url(), { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {}); await sleep(50); out.early = await earlyInteractions(pg); await go; await pg.close();
  await close(b);
  return out;
}

// ---- screenshots ----
async function shots() {
  if (!SHOTS) return [];
  const files = [], base = path.join(path.dirname(OUT), SHOTS + '-');
  const pods = {}, podOpts = { heading: 137, gyroNoise: 0.02, accNoise: 0.005, seed: 7 };
  const pod = tag => pods[tag] ??= { t: 3580, socks: new Set(), syn: makeSynth({ ...podOpts, script: [], t0: 3580.02 }) };
  wss = new WebSocketServer({ port: BR }); wss.on('connection', (ws, req) => { const p = pod(req.url.slice(1)); p.socks.add(ws); ws.on('close', () => p.socks.delete(ws)); ws.on('error', () => p.socks.delete(ws)); });
  const st0 = performance.now(); let sent = 0;
  const iv = setInterval(() => { const due = Math.floor((performance.now() - st0) / 20); for (; sent <= due; sent++) for (const p of Object.values(pods)) { const m = p.syn.next(); delete m._t; p.t = m.t; const j = JSON.stringify(m); for (const ws of p.socks) if (ws.readyState === 1) ws.send(j); } }, 5);
  const b = await launch(['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']);
  try {
    // the menu, frozen at frame SHOT_FRAME of a virtual 30 fps clock
    const pg = await newPage(b, { freeze: SHOT_FRAME }); await pg.cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    await pg.goto(url(), { waitUntil: 'load' }); await pg.mouse.move(1430, 890);
    const end = Date.now() + 60000; let f = 0; while (Date.now() < end) { const s = await pg.evaluate(() => ({ f: window.__frames.f, sc: !!window.__scenery })); f = s.f; if (s.sc && f >= SHOT_FRAME) break; await sleep(200); }
    if (f < SHOT_FRAME) console.log('NOTE screenshot clock never reached frame', SHOT_FRAME, '(at', f, ')');
    await pg.evaluate(() => document.fonts.ready); await sleep(2500);
    // CSS animations at a fixed moment too (the Play button's glow loops): a looping one paused 1 s in, a finite one at its end
    const still = () => pg.evaluate(() => { for (const a of document.getAnimations()) { try { if (a.effect && a.effect.getComputedTiming().iterations === Infinity) { a.pause(); a.currentTime = 1000; } else a.finish(); } catch (e) { /* */ } } });
    const shot = async n => { await still(); await sleep(150); const p = base + n + '.png'; await pg.screenshot({ path: p }); files.push(p); };
    await shot('home');
    await pg.addStyleTag({ content: 'body > *:not(#stage) { visibility: hidden !important; }' }); await sleep(300); await shot('court');
    await pg.evaluate(() => { for (const s of document.querySelectorAll('style')) if (s.textContent.includes('body > *:not(#stage)')) s.remove(); });
    await pg.click('#btn-start'); await sleep(200); await exitFs(pg); await pg.mouse.move(1430, 890);
    await pg.evaluate(n => { window.__frames.stopAt = n; }, SHOT_FRAME + 60); const e2 = Date.now() + 20000; while (Date.now() < e2 && (await pg.evaluate(() => window.__frames.f)) < SHOT_FRAME + 60) await sleep(100);
    await sleep(2000); await shot('lobby');
    await pg.close();
    if (MATCH) {                                                           // vs Matt, Rookie... Medium (btn-bot-1), after a fake-bridge calibration. Not frozen
      const pm = await newPage(b); const tag = 'shot';
      await pm.evaluateOnNewDocument(() => { try { localStorage.setItem('poddle.name', 'Perf'); localStorage.setItem('poddle.camPrimer', 'allow'); } catch (e) { /* */ } });
      await pm.goto(`http://localhost:${G}/?uitest=1&game=${G}&bridge=${BR}/${tag}`, { waitUntil: 'load' }); await sleep(1500);
      await phase(pm, 'lobby'); await pm.click('#btn-start'); await sleep(300); await exitFs(pm);
      await pm.waitForFunction(() => document.body.dataset.screen === 'lobby', { timeout: 5000 }); await clickVisible(pm, '#btn-bot'); await sleep(400); await phase(pm, 'join'); await clickVisible(pm, '#btn-bot-1');      // join: the welcome (setCourt), calibration
      const s1 = await pm.waitForFunction(() => document.body.dataset.screen === 'calibrate' || (window.__stats.calibrated && document.body.dataset.screen === 'hud'), { timeout: 15000 }).then(() => pm.evaluate(() => document.body.dataset.screen)).catch(() => null);
      const p = pod(tag); p.syn = makeSynth({ ...podOpts, script: s1 === 'calibrate' ? CALIBRATE : [{ T: 0.4 }], loop: SESSION_LOOP, t0: p.t + 0.02 });
      const onCourt = await pm.waitForFunction(() => window.__stats.calibrated && document.body.dataset.screen === 'hud', { timeout: 40000 }).then(() => true).catch(() => false);
      const t1 = Date.now(); if (onCourt) await phase(pm, 'match');      // the first MATCH_MS of play: the first rally's fx, swoosh, rings
      if (onCourt) { await sleep(4000); await pm.mouse.move(1430, 890); await sleep(500); const fp = base + 'match.png'; await pm.screenshot({ path: fp }); files.push(fp); }
      else console.log('NOTE match screenshot skipped: never reached the court (screen ' + await pm.evaluate(() => document.body.dataset.screen) + ')');
      if (onCourt) await sleep(Math.max(0, MATCH_MS - (Date.now() - t1)));
      matchRun = { onCourt, links: await linksOf(pm), marks: await marksOf(pm), errs: pm.errs.slice(0, 10) };
      await pm.close();
    }
  } finally { clearInterval(iv); await close(b); wss.close(); wss = null; }
  return files;
}

// ---- summary ----
const get = (o, k) => k.split('.').reduce((a, x) => (a == null ? a : a[x]), o);
function stat(vals) { const v = vals.filter(x => typeof x === 'number' && isFinite(x)).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1;
  return { median: r1(v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2), min: r1(v[0]), max: r1(v[v.length - 1]), n: v.length }; }
const LOAD_KEYS = ['ttfb', 'fcp', 'lcp', 'di', 'dcl', 'load', 'loafBlockMs', 'loafMs', 'loafMaxMs', 'loafN', 'programs', 'gl.syncMs', 'gl.syncN', 'gl.maxMs', 'gl.first', 'gl.last',
  'trace.shaderCheckSelfMs', 'trace.shaderCheckInclMs', 'trace.shaderCheckFirstAt', 'trace.sceneryMs', 'trace.canvasTexMs', 'trace.threeSelfMs', 'trace.jsMs', 'trace.traceEndMs',
  'net.requests', 'net.bytes', 'net.n304', 'net.cached', 'net.emoji', 'net.emojiBytes',
  'links.home.made', 'links.home.sync', 'links.home.syncMs', 'links.home.async', 'links.home.del', 'links.lobby.made', 'links.lobby.sync', 'links.lobby.syncMs', 'links.lobby.del', 'links.other.made',
  'marks.gl:first-frame.at', 'marks.gl:first-frame.dur', 'marks.gl:ready.at', 'marks.scenery:reveal.at', 'marks.scenery:reveal.dur'];
function summarize(runs) {
  const s = {};
  for (const kind of ['cold', 'warm']) { s[kind] = {}; for (const k of LOAD_KEYS) s[kind][k] = stat(runs.map(r => get(r[kind], k))); }
  const sceneryFiles = [...new Set(runs.flatMap(r => Object.keys(get(r.cold, 'trace.sceneryByFile') || {})))];
  s.cold.sceneryByFile = Object.fromEntries(sceneryFiles.map(f => [f, stat(runs.map(r => (get(r.cold, 'trace.sceneryByFile') || {})[f] || 0))]));
  const ia = runs.map(r => r.cold.interactions.rows), keys = rows => rows.filter(e => /^key/.test(e.name)), clicks = rows => rows.filter(e => !/^key/.test(e.name));
  s.settled = { inp: stat(ia.map(rows => Math.max(0, ...rows.map(e => e.dur)))), keySeen: stat(ia.map(rows => keys(rows).length)), keyMax: stat(ia.map(rows => Math.max(0, ...keys(rows).map(e => e.dur)))),
    clickMax: stat(ia.map(rows => Math.max(0, ...clicks(rows).map(e => e.dur)))), allDur: stat(ia.flat().map(e => e.dur)) };
  const ea = runs.map(r => r.early.rows);
  s.early = { clickAt: stat(runs.map(r => r.early.clickAt)), inp: stat(ea.map(rows => Math.max(0, ...rows.map(e => e.dur)))), keySeen: stat(ea.map(rows => keys(rows).length)),
    keyMax: stat(ea.map(rows => Math.max(0, ...keys(rows).map(e => e.dur)))), firstClick: stat(ea.map(rows => (clicks(rows)[0] || {}).dur)) };
  return s;
}

console.log(`perf-load: ${RUNS} runs, server :${G}, RTT ${RTT} ms${KBPS ? `, ${KBPS} kB/s` : ''}, GPU ${GPU}, glwrap ${GLWRAP}, settle ${SETTLE} ms`);
const linkLine = l => !l ? '-' : Object.entries(l).map(([k, v]) => `${k} ${v.sync}/${v.made}${v.syncMs ? ` ${Math.round(v.syncMs)} ms` : ''}${v.del ? ` del ${v.del}` : ''}`).join(', ');      // phase sync/made
const runs = [];
for (let i = 0; i < RUNS; i++) {
  const r = await run(i); runs.push(r);
  const c = r.cold, w = r.warm;
  console.log(`run ${i + 1}: cold fcp ${r1(c.fcp)} lcp ${r1(c.lcp)} dcl ${r1(c.dcl)} load ${r1(c.load)} loafBlock ${Math.round(c.loafBlockMs)} shaderCheck ${c.trace && c.trace.shaderCheckInclMs} (sync gl ${Math.round(c.gl.syncMs)} ms/${c.gl.syncN}) programs ${c.programs} scenery ${c.trace && c.trace.sceneryMs} req ${c.net.requests}/${Math.round(c.net.bytes / 1024)} KB emoji ${c.net.emoji}`
    + ` | warm fcp ${r1(w.fcp)} load ${r1(w.load)} loafBlock ${Math.round(w.loafBlockMs)} shaderCheck ${w.trace && w.trace.shaderCheckInclMs} 304s ${w.net.n304} | settled INP ${Math.max(0, ...c.interactions.rows.map(e => e.dur))} early INP ${Math.max(0, ...r.early.rows.map(e => e.dur))}`
    + ` | sync links ${linkLine(c.links)}`);
  if (i === 0 && /swiftshader/i.test(c.gpu) && GPU !== 'swiftshader') console.log('WARNING: WebGL is on SwiftShader, not the GPU: ' + c.gpu);
  if (c.errs.length) console.log('  page errors:', c.errs.join(' | '));
}
const screenshots = await shots();
let commit = ''; try { commit = execSync('git rev-parse --short HEAD', { cwd: root }).toString().trim() + (execSync('git status --porcelain web server', { cwd: root }).toString().trim() ? '+dirty' : ''); } catch { /* not a checkout */ }
const result = { at: new Date().toISOString(), commit, chrome: runs[0] && runs[0].chrome, gpu: runs[0] && runs[0].cold.gpu,
  config: { runs: RUNS, rttMs: RTT, kbps: KBPS, settleMs: SETTLE, gpuMode: GPU, glwrap: GLWRAP, viewport: '1440x900@1', url: url() }, summary: summarize(runs), screenshots, match: matchRun, runs };
fs.writeFileSync(OUT, JSON.stringify(result, null, 1));
const S = result.summary, line = (o, ks) => ks.map(k => `${k} ${o[k] ? `${o[k].median} [${o[k].min}..${o[k].max}]` : '-'}`).join(' · ');
console.log('\nGPU:', result.gpu);
console.log('COLD', line(S.cold, ['fcp', 'lcp', 'dcl', 'load', 'loafBlockMs', 'loafMs', 'trace.shaderCheckInclMs', 'gl.syncMs', 'programs', 'trace.sceneryMs', 'trace.canvasTexMs', 'net.requests', 'net.bytes', 'net.emoji']));
console.log('WARM', line(S.warm, ['fcp', 'lcp', 'dcl', 'load', 'loafBlockMs', 'trace.shaderCheckInclMs', 'gl.syncMs', 'net.requests', 'net.n304']));
console.log('LINKS cold', line(S.cold, ['links.home.made', 'links.home.sync', 'links.home.syncMs', 'links.lobby.sync', 'links.lobby.del', 'links.other.made']), '| warm', line(S.warm, ['links.home.sync', 'links.home.syncMs']));
console.log('MARKS cold', line(S.cold, ['marks.gl:first-frame.at', 'marks.gl:first-frame.dur', 'marks.gl:ready.at', 'marks.scenery:reveal.at', 'marks.scenery:reveal.dur']));
console.log('SETTLED', line(S.settled, ['inp', 'keySeen', 'keyMax', 'clickMax']), '| EARLY', line(S.early, ['clickAt', 'inp', 'firstClick', 'keySeen', 'keyMax']));
if (matchRun) console.log('MATCH sync links (phase sync/made):', linkLine(matchRun.links), matchRun.onCourt ? '' : '(never reached the court)');
console.log('\nwrote', OUT, screenshots.length ? '\nscreenshots ' + screenshots.join(' ') : '');
await finish(0);
