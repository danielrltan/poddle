// web/rec.js (NOTES 239): ?rec=1 keeps samples in the data/*.jsonl shape the harnesses read, plus ball events; off it does nothing.
import { createRec } from '../web/rec.js';
let saved = null, fails = 0;
globalThis.window = {}; Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'test' }, configurable: true });
globalThis.document = { createElement: () => ({ click() {}, remove() {} }), body: { append() {} } };
globalThis.URL.createObjectURL = b => { saved = b; return 'blob:x'; }; globalThis.URL.revokeObjectURL = () => {};
const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const off = createRec(false, () => null); off.sample({ t: 1, q: [0, 0, 0, 1], r: [0, 0, 0] }, 'phone'); ok(off.save() === undefined && !window.__rec, 'off: no recorder, no window.__rec');
const r = createRec(true, () => ({ phone: { at: 1 } }));
ok(r.save() === false, 'nothing recorded: no file');
r.got({ type: 'state', t: 5, p: [0.12345, 1, 2], v: [1, 2, 3], live: true, paddles: [{ x: 0, y: 1, z: 6.5 }, null] }, 0);
for (let i = 0; i < 3; i++) r.sample({ t: i / 60, q: [0, 0, 0, 1], r: [i, 0, 0], a: [0, 0, 0] }, 'phone');
r.sent({ type: 'swing', power: 9 }); r.sent({ type: 'paddle', x: 0 }); r.got({ type: 'hit', side: 0, p: [0, 1, 6] }, 0); r.got({ type: 'names' }, 0);
ok(r.save() === true && saved, 'a file is handed over');
const lines = (await saved.text()).trim().split('\n').map(l => JSON.parse(l));
const harness = lines.filter(x => x && x.q && x.r && Number.isFinite(x.at));       // test/reaimgap.mjs / swinglat.mjs filter
ok(lines[0].ev === 'meta' && lines[0].cal.phone.at === 1, 'first line: meta with the calibration');
ok(harness.length === 3 && harness.every(x => x.src === 'phone'), 'the harness filter sees exactly the 3 samples');
ok(lines.filter(x => x.ev === 'send').length === 1, 'only swing reports are kept from what was sent');
ok(lines.some(x => x.ev === 'state' && x.p[0] === 0.123 && x.pd[0][2] === 6.5) && lines.some(x => x.ev === 'hit') && !lines.some(x => x.ev === 'names'), 'ball state, hit kept; other messages not');
ok(r.save() === false, 'saved rows are freed');
console.log(fails ? fails + ' FAILURES' : 'REC TEST PASSED'); process.exit(fails ? 1 : 0);
