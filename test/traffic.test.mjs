// Page-view counts (server/traffic.js + db.js traffic, NOTES 219): no server, no port, the database ':memory:', every clock injected.
// Last line: TRAFFIC PASS or N FAILURES.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const db = require('../server/db.js'), traffic = require('../server/traffic.js');
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
let T = Date.UTC(2026, 9, 6, 12);                                   // 2026-10-06 noon UTC
const DAY = 86400e3;
const req = (url, { ua = 'Mozilla/5.0 (Macintosh) Chrome/130', referer, addr = '203.0.113.7', method = 'GET' } = {}) => ({ method, url, headers: { 'user-agent': ua, ...(referer ? { referer } : {}) }, socket: { remoteAddress: addr } });
const hitUrl = (u, o) => traffic.hit(req(u, o), u.split('?')[0]);   // as game.js calls it: the request and the file it resolved
const quiet = f => { const e = console.error; console.error = () => {}; try { return f(); } finally { console.error = e; } };

ok(quiet(() => db.open(':memory:')), 'the database opens with the traffic table');
traffic.init({ db, now: () => T, site: 'poddleball.com', addrOf: r => r.socket.remoteAddress, flushMs: 3600e3, log: () => {} });

console.log('source');
const src = (u, o) => traffic.sourceOf(req(u, o));
ok(src('/?ref=hn') === 'hn' && src('/?utm_source=Reddit&x=1') === 'reddit' && src('/how-to-play.html?ref=the_dink') === 'the_dink', 'ref= and utm_source= tag the visit (lower-cased)');
ok(src('/?ref=' + encodeURIComponent('<script>')) === 'other' && src('/?ref=' + 'a'.repeat(40)) === 'other', 'an odd or long tag is other');
ok(src('/', { referer: 'https://www.reddit.com/r/Pickleball/comments/x' }) === 'reddit.com' && src('/', { referer: 'https://news.ycombinator.com/item?id=1' }) === 'news.ycombinator.com', 'else the referring host, www. dropped');
ok(src('/', { referer: 'https://poddleball.com/how-to-play.html' }) === 'site' && src('/', { referer: 'https://www.poddleball.com/' }) === 'site', 'our own host is site');
ok(src('/') === 'direct' && src('/', { referer: 'not a url' }) === 'other', 'no Referer is direct, a broken one other');
ok(src('/', { ua: 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)' }) === 'bot' && src('/?ref=hn', { ua: 'facebookexternalhit/1.1' }) === 'bot' && src('/', { ua: '' }) === 'bot', 'crawlers and link previews are bot, whatever the tag');
ok(traffic.pageOf('/index.html') === '/' && traffic.pageOf('/how-to-play.html') === '/how-to-play' && traffic.pageOf('/privacy.html') === '/privacy', 'pages: the home is /, .html dropped');

console.log('counting');
hitUrl('/index.html?ref=hn'); hitUrl('/index.html?ref=hn'); hitUrl('/how-to-play.html', { referer: 'https://poddleball.com/' });
hitUrl('/index.html?ref=hn', { addr: '198.51.100.9' }); hitUrl('/index.html', { addr: '198.51.100.9', referer: 'https://www.reddit.com/r/x' });
hitUrl('/index.html', { method: 'HEAD', addr: '192.0.2.1' }); hitUrl('/index.html', { ua: 'curl/8', addr: '192.0.2.2' });
let r = traffic.report(1); let d = r[0];
ok(r.length === 1 && d.day === '2026-10-06' && d.views === 6 && d.people === 3, `today: 6 views (HEAD not counted), 3 people (the bot is one): ${JSON.stringify({ v: d.views, p: d.people })}`);
ok(eq(d.sources.map(s => [s.source, s.people, s.views]), [['hn', 2, 3], ['bot', 1, 1], ['reddit.com', 1, 1], ['site', 1, 1]]), `by source, most people first: ${JSON.stringify(d.sources)}`);
ok(eq(d.pages.map(p => [p.page, p.people, p.views]), [['/', 3, 5], ['/how-to-play', 1, 1]]), `by page, most views first: ${JSON.stringify(d.pages)}`);
ok(eq(db.trafficReport('2026-10-06').find(x => x.page === '' && x.source === ''), { day: '2026-10-06', page: '', source: '', views: 6, people: 3 }), 'the report flushed to the table');
hitUrl('/index.html?ref=hn'); ok(traffic.flush() === 4, 'a repeat visit: a delta of one view on four cells (the cell, its source, its page, the day; not the people), flushed');
const all = db.trafficReport('2026-10-06').find(x => x.page === '' && x.source === '');
ok(all.views === 7 && all.people === 3, `the table adds deltas, never double counts: ${all.views} views, ${all.people} people`);
ok(traffic.flush() === 0, 'nothing to flush twice');

console.log('a new day');
T += DAY; hitUrl('/index.html?ref=hn');
r = traffic.report(2);
ok(r.length === 2 && r[0].day === '2026-10-07' && r[0].people === 1 && r[0].views === 1 && r[1].day === '2026-10-06' && r[1].views === 7, `two days, newest first, the same address is a new person today: ${r.map(x => x.day + ':' + x.people + '/' + x.views)}`);
ok(traffic.report(1).length === 1, 'report(1) is today only');
ok(db.trafficReport('nope') === null && db.trafficAdd([{ day: 'x', page: '/', source: '', views: 1, people: 1 }]) === true && db.trafficReport('2026-10-06').filter(x => x.day === 'x').length === 0, 'bad days are refused or skipped');

console.log('bounds');
for (let i = 0; i < 230; i++) hitUrl('/index.html', { referer: `https://host${i}.example`, addr: '10.0.' + (i >> 8) + '.' + (i & 255) });
d = traffic.report(1)[0]; const other = d.sources.find(s => s.source === 'other');
ok(d.sources.length <= 203 && other && other.views === 230 - (200 - 1), `distinct sources a day are capped at 200, the rest are other: ${d.sources.length} sources, other ${other && other.views}`);
ok(!JSON.stringify(db.trafficReport('2026-10-06')).includes('203.0.113') && !JSON.stringify(db.trafficReport('2026-10-06')).includes('10.0.0'), 'no address in the table');
traffic.stop(); db.close();
console.log(fails ? `${fails} FAILURES` : 'TRAFFIC PASS');
process.exit(fails ? 1 : 0);
