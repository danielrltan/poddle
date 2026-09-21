// Two real tabs sit in a court; the server is killed under them (SIGINT, as fly does on a deploy) and a new one starts.
// They must end up back in the SAME court in their own seats, without ever seeing the lobby or "Court closed".
//   node test/revive-e2e.mjs        (REVIVE_E2E_PORT=<port>)
import { spawn } from 'child_process'; import puppeteer from 'puppeteer-core'; import fs from 'fs';
const G = +process.env.REVIVE_E2E_PORT || 9230, root = new URL('..', import.meta.url).pathname, sleep = ms => new Promise(r => setTimeout(r, ms));
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const CHROME = process.env.CHROME || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find(p => fs.existsSync(p));
const up = () => new Promise(res => { const p = spawn('node', ['server/game.js'], { cwd: root, env: { ...process.env, PORT: G } }); p.log = ''; p.stdout.on('data', d => { p.log += d; if (/game server on port/.test(d)) res(p); }); });
let srv = await up();
const browser = await puppeteer.launch({ executablePath: CHROME, headless: 'new', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist', '--mute-audio'] });
const open = async name => { const ctx = await browser.createBrowserContext(), pg = await ctx.newPage(); await pg.setViewport({ width: 1100, height: 650 }); pg.toasts = [];
  await pg.evaluateOnNewDocument(n => { try { localStorage.setItem('poddle.name', n); } catch {} }, name);
  await pg.goto(`http://localhost:${G}/?game=${G}&bridge=${G + 5}&cam=0`, { waitUntil: 'domcontentloaded' }); await sleep(2200); await pg.click('#btn-start'); await sleep(700);
  await pg.evaluate(() => { const t = document.getElementById('toast'); new MutationObserver(() => { const s = t.textContent.trim(); if (s) (window.__toasts ||= []).push(s); }).observe(t, { childList: true, characterData: true, subtree: true }); });
  return pg; };
const st = pg => pg.evaluate(() => ({ screen: document.body.dataset.screen || '', overlay: document.body.dataset.overlay || '', code: document.getElementById('room-code').textContent.trim(), me: document.getElementById('name-me').textContent.trim(), them: document.getElementById('name-them').textContent.trim(), link: document.getElementById('g').textContent.trim(), toasts: window.__toasts || [], search: location.search }));
const until = async (pg, f, ms = 8000) => { const t = Date.now(); let s; while (Date.now() - t < ms) { s = await st(pg); if (f(s)) return s; await sleep(150); } return s; };

const a = await open('Ann'); await a.click('#btn-create'); await sleep(500);
await a.evaluate(() => [...document.querySelectorAll('#screen-lobby button')].find(b => b.offsetParent && /^(create|make|start|open)/i.test(b.textContent.trim()) && b.id !== 'btn-create')?.click());
let sa = await until(a, s => s.code.length === 4); const CODE = sa.code; ok(CODE.length === 4, `Ann made court ${CODE}`);
const b = await open('Ben'); await b.goto(`http://localhost:${G}/?game=${G}&bridge=${G + 5}&cam=0&court=${CODE}`, { waitUntil: 'domcontentloaded' }); await sleep(2200); await b.click('#btn-start');
let sb = await until(b, s => s.code === CODE); ok(sb.code === CODE, `Ben joined ${sb.code}`);
sa = await until(a, s => s.them === 'Ben'); ok(sa.them === 'Ben' && sb.code === CODE, `both seated: Ann sees "${sa.them}"`);
for (const pg of [a, b]) await pg.evaluate(() => { window.__toasts = []; });

console.log('the server is killed and a new one starts (what a deploy does)');
const before = { a: (await st(a)).screen, b: (await st(b)).screen };
srv.kill('SIGINT'); await new Promise(r => srv.on('exit', r));
ok((await until(a, s => s.link === 'off', 4000)).link === 'off' && (await until(b, s => s.link === 'off', 4000)).link === 'off', 'both tabs lost the server');
await sleep(2500); srv = await up();
sa = await until(a, s => s.link === 'live' && s.code === CODE && s.them === 'Ben', 15000); sb = await until(b, s => s.link === 'live' && s.code === CODE && s.them === 'Ann', 15000); await sleep(1500); sa = await st(a); sb = await st(b);
ok(sa.code === CODE && sa.them === 'Ben' && sa.me !== 'Ben', `Ann is back in ${sa.code} facing ${sa.them}`);
ok(sb.code === CODE && sb.them === 'Ann', `Ben is back in ${sb.code} facing ${sb.them}`);
ok(/brought back after a restart/.test(srv.log), 'the new server rebuilt the court from the first tab back');
ok(![...sa.toasts, ...sb.toasts].some(t => /closed|not found/i.test(t)) && sa.screen === before.a && sb.screen === before.b && sa.link === 'live' && sb.link === 'live' && sa.overlay !== 'server-down' && sb.overlay !== 'server-down', `both are on the screen they were on, connected, and nobody saw "Court closed" or the server-down card (toasts: ${JSON.stringify([...new Set([...sa.toasts, ...sb.toasts])])})`);
ok([...sa.toasts, ...sb.toasts].some(t => /Updating/.test(t)), 'they were told it was an update');
ok(new RegExp('court=' + CODE).test(sa.search), 'the address bar still carries the court');
await browser.close(); srv.kill(); console.log(fails ? fails + ' FAILURES' : 'REVIVE E2E PASSED'); process.exit(fails ? 1 : 0);
