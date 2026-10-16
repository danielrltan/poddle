// Versioned URLs (server/versioned.js, server/game.js servePage + serveFile's ?v=): what a page names, what a ?v= request is cached for, and that
// a changed file changes the page (never an old page with a new module, never a year on a hash that is not the bytes sent). Plain HTTP, no browser.
// The change cases run on a temp copy of a page and two modules (server/versioned.js takes any dir); nothing under web/ is written.
// Usage: node test/versioned.test.mjs      VERSIONED_PORT=<port> moves it (default 9035). Last line: VERSIONED PASS or N FAILURES.
import { spawn } from 'child_process'; import http from 'http'; import fs from 'fs'; import os from 'os'; import path from 'path'; import crypto from 'crypto'; import zlib from 'zlib'; import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const PORT = +process.env.VERSIONED_PORT || 9035, root = new URL('..', import.meta.url).pathname, WEB = path.join(root, 'web');
const versioned = require('../server/versioned.js');
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const req = (p, headers = {}, method = 'GET') => new Promise((res, rej) => { const r = http.request({ port: PORT, path: p, method, headers }, x => { const b = []; x.on('data', d => b.push(d)); x.on('end', () => res({ status: x.statusCode, h: x.headers, body: Buffer.concat(b) })); }); r.on('error', rej); r.end(); });
const hash = f => crypto.createHash('sha1').update(fs.readFileSync(f)).digest('hex').slice(0, 10);
const YEAR = 'public, max-age=31536000, immutable';
const mapOf = html => { const m = html.match(/<script type="importmap">([^<]*)<\/script>/); try { return m ? JSON.parse(m[1]).imports : null; } catch { return null; } };
const refs = html => [...html.matchAll(/\s(?:src|href)="([^"]+\?v=[0-9a-f]{10})"/g)].map(m => m[1]);

const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, FLY_APP_NAME: '' }, stdio: ['ignore', 'ignore', 'inherit'] });
for (let i = 0; i < 60; i++) { try { await req('/robots.txt'); break; } catch { await wait(100); } }
try {
  console.log('pages');
  for (const p of ['/', '/play', '/leaderboard', '/index.html', '/pad.html']) {
    const r = await req(p), html = r.body.toString(), file = p === '/pad.html' ? 'pad.html' : 'index.html', map = mapOf(html), rs = refs(html);
    const mapAt = html.indexOf('<script type="importmap">'), firstMod = html.search(/<(?:script\b[^>]*\stype="module"|link\b[^>]*\srel="modulepreload")/);
    ok(r.status === 200 && r.h['cache-control'] === 'no-cache' && r.h['document-policy'] === 'js-profiling' && !!r.h['last-modified'] && /^W\/"[0-9a-f]+-[0-9a-f]{12}"$/.test(r.h.etag) && r.h.vary === 'Accept-Encoding',
      `${p}: ${r.status}, no-cache, Document-Policy, Last-Modified, ETag ${r.h.etag}`);
    ok(map && mapAt >= 0 && mapAt < firstMod && (html.match(/type="importmap"/g) || []).length === 1, `${p}: one import map, before the first module load (${mapAt} < ${firstMod})`);
    const bad = rs.filter(u => { const [f, v] = u.split('?v='); return hash(path.join(WEB, f.replace(/^\//, ''))) !== v; }).concat(Object.entries(map || {}).filter(([k, v]) => v !== `${k}?v=${hash(path.join(WEB, k.slice(1)))}`).map(([k]) => k));
    ok(rs.length >= (file === 'pad.html' ? 3 : 16) && !bad.length, `${p}: ${rs.length} src/href and ${Object.keys(map || {}).length} map entries, each ?v= the file's own hash${bad.length ? ' BAD ' + bad.join(' ') : ''}`);
    const pre = rs.filter(u => /\.m?js\?/.test(u) && !/rum\.js|three\.min\.js/.test(u)).filter(u => map[u.split('?')[0].replace(/^(?!\/)/, '/')] !== u.replace(/^(?!\/)/, '/'));
    ok(!pre.length, `${p}: every module src/modulepreload is the very URL the map gives that module (one instance each)${pre.length ? ' BAD ' + pre.join(' ') : ''}`);
    const s = html.replace(/<script type="importmap">[^<]*<\/script>\n/, '').replace(/\?v=[0-9a-f]{10}"/g, '"');
    ok(s === fs.readFileSync(path.join(WEB, file), 'utf8'), `${p}: the page minus its map and hashes is web/${file}, byte for byte`);
  }
  { const m = mapOf((await req('/')).body.toString());
    ok(['/main.js', '/ui.js', '/emblems.js', '/scenery/index.js', '/scenery/park.js', '/vendor/qrcode.mjs', '/vendor/mp/vision_bundle.js'].every(k => m[k]), 'the map holds static imports, import() targets (scenery, qrcode, MediaPipe) and what they import');
    ok(!m['/pad.js'] && !m['/rum.js'] && !m['/vendor/three.min.js'], 'and nothing the page does not reach as a module (pad.js, the classic scripts)'); }
  { const a = await req('/'), b = await req('/', { 'If-None-Match': a.h.etag }), c = await req('/', { 'If-Modified-Since': a.h['last-modified'] }), d = await req('/', {}, 'HEAD');
    ok(b.status === 304 && b.h.etag === a.h.etag && b.h['cache-control'] === 'no-cache' && b.h['document-policy'] === 'js-profiling', `If-None-Match with the page's tag: ${b.status}`);
    ok(c.status === 200 && c.body.equals(a.body), `If-Modified-Since alone: ${c.status} (never a 304 that could keep an old page naming old hashes)`);
    ok(d.status === 200 && d.body.length === 0 && +d.h['content-length'] === a.body.length, `HEAD /: ${d.status}, Content-Length ${d.h['content-length']}`);
    const br = await req('/', { 'Accept-Encoding': 'gzip, deflate, br, zstd' }), brh = await req('/', { 'Accept-Encoding': 'br' }, 'HEAD'), br304 = await req('/', { 'Accept-Encoding': 'br', 'If-None-Match': br.h.etag }), cross = await req('/', { 'If-None-Match': br.h.etag });
    ok(br.h['content-encoding'] === 'br' && zlib.brotliDecompressSync(br.body).equals(a.body) && br.h.etag === a.h.etag.slice(0, -1) + '-br"' && br.body.length < a.body.length / 3, `br: the rewritten page compressed (${br.body.length} B of ${a.body.length}), its own tag ${br.h.etag}`);
    ok(brh.status === 200 && +brh.h['content-length'] === br.body.length && br304.status === 304 && cross.status === 200 && !cross.h['content-encoding'], `HEAD with br ${brh.h['content-length']} B; br tag revalidates br (${br304.status}) but not identity (${cross.status})`); }
  { const nv = await req('/pickleball-no-download.html'), t = nv.body.toString();
    ok(nv.status === 200 && !/<script\b(?![^>]*application\/ld\+json)/.test(t) && /how-to-play\.css\?v=[0-9a-f]{10}"/.test(t) && !mapOf(t), 'a no-JS landing page: its stylesheet versioned, no script and no map added'); }

  console.log('files');
  { const h = hash(path.join(WEB, 'main.js')), a = await req('/main.js?v=' + h), b = await req('/main.js?v=' + h, { 'If-None-Match': a.h.etag }), c = await req('/main.js?v=0123456789'), d = await req('/main.js'), e = await req('/main.js?v=' + h.toUpperCase());
    ok(a.status === 200 && a.h['cache-control'] === YEAR && a.body.equals(fs.readFileSync(path.join(WEB, 'main.js'))), `/main.js?v=<its hash>: ${a.h['cache-control']}`);
    ok(b.status === 304 && b.h['cache-control'] === YEAR, `its revalidation: ${b.status}, ${b.h['cache-control']} (a 304 keeps the year)`);
    ok(c.status === 200 && c.h['cache-control'] === 'no-cache' && c.body.equals(a.body) && d.h['cache-control'] === 'no-cache' && e.h['cache-control'] === 'no-cache', `an old or wrong ?v=, none, or upper case: today's file, no-cache (${c.h['cache-control']}, ${d.h['cache-control']}, ${e.h['cache-control']})`);
    const t = await req('/vendor/three.min.js?v=' + hash(path.join(WEB, 'vendor/three.min.js'))), t0 = await req('/vendor/three.min.js'), og = await req('/og.jpg?v=9'), og2 = await req('/og.jpg?v=' + (fs.existsSync(path.join(WEB, 'og.jpg')) ? hash(path.join(WEB, 'og.jpg')) : '0123456789'));
    ok(t.h['cache-control'] === YEAR && t0.h['cache-control'] === 'public, max-age=86400', `vendor/three.min.js: a year with its hash, a day without (${t0.h['cache-control']})`);
    ok(og.h['cache-control'] === 'public, max-age=604800' && og2.h['cache-control'] === 'public, max-age=604800', `og.jpg?v=9 and a picture with a hash-like ?v=: a week, as before (only .js/.mjs/.css are versioned)`); }

  console.log('a file changes (temp dir)');
  { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'vertest-')); fs.mkdirSync(path.join(d, 'sub'));
    const page = path.join(d, 'p.html'), a = path.join(d, 'a.js'), b = path.join(d, 'sub', 'b.js'), css = path.join(d, 's.css');
    fs.writeFileSync(page, '<!doctype html>\n<link rel="stylesheet" href="s.css">\n<link rel="modulepreload" href="a.js">\n<script type="module" src="a.js"></script>\n');
    fs.writeFileSync(a, "import { b } from './sub/b.js';\nexport const a = b;\n"); fs.writeFileSync(b, 'export const b = 1;\n'); fs.writeFileSync(css, 'body{}\n');
    const old = new Date(Date.now() - 3600e3); for (const f of [page, a, b, css]) fs.utimesSync(f, old, old);
    const v = versioned(d), get = () => v.page(page, fs.statSync(page));
    const p1 = get(), m1 = mapOf(p1.body.toString());
    ok(m1 && m1['/a.js'] === '/a.js?v=' + hash(a) && m1['/sub/b.js'] === '/sub/b.js?v=' + hash(b) && p1.body.toString().includes('href="s.css?v=' + hash(css) + '"'), 'a page in another dir: entries, their imports and the stylesheet versioned');
    ok(get() === p1, 'nothing changed: the same build (no read, no hash)');
    fs.writeFileSync(b, 'export const b = 2;\n'); const p2 = get(), m2 = mapOf(p2.body.toString());
    ok(p2 !== p1 && m2['/sub/b.js'] === '/sub/b.js?v=' + hash(b) && m2['/sub/b.js'] !== m1['/sub/b.js'] && m2['/a.js'] === m1['/a.js'] && p2.etag !== p1.etag && p2.mtime > p1.mtime,
      `a module two imports deep edited: its hash, the page's ETag and Last-Modified all move (${p1.etag} -> ${p2.etag}); the page file itself untouched`);
    ok(v.hashOf(b, fs.statSync(b)) === hash(b) && v.hashOf(b, fs.statSync(b)) !== m1['/sub/b.js'].split('=')[1], 'the old hash no longer earns the year (hashOf is the new bytes)');
    fs.writeFileSync(a, "import { b } from './sub/b.js';\nimport { c } from './c.js';\nexport const a = b + c;\n"); const p3 = get();
    ok(!mapOf(p3.body.toString())['/c.js'], 'an import of a missing file: left out of the map (it would be a 404 either way)');
    fs.writeFileSync(path.join(d, 'c.js'), 'export const c = 3;\n'); const p4 = get();
    ok(mapOf(p4.body.toString())['/c.js'] === '/c.js?v=' + hash(path.join(d, 'c.js')), 'the missing file appears: the next request rebuilds and maps it');
    fs.writeFileSync(page, '<!doctype html>\n<script type="importmap">{"imports":{}}</script>\n<script type="module" src="a.js"></script>\n'); ok(get() === null, 'a page with its own import map: served as it is (one map per page)');
    fs.writeFileSync(page, '<!doctype html>\n<p>no scripts</p>\n'); ok(get() === null, 'a page that names nothing: served as it is');
    fs.rmSync(d, { recursive: true, force: true }); }
  const up = await req('/status.json'); ok(up.status === 200, 'and the server is still up');
} catch (e) { ok(false, 'threw: ' + (e && e.stack || e)); }
proc.kill();
console.log(fails ? `VERSIONED ${fails} FAILURES` : 'VERSIONED PASS');
process.exit(fails ? 1 : 0);
