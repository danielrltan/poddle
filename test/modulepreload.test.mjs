// index.html's <link rel="modulepreload"> list must be exactly the static module graph the home page loads, minus its entry scripts, so
// a new import cannot silently bring the request waterfall back (emblems.js was found only after ui.js arrived and parsed: a third serial
// round trip that gated evaluation on every live desktop load) and a removed or lazy module is not downloaded for nothing.
//   node test/modulepreload.test.mjs          check (exit 1, naming what is wrong and printing the right list)
//   node test/modulepreload.test.mjs --print  print the <link> lines to paste
//   MODULEPRELOAD_WEB=dir                      check another copy of web/ (how the failure cases were tried)
// The graph is read by V8's own module parser (vm.SourceTextModule.moduleRequests: exactly the static import / export-from specifiers the
// browser will fetch, no regex guessing about comments, strings or multi-line imports), starting from index.html's <script type="module">
// entries (main.js, cursor.js). Dynamic import()s are NOT in it and must not be preloaded: scenery/index.js and its five children (scene.js
// fetches them after the first frame; a probe of HTML preloads for them delayed main.js ~60 ms over HTTP/1.1), vendor/qrcode.mjs, vendor/mp/
// vision_bundle.js. motion.js is both (static from main.js, dynamic from scene.js): static wins, it is preloaded.
import fs from 'node:fs'; import vm from 'node:vm'; import { spawnSync } from 'node:child_process'; import { fileURLToPath } from 'node:url';

if (!vm.SourceTextModule) {      // the parser sits behind a flag; deploy.sh runs plain `node test/x.mjs`, so re-run this file with it
  const r = spawnSync(process.execPath, ['--experimental-vm-modules', '--no-warnings', fileURLToPath(import.meta.url), ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status ?? 1);
}

const WEB = (process.env.MODULEPRELOAD_WEB || fileURLToPath(new URL('../web/', import.meta.url))).replace(/\/?$/, '/');
const ORIGIN = 'http://poddle.test/', rel = u => new URL(u, ORIGIN).pathname.slice(1);      // URL -> web/-relative path, resolved the way the page resolves it from '/' (and from the one-segment MENU_PATHS aliases)
const html = fs.readFileSync(WEB + 'index.html', 'utf8').replace(/<!--[\s\S]*?-->/g, '');      // a commented-out tag is not a tag
const attrs = tag => Object.fromEntries([...tag.matchAll(/([\w-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)].slice(1).map(m => [m[1].toLowerCase(), m[2] ?? m[3] ?? m[4] ?? '']));
const scripts = [...html.matchAll(/<script\b[^>]*>/gi)].map(m => attrs(m[0])), links = [...html.matchAll(/<link\b[^>]*>/gi)].map(m => attrs(m[0]));
const entries = scripts.filter(a => a.type === 'module' && a.src).map(a => rel(a.src));
const have = links.filter(a => a.rel?.toLowerCase().split(/\s+/).includes('modulepreload')).map(a => rel(a.href));
const fail = msg => { console.log(msg); console.log('MODULEPRELOAD FAIL'); process.exit(1); };
if (!entries.length) fail('index.html has no <script type="module" src=...>: nothing to check against');

const parsed = new Map();      // path -> { stat: [paths], dyn: [paths] }
const parse = p => {
  if (parsed.has(p)) return parsed.get(p);
  const src = fs.readFileSync(WEB + p, 'utf8'), base = ORIGIN + p;
  const m = new vm.SourceTextModule(src, { identifier: p });      // parse only: nothing is linked or evaluated
  const specs = m.moduleRequests ? m.moduleRequests.map(r => r.specifier) : m.dependencySpecifiers;
  const dyn = [...src.matchAll(/\bimport\(\s*(['"])([^'"]+)\1\s*\)/g)].map(d => rel(new URL(d[2], base).href));      // string-literal import()s, only to say WHY a listed module is wrong
  const r = { stat: specs.map(s => rel(new URL(s, base).href)), dyn }; parsed.set(p, r); return r;
};
const eager = new Set(), q = [...entries];
while (q.length) { const p = q.shift(); if (eager.has(p)) continue; if (!fs.existsSync(WEB + p)) fail(`${p} is imported but web/${p} does not exist`); eager.add(p); q.push(...parse(p).stat); }
const dynOnly = new Set(); for (const p of eager) for (const d of parse(p).dyn) if (!eager.has(d)) dynOnly.add(d);
const want = [...eager].filter(p => !entries.includes(p));      // the entries are fetched by their own <script> tags, found by the same preload scanner pass

const line = p => `<link rel="modulepreload" href="${p}">`;
if (process.argv.includes('--print')) { console.log(want.map(line).join('\n')); process.exit(0); }
const problems = [];
for (const p of want) if (!have.includes(p)) problems.push(`missing:  ${p} (statically imported, so the browser finds it only after its importer arrives and parses)`);
for (const p of have) {
  if (want.includes(p)) continue;
  if (!fs.existsSync(WEB + p)) problems.push(`gone:     ${p} (listed, but web/${p} does not exist: a 404 on every load)`);
  else if (entries.includes(p)) problems.push(`entry:    ${p} (already a <script type="module">)`);
  else if (dynOnly.has(p) || p.startsWith('scenery/')) problems.push(`dynamic:  ${p} (only reached through import(): preloading it competes with the critical path for a file the first frame does not need)`);
  else problems.push(`unused:   ${p} (not in the static graph of ${entries.join(', ')})`);
}
for (const p of new Set(have)) if (have.filter(h => h === p).length > 1) problems.push(`twice:    ${p}`);
for (const a of links) if (a.rel?.toLowerCase().split(/\s+/).includes('modulepreload') && 'crossorigin' in a) problems.push(`crossorigin on ${rel(a.href)}: the module script requests are same-origin without it, so this preload would not be reused (double download)`);
if (problems.length) fail('index.html modulepreload list is wrong:\n  ' + problems.join('\n  ') + '\nThe list should be (any order):\n' + want.map(line).join('\n'));
console.log(`modulepreload: ${have.length} links = the static graph of ${entries.join(' + ')} (${eager.size} modules); dynamic-only, not preloaded: ${[...dynOnly].join(', ') || '-'}`);
console.log('MODULEPRELOAD PASS');
