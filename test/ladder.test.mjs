// The trophy ladder, pure (docs/TROPHIES.md 1; docs/RANKED.md 5 with DIVISIONS is history): server/ladder.js and web/emblems.js agree on the eight ranks (names, floors);
// tierOf / divOf / floorOf at every boundary; sticky floors through Platinum and demotion above (never below 450); Pro has no divisions (NOTES 126); the series deltas' bounds; Matt's
// bounty per rank, the 899 ceiling (the Champion floor - 1) and the day cap; new_opponent halving (min 8). No server, no port. Last line: PASS or FAIL n.
import { createRequire } from 'module';
const require = createRequire(import.meta.url);
const L = require('../server/ladder.js');
const E = await import('../web/emblems.js');
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

console.log('the table: eight ranks, the same on both sides of the wire');
ok(L.TIERS.length === 8 && L.TOP === 8 && L.TIERS.every((t, i) => t.tier === i + 1), 'eight tiers, numbered 1..8');
ok(eq(L.NAMES, ['Bronze', 'Silver', 'Gold', 'Platinum', 'Diamond', 'Master', 'Champion', 'Pro']), `the names, Master between Diamond and Champion (${L.NAMES.join(', ')})`);
ok(eq(L.FLOORS, [0, 150, 300, 450, 600, 750, 900, 1050]) && L.RANK_W === 150 && L.DIV_W === 50 && L.DIVS === 3 && eq(L.ROMAN, ['I', 'II', 'III']), `the rank floors, 150 a rank, 50 a division (${L.FLOORS.join(', ')})`);
ok(eq(E.THRESHOLDS, L.FLOORS), `web/emblems.js THRESHOLDS equals server/ladder.js FLOORS (${JSON.stringify(E.THRESHOLDS)} vs ${JSON.stringify(L.FLOORS)})`);
ok(eq(E.RANKS.map(r => r.name), L.NAMES) && E.RANKS.every((r, i) => r.id === i + 1), 'web/emblems.js RANKS names and ids match');
ok(!JSON.stringify(L.TIERS).match(/olymp/i) && !JSON.stringify(E.RANKS).match(/olymp/i), 'no Olympic wording anywhere');
ok(L.TIERS.slice(0, 4).every(t => t.sticky) && L.TIERS.slice(4).every(t => !t.sticky) && L.STICKY_TOP === 4, 'Bronze to Platinum are sticky, Diamond and up are not');
ok(eq(L.TIERS.map(t => t.matt), [0, 1, 1, 3, 3, 2, 2, 2]) && eq(L.TIERS.map(t => t.mattWin), [10, 8, 7, 6, 5, 4, 0, 0]), 'Matt: Rookie, Club, Club, Tour, Tour, Pro, Pro, Pro (wire levels); wins pay 10, 8, 7, 6, 5, 4, 0, 0');
ok(L.MATT_CEILING === 899 && L.CHAMPION === 7 && L.MATT_CEILING === L.floorOf(L.CHAMPION) - 1 && L.floorOf(L.TOP) === 1050 && L.EXPORT_NAMES === L.NAMES, 'the Matt ceiling is one under the Champion floor (899), Pro starts at 1050; EXPORT_NAMES are the names');
ok(Object.isFrozen(L.TIERS) && Object.isFrozen(L.TIERS[0]), 'the table is frozen');

console.log('tierOf / divOf / floorOf / nextFloorOf');
ok(L.tierOf(0) === 1 && L.tierOf(149) === 1 && L.tierOf(150) === 2 && L.tierOf(299) === 2 && L.tierOf(300) === 3 && L.tierOf(449) === 3 && L.tierOf(450) === 4 && L.tierOf(599) === 4 && L.tierOf(600) === 5 && L.tierOf(749) === 5 && L.tierOf(750) === 6 && L.tierOf(899) === 6 && L.tierOf(900) === 7 && L.tierOf(1049) === 7 && L.tierOf(1050) === 8 && L.tierOf(9999) === 8, 'tierOf at every rank floor and just under it');
ok(L.tierOf(-5) === 1 && L.tierOf(NaN) === 1 && L.tierOf('abc') === 1 && L.tierOf(null) === 1 && L.tierOf('300') === 3, 'tierOf: junk and negatives are Bronze, a numeric string counts');
ok(L.divOf(0) === 1 && L.divOf(49) === 1 && L.divOf(50) === 2 && L.divOf(99) === 2 && L.divOf(100) === 3 && L.divOf(149) === 3 && L.divOf(150) === 1 && L.divOf(200) === 2 && L.divOf(250) === 3 && L.divOf(299) === 3, 'divOf: Bronze I 0, II 50, III 100; Silver I 150, II 200, III 250');
ok(L.divOf(900) === 1 && L.divOf(950) === 2 && L.divOf(1000) === 3 && L.divOf(1049) === 3, 'Champion I 900, II 950, III 1000..1049');
ok(L.divOf(1050) === 1 && L.divOf(1100) === 1 && L.divOf(1200) === 1 && L.divOf(5000) === 1 && L.divOf(5000, 8) === 1 && !L.hasDivs(8) && L.hasDivs(7) && L.hasDivs(1) && E.divOf(1200) === 1 && !E.hasDivs(8) && E.hasDivs(7) && E.rankLabel(8, 3) === 'Pro', 'Pro has no divisions (NOTES 126): div is always 1 from 1050 up (no cap), on both sides of the wire');
ok(L.divOf(157, 2) === 1 && L.divOf(157, 1) === 3 && L.divOf(-9) === 1 && L.divOf('x') === 1, 'divOf with a tier given, clamped; junk is I');
{ let bad = 0; for (let t = 0; t <= 1200; t++) { const tier = L.tierOf(t), d = L.divOf(t, tier);
    if (tier === 8) { if (d !== 1 || L.divFloorOf(tier, d) !== 1050 || L.nextDivFloorOf(tier, d) !== null || L.nextFloorOf(tier) !== null || t < 1050) bad++; continue; }   // Pro: one division, nothing above
    const want = 1 + Math.min(2, Math.floor((t - L.floorOf(tier)) / 50)); if (d !== want || L.divFloorOf(tier, d) > t || (d < 3 && L.nextDivFloorOf(tier, d) !== L.divFloorOf(tier, d + 1)) || (d === 3 && L.nextDivFloorOf(tier, d) !== L.nextFloorOf(tier))) bad++; }
  ok(bad === 0, `every count 0..1200: divOf is 1 + min(2, floor((t - floor) / 50)) below Pro and 1 in Pro, divFloorOf <= t, nextDivFloorOf chains into the next rank, null in Pro (${bad} off)`); }
ok(L.romanOf(1) === 'I' && L.romanOf(2) === 'II' && L.romanOf(3) === 'III' && L.romanOf(0) === 'I' && L.romanOf(9) === 'III', 'romanOf: I, II, III, clamped');
ok(L.rankName(3, 2) === 'Gold II' && L.rankName(1, 1) === 'Bronze I' && L.rankName(6, 3) === 'Master III' && L.rankName(7, 3) === 'Champion III' && L.rankName(8, 1) === 'Pro' && L.rankName(8, 3) === 'Pro' && L.rankName(4) === 'Platinum', 'rankName: "Gold II", "Master III"; Pro never has a numeral; the rank alone without a division');
ok([1, 2, 3, 4, 5, 6, 7, 8].every(t => L.floorOf(t) === L.FLOORS[t - 1]) && L.floorOf(0) === 0 && L.floorOf(99) === 1050, 'floorOf per tier, clamped outside 1..8');
ok(L.divFloorOf(2, 1) === 150 && L.divFloorOf(2, 2) === 200 && L.divFloorOf(2, 3) === 250 && L.divFloorOf(7, 3) === 1000 && L.divFloorOf(8, 3) === 1050, 'divFloorOf (Pro: its floor, whatever div is asked)');
ok(L.nextFloorOf(1) === 150 && L.nextFloorOf(6) === 900 && L.nextFloorOf(7) === 1050 && L.nextFloorOf(8) === null && L.nextDivFloorOf(1, 3) === 150 && L.nextDivFloorOf(7, 3) === 1050 && L.nextDivFloorOf(7, 2) === 1000 && L.nextDivFloorOf(8, 1) === null && L.nextDivFloorOf(8, 2) === null, 'nextFloorOf / nextDivFloorOf: the next floor; Champion III leads to Pro; null in Pro (no "to Pro II")');
ok(E.rankOf(240).id === 2 && E.rankOf(900).id === 7 && E.rankOf(1050).id === 8 && E.rankOf(0).id === 1 && E.rankOf(149).id === 1, 'emblems.rankOf agrees with tierOf on both sides of a floor');

console.log('floors: sticky per RANK through Platinum (divisions inside can be lost), demotion above, never below 450');
ok(L.applyFloor(1, -30) === 0 && L.applyFloor(1, 5) === 5, 'Bronze: never below 0');
ok(L.applyFloor(2, 130) === 150 && L.applyFloor(2, 170) === 170, 'Silver reached: a loss at 150 stays at 150');
ok(L.applyFloor(2, 240) === 240 && L.divOf(240) === 2 && L.divOf(260) === 3, 'a Silver III losing to 240 is Silver II: the rank holds, the division does not');
ok(L.applyFloor(3, 280) === 300 && L.applyFloor(4, 430) === 450 && L.applyFloor(4, 460) === 460, 'Gold / Platinum floors hold');
ok(L.applyFloor(5, 590) === 590 && L.applyFloor(6, 740) === 740 && L.applyFloor(7, 880) === 880 && L.applyFloor(8, 1030) === 1030, 'Diamond, Master, Champion and Pro can drop (demotion)');
ok(L.applyFloor(5, 400) === 450 && L.applyFloor(8, 100) === 450, 'but never below Platinum\'s 450');
ok(L.tierOf(L.applyFloor(6, 740)) === 5 && L.divOf(740) === 3, 'a Master at 740 is Diamond III');
ok(L.tierOf(L.applyFloor(8, 1030)) === 7 && L.divOf(1030) === 3, 'a Pro at 1030 is Champion III (off the leaderboard)');

console.log('humanDelta: 18..45 for a win (+3 sweep); a loss costs the loser\'s rank loss (6 Bronze .. 34 Pro), x0.5 to someone 300 above, x1.5 to someone 300 below (NOTES 194)');
ok(L.humanDelta(500, 500, true, false) === 30 && L.humanDelta(500, 500, false, false) === -18, 'equal trophies in Platinum: +30 / -18');
ok(L.humanDelta(500, 500, true, true) === 33, 'a 2-0 sweep: +33');
ok(L.humanDelta(0, 300, true, false) === 42 && L.humanDelta(0, 300, true, true) === 45 && L.humanDelta(0, 300, false, false) === -3, 'the underdog: +42 (+45 sweep), a Bronze loss to someone 300 above costs 3');
ok(L.humanDelta(300, 0, true, false) === 18 && L.humanDelta(300, 0, true, true) === 21 && L.humanDelta(300, 0, false, false) === -21, 'the favourite: +18 (+21), a Gold loss to someone 300 below costs 21');
ok(L.humanDelta(0, 1000, true, false) === 42 && L.humanDelta(1000, 0, false, false) === -45, 'the gap is clamped at 300 either way (Champion: 30 x 1.5)');
ok(JSON.stringify([0, 149, 150, 300, 450, 600, 750, 900, 1050, 5000].map(t => L.humanDelta(t, t, false, false))) === JSON.stringify([-6, -6, -10, -14, -18, -22, -26, -30, -34, -34]), 'an equal loss grows with the rank: 6, 10, 14 .. 34 in Pro');
ok(L.humanDelta(1050, 1350, false, false) === -17 && L.humanDelta(1350, 1050, false, false) === -51, 'Pro: 17 to someone 300 above, 51 to someone 300 below');
{ let lo = Infinity, hi = -Infinity, llo = Infinity, lhi = -Infinity;
  for (let me = 0; me <= 1500; me += 7) for (let them = 0; them <= 1500; them += 11) { const w = L.humanDelta(me, them, true, true), l = L.humanDelta(me, them, false, false); lo = Math.min(lo, w); hi = Math.max(hi, w); llo = Math.min(llo, l); lhi = Math.max(lhi, l); }
  ok(lo === 21 && hi === 45 && llo === -51 && lhi === -3, `bounds over a sweep of counts: sweep wins ${lo}..${hi}, losses ${llo}..${lhi}`); }
ok(L.humanDelta(12, 12, true, false) === 30 && L.humanDelta(12, 24, true, false) === 30 && L.humanDelta(12, 25, true, false) === 31, 'rounding: a gap of 12 rounds to 0, 13 to 1 (round half up)');
ok(L.humanDelta('x', null, true, false) === 30, 'junk counts are 0');

console.log('halveWin: new_opponent halves the winner\'s delta, never under 8');
ok(L.halveWin(30) === 15 && L.halveWin(45) === 23 && L.halveWin(18) === 9 && L.halveWin(15) === 8 && L.halveWin(8) === 8, 'halved (rounded), min 8');

console.log('Matt: the bounty per tier, the ceiling, the day cap');
ok(L.mattDelta(1) === 10 && L.mattDelta(2) === 8 && L.mattDelta(3) === 7 && L.mattDelta(4) === 6 && L.mattDelta(5) === 5 && L.mattDelta(6) === 4 && L.mattDelta(7) === 0 && L.mattDelta(8) === 0, 'mattDelta per tier (Master 4, Champion and Pro 0)');
ok(L.mattDelta(0) === 10 && L.mattDelta(99) === 0, 'clamped outside 1..8');
ok(L.mattLevel(1) === 0 && L.mattLevel(2) === 1 && L.mattLevel(4) === 3 && L.mattLevel(6) === 2 && L.mattLevel(7) === 2 && L.mattLevel(8) === 2, 'mattLevel: the wire level for the warm-up court');
ok(L.mattAward(10, 0, 40, 0) === 10 && L.mattAward(10, 35, 40, 0) === 5 && L.mattAward(10, 40, 40, 0) === 0, 'the day cap: 40 a day, the last win pays the rest');
ok(L.mattAward(4, 0, 40, 896) === 3 && L.mattAward(4, 0, 40, 897) === 2 && L.mattAward(4, 0, 40, 899) === 0 && L.mattAward(4, 0, 40, 900) === 0, 'the ceiling: never past 899 (Master III at most)');
ok(L.mattAward(-5, 0, 40, 0) === 0 && L.mattAward(10, 50, 40, 0) === 0, 'never negative');
ok(L.mattAward(10, 0, 12, 0) === 10 && L.mattAward(10, 10, 12, 0) === 2, 'a test-sized cap (MATT_DAY 12): the second win pays 2');

console.log(fails ? `FAIL ${fails}` : 'PASS'); process.exit(fails ? 1 : 0);
