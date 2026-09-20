// All visuals + WebAudio. No networking, no motion maths. Uses the global THREE (r160).
// Frames: world x right (seen from side 0), y up, side 0 defends +z, net at z=0.
// Player frame (q, offset): x = player's right, y = up, z = toward the player. Side 1 = world rotated 180deg about Y.

const G = 9.81, BALL_R = 0.11;
const PADDLE_SCALE = 1.6;                 // Wii-sized so it reads from 5 m behind
const DEFAULT_COURT = { halfW: 3.05, halfL: 6.7, kitchen: 2.13, net: 0.91 };
const COL = {
  skyTop: '#2f7fd6', skyMid: '#8cc4ee', horizon: '#d6ecf7',
  grass: 0x4f9a4a, apron: 0x2e7d56, court: 0x2a66b3, kitchen: 0xe0813f, line: 0xffffff,
  screen: 0x17513a, skin: 0xf2c9a0,
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
  head.add(new THREE.Mesh(new THREE.SphereGeometry(0.27, 28, 20), skin));
  const hair = new THREE.Mesh(new THREE.SphereGeometry(0.283, 28, 14, 0, Math.PI * 2, 0, Math.PI * 0.48), new THREE.MeshStandardMaterial({ color: COL.hair[side], roughness: 0.9 }));
  hair.rotation.x = 0.42; head.add(hair);
  for (const sx of [-1, 1]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.036, 12, 10), dark);
    eye.scale.set(1, 1.55, 0.5); eye.position.set(sx * 0.095, 0.0, -0.25); head.add(eye);
    const foot = new THREE.Mesh(new THREE.SphereGeometry(0.11, 14, 10), dark);
    foot.scale.set(1, 0.6, 1.5); foot.position.set(sx * 0.15, 0.065, -0.04); g.add(foot);
  }
  const offHand = new THREE.Mesh(new THREE.SphereGeometry(0.075, 16, 12), skin); offHand.position.set(-0.42, 0.85, -0.12);
  g.add(body, shorts, head, offHand);
  g.traverse(o => { if (o.isMesh) o.castShadow = true; });
  g.scale.setScalar(1.3);
  g.userData = { head, body, offHand };
  return g;
}

// ---------- canned swing for bots: [t, yaw, pitch, roll] degrees, player frame, YXZ ----------
const IDLE = [14, -12, 12];
const SWING = [[0, ...IDLE], [0.13, -64, 12, -30], [0.29, 72, 22, 38], [0.40, 62, 18, 30], [0.74, ...IDLE]];
const SWING_CONTACT = 0.2;
const FACE_C = 0.23 * PADDLE_SCALE, REACH_MAX = 0.75;     // grip -> face centre; how far a hit may tug the paddle toward the ball
const BODY = [0.5, 0.68];                 // avatar centre, left of / behind the paddle base (player frame)
function swingEuler(t, out) {
  let i = 0; while (i < SWING.length - 2 && t > SWING[i + 1][0]) i++;
  const a = SWING[i], b = SWING[i + 1], k = ease(clamp((t - a[0]) / (b[0] - a[0]), 0, 1));
  for (let j = 0; j < 3; j++) out[j] = lerp(a[j + 1], b[j + 1], k);
  return out;
}

export function createScene(containerEl) {
  let court = { ...DEFAULT_COURT }, localSide = 0, lastMs = 0, timeS = 0;
  const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
  renderer.shadowMap.enabled = true; renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.style.display = 'block';
  containerEl.appendChild(renderer.domElement);

  const scene = new THREE.Scene();
  scene.fog = new THREE.Fog(new THREE.Color(COL.horizon), 38, 160);
  const camera = new THREE.PerspectiveCamera(50, 1, 0.3, 500);
  const cam = { x: 0, shake: 0, fovBase: 44 };

  // lights: hemisphere fill + ONE shadow-casting sun, frustum fitted to court + player run-off
  scene.add(new THREE.HemisphereLight(0xd6e9ff, 0x4f7a4a, 1.35));
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
  {
    const rnd = rng(7), geo = new THREE.SphereGeometry(1, 12, 8), mat = new THREE.MeshBasicMaterial({ color: 0xffffff, fog: false });
    const clouds = new THREE.InstancedMesh(geo, mat, 70), m = new THREE.Matrix4(), q = new THREE.Quaternion(); let n = 0;
    for (let c = 0; c < 14; c++) {
      const a = rnd() * Math.PI * 2, d = 170 + rnd() * 80, cx = Math.cos(a) * d, cz = Math.sin(a) * d, cy = 38 + rnd() * 45, sz = 6 + rnd() * 6;
      for (let k = 0; k < 5; k++) m.compose(new THREE.Vector3(cx + (k - 2) * sz * 0.8 + rnd() * 3, cy + rnd() * 2 - (k % 2) * 1.5, cz + rnd() * 6), q,
        new THREE.Vector3(sz * (1.1 - Math.abs(k - 2) * 0.22), sz * (0.55 - Math.abs(k - 2) * 0.1), sz * 0.8)), clouds.setMatrixAt(n++, m);
    }
    scene.add(clouds);
  }

  // ---------- court (rebuilt by setCourt) ----------
  let courtGroup = null;
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
    const fenceZ = L + 7.2, fenceX = W + 5.2;
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
      const rail = new THREE.Mesh(new THREE.BoxGeometry(fenceX * 2, 0.07, 0.07), railM); rail.position.set(0, 2.43, s * fenceZ); g.add(rail);
      const sd = new THREE.Mesh(new THREE.PlaneGeometry(fenceZ * 2, 1.3), sideM); sd.position.set(s * fenceX, 0.65, 0); sd.rotation.y = -s * Math.PI / 2; g.add(sd);
      const srail = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.07, fenceZ * 2), railM); srail.position.set(s * fenceX, 1.33, 0); g.add(srail);
      for (let i = -3; i <= 3; i++) { const p = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.5, 8), railM); p.position.set(i * fenceX / 3, 1.25, s * (fenceZ + 0.05)); g.add(p); }
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
    scene.add(g);
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
  const ballMesh = new THREE.Mesh(new THREE.SphereGeometry(BALL_R, 28, 20), new THREE.MeshStandardMaterial({ map: ballTex, roughness: 0.45, emissive: 0x6a7400, emissiveIntensity: 0.35 }));
  ballMesh.visible = false; scene.add(ballMesh);       // no real shadow: the blob below is the depth cue
  const blob = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ transparent: true, depthWrite: false, color: 0x000000, map: glowTex(), polygonOffset: true, polygonOffsetFactor: -4, polygonOffsetUnits: -4 }));
  blob.rotation.x = -Math.PI / 2; blob.position.y = 0.02; blob.renderOrder = 3; blob.visible = false; scene.add(blob);
  const ball = { p: [0, 1, 0], v: [0, 0, 0], live: false, stamp: 0, seen: false, snap: true, pos: new THREE.Vector3(0, 1, 0), vel: new THREE.Vector3(), lastBy: -1 };

  const TRAIL_N = 22, trail = { pts: [], acc: 0, glow: 0 };
  const trailGeo = new THREE.BufferGeometry();
  trailGeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 6), 3));
  trailGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(TRAIL_N * 6), 3));
  { const idx = []; for (let i = 0; i < TRAIL_N - 1; i++) idx.push(i * 2, i * 2 + 1, i * 2 + 2, i * 2 + 1, i * 2 + 3, i * 2 + 2); trailGeo.setIndex(idx); }
  const trailMesh = new THREE.Mesh(trailGeo, new THREE.MeshBasicMaterial({ vertexColors: true, transparent: true, blending: THREE.AdditiveBlending, depthWrite: false, side: THREE.DoubleSide, fog: false }));
  trailMesh.frustumCulled = false; scene.add(trailMesh);

  // ---------- fx pools: rings, sparks, landing marker ----------
  const ringTex = canvasTex(128, 128, (c) => { c.strokeStyle = '#fff'; c.lineWidth = 9; c.beginPath(); c.arc(64, 64, 54, 0, 7); c.stroke(); });
  const rings = [];
  for (let i = 0; i < 8; i++) {
    const m = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: ringTex, transparent: true, depthWrite: false, fog: false, side: THREE.DoubleSide }));
    m.visible = false; m.renderOrder = 4; scene.add(m); rings.push({ m, t: 1, dur: 1, r0: 0, r1: 1, a: 1 });
  }
  function ring(p, flat, r0, r1, dur, color, a = 1, additive = true) {
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
  const rndFx = rng(99), tmpC = new THREE.Color();
  function burst(p, n, count, speed, colors, dirZ = 0) {
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
  const pads = [0, 1].map(side => {
    const group = buildPaddle(side), avatar = buildAvatar(side);
    const skinM = new THREE.MeshStandardMaterial({ color: COL.skin, roughness: 0.7 });
    const hand = new THREE.Mesh(new THREE.SphereGeometry(0.072, 18, 14), skinM); hand.castShadow = true;
    const ghostM = new THREE.MeshStandardMaterial({ color: COL.skin, roughness: 0.7, transparent: true, opacity: 0.32, depthWrite: false });
    const forearm = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.062, 0.6, 14, 1, true).translate(0, -0.3, 0), ghostM);   // hangs from the hand along -y
    const sleeve = new THREE.Mesh(new THREE.CylinderGeometry(0.066, 0.075, 0.14, 14, 1, true).translate(0, -0.62, 0), new THREE.MeshStandardMaterial({ color: COL.shirt[side], transparent: true, opacity: 0.4, depthWrite: false }));
    forearm.add(sleeve); forearm.renderOrder = 5;
    for (const o of [group, avatar, hand, forearm]) { o.visible = false; scene.add(o); }
    return { side, group, avatar, hand, forearm, handM: skinM, has: false, init: false, bot: false,
      tgt: { x: 0, y: 1, z: sgn(side) * 6.5, q: new THREE.Quaternion(), off: null },
      pos: new THREE.Vector3(0, 1, sgn(side) * 6.5), q: new THREE.Quaternion(), off: new THREE.Vector3(),
      lunge: 0, reach: false, reachV: new THREE.Vector3(), hitP: [0, 1, 0], swingT: -1, mirror: 1, bodyX: 0, bodyZ: sgn(side) * 6.8, vx: 0, cheer: 0, world: new THREE.Vector3() };
  });
  const E = new THREE.Euler(0, 0, 0, 'YXZ'), qA = new THREE.Quaternion(), vA = new THREE.Vector3(), vB = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), DOWN = new THREE.Vector3(0, -1, 0), e3 = [0, 0, 0];
  const D2R = Math.PI / 180;

  function updatePads(dt) {
    for (const pd of pads) {
      const vis = pd.has; pd.group.visible = pd.hand.visible = vis;
      pd.avatar.visible = vis && pd.side !== localSide; pd.forearm.visible = vis && pd.side === localSide;
      if (!vis) continue;
      const s = sgn(pd.side), local = pd.side === localSide, t = pd.tgt;
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
      else { const o = armOffset([pd.q.x, pd.q.y, pd.q.z, pd.q.w]); pd.off.set(o[0], o[1], o[2]); }
      pd.lunge = Math.max(0, pd.lunge - dt / 0.22);
      const lg = Math.sin(Math.min(1, pd.lunge * 1.15) * Math.PI) * 0.34;      // out and back
      const w = pd.world.set(pd.pos.x + s * pd.off.x, Math.max(0.12, pd.pos.y + pd.off.y + lg * 0.12), pd.pos.z + s * (pd.off.z - lg));
      pd.group.quaternion.set(s * pd.q.x, pd.q.y, s * pd.q.z, pd.q.w);         // T*P*T^-1 for side 1
      if (pd.reach) {                                      // just hit: the server's contact box is generous, so pull the FACE onto the ball for a beat
        vA.set(0, FACE_C, 0).applyQuaternion(pd.group.quaternion).add(w);
        pd.reachV.set(clamp(pd.hitP[0] - vA.x, -REACH_MAX, REACH_MAX), clamp(pd.hitP[1] - vA.y, -REACH_MAX, REACH_MAX), 0); pd.reach = false;
      }
      const ts = (1 - pd.lunge) * 0.22, rk = pd.lunge > 0 ? Math.min(1, ts / 0.02) * (1 - ease(ts / 0.22)) : 0;
      w.x += pd.reachV.x * rk; w.y = Math.max(0.12, w.y + pd.reachV.y * rk);
      pd.group.position.copy(w); pd.hand.position.copy(w);
      if (local) {                                         // ghost forearm: from the hand back toward a virtual elbow
        vA.set(pd.pos.x + s * 0.2, Math.max(0.2, pd.pos.y - 0.3), pd.pos.z + s * 0.72).sub(w).normalize();
        pd.forearm.position.copy(w); pd.forearm.quaternion.setFromUnitVectors(DOWN, vA);
      } else {                                             // Mii stands so its right shoulder is the arm pivot: the paddle sweeps around the body, not through it
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
      if (pd.bot && pd.swingT < 0 && ball.live && ball.lastBy !== pd.side && ball.vel.z * s > 0.5) {
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
    if (!b.seen) return;
    if (b.live) {
      const age = clamp((now - b.stamp) / 1000, 0, 0.1);
      vA.set(b.p[0] + b.v[0] * age, Math.max(BALL_R, b.p[1] + b.v[1] * age - 0.5 * G * age * age), b.p[2] + b.v[2] * age);
      b.vel.set(b.v[0], b.v[1] - G * age, b.v[2]);
      if (b.snap || vA.distanceToSquared(b.pos) > 2.2) { b.pos.copy(vA); b.snap = false; trail.pts.length = 0; }
      else { b.pos.addScaledVector(b.vel, dt); b.pos.lerp(vA, damp(dt, 0.018)); }       // predict, then pull to the packet: hides LAN jitter, no lag
      b.pos.y = Math.max(BALL_R, b.pos.y);
    } else {                                               // rally over: let it bounce away on its own
      b.vel.y -= G * dt; b.pos.addScaledVector(b.vel, dt);
      if (b.pos.y < BALL_R) { b.pos.y = BALL_R; b.vel.y = Math.abs(b.vel.y) * 0.6; b.vel.x *= 0.75; b.vel.z *= 0.75; if (b.vel.y < 0.6) b.vel.y = 0; }
    }
    ballMesh.visible = blob.visible = true; ballMesh.position.copy(b.pos);
    const sp2 = Math.hypot(b.vel.x, b.vel.z);
    if (sp2 > 0.05) { vB.set(b.vel.z, 0, -b.vel.x).normalize(); ballMesh.rotateOnWorldAxis(vB, Math.min(sp2 / BALL_R * 0.35, 40) * dt); }
    const h = b.pos.y - BALL_R, k = 1 / (1 + h * 0.55);
    blob.position.set(b.pos.x, 0.02, b.pos.z); blob.scale.setScalar(0.22 + 0.36 * k); blob.material.opacity = 0.35 + 0.5 * k;
    // ribbon trail, camera-facing
    trail.glow = Math.max(b.live ? 0.1 : 0, trail.glow - dt * 1.6); trail.acc += dt;
    if (trail.acc >= 1 / 90) { trail.acc = 0; trail.pts.unshift(b.pos.clone()); if (trail.pts.length > TRAIL_N) trail.pts.pop(); }
    const P = trailGeo.attributes.position.array, C = trailGeo.attributes.color.array, n = trail.pts.length;
    for (let i = 0; i < TRAIL_N; i++) {
      const p = trail.pts[Math.min(i, n - 1)] || b.pos, q = trail.pts[Math.min(i + 1, n - 1)] || p, f = i < n ? 1 - i / TRAIL_N : 0;
      vA.subVectors(p, q); vB.subVectors(camera.position, p); vA.cross(vB);
      if (vA.lengthSq() < 1e-10) vA.set(0, 0, 0); else vA.normalize().multiplyScalar(BALL_R * 0.7 * f);
      P[i * 6] = p.x + vA.x; P[i * 6 + 1] = p.y + vA.y; P[i * 6 + 2] = p.z + vA.z; P[i * 6 + 3] = p.x - vA.x; P[i * 6 + 4] = p.y - vA.y; P[i * 6 + 5] = p.z - vA.z;
      const a = f * f * trail.glow; for (let j = 0; j < 6; j += 3) { C[i * 6 + j] = a; C[i * 6 + j + 1] = a * 0.95; C[i * 6 + j + 2] = a * 0.45; }
    }
    trailGeo.attributes.position.needsUpdate = trailGeo.attributes.color.needsUpdate = true;
  }

  function updateFx(dt) {
    for (const r of rings) {
      if (!r.m.visible) continue;
      r.t += dt; const k = r.t / r.dur; if (k >= 1) { r.m.visible = false; continue; }
      r.m.scale.setScalar(lerp(r.r0, r.r1, 1 - (1 - k) ** 3) * 2); r.m.material.opacity = r.a * (1 - k) ** 1.5;
      if (!r.flat) r.m.quaternion.copy(camera.quaternion);
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

  function updateCamera(dt) {
    const s = sgn(localSide), me = pads[localSide];
    cam.x = lerp(cam.x, me.has ? me.pos.x * 0.35 : 0, damp(dt, 0.25));
    // the server runs you back for deep balls (up to ~2 m behind the baseline). The camera goes with you, or the
    // paddle drops off the bottom of the screen exactly when the ball arrives.
    { const back = me.has ? me.pos.z * s - 6.5 : 0; cam.z = lerp(cam.z || 0, back > 0 ? back : back * 0.5, damp(dt, 0.18)); }
    cam.shake = Math.max(0, cam.shake - dt * (0.35 + cam.shake * 6));
    const k = cam.shake, t = timeS * 1000;
    camera.position.set(cam.x + Math.sin(t * 0.093) * k, 3.1 + Math.sin(t * 0.117 + 1) * k * 0.8, s * (court.halfL + 5.4 + (cam.z || 0)) + Math.sin(t * 0.071 + 2) * k * 0.5);
    camera.lookAt(cam.x * 0.45, 0.35, s * (0.4 + (cam.z || 0) * 0.6));
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
  const panOf = x => clamp(sgn(localSide) * (x - cam.x) / 4.5, -1, 1);
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
      if (!ac) return; const d = out(panOf(x)), f = 880 + 520 * n, g = 0.4 + 0.55 * n;
      tone(d, 'sine', f * 1.6, f, 0.018, g, 0.085); tone(d, 'triangle', f * 0.5, f * 0.46, 0.05, g * 0.5, 0.13);
      noise(d, 3200, 2400, 1800, 0.8, g * 0.5, 0.03, 0.001);
    },
    bounce(x) { if (!ac) return; const d = out(panOf(x)); tone(d, 'sine', 760, 560, 0.03, 0.16, 0.07); tone(d, 'triangle', 300, 250, 0.05, 0.1, 0.1); noise(d, 1500, 1100, 800, 0.7, 0.05, 0.03, 0.001); },
    whoosh(x, g = 0.2) { if (!ac) return; noise(out(panOf(x)), 420, 2100, 650, 1.3, g, 0.3, 0.09); },
    chime(win) {
      if (!ac) return; const d = out(0), ns = win ? [783.99, 1174.66] : [587.33, 440];
      ns.forEach((f, i) => { tone(d, 'sine', f, f, 0.01, 0.3, 0.7, i * 0.17); tone(d, 'triangle', f * 2, f * 2, 0.01, 0.07, 0.4, i * 0.17); });
    },
  };

  // ---------- public API ----------
  function onEvent(m) {
    if (!m || !m.type) return;
    if (m.type === 'launch') {
      ball.lastBy = m.by;
      if (m.land) { marker.visible = true; mk.t = 0; mk.fade = 0; marker.position.set(m.land[0], 0.025, m.land[1]);
        marker.material.color.set((m.land[1] > 0 ? 0 : 1) === localSide ? 0xffd23a : 0xffffff); }
    } else if (m.type === 'hit') {
      const n = clamp(+m.n || 0, 0, 1), p = m.p || ball.p, pd = pads[m.side], mine = m.side === localSide;
      const rs = mine ? 0.6 : 1;                           // the local hit is 5 m from the lens: keep the ring off the ball
      ring(p, false, 0.1 * rs, (0.42 + n * 0.5) * rs, 0.3, 0xfff2a8); ring(p, false, 0.06 * rs, (0.24 + n * 0.26) * rs, 0.2, 0xffffff);
      burst(p, n, 10 + Math.round(n * 14), 2.5 + n * 4.5, [0xfff6b0, 0xffd23a, 0xffffff], -sgn(m.side) * (2 + n * 3));
      cam.shake = Math.max(cam.shake, (0.025 + 0.085 * n) * (mine ? 1 : 0.55));
      trail.glow = 0.55 + 0.45 * n; ball.snap = true; ball.lastBy = m.side;
      if (pd) { pd.lunge = 1; pd.reach = pd.has; pd.hitP = [p[0], p[1], p[2]]; if (pd.bot && (pd.swingT < 0 || pd.swingT > 0.32 || pd.swingT < SWING_CONTACT - 0.06)) startSwing(pd, SWING_CONTACT - 0.04); }
      sfx.pock(n, p[0]);
    } else if (m.type === 'swung') {
      const pd = pads[m.side]; if (!pd) return;
      if (pd.bot && pd.swingT < 0) startSwing(pd);
      sfx.whoosh(pd.pos.x, m.side === localSide ? 0.22 : 0.12);
    } else if (m.type === 'bounce') {
      const p = m.p || ball.p; ring(p, true, 0.1, 0.55, 0.4, 0xffffff, 0.7, false);
      burst([p[0], 0.06, p[2]], 0, 5, 1.2, [0xd8e6f5, 0xffffff]);
      if (marker.visible && mk.fade === 0) mk.fade = 1e-4;
      sfx.bounce(p[0]);
    } else if (m.type === 'serve') { ball.snap = true; trail.glow = 0.35; }
    else if (m.type === 'point') {
      if (marker.visible && mk.fade === 0) mk.fade = 1e-4;
      const w = pads[m.winner]; if (w) { w.cheer = 1.05; if (w.has) burst([w.pos.x, 2.2, w.pos.z], 0.5, 22, 3.5, [0xff5d73, 0xffd23a, 0x5ad1ff, 0x7dff8a]); }
      sfx.chime(m.winner === localSide);
    } else if (m.type === 'whiff') { const me = pads[localSide]; if (ac) noise(out(panOf(me.pos.x)), 900, 500, 260, 1.0, 0.1, 0.22, 0.04); }
  }

  function updatePaddle(side, d) {
    const pd = pads[side]; if (!pd) return;
    if (!d) { pd.has = pd.init = false; return; }
    const t = pd.tgt; pd.has = true; pd.bot = !!d.bot;
    if (isFinite(d.x)) t.x = d.x; if (isFinite(d.y)) t.y = d.y; if (isFinite(d.z)) t.z = d.z;
    if (d.q && d.q.length === 4 && isFinite(d.q[0] + d.q[1] + d.q[2] + d.q[3])) { t.q.set(d.q[0], d.q[1], d.q[2], d.q[3]); if (t.q.lengthSq() > 1e-6) t.q.normalize(); else t.q.identity(); }
    t.off = d.offset && d.offset.length === 3 && isFinite(d.offset[0] + d.offset[1] + d.offset[2]) ? d.offset : null;
  }

  function updateBall(p, v, live, tMs) {                  // tMs optional (tests); default = arrival time, same clock as rAF
    if (!p || !v) return;
    if (live && !ball.live) ball.snap = true;
    ball.p = p; ball.v = v; ball.live = !!live; ball.stamp = tMs == null ? performance.now() : tMs;
    if (live) ball.seen = true;
  }

  function resize() {
    const w = containerEl.clientWidth || window.innerWidth, h = containerEl.clientHeight || window.innerHeight;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2)); renderer.setSize(w, h);
    camera.aspect = w / h; camera.fov = camera.aspect < 1.2 ? lerp(74, cam.fovBase, clamp((camera.aspect - 0.5) / 0.7, 0, 1)) : cam.fovBase;   // keep the court in frame on tall windows
    camera.updateProjectionMatrix();
  }

  function render(nowMs) {
    const now = nowMs == null ? performance.now() : nowMs;
    const dt = lastMs ? clamp((now - lastMs) / 1000, 0, 0.05) : 1 / 60; lastMs = now; timeS += dt;
    updateBallVis(now, dt); updatePads(dt); updateFx(dt); updateCamera(dt);
    renderer.render(scene, camera);
  }

  resize();
  return {
    setCourt(c) { if (c && isFinite(c.halfW + c.halfL + c.kitchen + c.net)) { court = { ...court, ...c }; buildCourt(); } },
    setSide(side) { localSide = side === 1 ? 1 : 0; cam.x = 0; for (const pd of pads) pd.init = false; },
    updatePaddle, updateBall, onEvent, unlockAudio, render, resize,
    _dbg: { renderer, scene, camera },                    // test harness only
  };
}
