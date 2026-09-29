// The mid-game record notice (NOTES 132), no server, no port: stats.records(m) against an in-memory database. A seat with a saved best is told
// once when this match passes it, again only for a higher value; the swing only in the tenths Your stats shows; a first-time player and a bot
// are never told. Last line: PASS or FAIL n.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const db = require('../server/db.js'), stats = require('../server/stats.js'), crypto = require('node:crypto');
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const T0 = Date.UTC(2026, 8, 28, 12), hash = s => crypto.createHash('sha256').update(s).digest();
ok(db.open(':memory:'), 'the database opens'); stats.init({ db, env: {} });
const d1 = hash('vet'), vet = db.ownerForDevice(d1, T0, { create: true }), d2 = hash('newbie');
const opp = db.createAccount('sub-opp', T0);
db.recordMatch({ now: T0, kind: 'human', ending: 'won', winner: 0, score: [11, 3], secs: 60, seats: [{ owner: vet, record: true, bests: true, bestRally: 8, bestSpeed: 20 }, { owner: opp.owner_id, record: true, bests: true, bestRally: 3 }] });
ok(db.profileOf(vet).bests.rally.v === 8 && db.profileOf(vet).bests.speed.v === 20, `the veteran's saved bests: rally 8, swing 20 rad/s`);
const seat = (devHash, extra = {}) => ({ pl: {}, bot: false, ident: { devHash, accountId: null, ownerId: null, anon: false }, bestRally: 0, bestSpeed: 0, swingBad: false, ...extra });
const m = { done: false, seats: [seat(d1), seat(d2)] };
ok(stats.records(m).length === 0, 'nothing beaten yet: no notice');
m.seats[0].bestRally = 8; ok(stats.records(m).length === 0, 'equal to the best is not a new best');
m.seats[0].bestRally = 11; let r = stats.records(m); ok(r.length === 1 && r[0].side === 0 && r[0].what === 'rally' && r[0].v === 11, `rally 11 over a saved 8: one notice (${JSON.stringify(r)})`);
ok(stats.records(m).length === 0, 'the same 11 is told once');
m.seats[0].bestRally = 14; r = stats.records(m); ok(r.length === 1 && r[0].v === 14, 'a longer rally later in the match is told again');
m.seats[0].bestSpeed = 20.05; ok(stats.records(m).length === 0, 'a swing a hair faster than the best, the same to 10 deg/s: no notice');
m.seats[0].bestSpeed = 24; r = stats.records(m); ok(r.length === 1 && r[0].what === 'speed' && r[0].v === 1380, `swing 24 rad/s over 20: told in deg/s as Your stats rounds it (${JSON.stringify(r)})`);
m.seats[0].bestSpeed = 30; m.seats[0].swingBad = true; ok(stats.records(m).length === 0, 'an implausible swing (swingBad) is never told');
m.seats[1].bestRally = 40; m.seats[1].bestSpeed = 30; ok(stats.records(m).length === 0, 'a first-time player has no best to beat: no notices on its first match');
const b = { done: false, seats: [{ bot: true }, { ...seat(null), ident: { anon: true } }] }; b.seats[1].bestRally = 50;
ok(stats.records(b).length === 0, 'Matt and an anonymous seat are never told');
const acct = db.createAccount('sub-vet2', T0);
db.recordMatch({ now: T0 + 1, kind: 'bot', level: 0, ending: 'won', winner: 0, score: [11, 0], secs: 60, seats: [{ owner: acct.owner_id, record: true, bests: true, bestRally: 5 }, null] });
const a = { done: false, seats: [{ ...seat(null), ident: { devHash: null, accountId: acct.id, ownerId: acct.owner_id, anon: false }, bestRally: 6 }, null] };
r = stats.records(a); ok(r.length === 1 && r[0].v === 6, 'a signed-in seat reads its account best (5) and is told at 6');
ok(stats.records({ done: true, seats: m.seats }).length === 0 && stats.records(null).length === 0, 'a finished match or none: nothing');
db.close();

console.log(fails ? `FAIL ${fails}` : 'PASS'); process.exit(fails ? 1 : 0);
