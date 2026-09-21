// web/scene.js, the docs/API-NEXT.md section 2 work: spectator views, free cam input, attract rally, menu mode, frozen ball, Matt, hiss by spin,
// ball contrast. Drives test/scene-preview.html in headless Chrome; serves the repo itself.   node test/scene-next.mjs [port]   (8730 by default)
// Screenshots land in test/ui-shots/scene-next/. LOOK at them: the asserts cannot tell a good picture from a bad one. QUICK=1 skips the 60 s live rally.
import puppeteer from 'puppeteer-core';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('..', import.meta.url)), port = +process.argv[2] || 8730, shots = root + 'test/ui-shots/scene-next/', sleep = ms => new Promise(r => setTimeout(r, ms));
fs.mkdirSync(shots, { recursive: true });
const http = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: root, stdio: 'ignore' });
let browser = null; const bye = async c => { if (browser) await browser.close().catch(() => {}); http.kill(); process.exit(c); };
setTimeout(() => { console.log('SCENE NEXT FAIL (timeout)'); bye(2); }, 400000);
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, e => { console.log('SCENE NEXT FAIL', e); bye(2); });
await sleep(700);
browser = await puppeteer.launch({ executablePath: process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new',
  args: ['--use-gl=angle', '--enable-unsafe-swiftshader', '--autoplay-policy=no-user-gesture-required'] });
let fail = 0; const errs = [], ok = (c, m) => { console.log((c ? '  ok   ' : '  FAIL ') + m); if (!c) fail++; return c; };
// every page names its own ports: a page without &game= would reach for the player's live server
async function open(query, w = 1280, h = 720, before) {
  const page = await browser.newPage(); await page.setViewport({ width: w, height: h }); if (before) await page.evaluateOnNewDocument(before);
  page.on('console', m => { if (m.type() === 'error') errs.push(m.text()); }); page.on('pageerror', e => errs.push(String(e)));
  await page.goto(`http://127.0.0.1:${port}/test/scene-preview.html?${query}&clean=1&game=${port}&bridge=${port}`, { waitUntil: 'load' });
  if (/(^|&)t=/.test(query)) await page.waitForFunction(() => document.title.startsWith('ready'), { timeout: 60000 });
  await page.waitForFunction(() => window.__scenery, { timeout: 20000 }).catch(() => errs.push('scenery never arrived: ' + query));
  return page;
}
const settle = page => page.evaluate(() => { for (let i = 1; i <= 4; i++) __scene.render(1e7 + i * 40); });      // a few frames with the scenery in

// ---------- 1. the four views, both window shapes ----------
console.log('views');
for (const [w, h] of [[1280, 720], [600, 900]]) for (const v of ['broadcast', 'split', 'pov0', 'pov1', 'free']) {
  const page = await open(`spectate=1&matt=1&opp=human&view=${v.replace(/\d/, '')}&pov=${v.endsWith('1') ? 1 : 0}&t=3.9`, w, h); await settle(page);
  const r = await page.evaluate(() => { const sc = __scene, d = sc._dbg, R = d.renderer, calls = [], real = R.render.bind(R), fences = [];
    d.scene.traverse(o => { const g = o.geometry && o.geometry.parameters; if (g && g.height === 2.4 && g.width > 10) fences[o.position.z > 0 ? 0 : 1] = o; if (g && g.height === 1.3 && g.width > 20) fences[o.position.x > 0 ? 2 : 3] = o; });
    R.render = (s, c) => { const vp = R.getViewport(new THREE.Vector4()); calls.push({ vp: [vp.x, vp.y, vp.z, vp.w], camZ: +c.position.z.toFixed(2), camX: +c.position.x.toFixed(2), aspect: +c.aspect.toFixed(3), fov: +c.fov.toFixed(1),
      av: d.pads.map(p => p.avatar.visible), arm: d.pads.map(p => p.forearm.visible), fence: fences.map(f => f.visible), px: d.pads.map(p => +p.pos.clone().project(c).x.toFixed(3)) }); real(s, c); };
    const drew = sc.render(1e7 + 400); R.render = real;
    return { drew, calls, view: d.view(), scissor: R.getScissorTest(), seat: null }; });
  await page.screenshot({ path: `${shots}${v}-${w}x${h}.png` });
  const c = r.calls, tag = `${v} ${w}x${h}`;
  ok(r.drew === true && r.view.spectator && r.view.name === v.replace(/\d/, ''), `${tag}: spectator view is ${r.view.name}, render() returned true`);
  if (v === 'broadcast') ok(c.length === 1 && c[0].px[0] < c[0].px[1] && Math.abs(c[0].px[0]) < 0.97 && Math.abs(c[0].px[1]) < 0.97 && c[0].av[0] && c[0].av[1] && !c[0].arm[0] && !c[0].arm[1] && !c[0].fence[2] && c[0].fence[0] && c[0].fence[1],
    `${tag}: side 0 on the LEFT (x ${c[0].px[0]}), side 1 on the right (x ${c[0].px[1]}), both in frame, both avatars, no ghost arm, the +x wall out of the way (fov ${c[0].fov})`);
  if (v === 'split') { const L = c[0], Rt = c[1] || {}, half = Math.floor(w / 2);
    ok(c.length === 2 && L.vp[0] === 0 && L.vp[2] === half && Rt.vp[0] === half && Rt.vp[2] === w - half && L.vp[3] === h && Math.abs(L.aspect - half / h) < 0.01 && !r.scissor, `${tag}: two viewports in one render(), each half wide, aspect ${L.aspect}, scissor test off again`);
    ok(L.camZ > 0 && !L.av[0] && L.arm[0] && L.av[1] && !L.arm[1] && !L.fence[0] && L.fence[1], `${tag}: left half = side 0's eyes (own avatar hidden, ghost arm, own fence gone, far fence up)`);
    ok(Rt.camZ < 0 && !Rt.av[1] && Rt.arm[1] && Rt.av[0] && !Rt.arm[0] && !Rt.fence[1] && Rt.fence[0], `${tag}: right half = side 1's eyes`); }
  if (v.startsWith('pov')) { const s = +v[3], k = c[0]; ok(c.length === 1 && r.view.side === s && (s ? k.camZ < 0 : k.camZ > 0) && !k.av[s] && k.arm[s] && k.av[1 - s] && !k.fence[s] && k.fence[1 - s], `${tag}: behind side ${s} (camera z ${k.camZ}), their avatar hidden, ghost arm shown, their fence gone`); }
  if (v === 'free') ok(c.length === 1 && c[0].camX > 8 && !c[0].fence[2] && c[0].av[0] && c[0].av[1], `${tag}: free cam outside the +x wall, which is hidden (camera x ${c[0].camX})`);
  await page.close();
}
{ const page = await open('side=1&t=1'); const r = await page.evaluate(() => { const sc = __scene; return { a: sc.setView('free'), b: sc.getView(), bad: (sc.setSide(null), sc.setView('nonsense')), c: sc.setView('pov', 1), d: (sc.setSide(0), sc.getView()) }; });
  ok(r.a.name === 'play' && r.a.side === 1 && r.b.name === 'play' && r.bad.name === 'broadcast' && r.c.name === 'pov' && r.c.side === 1 && r.d.name === 'play' && r.d.side === 0, `a seat always answers play; setSide(null) lands in broadcast; an unknown view changes nothing; a seat leaves spectator mode (${JSON.stringify(r)})`); await page.close(); }

// ---------- 2. free cam: real mouse, real wheel ----------
console.log('free cam');
{ const page = await open('spectate=1&view=free&t=2'); const F = () => page.evaluate(() => ({ ...__scene._dbg.free, y: __scene._dbg.camera.position.y, x: __scene._dbg.camera.position.x, touch: __scene._dbg.renderer.domElement.style.touchAction }));
  const drag = async (dx, dy) => { await page.mouse.move(640, 360); await page.mouse.down(); await page.mouse.move(640 + dx, 360 + dy, { steps: 8 }); await page.mouse.up(); await settle(page); };
  const a = await F(); await drag(100, 40); const b = await F();
  ok(Math.abs(b.yaw - a.yaw - 25) < 0.01 && Math.abs(b.pitch - a.pitch - 10) < 0.01 && a.touch === 'none', `drag 100 x 40 px = 25 deg of yaw, 10 deg of pitch (0.25 deg per px); touch-action none (${a.yaw}/${a.pitch} -> ${b.yaw}/${b.pitch})`);
  await page.mouse.move(640, 360); await page.mouse.wheel({ deltaY: 300 }); await settle(page); const c = await F(); ok(Math.abs(c.dist - b.dist * Math.exp(0.36)) < 0.01, `wheel 300 zooms out by e^0.36 (${b.dist} -> ${c.dist.toFixed(2)} m)`);
  await drag(0, 900); const hi = await F(); await drag(0, -900); const lo = await F(); await page.mouse.move(640, 360); await page.mouse.wheel({ deltaY: 9000 }); await settle(page); const far = await F(); await page.mouse.wheel({ deltaY: -90000 }); await settle(page); const near = await F();
  ok(hi.pitch === 80 && lo.pitch === 6 && far.dist === 30 && near.dist === 6 && near.y >= 1.2, `clamps hold: pitch ${lo.pitch}..${hi.pitch}, distance ${near.dist}..${far.dist} m, eye ${near.y.toFixed(2)} m up`);
  const push = await page.evaluate(() => { const d = __scene._dbg; Object.assign(d.free, { yaw: 0, pitch: 6, dist: 8.3 }); __scene.render(2e7); const x = d.camera.position.x; Object.assign(d.free, { yaw: NaN }); __scene.render(2e7 + 40); return { x, reset: { ...d.free } }; });
  ok(push.x >= 8.25 + 0.6 - 1e-6 && push.reset.yaw === 20 && push.reset.dist === 17, `an eye inside a wall's thickness is pushed out (x ${push.x.toFixed(2)}, wall at 8.25); a NaN orbit resets`);
  await page.evaluate(() => { Object.assign(__scene._dbg.free, { yaw: 123, pitch: 33, dist: 12 }); __scene.setView('broadcast'); }); await drag(200, 100); await page.mouse.wheel({ deltaY: 500 }); const off = await F();
  await page.evaluate(() => __scene.setView('free')); const back = await F();
  ok(off.yaw === 123 && off.pitch === 33 && off.dist === 12 && off.touch === '' && back.yaw === 123 && back.touch === 'none', 'outside the free view the mouse does nothing, and the orbit is where it was left on return');
  await page.evaluate(() => __scene.setMenu(true)); await drag(200, 100); const m = await F(); ok(m.yaw === 123 && m.touch === '', 'under a menu the mouse does nothing either'); await page.close(); }

// ---------- 3. attract rally + menu mode ----------
console.log('attract + menu');
const countAudio = () => { window.__ac = 0; for (const k of ['AudioContext', 'webkitAudioContext']) { const O = window[k]; if (O) window[k] = class extends O { constructor(...a) { super(...a); window.__ac++; } }; } };
{ const page = await open('attract=1&t=0.1'), T = Date.now();        // ten minutes of rally, as fast as the CPU goes (the picture is not needed for this)
  const r = await page.evaluate(() => { const sc = __scene, d = sc._dbg, R = d.renderer, real = R.render; R.render = () => {}; let ms = 3e7, minY = 9, maxSpeed = 0, side = [0, 0], kinds = new Set(); const at = d.attract, prev = new THREE.Vector3();
    for (let i = 0; i < 36000; i++) { ms += 1000 / 60; sc.render(ms); const p = d.ballMesh.position; minY = Math.min(minY, p.y); if (i) maxSpeed = Math.max(maxSpeed, p.distanceTo(prev) * 60); prev.copy(p); kinds.add(Math.round((at.hitAt - at.t0) * 4)); side[at.by]++; }
    R.render = real; return { stats: at.stats, minY, maxSpeed, kinds: kinds.size, side, bot: d.pads.map(p => p.bot), matt: d.pads.map(p => p.matt), has: d.pads.map(p => p.has) }; });
  ok(r.stats.shots > 300 && r.stats.late === 0 && r.stats.out === 0 && r.stats.net >= 0.25, `10 min of rally in ${((Date.now() - T) / 1000).toFixed(0)} s: ${r.stats.shots} shots, ${r.stats.late} missed, ${r.stats.out} out, lowest net clearance ${r.stats.net.toFixed(2)} m, receiver worst ${(r.stats.gap * 100).toFixed(0)} cm from the spot`);
  ok(r.maxSpeed < 40 && r.minY >= 0.109 && r.kinds >= 5, `the ball never jumps (fastest ${r.maxSpeed.toFixed(1)} m/s) or sinks (lowest ${r.minY.toFixed(3)} m); ${r.kinds} different flight times`);
  ok(r.bot[0] && r.bot[1] && !r.matt[0] && r.matt[1], 'side 1 is Matt, side 0 a generic player, both on the canned swing, although the fake server kept pushing its own paddles and ball');
  await page.close(); }
if (!process.env.QUICK) { const page = await open('attract=1&menu=1', 1280, 720, countAudio); await sleep(1500); await page.screenshot({ path: `${shots}menu-attract-1280x720.png` });
  const v0 = await page.evaluate(() => __scene._dbg.view()); await sleep(5000); const v1 = await page.evaluate(() => __scene._dbg.view()), fps = (v1.drawn - v0.drawn) / 5;
  ok(v1.menu && v1.attract && v1.pixelRatio === 0.5 && fps > 25 && fps < 33, `menu mode: pixel ratio ${v1.pixelRatio} (half of 1), ${fps.toFixed(1)} frames drawn a second`);
  ok(await page.evaluate(() => __scene._dbg.renderer.shadowMap.autoUpdate === false), 'shadow map frozen after its one frame');
  await sleep(53500); const s = await page.evaluate(() => ({ st: __scene._dbg.attract.stats, ac: window.__ac, t: __scene._dbg.attract.t }));
  ok(s.t > 55 && s.st.shots > 25 && s.st.late === 0 && s.st.out === 0 && s.ac === 0, `60 s live: ${s.st.shots} shots, ${s.st.late} missed, ${s.st.out} out, AudioContexts made: ${s.ac} (rally clock ${s.t.toFixed(0)} s)`);
  await page.screenshot({ path: `${shots}menu-attract-late-1280x720.png` });
  const hid = await page.evaluate(async () => { Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' }); const a = __scene._dbg.view().drawn, r = __scene.render(performance.now() + 500); await new Promise(r => setTimeout(r, 600)); const b = __scene._dbg.view().drawn; delete document.visibilityState; return { a, b, r }; });
  ok(hid.r === false && hid.a === hid.b, 'tab hidden: render() returns false and draws nothing');
  const ease = await page.evaluate(async () => { const d = __scene._dbg, c = d.camera, snap = () => ({ z: c.position.z, y: c.position.y, lens: c.projectionMatrix.elements[5] }), w = ms => new Promise(r => setTimeout(r, ms));
    const a = snap(); __scene.setMenu(false); await w(300); const b = snap(); await w(1200); return { a, b, c: snap() }; });        // lens = 1 / tan(fov / 2): 1.73 at the menu's 60 deg, 2.48 at the play camera's 44
  ok(Math.abs(ease.a.z - 13.7) < 0.01 && Math.abs(ease.a.y - 3.4) < 0.15 && Math.abs(ease.a.lens - 1.732) < 0.01 && ease.b.lens > 1.78 && ease.b.lens < 2.4 && Math.abs(ease.c.lens - 2.475) < 0.01,
    `menu camera (z ${ease.a.z.toFixed(1)}, y ${ease.a.y.toFixed(2)}, lens ${ease.a.lens.toFixed(2)}) eases into the play camera (lens ${ease.b.lens.toFixed(2)} after 0.3 s, ${ease.c.lens.toFixed(2)} when there)`);
  const w0 = await page.evaluate(() => __scene._dbg.view()); await sleep(3000); const w1 = await page.evaluate(() => ({ ...__scene._dbg.view(), auto: __scene._dbg.renderer.shadowMap.autoUpdate })), fps2 = (w1.drawn - w0.drawn) / 3;
  ok(!w1.menu && w1.pixelRatio === 1 && w1.auto === true && fps2 > 50, `setMenu(false): pixel ratio ${w1.pixelRatio}, shadows live, ${fps2.toFixed(1)} frames a second`);
  const st = await page.evaluate(async () => { const d = __scene._dbg; __scene.stopAttract(); const now = { ball: d.ballMesh.visible, has: d.pads.map(p => p.has), attract: d.view().attract }; await new Promise(r => setTimeout(r, 700)); return { now, later: { has: d.pads.map(p => p.has), bot: d.pads.map(p => p.bot), matt: d.pads.map(p => p.matt) } }; });
  ok(!st.now.ball && !st.now.has[0] && !st.now.has[1] && !st.now.attract && st.later.has[0] && st.later.has[1] && !st.later.bot[0] && !st.later.matt[0] && st.later.matt[1], 'stopAttract: ball and both players gone at once; the next packets draw the real match (a person at side 0, Matt at side 1)');
  await page.close();
  const tall = await open('attract=1&menu=1', 600, 900); await sleep(2500); await tall.screenshot({ path: `${shots}menu-attract-600x900.png` }); await tall.close();
  const hi = await open('attract=1&menu=1&side=1', 1280, 720); await hi.setViewport({ width: 1280, height: 720, deviceScaleFactor: 2 }); await sleep(1200); const pr = await hi.evaluate(() => (__scene.resize(), __scene._dbg.view().pixelRatio)); ok(pr === 1, `on a 2x screen the menu renders at ${pr}x`); await hi.close(); }
{ const page = await open('side=1&menu=1&t=3.2'); await settle(page); await page.screenshot({ path: `${shots}menu-seated-side1-1280x720.png` });
  const r = await page.evaluate(() => { const d = __scene._dbg; d.cam.shake = 0; __scene.onEvent({ type: 'hit', side: 0, n: 1, kind: 'smash', p: [0, 1, 3], spin: 0 }); __scene.setViewer({ x: 1, y: 1 });
    return { z: d.camera.position.z, shake: d.cam.shake, rings: d.scene.children.filter(o => o.renderOrder === 4 && o.visible).length }; });
  ok(r.z < -13 && r.shake === 0 && r.rings === 0, `seated at side 1 the menu camera stands behind side 1 (z ${r.z.toFixed(1)}); a hit under a menu raises no shake and no rings`); await page.close(); }

// ---------- 4. menu cost ----------
console.log('menu cost');
{ const page = await open('attract=1&t=0.1'); const cost = await page.evaluate(() => { const sc = __scene, d = sc._dbg, gl = d.renderer.getContext(), px = new Uint8Array(4), out = {}; let ms = 5e7; d.renderer.info.autoReset = false;      // three resets its counters AFTER the shadow pass: count by hand, or the shadow map's draws never show
    for (const on of [false, true, false]) { sc.setMenu(on); for (let i = 0; i < 30; i++) sc.render(ms += 40); const N = 150, t0 = performance.now(); let calls = 0, tris = 0;
      for (let i = 0; i < N; i++) { d.renderer.info.reset(); sc.render(ms += 40); calls += d.renderer.info.render.calls; tris += d.renderer.info.render.triangles; } gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);      // wait for the GPU
      out[on ? 'menu' : out.off ? 'offAgain' : 'off'] = { ms: (performance.now() - t0) / N, calls: calls / N, tris: Math.round(tris / N), buf: gl.drawingBufferWidth + 'x' + gl.drawingBufferHeight }; }
    return out; });
  console.log(`    setMenu(false): ${cost.off.ms.toFixed(2)} ms a frame, ${cost.off.calls.toFixed(0)} draw calls, ${cost.off.tris} triangles, buffer ${cost.off.buf}`);
  console.log(`    setMenu(true):  ${cost.menu.ms.toFixed(2)} ms a frame, ${cost.menu.calls.toFixed(0)} draw calls, ${cost.menu.tris} triangles, buffer ${cost.menu.buf}; and half as many frames`);
  ok(cost.menu.calls < cost.off.calls && cost.menu.buf === '640x360' && cost.offAgain.buf === '1280x720' && Math.abs(cost.offAgain.calls - cost.off.calls) < 3, 'the menu draws fewer calls into a quarter of the pixels, and everything is back afterwards'); await page.close(); }

// ---------- 5. frozen ball ----------
console.log('frozen');
{ const page = await open('side=0&t=3.0'); const r = await page.evaluate(() => { const sc = __scene, d = sc._dbg, f = __fake, m = d.ballMesh.position; let ms = 3000, i = 0;
    const frame = go => { ms += 1000 / 60; if (go) f.step(1 / 60); f.push(ms); sc.render(ms); return m.clone(); };
    while (!(f.ball.live && f.ball.p[1] > 1 && Math.abs(f.ball.p[2]) < 3) && i++ < 600) frame(true);       // mid-flight, over the kitchen
    const p0 = frame(true), speed = Math.hypot(...f.ball.v); f.pause(true); let moved = 0, trailN = 0; for (let k = 0; k < 120; k++) moved = Math.max(moved, frame(false).distanceTo(p0));
    const fr = d.view().frozen; f.pause(false); let leap = 0, last = p0; for (let k = 0; k < 30; k++) { const p = frame(true); leap = Math.max(leap, p.distanceTo(last)); last = p; }
    return { moved, leap, free: speed / 60, fr, err: Math.hypot(last.x - f.ball.p[0], last.y - f.ball.p[1], last.z - f.ball.p[2]), y: p0.y }; });
  ok(r.fr && r.moved === 0, `paused mid-flight (${r.y.toFixed(2)} m up): over 2 s of frames the drawn ball moved ${r.moved} m`);
  ok(r.leap < r.free * 1.6 + 0.02 && r.err < 0.2, `released: largest frame step ${r.leap.toFixed(3)} m (free flight ${r.free.toFixed(3)} m a frame), ${(r.err * 100).toFixed(0)} cm from the truth half a second on`);
  // the same through the server clock, in real time: t stands still for 1.5 s while wall time runs. Without the reset the ball leaps a coast ahead.
  const live = await page.evaluate(async () => { const sc = __scene, d = sc._dbg, m = d.ballMesh.position, G = 9.81, out = {};
    for (const mode of ['frozen', 'control']) { sc.setSide(0); sc.hideBall(); const P0 = [0, 1, 6], V0 = [0.4, 9, -4.2], truth = t => [P0[0] + V0[0] * t, P0[1] + V0[1] * t - G / 2 * t * t, P0[2] + V0[2] * t], T0 = performance.now(); let worst = 0, held = 0;
      await new Promise(done => { const tick = () => { const w = (performance.now() - T0) / 1000, paused = w > 0.5 && w < 2.0, t = w <= 0.5 ? w : paused ? 0.5 : w - 1.5;
        if (mode === 'frozen') sc.setFrozen(paused); const p = truth(t); sc.updateBall(p, [V0[0], V0[1] - G * t, V0[2]], true, undefined, 0, { t: 100 + t, b: 0, k: 0 }); sc.render(performance.now());
        const e = Math.hypot(m.x - p[0], m.y - p[1], m.z - p[2]); if (paused && w > 0.6) held = Math.max(held, e); if (w > 2.0) worst = Math.max(worst, e); if (w > 2.6) done(); else requestAnimationFrame(tick); }; tick(); });
      out[mode] = { held, worst }; } sc.setFrozen(false); return out; });
  ok(live.frozen.held < 0.25 && live.frozen.worst < 0.3 && live.control.worst > 1, `server clock: frozen ball held ${(live.frozen.held * 100).toFixed(1)} cm from where the server stopped it (the frame it was last drawn on) and resumed within ${(live.frozen.worst * 100).toFixed(0)} cm of the truth (never frozen, never reset: ${(live.control.held * 100).toFixed(0)} cm adrift while paused, ${(live.control.worst * 100).toFixed(0)} cm after)`);
  await page.close();
  const shot = await open('side=0&t=3.4&frozen=1'); await settle(shot); await shot.screenshot({ path: `${shots}frozen-1280x720.png` }); ok((await shot.evaluate(() => __scene._dbg.view())).frozen, '&frozen=1 leaves a paused frame up'); await shot.close(); }

// ---------- 6. Matt, and the hiss ----------
console.log('Matt + hiss');
{ const page = await open('spectate=1&view=free&matt=1&t=2.5', 1280, 720, () => { window.__ramps = []; const P = AudioParam.prototype, r = P.exponentialRampToValueAtTime, s = P.setValueAtTime;
    P.exponentialRampToValueAtTime = function (v, t) { window.__ramps.push(['ramp', v]); return r.call(this, v, t); }; P.setValueAtTime = function (v, t) { window.__ramps.push(['set', v]); return s.call(this, v, t); }; });
  await settle(page); await page.evaluate(() => { const d = __scene._dbg, R = d.renderer, c = d.camera; R.setScissorTest(true);           // two portraits, one picture: the person and Matt, each from 3 m in front
    d.pads.forEach((pd, i) => { const a = pd.avatar.position, s = i ? -1 : 1; c.position.set(a.x + 0.9 * s, 1.7, a.z - 3.2 * s); c.lookAt(a.x + 0.25 * s, 1.15, a.z); c.fov = 38; c.aspect = 640 / 720; c.updateProjectionMatrix();
      R.setViewport(i * 640, 0, 640, 720); R.setScissor(i * 640, 0, 640, 720); R.render(d.scene, c); }); R.setScissorTest(false); R.setViewport(0, 0, 1280, 720); });
  await page.screenshot({ path: `${shots}person-and-matt-1280x720.png` });
  const c = await page.evaluate(() => __scene._dbg.pads.map(p => ({ skin: p.avatar.userData.skin.color.getHex(), shirt: p.avatar.userData.shirt.color.getHex(), hair: p.avatar.userData.hairM.color.getHex(), hand: p.handM.color.getHex(), ghost: p.ghostM.color.getHex(), face: (p.avatar.userData.mattFace || p.avatar.userData.whites)[0].visible })));
  ok(c[1].skin === 0x6b4226 && c[1].shirt === 0xf26b1d && c[1].hair === 0x15110e && c[1].hand === 0x6b4226 && c[1].ghost === 0x6b4226 && c[1].face && c[0].skin === 0xf2c9a0 && c[0].shirt === 0xe5484d && !c[0].face, 'bot:true is Matt (skin, orange shirt, hair colour, his own face, the hand on his paddle and his ghost arm); the person opposite keeps today\'s colours');
  const hiss = await page.evaluate(() => { __scene.unlockAudio(); const out = {}; for (const spin of [0, 0.1, 0.13, 0.5, 0.8, 1]) { window.__ramps.length = 0; __scene.onEvent({ type: 'hit', side: 1, n: 0.5, p: [0, 1, -6], v: [0, 3, 9], spin });
      const i = window.__ramps.findIndex(r => r[0] === 'set' && r[1] === 5200); out[spin] = i < 0 ? null : window.__ramps.slice(i).find(r => r[0] === 'ramp' && r[1] < 1)[1]; } return out; });
  ok(hiss[0] === null && hiss[0.1] === null && hiss[0.13] > 0 && Math.abs(hiss[0.5] - 0.0707) < 0.001 && Math.abs(hiss[0.8] - 0.1431) < 0.001 && Math.abs(hiss[1] - 0.2) < 1e-9, `hiss gain by spin: ${JSON.stringify(hiss)}`); await page.close(); }

// ---------- 7. ball contrast, both ends (WCAG relative luminance, (L1 + 0.05) / (L2 + 0.05), mean over the ball's disc vs the same pixels without it) ----------
console.log('ball contrast');
{ let worst = { old: 99, now: 99 }, where = {};
  for (const side of [0, 1]) { const page = await open(`side=${side}&t=0.1`); const rows = await page.evaluate(side => { const sc = __scene, d = sc._dbg, gl = d.renderer.getContext(), cam = d.camera, s = side ? -1 : 1, W = gl.drawingBufferWidth, H = gl.drawingBufferHeight, M = d.ballMesh.material; let ms = 5e6;
      const lin = c => (c /= 255, c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4), V = (x, y, z) => new THREE.Vector3(x, y, z).project(cam); sc.updatePaddle(0, null); sc.updatePaddle(1, null); sc.render(ms += 17);
      const disc = pos => { const v = V(...pos), e = V(pos[0] + 0.11, pos[1], pos[2]), R = Math.max(2, Math.floor(Math.abs(e.x - v.x) / 2 * W * 0.8)), n = 2 * R + 1, px = new Uint8Array(n * n * 4); gl.readPixels(Math.round((v.x + 1) / 2 * W) - R, Math.round((v.y + 1) / 2 * H) - R, n, n, gl.RGBA, gl.UNSIGNED_BYTE, px);
        let t = 0, c = 0; for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) if ((x - R) ** 2 + (y - R) ** 2 <= R * R) { const o = (y * n + x) * 4; t += 0.2126 * lin(px[o]) + 0.7152 * lin(px[o + 1]) + 0.0722 * lin(px[o + 2]); c++; } return t / c; };
      const draw = pos => { d.ball.snap = true; for (let i = 0; i < 3; i++) { if (pos) sc.updateBall(pos, [0, 0, 0], true, ms += 17); sc.render(ms += 17); } }, ratio = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      const yForRow = (x, z, row) => { let lo = 0.2, hi = 9; for (let i = 0; i < 30; i++) { const y = (lo + hi) / 2; if ((1 - V(x, y, z).y) / 2 * 720 > row) lo = y; else hi = y; } return (lo + hi) / 2; };
      const now = { e: M.emissive.getHex(), k: M.emissiveIntensity, map: M.emissiveMap }, set = o => { M.emissive.setHex(o.e); M.emissiveIntensity = o.k; M.emissiveMap = o.map; M.needsUpdate = true; };
      return [['court', 0.9, -s * 3.5, 0.5], ['kitchen, through the net', 0.9, -s * 1.2, 0.6], ['far fence', 0.9, -s * 2, -225], ['ficus band', 0.9, -s * 2, -165], ['low sky', 0.9, -s * 2, -118], ['low sky, higher', 0.9, -s * 2, -85], ['sky, near lob', 0.9, s * 1, -30]].map(([name, x, z, yy]) => { const pos = [x, yy < 0 ? yForRow(x, z, -yy) : yy, z];
        sc.hideBall(); draw(null); const bg = disc(pos); set({ e: 0x6a7400, k: 0.35, map: null }); draw(pos); const was = disc(pos); set(now); draw(pos); const is = disc(pos); return { name, y: pos[1], bg, was, is, old: ratio(was, bg), now: ratio(is, bg) }; }); }, side);
    for (const r of rows) { console.log(`    side ${side}  ${r.name.padEnd(26)} ball at ${r.y.toFixed(1)} m  background L ${r.bg.toFixed(3)}   ball L ${r.was.toFixed(3)} -> ${r.is.toFixed(3)}   contrast ${r.old.toFixed(2)} : 1 -> ${r.now.toFixed(2)} : 1`);
      for (const k of ['old', 'now']) if (r[k] < worst[k]) { worst[k] = r[k]; where[k] = `side ${side} ${r.name}`; } }
    await page.close(); }
  ok(worst.now >= 1.5 && worst.now > worst.old + 0.25, `worst case ${worst.old.toFixed(2)} : 1 (${where.old}) -> ${worst.now.toFixed(2)} : 1 (${where.now})`); }

ok(errs.length === 0, 'no console errors' + (errs.length ? ': ' + errs.slice(0, 5).join(' | ') : ''));
console.log(fail ? `SCENE NEXT: ${fail} FAILURES` : 'SCENE NEXT TESTS PASSED'); bye(fail ? 1 : 0);
