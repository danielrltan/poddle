// SEO and the static handler: what a crawler, a link preview and a browser cache get from server/game.js. Plain HTTP, no browser.
// Pictures that are not rendered yet (og.jpg, the icons) and a help page that is not written yet are WAITING lines, not failures.
// Usage: node test/seo.test.mjs      SEO_PORT=<port> moves it (default 9025). STRICT=1 turns every WAITING into a FAIL (run it this way before a deploy).
import { spawn } from 'child_process'; import http from 'http'; import fs from 'fs'; import path from 'path';
const PORT = +process.env.SEO_PORT || 9025, STRICT = process.env.STRICT === '1', root = new URL('..', import.meta.url).pathname, WEB = path.join(root, 'web'), ORIGIN = 'https://poddleball.com';
const proc = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT }, stdio: ['ignore', 'ignore', 'inherit'] });
const wait = ms => new Promise(r => setTimeout(r, ms));
let fails = 0, waiting = 0;
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const pending = m => { if (STRICT) return ok(false, m); console.log('  WAIT ' + m); waiting++; };
const req = (p, { method = 'GET', headers = {} } = {}) => new Promise((res, rej) => { const r = http.request({ port: PORT, path: p, method, headers }, x => { const b = []; x.on('data', d => b.push(d)); x.on('end', () => res({ status: x.statusCode, h: x.headers, body: Buffer.concat(b) })); }); r.on('error', rej); r.end(); });
const has = f => fs.existsSync(path.join(WEB, f));
for (let i = 0; i < 40; i++) { try { await req('/robots.txt'); break; } catch { await wait(100); } }

try {
  console.log('status, type, cache');
  const NOCACHE = 'no-cache', WEEK = 'public, max-age=604800';
  for (const [p, type, cache, file] of [['/', 'text/html; charset=utf-8', NOCACHE, 'index.html'], ['/index.html', 'text/html; charset=utf-8', NOCACHE, 'index.html'], ['/robots.txt', 'text/plain; charset=utf-8', NOCACHE, 'robots.txt'],
    ['/sitemap.xml', 'application/xml; charset=utf-8', NOCACHE, 'sitemap.xml'], ['/site.webmanifest', 'application/manifest+json', NOCACHE, 'site.webmanifest'], ['/how-to-play.html', 'text/html; charset=utf-8', NOCACHE, 'how-to-play.html'],
    ['/og.jpg', 'image/jpeg', WEEK, 'og.jpg'], ['/og.jpg?v=6', 'image/jpeg', WEEK, 'og.jpg'], ['/favicon.ico', 'image/x-icon', WEEK, 'favicon.ico'], ['/favicon.svg', 'image/svg+xml; charset=utf-8', WEEK, 'favicon.svg'], ['/favicon-32.png', 'image/png', WEEK, 'favicon-32.png'],
    ['/apple-touch-icon.png', 'image/png', WEEK, 'apple-touch-icon.png'], ['/icon-192.png', 'image/png', WEEK, 'icon-192.png'], ['/icon-512.png', 'image/png', WEEK, 'icon-512.png'],
    ['/main.js', 'text/javascript; charset=utf-8', NOCACHE, 'main.js'], ['/ui.css', 'text/css; charset=utf-8', NOCACHE, 'ui.css'], ['/vendor/three.min.js', 'text/javascript; charset=utf-8', 'public, max-age=86400', 'vendor/three.min.js']]) {
    if (!has(file)) { pending(`${p}: web/${file} is not yet rendered`); continue; }
    const r = await req(p);
    ok(r.status === 200 && r.h['content-type'] === type && r.h['cache-control'] === cache && !!r.h.etag && !!r.h['last-modified'] && r.h['x-content-type-options'] === 'nosniff' && r.body.length === fs.statSync(path.join(WEB, file)).size,
      `${p}: ${r.status} ${r.h['content-type']} | ${r.h['cache-control']} | etag ${r.h.etag} | ${r.body.length} B`);
  }

  console.log('validators');
  { const a = await req('/main.js'), b = await req('/main.js', { headers: { 'If-None-Match': a.h.etag } }), c = await req('/main.js', { headers: { 'If-None-Match': '"nope"' } });
    const d = await req('/main.js', { headers: { 'If-Modified-Since': a.h['last-modified'] } }), e = await req('/main.js', { headers: { 'If-Modified-Since': 'Thu, 01 Jan 2015 00:00:00 GMT' } }), f = await req('/main.js', { method: 'HEAD' });
    ok(/^W\/"[0-9a-f]+-[0-9a-f]+"$/.test(a.h.etag), `the ETag is weak (the proxy compresses): ${a.h.etag}`);
    ok(b.status === 304 && b.body.length === 0 && b.h.etag === a.h.etag && b.h['cache-control'] === 'no-cache', `If-None-Match with the ETag: ${b.status}, ${b.body.length} B, keeps ETag and Cache-Control`);
    ok(c.status === 200 && c.body.length === a.body.length, `If-None-Match with another tag: ${c.status}`);
    ok(d.status === 304 && e.status === 200, `If-Modified-Since at the mtime: ${d.status}. In 2015: ${e.status}`);
    ok(f.status === 200 && f.body.length === 0 && +f.h['content-length'] === a.body.length, `HEAD /main.js: ${f.status}, no body, Content-Length ${f.h['content-length']}`); }

  console.log('misses, redirects, methods');
  { const page = has('404.html') ? fs.readFileSync(path.join(WEB, '404.html')) : null;
    for (const p of ['/nope', '/nope/', '/vendor/', '/404.html', '/how-to-play.htm']) { const r = await req(p);
      ok(r.status === 404 && r.h['content-type'] === 'text/html; charset=utf-8' && r.h['x-robots-tag'] === 'noindex' && r.h['cache-control'] === 'no-cache' && page && r.body.equals(page), `${p}: ${r.status} ${r.h['content-type']}, X-Robots-Tag ${r.h['x-robots-tag']}, the 404 page (${r.body.length} B)`); }
    const h = await req('/nope', { method: 'HEAD' }); ok(h.status === 404 && h.body.length === 0 && +h.h['content-length'] === page.length, `HEAD /nope: ${h.status}, no body`);
    const t = page.toString();
    ok(page.length < 2048 && /<meta name="robots" content="noindex">/.test(t) && /<title>Poddle: page not found<\/title>/.test(t) && (t.match(/<h1/g) || []).length === 1 && /href="\/"/.test(t) && /href="\/how-to-play\.html"/.test(t) && !/(href|src)="(?!\/|https:)/.test(t) && !/url\((?!\/)/.test(t),
      `404.html: ${page.length} B, noindex, one h1, links home and to How to play, no relative URL (it is served at any depth)`);
    for (const [p, to] of [['/how-to-play', '/how-to-play.html'], ['/how-to-play/', '/how-to-play.html'], ['/how-to-play?court=ABCD', '/how-to-play.html?court=ABCD']]) { const r = await req(p); ok(r.status === 301 && r.h.location === to && r.h['cache-control'] === 'no-cache', `${p}: ${r.status} -> ${r.h.location}`); }
    const bad = await req('/%00'), bad2 = await req('/a%00b.js'), up = await req('/../server/game.js'), esc = await req('/%E0%A4%A');
    ok(bad.status === 400 && bad2.status === 400, `/%00 and /a%00b.js: ${bad.status}, ${bad2.status}`);
    const oldHost = await req('/how-to-play.html?x=1', { headers: { host: 'poddle.fly.dev' } }), www = await req('/', { headers: { host: 'www.poddleball.com' } }), own = await req('/', { headers: { host: 'poddleball.com' } });
    ok(oldHost.status === 301 && oldHost.h.location === 'https://poddleball.com/how-to-play.html?x=1' && www.status === 301 && www.h.location === 'https://poddleball.com/' && own.status === 200, `old names forward to the one name, path and query kept (${oldHost.status} ${oldHost.h.location}; ${www.status}; own host ${own.status})`);
    ok(up.status === 404 && !up.body.includes('WebSocketServer'), `/../server/game.js: ${up.status}, not the server's source`);
    ok([200, 404].includes(esc.status), `a bad escape: ${esc.status}`);
    for (const m of ['POST', 'PUT', 'DELETE']) { const r = await req('/', { method: m }); ok(r.status === 405 && r.h.allow === 'GET, HEAD' && r.body.length === 0, `${m} /: ${r.status}, Allow: ${r.h.allow}`); }
    const again = await req('/'); ok(again.status === 200, 'and the server is still up'); }

  console.log('home page head');
  const home = (await req('/')).body.toString(), attr = (tag, k, v, want = 'content') => { const m = [...home.matchAll(new RegExp(`<${tag}\\b[^>]*\\b${k}="${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"[^>]*>`, 'g'))]; return m.map(x => (x[0].match(new RegExp(`\\b${want}="([^"]*)"`)) || [])[1]); };
  const one = (tag, k, v, want) => { const a = attr(tag, k, v, want); return a.length === 1 ? a[0] : null; };
  { const titles = [...home.matchAll(/<title>([^<]*)<\/title>/g)].map(m => m[1]); ok(titles.length === 1 && titles[0].length >= 10 && titles[0].length <= 60 && /Poddle/.test(titles[0]) && /phone/i.test(titles[0]) && !/AirPod/.test(titles[0]), `one <title>, ${titles[0] && titles[0].length} chars: ${titles[0]}`);
    const d = one('meta', 'name', 'description'); ok(d && d.length >= 70 && d.length <= 160 && /phone/.test(d) && /any computer/i.test(d) && /friends/.test(d), `one meta description, ${d && d.length} chars (70 to 160), says phone, any computer and friends`);
    ok(one('link', 'rel', 'canonical', 'href') === ORIGIN + '/', `one canonical: ${attr('link', 'rel', 'canonical', 'href')}`);
    const robots = one('meta', 'name', 'robots'); ok(robots && /\bindex\b/.test(robots) && !/noindex/.test(robots), `meta robots: ${robots}`);
    ok(!home.includes('data:,'), 'the empty data: favicon is gone');
    ok(/<html lang="en">/.test(home) && /<meta charset="utf-8">/.test(home) && one('meta', 'name', 'viewport') != null && /^#[0-9a-f]{6}$/.test(one('meta', 'name', 'theme-color') || ''), 'lang, charset, viewport, theme-color');
    const og = {}; for (const k of ['og:type', 'og:site_name', 'og:title', 'og:description', 'og:url', 'og:locale', 'og:image', 'og:image:secure_url', 'og:image:type', 'og:image:width', 'og:image:height', 'og:image:alt']) og[k] = one('meta', 'property', k);
    const tw = {}; for (const k of ['twitter:card', 'twitter:title', 'twitter:description', 'twitter:image', 'twitter:image:alt']) tw[k] = one('meta', 'name', k);
    const missing = [...Object.entries(og), ...Object.entries(tw)].filter(([, v]) => !v).map(([k]) => k); ok(!missing.length, `the Open Graph and Twitter set, each tag once${missing.length ? ': missing or doubled ' + missing : ''}`);
    ok(og['og:type'] === 'website' && og['og:url'] === ORIGIN + '/' && tw['twitter:card'] === 'summary_large_image', `og:type ${og['og:type']}, og:url ${og['og:url']}, twitter:card ${tw['twitter:card']}`);
    const img = /^https:\/\/poddleball\.com\/og\.jpg\?v=\d+$/; ok(img.test(og['og:image']) && og['og:image:secure_url'] === og['og:image'] && tw['twitter:image'] === og['og:image'], `share image is one absolute https URL with ?v=: ${og['og:image']}`);
    ok(og['og:image:width'] === '1200' && og['og:image:height'] === '630' && og['og:image:type'] === 'image/jpeg', 'og:image is declared 1200x630 image/jpeg');
    ok((og['og:title'] || '').length <= 60 && (og['og:description'] || '').length <= 110 && og['og:title'] === tw['twitter:title'] && og['og:description'] === tw['twitter:description'], `og:title ${(og['og:title'] || '').length} chars, og:description ${(og['og:description'] || '').length} chars, Twitter says the same`);
    ok(/phone/.test(og['og:description'] || '') && !/AirPod/.test(og['og:title'] || '') && /friends/.test(og['og:description'] || '') && og['og:title'] !== 'Poddle: your AirPod is the paddle', 'the card says phone, AirPod and friends, and its title does not repeat the line in the picture');
    ok(/with your phone/.test(og['og:image:alt'] || ''), 'the image alt quotes the card\'s line about the phone');
    ok((og['og:image:alt'] || '').length >= 20 && og['og:image:alt'].length <= 200 && og['og:image:alt'] === tw['twitter:image:alt'] && !/PENDING/.test(og['og:image:alt']), `image alt, ${(og['og:image:alt'] || '').length} chars: ${og['og:image:alt']}`);
    ok(!/twitter:site|twitter:creator/.test(home), 'no invented Twitter handle');
    const at = h => h == null ? null : new URL(h, ORIGIN + '/').pathname;      // relative on purpose, like ui.css and main.js: test/ui-next.mjs serves this page from /web/, and the live page is only ever at /
    ok(at(one('link', 'rel', 'manifest', 'href')) === '/site.webmanifest' && at(one('link', 'rel', 'apple-touch-icon', 'href')) === '/apple-touch-icon.png' && attr('link', 'rel', 'icon', 'href').map(at).join() === '/favicon.svg,/favicon-32.png', `icons and manifest resolve to the site root: ${attr('link', 'rel', 'icon', 'href').map(at)}`);
    const readable = [titles[0], d, ...Object.values(og), ...Object.values(tw)].join(' ').replaceAll('Play pickleball with your phone or AirPod!', ''); /* the share card's line is the owner's own wording, quoted in the alt text */ ok(!/[–—…!]|\b(simply|just|please|seamless|room)\b/i.test(readable), 'voice: no long dash, ellipsis, exclamation mark, filler or "room" in the head copy'); }

  console.log('structured data');
  { const blocks = [...home.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map(m => m[1]); let parsed = []; try { parsed = blocks.map(b => JSON.parse(b)); } catch (e) { ok(false, 'JSON-LD does not parse: ' + e.message); }
    ok(blocks.length === 1 && parsed.length === 1, `${blocks.length} JSON-LD block, parses`); const g = parsed[0] || {};
    ok(g['@context'] === 'https://schema.org' && [].concat(g['@type']).includes('VideoGame') && g.name === 'Poddle' && g.url === ORIGIN + '/' && typeof g.description === 'string' && g.description.length > 40 && g.image === ORIGIN + '/og.jpg', `@type ${g['@type']}, name, url, description, image`);
    ok(g.operatingSystem === 'Any, in a modern browser' && g.applicationCategory === 'GameApplication' && g.isAccessibleForFree === true && g.offers && g.offers.price === '0' && g.offers.priceCurrency === 'USD', 'operatingSystem, applicationCategory, free offer');
    ok(g.softwareHelp && g.softwareHelp.url === ORIGIN + '/how-to-play.html' && !g.aggregateRating && !g.review && !g.author, 'softwareHelp points at the help page. No rating, review or author is claimed');
    const urls = JSON.stringify(g).match(/"https?:[^"]+"/g) || []; ok(urls.every(u => /^"https:\/\/(poddleball\.com|schema\.org)/.test(u)), `every URL in it is https on poddleball.com or schema.org (${urls.length})`); }

  console.log('text a crawler reads without JavaScript');
  { const ns = [...home.matchAll(/<noscript>([\s\S]*?)<\/noscript>/g)].map(m => m[1]), text = (ns[0] || '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
    ok(ns.length === 1 && home.indexOf('<noscript>') > home.indexOf('<div id="stage">') && home.indexOf('<noscript>') < home.indexOf('<!-- UI:BEGIN -->'), 'one <noscript>, in the body, outside the markup the mock loads');
    ok(text.length > 120 && /Poddle/.test(text) && /AirPod/.test(text) && /JavaScript/.test(text) && /phone is the paddle/.test(text) && /href="\/how-to-play\.html"/.test(ns[0]), `it holds real words (${text.length} chars) and the How to play link`);
    const body = home.replace(/<noscript>[\s\S]*?<\/noscript>/g, ''), h1 = [...body.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map(m => m[1].replace(/<[^>]+>/g, '').trim());
    const title = (body.match(/<section[^>]*id="screen-title"[\s\S]*?<\/section>/) || [''])[0], th1 = [...title.matchAll(/<h1\b[^>]*>([\s\S]*?)<\/h1>/g)].map(m => m[1].replace(/<[^>]+>/g, ''));
    ok(th1.length === 1 && th1[0] === 'Poddle' && h1.length === 1, `one <h1> outside noscript, on the title screen, and its text is "${th1[0]}"${h1.length > 1 ? ' (others: ' + h1.slice(1).join(', ') + ')' : ''}`);
    ok(/Phone pickleball/.test(title) && /nothing to install/i.test(title) && (title.match(/<a\b[^>]*href="\/how-to-play\.html"[^>]*>How to play<\/a>/g) || []).length === 1, 'the title screen says Phone pickleball, what you need, and links How to play');
    ok(!/First to 11/.test(title), 'the title screen does not say First to 11'); }

  console.log('robots.txt, sitemap.xml');
  { const robots = (await req('/robots.txt')).body.toString(), lines = robots.split('\n').map(l => l.trim()).filter(Boolean);
    ok(lines.includes('User-agent: *') && lines.includes(`Sitemap: ${ORIGIN}/sitemap.xml`) && !lines.some(l => /^Disallow:\s*\S/.test(l)), `robots.txt allows everything and names the sitemap: ${lines.join(' / ')}`);
    const xml = (await req('/sitemap.xml')).body.toString(), locs = [...xml.matchAll(/<loc>([^<]*)<\/loc>/g)].map(m => m[1]), mods = [...xml.matchAll(/<lastmod>([^<]*)<\/lastmod>/g)].map(m => m[1]);
    const opens = (xml.match(/<(?![?\/!])[^>]*[^\/]>/g) || []).length, closes = (xml.match(/<\/[^>]+>/g) || []).length;
    ok(xml.startsWith('<?xml version="1.0" encoding="UTF-8"?>') && /<urlset xmlns="http:\/\/www\.sitemaps\.org\/schemas\/sitemap\/0\.9">/.test(xml) && xml.trim().endsWith('</urlset>') && opens === closes && !/&(?!amp;|lt;|gt;|quot;|apos;)/.test(xml), `sitemap.xml is well formed (${opens} tags open, ${closes} close)`);
    ok(locs.join() === `${ORIGIN}/,${ORIGIN}/how-to-play.html`, `it lists ${locs.join(' and ')}`);
    ok(mods.length === locs.length && mods.every(d => /^\d{4}-\d{2}-\d{2}$/.test(d) && !isNaN(Date.parse(d)) && Date.parse(d) <= Date.now() + 864e5), `lastmod is a W3C date, not in the future: ${mods}`);
    for (const l of locs) { const p = new URL(l).pathname, r = await req(p); ok(r.status === 200 && /text\/html/.test(r.h['content-type']), `${p} from the sitemap: ${r.status}`);
      if (r.status === 200) { const c = [...r.body.toString().matchAll(/<link rel="canonical" href="([^"]*)"/g)].map(m => m[1]); ok(c.length === 1 && c[0] === l, `its canonical is itself: ${c}`); } } }

  console.log('court links');
  for (const p of ['/?court=ABCD', '/?room=ABCD&watch=1', '/?host=192.168.1.5']) { const r = await req(p); ok(r.status === 200 && r.body.toString() === home && !r.h['x-robots-tag'], `${p}: the same page, canonical to /, no X-Robots-Tag`); }

  console.log('manifest and icons');
  const pngSize = f => { const b = fs.readFileSync(f); return b.length > 24 && b.readUInt32BE(0) === 0x89504e47 && b.toString('latin1', 12, 16) === 'IHDR' ? { w: b.readUInt32BE(16), h: b.readUInt32BE(20), alpha: [4, 6].includes(b[25]), bytes: b.length } : null; };
  { let m = null; try { m = JSON.parse((await req('/site.webmanifest')).body.toString()); } catch (e) { ok(false, 'site.webmanifest does not parse: ' + e.message); }
    if (m) { ok(m.name && m.short_name === 'Poddle' && m.start_url === '/' && m.display === 'standalone' && /^#[0-9a-f]{6}$/.test(m.theme_color) && /^#[0-9a-f]{6}$/.test(m.background_color) && Array.isArray(m.icons) && m.icons.length >= 2, `manifest: "${m.name}", ${m.icons.length} icons`);
      ok(m.icons.some(i => i.sizes === '192x192') && m.icons.some(i => i.sizes === '512x512') && m.icons.some(i => i.purpose === 'maskable'), 'a 192, a 512 and a maskable icon');
      for (const i of m.icons) { const f = path.join(WEB, new URL(i.src, ORIGIN + '/site.webmanifest').pathname); if (!fs.existsSync(f)) { pending(`manifest icon ${i.src} (${i.purpose}) is not yet rendered`); continue; } const s = pngSize(f); ok(i.type === 'image/png' && s && `${s.w}x${s.h}` === i.sizes, `manifest icon ${i.src} (${i.purpose}): the PNG is ${s ? s.w + 'x' + s.h : 'not a PNG'}, the manifest says ${i.sizes}`); } }
    for (const [f, n] of [['favicon-32.png', 32], ['apple-touch-icon.png', 180], ['icon-192.png', 192], ['icon-512.png', 512]]) { if (!has(f)) { pending(`${f} is not yet rendered`); continue; } const s = pngSize(path.join(WEB, f));
      const cap = n > 192 ? 100 : 30;
      ok(s && s.w === n && s.h === n && s.bytes < cap * 1024, `${f}: ${s ? `${s.w}x${s.h}, ${s.bytes} B` : 'not a PNG'} (want ${n}x${n}, under ${cap} KB)`); }
    if (!has('favicon.svg')) pending('favicon.svg is not yet rendered'); else { const s = fs.readFileSync(path.join(WEB, 'favicon.svg'), 'utf8'); ok(/<svg[^>]*viewBox="0 0 (\d+(\.\d+)?) \1"/.test(s) && !/<text|<image|href=|@font-face|<script/.test(s), 'favicon.svg: a square viewBox, no text, no outside files, no script'); } }

  console.log('share image');
  if (!has('og.jpg')) pending('og.jpg is not yet rendered'); else { const b = fs.readFileSync(path.join(WEB, 'og.jpg')); let w = 0, h = 0, prog = false;
    if (b[0] === 0xff && b[1] === 0xd8) for (let i = 2; i + 9 < b.length;) { if (b[i] !== 0xff) { i++; continue; } const k = b[i + 1]; if (k === 0xff) { i++; continue; } if (k === 0xd8 || k === 0x01 || (k >= 0xd0 && k <= 0xd7)) { i += 2; continue; }
      if (k >= 0xc0 && k <= 0xcf && k !== 0xc4 && k !== 0xc8 && k !== 0xcc) { h = b.readUInt16BE(i + 5); w = b.readUInt16BE(i + 7); prog = k === 0xc2; break; } i += 2 + b.readUInt16BE(i + 2); }
    ok(w === 1200 && h === 630, `og.jpg is a JPEG of ${w}x${h}${prog ? ', progressive' : ''} (want 1200x630)`); ok(b.length < 500 * 1024, `og.jpg is ${(b.length / 1024).toFixed(0)} KB (under 500 KB)`); }

  console.log('downloads');
  if (!has('download/Poddle-Helper.zip')) pending('/download/Poddle-Helper.zip: web/download/Poddle-Helper.zip is not yet built'); else { const r = await req('/download/Poddle-Helper.zip', { method: 'HEAD' });
    ok(r.status === 200 && r.h['content-type'] === 'application/zip' && r.h['content-disposition'] === 'attachment; filename="Poddle-Helper.zip"' && r.h['cache-control'] === 'no-cache', `/download/Poddle-Helper.zip: ${r.status} ${r.h['content-type']} | ${r.h['content-disposition']} | ${r.h['cache-control']}`); }

  console.log('help page');
  if (!has('how-to-play.html')) pending('how-to-play.html is not yet written'); else { const t = (await req('/how-to-play.html')).body.toString();
    ok((t.match(/<title>/g) || []).length === 1 && (t.match(/<h1\b/g) || []).length === 1 && /<link rel="canonical" href="https:\/\/poddleball\.com\/how-to-play\.html">/.test(t) && /href="\/"/.test(t), 'one title, one h1, its own canonical, a link home');
    let bad = null; for (const m of t.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)) try { JSON.parse(m[1]); } catch (e) { bad = e.message; } ok(!bad, 'its JSON-LD parses' + (bad ? ': ' + bad : ''));
    for (const m of new Set([...t.matchAll(/(?:href|src)="(\/[^"#?]*)/g)].map(m => m[1]))) { if (m === '/') continue; const r = await req(m, { method: 'HEAD' }); if (r.status === 200) ok(true, `it links ${m}: ${r.status}`); else if (/\.(png|jpg|svg)$/.test(m)) pending(`it links ${m}, which is not yet rendered`); else if (m.startsWith('/download/')) pending(`it links ${m}, which is not yet built (Poddle Helper, NOTES 36)`); else ok(false, `it links ${m}: ${r.status}`); } }
} catch (e) { ok(false, 'the test threw: ' + (e && e.stack || e)); }
finally { proc.kill(); }
console.log(fails ? `\nSEO FAIL (${fails})` : waiting ? `\nSEO PASS, ${waiting} WAITING for files another owner is still rendering (STRICT=1 makes those failures)` : '\nSEO PASS');
process.exit(fails ? 1 : 0);
