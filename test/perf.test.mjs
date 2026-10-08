// Page-load diagnostics (server/perf.js, web/rum.js, NOTES 232). Part 1 in process (':memory:'): what a beacon may say and what is kept.
// Part 2 on a real server in a real Chrome: the home page's load and fin parts and its profile reach the database, and the panel's reads
// return them behind the key. PERF_PORT=<port> moves the server (default 8970). Last line: PERF PASS or N FAILURES.
import { createRequire } from 'module'; import { spawn } from 'child_process'; import zlib from 'zlib';
const require = createRequire(import.meta.url);
const db = require('../server/db.js'), perf = require('../server/perf.js'), traffic = require('../server/traffic.js');
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const CHROME_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const PH = 'https://poddleball.com', DR = 'https://danielrltan.com';
const quiet = f => { const e = console.error; console.error = () => {}; try { return f(); } finally { console.error = e; } };

console.log('shaping');
quiet(() => db.open(':memory:')); perf.init({ hosted: true });
traffic.init({ db, site: 'poddleball.com', addrOf: r => r && r.socket ? r.socket.remoteAddress : 'bad', flushMs: 3600e3, log: () => {} });   // as game.js: no request, no address, no count
ok(perf.siteOf(PH) === 'poddleball.com' && perf.siteOf('https://www.danielrltan.com') === 'danielrltan.com' && perf.siteOf('https://evil.example') === null && perf.siteOf('http://localhost:5173', 'danielrltan.com') === null, 'sites by Origin; on Fly a localhost origin is refused');
ok(perf.url('https://poddleball.com/pad.html?k=ABCD#x', PH) === '/pad.html' && perf.url('https://poddleball.com/c/s3cr3tslug', PH) === '/c/*' && perf.url('https://cdn.example/a.js?token=1', PH) === 'https://cdn.example/a.js' && perf.url('blob:https://poddleball.com/1', PH) === 'blob', 'URLs lose query, fragment and share slugs; other origins keep host + path');
ok(perf.uaOf(CHROME_UA) === 'Chrome 141 · macOS' && perf.uaOf('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1') === 'Safari 18 · iOS · mobile', 'the user agent becomes family, major version, platform');
const id1 = '0123456789abcdef', load = (id, extra = {}) => JSON.stringify({ id, kind: 'load', page: '/pad.html?k=SECRET', nav: { ps: 120.4, dl: 800, le: 1500, ty: 'navigate' }, fcp: 300, lcp: { t: 900, el: 'canvas' },
  res: [['https://poddleball.com/main.js?v=2', 'script', 130, 400, 90000, 89000, 300, 'blocking', 200], ['https://poddleball.com/c/slug.png', 'img', 1, 2, 3, 4, 5, '', 200]],
  loaf: [[1000, 220, 170, 1180, 1190, [['https://poddleball.com/main.js?x=1', 'boot', 'https://poddleball.com/main.js?x=1', 'classic-script', 1001, 200, 3, 10]]]], evil: 'x'.repeat(100), ...extra });
let r = perf.beacon({ origin: PH, ua: CHROME_UA, body: load(id1) });
ok(r.status === 204, 'a load part is stored: ' + r.status);
const v = perf.viewOf(id1), js = JSON.stringify(v);
ok(v && v.site === 'poddleball.com' && v.page === '/pad.html' && v.ttfb === 120.4 && v.fcp === 300 && v.lcp === 900 && v.block === 170 && v.ua === 'Chrome 141 · macOS', 'its columns: ' + JSON.stringify(v && { page: v.page, ttfb: v.ttfb, lcp: v.lcp, block: v.block }));
ok(!js.includes('SECRET') && !js.includes('slug') && !js.includes('?') && !js.includes('evil') && v.load.res[0][0] === '/main.js' && v.load.loaf[0][5][0][2] === '/main.js', 'no query string, no share slug, no unknown field in what is kept');
ok(perf.beacon({ origin: 'https://evil.example', ua: CHROME_UA, body: load('1111111111111111') }).status === 403, 'another origin: 403');
ok(perf.beacon({ origin: PH, ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)', body: load('2222222222222222') }).status === 204 && !perf.viewOf('2222222222222222'), 'a crawler: 204, nothing kept');
ok(perf.beacon({ origin: PH, ua: CHROME_UA, body: load('nothex') }).status === 400 && perf.beacon({ origin: PH, ua: CHROME_UA, body: 'not json' }).status === 400, 'a bad id or body: 400');
r = perf.beacon({ origin: PH, ua: CHROME_UA, body: JSON.stringify({ id: id1, kind: 'fin', page: '/pad.html', cls: 0.05, inp: 180, lcp: { t: 950 }, ev: [['click', 'button#play', 2000, 180, 20, 120, 40]], clicks: [['button#play', 2000]] }) });
const v2 = perf.viewOf(id1);
ok(r.status === 204 && v2.inp === 180 && v2.cls === 0.05 && v2.lcp === 950 && v2.fin.ev.length === 1 && v2.fin.clicks.length === 0, 'the fin part updates the view; poddleball.com keeps no click targets (latency only)');
const id3 = '3333333333333333', inv = [[1, 120, 70, 0, 0, [['', '', 'BUTTON#friend-accept.onclick', 'event-listener', 1, 100, 0, 0], ['', '', 'IMG[src=https://poddleball.com/c/abc.png?v=1].onload', 'event-listener', 2, 10, 0, 0]]]];
perf.beacon({ origin: PH, ua: CHROME_UA, body: load(id3, { loaf: inv, lcp: { t: 5, el: 'button#play' } }) });
perf.beacon({ origin: PH, ua: CHROME_UA, body: JSON.stringify({ id: id3, kind: 'fin', ev: [['click', 'button#friend-accept', 1, 50, 1, 1, 1]], loaf: inv }) });
const v3 = perf.viewOf(id3), s3 = JSON.stringify(v3);
ok(v3.load.loaf[0][5][0][2] === 'BUTTON.onclick' && v3.load.loaf[0][5][1][2] === 'IMG.onload' && v3.fin.loaf[0][5][0][2] === 'BUTTON.onclick' && v3.fin.ev[0][1] === 'button' && v3.load.lcp.el === 'button' && !s3.includes('friend') && !s3.includes('abc') && !s3.includes('play'),
  'poddleball.com: long-frame invokers, interaction targets and the LCP element keep the tag only (no #id, no [src=])');
const id4 = '4444444444444444'; perf.beacon({ origin: DR, ua: CHROME_UA, body: load(id4, { loaf: inv }) });
ok(perf.viewOf(id4).load.loaf[0][5][0][2] === 'BUTTON#friend-accept.onclick' && perf.viewOf(id4).load.loaf[0][5][1][2] === 'IMG.onload', 'danielrltan.com keeps the id, never the [src=] part');
ok(perf.beacon({ origin: DR, ua: CHROME_UA, body: JSON.stringify({ id: id1, kind: 'fin', inp: 1 }) }).status === 429 && perf.viewOf(id1).inp === 180, "another site cannot touch a view");
perf.beacon({ origin: DR, ua: CHROME_UA, body: JSON.stringify({ id: 'aaaaaaaaaaaaaaaa', kind: 'fin', page: '/', clicks: [['a#resume', 10], ['<b>x</b>', 11]] }) });
ok(JSON.stringify(perf.viewOf('aaaaaaaaaaaaaaaa').fin.clicks) === '[["a#resume",10],["bx/b",11]]', 'danielrltan.com keeps click targets, characters limited');

console.log("another site's page views and events (NOTES 233)");
const rq = a => ({ headers: {}, socket: { remoteAddress: a } });
const dv = (id, a, extra = {}) => perf.beacon({ origin: DR, ua: CHROME_UA, req: rq(a), body: JSON.stringify({ id, kind: 'load', page: '/?ref=x', ...extra }) });
dv('d000000000000001', '203.0.113.1', { tag: 'LinkedIn' }); dv('d000000000000002', '203.0.113.1', { ref: 'https://www.google.com' }); dv('d000000000000003', '203.0.113.2', { ref: 'https://danielrltan.com' });
perf.beacon({ origin: DR, ua: 'Mozilla/5.0 (compatible; Googlebot/2.1)', req: rq('203.0.113.3'), body: JSON.stringify({ id: 'd000000000000004', kind: 'load', page: '/' }) });
perf.beacon({ origin: PH, ua: CHROME_UA, req: rq('203.0.113.4'), body: load('d000000000000005') });
perf.beacon({ origin: DR, ua: CHROME_UA, req: rq('203.0.113.1'), body: JSON.stringify({ id: 'd000000000000001', kind: 'fin', evs: [['section_view', 'work'], ['section_view', 'work'], ['outbound_link', 'about · https://github.com/x'], ['Bad Name', 'x']] }) });
let tr = traffic.report(1, 'danielrltan.com')[0];
ok(tr && tr.views === 3 && tr.people === 2 && tr.pages[0].page === '/', 'three loads of / from two addresses: 3 views, 2 people (the crawler not counted): ' + JSON.stringify(tr && { v: tr.views, p: tr.people, pages: tr.pages }));
ok(tr && JSON.stringify(tr.sources.map(x => x.source).sort()) === '["google.com","linkedin","site"]', 'sources: the ?ref= tag, the referrer host, our own host as site: ' + JSON.stringify(tr && tr.sources));
ok(tr && JSON.stringify(tr.events.map(e => [e.name, e.detail, e.n])) === '[["section_view","work",2],["outbound_link","about · https://github.com/x",1]]', 'named events counted per day, bad names dropped: ' + JSON.stringify(tr && tr.events));
ok(!(traffic.report(1)[0] || { views: 0 }).views && !JSON.stringify(db.siteTrafficReport('danielrltan.com', '2000-01-01')).includes('203.0'), "poddleball.com's beacons never count a view (it counts as it serves), and no address is stored");
traffic.stop();

console.log('profiles');
const trace = { resources: ['https://poddleball.com/main.js?v=1'], frames: [{ name: 'boot', resourceId: 0, line: 1, column: 2 }, { name: 'tick', resourceId: 9 }], stacks: [{ frameId: 0 }, { frameId: 1, parentId: 0 }], samples: [{ timestamp: 10, stackId: 1 }, { timestamp: 20 }] };
r = perf.profile({ origin: PH, ua: CHROME_UA, id: id1, body: zlib.gzipSync(JSON.stringify(trace)) });
const back = JSON.parse(zlib.gunzipSync(perf.profileOf(id1)));
ok(r.status === 204 && perf.viewOf(id1).prof === 1 && back.resources[0] === '/main.js' && back.frames[1].resourceId === undefined && back.samples.length === 2, 'a gzipped profile is checked, stripped and kept: ' + r.status);
ok(perf.profile({ origin: PH, ua: CHROME_UA, id: id1, body: Buffer.from(JSON.stringify(trace)) }).status === 409, 'one profile per view');
ok(perf.profile({ origin: PH, ua: CHROME_UA, id: 'bbbbbbbbbbbbbbbb', body: Buffer.from(JSON.stringify(trace)) }).status === 409, 'no view, no profile');
ok(JSON.stringify(perf.profileIds('poddleball.com', '/pad.html', 7)) === JSON.stringify([id1]), 'profile ids by page');
const ck = perf.clicksOf('danielrltan.com', 7), cp = perf.clicksOf('poddleball.com', 7);
ok(JSON.stringify(ck.targets) === '[{"target":"a#resume","n":1},{"target":"bx/b","n":1}]' && cp.targets.length === 0 && cp.slow[0].target === 'button' && cp.slow[0].p75 === 180, 'clicks and interaction latency over the range: ' + JSON.stringify(cp.slow));

console.log('caps and sweep');
for (let i = 0; i < perf.LIMITS.dayCap + 5; i++) perf.beacon({ origin: DR, ua: CHROME_UA, body: load('1' + String(i).padStart(15, '0')) });
ok(perf.listOf('danielrltan.com', 1).length === perf.LIMITS.dayCap, `a site's day cap holds: ${perf.listOf('danielrltan.com', 1).length}`);
ok(perf.listOf('poddleball.com', 1).length === 3, 'and does not touch the other site');
db.perfSweep(Date.now(), 30, 10, 0);
ok(perf.listOf('danielrltan.com', 30).length + perf.listOf('poddleball.com', 30).length === 10 && !perf.profileOf(id1), 'the sweep keeps the newest views and profiles');
db.perfSweep(Date.now() + 31 * 86400e3, 30, 8000, 200);
ok(perf.listOf('danielrltan.com', 30, Date.now() + 31 * 86400e3).length === 0, '30 days and they are gone');
db.close();

console.log('a real page in Chrome');
const PORT = +process.env.PERF_PORT || 8970, KEY = 'perf-test-key', base = `http://localhost:${PORT}`;
const server = spawn('node', ['server/game.js'], { cwd: new URL('..', import.meta.url).pathname, env: { ...process.env, PORT, STATS_KEY: KEY, FLY_APP_NAME: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
let browser;
try {
  for (let i = 0; i < 50; i++) { try { await fetch(base + '/status.json'); break; } catch { await sleep(200); } }
  const head = await fetch(base + '/how-to-play.html');
  ok(head.headers.get('document-policy') === 'js-profiling', 'pages are served with Document-Policy: js-profiling');
  const puppeteer = (await import('puppeteer-core')).default;
  browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--user-agent=' + CHROME_UA] });   // the flag, not setUserAgent: a beacon sent while the page unloads carries the browser's own agent, and HeadlessChrome is a bot
  const pg = await browser.newPage(); await pg.setUserAgent(CHROME_UA);
  await pg.evaluateOnNewDocument(() => { window.__rumForce = 1; window.__rumProfile = 1; });
  await pg.goto(base + '/?ref=test', { waitUntil: 'load' });
  await sleep(4500);
  await pg.click('body').catch(() => {});
  await sleep(1500);
  await pg.goto(base + '/privacy.html'); await sleep(1500);
  const get = (p, h = { authorization: 'Bearer ' + KEY }) => fetch(base + p, { headers: h });
  ok((await get('/api/perf?site=localhost', {})).status === 401, 'the reads need the key');
  const list = await (await get('/api/perf?site=localhost&days=1')).json();
  const row = list.views && list.views[0];
  ok(row && row.page === '/' && row.ttfb > 0 && row.fcp > 0 && row.onload > 0, 'the home page load is listed: ' + JSON.stringify(row));
  const view = row && await (await get('/api/perf/view?id=' + row.id)).json();
  ok(view && view.load && view.load.res.some(x => x[0] === '/main.js') && view.load.nav.le > 0, 'its load part: ' + (view && view.load && view.load.res.length) + ' files');
  ok(view && view.fin && view.fin.dur > 0, 'its fin part (sent on leaving): ' + JSON.stringify(view && view.fin).slice(0, 300));
  ok(view && !JSON.stringify(view).includes('ref=test'), 'the page URL lost its ?ref=');
  ok(row && row.prof === 1, 'its profile arrived');
  const pr = row && await get('/api/perf/profile?id=' + row.id);
  const tr = pr && pr.ok && await pr.json();
  ok(tr && tr.samples.length > 10 && tr.frames.length > 10 && tr.resources.includes('/main.js'), `the profile reads back: ${tr && tr.samples.length} samples, ${tr && tr.frames.length} frames`);
} catch (e) { ok(false, 'threw: ' + (e && e.stack)); }
finally { if (browser) await browser.close(); server.kill(); }
console.log(fails ? `${fails} FAILURES` : 'PERF PASS');
process.exit(fails ? 1 : 0);
