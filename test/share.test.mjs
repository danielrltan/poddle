// Share links end to end (docs/SHARE.md 2): POST/DELETE /api/share, the public page /c/<slug> and its PNG card, one link per owner, a new
// slug after Stop sharing, 404s that never render, the hash following the stats, merge / export / delete, the render budget, and the
// og.jpg fallback when @resvg/resvg-js cannot load (test/no-resvg.cjs preloaded into that server only). No match is played: the profiles
// are written into the database file through server/db.js by this process, which the servers read at request time.
//   node test/share.test.mjs        SHARE_PORT=<base> moves the servers (base .. +3; default 9850-9853). Takes a few seconds.
// Saves the served card to test/ui-shots/share/served.png and the page at 1280x800 / 390x844 (share-page-*.png) when Chrome is there.
import { spawn } from 'child_process';
import { createRequire } from 'module';
import http from 'http';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
const require = createRequire(import.meta.url);
const root = new URL('..', import.meta.url).pathname, SHOTS = path.join(root, 'test/ui-shots/share');
const PORT = +process.env.SHARE_PORT || 9850, P_NORES = PORT + 1, P_HOST = PORT + 2, P_BUSY = PORT + 3;
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'poddle-share-')), DBF = path.join(tmp, 's.db');
const db = require('../server/db.js'), auth = require('../server/auth.js'), names = require('../server/usernames.js'), card = require('../server/card.js');
const { DatabaseSync } = require('node:sqlite');
const procs = new Set(), logs = [];
function up(port, env) {
  return new Promise(res => { const p = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, NODE_ENV: '', FLY_APP_NAME: '', GOOGLE_CLIENT_ID: '', GOOGLE_JWKS_FILE: '', NODE_OPTIONS: '', PORT: port, PODDLE_DB: DBF, COOKIE_SECURE: '1', ...env } }); procs.add(p);
    const mine = { port, out: '' }; logs.push(mine); const eat = d => { mine.out += d; if (/game server on port/.test(d)) res(p); }; p.stdout.on('data', eat); p.stderr.on('data', eat); p.on('exit', () => procs.delete(p)); });
}
process.on('exit', () => { for (const p of procs) p.kill(); try { db.close(); } catch { /* closed */ } fs.rmSync(tmp, { recursive: true, force: true }); });
process.on('unhandledRejection', e => { console.error(e); process.exit(1); });
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
let ipn = 0; const ip = () => `198.51.100.${++ipn}`;              // TEST-NET-2: a fresh computer (and fresh rate-limit buckets) per request unless one is given
function req(port, method, p, body, { addr = ip(), origin = `http://localhost:${port}`, cookie, headers: extra = {} } = {}) {
  return new Promise(res => {
    const data = body === undefined ? null : JSON.stringify(body), headers = { ...extra };
    if (data != null) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    if (origin && method !== 'GET' && method !== 'HEAD') headers.origin = origin; if (addr) headers['fly-client-ip'] = addr; if (cookie) headers.cookie = cookie;
    const rq = http.request({ host: '127.0.0.1', port, method, path: p, headers }, r => { const parts = []; r.on('data', d => parts.push(d));
      r.on('end', () => { const buf = Buffer.concat(parts); let j = null; try { j = JSON.parse(buf.toString('utf8')); } catch { /* not json */ } res({ status: r.statusCode, headers: r.headers, buf, body: buf.toString('utf8'), json: j }); }); });
    rq.on('error', e => res({ status: 0, error: e.code, headers: {}, buf: Buffer.alloc(0), body: '' })); if (data != null) rq.write(data); rq.end();
  });
}
const isPng = b => b.length > 24 && b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) && b.subarray(12, 16).toString('latin1') === 'IHDR';
const dims = b => [b.readUInt32BE(16), b.readUInt32BE(20)];
const meta = (html, k) => { const m = new RegExp(`<meta (?:property|name)="${k.replace(/[.:]/g, '\\$&')}" content="([^"]*)"`).exec(html); return m ? m[1].replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"') : null; };
const slugOf = url => (/\/c\/([A-Za-z0-9]{10})$/.exec(url || '') || [])[1];

// ---- the database: an account with a username and a session, a guest, stats for both ----
const now = Date.now(), SES = '__Host-poddle_s';
ok(db.open(DBF, { busyMs: 2000 }), 'the test opens the database file');
const A = db.createAccount('share-sub-a', now), v = names.validate('Share_Ace'); db.claimUsername(A.id, v.name, v.key, now);
const cookieA = `${SES}=${db.session.create(A.id, now)}`;
const B = db.createAccount('share-sub-b', now), cookieB = `${SES}=${db.session.create(B.id, now)}`;   // B: no username, no matches
const G = crypto.randomUUID(), gOwner = db.ownerForDevice(auth.deviceHash(G), now, { create: true });
const G2 = crypto.randomUUID(), g2Owner = db.ownerForDevice(auth.deviceHash(G2), now, { create: true });
let rally = 10;
const win = (owner, extra = {}) => db.recordMatch({ now: Date.now(), kind: 'bot', level: 0, winner: 0, ending: 'won', score: [11, 4], secs: 300, ranked: true, flags: [],
  seats: [{ owner, record: true, bests: true, bestRally: rally++, bestHit: 40, bestSpeed: 20, ...extra }, null] });
ok(!!win(A.owner_id) && !!win(gOwner) && !!win(g2Owner), 'three profiles have a match on record');
const raw = new DatabaseSync(DBF); raw.exec('PRAGMA busy_timeout=2000');
raw.prepare('UPDATE profile SET hits = 140, returns = 120, chances = 150, winners = 30, aces = 12, smashes = 9 WHERE owner_id = ?').run(A.owner_id);   // part A's counters, by hand

console.log('servers: ' + PORT + ' (SHARE_RENDERS 2), ' + P_NORES + ' (no resvg), ' + P_HOST + ' (hosted), ' + P_BUSY + ' (SHARE_RENDERS 24)');
await Promise.all([up(PORT, { SHARE_RENDERS: '2' }), up(P_NORES, { NODE_OPTIONS: `--require ${root}test/no-resvg.cjs` }), up(P_HOST, { FLY_APP_NAME: 'poddle-test' }), up(P_BUSY, { SHARE_RENDERS: '24' })]);

// ---- create / get: one link per owner ----
const a1 = await req(PORT, 'POST', '/api/share', {}, { cookie: cookieA });
const url = a1.json && a1.json.url, slug = slugOf(url);
ok(a1.status === 200 && !!slug && url === `http://127.0.0.1:${PORT}/c/${slug}` && a1.json.image === `${url}.png?v=${card.hashOf(card.dataOf(db.profileOf(A.owner_id), 'Share_Ace'))}`,
  'POST /api/share (session): 200 { url, image }, a 10-char slug on this host, image = url.png?v=<hash of the card>');
ok(/^[0-9a-f]{12}$/.test(a1.json.image.split('?v=')[1]), 'the hash is 12 hex chars');
const a2 = await req(PORT, 'POST', '/api/share', { dev: G }, { cookie: cookieA });
ok(a2.status === 200 && a2.json.url === url, 'POST again: the same link (one per owner; the session wins over a dev in the body)');
const st = await req(PORT, 'POST', '/api/stats', {}, { cookie: cookieA });
ok(st.status === 200 && st.json.profile.share && st.json.profile.share.url === url && st.json.profile.share.image === a1.json.image, "/api/stats's profile carries share { url, image }");
const stB = await req(PORT, 'POST', '/api/stats', {}, { cookie: cookieB });
ok(stB.status === 200 && stB.json.profile && stB.json.profile.share === null, '...and share: null for a profile with no link');
ok((await req(PORT, 'POST', '/api/share', { dev: crypto.randomUUID() })).json?.error === 'nothing' && (await req(PORT, 'POST', '/api/share', {})).status === 404, 'no saved profile (an unknown device, no device): 404 nothing');
ok((await req(PORT, 'POST', '/api/share', {}, { cookie: cookieA, origin: 'https://evil.example' })).status === 403, 'a foreign Origin: 403, like every other POST');
ok((await req(PORT, 'GET', '/api/share')).status === 405, 'GET /api/share: 405');

// ---- the page ----
const pg = await req(PORT, 'GET', `/c/${slug}`), html = pg.body;
ok(pg.status === 200 && /^text\/html/.test(pg.headers['content-type']) && pg.headers['cache-control'] === 'public, max-age=300' && pg.headers['x-robots-tag'] === 'noindex', '/c/<slug>: 200 html, public max-age=300, X-Robots-Tag noindex');
ok(meta(html, 'og:title') === 'Share_Ace on Poddle' && meta(html, 'og:site_name') === 'Poddle' && meta(html, 'twitter:card') === 'summary_large_image' && meta(html, 'robots') === 'noindex', 'og:title "<Name> on Poddle", og:site_name, twitter:card, robots noindex');
ok(meta(html, 'og:image') === a1.json.image && meta(html, 'og:url') === url && meta(html, 'og:image:width') === '1200' && meta(html, 'og:image:height') === '630', 'og:image (the same url as the API), og:url, 1200x630');
ok(/^https?:\/\//.test(meta(html, 'og:image')) && /^https?:\/\//.test(meta(html, 'og:url')) && /^https?:\/\//.test(meta(html, 'twitter:image')), 'every og/twitter URL is absolute');
ok(/Play free at poddleball\.com$/.test(meta(html, 'og:description') || '') && /80% return rate/.test(meta(html, 'og:description')) && (meta(html, 'og:image:alt') || '').startsWith("Share_Ace's Poddle player card"), 'og:description: the best stats + "Play free at poddleball.com"; og:image:alt');
ok(/href="\/"[^>]*>[\s\S]*Play Poddle free/.test(html) && /Make your own card/.test(html) && /src="\/vendor\/fonts\//.test(html.replace(/url\(/g, 'src="')) && !/url\(vendor/.test(html), 'the body: the Play Poddle free button to /, the make-your-own line, root-absolute font URLs');
ok((await req(PORT, 'HEAD', `/c/${slug}`)).status === 200, 'HEAD /c/<slug>: 200');

// ---- the PNG ----
const im = await req(PORT, 'GET', `/c/${slug}.png?v=whatever`), hashA = a1.json.image.split('?v=')[1];
ok(im.status === 200 && im.headers['content-type'] === 'image/png' && isPng(im.buf) && dims(im.buf).join('x') === '1200x630', '/c/<slug>.png: 200 image/png, a valid 1200x630 PNG');
ok(im.headers.etag === `"${hashA}"` && im.headers['cache-control'] === 'public, max-age=300' && !im.headers['cross-origin-resource-policy'], 'its ETag is the hash, public max-age=300, embeddable (no same-origin CORP)');
fs.mkdirSync(SHOTS, { recursive: true }); fs.writeFileSync(path.join(SHOTS, 'served.png'), im.buf);
const again = await req(PORT, 'GET', `/c/${slug}.png`, undefined, { headers: { 'if-none-match': `W/"${hashA}"` } });
ok(again.status === 304 && again.buf.length === 0, 'If-None-Match with the hash: 304');
const hd = await req(PORT, 'HEAD', `/c/${slug}.png`);
ok(hd.status === 200 && hd.buf.length === 0 && +hd.headers['content-length'] === im.buf.length, 'HEAD .png: the headers, the length, no body');

// ---- unknown or malformed: 404, nothing rendered (the same computer still has its whole render budget after) ----
const me = ip(), bad = ['/c/AAAAAAAAAA', '/c/AAAAAAAAAA.png', '/c/short.png', '/c/abcdefghijk.png', '/c/', '/c/a/b', '/c/..%2F..%2Fserver%2Fdb.js', '/c/abc%00def.png', '/c/' + slug + '.jpg', '/c/' + slug + '/'];
const got = []; for (const p of bad) got.push(await req(PORT, 'GET', p, undefined, { addr: me }));
ok(got.every(r => r.status === 404 || r.status === 400), '404 (400 for a null byte) for ' + bad.length + ' unknown or malformed paths: ' + got.map(r => r.status).join(','));
ok(/text\/html/.test(got[0].headers['content-type']) && got[1].buf.length === 0 && !got[1].headers['content-type'], 'the page 404 is the site\'s 404 page; the .png 404 is empty');
// the render budget: SHARE_RENDERS=2 cache-miss renders a minute per computer. The 404s above spent none of it
db.close(); db.open(DBF, { busyMs: 2000 });                       // (the test's own connection re-reads the file: the server wrote nothing, this is just hygiene)
const miss = async () => { win(A.owner_id); const s2 = await req(PORT, 'POST', '/api/stats', {}, { cookie: cookieA }); return req(PORT, 'GET', new URL(s2.json.profile.share.image).pathname, undefined, { addr: me }); };
const m1 = await miss(), m2 = await miss(), m3 = await miss();
ok(m1.status === 200 && m2.status === 200 && isPng(m2.buf), 'after the 404s the same computer still renders two new cards (the 404s rendered nothing)');
ok(m3.status === 429 && +m3.headers['retry-after'] >= 1, 'the third cache miss in a minute from that computer: 429 with Retry-After');
ok((await req(PORT, 'GET', new URL((await req(PORT, 'POST', '/api/stats', {}, { cookie: cookieA })).json.profile.share.image).pathname)).status === 200, '...another computer still gets it');

// ---- the hash follows the stats ----
const before = (await req(PORT, 'POST', '/api/stats', {}, { cookie: cookieA })).json.profile.share.image;
win(A.owner_id);
const after = (await req(PORT, 'POST', '/api/stats', {}, { cookie: cookieA })).json.profile.share.image, pg2 = await req(PORT, 'GET', `/c/${slug}`);
ok(before !== after && slugOf(before.split('.png')[0]) === slug && slugOf(after.split('.png')[0]) === slug, 'a new best rally changes the image hash (the slug stays)');
ok(meta(pg2.body, 'og:image') === after, "...and the page's og:image follows it");
raw.prepare('UPDATE profile SET returns = 60 WHERE owner_id = ?').run(A.owner_id);
const after2 = (await req(PORT, 'POST', '/api/stats', {}, { cookie: cookieA })).json.profile.share.image;
ok(after2 !== after, 'a changed return count changes it too (the play counters are on the card)');
const im2 = await req(PORT, 'GET', new URL(after2).pathname);
ok(im2.status === 200 && im2.headers.etag === `"${after2.split('?v=')[1]}"` && !im2.buf.equals(im.buf), 'the PNG is a new picture with the new ETag');

// ---- export, stop sharing, a new slug ----
const ex = await req(PORT, 'POST', '/api/export', {}, { cookie: cookieA });
ok(ex.status === 200 && ex.json.share && ex.json.share.url === `https://poddleball.com/c/${slug}` && !Number.isNaN(Date.parse(ex.json.share.created)), 'the export has share { url, created }');
const del = await req(PORT, 'DELETE', '/api/share', {}, { cookie: cookieA });
ok(del.status === 204 && (await req(PORT, 'GET', `/c/${slug}`)).status === 404 && (await req(PORT, 'GET', `/c/${slug}.png`)).status === 404, 'DELETE /api/share: 204, and the old link and picture are 404');
ok((await req(PORT, 'DELETE', '/api/share', {}, { cookie: cookieA })).status === 204 && (await req(PORT, 'DELETE', '/api/share', {})).status === 204, 'DELETE again (and with nobody): still 204');
ok((await req(PORT, 'POST', '/api/export', {}, { cookie: cookieA })).json.share === null && (await req(PORT, 'POST', '/api/stats', {}, { cookie: cookieA })).json.profile.share === null, 'export and /api/stats: share null');
const a3 = await req(PORT, 'POST', '/api/share', {}, { cookie: cookieA }), slug3 = slugOf(a3.json && a3.json.url);
ok(a3.status === 200 && slug3 && slug3 !== slug && (await req(PORT, 'GET', `/c/${slug3}`)).status === 200 && (await req(PORT, 'GET', `/c/${slug}`)).status === 404, 'sharing again makes a NEW slug; the old one stays dead');

// ---- an account with no username, a guest: "Poddle player" ----
const b1 = await req(PORT, 'POST', '/api/share', {}, { cookie: cookieB }), pb = b1.status === 200 ? await req(PORT, 'GET', `/c/${slugOf(b1.json.url)}`) : { body: '' };
ok(b1.status === 200 && /Poddle player/.test(meta(pb.body, 'og:image:alt') || '') && meta(pb.body, 'og:title') === 'A player on Poddle', 'an account with no username (and no matches): a card for "Poddle player"');
const g1 = await req(PORT, 'POST', '/api/share', { dev: G }), gSlug = slugOf(g1.json && g1.json.url);
ok(g1.status === 200 && gSlug && (await req(PORT, 'GET', `/c/${gSlug}.png`)).status === 200, 'a guest (device id in the body) gets a link and a card');

// ---- merge: the guest's link dies, it never moves ----
ok(db.mergeDevice(auth.deviceHash(G), B.id, Date.now()) === 'merged', 'the guest merges into account B (db.mergeDevice, what sign-in runs)');
ok(db.shareOwner(gSlug) === null && (await req(PORT, 'GET', `/c/${gSlug}`)).status === 404, "the guest's link is gone after the merge");
ok(slugOf((await req(PORT, 'POST', '/api/stats', {}, { cookie: cookieB })).json.profile.share.url) === slugOf(b1.json.url), "account B's own link is unchanged");

// ---- delete: the cascade takes the link ----
const g2 = await req(PORT, 'POST', '/api/share', { dev: G2 }), g2Slug = slugOf(g2.json && g2.json.url);
const gone = await req(PORT, 'DELETE', '/api/account', { dev: G2, confirm: 'delete' });
ok(g2.status === 200 && gone.status === 200 && gone.json.deleted.device === true && db.shareOwner(g2Slug) === null && (await req(PORT, 'GET', `/c/${g2Slug}`)).status === 404, 'Delete my data (guest): the profile goes and its link with it');
ok(db.counts().share === 2, 'two links are left (A and B)');

// ---- signed in on a browser whose guest stats did not merge (the caps): Stop sharing stops both links ----
const C = db.createAccount('share-sub-c', Date.now()), vc = names.validate('Share_Cee'); db.claimUsername(C.id, vc.name, vc.key, Date.now());
const cookieC = `${SES}=${db.session.create(C.id, Date.now())}`, G3 = crypto.randomUUID(), g3Owner = db.ownerForDevice(auth.deviceHash(G3), Date.now(), { create: true });
ok(!!win(C.owner_id) && !!win(g3Owner), 'account C and an unmerged guest G3 have a match on record');
const g3 = await req(PORT, 'POST', '/api/share', { dev: G3 }), g3Slug = slugOf(g3.json && g3.json.url), c1 = await req(PORT, 'POST', '/api/share', { dev: G3 }, { cookie: cookieC }), cSlug = slugOf(c1.json && c1.json.url);
ok(g3Slug && cSlug && g3Slug !== cSlug, 'the guest and the account (same browser, signed in) each have a link');
const stopBoth = await req(PORT, 'DELETE', '/api/share', { dev: G3 }, { cookie: cookieC });
ok(stopBoth.status === 204 && (await req(PORT, 'GET', `/c/${cSlug}`)).status === 404 && (await req(PORT, 'GET', `/c/${g3Slug}`)).status === 404 && (await req(PORT, 'GET', `/c/${g3Slug}.png`)).status === 404,
  "Stop sharing while signed in with the unmerged guest's device id: the account's link AND the guest's link are 404");
const stopOther = async () => { const x = await req(PORT, 'POST', '/api/share', { dev: G3 }); await req(PORT, 'DELETE', '/api/share', { dev: crypto.randomUUID() }, { cookie: cookieC }); return slugOf(x.json && x.json.url); };
const g3b = await stopOther();
ok(g3b && (await req(PORT, 'GET', `/c/${g3b}`)).status === 200, "...another browser's device id stops nothing of this guest's");
await req(PORT, 'DELETE', '/api/share', { dev: G3 });

// ---- the operator: node server/admin.js unshare <link or code> | unshare-user <username> (a separate process, like fly ssh) ----
const admin = (...args) => new Promise(res => { const p = spawn('node', ['server/admin.js', ...args], { cwd: root, env: { ...process.env, NODE_OPTIONS: '', PODDLE_DB: DBF } }); let out = '';
  p.stdout.on('data', d => { out += d; }); p.stderr.on('data', d => { out += d; }); p.on('exit', code => res({ code, out })); });
const c2 = await req(PORT, 'POST', '/api/share', {}, { cookie: cookieC }), c2Slug = slugOf(c2.json && c2.json.url);
ok((await req(PORT, 'GET', new URL(c2.json.image).pathname)).status === 200, 'a live link whose picture the server now holds in memory');
const un = await admin('unshare', c2.json.image);
ok(un.code === 0 && /removed/.test(un.out) && !un.out.includes(c2Slug) && !un.out.includes('Share_Cee'), 'admin unshare <the .png?v= link>: exit 0, "removed", no code or name printed');
ok((await req(PORT, 'GET', `/c/${c2Slug}`)).status === 404 && (await req(PORT, 'GET', `/c/${c2Slug}.png`)).status === 404, '...the running server answers 404 for the page and the picture (the cached PNG is never served)');
const un2 = await admin('unshare', c2Slug), un3 = await admin('unshare', 'https://poddleball.com/c/short');
ok(un2.code === 1 && /no live link/.test(un2.out) && un3.code === 1 && /not a share link/.test(un3.out), 'unshare again: exit 1 "no live link"; a malformed link: exit 1');
const c3 = await req(PORT, 'POST', '/api/share', {}, { cookie: cookieC }), c3Slug = slugOf(c3.json && c3.json.url), uu = await admin('unshare-user', 'share_cee');
ok(c3Slug && c3Slug !== c2Slug && uu.code === 0 && (await req(PORT, 'GET', `/c/${c3Slug}`)).status === 404, 'admin unshare-user <username> (any case): the account\'s link is 404');
ok((await admin('unshare-user', 'share_cee')).code === 1, '...again: exit 1, no live link');

// ---- no renderer: web/og.jpg ----
const nr = await req(P_NORES, 'GET', `/c/${slug3}.png`), og = fs.readFileSync(path.join(root, 'web/og.jpg'));
ok(nr.status === 200 && nr.headers['content-type'] === 'image/jpeg' && nr.buf.equals(og) && nr.headers['cache-control'] === 'public, max-age=60', 'resvg missing: the card is web/og.jpg (image/jpeg, cached a minute)');
await req(P_NORES, 'GET', `/c/${slugOf(b1.json.url)}.png`);
const nrLog = logs.find(l => l.port === P_NORES).out;
ok((nrLog.match(/card: renderer unavailable/g) || []).length === 1, 'one log line for it, not one per request');
ok((await req(P_NORES, 'GET', `/c/${slug3}`)).status === 200, 'the page itself still works');

// ---- hosted: the site's own origin, whatever the Host header says ----
const hp = await req(P_HOST, 'GET', `/c/${slug3}`, undefined, { addr: '8.8.4.4', headers: { host: 'evil.example' } });
ok(hp.status === 200 && meta(hp.body, 'og:image').startsWith(`https://poddleball.com/c/${slug3}.png?v=`) && meta(hp.body, 'og:url') === `https://poddleball.com/c/${slug3}`, 'hosted: og:url and og:image are https://poddleball.com/..., never the Host header');
const hs = await req(P_HOST, 'POST', '/api/share', {}, { cookie: cookieA, addr: '8.8.4.5', origin: 'https://poddleball.com' });
ok(hs.status === 200 && hs.json.url === `https://poddleball.com/c/${slug3}`, 'hosted POST /api/share: https://poddleball.com/c/<slug>');

// ---- the logs never name anyone ----
const all = logs.map(l => l.out).join('\n');
ok(![slug, slug3, gSlug, g2Slug, g3Slug, cSlug, c2Slug, 'Share_Ace', 'Share_Cee', G, G2, G3].some(s => all.includes(s)), 'no slug, username or device id in any server log');

// ---- a full render queue (503) spends none of the budget: the retry Retry-After asks for is not a 429 ----
{
  const many = []; for (let i = 0; i < 24; i++) { const d = crypto.randomUUID(), o = db.ownerForDevice(auth.deviceHash(d), Date.now(), { create: true }); win(o); many.push(slugOf((await req(P_BUSY, 'POST', '/api/share', { dev: d })).json?.url)); }
  const who = ip(), first = await Promise.all(many.map(sl => req(P_BUSY, 'GET', `/c/${sl}.png`, undefined, { addr: who })));
  const busy = many.filter((sl, i) => first[i].status === 503), drawn = first.filter(r => r.status === 200).length;
  if (!busy.length) console.log('  skip the busy refund: the queue never filled (' + first.map(r => r.status).join(',') + ')');
  else {
    const retry = await Promise.all(busy.map(sl => req(P_BUSY, 'GET', `/c/${sl}.png`, undefined, { addr: who })));
    ok(drawn + busy.length === many.length && retry.every(r => r.status !== 429), `${busy.length} of ${many.length} got 503 (queue full), and their retries from the same computer are not 429 (budget ${many.length}: ${retry.map(r => r.status).join(',')})`);
  }
}

// ---- memory: every render's native memory is freed (the worker collects after each job), so a burst cannot push the 256 MB VM over ----
{
  const mb = () => process.memoryUsage().rss / 1048576, base = { played: 30, human: { wins: 5, losses: 3, bestStreak: 3 }, titles: 1, bests: { rally: { v: 12 }, speed: { v: 20 } } };
  const keep = setInterval(() => {}, 1000);                        // the worker is unref'd: hold the loop open while awaiting it
  let d0 = card.dataOf(base, 'Mem0'); await card.png('warm:' + card.hashOf(d0), d0);
  const r0 = mb(); let peak = r0, good = 0;
  for (let i = 0; i < 100; i++) { const d = card.dataOf({ ...base, played: 31 + i }, 'Mem' + i), b = await card.png('mem' + i + ':' + card.hashOf(d), d); if (Buffer.isBuffer(b) && isPng(b)) good++; peak = Math.max(peak, mb()); }
  clearInterval(keep);
  ok(good === 100 && peak - r0 < 100, `100 cache-miss renders in a row: RSS grew ${Math.round(peak - r0)} MB (under 100 MB; the 64-card cache is ~15 MB of it). Unfixed it passed 300`);
}

// ---- the page in a browser (optional: Chrome as the other UI tests use it) ----
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
if (fs.existsSync(CHROME)) {
  const puppeteer = (await import('puppeteer-core')).default, browser = await puppeteer.launch({ executablePath: CHROME, headless: true, args: ['--no-sandbox'] });
  try {
    for (const [w, h] of [[1280, 800], [390, 844]]) {
      const page = await browser.newPage(); await page.setViewport({ width: w, height: h, deviceScaleFactor: 1 });
      await page.goto(`http://127.0.0.1:${PORT}/c/${slug3}`, { waitUntil: 'networkidle0' });
      await page.evaluate(() => document.fonts.ready);
      const r = await page.evaluate(() => { const img = document.querySelector('.card img'), b = document.querySelector('.play').getBoundingClientRect();
        return { loaded: img.complete && img.naturalWidth === 1200, font: document.fonts.check('900 20px "Poddle Rounded"'), btn: b.bottom <= innerHeight + 200 && b.width > 150, over: document.documentElement.scrollWidth > innerWidth }; });
      ok(r.loaded && r.font && r.btn && !r.over, `the page at ${w}x${h}: the card loads, the font loads, the button is there, no sideways scroll`);
      await page.screenshot({ path: path.join(SHOTS, `share-page-${w}x${h}.png`) }); await page.close();
    }
  } finally { await browser.close(); }
} else console.log('  skip the page screenshots: no Chrome at ' + CHROME);

console.log(fails ? `\n${fails} FAILED` : '\nall passed');
process.exit(fails ? 1 : 0);
