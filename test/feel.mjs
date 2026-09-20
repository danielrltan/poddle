// How a hit FEELS, measured from the packets a client receives: swing -> 'hit' latency, where a back-dated hit launches
// from, and the biggest kink in the ball's path around a hit and around a power fix.
// Usage: node test/feel.mjs [server.js] [seconds]   (a second server file = measure an older build for comparison)
import { spawn } from 'child_process';
import WebSocket from 'ws';
const PORT = 8170, root = new URL('..', import.meta.url).pathname, file = process.argv[2] || 'server/game.js', SECS = +process.argv[3] || 40;
const proc = spawn('node', [file], { cwd: root, env: { ...process.env, NODE_PATH: root + 'node_modules', PORT, AUTOBOT: '0', SWING_SERVE: '0', WIN_AT: '0', BLOCK: '0' } });
await new Promise(r => setTimeout(r, 700));
const G = 9.81, DT = 1 / 60, ZONE = { x: 1.15, y: 0.95, front: 1.6, behind: 1.25 }, wait = ms => new Promise(r => setTimeout(r, ms));
const ms = () => performance.timeOrigin + performance.now();
let fails = 0; const ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fails++; };
const FIX = { fix50: 50, fix120: 120, fix200: 200 };

function player(plans) {
  const ws = new WebSocket('ws://localhost:' + PORT), h = { ws, side: null, st: [], ev: [], ball: 0, acted: false, wasIn: false, swings: [] };
  ws.on('message', raw => { const m = JSON.parse(raw), at = ms();
    if (m.type === 'welcome') h.side = m.side;
    if (m.type !== 'state') h.ev.push({ ...m, at, ball: h.ball, i: h.st.length });
    if (m.type === 'launch' && m.by !== h.side && at - (h.lastLaunch || 0) > 300) { h.ball++; h.wasIn = h.acted = false; }
    if (m.type === 'launch') h.lastLaunch = at;
    if (m.type !== 'state' || h.side == null) return;
    h.st.push({ at, t: m.t, p: m.p, v: m.v, live: m.live, me: m.paddles[h.side] });
    ws.send(JSON.stringify({ type: 'paddle', auto: true, q: [0, 0, 0, 1] }));
    const me = m.paddles[h.side], s = h.side === 0 ? 1 : -1, plan = plans[(h.ball - 1) % plans.length];
    if (!me || !m.live || h.acted || h.ball < 1 || m.v[2] * s <= 0) return;
    const ahead = -(m.p[2] - me.z) * s, inside = ahead > -ZONE.behind && ahead < ZONE.front && Math.abs(m.p[0] - me.x) < ZONE.x && Math.abs(m.p[1] - me.y) < ZONE.y;
    if (inside) h.wasIn = true;
    const swing = (o, tag) => { if (tag) h.swings.push({ tag, at: ms(), ball: h.ball }); ws.send(JSON.stringify({ type: 'swing', dir: 0, lob: 0, ...o })); };
    // anywhere inside a tick, like a real message
    if (plan === 'inbox' && inside && ahead < 0.9) { h.acted = true; setTimeout(() => swing({ power: 20, age: 0 }, plan), Math.random() * 16); }
    if (plan === 'late' && h.wasIn && ahead < -1.3) { h.acted = true; swing({ power: 20, age: 250 }, plan); }
    if (FIX[plan] && inside && ahead < 0.9) { h.acted = true; swing({ power: 8, age: 60 }, plan); setTimeout(() => swing({ power: 30, age: 60 + FIX[plan], fix: true }), FIX[plan]); }
  });
  return h;
}
const a = player(['fix50', 'fix120', 'fix200']), b = player(['inbox', 'late']);
await wait(SECS * 1000);

const hyp = (x, y, z) => Math.hypot(x, y, z), f = (v, d = 2) => (v == null || !isFinite(v) ? '-' : v.toFixed(d));
const stat = xs => (xs.length ? `n=${xs.length} mean ${f(xs.reduce((p, c) => p + c, 0) / xs.length)} max ${f(Math.max(...xs))} min ${f(Math.min(...xs))}` : 'n=0');
function analyse(h, tag) {
  const out = [];
  for (const sw of h.swings.filter(x => x.tag === tag)) {
    const hit = h.ev.find(e => e.type === 'hit' && e.side === h.side && e.at >= sw.at && e.at - sw.at < 700); if (!hit) { out.push({ miss: true }); continue; }
    const s = h.side === 0 ? 1 : -1, pre = h.st[hit.i - 1], post = h.st[hit.i]; if (!pre || !post) continue;
    const dt = post.t != null && pre.t != null ? post.t - pre.t : DT;
    const r = { latency: hit.at - sw.at, ahead: -(hit.p[2] - pre.me.z) * s,
      jump: Math.min(hyp(...[0, 1, 2].map(i => post.p[i] - pre.p[i] - post.v[i] * dt)), hyp(...[0, 1, 2].map(i => post.p[i] - pre.p[i] - pre.v[i] * dt))), kink: 0, steps: 0, land: null, bounce: null };
    // after the hit packet: the largest change of velocity between two packets, gravity taken out
    for (let i = hit.i + 1; i < h.st.length && h.st[i].at - hit.at < 450; i++) {
      const A = h.st[i - 1], B = h.st[i], d = B.t != null && A.t != null ? B.t - A.t : DT;
      const k = hyp(B.v[0] - A.v[0], B.v[1] - A.v[1] + G * d, B.v[2] - A.v[2]); if (k > 0.05) r.steps++; r.kink = Math.max(r.kink, k);
    }
    const next = h.ev.filter(e => e.at >= hit.at && e.type === 'launch' && e.by === h.side && e.at - hit.at < 450);
    const bnc = h.ev.find(e => e.at > hit.at && e.type === 'bounce'); r.launches = next.length;
    if (next.length && bnc) { r.land = next[next.length - 1].land; r.bounce = bnc.p; r.off = Math.hypot(bnc.p[0] - r.land[0], bnc.p[2] - r.land[1]); }
    out.push(r);
  }
  return out;
}
console.log(`server: ${file}   (${SECS} s of rally, loopback)`);
const inbox = analyse(b, 'inbox').filter(r => !r.miss), late = analyse(b, 'late');
console.log(`swing -> 'hit' latency, ball in the box, ms:   ${stat(inbox.map(r => r.latency))}`);
console.log(`in-box hit: launch point ahead of paddle, m:   ${stat(inbox.map(r => r.ahead))}`);
console.log(`in-box hit: position jump in the packets, m:   ${stat(inbox.map(r => r.jump))}`);
const lh = late.filter(r => !r.miss);
console.log(`back-dated hit (age 250 ms): ${lh.length}/${late.length} granted`);
console.log(`  launch point ahead of paddle (- = behind), m: ${stat(lh.map(r => r.ahead))}`);
console.log(`  position jump in the packets, m:              ${stat(lh.map(r => r.jump))}`);
console.log(`  swing -> 'hit', ms:                           ${stat(lh.map(r => r.latency))}`);
for (const tag of Object.keys(FIX)) {
  const rs = analyse(a, tag).filter(r => !r.miss);
  console.log(`${tag}: provisional power 8, fix to 30 after ${FIX[tag]} ms`);
  console.log(`  largest velocity step after the hit, m/s:     ${stat(rs.map(r => r.kink))}`);
  console.log(`  packets carrying a velocity step:             ${stat(rs.map(r => r.steps))}`);
  console.log(`  launches sent: ${rs.map(r => r.launches).join(',')}   final target z: ${rs.map(r => f(r.land && Math.abs(r.land[1]))).join(',')}   bounce off target, m: ${stat(rs.filter(r => r.off != null).map(r => r.off))}`);
}
if (process.argv[2] == null) {                        // assertions only for the current build
  ok(inbox.length >= 3 && Math.max(...inbox.map(r => r.latency)) < 12, 'in the box: hit comes back within a tick of the swing being sent');
  ok(lh.length >= 2 && lh.length === late.length, 'back-dated swings are still granted');
  ok(lh.every(r => r.ahead > -0.15), 'a back-dated hit launches from the paddle, not from behind the player');
  for (const tag of Object.keys(FIX)) { const rs = analyse(a, tag).filter(r => !r.miss);
    ok(rs.length >= 2 && rs.every(r => r.kink < 3), `${tag}: no single-packet kink (< 3 m/s per packet)`);
    ok(rs.every(r => r.launches === 2 && r.land && Math.abs(Math.abs(r.land[1]) - 5.43) < 0.1), `${tag}: landing marker re-sent on the refined power`);
    ok(rs.filter(r => r.off != null).every(r => r.off < 0.25), `${tag}: the ball really lands on the refined target`); }
}
a.ws.close(); b.ws.close(); proc.kill(); console.log(fails ? fails + ' FAILURES' : 'FEEL TESTS DONE'); process.exit(fails ? 1 : 0);
