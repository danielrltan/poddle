// Black-box test of server/game.js over real websockets + an in-process sweep of solve().
// run: node test/server.test.mjs      (ports 8140-8159, TEST_SCALE=6 by default: sim runs 6x real time)
// One state packet == one 60Hz sim tick, so all timing below is counted in packets, not wall clock.
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import path from 'node:path';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GAME = path.join(ROOT, 'server/game.js');
const SCALE = +process.env.TEST_SCALE || 6;
const DT = 1 / 60;
process.env.PORT = '8140';                                   // the in-process copy (only used for solve())
const { COURT, ZONE, BOUNCE, G, R, solve } = createRequire(import.meta.url)(GAME);

const sg = side => (side === 0 ? 1 : -1);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fails = [], notes = [];
const fail = (where, msg) => { fails.push(`[${where}] ${msg}`); if (fails.length <= 40) console.log(`  FAIL [${where}] ${msg}`); };
const ok = (where, cond, msg) => { if (!cond) fail(where, msg); return cond; };
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- server processes ----------
const procs = new Set();
let nextPort = 8141;
function startServer(scale = SCALE) {
  const port = nextPort++;
  return new Promise((res, rej) => {
    const proc = spawn(process.execPath, [GAME], { env: { ...process.env, PORT: String(port), TIMESCALE: String(scale), AUTOBOT: '0' } });
    const sv = { port, proc, dead: false, out: '' };
    procs.add(proc);
    proc.stdout.on('data', d => { sv.out += d; if (/game server on port/.test(sv.out)) res(sv); });
    proc.stderr.on('data', d => { sv.out += d; });
    proc.on('exit', code => { sv.dead = true; sv.code = code; procs.delete(proc); rej(new Error('server exited early: ' + sv.out)); });
  });
}
const stopServer = sv => { sv.stopping = true; sv.proc.kill('SIGKILL'); };
process.on('exit', () => { for (const p of procs) p.kill('SIGKILL'); });

function allFinite(o) {
  if (typeof o === 'number') return Number.isFinite(o);
  if (o === null || typeof o === 'boolean' || typeof o === 'string') return true;   // null handled by shape checks below
  if (Array.isArray(o)) return o.every(allFinite);
  return Object.values(o).every(allFinite);
}
const vec = (a, n) => Array.isArray(a) && a.length === n && a.every(Number.isFinite);

// ---------- scripted client + invariant checker ----------
class Client extends EventEmitter {
  static open(port, label, director) {
    return new Promise((res, rej) => {
      const c = new Client(); c.label = label; c.director = director || (() => ({ kind: 'none' }));
      c.ws = new WebSocket('ws://localhost:' + port);
      c.ws.on('message', raw => c.onMsg(JSON.parse(raw)));
      c.ws.on('error', rej);
      c.ws.on('close', () => { c.closed = true; c.emit('closed'); });
      c.once('welcome', () => res(c));
      setTimeout(() => rej(new Error(label + ': no welcome')), 5000);
    });
  }
  tick = 0; st = null; prev = null; hitter = null; bounces = 0; teleportOk = true; pendingHit = null; landed = null;
  rallyIdx = 0; ctx = null; serveBy = null; lastServeBy = null; lastServeTick = -1e9;
  log = []; whiffs = []; hits = []; stats = []; maxStep = 0; maxSpeed = 0; zRange = [Infinity, -Infinity];
  send(o) { if (this.ws.readyState === 1) this.ws.send(typeof o === 'string' || Buffer.isBuffer(o) ? o : JSON.stringify(o)); }
  close() { this.ws.close(); }

  onMsg(m) {
    const L = this.label;
    if (!allFinite(m)) fail(L, 'non-finite number in ' + JSON.stringify(m).slice(0, 200));
    if (m.type !== 'state') this.log.push({ tick: this.tick, ...m });
    switch (m.type) {
      case 'welcome': this.side = m.side; this.court = m.court; this.rallyIdx = 0; break;
      case 'launch': {
        ok(L, vec(m.land, 2), 'launch.land malformed ' + JSON.stringify(m));
        const s = sg(m.by);
        ok(L, Math.abs(m.land[0]) <= COURT.halfW && m.land[1] * s < 0 && Math.abs(m.land[1]) <= COURT.halfL, `launch target out of bounds ${JSON.stringify(m)}`);
        this.hitter = m.by; this.bounces = 0; this.landed = m.land;
        this.ctx = m.by === this.side ? null : { idx: this.rallyIdx, b: null, bounced: false, swung: false, launchTick: this.tick };
        if (this.rallyIdx === 0) this.serveBy = m.by;
        if (this.ctx) this.ctx.b = this.director(this.ctx.idx, this) || { kind: 'none' };
        this.rallyIdx++;
        break;
      }
      case 'serve':
        this.teleportOk = true;
        if (this.lastServeBy !== null && !this.matchRestart) ok(L, m.by !== this.lastServeBy, `serve did not alternate (by ${m.by} twice)`);
        if (!this.matchRestart) ok(L, this.tick - this.lastServeTick > 60, `two serves within ${this.tick - this.lastServeTick} ticks`);
        this.lastServeBy = m.by; this.lastServeTick = this.tick; this.matchRestart = false;
        break;
      case 'bounce':
        this.bounces++;
        if (this.ctx) this.ctx.bounced = true;
        if (this.bounces === 1 && this.hitter !== null) {
          const s = sg(this.hitter);
          ok(L, vec(m.p, 3) && m.p[2] * s < 0 && Math.abs(m.p[0]) <= COURT.halfW && Math.abs(m.p[2]) <= COURT.halfL, `first bounce not in the opponent's court: ${JSON.stringify(m.p)} hitter ${this.hitter}`);
          ok(L, Math.hypot(m.p[0] - this.landed[0], m.p[2] - this.landed[1]) < 0.35, `bounce ${JSON.stringify(m.p)} far from announced landing ${JSON.stringify(this.landed)}`);
        }
        break;
      case 'hit':
        ok(L, this.hitter !== m.side, `side ${m.side} hit its own ball`);
        ok(L, m.n >= 0 && m.n <= 1, 'hit.n out of range');
        this.pendingHit = m; this.hits.push({ tick: this.tick, side: m.side, ctx: m.side === this.side ? this.ctx : null });
        break;
      case 'whiff': this.whiffs.push({ tick: this.tick, why: m.why, idx: this.ctx ? this.ctx.idx : -1 }); break;
      case 'swung': if (m.side === this.side && this.ctx && this.ctx.swungTick == null) this.ctx.swungTick = this.tick; break;
      case 'point':
        if (this.st) { const exp = [...this.st.score]; exp[m.winner]++; ok(L, m.score[0] === exp[0] && m.score[1] === exp[1], `point score ${m.score} expected ${exp}`); }
        this.rallyIdx = 0; this.ctx = null; this.hitter = null;
        break;
      case 'state': this.onState(m); break;
    }
    this.emit(m.type, m); this.emit('any', m);
  }

  onState(st) {
    const L = this.label; this.tick++;
    if (!(vec(st.p, 3) && vec(st.v, 3) && vec(st.score, 2))) { fail(L, 'malformed state ' + JSON.stringify(st).slice(0, 200)); return; }
    st.paddles.forEach((pd, k) => {
      if (!pd) return;
      if (!(Number.isFinite(pd.x) && Number.isFinite(pd.y) && Number.isFinite(pd.z) && vec(pd.q, 4))) return fail(L, 'malformed paddle ' + JSON.stringify(pd));
      const d = pd.z * sg(k); this.zRange = [Math.min(this.zRange[0], d), Math.max(this.zRange[1], d)];
      ok(L, d > 0.9 && d < 9.6, `paddle ${k} z insane: ${pd.z}`);
      ok(L, Math.abs(pd.x) <= 3.8 + 1e-9 && pd.y >= 0.3 - 1e-9 && pd.y <= 2.3 + 1e-9, `paddle ${k} x/y outside limits ${pd.x},${pd.y}`);
    });
    const pv = this.prev, justHit = !!this.pendingHit;         // on the hit tick the ball still moved with its old velocity before being struck
    if (this.pendingHit) {                                     // contact box, against the paddle exactly as it was on the hit tick
      const h = this.pendingHit, pd = st.paddles[h.side], s = sg(h.side); this.pendingHit = null;
      const dx = h.p[0] - pd.x, dy = h.p[1] - pd.y, ahead = -(h.p[2] - pd.z) * s;
      ok(L, Math.abs(dx) < ZONE.x && Math.abs(dy) < ZONE.y && ahead > -ZONE.behind && ahead < ZONE.front, `hit outside contact box dx=${dx.toFixed(2)} dy=${dy.toFixed(2)} ahead=${ahead.toFixed(2)}`);
      if (pv) ok(L, Math.hypot(h.p[0] - pv.p[0], h.p[1] - pv.p[1], h.p[2] - pv.p[2]) <= 0.6, 'ball teleported into the hit');
      ok(L, st.v[2] * s < 0, 'ball not leaving the hitter after hit');
      const sp = Math.hypot(...st.v); this.maxSpeed = Math.max(this.maxSpeed, sp);
      const hr = this.hits[this.hits.length - 1];
      hr.stat = { ahead, dx, dy };
      this.stats.push({ tick: this.tick, side: h.side, n: h.n, dx, dy, ahead, y: h.p[1], speed: sp, dz: Math.abs(h.p[2] - pd.z) });
    }
    if (pv && pv.live && st.live) {
      const d = Math.hypot(st.p[0] - pv.p[0], st.p[1] - pv.p[1], st.p[2] - pv.p[2]);
      if (this.teleportOk) this.teleportOk = false;            // serve: ball is placed in the server's hand
      else {
        this.maxStep = Math.max(this.maxStep, d);
        ok(L, d <= 0.6, `ball teleported ${d.toFixed(2)} m between packets`);
        if (this.hitter !== null) {
          const s = sg(this.hitter);
          ok(L, st.v[2] * s < 0 && (justHit || (st.p[2] - pv.p[2]) * s <= 1e-9), `ball moving toward hitter ${this.hitter}: z ${pv.p[2].toFixed(2)} -> ${st.p[2].toFixed(2)}`);
        }
        if (pv.p[2] * st.p[2] < 0) {                           // crossed the net plane
          const f = pv.p[2] / (pv.p[2] - st.p[2]), yn = pv.p[1] + (st.p[1] - pv.p[1]) * f;
          ok(L, yn > COURT.net + R, `ball crossed the net at y=${yn.toFixed(2)}`);
          this.netY = yn;
        }
      }
    } else if (st.live) this.teleportOk = false;
    this.prev = this.st = st;
    this.brain(st);
  }

  // behaviours: none | good{right,up,trig,shot} | timing{shot} | early | late | lead{lead,shot} ; y: fixed paddle height
  brain(st) {
    const me = st.paddles[this.side], c = this.ctx; if (!me || !st.live || !c) return;
    const b = c.b, s = sg(this.side);
    const ahead = -(st.p[2] - me.z) * s;
    const closing = c.prevAhead != null ? (c.prevAhead - ahead) / DT : 0; c.prevAhead = ahead;
    if (c.enterTick == null && ahead < ZONE.front && ahead > -ZONE.behind) c.enterTick = this.tick;
    if (b.kind === 'idle') return;
    const x = st.p[0] + st.v[0] * DT * 2 + (b.right || 0) * s;
    const y = b.y != null ? b.y : st.p[1] + st.v[1] * DT * 2 + (b.up || 0);
    this.send({ type: 'paddle', x, y: clamp(y, 0.3, 2.3), q: [0, 0, 0, 1] });
    if (c.swung || b.kind === 'none') return;
    let go = false;
    if (b.kind === 'good') go = c.bounced && ahead < (b.trig ?? 0.5) && ahead > -0.6;
    else if (b.kind === 'timing') go = c.bounced && (st.v[1] <= 0 || ahead <= 0.3);
    else if (b.kind === 'early') go = st.p[2] * s > 0;
    else if (b.kind === 'late') go = ahead < -1.2;
    else if (b.kind === 'lead' && closing > 0 && ahead > ZONE.front) {   // time until the ball enters the box, allowing for the bounce slowing it
      const gap = ahead - ZONE.front, tl = c.bounced ? Infinity : (st.v[1] + Math.sqrt(st.v[1] ** 2 + 2 * G * Math.max(0, st.p[1] - R))) / G;
      const eta = gap <= closing * tl ? gap / closing : tl + (gap - closing * tl) / (closing * BOUNCE.along);
      go = eta <= b.lead;
    }
    if (!go) return;
    const sh = b.shot || { n: 0.4, dir: 0, lob: 0 };
    c.swung = true; c.sentTick = this.tick; c.sentAhead = ahead;
    this.send({ type: 'swing', power: 9 + 26 * sh.n, dir: sh.dir, lob: sh.lob });
  }
}

// wait for a message matching pred, bounded in SIM ticks of that client (and in wall clock in case the server is dead)
function waitFor(c, type, pred, maxTicks, what) {
  return new Promise(res => {
    const t0 = c.tick;
    const done = v => { c.off(type, onM); c.off('state', onT); clearTimeout(tm); res(v); };
    const onM = m => { if (!pred || pred(m)) done(m); };
    const onT = () => { if (c.tick - t0 > maxTicks) done(null); };
    const tm = setTimeout(() => { fail(c.label, `wall-clock timeout waiting for ${what} (server dead/stuck?)`); done(null); }, 3000 + maxTicks * DT * 1000 / SCALE * 3);
    c.on(type, onM); if (type !== 'state') c.on('state', onT); else c.on('state', onT);
  });
}
const waitTicks = (c, n) => waitFor(c, 'never', null, n, 'ticks');

const SEC = s => Math.round(s * 60);
const good = (shot, extra) => ({ kind: 'good', shot, ...extra });

// ---------- (2a)(8) in-process sweep of solve(): every contact position x every shot ----------
function sweepSolve() {
  const W = 'solve-sweep'; let count = 0, maxSpeed = 0, minNet = Infinity, maxT = 0, maxXc = 0;
  const fly = (p0, side, n, dir, lob, strict) => {
    const s = sg(side), sol = solve(p0, side, n, dir, lob); count++;
    if (!ok(W, vec(sol.v, 3) && vec(sol.land, 2) && Number.isFinite(sol.T) && sol.T > 0, `non-finite solve for p=${p0} side=${side} n=${n} dir=${dir} lob=${lob}: ${JSON.stringify(sol)}`)) return;
    if (!strict) return;
    ok(W, sol.v[2] * s < 0, `shot goes toward the hitter p=${p0}`);
    maxSpeed = Math.max(maxSpeed, Math.hypot(...sol.v)); maxT = Math.max(maxT, sol.T);
    ok(W, Math.hypot(...sol.v) * DT <= 0.6, `ball steps ${(Math.hypot(...sol.v) * DT).toFixed(2)} m per packet p=${p0} n=${n}`);
    const p = [p0[0], Math.max(p0[1], R), p0[2]], v = [...sol.v];
    for (let i = 0; i < 600; i++) {                            // same integrator as the server
      const z0 = p[2], y0 = p[1];
      v[1] -= G * DT; for (let k = 0; k < 3; k++) p[k] += v[k] * DT;
      if (z0 * p[2] < 0 || (z0 !== 0 && p[2] === 0)) {
        const yn = y0 + (p[1] - y0) * (z0 / (z0 - p[2])); minNet = Math.min(minNet, yn);
        ok(W, yn > COURT.net + R, `net: y=${yn.toFixed(2)} from p=${p0} n=${n} dir=${dir} lob=${lob}`);
      }
      if (p[1] < R) {
        const ta = -v[1] * BOUNCE.up / G, xc = p[0] + v[0] * BOUNCE.along * ta; maxXc = Math.max(maxXc, Math.abs(xc));
        ok(W, Math.abs(xc) <= 3.25, `top of bounce at x=${xc.toFixed(2)}: out of reach, from p=${p0} n=${n} dir=${dir} lob=${lob}`);
        ok(W, p[2] * s < 0 && Math.abs(p[0]) <= COURT.halfW && Math.abs(p[2]) <= COURT.halfL && Math.abs(p[2]) > 0.5, `lands out: ${p.map(a => a.toFixed(2))} from p=${p0} n=${n} dir=${dir} lob=${lob}`);
        return;
      }
    }
    fail(W, `never landed from p=${p0}`);
  };
  for (const side of [0, 1]) for (const n of [0, 0.25, 0.5, 0.75, 1]) for (const dir of [-1, -0.5, 0, 0.5, 1]) for (const lob of [0, 0.5, 1])
    for (const x of [-4.95, -3, 0, 3, 4.95]) for (const y of [R, 0.3, 1, 2, 3.25]) for (const d of [1.0, 1.7, 2.6, 4.5, 6.5, 8.4, 9.3])
      fly([x, y, d * sg(side)], side, n, dir, lob, true);
  // degenerate: ball on the net plane, on the wrong side, exactly on the target z, underground, absurd inputs
  for (const side of [0, 1]) for (const n of [0, 1]) for (const lob of [0, 1]) {
    const s = sg(side), tz = -s * ((n ? 3.4 : 4.7) + lob * 1.2);
    for (const p of [[0, 1, 0], [0, 1, tz], [0, 1, -s * 3], [0, -5, s * 6], [0, 1, s * 1e-12], [2.5 * s, R, tz]]) fly(p, side, n, 1, lob, false);
  }
  notes.push(`solve sweep: ${count} launches, max launch speed ${maxSpeed.toFixed(1)} m/s (${(maxSpeed * DT).toFixed(2)} m/packet), lowest net crossing y=${minNet.toFixed(2)} (net ${COURT.net}), longest flight ${maxT.toFixed(2)} s, widest top-of-bounce |x|=${maxXc.toFixed(2)} m`);
}

// ---------- feel table (numbers only, from solve + the server's bounce model) ----------
function feelTable() {
  const rows = [];
  for (const [name, n, lob] of [['serve', 0.15, 0.25], ['soft', 0, 0], ['medium', 0.5, 0], ['hard', 1, 0], ['lob', 0.3, 1]]) {
    for (const [from, dir, x0] of [['baseline 7.5m, straight', 0, 0], ['baseline 7.5m, corner->corner', 1, -3]]) {
      const sol = solve([x0, 1.0, 7.5], 0, n, dir, lob), v = sol.v;
      const up = -(v[1] - G * sol.T) * BOUNCE.up, ta = up / G, vz = Math.abs(v[2]) * BOUNCE.along, vx = v[0] * BOUNCE.along;
      let apexZ = Math.abs(sol.land[1]) + vz * ta, t = ta;
      if (apexZ > 8.1) { t = (8.1 - Math.abs(sol.land[1])) / vz; apexZ = 8.1; }       // met on the rise at the back of the footwork range
      const yC = R + up * t - 0.5 * G * t * t, xC = sol.land[0] + vx * t;
      const box = (ZONE.front + ZONE.behind) / vz;
      rows.push({ shot: name, from, 'launch m/s': +Math.hypot(...v).toFixed(1), 'flight s': +sol.T.toFixed(2), 'hit-to-hit s': +(sol.T + t).toFixed(2),
        'post-bounce m/s': +Math.hypot(vz, vx).toFixed(1), 'y at receiver m': +yC.toFixed(2), 'x at receiver m': +xC.toFixed(2),
        'deg of wrist from centre': +(Math.abs(xC) / 3.0 * 35).toFixed(0), 'deg needed (box 1.15)': +(Math.max(0, Math.abs(xC) - ZONE.x) / 3.0 * 35).toFixed(0),
        'ms ball is in box': +(box * 1000).toFixed(0), 'ms swing window total': +((box + 0.32) * 1000).toFixed(0) });
    }
  }
  console.log('\nFEEL TABLE (receiver standing where footwork puts them):'); console.table(rows);
}

// ---------- suites ----------
async function pair(sv, dirA, dirB, la = 'A', lb = 'B') {
  const A = await Client.open(sv.port, `${sv.port}:${la}`, dirA);
  const B = await Client.open(sv.port, `${sv.port}:${lb}`, dirB);
  return [A, B];
}

// (1) sustained rally, zero whiffs
async function suiteRally() {
  const W = 'rally', sv = await startServer();
  let k = 0; const shots = [{ n: 0.3, dir: 0.5, lob: 0 }, { n: 0.7, dir: -0.6, lob: 0 }, { n: 0.1, dir: 0, lob: 0.5 }, { n: 1, dir: 0.9, lob: 0 }];
  const d = () => good(shots[k++ % shots.length]);
  const [A, B] = await pair(sv, d, d);
  await waitFor(A, 'hit', () => A.hits.length >= 30, SEC(90), '30 hits');
  ok(W, A.hits.length >= 30, `only ${A.hits.length} hits in 90 s`);
  const points = A.log.filter(m => m.type === 'point');
  ok(W, points.length === 0, `rally broke: ${JSON.stringify(points[0])}`);
  ok(W, A.whiffs.length + B.whiffs.length === 0, `whiffs with good timing: ${JSON.stringify([...A.whiffs, ...B.whiffs])}`);
  const gaps = A.stats.slice(1).map((h, i) => (h.tick - A.stats[i].tick) * DT);
  notes.push(`rally: ${A.hits.length} consecutive hits, 0 whiffs, time between hits ${Math.min(...gaps).toFixed(2)}..${Math.max(...gaps).toFixed(2)} s, max ball step ${A.maxStep.toFixed(2)} m/packet`);
  A.close(); B.close(); stopServer(sv);
}

// (2b) over the wire: every power/dir/lob, paddle anywhere in the box, swing anywhere in the depth of the box
async function suiteSweep(seed) {
  const W = 'sweep' + seed, sv = await startServer();
  let r = seed * 7919 + 13; const rnd = () => ((r = (r * 1103515245 + 12345) % 2147483648) / 2147483648);
  const grid = []; for (const n of [0, 0.5, 1]) for (const dir of [-1, -0.5, 0, 0.5, 1]) for (const lob of [0, 0.5, 1]) grid.push({ n, dir, lob });
  for (let i = grid.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [grid[i], grid[j]] = [grid[j], grid[i]]; }
  let k = 0;
  const d = () => good(grid[k++ % grid.length], { right: (rnd() * 2 - 1) * 0.95, up: (rnd() * 2 - 1) * 0.75, trig: -0.2 + rnd() * 1.5 });
  const [A, B] = await pair(sv, d, d);
  await waitFor(A, 'hit', () => A.hits.length >= grid.length + 5, SEC(140), 'sweep hits');
  ok(W, A.hits.length >= grid.length + 5, `only ${A.hits.length} hits`);
  ok(W, A.whiffs.length + B.whiffs.length === 0, `whiffs although inside the box: ${JSON.stringify([...A.whiffs, ...B.whiffs])}`);
  ok(W, !A.log.some(m => m.type === 'point'), 'rally broke during sweep: ' + JSON.stringify(A.log.find(m => m.type === 'point')));
  const xs = A.stats.map(h => h.dx), as = A.stats.map(h => h.ahead), px = A.log.filter(m => m.type === 'hit').map(m => m.p[0]);
  notes.push(`sweep${seed}: ${A.hits.length} hits over all n/dir/lob; contact dx ${Math.min(...xs).toFixed(2)}..${Math.max(...xs).toFixed(2)}, ahead ${Math.min(...as).toFixed(2)}..${Math.max(...as).toFixed(2)}, ball x at contact ${Math.min(...px).toFixed(1)}..${Math.max(...px).toFixed(1)}, max speed ${A.maxSpeed.toFixed(1)} m/s, max step ${A.maxStep.toFixed(2)} m, paddle z ${A.zRange.map(z => z.toFixed(1)).join('..')}`);
  A.close(); B.close(); stopServer(sv);
  return A.stats;
}

// one scripted point: receiver returns the serve with `ret`, the SERVER-side player is the subject on that ball (idx 1)
async function scriptedPoint(A, B, ret, subject) {
  const dir = (idx) => (idx === 0 ? (ret ? good(ret) : { kind: 'none' }) : idx === 1 ? subject : { kind: 'none' });
  A.director = B.director = dir;
  const mark = A.log.length, wa = A.whiffs.length, wb = B.whiffs.length, ha = A.hits.length, hb = B.hits.length;
  let subjCtx = null; const grab = c => () => { if (c.ctx && c.ctx.idx === 1) subjCtx = c.ctx; }; const ga = grab(A), gb = grab(B); A.on('state', ga); B.on('state', gb);
  const pt = await waitFor(A, 'point', null, SEC(15), 'point');
  await Promise.all([waitTicks(A, 4), waitTicks(B, 4)]);         // the loser's whiff travels on another socket: let it land
  A.off('state', ga); B.off('state', gb);
  if (!pt) return null;
  const log = A.log.slice(mark), serve = log.find(m => m.type === 'serve');
  const by = serve ? serve.by : A.serveBy, S = A.side === by ? A : B, Rv = S === A ? B : A;
  return { pt, by, S, log, subjWhiffs: S.whiffs.slice(S === A ? wa : wb), recvWhiffs: Rv.whiffs.slice(S === A ? wb : wa),
    subjHits: log.filter(m => m.type === 'hit' && m.side === by), ctx: subjCtx, hit: S.hits.slice(S === A ? ha : hb).filter(h => h.ctx && h.ctx.idx === 1).pop(), bounces: log.filter(m => m.type === 'bounce').length };
}

// (3) whiffs with the right reason, never a hit
async function suiteWhiffs() {
  const W = 'whiffs', sv = await startServer(Math.min(SCALE, 4));
  const [A, B] = await pair(sv);
  const flat = { n: 0.5, dir: 0, lob: 0 }, lobbed = { n: 0, dir: 0, lob: 1 };
  const cases = [
    ['early', flat, { kind: 'early' }], ['late', flat, { kind: 'late' }],
    ['right', flat, good(null, { right: -2.0, trig: 0.3 })],     // paddle 2 m too far LEFT -> ball was to your right
    ['left', flat, good(null, { right: 2.0, trig: 0.3 })],
    ['low', flat, good(null, { y: 2.3, trig: 0.3 })],            // paddle too high -> ball was low
    ['high', lobbed, good(null, { y: 0.3, trig: 0.3 })],
    ['early', flat, { kind: 'lead', lead: 0.5 }],                // 500 ms before the ball arrives: outside the forgiving window
  ];
  for (const [why, ret, subj] of [...cases, ...cases]) {        // twice so both sides get every case
    const r = await scriptedPoint(A, B, ret, subj);
    if (!ok(W, r, `${why}: no point`)) continue;
    ok(W, r.subjHits.length === 0, `${why}: subject still hit the ball`);
    ok(W, r.subjWhiffs.length === 1 && r.subjWhiffs[0].why === why, `${why} (side ${r.by}): got whiffs ${JSON.stringify(r.subjWhiffs)}`);
    ok(W, r.recvWhiffs.length === 0, `${why}: other player got a whiff ${JSON.stringify(r.recvWhiffs)}`);
    ok(W, r.pt.winner === 1 - r.by, `${why}: wrong winner ${JSON.stringify(r.pt)}`);
  }
  notes.push(`whiffs: ${cases.length * 2} scripted misses, each produced exactly one whiff with the expected reason and no hit`);
  A.close(); B.close(); stopServer(sv);
}

// (4) forgiving window
async function suiteWindow() {
  const W = 'window', sv = await startServer(Math.min(SCALE, 3));
  const [A, B] = await pair(sv);
  const ret = { n: 0.5, dir: 0.3, lob: 0 }, leads = [];
  for (const lead of [0.1, 0.2, 0.26, 0.29, 0.31, 0.1, 0.2, 0.26, 0.29, 0.31]) {
    const r = await scriptedPoint(A, B, ret, { kind: 'lead', lead, shot: { n: 0.5, dir: 0, lob: 0 } });
    if (!ok(W, r && r.ctx && r.ctx.swungTick != null, `lead ${lead}: no point / no swing`)) continue;
    const c = r.ctx, arrive = r.hit ? r.hit.tick : c.enterTick - 1;
    const measured = (arrive - c.swungTick) * DT;               // sim time from the server accepting the swing to the ball entering the box
    if (measured > 0.3) { notes.push(`window: (a ${lead}s lead came out at ${(measured * 1000).toFixed(0)} ms, beyond the promise; ${r.hit ? 'hit' : 'whiff'})`); continue; }
    if (!r.hit) { fail(W, `swing ${(measured * 1000).toFixed(0)} ms before arrival did not connect, whiffs ${JSON.stringify(r.subjWhiffs)}`); continue; }
    leads.push(measured);
    ok(W, r.hit.stat.ahead > ZONE.front - 0.3, `lead ${lead}: did not connect on arrival, ball was already ${r.hit.stat.ahead.toFixed(2)} m from the paddle plane`);
    ok(W, r.subjWhiffs.length === 0, `lead ${lead}: hit AND whiff`);
  }
  ok(W, Math.max(...leads) >= 0.25, `never actually tested a long lead (max ${Math.max(...leads)})`);
  for (const trig of [1.4, 0.5, -0.4]) {                        // ball already in the box -> immediate
    const r = await scriptedPoint(A, B, ret, good({ n: 0.5, dir: 0, lob: 0 }, { trig }));
    const c = r && r.hit && r.hit.ctx;
    if (!ok(W, c, `in-box swing (trig ${trig}) did not connect`)) continue;
    ok(W, r.hit.tick - c.swungTick <= 1, `in-box swing connected ${r.hit.tick - c.swungTick} ticks after the swing`);
  }
  notes.push(`window: swings ${leads.map(l => (l * 1000).toFixed(0)).join('/')} ms before the ball arrived all connected the tick it entered the box; in-box swings connected within 1 tick`);
  A.close(); B.close(); stopServer(sv);
}

// (5) scoring
async function suiteScoring() {
  const W = 'scoring', sv = await startServer();
  let [A, B] = await pair(sv);
  const serves = [], exp = [0, 0];
  const check = (r, winner, why, what) => {
    if (!ok(W, r, what + ': no point')) return;
    serves.push(r.by); exp[winner(r)]++;
    ok(W, r.pt.winner === winner(r) && r.pt.why === why, `${what}: got ${JSON.stringify(r.pt)} (serve by ${r.by}, ${r.bounces} bounces)`);
    ok(W, r.pt.score[0] === exp[0] && r.pt.score[1] === exp[1], `${what}: score ${r.pt.score} expected ${exp}`);
  };
  for (let i = 0; i < 2; i++) check(await scriptedPoint(A, B, null, { kind: 'none' }), r => r.by, 'double bounce', 'unreturned serve');
  for (let i = 0; i < 2; i++) check(await scriptedPoint(A, B, { n: 1, dir: 0, lob: 0 }, { kind: 'none' }), r => 1 - r.by, 'double bounce', 'unreturned hard return');
  for (let i = 0; i < 2; i++) check(await scriptedPoint(A, B, { n: 0, dir: 0, lob: 1 }, { kind: 'none' }), r => 1 - r.by, 'passed', 'unreturned deep lob');
  ok(W, serves[0] === 0, 'first serve of a match should be side 0');
  ok(W, serves.every((s, i) => i === 0 || s !== serves[i - 1]), 'serve order ' + serves.join(''));
  ok(W, A.st.score[0] + A.st.score[1] === 6, 'state score ' + A.st.score);
  // a new pair -> score resets, one fresh serve
  B.close(); await waitFor(A, 'state', st => !st.paddles[B.side], SEC(2), 'B gone');
  ok(W, A.st.score[0] + A.st.score[1] === 6, 'score should survive until a new pair forms');
  A.matchRestart = true;
  const C = await Client.open(sv.port, `${sv.port}:C`);
  ok(W, C.side === B.side, `newcomer got side ${C.side}`);
  const st = await waitFor(A, 'state', s => s.paddles[0] && s.paddles[1], SEC(1), 'pair');
  ok(W, st && st.score[0] === 0 && st.score[1] === 0, 'score not reset for new pair: ' + (st && st.score));
  const sv2 = await waitFor(A, 'serve', null, SEC(3), 'serve for new pair');
  ok(W, sv2 && sv2.by === 0, 'new pair: no serve by side 0: ' + JSON.stringify(sv2));
  notes.push(`scoring: serve order ${serves.join('')}, double bounce + passed + score reset verified`);
  A.close(); C.close(); stopServer(sv);
}

// (6) bot + connection churn + hostile input
async function suiteBot() {
  const W = 'bot', sv = await startServer();
  let shot = { n: 0.25, dir: 0, lob: 0 }, flip = 1;
  const human = () => good(typeof shot === 'function' ? shot() : shot);
  const H = await Client.open(sv.port, `${sv.port}:H`, human);
  await waitTicks(H, SEC(1));
  ok(W, !H.log.some(m => m.type === 'serve'), 'served to a lone player');
  H.send({ type: 'bot' });
  const st = await waitFor(H, 'state', s => s.paddles[1 - H.side] && s.paddles[1 - H.side].bot, SEC(1), 'bot paddle');
  ok(W, st, 'bot never appeared'); ok(W, st && st.paddles[H.side].bot === false, 'human flagged as bot');
  const botSide = 1 - H.side;
  const count = () => ({ bot: H.log.filter(m => m.type === 'hit' && m.side === botSide).length, swung: H.log.filter(m => m.type === 'swung' && m.side === botSide).length, pts: [0, 1].map(k => H.log.filter(m => m.type === 'point' && m.winner === k).length) });
  await waitFor(H, 'hit', () => count().bot >= 8, SEC(60), 'bot returning easy balls');
  const easy = count();
  ok(W, easy.bot >= 8, `bot only returned ${easy.bot} easy balls in 60 s`);
  ok(W, easy.swung >= easy.bot, 'bot hits without a swung broadcast');
  shot = () => ({ n: 1, dir: (flip = -flip), lob: 0 });          // now try to beat it: hard, corner to corner
  await waitFor(H, 'point', () => count().pts[H.side] - easy.pts[H.side] >= 3, SEC(150), 'human beating bot');
  const hard = count();
  ok(W, hard.pts[H.side] - easy.pts[H.side] >= 3, `bot is not beatable: human won ${hard.pts[H.side] - easy.pts[H.side]} points in 150 s of corner-to-corner drives`);
  ok(W, H.whiffs.length === 0, 'human whiffed vs bot: ' + JSON.stringify(H.whiffs));
  notes.push(`bot: returned ${easy.bot} easy balls (points H/bot ${easy.pts[H.side]}/${easy.pts[botSide]}); vs hard corners human took ${hard.pts[H.side] - easy.pts[H.side]} points while bot made ${hard.bot - easy.bot} more returns; paddle z range ${H.zRange.map(z => z.toFixed(1)).join('..')}`);

  // second human replaces the bot
  shot = { n: 0.4, dir: 0.3, lob: 0 }; H.matchRestart = true;
  const H2 = await Client.open(sv.port, `${sv.port}:H2`, human);
  ok(W, H2.side === botSide, 'second human did not take the bot side');
  const s2 = await waitFor(H, 'state', s => s.paddles[botSide] && !s.paddles[botSide].bot, SEC(1), 'bot replaced');
  ok(W, s2 && s2.score[0] === 0 && s2.score[1] === 0 && !s2.live, 'bot->human: score/live not reset ' + JSON.stringify(s2 && [s2.score, s2.live]));
  ok(W, await waitFor(H, 'serve', null, SEC(3), 'serve after bot replaced'), 'no serve after the bot was replaced');
  let h0 = H.hits.length; await waitFor(H, 'hit', () => H.hits.length - h0 >= 5, SEC(20), 'rally');
  ok(W, H.hits.length - h0 >= 5, 'humans could not rally after replacing bot');

  // third connection is refused and harmless
  await new Promise(res => { const x = new WebSocket('ws://localhost:' + sv.port); x.on('close', res); x.on('error', res); x.on('message', raw => { if (JSON.parse(raw).type !== 'full') fail(W, 'third client got a message'); }); setTimeout(res, 2000); });

  // hostile input mid-rally
  for (const junk of ['null', '[]', '"x"', '7', '{', '{"type":"swing"}', '{"type":"swing","power":"abc","dir":null,"lob":{}}', '{"type":"swing","power":1e999,"dir":-1e999,"lob":1e999}',
    '{"type":"paddle","x":"abc","y":null,"q":[null,1,"a",{}]}', '{"type":"paddle","x":1e999,"y":-1e999,"q":[1e999,0,0,0]}', '{"type":"paddle"}', '{"type":"bot"}', Buffer.from([0, 255, 1, 2])]) H2.send(junk);
  h0 = H.hits.length; await waitFor(H, 'hit', () => H.hits.length - h0 >= 3, SEC(40), 'rally after junk');
  ok(W, H.hits.length - h0 >= 3 && !sv.dead, 'server unhealthy after junk input');
  ok(W, H.st.paddles.every(p => p && !p.bot), '{type:bot} with two humans changed the players');

  // disconnect mid-rally, reconnect, repeatedly; also during the pause after a point
  let stay = H, leaver = H2;
  for (let i = 0; i < 4; i++) {
    if (i >= 2) { stay.director = leaver.director = () => ({ kind: 'none' }); await waitFor(stay, 'point', null, SEC(20), 'point before leaving'); await waitTicks(stay, 20); }
    else { await waitFor(stay, 'hit', null, SEC(20), 'hit before leaving'); await waitTicks(stay, 15); }
    leaver.close();
    const gone = await waitFor(stay, 'state', s => !s.paddles[leaver.side], SEC(1), 'leaver removed');
    ok(W, gone && !gone.live, `churn ${i}: ball still live after disconnect`);
    const lone = stay.log.length; await waitTicks(stay, SEC(2.5));
    ok(W, !stay.log.slice(lone).some(m => m.type === 'serve' || m.type === 'point'), `churn ${i}: serve/point while alone`);
    stay.matchRestart = true; stay.director = human;
    const N = await Client.open(sv.port, `${sv.port}:N${i}`, human);
    ok(W, N.side === leaver.side, `churn ${i}: newcomer side ${N.side}`);
    const m0 = stay.log.length;
    ok(W, await waitFor(stay, 'serve', null, SEC(3), 'serve after reconnect'), `churn ${i}: NO SERVE after reconnect (stuck)`);
    h0 = stay.hits.length; await waitFor(stay, 'hit', () => stay.hits.length - h0 >= 3, SEC(20), 'rally after reconnect');
    ok(W, stay.hits.length - h0 >= 3, `churn ${i}: no rally after reconnect`);
    ok(W, stay.log.slice(m0).filter(m => m.type === 'serve').length === 1, `churn ${i}: ${stay.log.slice(m0).filter(m => m.type === 'serve').length} serves after reconnect`);
    ok(W, stay.st.score[0] + stay.st.score[1] === 0, `churn ${i}: score not reset`);
    [stay, leaver] = [N, stay];                                  // next round the veteran leaves
  }
  // both leave at once, a fresh pair arrives, then the lone survivor asks for a bot again
  stay.close(); leaver.close(); await sleep(200);
  const [P, Q] = await pair(sv, human, human, 'P', 'Q');
  ok(W, await waitFor(P, 'serve', null, SEC(3), 'serve for fresh pair'), 'no serve for a fresh pair after everyone left');
  Q.close(); await waitFor(P, 'state', s => !s.paddles[Q.side], SEC(1), 'Q gone');
  P.matchRestart = true; P.send({ type: 'bot' }); P.send({ type: 'bot' });
  ok(W, await waitFor(P, 'serve', null, SEC(3), 'serve vs new bot'), 'no serve after asking for a bot again');
  h0 = P.log.filter(m => m.type === 'hit').length;
  await waitFor(P, 'hit', () => P.log.filter(m => m.type === 'hit').length - h0 >= 4, SEC(30), 'rally vs new bot');
  ok(W, P.log.filter(m => m.type === 'hit').length - h0 >= 4, 'no rally against the second bot');
  ok(W, !sv.dead, 'server died'); P.close(); stopServer(sv);
}

// (7) footwork: a player who only does x/y + timing meets the ball within 1 m of the paddle
async function suiteFootwork() {
  const W = 'footwork', sv = await startServer();
  const grid = []; for (const n of [0, 0.5, 1]) for (const dir of [-1, 0, 1]) for (const lob of [0, 0.5, 1]) grid.push({ n, dir, lob });
  let k = 0; const d = () => ({ kind: 'timing', shot: grid[k++ % grid.length] });
  const [A, B] = await pair(sv, d, d);
  await waitFor(A, 'hit', () => A.hits.length >= grid.length + 3, SEC(90), 'footwork hits');
  ok(W, A.hits.length >= grid.length + 3, `only ${A.hits.length} hits`);
  ok(W, A.whiffs.length + B.whiffs.length === 0 && !A.log.some(m => m.type === 'point'), `timing-only player missed: ${JSON.stringify([...A.whiffs, ...B.whiffs])}`);
  const dz = A.stats.map(h => h.dz), ys = A.stats.map(h => h.y);
  ok(W, Math.max(...dz) <= 1.0, `paddle z was ${Math.max(...dz).toFixed(2)} m from the ball at contact`);
  notes.push(`footwork: ${A.hits.length} hits by a timing-only player, |ball z - paddle z| at contact ${Math.min(...dz).toFixed(2)}..${Math.max(...dz).toFixed(2)} m (mean ${(dz.reduce((a, b) => a + b) / dz.length).toFixed(2)}), ball height at contact ${Math.min(...ys).toFixed(2)}..${Math.max(...ys).toFixed(2)} m, paddle z ${A.zRange.map(z => z.toFixed(1)).join('..')}`);
  A.close(); B.close(); stopServer(sv);
}

// ---------- main ----------
const t0 = Date.now();
sweepSolve();
const only = process.argv[2];
const suites = { rally: suiteRally, sweep1: () => suiteSweep(1), sweep2: () => suiteSweep(2), whiffs: suiteWhiffs, window: suiteWindow, scoring: suiteScoring, bot: suiteBot, footwork: suiteFootwork };
const run = Object.entries(suites).filter(([k]) => !only || k.startsWith(only));
const res = await Promise.allSettled(run.map(([name, fn]) => fn().then(() => console.log(`  done ${name} (${((Date.now() - t0) / 1000).toFixed(1)} s)`))));
res.forEach((r, i) => { if (r.status === 'rejected') fail(run[i][0], 'suite crashed: ' + (r.reason && r.reason.stack || r.reason)); });
for (const p of procs) p.kill('SIGKILL');
feelTable();
console.log('\n' + notes.map(n => '  ' + n).join('\n'));
console.log(fails.length ? `\n${fails.length} FAILURES` : `\nALL PASSED in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
process.exit(fails.length ? 1 : 0);
