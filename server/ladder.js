// The Ranked ladder (docs/RANKED.md 5, DIVISIONS): seven ranks of three divisions each, their trophy floors, what a series and a queue game vs Matt
// are worth. Pure CommonJS, no state, nothing runs on require. web/emblems.js mirrors the rank table (names, floors); test/ladder.test.mjs asserts they agree.
// Vocabulary (RANKED.md 0.1): "trophies" is the count, "tier" the rank index 1..7, "div" the division 1..3 inside it (I lowest, III highest: after III you
// rank up to the next rank's I). `ranked` elsewhere in this codebase means "counted", never this mode.

// tier, name, floor (trophies where the rank starts), sticky (a floor you never fall below once reached), matt (Matt's WIRE level while you
// wait in the queue: Rookie 0, Club 1, Pro 2, Tour 3), mattWin (trophies for a played-out counted win against him; the top rank is only won against people)
const TIERS = Object.freeze([
  Object.freeze({ tier: 1, name: 'Bronze',   floor: 0,   sticky: true,  matt: 0, mattWin: 10 }),
  Object.freeze({ tier: 2, name: 'Silver',   floor: 150, sticky: true,  matt: 1, mattWin: 8 }),
  Object.freeze({ tier: 3, name: 'Gold',     floor: 300, sticky: true,  matt: 1, mattWin: 7 }),
  Object.freeze({ tier: 4, name: 'Platinum', floor: 450, sticky: true,  matt: 3, mattWin: 6 }),
  Object.freeze({ tier: 5, name: 'Diamond',  floor: 600, sticky: false, matt: 3, mattWin: 5 }),
  Object.freeze({ tier: 6, name: 'Champion', floor: 750, sticky: false, matt: 2, mattWin: 4 }),
  Object.freeze({ tier: 7, name: 'Pro',      floor: 900, sticky: false, matt: 2, mattWin: 0 }),
]);
const TOP = TIERS.length;                                        // 7
const RANK_W = 150, DIV_W = 50, DIVS = 3;                        // a rank is 150 trophies wide, a division 50: Bronze I 0, II 50, III 100, Silver I 150 ... Pro III 1000 and up (no cap)
const STICKY_TOP = 4;                                            // Bronze .. Platinum are kept for good (divisions inside them can be lost); Diamond and above can drop, never below Platinum's floor
const NAMES = Object.freeze(TIERS.map(t => t.name));
const FLOORS = Object.freeze(TIERS.map(t => t.floor));
const ROMAN = Object.freeze(['I', 'II', 'III']);
const MATT_CEILING = TIERS[TOP - 1].floor - 1;                   // 899: Matt never carries anyone into the top rank

const int = v => (Number.isFinite(+v) ? Math.trunc(+v) : 0);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

// tierOf(trophies) -> 1..7: the highest rank floor reached (anything unparseable or negative is Bronze)
function tierOf(trophies) { const t = int(trophies); let i = 0; while (i + 1 < TOP && t >= FLOORS[i + 1]) i++; return i + 1; }
// divOf(trophies, tier?) -> 1..3: the division inside the rank (tier defaults to tierOf(trophies)); the top division never ends
function divOf(trophies, tier) { const t = clamp(int(tier == null ? tierOf(trophies) : tier), 1, TOP); return 1 + clamp(Math.floor((int(trophies) - FLOORS[t - 1]) / DIV_W), 0, DIVS - 1); }
// romanOf(div) -> 'I' | 'II' | 'III'
function romanOf(div) { return ROMAN[clamp(int(div), 1, DIVS) - 1]; }
// rankName(tier, div) -> the player-facing rank string, 'Gold II' (div omitted: the rank alone)
function rankName(tier, div) { const n = TIERS[clamp(int(tier), 1, TOP) - 1].name; return div == null ? n : n + ' ' + romanOf(div); }
// floorOf(tier) -> that rank's first trophy count (a tier outside 1..7 is clamped)
function floorOf(tier) { return FLOORS[clamp(int(tier), 1, TOP) - 1]; }
// divFloorOf(tier, div) -> the division's first trophy count
function divFloorOf(tier, div) { return floorOf(tier) + (clamp(int(div), 1, DIVS) - 1) * DIV_W; }
// nextFloorOf(tier) -> the next rank's floor, null at the top
function nextFloorOf(tier) { const t = clamp(int(tier), 1, TOP); return t < TOP ? FLOORS[t] : null; }
// nextDivFloorOf(tier, div) -> where the next division (or the next rank) starts, null at Pro III
function nextDivFloorOf(tier, div) { const t = clamp(int(tier), 1, TOP), d = clamp(int(div), 1, DIVS); return d < DIVS ? divFloorOf(t, d + 1) : nextFloorOf(t); }
// applyFloor(bestTier, trophies) -> trophies, never below the sticky floor of the best RANK reached (Bronze..Platinum), never below 0
function applyFloor(bestTier, trophies) { return Math.max(int(trophies), floorOf(clamp(int(bestTier), 1, STICKY_TOP))); }

// humanDelta(me, them, won, sweep) -> trophies for one side of a settled series, from BOTH sides' pre-series counts (RANKED.md 5.4):
//   gap = clamp(them - me, -300, 300); win = 30 + round(gap / 25) (+3 for a sweep) = 18..45; loss = -(20 - round(gap / 25)) = -32..-8
function humanDelta(me, them, won, sweep) {
  const gap = clamp(int(them) - int(me), -300, 300), k = Math.round(gap / 25);
  return won ? 30 + k + (sweep ? 3 : 0) : -(20 - k);
}
// halveWin(delta) -> the winner's delta over a not-yet-established opponent (R11c new_opponent): half, never under 8
function halveWin(delta) { return Math.max(8, Math.round(int(delta) / 2)); }
// mattDelta(tier) -> a played-out counted win against Matt while queued, by the rank at the START of that game
function mattDelta(tier) { return TIERS[clamp(int(tier), 1, TOP) - 1].mattWin; }
// mattLevel(tier) -> Matt's wire level for the warm-up court
function mattLevel(tier) { return TIERS[clamp(int(tier), 1, TOP) - 1].matt; }
// mattAward(delta, dayUsed, dayCap, trophies) -> what a Matt win may really pay: the day cap and the ceiling applied, never negative
function mattAward(delta, dayUsed, dayCap, trophies) { return Math.max(0, Math.min(int(delta), int(dayCap) - int(dayUsed), MATT_CEILING - int(trophies))); }

const EXPORT_NAMES = NAMES;                                      // the export file names ranks by these words (never by tier number alone)

module.exports = { TIERS, NAMES, FLOORS, ROMAN, TOP, DIVS, RANK_W, DIV_W, STICKY_TOP, MATT_CEILING, EXPORT_NAMES,
  tierOf, divOf, romanOf, rankName, floorOf, divFloorOf, nextFloorOf, nextDivFloorOf, applyFloor, humanDelta, halveWin, mattDelta, mattLevel, mattAward };
