// Versioned URLs without a build step. Every page served from web/ is rewritten as it goes out: its own <script src> and <link href> to a
// .js/.mjs/.css under web/ get ?v=<first 10 hex of the file's sha1>, and an import map sends every module its module entries reach (static
// import, side-effect import, import() with a literal './', '../' or '/' specifier) to its ?v= URL too, so no module source changes.
// server/game.js caches a ?v= that is the file's current hash for a year (immutable): a repeat visit revalidates the page alone instead of
// every JS/CSS file it names (21 of 22 304s on a warm load before). Anything else (no ?v=, an old hash after a deploy, a browser without import maps) is the old no-cache response.
//   const v = require('./versioned')(webDir);  v.page(file, st) -> null (nothing to version: serve the file) or
//     { body, etag, mtime, br: Promise<Buffer|null> }        v.hashOf(file, st) -> '0123456789' or null
// One snapshot per build: the entry src's, the modulepreload hrefs and the map's values come from the same hashes (a /ui.js?v=A beside a
// /ui.js?v=B would be two instances of the module). A build is reused while every input (the page and each file it names or its modules
// reach, a missing one too) keeps its size and mtime: a page view costs those stats, never a read or a hash.
const fs = require('fs'), path = require('path'), crypto = require('crypto'), zlib = require('zlib');
const VER_EXT = new Set(['.js', '.mjs', '.css']);                // what gets a ?v=: the files a page loads that change with a deploy
const MOD_EXT = new Set(['.js', '.mjs']);
const SPEC = /(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s+)(['"])((?:\.{1,2})?\/[^'"\s]+)\1/g;   // import x from './a.js', import './a.js', import('./a.js'): a literal path only
const TAG = /<(?:script|link)\b[^>]*>/gi, REF = /(\s(?:src|href)=")([^"?#:]+\.(?:m?js|css))"/i;   // a quoted local path ('https:' has a colon): the inline CDN fallback's string is left alone
const stKey = st => st.size + '-' + st.mtimeMs;

module.exports = function versioned(WEB) {
  const files = new Map(), pages = new Map();                    // file -> { key, mtime, h, specs } / page file -> its last build
  const inWeb = f => (f.startsWith(WEB + path.sep) ? f : null);
  const urlOf = f => '/' + path.relative(WEB, f).split(path.sep).join('/');
  function info(file, st) {                                       // hash (and a module's specifiers) by size and mtime; null: missing or not a file
    try { st = st || fs.statSync(file); } catch { return null; }
    if (!st.isFile()) return null;
    let c = files.get(file);
    if (!c || c.key !== stKey(st)) {
      let src; try { src = fs.readFileSync(file); } catch { return null; }
      c = { key: stKey(st), mtime: st.mtimeMs, h: crypto.createHash('sha1').update(src).digest('hex').slice(0, 10), specs: MOD_EXT.has(path.extname(file).toLowerCase()) ? [...src.toString('utf8').matchAll(SPEC)].map(m => m[2]) : [] };
      files.set(file, c);
    }
    return c;
  }
  function build(file, st) {
    const html = fs.readFileSync(file, 'utf8');
    const deps = new Map([[file, stKey(st)]]); let mtime = st.mtimeMs;
    const ver = f => { const c = info(f); deps.set(f, c ? c.key : null); if (c) mtime = Math.max(mtime, c.mtime); return c; };
    if (/<script\b[^>]*\stype="importmap"/i.test(html)) return { deps, page: null };   // a page with its own map: browsers before 2023 take only one, leave it as it is
    const dir = path.dirname(file), entries = [];
    let out = html.replace(TAG, tag => tag.replace(REF, (all, pre, ref) => {
      const f = inWeb(path.normalize(ref.startsWith('/') ? path.join(WEB, ref) : path.join(dir, ref))), c = f && VER_EXT.has(path.extname(f).toLowerCase()) && ver(f);
      if (!c) return all;
      if (/\stype="module"/i.test(tag) || /\srel="modulepreload"/i.test(tag)) entries.push(f);
      return `${pre}${ref}?v=${c.h}"`;
    }));
    const map = {}, walk = f => {                                 // every module the entries reach, each once
      if (map[urlOf(f)]) return; const c = ver(f); if (!c) return;
      map[urlOf(f)] = urlOf(f) + '?v=' + c.h;
      for (const s of c.specs) { const g = inWeb(path.normalize(s.startsWith('/') ? path.join(WEB, s) : path.join(path.dirname(f), s))); if (g && MOD_EXT.has(path.extname(g).toLowerCase())) walk(g); }
    };
    entries.forEach(walk);
    if (Object.keys(map).length) {                                // before the first module load: a map that comes after one is ignored
      const at = out.search(/<(?:script\b[^>]*\stype="module"|link\b[^>]*\srel="modulepreload")/i);
      out = out.slice(0, at) + `<script type="importmap">${JSON.stringify({ imports: map })}</script>\n` + out.slice(at);
    }
    if (out === html) return { deps, page: null };
    const body = Buffer.from(out), page = { body, etag: `W/"${body.length.toString(16)}-${crypto.createHash('sha1').update(body).digest('hex').slice(0, 12)}"`, mtime: Math.floor(mtime / 1000) * 1000 };
    page.br = new Promise(r => zlib.brotliCompress(body, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 11, [zlib.constants.BROTLI_PARAM_MODE]: zlib.constants.BROTLI_MODE_TEXT, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: body.length } },
      (e, b) => r(e ? null : b)));                                // q11 like server/precompress.js, once per build, on libuv's pool (not the game's thread); web/<page>.br is the unrewritten file
    return { deps, page };
  }
  function page(file, st) {
    const b = pages.get(file);
    if (b && [...b.deps].every(([f, k]) => { let s; try { s = fs.statSync(f); } catch { return k === null; } return k === (s.isFile() ? stKey(s) : null); })) return b.page;
    const nb = build(file, st); pages.set(file, nb); return nb.page;
  }
  return { page, hashOf: (file, st) => (VER_EXT.has(path.extname(file).toLowerCase()) ? (info(file, st) || {}).h || null : null), VER_EXT };
};
