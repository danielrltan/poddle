// Tests only (node -r test/seedrand.cjs server/game.js): a seeded Math.random, SEED from the environment, so two server runs (today's and a
// counterfactual's, test/strikeat.mjs) draw Matt's whiffs, errors and placements from the same sequence.
let a = (+process.env.SEED || 1) >>> 0;
Math.random = () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
