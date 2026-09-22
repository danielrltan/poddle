// All visuals + WebAudio. No networking, no motion maths. Uses the global THREE (r160).
// Frames: world x right (seen from side 0), y up, side 0 defends +z, net at z=0.
// Player frame (q, offset): x = player's right, y = up, z = toward the player. Side 1 = world rotated 180deg about Y.

const G = 9.81, BALL_R = 0.11;
// ---------- riding out a bad connection ----------
// The server owns the ball. Between packets the client only has to know where that ball is NOW, and between hits a ball
// is pure physics, so every client works out the same answer. coast() is the server's own flight (spin-lightened
// gravity, the first bounce with its spin and sideways kick), in closed form, for up to COAST_MAX seconds with no news.
// The next packet or hit event is the truth again; nothing here decides a hit, a bounce call or a point.
const COAST_MAX = 0.6;
const FLOOR = { up: 0.7, along: 0.78 }, SPUN = { lift: 0.3, up: 0.55, along: 0.45 };       // = BOUNCE / SLICE in server/game.js
// coast(), but it will not carry the ball through the far player. With no news for over 100 ms and the ball arriving at
// their paddle (farZ, signed), the likeliest truth is that they are hitting it: wait there for the packet. Guessing wrong
// costs a short pause at the baseline; flying on costs a ball metres behind them that then has to come all the way back.
export function coastTo(outP, outV, p, v, age, spin, bounces, kick, farZ) {
  coast(outP, outV, p, v, age, spin, bounces, kick);
  const s = Math.sign(farZ);
  if (age <= 0.1 || !s || v[2] * s <= 0 || outP.z * s < farZ * s) return;
  let lo = 0.1, hi = age;
  coast(outP, outV, p, v, lo, spin, bounces, kick); if (outP.z * s >= farZ * s) return;      // already there in the last packet's own 100 ms
  for (let i = 0; i < 10; i++) { const mid = (lo + hi) / 2; coast(outP, outV, p, v, mid, spin, bounces, kick); if (outP.z * s < farZ * s) lo = mid; else hi = mid; }
  coast(outP, outV, p, v, lo, spin, bounces, kick);
}

// A ball hanging for the serve is not falling: the server floats it after the server's hand and sends its real drift as
// v. Carry it along that drift and nothing else. (Gravity here made it sag between packets and snap back up on each one:
// a millimetre on a LAN, a 5 cm sawtooth on a jittery link.) The drift is a damped spring, so past HOVER_MAX just wait.
const HOVER_MAX = 0.25;
export function hover(outP, outV, p, v, age) {
  outP.set(p[0] + v[0] * age, Math.max(BALL_R, p[1] + v[1] * age), p[2] + v[2] * age); outV.set(v[0], v[1], v[2]);
}

// Server clock. A packet is stamped with when the server MADE it, not when it got here: a packet that sat 80 ms in a
// wifi retry is 80 ms old, and drawing it as fresh would yank a fast ball a metre back. The least-delayed packet of the
// last couple of seconds sets the offset between the two clocks; every other packet is aged by how much later it came.
export function serverClock() {
  const d = new Float64Array(96); let n = 0, off = NaN;
  return { reset() { n = 0; },
    madeAt(t, arrived) {                                         // t: the packet's server time (s). arrived: local ms. -> local ms it was made
      if (!isFinite(t)) return arrived;
      const dd = arrived - t * 1000;
      if (Math.abs(dd - off) > 1500) n = 0;                      // the server restarted (its clock starts again), or this tab slept
      d[n++ % 96] = dd;
      let m = Infinity; for (let i = Math.min(n, 96) - 1; i >= 0; i--) if (d[i] < m) m = d[i];
      off = m;
      return Math.max(arrived - COAST_MAX * 1000, t * 1000 + m);
    } };
}
export function coast(outP, outV, p, v, t, spin, bounces, kick) {
  let x = p[0], y = p[1], z = p[2], vx = v[0], vy = v[1], vz = v[2], b = bounces;
  for (let i = 0; i < 2 && t > 0; i++) {
    const g = b ? G : G * (1 - SPUN.lift * spin), disc = vy * vy + 2 * g * Math.max(0, y - BALL_R), tf = (vy + Math.sqrt(disc)) / g;    // time until it reaches the floor
    const step = Math.min(t, tf);
    x += vx * step; z += vz * step; y += vy * step - 0.5 * g * step * step; vy -= g * step; t -= step;
    if (step < tf) break;
    y = BALL_R;
    if (b) { vx = vy = vz = 0; break; }                    // a second bounce ends the rally; that call is the server's: wait on the floor
    const sp = b ? 0 : spin, al = FLOOR.along + (SPUN.along - FLOOR.along) * sp;
    vy *= -(FLOOR.up + (SPUN.up - FLOOR.up) * sp); vx = vx * al + kick; vz *= al; b++;
  }
  outP.set(x, Math.max(BALL_R, y), z); outV.set(vx, vy, vz);
}

const SMASH_N = 0.76;                     // = SMASH in server/game.js: n above this is a smash
const PADDLE_SCALE = 1.6;                 // Wii-sized so it reads from 5 m behind
const VIEW_PARALLAX = 1;                  // head-coupled camera strength: 0 = locked-off, 1 = full
const VIEW = { x: 1.7, y: 0.45, back: 2.2, tau: 0.22 };   // eye travel (m) at viewer = 1: sideways, up, drift back; follow time (s)
const DEFAULT_COURT = { halfW: 3.05, halfL: 6.7, kitchen: 2.13, net: 0.91 };
const COL = {
  skyTop: '#2f7fd6', skyMid: '#8cc4ee', horizon: '#d6ecf7',
  grass: 0x4f9a4a, apron: 0x2e7d56, court: 0x2a66b3, kitchen: 0xe0813f, line: 0xffffff,
  screen: 0x17513a, skin: 0xf2c9a0,
  matt: { skin: 0x6b4226, shirt: 0xf26b1d, hair: 0x15110e },       // the bot is Matt: a Black man in an orange shirt, whichever end he plays
  shirt: [0xe5484d, 0xf5b324], hair: [0x3a2a1e, 0x1d1d26], face: ['#e5484d', '#f5b324'],
};

// Kinematic-arm fallback, replaced by motion.js's armOffset when that module loads.
const ARM = [0.18, -0.22, -0.68];
function localArm(P) {
  const [x, y, z, w] = P, [vx, vy, vz] = ARM;
  const tx = 2 * (y * vz - z * vy), ty = 2 * (z * vx - x * vz), tz = 2 * (x * vy - y * vx);
  return [w * tx + y * tz - z * ty, w * ty + z * tx - x * tz, w * tz + x * ty - y * tx];   // = P(v) - v
}
let armImpl = localArm;
import('./motion.js').then(m => { if (typeof m.armOffset === 'function') armImpl = m.armOffset; }).catch(() => {});
function armOffset(P) {
  try { const o = armImpl(P); if (o && isFinite(o[0] + o[1] + o[2])) return o; } catch (e) { armImpl = localArm; }
  return localArm(P);
}

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const lerp = (a, b, t) => a + (b - a) * t;
const ease = t => t * t * (3 - 2 * t);
const sgn = side => (side === 0 ? 1 : -1);
const damp = (dt, tau) => 1 - Math.exp(-dt / tau);
// The trail's heat: n -> 0..1 along white -> yellow -> orange -> red. Real swings sit low (live captures, settled n: median 0.06, p75 0.27,
// p90 0.61), so the ramp is stretched over n 0.03..SMASH_N with a gamma: 0.15 is yellow, 0.35 amber, 0.55 deep orange, red is a smash.
// web/pad.js trailRGB is this same ramp (the phone's edge glow): change one, change both.
const trailHeat = n => Math.pow(clamp((n - 0.03) / (SMASH_N - 0.03), 0, 1), 0.7);
function trailRamp(t, out) { const u = 3 * t;                // -> out = [r, g, b], 0..1
  out[0] = 1; out[1] = u < 1 ? lerp(1, 0.9, u) : u < 2 ? lerp(0.9, 0.5, u - 1) : lerp(0.5, 0.12, u - 2); out[2] = u < 1 ? lerp(1, 0.3, u) : u < 2 ? lerp(0.3, 0.12, u - 1) : lerp(0.12, 0.08, u - 2); return out; }
function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

function canvasTex(w, h, draw) {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  draw(c.getContext('2d'), w, h);
  const t = new THREE.CanvasTexture(c); t.colorSpace = THREE.SRGBColorSpace; t.anisotropy = 8;
  return t;
}
function glowTex() {
  return canvasTex(64, 64, (g) => {
    const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32);
    gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.35, 'rgba(255,255,255,0.55)'); gr.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = gr; g.fillRect(0, 0, 64, 64);
  });
}

// ---------- paddle model: origin at the grip, handle down (-y), face looks at the net (-z) ----------
function facePath(hw, y0, y1, r, neck, P) {
  P.moveTo(-neck, y0 - 0.03);
  P.bezierCurveTo(-neck, y0 + 0.03, -hw, y0 + 0.01, -hw, y0 + 0.085);
  P.lineTo(-hw, y1 - r); P.quadraticCurveTo(-hw, y1, -hw + r, y1);
  P.lineTo(hw - r, y1); P.quadraticCurveTo(hw, y1, hw, y1 - r);
  P.lineTo(hw, y0 + 0.085);
  P.bezierCurveTo(hw, y0 + 0.01, neck, y0 + 0.03, neck, y0 - 0.03);
  P.closePath();
  return P;
}
function buildPaddle(side) {
  const g = new THREE.Group();
  const hw = 0.1, y0 = 0.085, y1 = 0.375, th = 0.014;
  const faceTex = canvasTex(256, 512, (c, w, h) => {
    c.fillStyle = COL.face[side]; c.fillRect(0, 0, w, h);
    c.fillStyle = 'rgba(255,255,255,0.10)';                       // honeycomb-ish texture dots
    for (let y = 0; y < h; y += 10) for (let x = (y / 10) % 2 ? 5 : 0; x < w; x += 10) { c.beginPath(); c.arc(x, y, 1.6, 0, 7); c.fill(); }
    c.save(); c.translate(w / 2, h * 0.43); c.rotate(-0.5);
    c.fillStyle = '#ffffff'; c.fillRect(-w, -34, w * 2, 44);
    c.fillStyle = 'rgba(20,24,40,0.9)'; c.fillRect(-w, 18, w * 2, 12);
    c.restore();
    c.fillStyle = 'rgba(255,255,255,0.9)'; c.beginPath(); c.arc(w / 2, h * 0.24, 20, 0, 7); c.fill();
    c.fillStyle = COL.face[side]; c.beginPath(); c.arc(w / 2, h * 0.24, 11, 0, 7); c.fill();
  });
  faceTex.repeat.set(1 / (hw * 2), 1 / (y1 - y0 + 0.03)); faceTex.offset.set(0.5, -(y0 - 0.03) / (y1 - y0 + 0.03));   // extrude UVs are in metres
  const face = new THREE.Mesh(
    new THREE.ExtrudeGeometry(facePath(hw - 0.006, y0, y1 - 0.006, 0.05, 0.02, new THREE.Shape()), { depth: th, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 2, curveSegments: 14 }),
    [new THREE.MeshStandardMaterial({ map: faceTex, roughness: 0.55 }), new THREE.MeshStandardMaterial({ color: 0x1b1d24, roughness: 0.6 })]);
  face.position.z = -th / 2;
  // edge guard: a ring around the face, a touch thicker
  const outer = facePath(hw + 0.004, y0, y1 + 0.004, 0.056, 0.026, new THREE.Shape());
  outer.holes.push(facePath(hw - 0.008, y0 + 0.004, y1 - 0.008, 0.046, 0.016, new THREE.Path()));
  const guard = new THREE.Mesh(
    new THREE.ExtrudeGeometry(outer, { depth: th + 0.004, bevelEnabled: true, bevelThickness: 0.002, bevelSize: 0.002, bevelSegments: 2, curveSegments: 14 }),
    new THREE.MeshStandardMaterial({ color: 0x14161c, roughness: 0.45, metalness: 0.1 }));
  guard.position.z = -(th + 0.004) / 2;
  // tapered handle with wrapped grip, collar, butt cap
  const gripTex = canvasTex(64, 64, (c) => {
    c.fillStyle = '#23252e'; c.fillRect(0, 0, 64, 64);
    c.strokeStyle = '#4a4f60'; c.lineWidth = 5;
    for (let i = -64; i < 128; i += 21) { c.beginPath(); c.moveTo(i, 64); c.lineTo(i + 64, 0); c.stroke(); }
  });
  gripTex.wrapS = gripTex.wrapT = THREE.RepeatWrapping; gripTex.repeat.set(2, 5);
  const handle = new THREE.Mesh(new THREE.CylinderGeometry(0.0165, 0.02, 0.15, 20), new THREE.MeshStandardMaterial({ map: gripTex, roughness: 0.95 }));
  handle.position.y = -0.005; handle.scale.z = 0.82;
  const capM = new THREE.MeshStandardMaterial({ color: 0x0f1014, roughness: 0.5 });
  const butt = new THREE.Mesh(new THREE.CylinderGeometry(0.0245, 0.022, 0.016, 20), capM); butt.position.y = -0.086; butt.scale.z = 0.85;
  const collar = new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.0185, 0.012, 20), new THREE.MeshStandardMaterial({ color: COL.shirt[side], roughness: 0.5 }));
  collar.position.y = 0.068; collar.scale.z = 0.85;
  g.add(face, guard, handle, butt, collar);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  g.scale.setScalar(PADDLE_SCALE);
  return g;
}

// ---------- Mii-ish avatar, built facing -z (the net, in the player frame) ----------
function buildAvatar(side) {
  const g = new THREE.Group();
  const skin = new THREE.MeshStandardMaterial({ color: COL.skin, roughness: 0.7 });
  const shirt = new THREE.MeshStandardMaterial({ color: COL.shirt[side], roughness: 0.75 });
  const dark = new THREE.MeshStandardMaterial({ color: 0x20222c, roughness: 0.8 });
  const body = new THREE.Mesh(new THREE.CapsuleGeometry(0.25, 0.42, 6, 20), shirt); body.position.y = 0.74;
  const shorts = new THREE.Mesh(new THREE.SphereGeometry(0.255, 20, 12, 0, Math.PI * 2, Math.PI * 0.55, Math.PI * 0.45), dark); shorts.position.y = 0.55;
  const head = new THREE.Group(); head.position.y = 1.47;
  const whiteM = new THREE.MeshStandardMaterial({ color: 0xf4f1ea, roughness: 0.6 }), whites = [], eyes = [], mattFace = [];      // whites: kept (empty) for callers that loop over it
  const halfEye = new THREE.SphereGeometry(0.036, 16, 10, 0, Math.PI * 2, Math.PI * 0.44, Math.PI * 0.56);      // an eye with its top cut off flat
  head.add(new THREE.Mesh(new THREE.SphereGeometry(0.27, 28, 20), skin));
  const hairM = new THREE.MeshStandardMaterial({ color: COL.hair[side], roughness: 0.9 });
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.283, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.48), hairM);
  hair.rotation.x = 0.42; head.add(hair);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.036, 12, 10), dark);
    eye.scale.set(1, 1.55, 0.5); eye.position.set(sx * 0.095, 0.0, -0.25); head.add(eye); eyes.push(eye);
    // Matt's own face (after the Wii Sports champion): calm and a little pensive, never angry. The eyes are the lower part
    // of an oval with a flat lid line across the top, so they read half-closed; the brows are heavy, low and almost level.
    const mEye = new THREE.Mesh(halfEye, dark); mEye.scale.set(1.35, 1.45, 0.5); mEye.position.set(sx * 0.095, 0.004, -0.25);
    const mWhite = new THREE.Mesh(halfEye, whiteM); mWhite.scale.set(1.62, 1.7, 0.36); mWhite.position.set(sx * 0.095, 0.005, -0.2455);
    const lidLine = new THREE.Mesh(new THREE.BoxGeometry(0.118, 0.013, 0.024), dark); lidLine.position.set(sx * 0.096, 0.014, -0.2475); lidLine.rotation.set(0, sx * -0.36, sx * -0.05);
    const brow = new THREE.Mesh(new THREE.BoxGeometry(0.112, 0.03, 0.03), dark); brow.position.set(sx * 0.098, 0.068, -0.244); brow.rotation.set(0.26, sx * -0.36, sx * 0.07);
    for (const o of [mEye, mWhite, lidLine, brow]) { o.visible = false; head.add(o); mattFace.push(o); }
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 10), dark);
    foot.scale.set(1, 0.6, 1.5); foot.position.set(sx * 0.15, 0.065, -0.04); g.add(foot);
  }
  const offHand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), skin); offHand.position.set(-0.42, 0.85, -0.12);
  g.add(body, shorts, head, offHand);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  g.scale.setScalar(1.3);
  g.userData = { head, body, offHand, skin, shirt, hairM, whites, hair, eyes, mattFace };
  return g;
}

// ---------- canned swing for bots: [t, yaw, pitch, roll] degrees, player frame, YXZ ----------
const IDLE = [14, -12, 12];
const SWING = [[0, ...IDLE], [0.13, -64, 12, -30], [0.29, 72, 22, 38], [0.40, 62, 18, 30], [0.74, ...IDLE]];
const SWING_CONTACT = 0.2;
const FACE_C = 0.23 * PADDLE_SCALE, REACH_MAX = 0.4;      // grip -> face centre; how far a hit may tug the paddle toward the ball
const BODY = [0.5, 0.68];                 // avatar centre, left of / behind the paddle base (player frame)
function swingEuler(t, out) {
  let i = 0; while (i < SWING.length - 2 && t > SWING[i + 1][0]) i++;
  const a = SWING[i], b = SWING[i + 1], k = ease(clamp((t - a[0]) / (b[0] - a[0]), 0, 1));
  for (let j = 0; j < 3; j++) out[j] = lerp(a[j + 1], b[j + 1], k);
  return out;
}

export function createScene(containerEl) {
  let court = { ...DEFAULT_COURT }, localSide = 0, lastMs = 0, timeS = 0;
  // Three switches (docs/API-NEXT.md 2.1). Camera: menu beats spectator (broadcast | split | pov | free) beats seated (today's play camera).
  let spectator = false, vName = 'broadcast', vSide = 0, menu = false, dim = false, frozen = false, drawn = 0, force = false, shadowHold = 0, easeT = 1;      // dim: paused behind the full blur. The menu's cheap picture, the play camera
  const VIEWS = ['broadcast', 'split', 'pov', 'free'], free = { yaw: 20, pitch: 25, dist: 17, tz: 0 }, size = { w: 1, h: 1 };      // free: degrees off +x, degrees up, metres from the target (0, 0.9, tz); tz slides along the court so a player can be framed up close. It outlives view changes. (Not 35 off: a floodlight head hangs exactly there)
  const still = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pixelRatio = () => Math.min(window.devicePixelRatio || 1, 2) / (menu || dim ? 2 : 1);       // a menu (or a pause) is blurred glass over the court: half the pixels each way
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(pixelRatio());
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.display = 'block';
  containerEl.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(new THREE.Color(COL.horizon), 38, 160);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 500);
  const cam = { x: 0, shake: 0, fovBase: 44 };
  const view = { x: 0, y: 0, vx: 0, vy: 0, inX: 0, inY: 0, at: -9 };      // smoothed viewer offset + last setViewer()

  // lights: hemisphere fill + ONE shadow-casting sun, frustum fitted to court + player run-off
  const hemi = new THREE.HemisphereLight(0xd6e9ff, 0x4f7a4a, 1.35); scene.add(hemi);
  const sun = new THREE.DirectionalLight(0xfff0d2, 3.3);
  sun.position.set(-7, 16, 9); sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  Object.assign(sun.shadow.camera, { left: -11, right: 11, top: 12, bottom: -12, near: 2, far: 45 });
  sun.shadow.camera.updateProjectionMatrix();
  sun.shadow.bias = -0.0004; sun.shadow.normalBias = 0.03; sun.shadow.radius = 3;
  scene.add(sun, sun.target);

  // sky dome + clouds
  const sky = new THREE.Mesh(new THREE.SphereGeometry(300, 24, 16),
    new THREE.MeshBasicMaterial({ side: THREE.BackSide, fog: false, depthWrite: false, map: canvasTex(4, 512, (g, w, h) => {
      const gr = g.createLinearGradient(0, 0, 0, h);
      gr.addColorStop(0, COL.skyTop); gr.addColorStop(0.36, COL.skyMid); gr.addColorStop(0.5, COL.horizon); gr.addColorStop(1, COL.horizon);
      g.fillStyle = gr; g.fillRect(0, 0, w, h);
    }) }));
  scene.add(sky);
  const plainSky = [sky];                                  // what web/scenery/ replaces when it loads (see docs/SCENERY.md)
  {
    const rnd = rng(7), geo = new THREE.SphereGeometry(1, 12, 8), mat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
    const clouds = new THREE.InstancedMesh(geo, mat, 70), m = new THREE.Matrix4(), q = new THREE.Quaternion(); let n = 0;
    for (let c = 0; c < 14; c++) {
      const a = rnd() * Math.PI * 2, d = 170 + rnd() * 80, cx = Math.cos(a) * d, cz = Math.sin(a) * d, cy = 38 + rnd() * 45, sz = 6 + rnd() * 6;
      for (let k = 0; k < 5; k++) m.compose(new THREE.Vector3(cx + (k - 2) * sz * 0.8 + rnd() * 3, cy + rnd() * 2 - (k % 2) * 1.5, cz + rnd() * 6), q,
        new THREE.Vector3(sz * (1.1 - Math.abs(k - 2) * 0.22), sz * (0.55 - Math.abs(k - 2) * 0.1), sz * 0.8)), clouds.setMatrixAt(n++, m);
    }
    scene.add(clouds); plainSky.push(clouds);
  }

  // ---------- everything beyond the fences lives in web/scenery/ (docs/SCENERY.md). Missing or broken: the plain sky above stays. ----------
  let scenery = null;
  import('./scenery/index.js').then(m => { scenery = m.createScenery(THREE, { scene, renderer, camera, sun, hemi, fog: scene.fog, plainSky, court: () => court, side: () => localSide }); })
    .catch(e => { if (!/Failed to fetch|Cannot find module|404/i.test(String(e && e.message))) console.error('scenery:', e); });

  // ---------- court (rebuilt by setCourt) ----------
  let courtGroup = null;
  const backFence = [[], []], sideFence = [[], []];       // per side: the windscreen behind that baseline (hidden for whoever looks from there). sideFence: +x, -x (broadcast and free cam look over them)
  const speckle = canvasTex(256, 256, (g, w, h) => {
    g.fillStyle = '#fff'; g.fillRect(0, 0, w, h); const rnd = rng(3);
    for (let i = 0; i < 5000; i++) { g.fillStyle = `rgba(0,0,0,${0.03 + rnd() * 0.07})`; g.fillRect(rnd() * w, rnd() * h, 1.5, 1.5); }
  });
  speckle.wrapS = speckle.wrapT = THREE.RepeatWrapping;
  function slab(w, l, color, y, x = 0, z = 0, rep = 0) {
    const map = rep ? speckle.clone() : null; if (map) { map.repeat.set(w * rep, l * rep); map.needsUpdate = true; }
    const m = new THREE.Mesh(new THREE.PlaneGeometry(w, l), new THREE.MeshStandardMaterial({ color, map, roughness: 0.92 }));
    m.rotation.x = -Math.PI / 2; m.position.set(x, y, z); m.receiveShadow = true;
    return m;
  }
  function buildCourt() {
    if (courtGroup) { scene.remove(courtGroup); courtGroup.traverse(o => { if (o.geometry) o.geometry.dispose(); }); }
    const g = courtGroup = new THREE.Group(), { halfW: W, halfL: L, kitchen: K, net: N } = court, LW = 0.07;
    const fenceZ = L + 7.2, fenceX = W + 5.2; backFence[0].length = backFence[1].length = sideFence[0].length = sideFence[1].length = 0;
    g.add(slab(600, 600, COL.grass, -0.02));
    g.add(slab(fenceX * 2, fenceZ * 2, COL.apron, 0, 0, 0, 0.6));
    g.add(slab(W * 2, L * 2, COL.court, 0.004, 0, 0, 0.6));
    g.add(slab(W * 2, K * 2, COL.kitchen, 0.008, 0, 0, 0.6));
    const line = (w, l, x, z) => { const m = slab(w, l, COL.line, 0.012, x, z); m.material.roughness = 0.8; g.add(m); };
    for (const s of [-1, 1]) {
      line(W * 2 + LW, LW, 0, s * L);                       // baselines
      line(LW, L * 2 + LW, s * W, 0);                       // sidelines
      line(W * 2, LW, 0, s * K);                            // kitchen lines
      line(LW, L - K, 0, s * (K + L) / 2);                  // centre lines
    }
    // net: mesh, tape, posts, centre strap, soft contact shadow
    const NW = W + 0.3;                                   // server net is flat at N; keep the visual honest
    const netTex = canvasTex(64, 64, (c) => {
      c.clearRect(0, 0, 64, 64); c.strokeStyle = 'rgba(18,20,24,0.9)'; c.lineWidth = 3;
      for (let i = 0; i <= 64; i += 16) { c.beginPath(); c.moveTo(i, 0); c.lineTo(i, 64); c.moveTo(0, i); c.lineTo(64, i); c.stroke(); }
    });
    netTex.wrapS = netTex.wrapT = THREE.RepeatWrapping; netTex.repeat.set(NW * 2 / 0.16, N / 0.16);
    const mesh = new THREE.Mesh(new THREE.PlaneGeometry(NW * 2, N - 0.06), new THREE.MeshBasicMaterial({ map: netTex, transparent: true, side: THREE.DoubleSide, depthWrite: false, opacity: 0.85 }));
    mesh.position.y = (N - 0.06) / 2 + 0.04; mesh.renderOrder = 2; g.add(mesh);
    const white = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.7 });
    const tape = new THREE.Mesh(new THREE.BoxGeometry(NW * 2, 0.055, 0.035), white); tape.position.y = N - 0.0125; tape.castShadow = true; g.add(tape);
    const strap = new THREE.Mesh(new THREE.BoxGeometry(0.05, N, 0.012), white); strap.position.y = N / 2; g.add(strap);
    const hem = new THREE.Mesh(new THREE.BoxGeometry(NW * 2, 0.03, 0.02), new THREE.MeshStandardMaterial({ color: 0x1a1c22 })); hem.position.y = 0.05; g.add(hem);
    const postM = new THREE.MeshStandardMaterial({ color: 0x20242c, roughness: 0.4, metalness: 0.5 });
    for (const s of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.CylinderGeometry(0.045, 0.05, N + 0.08, 16), postM); post.position.set(s * NW, (N + 0.08) / 2, 0); post.castShadow = true;
      const cap = new THREE.Mesh(new THREE.SphereGeometry(0.058, 14, 10), white); cap.position.set(s * NW, N + 0.09, 0); cap.castShadow = true;
      const foot = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.18, 0.03, 20), postM); foot.position.set(s * NW, 0.015, 0); foot.receiveShadow = true;
      g.add(post, cap, foot);
    }
    const netShadow = new THREE.Mesh(new THREE.PlaneGeometry(NW * 2, 0.9), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, map: canvasTex(4, 64, (c, w, h) => {
      const gr = c.createLinearGradient(0, 0, 0, h); gr.addColorStop(0, 'rgba(0,0,0,0)'); gr.addColorStop(0.5, 'rgba(0,0,0,0.28)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
      c.fillStyle = gr; c.fillRect(0, 0, w, h);
    }) }));
    netShadow.rotation.x = -Math.PI / 2; netShadow.position.y = 0.016; g.add(netShadow);
    // windscreens behind both baselines (dark backdrop = the ball reads), lower ones down the sides
    const banner = canvasTex(2048, 256, (c, w, h) => {
      c.fillStyle = '#17513a'; c.fillRect(0, 0, w, h);
      c.fillStyle = 'rgba(255,255,255,0.05)'; for (let x = 0; x < w; x += 8) c.fillRect(x, 0, 2, h);
      c.fillStyle = '#0f3a29'; c.fillRect(0, 0, w, 14); c.fillRect(0, h - 10, w, 10);
      c.font = '800 96px "Avenir Next", "Helvetica Neue", Arial, sans-serif'; c.textAlign = 'center'; c.textBaseline = 'middle';
      c.fillStyle = 'rgba(255,255,255,0.86)';
      for (const x of [w * 0.2, w * 0.5, w * 0.8]) c.fillText('PODDLE', x, h / 2 + 4, w * 0.27);
      c.fillStyle = '#f5d53a'; for (const x of [w * 0.35, w * 0.65]) { c.beginPath(); c.arc(x, h / 2, 26, 0, 7); c.fill(); }
    });
    const screenM = new THREE.MeshStandardMaterial({ map: banner, roughness: 0.95 });
    const sideM = new THREE.MeshStandardMaterial({ color: COL.screen, roughness: 0.95, side: THREE.DoubleSide });
    const railM = new THREE.MeshStandardMaterial({ color: 0xd9dde3, roughness: 0.4, metalness: 0.6 });
    for (const s of [-1, 1]) {
      const back = new THREE.Mesh(new THREE.PlaneGeometry(fenceX * 2, 2.4), screenM); back.position.set(0, 1.2, s * fenceZ); back.rotation.y = s > 0 ? Math.PI : 0; g.add(back);
      const mine = backFence[s > 0 ? 0 : 1]; mine.push(back);      // the camera drifts back through its own fence when the player is deep or far offside
      const rail = new THREE.Mesh(new THREE.BoxGeometry(fenceX * 2, 0.07, 0.07), railM); rail.position.set(0, 2.43, s * fenceZ); g.add(rail); mine.push(rail);
      const sd = new THREE.Mesh(new THREE.PlaneGeometry(fenceZ * 2, 1.3), sideM); sd.position.set(s * fenceX, 0.65, 0); sd.rotation.y = -s * Math.PI / 2; g.add(sd);
      const srail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, fenceZ * 2), railM); srail.position.set(s * fenceX, 1.33, 0); g.add(srail); sideFence[s > 0 ? 0 : 1].push(sd, srail);
      for (let i = -3; i <= 3; i++) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.5, 8), railM); p.position.set(i * fenceX / 3, 1.25, s * (fenceZ + 0.05)); g.add(p); mine.push(p); }
    }
    // trees outside the fence
    const rnd = rng(11), N_T = 46, trunks = new THREE.InstancedMesh(new THREE.CylinderGeometry(0.22, 0.3, 1, 8), new THREE.MeshStandardMaterial({ color: 0x7a5535, roughness: 1 }), N_T);
    const leafM = [0x3f8f45, 0x57a84f].map(c => new THREE.MeshStandardMaterial({ color: c, roughness: 1 }));
    const leaves = leafM.map(m => new THREE.InstancedMesh(new THREE.SphereGeometry(1, 14, 10), m, N_T * 2)), cnt = [0, 0];
    const M = new THREE.Matrix4(), Q = new THREE.Quaternion();
    for (let i = 0; i < N_T; i++) {
      const onSide = i % 2 === 0, s = rnd() < 0.5 ? -1 : 1;
      const x = onSide ? s * (fenceX + 4 + rnd() * 16) : (rnd() * 2 - 1) * (fenceX + 16);
      const z = onSide ? (rnd() * 2 - 1) * (fenceZ + 12) : s * (fenceZ + 5 + rnd() * 18);
      const h = 2.0 + rnd() * 1.8, r = 1.2 + rnd() * 0.9;
      M.compose(new THREE.Vector3(x, h / 2, z), Q, new THREE.Vector3(1, h, 1)); trunks.setMatrixAt(i, M);
      const k = i % 2; M.compose(new THREE.Vector3(x, h + r * 0.55, z), Q, new THREE.Vector3(r, r * 0.95, r)); leaves[k].setMatrixAt(cnt[k]++, M);
      M.compose(new THREE.Vector3(x + r * 0.5, h + r * 0.2, z + r * 0.3), Q, new THREE.Vector3(r * 0.65, r * 0.6, r * 0.65)); leaves[1 - k].setMatrixAt(cnt[1 - k]++, M);
    }
    leaves.forEach((l, k) => { l.count = cnt[k]; g.add(l); }); g.add(trunks);
    scene.add(g); if (menu) shadowHold = 1;                // a frozen shadow map belongs to the old court
  }
  buildCourt();

  // ---------- ball, blob shadow, trail ----------
  const ballTex = canvasTex(512, 256, (c, w, h) => {
    c.fillStyle = '#e3f23a'; c.fillRect(0, 0, w, h);
    const hole = (u, lat) => { const x = u * w, y = (0.5 - lat / Math.PI) * h, r = 15, rx = Math.min(r / Math.max(Math.cos(lat), 0.12), w);
      for (const dx of [-w, 0, w]) { c.beginPath(); c.ellipse(x + dx, y, rx, r, 0, 0, 7); c.fill(); } };
    c.fillStyle = '#6f7d12';
    [[0, 8, 0], [0.62, 6, 0.5], [-0.62, 6, 0.5], [1.15, 4, 0], [-1.15, 4, 0]].forEach(([lat, n, ph]) => { for (let i = 0; i < n; i++) hole((i + ph) / n, lat); });
    hole(0.5, 1.5); hole(0.5, -1.5);
  });
  // spin swirl: wind whipping round a sliced ball, turning the way its FIRST BOUNCE will go. The bounce (coast / bounceV in server/game.js) is a
  // plain one plus, from the spin: forward speed cut by (FLOOR.along - SPUN.along) * spin, and the sideways kick. That extra change D in the ball's
  // ground speed is what friction does to a ball whose bottom slides the other way, so the swirl turns about up x D like a wheel that will roll the
  // ball along D when it lands: backspin = the underside rolling forward (it checks up), kick right = a wheel rolling right. |D| (m/s) sets how
  // wild it is: fatter, more wisps, more wobble, more opaque, faster. It is gone once the ball has bounced (the spin only bites on the first one).
  // Three tapered wisps (pointed heads leading, tails fading), each with a thin one further out that joins as |D| grows. One mesh; each camera
  // that draws it (split view draws the frame twice) sets it just before drawing: the ring about the true axis, but leaning at most 52 deg off
  // facing that camera, so it is never edge-on. Seen along the axis it turns clockwise or anticlockwise; seen across it, it is an ellipse whose
  // near side sweeps the way the ball's face turns (a backspin ball coming at you: up and away). Receiving, the sideways kick is the clockwise
  // (kicks right) or anticlockwise (left) turn, since a real slice always carries one (solve: at least 0.55 of SLICE.kick).
  // The shape is rewritten into the same buffer each frame (updateSpinFx); scaled up with distance like the serve cue, so it reads at game size.
  const qFx = new THREE.Quaternion(), qRoll = new THREE.Quaternion(), zFx = new THREE.Vector3(0, 0, 1), sFx = new THREE.Vector3(), cFx = new THREE.Vector3(), nFx = new THREE.Vector3();
  const fxScale = (cam, p) => clamp(cam.position.distanceTo(p) / 6, 1, 1.8);                 // a ball at the far baseline still reads
  const SW_SEG = 20, SW = [];                                 // per wisp: phase, radius at the head and at the tail (ball radii), sweep (rad), width (ball radii), alpha, companion?
  for (let i = 0; i < 3; i++) { const ph = i * Math.PI * 2 / 3; SW.push([ph, 1.3, 2.3, 2.5, 0.9, 1, 0], [ph - 1.0, 2.15, 2.85, 1.5, 0.42, 0.8, 1]); }
  const spinMat = new THREE.MeshBasicMaterial({ color: 0xe4f6ff, vertexColors: true, transparent: true, opacity: 0, depthWrite: false, fog: false, side: THREE.DoubleSide });
  const spinFx = (() => { const nv = SW.length * (SW_SEG + 1) * 2, col = new Float32Array(nv * 4), idx = [];
    SW.forEach(([, , , , , al], s) => { for (let j = 0; j <= SW_SEG; j++) { const u = j / SW_SEG, a = al * Math.min(1, u / 0.03) * Math.pow(1 - u, 1.2), o = (s * (SW_SEG + 1) + j) * 2;
      for (const v of [o, o + 1]) col.set([1, 1, 1, a], v * 4);
      if (j < SW_SEG) idx.push(o, o + 1, o + 2, o + 1, o + 3, o + 2); } });
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 4)); g.setIndex(idx);
    return new THREE.Mesh(g, spinMat); })();
  function updateSpinFx(w, t) {                              // w: how wild (0..1); t: time, for the wobble of the radii
    const P = spinFx.geometry.attributes.position.array, k = 0.45 + 0.55 * w, extra = clamp((w - 0.25) / 0.45, 0, 1), wob = 0.04 + 0.2 * w; let q = 0;
    SW.forEach(([ph, r0, r1, sw, wd, , co], s) => { const kw = k * (co ? extra : 1);
      for (let j = 0; j <= SW_SEG; j++) { const u = j / SW_SEG, th = ph - u * sw, c = Math.cos(th), sn = Math.sin(th);      // it turns anticlockwise about its own z: the head leads, the tail trails
        const r = BALL_R * (r0 + (r1 - r0) * u + wob * Math.sin(t * (4 + 6 * w) + s * 1.7 + u * 4)), hw = BALL_R * wd * kw * Math.sqrt(Math.min(1, u / 0.07)) * Math.pow(1 - u, 1.1) * 0.5;
        P[q++] = c * (r - hw); P[q++] = sn * (r - hw); P[q++] = 0; P[q++] = c * (r + hw); P[q++] = sn * (r + hw); P[q++] = 0; } });
    spinFx.geometry.attributes.position.needsUpdate = true;
  }
  const spinAxis = new THREE.Vector3(1, 0, 0), camBack = new THREE.Vector3(); let spinRoll = 0, spinW = 0, swHit = -1, swLanded = false, swFrame = -1, swPass = 0; const swSide = [0, 0, 0, 0];
  const SW_TILT = 1.3;                                       // tan of the most it leans off facing the camera (52 deg: seen across its axis, an ellipse 0.6 as wide)
  spinFx.frustumCulled = false; spinFx.renderOrder = 4; spinFx.visible = false; scene.add(spinFx);
  spinFx.onBeforeRender = (r, sc, cam) => {                  // per camera: the true ring about the axis, tilted no more than SW_TILT off facing this camera
    if (swFrame !== drawn) { swFrame = drawn; swPass = 0; }     // split view moves the one camera between its two draws: each draw of a frame keeps its own state
    const pass = Math.min(swPass++, 3); cFx.subVectors(cam.position, spinFx.position).normalize(); const along = spinAxis.dot(cFx);
    if (!swSide[pass] || along * swSide[pass] < -0.15) swSide[pass] = along < 0 ? -1 : 1;     // which end of the axis faces this camera (hysteresis: a pure backspin seen from behind sits near 0)
    const side = swSide[pass];
    nFx.copy(spinAxis).addScaledVector(cFx, -along); const across = nFx.length();         // the axis's part across the view
    if (across > 1e-4) nFx.multiplyScalar(side * Math.min(SW_TILT, across / Math.max(Math.abs(along), 1e-3)) / across);
    nFx.add(cFx).normalize();                                 // the facing normal of the ring; it turns about it the way the real ball does about that end of its axis
    camBack.set(0, 0, 1).applyQuaternion(cam.quaternion);
    qFx.setFromUnitVectors(camBack, nFx).multiply(cam.quaternion).multiply(qRoll.setFromAxisAngle(zFx, side * spinRoll));      // from the camera's own frame: under 60 deg of turn, no flips
    const k = 1.2 * fxScale(cam, spinFx.position) * spinFx.scale.x;     // seen from the other end of the axis it turns the other way: mirrored, so the heads still lead
    spinFx.matrixWorld.compose(spinFx.position, qFx, sFx.set(side * k, k, k)); };
  // serve cue: three short white arcs round the ball while it hangs for the serve, turning slowly and breathing (the look the spin streaks had
  // before the swirl). Billboarded per camera the same way; never on screen with the swirl (updateBallVis).
  const serveMat = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0, depthWrite: false, fog: false });
  const serveFx = new THREE.Group(); let serveA = 0, serveRoll = 0;
  for (let i = 0; i < 3; i++) { const arc = new THREE.Mesh(new THREE.TorusGeometry(BALL_R * 1.9, BALL_R * 0.13, 6, 14, 1.1), serveMat); arc.frustumCulled = false; arc.renderOrder = 4;
    arc.onBeforeRender = (r, sc, cam) => { qFx.copy(cam.quaternion).multiply(qRoll.setFromAxisAngle(zFx, serveRoll + i * Math.PI * 2 / 3));
      arc.matrixWorld.compose(serveFx.position, qFx, sFx.setScalar(fxScale(cam, serveFx.position) * serveFx.scale.x)); };
    serveFx.add(arc); }
  serveFx.visible = false; scene.add(serveFx);
  const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 28, 20), new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.45, emissive: 0xffffff, emissiveMap: ballTex, emissiveIntensity: 1.6 }));
  // The ball lights itself: from side 1 you see its shaded face (it measured 1.16 : 1 against the kitchen, 1.25 : 1 against the court), from side 0 the lit face
  // was 1.31 : 1 on the low sky. Through its own texture, so the holes still read and the spin still shows. Now 1.5 : 1 at worst (the milky south sky), 2.2+ elsewhere.
  ballMesh.visible = false; scene.add(ballMesh);       // no real shadow: the blob below is the depth cue
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, color: 0x000000, map: glowTex(), polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.02; blob.renderOrder = 3; blob.visible = false; scene.add(blob);
  const ball = { p: [0, 1, 0], v: [0, 0, 0], live: false, stamp: 0, seen: false, snap: true, pos: new THREE.Vector3(0, 1, 0), vel: new THREE.Vector3(), lastBy: -1,
    spin: 0, cool: 0, pulse: 0,                                      // backspin of a sliced ball (0..1) and the trail tint easing toward it
    core: new THREE.Vector3(0, 1, 0), err: new THREE.Vector3(), errT: 1, errDur: 0.1, blend: false, ext: false,
    bounces: 0, kick: 0, held: false };                              // what coast() needs beyond p and v; they ride on the state packet
  const clock = serverClock(), madeAt = clock.madeAt;   // pos = core (tracks the packets) + err (what is left of a correction, eased out)
  // attract: the endless rally behind the menus (docs/NEXT.md 11). All of it lives here: no server, no score, no sound.
  const at = { on: false, t: 0, rnd: null, by: 0, p: [0, 1, 0], v: [0, 0, 0], t0: 0, spin: 0, kick: 0, n: 0, hitAt: 0, hitP: [0, 1, 0], swung: false,
    run: [0, 1].map(() => ({ from: [0, 1, 0], to: [0, 1, 0], t0: 0, t1: 1, bh: false })), stats: { shots: 0, late: 0, out: 0, net: 9, gap: 0 } };

  // Two ribbons: a wide additive halo (the glow) and a narrower core drawn with normal blending over it. Light added to a bright court or sky
  // can only whiten it, so the halo alone read the same pale yellow at every power (and its smash came out LIGHTER than a drive); the core
  // puts the real colour on top, so orange and red survive on the court and against the sky.
  const TRAIL_N = 22, trail = { pts: [], acc: 0, glow: 0 }, trailC = [0, 0, 0];
  const ribbon = (name, alpha, blending, order) => { const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 6), 3));
    g.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_N * (alpha ? 8 : 6)), alpha ? 4 : 3));
    const idx = []; for (let i = 0; i < TRAIL_N - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2); g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
    m.name = name; m.frustumCulled = false; m.renderOrder = order; scene.add(m); return m; };
  const trailMesh = ribbon('trail', false, THREE.AdditiveBlending, 1), trailGeo = trailMesh.geometry;
  const coreMesh = ribbon('trailCore', true, THREE.NormalBlending, 2), coreGeo = coreMesh.geometry;

  // ---------- fx pools: rings, sparks, landing marker ----------
  const ringTex = canvasTex(128, 128, (c) => { c.strokeStyle = '#fff'; c.lineWidth = 9; c.beginPath(); c.arc(64, 64, 54, 0, 7); c.stroke(); });
  const rings = [];
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide }));
    m.visible = false; m.renderOrder = 4; scene.add(m); rings.push({ m, t: 1, dur: 1, r0: 0, r1: 1, a: 1 });
  }
  const flashMat = new THREE.SpriteMaterial({ color: 0xffffff, transparent: true, opacity: 0, blending: THREE.AdditiveBlending, depthWrite: false, depthTest: false });
  { const c = document.createElement('canvas'); c.width = c.height = 64; const x = c.getContext('2d'), g = x.createRadialGradient(32, 32, 0, 32, 32, 32);
    g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(0.35, 'rgba(255,244,190,.75)'); g.addColorStop(1, 'rgba(255,220,120,0)'); x.fillStyle = g; x.fillRect(0, 0, 64, 64);
    flashMat.map = new THREE.CanvasTexture(c); }
  const flash = new THREE.Sprite(flashMat); flash.visible = false; scene.add(flash); let flashT = 0, flashS = 1;
  const quiet = () => menu || at.on;                      // fx pools idle: no rings, bursts, flash, shake or marker behind a menu
  function flashAt(p, size) { if (quiet()) return; flash.position.set(p[0], p[1], p[2]); flashT = 1; flashS = size; flash.visible = true; }
  function updateFlash(dt) { if (flashT <= 0) return; flashT = Math.max(0, flashT - dt / 0.14); const k = 1 - flashT;
    flash.scale.setScalar(flashS * (0.6 + 2.4 * k)); flashMat.opacity = flashT * flashT; if (flashT === 0) flash.visible = false; }
  function ring(p, flat, r0, r1, dur, color, a = 1, additive = true) {
    if (quiet()) return;
    const r = rings.reduce((b, c) => (c.t / c.dur > b.t / b.dur ? c : b));
    Object.assign(r, { t: 0, dur, r0, r1, a, flat }); r.m.visible = true; r.m.material.color.set(color);
    r.m.material.blending = additive ? THREE.AdditiveBlending : THREE.NormalBlending;
    r.m.position.set(p[0], flat ? 0.03 : p[1], p[2]);
    if (flat) r.m.rotation.set(-Math.PI / 2, 0, 0);
  }
  const SPARKS = 120, sp = { p: new Float32Array(SPARKS * 3), c: new Float32Array(SPARKS * 3), v: new Float32Array(SPARKS * 3), life: new Float32Array(SPARKS), col: new Float32Array(SPARKS * 3), next: 0 };
  const sparkGeo = new THREE.BufferGeometry();
  sparkGeo.setAttribute('position', new THREE.BufferAttribute(sp.p, 3)); sparkGeo.setAttribute('color', new THREE.BufferAttribute(sp.c, 3));
  const sparks = new THREE.Points(sparkGeo, new THREE.PointsMaterial({ size: 0.16, map: glowTex(), vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, fog: false }));
  sparks.frustumCulled = false; scene.add(sparks);
  const rndFx = rng(99), tmpC = new THREE.Color(), tmpD = new THREE.Color();
  function burst(p, n, count, speed, colors, dirZ = 0) {
    if (quiet()) return;
    for (let k = 0; k < count; k++) {
      const i = sp.next = (sp.next + 1) % SPARKS, a = rndFx() * Math.PI * 2, e = (rndFx() - 0.3) * 1.6, s = speed * (0.4 + rndFx() * 0.8);
      sp.p.set(p, i * 3); sp.v.set([Math.cos(a) * Math.cos(e) * s, Math.sin(e) * s + 1.2, Math.sin(a) * Math.cos(e) * s + dirZ], i * 3);
      sp.life[i] = 0.26 + rndFx() * 0.26 + n * 0.12;
      tmpC.set(colors[k % colors.length]); sp.col.set([tmpC.r, tmpC.g, tmpC.b], i * 3);
    }
  }
  const markerTex = canvasTex(256, 256, (c) => {
    c.strokeStyle = '#fff'; c.lineWidth = 14; c.beginPath(); c.arc(128, 128, 104, 0, 7); c.stroke();
    c.lineWidth = 5; c.setLineDash([16, 12]); c.beginPath(); c.arc(128, 128, 70, 0, 7); c.stroke();
    c.fillStyle = '#fff'; c.beginPath(); c.arc(128, 128, 16, 0, 7); c.fill();
  });
  const marker = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: markerTex, transparent: true, depthWrite: false, opacity: 0, polygonOffset: true, polygonOffsetFactor: -3, polygonOffsetUnits: -3 }));
  marker.rotation.x = -Math.PI / 2; marker.position.y = 0.025; marker.renderOrder = 3; marker.visible = false; scene.add(marker);
  const mk = { t: 9, fade: 0 };

  // ---------- paddles / avatars ----------
  // Motion blur for the paddle: a ribbon swept between the throat and the tip of the face over the last few frames.
  // Additive, so alpha lives in the vertex colour. Preallocated; nothing is created per frame.
  const SW_N = 14;
  function makeSwoosh(color) {
    const g = new THREE.BufferGeometry(), pos = new Float32Array(SW_N * 2 * 3), col = new Float32Array(SW_N * 2 * 3), idx = [];
    for (let i = 0; i < SW_N - 1; i++) { const a = i * 2; idx.push(a, a + 1, a + 2, a + 1, a + 3, a + 2); }
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setIndex(idx);
    const m = new THREE.Mesh(g, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide }));
    m.frustumCulled = false; m.visible = false; scene.add(m);
    return { mesh: m, pos, col, n: 0, heat: 0, tint: new THREE.Color(color), lastTip: new THREE.Vector3(), lastQ: new THREE.Quaternion(), has: false };
  }
  const swTip = new THREE.Vector3(), swBase = new THREE.Vector3();
  function updateSwoosh(sw, group, dt, swinging) {
    swTip.set(0, FACE_C * 2.05, 0).applyQuaternion(group.quaternion).add(group.position);
    swBase.set(0, FACE_C * 0.35, 0).applyQuaternion(group.quaternion).add(group.position);
    // Only a HARD swing blurs: the paddle itself must be whipping round (not just carried along by footwork, the
    // camera-tracked body or the hit lunge), and its tip must really be travelling.
    const speed = sw.has ? swTip.distanceTo(sw.lastTip) / Math.max(dt, 1e-3) : 0; sw.lastTip.copy(swTip);
    const spinRate = sw.has ? 2 * Math.acos(Math.min(1, Math.abs(sw.lastQ.dot(group.quaternion)))) / Math.max(dt, 1e-3) : 0; sw.lastQ.copy(group.quaternion); sw.has = true;
    // only while a swing is actually in progress (the 'swung' event opens a short window); harder swing = brighter
    const want = swinging && spinRate > 7 && speed > 3 ? Math.min(1, 0.25 + (spinRate - 7) / 20) : 0;
    sw.heat += (want - sw.heat) * (want > sw.heat ? 0.5 : Math.min(1, dt * 16));
    if (sw.heat < 0.06 && want === 0) sw.heat = 0;                               // no ghost line lingering after it fades
    const P = sw.pos; P.copyWithin(6, 0, (SW_N - 1) * 6);                       // shift the history back one slot
    P[0] = swBase.x; P[1] = swBase.y; P[2] = swBase.z; P[3] = swTip.x; P[4] = swTip.y; P[5] = swTip.z;
    sw.n = Math.min(SW_N, sw.n + 1);
    for (let i = 0; i < SW_N; i++) { const k = i < sw.n ? sw.heat * Math.pow(1 - i / SW_N, 1.6) * 0.5 : 0, o = i * 6;
      if (i >= sw.n) { P[o] = P[o - 6]; P[o + 1] = P[o - 5]; P[o + 2] = P[o - 4]; P[o + 3] = P[o - 3]; P[o + 4] = P[o - 2]; P[o + 5] = P[o - 1]; }
      sw.col[o] = sw.col[o + 3] = sw.tint.r * k; sw.col[o + 1] = sw.col[o + 4] = sw.tint.g * k; sw.col[o + 2] = sw.col[o + 5] = sw.tint.b * k; }
    sw.mesh.visible = sw.heat > 0.06;
    sw.mesh.geometry.attributes.position.needsUpdate = true; sw.mesh.geometry.attributes.color.needsUpdate = true;
  }
  const pads = [0, 1].map(side => {
    const group = buildPaddle(side), avatar = buildAvatar(side);
    const skinM = new THREE.MeshStandardMaterial({ color: COL.skin, roughness: 0.7 });
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.072, 18, 14), skinM); hand.castShadow = true;
    const ghostM = new THREE.MeshStandardMaterial({ color: COL.skin, roughness: 0.7, transparent: true, opacity: 0.32, depthWrite: false });
    const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.062, 0.6, 14, 1, true).translate(0, -0.3, 0), ghostM);   // hangs from the hand along -y
    const sleeveM = new THREE.MeshStandardMaterial({ color: COL.shirt[side], transparent: true, opacity: 0.4, depthWrite: false });
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.066, 0.075, 0.14, 14, 1, true).translate(0, -0.62, 0), sleeveM);
    forearm.add(sleeve); forearm.renderOrder = 5;
    const tag = new THREE.Sprite(new THREE.SpriteMaterial({ transparent: true, depthTest: false, depthWrite: false, sizeAttenuation: false, toneMapped: false }));      // the status tag over the head: a billboard by nature (each split half faces its own camera), one size at any distance, over the scenery
    tag.center.set(0.5, 0); tag.renderOrder = 50;
    for (const o of [group, avatar, hand, forearm, tag]) { o.visible = false; scene.add(o); }
    return { side, group, avatar, hand, forearm, tag, status: null, tagFor: null, ghost: 0, mats: [], handM: skinM, ghostM, sleeveM, has: false, init: false, bot: false, matt: false,      // bot: canned swing, no q. matt: Matt's look. Only the attract rally's side 0 has the first without the second
      tgt: { x: 0, y: 1, z: sgn(side) * 6.5, q: new THREE.Quaternion(), off: null },
      pos: new THREE.Vector3(0, 1, sgn(side) * 6.5), q: new THREE.Quaternion(), off: new THREE.Vector3(),
      lunge: 0, reach: false, reachV: new THREE.Vector3(), hitP: [0, 1, 0], swingT: -1, swungAt: -9, mirror: 1, bodyX: 0, bodyZ: sgn(side) * 6.8, vx: 0, cheer: 0, world: new THREE.Vector3() };
  });
  const casters = []; for (const pd of pads) for (const o of [pd.group, pd.avatar, pd.hand]) o.traverse(m => { if (m.castShadow) casters.push(m); });
  // ---------- seat status (docs/NEXT.md 14a): calibrating / paused / away. The character and its paddle go pale and see-through, a tag floats over the head ----------
  // One tween value per pad (pd.ghost, 0.25 s each way) drives the SAME materials toward white: nothing is swapped, nothing is allocated per frame.
  const WHITE = new THREE.Color(0xffffff), TAG_WORD = { calibrating: 'Calibrating', paused: 'Paused', away: 'Reconnecting' }, tagTex = {};
  for (const pd of pads) { const seen = new Set(); for (const o of [pd.group, pd.avatar, pd.hand]) o.traverse(m => { if (m.isMesh) for (const mt of [].concat(m.material)) if (!seen.has(mt)) { seen.add(mt); pd.mats.push(mt); } }); rebase(pd); }      // (the paddle's face is a mesh with several materials)
  function rebase(pd) { for (const m of pd.mats) m.userData.base = { c: (m.userData.base ? m.userData.base.c : new THREE.Color()).copy(m.color), o: m.userData.base ? m.userData.base.o : m.opacity, t: m.userData.base ? m.userData.base.t : m.transparent }; }   // the colours to come back to (paint() changes them when Matt takes a seat)
  function ghostify(pd) {
    const k = ease(pd.ghost);
    for (const m of pd.mats) { const b = m.userData.base, t = b.t || k > 0; m.color.copy(b.c).lerp(WHITE, 0.86 * k); if (m.emissive) m.emissive.setScalar(0.3 * k); m.opacity = b.o * (1 - 0.5 * k); if (m.transparent !== t) { m.transparent = t; m.needsUpdate = true; } }
  }
  function tagTexture(status) {                             // built once per status: a white pill, a small icon, ONE word
    if (tagTex[status]) return tagTex[status];
    const c = document.createElement('canvas'), W = c.width = 640, H = c.height = 160, g = c.getContext('2d'), tex = new THREE.CanvasTexture(c); tex.colorSpace = THREE.SRGBColorSpace; tex.anisotropy = 4;
    const draw = () => {
      g.clearRect(0, 0, W, H); g.font = '800 72px "Poddle Rounded", system-ui, sans-serif'; const word = TAG_WORD[status], tw = g.measureText(word).width, w = Math.min(W - 8, tw + 190), x0 = (W - w) / 2, r = 68;
      g.beginPath(); g.roundRect(x0, 12, w, H - 24, r); g.fillStyle = 'rgba(255,255,255,.96)'; g.fill(); g.lineWidth = 6; g.strokeStyle = '#34beed'; g.stroke();
      const ix = x0 + 78, iy = H / 2; g.strokeStyle = g.fillStyle = '#1c8fd0'; g.lineWidth = 11; g.lineCap = 'round';
      if (status === 'paused') { g.beginPath(); g.roundRect(ix - 26, iy - 32, 19, 64, 7); g.roundRect(ix + 7, iy - 32, 19, 64, 7); g.fill(); }
      else if (status === 'calibrating') { g.beginPath(); g.arc(ix, iy, 30, 0, 7); g.stroke(); g.beginPath(); g.arc(ix, iy, 9, 0, 7); g.fill(); g.beginPath(); for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0]]) { g.moveTo(ix + dx * 30, iy + dy * 30); g.lineTo(ix + dx * 42, iy + dy * 42); } g.stroke(); }
      else { for (const rr of [50, 31]) { g.beginPath(); g.arc(ix, iy + 28, rr, -Math.PI * 0.76, -Math.PI * 0.24); g.stroke(); } g.beginPath(); g.arc(ix, iy + 24, 9, 0, 7); g.fill(); }      // a wifi mark
      g.fillStyle = '#39434d'; g.textBaseline = 'middle'; g.fillText(word, x0 + 140, H / 2 + 5); tex.needsUpdate = true;
    };
    draw(); try { const f = '800 72px "Poddle Rounded"'; if (document.fonts && !document.fonts.check(f)) document.fonts.load(f).then(draw, () => {}); } catch (_) { /* the fallback font is fine */ }
    return tagTex[status] = tex;
  }
  let vpW = 1, vpH = 1;                                     // the viewport being drawn (a half, in split): the tag's size is set in its pixels
  function placeTag(pd) {
    const on = pd.avatar.visible && pd.ghost > 0.02 && !!pd.tagFor; pd.tag.visible = on; if (!on) return;
    const e = camera.projectionMatrix.elements, px = clamp(vpH * 0.062, 34, 58);      // sizeAttenuation off: scale is NDC / lens, so pixels -> scale through the projection's own terms
    pd.tag.scale.set(2 * px * 4 / (vpW * e[0]), 2 * px / (vpH * e[5]), 1); pd.tag.material.opacity = ease(pd.ghost);
    pd.tag.position.set(pd.avatar.position.x, pd.avatar.position.y + 2.42, pd.avatar.position.z);
  }
  function paint(pd, matt) {                                // a seat changes hands between a person and Matt: repaint, don't rebuild
    pd.matt = matt; const u = pd.avatar.userData, m = matt ? COL.matt : null, skin = m ? m.skin : COL.skin, shirt = m ? m.shirt : COL.shirt[pd.side];
    u.skin.color.setHex(skin); u.shirt.color.setHex(shirt); u.hairM.color.setHex(m ? m.hair : COL.hair[pd.side]); for (const w of u.whites) w.visible = matt; u.hair.visible = !matt; for (const e of u.eyes) e.visible = !matt; for (const o of u.mattFace) o.visible = matt;      // Matt is bald, with his own eyes
    pd.handM.color.setHex(skin); pd.ghostM.color.setHex(skin); pd.sleeveM.color.setHex(shirt);       // the hand on his paddle, and his forearm when a spectator looks through his eyes
    rebase(pd); if (pd.ghost > 0) ghostify(pd);
  }
  // Whose eyes is the picture taken from? Their avatar is hidden and their ghost forearm shown. -1: nobody's (broadcast, free, attract, a spectator's menu).
  const eyeSide = () => (at.on || (spectator && (menu || vName !== 'pov')) ? -1 : spectator ? vSide : localSide);
  const isMe = side => !spectator && !at.on && side === localSide;      // the 1:1 paddle and "my" sounds. A spectator has neither; both paddles are remote
  function dress(eye, hideBack, hideSide) {                 // what this camera may see: per view, and per half in split
    for (const pd of pads) { pd.avatar.visible = pd.has && pd.side !== eye; pd.forearm.visible = pd.has && pd.side === eye; placeTag(pd); }
    for (let i = 0; i < 2; i++) { const b = i !== hideBack, s = i !== hideSide; for (const o of backFence[i]) o.visible = b; for (const o of sideFence[i]) o.visible = s; }
  }
  const E = new THREE.Euler(0, 0, 0, 'YXZ'), qA = new THREE.Quaternion(), vA = new THREE.Vector3(), vB = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0), e3 = [0, 0, 0];
  const D2R = Math.PI / 180;

  function updatePads(dt) {
    for (const pd of pads) {
      const vis = pd.has; pd.group.visible = pd.hand.visible = vis;             // avatar / forearm: dress(), once the camera is known
      const want = pd.status && vis && !at.on ? 1 : 0; if (pd.ghost !== want) { pd.ghost = clamp(pd.ghost + (want ? dt : -dt) / 0.25, 0, 1); ghostify(pd); }      // whited out while calibrating / paused / away
      if (!vis) continue;
      const s = sgn(pd.side), local = isMe(pd.side), t = pd.tgt;
      if (!pd.init) { pd.pos.set(t.x, t.y, t.z); pd.q.copy(t.q); pd.bodyX = t.x - s * BODY[0]; pd.bodyZ = t.z + s * BODY[1]; pd.init = true; }
      // local paddle is 1:1 (only the server-stepped z gets a whisper of filtering); remote is 20Hz -> slerp/lerp
      const kp = local ? 1 : damp(dt, 0.055);
      pd.pos.x = lerp(pd.pos.x, t.x, kp); pd.pos.y = lerp(pd.pos.y, t.y, kp); pd.pos.z = lerp(pd.pos.z, t.z, damp(dt, local ? 0.03 : 0.06));
      if (pd.bot) {                                        // bots never send a q: idle sway + canned swing
        if (pd.swingT >= 0) { pd.swingT += dt; if (pd.swingT > SWING[SWING.length - 1][0]) pd.swingT = -1; }
        if (pd.swingT >= 0) swingEuler(pd.swingT, e3); else { e3[0] = IDLE[0]; e3[1] = IDLE[1]; e3[2] = IDLE[2]; }
        const br = Math.sin(timeS * 2.1 + pd.side);
        E.set((e3[1] + br * 2.5) * D2R, e3[0] * pd.mirror * D2R, (e3[2] * pd.mirror + br * 3) * D2R);
        qA.setFromEuler(E);
        if (pd.swingT >= 0) pd.q.copy(qA); else pd.q.slerp(qA, damp(dt, 0.08));
      } else if (local) pd.q.copy(t.q); else pd.q.slerp(t.q, damp(dt, 0.045));
      // swing-arc offset (player frame): given for the local player, else the kinematic arm of the SMOOTHED q
      if (t.off && !pd.bot) pd.off.set(t.off[0], t.off[1], t.off[2]);
      else {                                                   // high-passed: a held pose relaxes to no offset at all
        const o = armOffset([pd.q.x, pd.q.y, pd.q.z, pd.q.w]), k = damp(dt, 0.35);
        if (!pd.offRef) pd.offRef = [o[0], o[1], o[2]];
        for (let i = 0; i < 3; i++) pd.offRef[i] += (o[i] - pd.offRef[i]) * k;
        pd.off.set(o[0] - pd.offRef[0], o[1] - pd.offRef[1], o[2] - pd.offRef[2]);
      }
      pd.lunge = Math.max(0, pd.lunge - dt / 0.32);
      const lg = Math.sin(Math.min(1, pd.lunge * 1.15) * Math.PI) * 0.2;       // out and back, gently
      const w = pd.world.set(pd.pos.x + s * pd.off.x, Math.max(0.12, pd.pos.y + pd.off.y + lg * 0.12), pd.pos.z + s * (pd.off.z - lg));
      pd.group.quaternion.set(s * pd.q.x, pd.q.y, s * pd.q.z, pd.q.w);         // T*P*T^-1 for side 1
      if (pd.reach) {                                      // just hit: the server's contact box is generous, so pull the FACE onto the ball for a beat
        vA.set(0, FACE_C, 0).applyQuaternion(pd.group.quaternion).add(w);
        pd.reachV.set(clamp(pd.hitP[0] - vA.x, -REACH_MAX, REACH_MAX), clamp(pd.hitP[1] - vA.y, -REACH_MAX, REACH_MAX), 0); pd.reach = false;
      }
      // ease INTO the ball over 3 frames and back out over the rest: a 1-frame snap read as the paddle clipping into a pose,
      // 80 ms read as a late contact. Only the paddle eases: the ball, pop, burst and shake all start on the event's frame.
      const ts = (1 - pd.lunge) * 0.32, rk = pd.lunge > 0 ? ease(Math.min(1, ts / 0.05)) * (1 - ease(ts / 0.32)) : 0;
      w.x += pd.reachV.x * rk; w.y = Math.max(0.12, w.y + pd.reachV.y * rk);
      pd.group.position.copy(w); pd.hand.position.copy(w);
      if (!pd.swoosh) pd.swoosh = makeSwoosh(local ? 0xfff1c9 : 0xffd0b8);
      updateSwoosh(pd.swoosh, pd.group, dt, timeS < (pd.swooshUntil || 0));
      if (local || spectator) {                            // ghost forearm: from the hand back toward a virtual elbow (a spectator may look through either player's eyes)
        vA.set(pd.pos.x + s * 0.2, Math.max(0.2, pd.pos.y - 0.3), pd.pos.z + s * 0.72).sub(w).normalize();
        pd.forearm.position.copy(w); pd.forearm.quaternion.setFromUnitVectors(DOWN, vA);
      }
      if (!local) {                                             // Mii stands so its right shoulder is the arm pivot: the paddle sweeps around the body, not through it
        const bx = pd.pos.x - s * BODY[0], bz = pd.pos.z + s * BODY[1], px = pd.bodyX;
        pd.bodyX = lerp(pd.bodyX, bx, damp(dt, 0.12)); pd.bodyZ = lerp(pd.bodyZ, bz, damp(dt, 0.12));
        pd.vx = lerp(pd.vx, (pd.bodyX - px) / Math.max(dt, 1e-3), damp(dt, 0.1));
        pd.cheer = Math.max(0, pd.cheer - dt);
        const hop = pd.cheer > 0 ? Math.abs(Math.sin(pd.cheer * 9)) * 0.28 : 0, run = Math.min(1, Math.abs(pd.vx) / 3);
        const a = pd.avatar, u = a.userData;
        a.position.set(pd.bodyX, hop + Math.abs(Math.sin(timeS * 11)) * 0.05 * run, pd.bodyZ);
        a.rotation.set(0, s > 0 ? 0 : Math.PI, 0); a.rotateZ(clamp(-pd.vx * s * 0.05, -0.22, 0.22)); a.rotateX(-0.06 - run * 0.08 - (pd.swingT >= 0 ? 0.1 : 0));
        u.body.scale.y = 1 + Math.sin(timeS * 2.4 + pd.side) * 0.018;
        u.offHand.position.y = 0.85 + Math.sin(timeS * 2.4 + 1) * 0.02 + hop * 0.6;
        if (ball.seen) {                                   // head tracks the ball
          const dx = (ballMesh.position.x - pd.bodyX) * s, dz = Math.max(0.5, (pd.bodyZ - ballMesh.position.z) * s);
          u.head.rotation.y = lerp(u.head.rotation.y, clamp(-Math.atan2(dx, dz), -0.8, 0.8), damp(dt, 0.12));
          u.head.rotation.x = lerp(u.head.rotation.x, clamp(Math.atan2(ballMesh.position.y - 1.6, dz + 2) * 0.8, -0.3, 0.5), damp(dt, 0.12));
        }
      }
      // bots: start the wind-up just before the ball arrives so contact lands mid-sweep
      if (pd.bot && pd.swingT < 0 && !frozen && !at.on && ball.live && ball.lastBy !== pd.side && ball.vel.z * s > 0.5) {      // attract times its own swings; a paused ball is not arriving
        const ahead = -(ball.pos.z - pd.pos.z) * s, tc = (ahead - 0.7) / Math.abs(ball.vel.z);
        if (ahead > 0 && tc < SWING_CONTACT && Math.abs(ball.pos.x - pd.pos.x) < 1.5) startSwing(pd);
      }
    }
  }
  function startSwing(pd, at = 0) {
    pd.swingT = at; pd.mirror = (ball.pos.x - pd.pos.x) * sgn(pd.side) < -0.25 ? -1 : 1;     // ball on their left -> backhand
  }

  function updateBallVis(now, dt) {
    const b = ball;
    if (!b.seen) { spinW = 0; return; }                   // hidden (hideBall): no stale swirl when it comes back
    if (frozen && !at.on) {                                // paused, or a seat is held: the ball stays where it is drawn. No coast, no hover, no blend, no new trail points
      if (!ballMesh.visible && b.live) { b.pos.set(b.p[0], Math.max(BALL_R, b.p[1]), b.p[2]); b.core.copy(b.pos); b.errT = 1; ballMesh.position.copy(b.pos); blob.position.set(b.pos.x, 0.02, b.pos.z); ballMesh.visible = blob.visible = trailMesh.visible = true; }   // joined a paused room: the packet is where it hangs
      return;
    }
    if (at.on) { coast(b.pos, b.vel, at.p, at.v, at.t - at.t0, at.spin, 0, at.kick); b.core.copy(b.pos); b.errT = 1; }      // one closed-form flight from the last contact: it cannot drift
    else if (b.live) {
      const age = clamp((now - b.stamp) / 1000, 0, b.held ? HOVER_MAX : COAST_MAX), far = pads[1 - localSide];
      if (b.held) hover(vA, b.vel, b.p, b.v, age);
      else coastTo(vA, b.vel, b.p, b.v, age, b.spin, b.bounces, b.kick, far && far.has ? far.pos.z : 0);
      if (b.blend) {                                       // a hit moved the truth (a late swing meets the ball where it WAS): the drawn ball takes the new
        b.blend = false; b.err.copy(b.pos).sub(vA);        // velocity on this frame and slides onto the new path, instead of teleporting
        const e = b.err.length(); if (e > 5) b.snap = true; else { b.core.copy(vA); b.errT = 0; b.errDur = clamp(0.08 + 0.05 * e, 0.08, 0.18); }
      }
      if (b.snap || vA.distanceToSquared(b.core) > 2.2) { b.core.copy(vA); b.errT = 1; b.snap = false; trail.pts.length = 0; }
      else if (b.errT > 0) { b.core.addScaledVector(b.vel, dt); b.core.lerp(vA, damp(dt, 0.018)); }     // predict, then pull to the packet: hides LAN jitter, no lag
      b.errT += dt / b.errDur;
      b.pos.copy(b.core); if (b.errT < 1) b.pos.addScaledVector(b.err, 1 - ease(b.errT));
      b.pos.y = Math.max(BALL_R, b.pos.y);
    } else {                                               // rally over: let it bounce away on its own
      b.vel.y -= G * dt; b.pos.addScaledVector(b.vel, dt);
      if (b.pos.y < BALL_R) { b.pos.y = BALL_R; b.vel.y = Math.abs(b.vel.y) * 0.6; b.vel.x *= 0.75; b.vel.z *= 0.75; if (b.vel.y < 0.6) b.vel.y = 0; }
    }
    ballMesh.visible = blob.visible = trailMesh.visible = true; ballMesh.position.copy(b.pos);
    if (b.pulse > 0) { b.pulse = Math.max(0, b.pulse - dt / 0.16); ballMesh.scale.setScalar(1 + 0.9 * b.pulse * b.pulse); } else ballMesh.scale.setScalar(1);
    const sp2 = Math.hypot(b.vel.x, b.vel.z);
    // rolls the way it flies; a sliced ball visibly spins BACKWARDS, and fast
    // 60 rad/s at 60 fps is ~1 rad a frame on a ball with a regular hole pattern: it strobes and reads as NOT spinning.
    // So backspin is drawn slower than life (~3 turns a second), and a swirl of wind whips around the ball with it.
    if (sp2 > 0.05) { vB.set(b.vel.z, 0, -b.vel.x).normalize(); ballMesh.rotateOnWorldAxis(vB, lerp(Math.min(sp2 / BALL_R * 0.35, 40), -19, b.spin) * dt); }
    serveA = b.live && b.held && !at.on ? Math.min(1, serveA + dt / 0.25) : Math.max(0, serveA - dt / 0.12);     // gone almost at once when it is struck
    serveFx.visible = serveA > 0;
    if (serveFx.visible) { const k = 0.5 - 0.5 * Math.cos(timeS * Math.PI * 2 * 1.2); serveFx.position.copy(b.pos); serveRoll -= 1.6 * dt; serveFx.scale.setScalar(1.05 + 0.2 * k); serveMat.opacity = serveA * (0.85 + 0.15 * k); }     // turning gently, breathing out and in 1.2 times a second, brightest when widest
    {                                                      // the swirl: what the spin will do to the first bounce, from the same numbers coast() bounces with
      const spin = at.on ? at.spin : b.spin, kick = at.on ? at.kick : b.kick, cut = (SPUN.along - FLOOR.along) * spin;
      if (at.on) { if (at.t0 !== swHit) { swHit = at.t0; swLanded = false; } if (b.pos.y <= BALL_R + 1e-3) swLanded = true; }     // attract has no bounce count: watch the floor
      const dx = b.vel.x * cut + kick, dz = b.vel.z * cut, D = Math.hypot(dx, dz), on = b.live && !b.held && !(at.on ? swLanded : b.bounces > 0) && spin > 0.02;
      if (on && D > 0.05) spinAxis.set(dz / D, 0, -dx / D);     // up x D
      spinW += ((on ? clamp(D / 4, 0, 1) : 0) - spinW) * damp(dt, 0.08);
      spinFx.position.copy(b.pos); spinFx.visible = spinW > 0.05 && serveA === 0;     // the serve cue goes first (0.12 s), then the swirl comes in
      if (spinFx.visible) { spinRoll = (spinRoll + (5 + 13 * spinW) * dt) % (Math.PI * 2); updateSpinFx(spinW, timeS); spinMat.opacity = Math.min(1, spinW * 5) * (0.45 + 0.5 * spinW); }
    }
    const h = b.pos.y - BALL_R, k = 1 / (1 + h * 0.55);
    blob.position.set(b.pos.x, 0.02, b.pos.z); blob.scale.setScalar(0.22 + 0.36 * k); blob.material.opacity = 0.35 + 0.5 * k;
    // ribbon trail, camera-facing
    b.cool += ((b.live && !b.held ? b.spin : 0) - b.cool) * damp(dt, 0.08);
    b.hot = (b.hot || 0) + ((b.live ? b.power || 0 : 0) - (b.hot || 0)) * damp(dt, 0.05);      // a hit sets it outright (onEvent); this only glides a re-aim, and cools it when the rally is over
    if (b.live && b.hot > SMASH_N) { b.ember = (b.ember || 0) + dt;      // embers and the fat flame are the smash's own (they started at n 0.55-0.6, the OLD smash line: drives at 21-27 rad/s wore them too)
      if (b.ember > 0.028) { b.ember = 0; burst([b.pos.x, b.pos.y, b.pos.z], 0.2, 3, 1.6, [0xff5a1f, 0xffb340, 0xfff0a0]); } }
    trail.glow = Math.max(b.live ? 0.55 + 0.35 * trailHeat(b.hot) : 0, trail.glow - dt * 1.6); trail.acc += dt;
    if (trail.acc >= 1 / 90) { trail.acc = 0; trail.pts.unshift(b.pos.clone()); if (trail.pts.length > TRAIL_N) trail.pts.pop(); }
  }
  const lin = c => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);   // vertex colours are linear (the renderer writes sRGB): unconverted, the ramp's orange drew as pale amber and its red as salmon
  function drawTrail() {                                   // after the camera is posed (twice a frame in split: each half gets a ribbon that faces ITS camera)
    const b = ball; coreMesh.visible = trailMesh.visible; if (!trailMesh.visible) return;
    const P = trailGeo.attributes.position.array, C = trailGeo.attributes.color.array, PC = coreGeo.attributes.position.array, CC = coreGeo.attributes.color.array, n = trail.pts.length;
    // one colour per shot, the heat of its power: white tap -> yellow -> orange -> red smash (trailHeat spreads the powers people really swing over it)
    const h = b.hot || 0, t = trailHeat(h), fire = Math.max(0, (h - SMASH_N) / (1 - SMASH_N)), c = trailRamp(t, trailC), boost = 1 + 0.9 * fire;   // fire: 0 below smash power, 1 at full
    const r = lin(c[0]), g = lin(c[1]), bl = lin(c[2]), core = clamp(0.35 + 0.65 * trail.glow, 0, 1);
    for (let i = 0; i < TRAIL_N; i++) {
      const p = trail.pts[Math.min(i, n - 1)] || b.pos, q = trail.pts[Math.min(i + 1, n - 1)] || p, f = i < n ? 1 - i / TRAIL_N : 0;
      vA.subVectors(p, q); vB.subVectors(camera.position, p); vA.cross(vB); if (vA.lengthSq() < 1e-10) vA.set(0, 0, 0); else vA.normalize();
      const lick = fire * (0.75 + 0.25 * Math.sin(timeS * 47 + i * 1.9)), wh = BALL_R * (0.85 + 0.6 * t + 1.5 * lick) * f, wc = BALL_R * (0.42 + 0.3 * t + 0.9 * lick) * f;   // harder = wider; a smash drags a fat, licking flame
      P[i * 6] = p.x + vA.x * wh; P[i * 6 + 1] = p.y + vA.y * wh; P[i * 6 + 2] = p.z + vA.z * wh; P[i * 6 + 3] = p.x - vA.x * wh; P[i * 6 + 4] = p.y - vA.y * wh; P[i * 6 + 5] = p.z - vA.z * wh;
      PC[i * 6] = p.x + vA.x * wc; PC[i * 6 + 1] = p.y + vA.y * wc; PC[i * 6 + 2] = p.z + vA.z * wc; PC[i * 6 + 3] = p.x - vA.x * wc; PC[i * 6 + 4] = p.y - vA.y * wc; PC[i * 6 + 5] = p.z - vA.z * wc;
      const a = f * f * trail.glow * 0.7 * boost, ac = Math.pow(f, 1.2) * core;     // halo: added light, soft; core: the colour itself, over whatever is behind it
      for (let j = 0; j < 2; j++) { const k = i * 6 + j * 3, kc = i * 8 + j * 4;
        C[k] = r * a; C[k + 1] = g * a; C[k + 2] = bl * a; CC[kc] = r; CC[kc + 1] = g; CC[kc + 2] = bl; CC[kc + 3] = ac; }
    }
    trailGeo.attributes.position.needsUpdate = trailGeo.attributes.color.needsUpdate = coreGeo.attributes.position.needsUpdate = coreGeo.attributes.color.needsUpdate = true;
  }

  function faceFx() { for (const r of rings) if (r.m.visible && !r.flat) r.m.quaternion.copy(camera.quaternion); }      // per camera, like the trail
  function stopFx() {                                      // a menu came up: nothing may hang in the air behind it, or pop back when it goes
    for (const r of rings) { r.m.visible = false; r.t = r.dur; } sp.life.fill(0); sp.c.fill(0); sparkGeo.attributes.color.needsUpdate = true;
    flashT = 0; flash.visible = false; marker.visible = false; cam.shake = 0; ball.pulse = 0;
  }
  function updateFx(dt) {
    updateFlash(dt);
    for (const r of rings) {
      if (!r.m.visible) continue;
      r.t += dt; const k = r.t / r.dur; if (k >= 1) { r.m.visible = false; continue; }
      r.m.scale.setScalar(lerp(r.r0, r.r1, 1 - (1 - k) ** 3) * 2); r.m.material.opacity = r.a * (1 - k) ** 1.5;
    }
    for (let i = 0; i < SPARKS; i++) {
      const j = i * 3;
      if (sp.life[i] <= 0) { sp.c[j] = sp.c[j + 1] = sp.c[j + 2] = 0; continue; }
      sp.life[i] -= dt; sp.v[j + 1] -= G * 0.7 * dt;
      for (let a = 0; a < 3; a++) { sp.v[j + a] *= 1 - 3.4 * dt; sp.p[j + a] += sp.v[j + a] * dt; }
      if (sp.p[j + 1] < 0.03) { sp.p[j + 1] = 0.03; sp.v[j + 1] *= -0.4; }
      const f = clamp(sp.life[i] / 0.3, 0, 1); for (let a = 0; a < 3; a++) sp.c[j + a] = sp.col[j + a] * f;
    }
    sparkGeo.attributes.position.needsUpdate = sparkGeo.attributes.color.needsUpdate = true;
    if (marker.visible) {
      mk.t += dt; if (mk.fade > 0) mk.fade += dt;
      const a = Math.min(1, mk.t / 0.12) * (mk.fade > 0 ? 1 - mk.fade / 0.3 : 1) * (mk.t > 2.2 ? Math.max(0, 1 - (mk.t - 2.2) / 0.5) : 1);
      if (a <= 0) marker.visible = false;
      marker.material.opacity = a * 0.85; marker.scale.setScalar(1.15 + Math.sin(mk.t * 9) * 0.07 + Math.max(0, 0.6 - mk.t * 3)); marker.rotation.z = mk.t * 1.4;
    }
  }

  // Head-coupled perspective (the Johnny Lee Wii-remote trick): the screen is a window onto the court. The window is a
  // fixed rectangle through the court centre, square to the locked-off view; the eye slides with the player and the
  // frustum goes off-axis so the window stays put. The net and far court never move on screen, near things shift
  // against the eye, and the paddle stays well inside the frame at the sideline.
  function spring(o, k, vk, target, tau, dt) {             // critically damped follow (no overshoot, no allocations)
    const w = 2 / tau, x = w * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x), c = o[k] - target, tmp = (o[vk] + w * c) * dt;
    o[vk] = (o[vk] - w * tmp) * e; o[k] = target + (c + tmp) * e;
  }
  const fovFor = (base, aspect) => (aspect < 1.2 ? lerp(Math.max(74, base), base, clamp((aspect - 0.5) / 0.7, 0, 1)) : base);   // keep the court in frame on tall windows (and in each tall half of a split)
  const povSt = [0, 1].map(() => ({ x: 0, y: 0, vx: 0, vy: 0, z: 0, cut: true }));      // a spectator looking through a player's eyes: that seat's own smoothed offset + run-back
  // The play camera, for any seat. st: that seat's smoothed state (the seated player's is `view`). viewer: honour setViewer() (the seated player only).
  function playPose(side, st, aspect, viewer, dt) {
    const s = sgn(side), me = pads[side];
    camera.aspect = aspect; camera.fov = fovFor(cam.fovBase, aspect);
    // viewer offset: setViewer() while it is fresh, else wherever that paddle stands
    let tx = 0, ty = 0;
    if (viewer && timeS - view.at < 0.5) { tx = view.inX; ty = view.inY; }
    else if (me.has) { tx = me.pos.x * s / court.halfW; ty = (me.pos.y - 1) / 1.3; }
    // the server runs you back for deep balls (up to ~2 m behind the baseline). The camera goes with you, or the
    // paddle drops off the bottom of the screen exactly when the ball arrives.
    const back = me.has ? me.pos.z * s - 6.5 : 0, bz = back > 0 ? back : back * 0.5;
    if (st.cut) { st.cut = false; st.x = clamp(tx, -1, 1); st.y = clamp(ty, -1, 1); st.vx = st.vy = 0; st.z = bz; }      // changing view is a cut: no slide in from the last pose
    spring(st, 'x', 'vx', clamp(tx, -1, 1), VIEW.tau, dt); spring(st, 'y', 'vy', clamp(ty, -1, 1), VIEW.tau, dt);
    st.z = lerp(st.z || 0, bz, damp(dt, 0.18));
    const k = cam.shake, t = timeS * 1000;
    // locked-off pose (+ shake): fixes the view direction and the window
    camera.position.set(Math.sin(t * 0.093) * k, 3.1 + Math.sin(t * 0.117 + 1) * k * 0.8, s * (court.halfL + 5.4 + (st.z || 0)) + Math.sin(t * 0.071 + 2) * k * 0.5);
    vB.set(0, 0.35, s * (0.4 + (st.z || 0) * 0.6)); camera.lookAt(vB);
    // window = the net plane: depth of the net's centre along the view axis (the look target itself moves with the run-back)
    const D = vB.set(0, court.net / 2, 0).sub(camera.position).dot(vA.set(0, 0, -1).applyQuaternion(camera.quaternion)), hh = D * Math.tan(camera.fov * D2R / 2), hw = hh * camera.aspect;
    // slide the eye in the camera's own axes (side 1's right is world -x, which the camera's right already is);
    // far offside it also drifts back so the whole near court still fits beside the paddle
    const g = VIEW_PARALLAX, ex = st.x * VIEW.x * g * clamp(hw / 8, 0.4, 1),   // less sideways travel through a narrow window
      ey = st.y * VIEW.y * g, eb = st.x * st.x * VIEW.back * g;
    camera.position.add(vA.set(1, 0, 0).applyQuaternion(camera.quaternion).multiplyScalar(ex));
    camera.position.add(vA.set(0, 1, 0).applyQuaternion(camera.quaternion).multiplyScalar(ey));
    camera.position.add(vA.set(0, 0, 1).applyQuaternion(camera.quaternion).multiplyScalar(eb));
    if (viewer) cam.x = camera.position.x;
    const n = camera.near / (D + eb);
    camera.projectionMatrix.makePerspective((-hw - ex) * n, (hw - ex) * n, (hh - ey) * n, (-hh - ey) * n, camera.near, camera.far);
    camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
  }
  const shaken = (x, y, z) => { const k = cam.shake, t = timeS * 1000; camera.position.set(x + Math.sin(t * 0.093) * k, y + Math.sin(t * 0.117 + 1) * k * 0.8, z + Math.sin(t * 0.071 + 2) * k * 0.5); };
  function lens(fov, aspect) { camera.aspect = aspect; camera.fov = fov; camera.updateProjectionMatrix(); }
  // Broadcast: side-on from beyond the +x net post, so side 0 (+z) is on screen LEFT, like the spectator scoreboard.
  function broadcastPose(aspect) {
    const X = court.halfW + 10, Y = 5.5; let fov = 38;
    shaken(X, Y, still ? 0 : Math.sin(timeS / 6.1) * 0.3);
    for (let i = 0; i < 2; i++) {                          // narrow window: widen until both players' run-off is in frame, and lift the gaze so the frame's foot stays on the apron
      const down = Math.min(Math.atan2(Y - 0.8, X), (40 - fov / 2) * D2R); camera.lookAt(vB.set(0, Y - Math.tan(down) * X, 0)); camera.updateMatrixWorld();      // (past 40 deg down it would stare into the planting under the lens)
      let need = 0; for (const z of [-1, 1]) { vA.set(court.halfW / 2, 1, z * (court.halfL + 2)).applyMatrix4(camera.matrixWorldInverse); need = Math.max(need, Math.abs(vA.x) / -vA.z); }
      fov = clamp(2 * Math.atan(need * 1.06 / aspect) / D2R, 38, 100);
    }
    lens(fov, aspect);
  }
  // Free: orbit (0, 0.9, tz). Above the ground, never inside a fence's thickness. Returns nothing; freeHide() says which panels stand in the way.
  // The lower the camera, the shorter its leash: 30 m out at 6 degrees it stood in the street with a parked car under the lens, a palm trunk down the middle and the hedge across the court.
  const freeMax = () => lerp(16, 30, clamp((free.pitch - 6) / 14, 0, 1));
  function freePose(aspect) {
    if (!isFinite(free.yaw + free.pitch + free.dist + free.tz)) { free.yaw = 20; free.pitch = 25; free.dist = 17; free.tz = 0; }
    free.pitch = clamp(free.pitch, 6, 80); free.dist = clamp(free.dist, 6, freeMax()); free.yaw = ((free.yaw % 360) + 360) % 360; free.tz = clamp(free.tz, -court.halfL, court.halfL);
    const fx = court.halfW + 5.2, fz = court.halfL + 7.2, cp = Math.cos(free.pitch * D2R) * free.dist;
    let x = Math.cos(free.yaw * D2R) * cp, z = free.tz + Math.sin(free.yaw * D2R) * cp; const y = Math.max(1.2, 0.9 + Math.sin(free.pitch * D2R) * free.dist);
    if (Math.abs(Math.abs(x) - fx) < 0.6 && Math.abs(z) < fz + 0.6 && y < 1.93) x = Math.sign(x) * (fx + 0.6);       // within 0.6 m of a side wall's plane (1.33 m tall): push it outward
    if (Math.abs(Math.abs(z) - fz) < 0.6 && Math.abs(x) < fx + 0.6 && y < 3.07) z = Math.sign(z) * (fz + 0.6);       // and of a windscreen's (2.47 m)
    camera.position.set(x, y, z); camera.lookAt(vB.set(0, 0.9, free.tz)); lens(fovFor(50, aspect), aspect);
  }
  // Menu: from behind a baseline, level gaze, wide: sky and palms instead of "green court, green mounds". It drifts by itself.
  const menuSide = () => (spectator || at.on ? 0 : localSide);       // side 0 looks north at the hills
  function menuPose(aspect) {
    const s = sgn(menuSide()), d = still ? 0 : 1, y = 3.4 + Math.sin(timeS / 7.3 + 1) * 0.12 * d;
    camera.position.set(Math.sin(timeS / 5.2) * 0.9 * d, y, s * (court.halfL + 7)); camera.lookAt(vB.set(0, y, -s * court.halfL)); lens(fovFor(60, aspect), aspect);
  }
  const easeFrom = { p: new THREE.Vector3(), q: new THREE.Quaternion(), m: new THREE.Matrix4() };
  // One picture: pose the camera for the mode, ease out of the menu pose if a menu just closed, dress the scene for that camera.
  function updateCamera(dt, aspect) {
    let back = -1, sd = -1;
    if (menu) { menuPose(aspect); back = menuSide(); }
    else if (!spectator) { playPose(localSide, view, aspect, true, dt); back = localSide; }
    else if (vName === 'pov') { playPose(vSide, povSt[vSide], aspect, false, dt); back = vSide; }
    else if (vName === 'free') { freePose(aspect); const p = camera.position; sd = p.x > court.halfW + 5.2 ? 0 : p.x < -court.halfW - 5.2 ? 1 : -1; back = p.z > court.halfL + 7.2 ? 0 : p.z < -court.halfL - 7.2 ? 1 : -1; }
    else { broadcastPose(aspect); sd = 0; }
    if (easeT < 1) {                                       // the court opens: menu pose -> this pose, once (position, aim and lens together)
      easeT = Math.min(1, easeT + dt / 0.8); const k = ease(easeT), a = easeFrom.m.elements, m = camera.projectionMatrix.elements;
      vA.copy(camera.position); camera.position.copy(easeFrom.p).lerp(vA, k); qA.copy(camera.quaternion); camera.quaternion.copy(easeFrom.q).slerp(qA, k);
      for (let i = 0; i < 16; i++) m[i] = lerp(a[i], m[i], k); camera.projectionMatrixInverse.copy(camera.projectionMatrix).invert();
    }
    dress(eyeSide(), back, sd);
  }

  // ---------- WebAudio, no assets ----------
  let ac = null, master = null, noiseBuf = null;
  function unlockAudio() {
    try {
      if (!ac) {
        const AC = window.AudioContext || window.webkitAudioContext; if (!AC) return;
        ac = new AC(); master = ac.createGain(); master.gain.value = 0.7;
        const comp = ac.createDynamicsCompressor(); master.connect(comp); comp.connect(ac.destination);
        noiseBuf = ac.createBuffer(1, ac.sampleRate, ac.sampleRate);
        const d = noiseBuf.getChannelData(0), r = rng(5); for (let i = 0; i < d.length; i++) d[i] = r() * 2 - 1;
      }
      if (ac.state !== 'running') ac.resume();
    } catch (e) { ac = null; }
  }
  const panOf = x => (spectator ? 0 : clamp(sgn(localSide) * (x - cam.x) / 4.5, -1, 1));       // a spectator's left and right are not the court's: centred
  function out(pan) {                                     // -> node to connect a voice into
    if (!ac.createStereoPanner) return master;
    const p = ac.createStereoPanner(); p.pan.value = pan; p.connect(master); return p;
  }
  function tone(dst, type, f0, f1, tGlide, gain, decay, at = 0) {
    const t = ac.currentTime + at, o = ac.createOscillator(), g = ac.createGain();
    o.type = type; o.frequency.setValueAtTime(f0, t); o.frequency.exponentialRampToValueAtTime(f1, t + tGlide);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + 0.002); g.gain.exponentialRampToValueAtTime(0.0001, t + decay);
    o.connect(g); g.connect(dst); o.start(t); o.stop(t + decay + 0.02);
  }
  function noise(dst, f0, f1, f2, Q, gain, dur, attack) {
    const t = ac.currentTime, src = ac.createBufferSource(), bp = ac.createBiquadFilter(), g = ac.createGain();
    src.buffer = noiseBuf; src.loop = true; bp.type = 'bandpass'; bp.Q.value = Q;
    bp.frequency.setValueAtTime(f0, t); bp.frequency.exponentialRampToValueAtTime(f1, t + dur * 0.45); bp.frequency.exponentialRampToValueAtTime(f2, t + dur);
    g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(gain, t + attack); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(bp); bp.connect(g); g.connect(dst); src.start(t, rndFx() * 0.5); src.stop(t + dur + 0.02);
  }
  const sfx = {
    pock(n, x) {                                          // hollow plastic: pitched body + low cavity + bright click
      if (!ac) return; const d = out(panOf(x)), f = 880 + 520 * n, g = 0.6 + 0.7 * n;
      tone(d, 'sine', 170 + 60 * n, 70, 0.004, 0.35 + 0.5 * n, 0.16);          // the thump you feel: gets heavier with power
      tone(d, 'sine', f * 1.6, f, 0.018, g, 0.085); tone(d, 'triangle', f * 0.5, f * 0.46, 0.05, g * 0.5, 0.13);
      noise(d, 3200, 2400, 1800, 0.8, g * 0.5, 0.03, 0.001);
    },
    bounce(x) { if (!ac) return; const d = out(panOf(x)); tone(d, 'sine', 760, 560, 0.03, 0.16, 0.07); tone(d, 'triangle', 300, 250, 0.05, 0.1, 0.1); noise(d, 1500, 1100, 800, 0.7, 0.05, 0.03, 0.001); },
    whoosh(x, g = 0.2, mine = false) { if (!ac) return; noise(out(panOf(x)), 420, 2100, 650, 1.3, g, mine ? 0.22 : 0.3, mine ? 0.025 : 0.09); },   // mine: no slow swell, it is already late
    chime(win) {
      if (!ac) return; const d = out(0), ns = win ? [783.99, 1174.66] : [587.33, 440];
      ns.forEach((f, i) => { tone(d, 'sine', f, f, 0.01, 0.3, 0.7, i * 0.17); tone(d, 'triangle', f * 2, f * 2, 0.01, 0.07, 0.4, i * 0.17); });
    },
  };

  // ---------- public API ----------
  function smashFx(p, side, spin, rs, sk) { const purple = spin > 0.3; ring(p, false, 0.1 * rs, 2.6 * rs, 0.6, purple ? 0xb070ff : 0xff5a1f, 0.7); flashAt(p, 2.2);
    burst(p, 1, 40, 9, purple ? [0xd08bff, 0x8a5bff, 0xffffff] : [0xff5a1f, 0xffb340, 0xfff0a0], -sgn(side) * 6); cam.shake = Math.max(cam.shake, sk === 1 ? 0.34 : sk ? 0.18 : 0); }
  const hitLook = side => { const split = spectator && vName === 'split', mine = split || side === eyeSide();      // -> [ring scale, shake share]: mine, not mine, or none (two cameras, or the spectator's own hand on the camera)
    return [mine ? 0.6 : 1, menu ? 0 : spectator ? (split || vName === 'free' ? 0 : vName === 'pov' && mine ? 1 : 0.55) : mine ? 1 : 0.55]; };
  function onEvent(m) {
    if (!m || !m.type || at.on) return;
    if (m.type === 'launch') {
      ball.lastBy = m.by; if (isFinite(m.spin)) ball.spin = clamp(+m.spin, 0, 1); if (isFinite(m.k)) ball.kick = +m.k;
      if (m.n != null && isFinite(m.n)) ball.power = clamp(+m.n, 0, 1);      // a re-aim: the hit went out on the early bet, this is the settled swing. The trail burns for THAT (a tap that was called 30 rad/s loses its flame)
      if (m.kind === 'smash' && ball.seen) { const [rs, sk] = hitLook(m.by); smashFx([ball.pos.x, ball.pos.y, ball.pos.z], m.by, ball.spin, rs, sk); trail.glow = 1; }      // and only a settled swing is announced as a smash: here, up to 0.25 s after the hit
      if (m.land && !menu) { marker.visible = true; mk.t = 0; mk.fade = 0; marker.position.set(m.land[0], 0.025, m.land[1]);
        marker.material.color.set(isMe(m.land[1] > 0 ? 0 : 1) ? 0xffd23a : 0xffffff); }      // yellow = coming to ME. A spectator has no me: always white
    } else if (m.type === 'hit') {
      const n = clamp(+m.n || 0, 0, 1), p = m.p || ball.p, pd = pads[m.side], [rs, sk] = hitLook(m.side);      // rs: the local hit is 5 m from the lens, keep the ring off the ball (in split every hit is near one of the two lenses)
      // impact: three rings, a flash, twice the sparks, a harder shake and a ball that swells for a beat
      ring(p, false, 0.12 * rs, (0.7 + n * 0.9) * rs, 0.34, 0xfff2a8); ring(p, false, 0.08 * rs, (0.42 + n * 0.5) * rs, 0.24, 0xffffff);
      const sp = clamp(+m.spin || 0, 0, 1);                   // spin is continuous, so is its colour: yellow flat, icy blue at full spin (it used to flip at 0.5)
      ring(p, false, 0.05 * rs, (1.0 + n * 1.3) * rs, 0.5, tmpC.set(0xffd23a).lerp(tmpD.set(0x9fe3ff), sp), 0.55);
      burst(p, n, 22 + Math.round(n * 30), 3.6 + n * 6.5, [tmpC.set(0xfff6b0).lerp(tmpD.set(0xbfe9ff), sp).getHex(), tmpC.set(0xffd23a).lerp(tmpD.set(0x5ad1ff), sp).getHex(), 0xffffff], -sgn(m.side) * (2.5 + n * 4));
      cam.shake = Math.max(cam.shake, (0.06 + 0.17 * n) * sk);
      flashAt(p, 0.5 + n * 0.9); ball.pulse = 1; ball.power = ball.hot = n;      // the trail takes this shot's colour at once, not eased up from the last one
      if (m.kind === 'smash') smashFx(p, m.side, m.spin, rs, sk);
      ball.spin = clamp(+m.spin || 0, 0, 1);
      trail.glow = 0.8 + 0.2 * n; ball.blend = ball.seen; ball.snap = !ball.seen; ball.lastBy = m.side;
      if (m.v && m.v.length === 3 && isFinite(m.v[0] + m.v[1] + m.v[2] + p[0] + p[1] + p[2])) {   // the launch rides on the hit: no waiting for the next state packet
        ball.p = [p[0], p[1], p[2]]; ball.v = [m.v[0], m.v[1], m.v[2]]; ball.stamp = ball.ext ? lastMs : madeAt(+m.t, performance.now());
        ball.bounces = 0; ball.kick = +m.k || 0; ball.held = false; }
      if (pd) { pd.lunge = 1; pd.reach = pd.has; pd.hitP = [p[0], p[1], p[2]]; if (pd.bot && (pd.swingT < 0 || pd.swingT > 0.32 || pd.swingT < SWING_CONTACT - 0.06)) startSwing(pd, SWING_CONTACT - 0.04); }
      sfx.pock(n, p[0]); if (m.spin > 0.12 && ac) noise(out(panOf(p[0])), 5200, 3000, 1600, 0.9, 0.2 * Math.min(1, m.spin) ** 1.5, 0.11, 0.004);   // spin hisses off the face, as loud as there is spin: 0.5 -> 0.07, 0.8 -> 0.14, 1 -> 0.2
    } else if (m.type === 'swung') {
      const pd = pads[m.side]; if (!pd) return;
      pd.swooshUntil = timeS + 0.5;                          // the blur belongs to the swing, never to plain movement
      if (pd.bot && pd.swingT < 0) startSwing(pd);
      if (timeS - pd.swungAt < 0.25) return; pd.swungAt = timeS;          // main may play it locally AND the server echoes it: once
      sfx.whoosh(pd.pos.x, isMe(m.side) ? 0.22 : 0.12, isMe(m.side));
    } else if (m.type === 'bounce') {
      const p = m.p || ball.p; ring(p, true, 0.1, 0.55, 0.4, 0xffffff, 0.7, false);
      burst([p[0], 0.06, p[2]], 0, 5, 1.2, [0xd8e6f5, 0xffffff]);
      if (marker.visible && mk.fade === 0) mk.fade = 1e-4;
      sfx.bounce(p[0]);
    } else if (m.type === 'serve') { ball.snap = true; ball.spin = 0; ball.power = 0; trail.glow = 0.35; }
    else if (m.type === 'point') {
      if (marker.visible && mk.fade === 0) mk.fade = 1e-4;
      const w = pads[m.winner]; if (w) { w.cheer = 1.05; if (w.has) burst([w.pos.x, 2.2, w.pos.z], 0.5, 22, 3.5, [0xff5d73, 0xffd23a, 0x5ad1ff, 0x7dff8a]); }
      sfx.chime(spectator || m.winner === localSide);      // a spectator is on nobody's side: every point gets the winner's chime
    } else if (m.type === 'whiff' && !spectator) { const me = pads[localSide]; if (ac) noise(out(panOf(me.pos.x)), 900, 500, 260, 1.0, 0.1, 0.22, 0.04); }
  }

  function updatePaddle(side, d) {
    const pd = pads[side]; if (!pd || at.on) return;
    if (!d) { pd.has = pd.init = false; pd.status = null; return; }
    const t = pd.tgt; pd.has = true;
    const st = TAG_WORD[d.status] ? d.status : null; if (st !== pd.status) { pd.status = st; if (st && st !== pd.tagFor) { pd.tagFor = st; pd.tag.material.map = tagTexture(st); pd.tag.material.needsUpdate = true; } }      // the tag keeps its last word while it fades out
    pd.bot = !!d.bot; if (pd.matt !== pd.bot) paint(pd, pd.bot);      // bot:true IS Matt, at every level
    if (isFinite(d.x)) t.x = d.x; if (isFinite(d.y)) t.y = d.y; if (isFinite(d.z)) t.z = d.z;
    if (d.q && d.q.length === 4 && isFinite(d.q[0] + d.q[1] + d.q[2] + d.q[3])) { t.q.set(d.q[0], d.q[1], d.q[2], d.q[3]); if (t.q.lengthSq() > 1e-6) t.q.normalize(); else t.q.identity(); }
    t.off = d.offset && d.offset.length === 3 && isFinite(d.offset[0] + d.offset[1] + d.offset[2]) ? d.offset : null;
  }

  function updateBall(p, v, live, tMs, spin, m) {         // tMs optional (tests); default = when the server made it, on the rAF clock. spin optional: the state packet's
    if (!p || !v || at.on) return;                         // m optional: the state packet itself ({ t, b, k, serving }), for the clock and for coast()
    if (isFinite(spin) && spin != null) ball.spin = clamp(+spin, 0, 1);
    if (live && !ball.live) ball.snap = true;
    if (m) { ball.bounces = m.b | 0; ball.kick = +m.k || 0; ball.held = m.serving != null; }
    ball.p = p; ball.v = v; ball.live = !!live; ball.ext = tMs != null; ball.stamp = tMs == null ? madeAt(m ? +m.t : NaN, performance.now()) : tMs;
    if (live) ball.seen = true;
  }

  function hideBall() { if (at.on) return; ball.seen = ball.live = false; ballMesh.visible = blob.visible = trailMesh.visible = spinFx.visible = serveFx.visible = marker.visible = false; serveA = 0; trail.pts.length = 0; }   // the match it belonged to is over (opponent left, back to the lobby)

  // ---------- attract rally ----------
  // `by` strikes the ball at `from` at rally time t0. Pick a landing spot and an arc, solve the launch so it lands there and clears the
  // net, then look along that flight (coast(): the very function that draws it) for where the other one meets it, and send them there.
  const aP = new THREE.Vector3(), aV = new THREE.Vector3();
  function attractShot(by, from, t0) {
    const r = at.rnd, s = sgn(by), kind = r(), arc = kind < 0.45 ? 0 : kind < 0.8 ? 1 : 2, st = at.stats;          // drive / soft / lob-ish
    const spin = r() < 0.3 ? 0.45 + r() * 0.55 : 0, g = G * (1 - SPUN.lift * spin), kick = spin ? (r() - 0.5) * 1.2 * spin : 0;   // now and then a slice: the trail goes icy
    const deep = arc === 1 ? r() * 0.75 : 0.55 + r() * 0.45;                                                            // drives and lobs land deep, soft ones anywhere past the kitchen line
    const tx = (r() * 2 - 1) * (court.halfW - 0.4), tz = -s * lerp(court.kitchen + 0.4, court.halfL - 0.4, deep);        // 0.4 m inside the lines, always
    let T = [0.75, 1.1, 1.6][arc] * (0.92 + r() * 0.16), v = null, over = 0;
    for (let i = 0; i < 40; i++) { v = [(tx - from[0]) / T, (BALL_R - from[1]) / T + 0.5 * g * T, (tz - from[2]) / T];
      const tn = -from[2] / v[2]; over = from[1] + v[1] * tn - 0.5 * g * tn * tn - BALL_R - court.net; if (over >= 0.25) break; T += 0.05; }      // too flat for the net: give it more air
    let best = T + 0.3, cost = 1e9;
    for (let t = T + 0.1; t < T + 1.8; t += 1 / 90) {       // after the bounce: a comfortable height, not miles behind the baseline, on the way down if there is a choice
      coast(aP, aV, from, v, t, spin, 0, kick); if (aP.y <= BALL_R + 1e-4) break;                                        // second bounce: too late
      const c = Math.abs(aP.y - 1.0) + (aV.y > 0 ? 0.12 : 0) + 3 * Math.max(0, -aP.z * s - court.halfL - 1.4) + 3 * Math.max(0, Math.abs(aP.x) - court.halfW - 1.6);
      if (c < cost) { cost = c; best = t; }
    }
    coast(aP, aV, from, v, best, spin, 0, kick);
    Object.assign(at, { by, p: [from[0], from[1], from[2]], v, t0, spin, kick, n: [0.5, 0.12, 0.3][arc] + r() * 0.1, hitAt: t0 + best, hitP: [aP.x, aP.y, aP.z], swung: false });
    ball.spin = spin; ball.power = ball.hot = at.n; ball.lastBy = by; trail.glow = Math.max(trail.glow, 0.45 + 0.4 * at.n);
    st.shots++; st.net = Math.min(st.net, over); if (Math.abs(tx) > court.halfW - 0.399 || Math.abs(tz) > court.halfL - 0.399 || over < 0.25) st.out++;
    const go = (side, to, a, b, bh) => { const t = pads[side].tgt; Object.assign(at.run[side], { from: [t.x, t.y, t.z], to, t0: a, t1: b, bh }); };
    const bh = r() < 0.35;                                  // the paddle waits beside the ball: a touch inside it for a forehand, well outside for a backhand (the hit's reach closes the rest)
    go(1 - by, [aP.x - s * (bh ? 0.32 : -0.06), clamp(aP.y - 0.28, 0.35, 1.7), aP.z - s * 0.25], t0, t0 + best * 0.8, bh);   // there with a fifth of the flight to spare: never a miss
    go(by, [(r() - 0.5) * 1.6, 1, s * 6.5], t0 + 0.18, t0 + 1.1, false);                                                // the striker recovers to the middle
  }
  function attractStep(dt) {
    at.t += dt;
    for (const pd of pads) { const r = at.run[pd.side], k = ease(clamp((at.t - r.t0) / (r.t1 - r.t0), 0, 1)), t = pd.tgt; t.x = lerp(r.from[0], r.to[0], k); t.y = lerp(r.from[1], r.to[1], k); t.z = lerp(r.from[2], r.to[2], k); }
    const rc = pads[1 - at.by], run = at.run[rc.side];
    if (!at.swung && at.t >= at.hitAt - SWING_CONTACT) { at.swung = true; startSwing(rc); rc.mirror = run.bh ? -1 : 1; }  // the existing bot swing, wound up so contact lands mid-sweep
    if (at.t < at.hitAt) return;
    const gap = Math.hypot(rc.pos.x - run.to[0], rc.pos.z - run.to[2]); at.stats.gap = Math.max(at.stats.gap, gap); if (gap > 0.5 || rc.swingT < 0) at.stats.late++;   // test/scene-next.mjs holds this at 0
    rc.lunge = 1; rc.reach = true; rc.hitP = at.hitP;
    attractShot(rc.side, at.hitP, at.hitAt);
  }
  function startAttract() {
    if (at.on) return; at.on = true; at.t = 0; at.rnd = rng(20260920); Object.assign(at.stats, { shots: 0, late: 0, out: 0, net: 9, gap: 0 }); stopFx();
    for (const pd of pads) { const s = sgn(pd.side), t = pd.tgt; pd.has = true; pd.init = false; pd.bot = true; pd.status = null; paint(pd, pd.side === 1); pd.swingT = -1; pd.lunge = 0; pd.cheer = 0; pd.swooshUntil = 0;
      t.x = 0; t.y = 1; t.z = s * 6.5; t.off = null; Object.assign(at.run[pd.side], { from: [0, 1, s * 6.5], to: [0, 1, s * 6.5], t0: 0, t1: 1 }); }
    Object.assign(ball, { seen: true, live: true, snap: false, blend: false, held: false, pulse: 0 }); trail.pts.length = 0;
    attractShot(0, [0.5, 1.0, 6.2], 0);                     // no serve ritual: the rally is simply under way
  }
  function stopAttract() {                                 // the next welcome / state draws the real match from nothing
    if (!at.on) return; at.on = false; hideBall(); ball.spin = ball.power = 0; ball.lastBy = -1;
    for (const pd of pads) { pd.has = pd.init = pd.bot = false; pd.swingT = -1; pd.lunge = 0; paint(pd, false); }
    clock.reset();
  }

  function resize() {
    const w = size.w = containerEl.clientWidth || window.innerWidth, h = size.h = containerEl.clientHeight || window.innerHeight;
    renderer.setPixelRatio(pixelRatio()); renderer.setSize(w, h); force = true;      // setSize wipes the canvas: the next frame must not be one the 30 fps cap skips
    camera.aspect = w / h; camera.fov = fovFor(cam.fovBase, camera.aspect);
    camera.updateProjectionMatrix();
  }

  function setMenu(on) {
    on = !!on; if (on === menu) return;
    if (!on) { easeFrom.p.copy(camera.position); easeFrom.q.copy(camera.quaternion); easeFrom.m.copy(camera.projectionMatrix); }      // the menu pose as last drawn (before resize() touches the lens)
    menu = on; resize(); syncInput();
    if (on) { stopFx(); shadowHold = 1; easeT = 1; }
    else { renderer.shadowMap.autoUpdate = !dim; renderer.shadowMap.needsUpdate = true; shadowHold = 0;
      const split = spectator && vName === 'split'; easeT = split || !drawn ? 1 : 0;                   // two cameras cannot ease out of one: split is a cut
      povSt[0].cut = povSt[1].cut = true; }
  }
  function setDim(on) {                                    // main.js: paused against Matt with the settings card (and so the blur) up. Nothing moves but Matt's idle sway: half the pixels, 30 fps, the shadow map as it stands
    on = !!on; if (on === dim) return; dim = on; if (menu) return; resize();
    renderer.shadowMap.autoUpdate = !on; if (!on) renderer.shadowMap.needsUpdate = true;
  }
  const getView = () => (spectator ? { name: vName, side: vName === 'pov' ? vSide : 0 } : { name: 'play', side: localSide });
  function setView(name, side = 0) {
    if (spectator && VIEWS.includes(name)) { vName = name; if (name === 'pov') vSide = side === 1 ? 1 : 0; povSt[0].cut = povSt[1].cut = true; cam.shake = 0; if (name === 'split') easeT = 1; syncInput(); }      // changing view is a cut (an ease out of the menu, if one is running, carries on into the new view)
    return getView();
  }
  function setSide(side) {                                 // 0 | 1: a seat. null: a spectator (both paddles remote, the view cameras). Anything else: seat 0, as ever
    spectator = side === null; localSide = side === 1 ? 1 : 0; clock.reset(); cam.x = 0; view.x = view.y = view.vx = view.vy = 0; view.z = 0; povSt[0].cut = povSt[1].cut = true;
    for (const pd of pads) pd.init = false; syncInput();
  }
  function setFrozen(on) {
    on = !!on; if (on === frozen) return; frozen = on;
    if (!on) { clock.reset(); ball.snap = true; if (!ball.ext) ball.stamp = performance.now(); }      // the server's t stood still while wall time ran: a stale offset would age every packet by the whole pause.
    // The stamp too: every paused packet was dated to when the pause BEGAN, so the frame drawn before the next packet coasted the ball up to 0.6 s ahead and back (seen as a 3 m flick in test/spectate-e2e.mjs). Time starts again now.
  }
  // Free cam input lives here (MAIN forwards nothing): drag = orbit, wheel = zoom, right-drag / shift-drag / arrow keys = slide along the court, only while a spectator is in the free view with no menu up.
  const canOrbit = () => spectator && vName === 'free' && !menu;
  function syncInput() { renderer.domElement.style.touchAction = canOrbit() ? 'none' : ''; }
  { const el = renderer.domElement; let drag = null;
    const end = e => { if (!drag || e.pointerId !== drag.id) return; drag = null; try { el.releasePointerCapture(e.pointerId); } catch (_) {} };
    const slide = (dx, dy) => { const y = free.yaw * D2R; free.tz = clamp(free.tz + (Math.cos(y) * dx - Math.sin(y) * dy) * free.dist * 0.0016, -court.halfL, court.halfL); };      // the court follows the hand here too: screen right is (sin yaw, -cos yaw) on the ground, and only the part of the drag along the court's axis counts
    el.addEventListener('pointerdown', e => { if (!canOrbit() || drag) return; drag = { id: e.pointerId, x: e.clientX, y: e.clientY, pan: e.button === 2 || e.shiftKey }; try { el.setPointerCapture(e.pointerId); } catch (_) {} });
    el.addEventListener('pointermove', e => { if (!drag || e.pointerId !== drag.id) return; if (!canOrbit()) { drag = null; return; }
      if (drag.pan) slide(e.clientX - drag.x, e.clientY - drag.y);
      else { free.yaw += (e.clientX - drag.x) * 0.25; free.pitch = clamp(free.pitch + (e.clientY - drag.y) * 0.25, 6, 80); free.dist = Math.min(free.dist, freeMax()); }   // the court follows the hand, 0.25 deg per px
      drag.x = e.clientX; drag.y = e.clientY; });
    el.addEventListener('contextmenu', e => { if (canOrbit()) e.preventDefault(); });
    addEventListener('keydown', e => { const d = { ArrowLeft: [40, 0], ArrowRight: [-40, 0], ArrowUp: [0, 40], ArrowDown: [0, -40] }[e.key]; if (!d || !canOrbit() || e.defaultPrevented || e.metaKey || e.ctrlKey || e.altKey || e.target.tagName === 'INPUT') return; e.preventDefault(); slide(d[0], d[1]); });      // (a focused view chip takes the arrows for itself: defaultPrevented)
    el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    el.addEventListener('wheel', e => { if (!canOrbit()) return; e.preventDefault(); free.dist = clamp(free.dist * Math.exp(e.deltaY * 0.0012), 6, freeMax()); }, { passive: false });
  }

  function render(nowMs) {                                 // -> true when a frame was drawn
    const now = nowMs == null ? performance.now() : nowMs;
    if (document.visibilityState === 'hidden') return false;                                        // nobody is looking: draw nothing, menu or not
    if ((menu || dim) && !force && lastMs && now >= lastMs && now - lastMs < 30) return false;      // a menu (or a pause behind the blur) runs at 30 fps. dt below is between DRAWN frames
    const dt = lastMs ? clamp((now - lastMs) / 1000, 0, 0.05) : 1 / 60; lastMs = now; timeS += dt; force = false; drawn++;
    if (at.on) attractStep(dt);
    updateBallVis(now, dt); updatePads(dt); if (!menu) updateFx(dt);
    cam.shake = Math.max(0, cam.shake - dt * (0.35 + cam.shake * 6));
    const w = size.w, h = size.h;
    if (spectator && vName === 'split' && !menu) {         // two viewports, one scene: each half is that player's own picture (their fence gone, their avatar a ghost forearm)
      const tall = w <= h, wl = Math.floor(w / 2), ht = Math.floor(h / 2); renderer.setScissorTest(true);       // taller than wide: side 0 on top, side 1 under it (two 300 px columns cut both courts' corners off and gave 45 % of each to the sky). ui.css turns #split-line with the same test
      for (let i = 0; i < 2; i++) { const x = tall || !i ? 0 : wl, ww = tall ? w : i ? w - wl : wl, y = tall && !i ? h - ht : 0, hh = tall ? (i ? h - ht : ht) : h;      // (GL's y runs up from the bottom)
        vpW = ww; vpH = hh; playPose(i, povSt[i], ww / hh, false, dt); dress(i, i, -1); drawTrail(); faceFx();                // trail and rings are rebuilt for each camera
        if (!i && scenery) scenery.update(dt, timeS, camera);                                           // once a frame, with the first camera
        renderer.setViewport(x, y, ww, hh); renderer.setScissor(x, y, ww, hh); renderer.render(scene, camera); }
      renderer.setScissorTest(false); renderer.setViewport(0, 0, w, h);
      return true;
    }
    vpW = w; vpH = h; updateCamera(dt, w / h); drawTrail(); faceFx(); if (scenery) scenery.update(dt, timeS, camera);
    const hold = menu && shadowHold === 1;                 // a menu's shadow map is drawn ONCE, without the players (a moving avatar must not leave its shadow baked on the court)
    if (hold) { for (const o of casters) o.castShadow = false; renderer.shadowMap.autoUpdate = true; renderer.shadowMap.needsUpdate = true; }
    renderer.render(scene, camera);
    if (hold) { for (const o of casters) o.castShadow = true; renderer.shadowMap.autoUpdate = false; shadowHold = 2; }
    return true;
  }

  resize();
  return {
    setCourt(c) { if (c && isFinite(c.halfW + c.halfL + c.kitchen + c.net)) { court = { ...court, ...c }; buildCourt(); } },
    setSide, setView, getView, setMenu, setDim, startAttract, stopAttract, setFrozen,
    // where the player is relative to where they calibrated: -1..1, + = THEIR right / up (same for both sides).
    // Call every frame while tracking is good; 500 ms without a call falls back to the local paddle position.
    setViewer(v) { if (v && isFinite(v.x) && isFinite(v.y) && !spectator && !menu) { view.inX = v.x; view.inY = v.y; view.at = timeS; } },
    updatePaddle, updateBall, hideBall, onEvent, unlockAudio, render, resize,
    _dbg: { renderer, scene, camera, VIEW, pads, ball, cam, free, ballMesh, attract: at,               // test harness only
      view: () => ({ ...getView(), menu, dim, attract: at.on, frozen, spectator, stacked: size.w <= size.h, pixelRatio: renderer.getPixelRatio(), drawn }) },
  };
}
