// Our own brotli (server/precompress.js at image build, server/game.js serveFile): which request gets the .br, and that everything else
// is exactly the response from before the .br files existed. Plain HTTP, no browser. Writes a few brtest-<pid>-* files into web/ (and
// web/index.html.br when there is none) and removes what it made, also on a failure.
// Usage: node test/brotli.test.mjs      BROTLI_PORT=<port> moves it (default 9030). Last line: BROTLI PASS or N FAILURES.
import { spawn } from 'child_process'; import http from 'http'; import fs from 'fs'; import os from 'os'; import path from 'path'; import zlib from 'zlib'; import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const PORT = +process.env.BROTLI_PORT || 9030, root = new URL('..', import.meta.url).pathname, WEB = path.join(root, 'web');
const { precompress } = require('../server/precompress.js');
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const wait = ms => new Promise(r => setTimeout(r, ms));
const req = (p, headers = {}, method = 'GET') => new Promise((res, rej) => { const r = http.request({ port: PORT, path: p, method, headers }, x => { const b = []; x.on('data', d => b.push(d)); x.on('end', () => res({ status: x.statusCode, h: x.headers, body: Buffer.concat(b) })); }); r.on('error', rej); r.end(); });
const BR = { 'Accept-Encoding': 'gzip, deflate, br, zstd' };            // what Chrome sends
const q11 = buf => zlib.brotliCompressSync(buf, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11 } });
const unbr = buf => { try { return zlib.brotliDecompressSync(buf); } catch { return Buffer.alloc(0); } };

// scratch files under web/ (the server only serves web/): fresh .br, stale .br, a directory where the .br should be, no .br at all
const made = [], tag = 'brtest-' + process.pid, put = (rel, data) => { const f = path.join(WEB, rel); fs.writeFileSync(f, data); made.push(f); return f; };
const src = Buffer.from(Array.from({ length: 400 }, (_, i) => `export const line${i} = 'the same few words, over and over, compress well';\n`).join(''));
function brBeside(f, mtimeShift = 0) { put(path.relative(WEB, f) + '.br', q11(fs.readFileSync(f))); const st = fs.statSync(f); fs.utimesSync(f + '.br', st.atime, st.mtimeMs / 1000 + mtimeShift); }
const fresh = put(tag + '.js', src); brBeside(fresh);
const stale = put(tag + '-stale.css', src); brBeside(stale, -10);         // the source was edited after the .br was made
const dirBr = put(tag + '-dir.js', src); fs.mkdirSync(dirBr + '.br'); made.push(dirBr + '.br');
const none = put(tag + '-none.js', src);
const INDEX = path.join(WEB, 'index.html'), indexHad = fs.existsSync(INDEX + '.br'); if (!indexHad) brBeside(INDEX);
const cleanup = () => { for (const f of made.reverse()) try { fs.rmSync(f, { recursive: true, force: true }); } catch { /* gone */ } };
process.on('exit', cleanup); for (const s of ['SIGINT', 'SIGTERM']) process.on(s, () => process.exit(1));

const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT, FLY_APP_NAME: '' }, stdio: ['ignore', 'ignore', 'inherit'] });
for (let i = 0; i < 60; i++) { try { await req('/robots.txt'); break; } catch { await wait(100); } }
const P = '/' + tag;
try {
  console.log('a fresh .br');
  { const a = await req(P + '.js', BR), id = await req(P + '.js'), brSize = fs.statSync(fresh + '.br').size;
    ok(a.status === 200 && a.h['content-encoding'] === 'br' && a.h.vary === 'Accept-Encoding' && +a.h['content-length'] === brSize && a.body.length === brSize && unbr(a.body).equals(src) && a.h['content-type'] === 'text/javascript; charset=utf-8',
      `Accept-Encoding with br: ${a.status} ${a.h['content-encoding']}, Vary ${a.h.vary}, ${a.body.length} B (the .br is ${brSize}), decodes to the file`);
    ok(id.status === 200 && !id.h['content-encoding'] && id.h.vary === 'Accept-Encoding' && id.body.equals(src) && +id.h['content-length'] === src.length, `no Accept-Encoding: identity, ${id.body.length} B, Vary ${id.h.vary}`);
    ok(/^W\/"[0-9a-f]+-[0-9a-f]+-br"$/.test(a.h.etag) && a.h.etag === id.h.etag.slice(0, -1) + '-br"' && a.h['last-modified'] === id.h['last-modified'] && a.h['cache-control'] === id.h['cache-control'],
      `each encoding its own weak tag (${a.h.etag} / ${id.h.etag}); Last-Modified and Cache-Control the same`);
    for (const [ae, want] of [['gzip, deflate', null], ['br;q=0', null], ['gzip, br;q=0.0', null], ['*', null], ['identity', null], ['BR;q=0.5', 'br'], ['gzip;q=1, br;q=0.1', 'br'], ['brotli', null]]) {
      const r = await req(P + '.js', { 'Accept-Encoding': ae }); ok(r.status === 200 && (r.h['content-encoding'] || null) === want && (want ? unbr(r.body) : r.body).equals(src), `Accept-Encoding "${ae}": ${r.h['content-encoding'] || 'identity'}`); }
    const n1 = await req(P + '.js', { ...BR, 'If-None-Match': a.h.etag }), n2 = await req(P + '.js', { 'If-None-Match': a.h.etag }), n3 = await req(P + '.js', { ...BR, 'If-None-Match': id.h.etag }), n4 = await req(P + '.js', { 'If-None-Match': id.h.etag });
    ok(n1.status === 304 && n1.body.length === 0 && n1.h.vary === 'Accept-Encoding' && n1.h.etag === a.h.etag && !n1.h['content-encoding'], `br tag, br accepted: ${n1.status}, Vary ${n1.h.vary}, ETag ${n1.h.etag}`);
    ok(n2.status === 200 && !n2.h['content-encoding'] && n2.body.equals(src), `br tag, br not accepted: ${n2.status} identity (that cache holds the other encoding)`);
    ok(n3.status === 200 && n3.h['content-encoding'] === 'br', `identity tag, br accepted: ${n3.status} br`);
    ok(n4.status === 304 && n4.h.etag === id.h.etag && n4.h.vary === 'Accept-Encoding', `identity tag, identity: ${n4.status}`);
    const m1 = await req(P + '.js', { ...BR, 'If-Modified-Since': a.h['last-modified'] }), m2 = await req(P + '.js', { 'If-Modified-Since': a.h['last-modified'] });
    ok(m1.status === 304 && m2.status === 304 && m1.h.etag === a.h.etag && m2.h.etag === id.h.etag, `If-Modified-Since: ${m1.status} / ${m2.status}, each with its own tag`);
    const h = await req(P + '.js', BR, 'HEAD'); ok(h.status === 200 && h.body.length === 0 && +h.h['content-length'] === brSize && h.h['content-encoding'] === 'br', `HEAD with br: ${h.status}, no body, Content-Length ${h.h['content-length']}`);
    const rg = await req(P + '.js', { ...BR, Range: 'bytes=0-99' }); ok(rg.status === 200 && rg.h['content-encoding'] === 'br' && !rg.h['content-range'] && unbr(rg.body).equals(src), `a range on a .js: ${rg.status}, the whole file (ranges are mp4 only, as before)`); }

  console.log('no usable .br: the response from before');
  for (const [p, f, why] of [[P + '-stale.css', stale, 'stale .br'], [P + '-dir.js', dirBr, '.br is a directory'], [P + '-none.js', none, 'no .br']]) {
    const r = await req(p, BR), r0 = await req(p);
    ok(r.status === 200 && !r.h['content-encoding'] && !r.h.vary && r.body.equals(fs.readFileSync(f)) && !/-br"$/.test(r.h.etag) && r.h.etag === r0.h.etag && JSON.stringify(Object.keys(r.h)) === JSON.stringify(Object.keys(r0.h)),
      `${why}: ${r.status} identity, no Vary, same headers with or without br (${r.h.etag})`); }
  { fs.rmSync(fresh + '.br'); const r = await req(P + '.js', BR); ok(r.status === 200 && !r.h['content-encoding'] && r.body.equals(src), `the .br removed while serving: ${r.status} identity at once`); brBeside(fresh); }

  console.log('pages');
  { const html = (await req('/')).body;                              // the page as served without br: index.html, rewritten with ?v= hashes (server/versioned.js)
    for (const p of ['/', '/index.html', '/play', '/leaderboard']) { const r = await req(p, BR);
      ok(r.status === 200 && r.h['content-encoding'] === 'br' && r.h['document-policy'] === 'js-profiling' && r.h['content-type'] === 'text/html; charset=utf-8' && unbr(r.body).equals(html), `${p} with br: ${r.status} ${r.h['content-encoding']}, Document-Policy ${r.h['document-policy']}, decodes to the identity page`); }
    const mv = await req('/how-to-play', BR); ok(mv.status === 301 && mv.h.location === '/how-to-play.html' && !mv.h['content-encoding'], `a MOVED path: ${mv.status} -> ${mv.h.location}`);
    for (const p of [P + '.js.br', '/index.html.br', '/main.js.BR']) { const r = await req(p, BR); ok(r.status === 404 && r.h['content-type'] === 'text/html; charset=utf-8' && !r.h['content-encoding'], `${p}: ${r.status} (a .br is not a URL of its own)`); }
    if (fs.existsSync(path.join(WEB, 'video/teaser.mp4'))) { const r = await req('/video/teaser.mp4', { ...BR, Range: 'bytes=0-99' });
      ok(r.status === 206 && r.body.length === 100 && !r.h['content-encoding'] && !r.h.vary && r.h['accept-ranges'] === 'bytes', `teaser.mp4 range with br accepted: ${r.status}, ${r.body.length} B, identity`); }
    const up = await req('/status.json'); ok(up.status === 200, 'and the server is still up'); }

  console.log('server/precompress.js');
  { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'brtest-')); fs.mkdirSync(path.join(d, 'sub')); fs.mkdirSync(path.join(d, 'video'));
    fs.writeFileSync(path.join(d, 'a.js'), src); fs.writeFileSync(path.join(d, 'sub', 'b.css'), src); fs.writeFileSync(path.join(d, 'tiny.txt'), 'x'); fs.writeFileSync(path.join(d, 'c.png'), src);
    fs.writeFileSync(path.join(d, 'video', 'v.js'), src); fs.writeFileSync(path.join(d, 'gone.js.br'), 'old'); fs.writeFileSync(path.join(d, 'tiny.txt.br'), 'old');
    const o = precompress(d), ex = f => fs.existsSync(path.join(d, f)), mt = f => fs.statSync(path.join(d, f)).mtimeMs;
    ok(o.files === 2 && ex('a.js.br') && ex('sub/b.css.br') && unbr(fs.readFileSync(path.join(d, 'a.js.br'))).equals(src), `writes a .br beside each text file, nested too (${o.files} files, ${o.raw} -> ${o.br} B)`);
    ok(Math.abs(mt('a.js.br') - mt('a.js')) < 1 && Math.abs(mt('sub/b.css.br') - mt('sub/b.css')) < 1, 'each .br has its source\'s mtime (the server\'s freshness check does not depend on the build machine\'s clock)');
    ok(!ex('c.png.br') && !ex('video/v.js.br') && !ex('tiny.txt.br') && !ex('gone.js.br') && o.removed === 1, 'not for pictures, video/, a file brotli cannot shrink (its old .br removed) or an orphan .br');
    const o0 = precompress(d, 0); ok(o0.files === 0 && !ex('a.js.br') && !ex('sub/b.css.br'), 'quality 0 removes them all');
    fs.rmSync(d, { recursive: true, force: true }); }
} catch (e) { ok(false, 'threw: ' + (e && e.stack || e)); }
proc.kill();
console.log(fails ? `BROTLI ${fails} FAILURES` : 'BROTLI PASS');
process.exit(fails ? 1 : 0);
