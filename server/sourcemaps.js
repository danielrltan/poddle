// danielrltan.com's JavaScript source maps (NOTES 234), kept private here so the owner's stats panel can turn its minified flame graphs back
// into real function names and files. The site's build makes "hidden" maps, PUTs the ones this server lacks (scripts/upload-sourcemaps.mjs
// there, with the STATS_KEY bearer) and deletes them from what it publishes. Stored gzipped as files beside the database on the Fly volume
// (/data/sourcemaps; never in SQLite, never under web/), at most 200 MB: past that the least recently written go first. No visitor data.
const fs = require('node:fs'), path = require('node:path'), os = require('node:os'), zlib = require('node:zlib');

const NAME = /^[A-Za-z0-9_-]{1,100}\.js\.map$/, CAP = 200 << 20, RAW_MAX = 64 << 20;
let dir = null;

function init(env = process.env) {
  const db = String(env.PODDLE_DB || '');
  dir = env.SOURCEMAP_DIR || (db && db !== ':memory:' ? path.join(path.dirname(db), 'sourcemaps') : path.join(os.tmpdir(), 'poddle-sourcemaps'));
  try { fs.mkdirSync(dir, { recursive: true }); } catch { /* every call reports the failure */ }
}
const fileOf = name => path.join(dir, name + '.gz');
const okName = name => typeof name === 'string' && NAME.test(name);

function list() {
  if (!dir) init();
  try { return fs.readdirSync(dir).filter(f => f.endsWith('.map.gz')).map(f => f.slice(0, -3)).filter(okName).sort(); } catch { return []; }
}
// put(name, body: Buffer, gzipped or not) -> { status }. The body must be a version 3 source map
function put(name, body) {
  if (!dir) init();
  if (!okName(name)) return { status: 400 };
  let raw = body;
  if (raw.length > 1 && raw[0] === 0x1f && raw[1] === 0x8b) { try { raw = zlib.gunzipSync(raw, { maxOutputLength: RAW_MAX }); } catch { return { status: 413 }; } }
  let m; try { m = JSON.parse(raw.toString('utf8')); } catch { return { status: 400 }; }
  if (!m || m.version !== 3 || typeof m.mappings !== 'string' || !Array.isArray(m.sources)) return { status: 400 };
  const tmp = fileOf(name) + '.' + process.pid + '.tmp';
  try { fs.writeFileSync(tmp, zlib.gzipSync(raw)); fs.renameSync(tmp, fileOf(name)); } catch { try { fs.unlinkSync(tmp); } catch { /* not there */ } return { status: 507 }; }
  prune();
  return { status: 204 };
}
const get = name => { if (!dir) init(); if (!okName(name)) return null; try { return fs.readFileSync(fileOf(name)); } catch { return null; } };
function prune() {                                                   // oldest written first, until the folder is under CAP
  let files; try { files = fs.readdirSync(dir).filter(f => f.endsWith('.map.gz')).map(f => { const st = fs.statSync(path.join(dir, f)); return { f, size: st.size, t: st.mtimeMs }; }); } catch { return; }
  let total = files.reduce((a, x) => a + x.size, 0);
  for (const x of files.sort((a, b) => a.t - b.t)) { if (total <= CAP) break; try { fs.unlinkSync(path.join(dir, x.f)); total -= x.size; } catch { /* raced */ } }
}

module.exports = { init, list, put, get, NAME };
