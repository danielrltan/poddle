// Brotli at quality 11, made once when the image is built (Dockerfile: RUN node server/precompress.js), never while serving.
// Fly's proxy compresses on the fly at about q1 (three.min.js 191 KB on the wire vs 135 KB at q11; the text of a home load 651 KB vs 471 KB),
// and q11 is too slow to do per request or at boot (~2 s of the one core while courts revive). server/game.js sends <file>.br with
// Content-Encoding: br when the request accepts br and the .br is as new as its source; otherwise the file itself, exactly as before.
//   node server/precompress.js [dir]        dir defaults to web/; PODDLE_BR_Q=<0..11> sets the quality (measurement only; 0 removes them all)
// Every run rewrites every .br (none is trusted from before) and gives it its source's mtime, so the server's freshness check does not depend
// on the builder's clock agreeing with the files' (COPY keeps the mtimes from the machine that deployed). A .br that is not smaller is not written.
const fs = require('fs'), path = require('path'), zlib = require('zlib');
const EXT = new Set(['.js', '.mjs', '.css', '.html', '.svg', '.json', '.webmanifest', '.txt', '.xml']);   // server/game.js BR_EXT: the same list
const SKIP = new Set(['download', 'video', 'audio']);              // binaries only (the helper zip, the teaser, the music): nothing to compress there

function precompress(dir = path.join(__dirname, '..', 'web'), q = 11) {
  const out = { files: 0, raw: 0, br: 0, skipped: 0, removed: 0 };
  (function walk(d) {
    for (const n of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, n.name);
      if (n.isDirectory()) { if (!SKIP.has(n.name)) walk(f); continue; }
      if (n.name.endsWith('.br')) { if (!fs.existsSync(f.slice(0, -3))) { fs.unlinkSync(f); out.removed++; } continue; }   // its source is gone: never serve an orphan
      if (!n.isFile() || !EXT.has(path.extname(n.name).toLowerCase())) continue;
      const raw = fs.readFileSync(f), st = fs.statSync(f);
      const br = q > 0 && zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: q, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } });
      if (!br || br.length >= raw.length) { fs.rmSync(f + '.br', { force: true }); out.skipped++; continue; }   // tiny files: identity is no bigger
      fs.writeFileSync(f + '.br', br); fs.utimesSync(f + '.br', st.atime, st.mtimeMs / 1000);   // same mtime as the source (seconds with the fraction: sub-ms survives)
      out.files++; out.raw += raw.length; out.br += br.length;
    }
  })(dir);
  return out;
}

module.exports = { precompress, EXT };
if (require.main === module) {
  const t = Date.now(), q = process.env.PODDLE_BR_Q != null && process.env.PODDLE_BR_Q !== '' ? +process.env.PODDLE_BR_Q : 11, o = precompress(process.argv[2] ? path.resolve(process.argv[2]) : undefined, q);
  console.log(`precompress: q${q}, ${o.files} files ${Math.round(o.raw / 1024)} KB -> ${Math.round(o.br / 1024)} KB brotli, ${o.skipped} left as they are, ${o.removed} orphans removed, ${Date.now() - t} ms`);
}
