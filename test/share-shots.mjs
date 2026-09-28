// Renders the share card (server/card.js) for a set of made-up profiles, straight through card.js (no server), to test/ui-shots/share/.
//   node test/share-shots.mjs [outDir]       also writes a 400 px wide copy of each (<name>-400.png) to judge how a chat app shows it
import { createRequire } from 'module';
import fs from 'fs';
import path from 'path';
const require = createRequire(import.meta.url);
const card = require('../server/card.js'), LAD = require('../server/ladder.js'), { Resvg } = require('@resvg/resvg-js');
const out = process.argv[2] || new URL('./ui-shots/share/', import.meta.url).pathname; fs.mkdirSync(out, { recursive: true });
const DAY = 86400e3, T = Date.parse('2026-09-01');
const matt = won => [0, 1, 3, 2].map((lv, i) => ({ level: lv, wins: won[i] ? 3 : 0, losses: 1, streak: 0, bestStreak: won[i] ? 3 : 0, firstWinAt: won[i] ? T + i * DAY : null }));
const lad = t => ({ trophies: t, tier: LAD.tierOf(t), div: LAD.divOf(t), bestTrophies: t, wins: 0, losses: 0 });   // profile.ladder (db.ladderOf): 'Gold II' is tier 3, div 2
const prof = o => ({ guest: false, played: 0, human: { wins: 0, losses: 0, streak: 0, bestStreak: 0 }, titles: 0, matt: matt([0, 0, 0, 0]), bests: { rally: { v: 0 }, hit: { v: 0 }, speed: { v: 0 } }, ...o });
const V = {
  veteran: [prof({ ladder: lad(575), played: 86, human: { wins: 31, losses: 12, streak: 2, bestStreak: 7 }, titles: 2, matt: matt([1, 1, 1, 0]), bests: { rally: { v: 24 }, hit: { v: 80 }, speed: { v: 27.4 } },
    play: { hits: 1840, returns: 1203, chances: 1391, winners: 214, aces: 38, smashes: 97, pointsWon: 900, pointsLost: 700, secs: 40000 } }), 'Daniel'],
  'new-guest': [prof({ ladder: lad(64), guest: true, played: 2, bests: { rally: { v: 5 }, hit: { v: 30 }, speed: { v: 12.2 } }, play: { hits: 14, returns: 6, chances: 9, winners: 1, aces: 0, smashes: 0 } }), null],
  'long-name': [prof({ ladder: lad(372), played: 40, human: { wins: 9, losses: 9, streak: 0, bestStreak: 3 }, matt: matt([1, 1, 0, 0]), bests: { rally: { v: 131 }, hit: { v: 60 }, speed: { v: 44.9 } },
    play: { hits: 900, returns: 555, chances: 999, winners: 88, aces: 12, smashes: 30 } }), 'WWWWWWWWWWWW'],
  'pro-badge': [prof({ ladder: lad(672), played: 260, human: { wins: 88, losses: 20, streak: 9, bestStreak: 14 }, titles: 5, matt: matt([1, 1, 1, 1]), bests: { rally: { v: 41 }, hit: { v: 90 }, speed: { v: 33 } },
    play: { hits: 9000, returns: 6100, chances: 6480, winners: 1200, aces: 300, smashes: 700 } }), 'Ace_Mo'],
  'no-matt': [prof({ ladder: lad(262), played: 12, human: { wins: 3, losses: 6, streak: 0, bestStreak: 2 }, bests: { rally: { v: 11 }, hit: { v: 50 }, speed: { v: 20 } },
    play: { hits: 200, returns: 120, chances: 190, winners: 22, aces: 4, smashes: 5 } }), 'pickle_pat'],
  'fresh-account': [prof({ played: 0 }), 'Newbie'],   // no Ranked games: Bronze I, as Your stats reads it (no trophy pill: zeros are left off)
  losing: [prof({ ladder: lad(20), played: 15, human: { wins: 1, losses: 14, streak: 0, bestStreak: 1 }, bests: { rally: { v: 4 }, hit: { v: 20 }, speed: { v: 5 } }, play: { hits: 40, returns: 9, chances: 30, winners: 2, aces: 0, smashes: 1 } }), 'sam'],   // a 1-14 record: neither a tile nor a chip
  'streak-no-rate': [prof({ ladder: lad(318), played: 20, human: { wins: 6, losses: 2, streak: 4, bestStreak: 5 }, titles: 1, matt: matt([1, 0, 0, 0]), bests: { rally: { v: 9 }, hit: { v: 50 }, speed: { v: 25 } }, play: { hits: 300, returns: 70, chances: 160, winners: 12, aces: 3, smashes: 8 } }), 'Rookie_Rick'],   // under 50%: the record, streak, title take the tiles before the swing
  lowret: [prof({ ladder: lad(158), played: 6, human: { wins: 0, losses: 2, streak: 0, bestStreak: 0 }, bests: { rally: { v: 3 }, hit: { v: 30 }, speed: { v: 5.06 } }, play: { hits: 20, returns: 3, chances: 60, winners: 1, aces: 0, smashes: 0 } }), 'rookie_rae'],   // a weak start: no 5% tile, no 3-hit rally
  'champion-3': [prof({ ladder: lad(868), played: 140, human: { wins: 52, losses: 30, streak: 3, bestStreak: 9 }, titles: 3, matt: matt([1, 1, 1, 1]), bests: { rally: { v: 33 }, hit: { v: 85 }, speed: { v: 30 } },
    play: { hits: 5200, returns: 3300, chances: 4100, winners: 610, aces: 120, smashes: 300 } }), 'Chloe_C'],   // the longest rank name: CHAMPION III
  'pro-top': [prof({ ladder: lad(1046), played: 410, human: { wins: 160, losses: 44, streak: 11, bestStreak: 17 }, titles: 9, matt: matt([1, 1, 1, 1]), bests: { rally: { v: 58 }, hit: { v: 95 }, speed: { v: 36 } },
    play: { hits: 16000, returns: 11800, chances: 12600, winners: 2300, aces: 540, smashes: 1300 } }), 'TopSpin'],   // the top of the ladder: Pro (no divisions, NOTES 126)
};
for (const [name, [p, user]] of Object.entries(V)) {
  const d = card.dataOf(p, user), svg = card.svgOf(d), t = Date.now();
  const opts = { font: { fontFiles: card.FONTS, loadSystemFonts: false, defaultFontFamily: card.F[800] } };
  const full = new Resvg(svg, opts).render().asPng(), ms = Date.now() - t;
  fs.writeFileSync(path.join(out, name + '.png'), full);
  fs.writeFileSync(path.join(out, name + '-400.png'), new Resvg(svg, { ...opts, fitTo: { mode: 'width', value: 400 } }).render().asPng());
  console.log(name.padEnd(14), (full.length / 1024).toFixed(0) + ' KB', ms + ' ms', card.hashOf(d), JSON.stringify(d.big.map(b => b.value)), JSON.stringify(d.chips));
}
