// The RANKED venue (scene.setVenue('stadium')): an evening arena round the same court. ONE module owns the whole venue (index.js
// MODULES.stadium): night dome + stars, four tiered stands with crowd rows, the LED hoarding ring, four floodlight masts with lamp heads,
// their light cones and the pool of light on the concourse. No sponsor text, no assets: geometry in code, two small canvas textures.
// Rules: docs/SCENERY.md. keepOut (|x| < 9, |z| < 14.6) holds nothing of ours; noTall (|x| < 12, |z| < 18) nothing over 2.4 m; the masts
// stand in the corners outside the calm corridor. The far stand FILLS the calm band behind either baseline (visibleTop(32 m) = 8 m), so
// seats and heads are dark / mid-value, nothing yellow-white, and the idle sway is 3 cm: alive under the eye, invisible behind the ball.
// Cost: 10 draws / ~6k tris / 0.2 MB (low: 9 draws, no cones, fewer stars). All motion rides S.uniforms.uTime: a frozen clock is a still picture.
const DITHER = /* glsl */`c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;`;   // 8-bit output bands a slow dark gradient

export function create(THREE, S) {
  const group = new THREE.Group(), pal = S.pal, col = S.color, PI = Math.PI, hi = !S.low, W = S.world, tmp = new THREE.Color();

  // ---------------------------------------------------------------- sky: dome gradient per pixel + one Points draw of stars ------
  const dome = new THREE.Mesh(new THREE.SphereGeometry(W.domeR, 16, 10), new THREE.ShaderMaterial({
    side: THREE.BackSide, fog: false, depthWrite: false, depthTest: false,
    uniforms: { cH: { value: col(pal.horizon) }, c4: { value: col(pal.sky4) }, c12: { value: col(pal.sky12) }, c40: { value: col(pal.sky40) }, cZ: { value: col(pal.skyZenith) }, cGlow: { value: col(pal.glow) } },
    vertexShader: `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform vec3 cH, c4, c12, c40, cZ, cGlow; varying vec3 vDir;
      float seg(float e, float a, float b) { float t = clamp((e - a) / (b - a), 0.0, 1.0); return mix(t, t * t * (3.0 - 2.0 * t), 0.5); }
      void main() {
        vec3 d = normalize(vDir); float e = degrees(asin(clamp(d.y, -1.0, 1.0))), az = atan(d.x, -d.z);
        vec3 c = mix(cH, c4, seg(e, -3.0, 4.0)); c = mix(c, c12, seg(e, 4.0, 12.0)); c = mix(c, c40, seg(e, 12.0, 40.0)); c = mix(c, cZ, seg(e, 40.0, 90.0));
        c += cGlow * (0.5 + 0.5 * sin(az * 3.0 + 0.7) * sin(az * 5.0 + 2.0)) * smoothstep(10.0, -2.0, e) * 0.7;   // the city beyond the bowl lights the haze, unevenly
        c += cGlow * 0.4 * smoothstep(30.0, 0.0, e);                                                              // the floodlights' own haze over the arena
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
        ${hi ? 'c = gl_FragColor.rgb; ' + DITHER + ' gl_FragColor.rgb = c;' : ''}
      }` }));
  dome.renderOrder = -10; dome.frustumCulled = false;
  const nStar = S.pick(320, 140), sp = new Float32Array(nStar * 3), sc = new Float32Array(nStar * 3), rs = S.rng(1901), R = W.domeR - 30;
  for (let i = 0; i < nStar; i++) { const el = (14 + 76 * Math.pow(rs(), 0.7)) * PI / 180, az = rs() * 2 * PI, k = 0.35 + 0.65 * rs() * rs();   // >= 14 deg up: never in the play frame
    sp.set([Math.cos(el) * Math.sin(az) * R, Math.sin(el) * R, -Math.cos(el) * Math.cos(az) * R], i * 3); tmp.copy(col(pal.star)).multiplyScalar(k); if (rs() < 0.15) tmp.lerp(col('#ffd2a0'), 0.4); sc.set([tmp.r, tmp.g, tmp.b], i * 3); }
  const sg = new THREE.BufferGeometry(); sg.setAttribute('position', new THREE.BufferAttribute(sp, 3)); sg.setAttribute('color', new THREE.BufferAttribute(sc, 3));
  const stars = new THREE.Points(sg, new THREE.PointsMaterial({ size: 2, sizeAttenuation: false, vertexColors: true, fog: false, depthWrite: false, depthTest: false, transparent: true, opacity: 0.9, blending: THREE.AdditiveBlending }));
  stars.renderOrder = -9; stars.frustumCulled = false;
  const skyG = new THREE.Group(); skyG.add(dome, stars); group.add(skyG);                                                    // rides with the camera (update)

  // ---------------------------------------------------------------- the pool of light on the concourse -------------------------
  // A frame of quads round the apron, lit like the ground (Lambert), vertex alpha fading outward: the lit run-off bleeds into the dark concourse.
  // Nothing over the court itself (no fill there); the inner ring overlaps the apron edge by 25 cm so there is no seam under the fence.
  { const N = 64, D = [0, 2.5, 6, 11, 20], A = [0.7, 0.5, 0.28, 0.1, 0], P = [], C = [], c = col(pal.spill), ring = [];
    for (let i = 0; i <= N; i++) { const th = i / N * 2 * PI, dx = Math.cos(th), dz = Math.sin(th), t = Math.min(8.0 / Math.max(1e-6, Math.abs(dx)), 13.65 / Math.max(1e-6, Math.abs(dz))); ring.push(D.map(d => [dx * (t + d), dz * (t + d)])); }
    const push = (i, j) => { const [x, z] = ring[i][j]; P.push(x, 0.012, z); C.push(c.r, c.g, c.b, A[j]); };
    for (let i = 0; i < N; i++) for (let j = 0; j < D.length - 1; j++) { push(i, j); push(i, j + 1); push(i + 1, j + 1); push(i, j); push(i + 1, j + 1); push(i + 1, j); }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 4)); g.computeVertexNormals();
    const m = new THREE.Mesh(g, new THREE.MeshLambertMaterial({ vertexColors: true, transparent: true, depthWrite: false })); m.name = 'pool'; m.renderOrder = 0.5; m.frustumCulled = false; group.add(m); }

  // ---------------------------------------------------------------- hoardings: a 1.45 m ring just outside the fences, LED strip on top --
  // Emissive (no lighting), so it reads at night; one ShaderMaterial draw. u runs in metres round the ring: the highlight glides along it.
  { const H = 1.45, X = 9.7, Z = 15.3, corners = [[-X, -Z], [X, -Z], [X, Z], [-X, Z]], P = [], UV = []; let u = 0;
    for (let k = 0; k < 4; k++) { const [x0, z0] = corners[k], [x1, z1] = corners[(k + 1) % 4], L = Math.hypot(x1 - x0, z1 - z0), u1 = u + L;
      const q = [[x0, 0, z0, u, 0], [x1, 0, z1, u1, 0], [x1, H, z1, u1, 1], [x0, H, z0, u, 1]]; for (const i of [0, 1, 2, 0, 2, 3]) { P.push(q[i][0], q[i][1], q[i][2]); UV.push(q[i][3], q[i][4]); } u = u1; }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('aUV', new THREE.Float32BufferAttribute(UV, 2));
    const m = new THREE.Mesh(g, new THREE.ShaderMaterial({ side: THREE.DoubleSide, fog: false,
      uniforms: { uTime: S.uniforms.uTime, cBase: { value: col(pal.hoarding) }, cEdge: { value: col(pal.hoardingEdge) }, cLed: { value: col(pal.led) }, cDim: { value: col(pal.ledDim) } },
      vertexShader: `attribute vec2 aUV; varying vec2 vUV; void main() { vUV = aUV; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
      fragmentShader: /* glsl */`
        uniform float uTime; uniform vec3 cBase, cEdge, cLed, cDim; varying vec2 vUV;
        void main() {
          float u = vUV.x, v = vUV.y;
          vec3 c = mix(cBase, cEdge, 0.6 * v * v);                                                     // catches the floodlights toward the top
          c *= 1.0 - 0.4 * step(0.985, fract(u / 4.0));                                                // panel seams every 4 m
          float led = smoothstep(0.905, 0.92, v) * smoothstep(0.975, 0.96, v);                         // the strip: an 8 cm band under the top edge
          float run = pow(0.5 + 0.5 * sin((u - uTime * 1.6) * 0.26), 8.0);                             // one soft highlight every 24 m, gliding at 1.6 m/s
          c = mix(c, mix(cDim, cLed, 0.3 + 0.7 * run), led);
          c += cLed * 0.06 * smoothstep(0.86, 0.905, v) * (0.3 + 0.7 * run);                            // its glow on the panel below
          gl_FragColor = vec4(c, 1.0);
          #include <colorspace_fragment>
        }` }));
    m.name = 'hoardings'; m.frustumCulled = false; group.add(m); }

  // ---------------------------------------------------------------- stands: solid steps, parapet, rear wall, roof lip; corner blocks ---
  const standG = [], ROWS = 12, TREAD = 0.85, RISE = 0.42, FRONT = 1.05;                                                      // 12 rows climb to 6 m over 10 m of depth
  const box = (w, h, d, x, y0, z, hex, k = 1) => { const g = new THREE.BoxGeometry(w, h, d); g.translate(x, y0 + h / 2, z); g.deleteAttribute('uv'); standG.push(S.paint(g, (px, py, pz, i, out) => out.copy(col(hex)).multiplyScalar(k))); };
  const cP = [], cC = [], cUV = [], cSw = [], SEAT = 0.64, HEADS = 16;                                                            // crowd rows: one textured plane per row segment
  const place = (axis, sign, f, s) => (axis === 'x' ? [sign * f, s] : [s, sign * f]);                                          // f: out from the centre along the stand's axis, s: along the row
  function crowdRow(axis, sign, f, y, len, row, phase) {
    const gaps = [[-len / 2, -len / 6 - 0.5], [-len / 6 + 0.5, len / 6 - 0.5], [len / 6 + 0.5, len / 2]], k = 0.9 - 0.03 * row, dir = axis === 'x' ? [0, 1] : [1, 0];   // two aisles; back rows a touch darker
    for (const [s0, s1] of gaps) { const [xa, za] = place(axis, sign, f, s0), [xb, zb] = place(axis, sign, f, s1), [xc, zc] = place(axis, sign, f + 0.28, s1), [xd, zd] = place(axis, sign, f + 0.28, s0), rep = (s1 - s0) / (SEAT * HEADS), u0 = (s0 + 40) / (SEAT * HEADS);
      const q = [[xa, y, za, u0, 0, 0], [xb, y, zb, u0 + rep, 0, 0], [xc, y + 1.3, zc, u0 + rep, 1, 1], [xd, y + 1.3, zd, u0, 1, 1]];                   // leaning back a little: heads behind feet
      for (const i of [0, 1, 2, 0, 2, 3]) { const p = q[i]; cP.push(p[0], p[1], p[2]); cUV.push(p[3], p[4]); cC.push(k, k, k); cSw.push(dir[0], dir[1], p[5], phase); } }
  }
  function stand(axis, sign, len, f0, phase) {
    const B = (df, h, ds, f, y0, s, hex, k) => { const [w, d] = axis === 'x' ? [df, ds] : [ds, df], [x, z] = place(axis, sign, f, s); box(w, h, d, x, y0, z, hex, k); };
    B(0.3, FRONT, len, f0 + 0.15, 0, 0, pal.parapet);                                                                          // front parapet
    for (let i = 0; i < ROWS; i++) { const f = f0 + 0.3 + i * TREAD, top = FRONT - 0.15 + i * RISE;
      B(TREAD, top, len, f + TREAD / 2, 0, 0, i % 2 ? pal.stand : pal.standAlt);                                                // a solid step from the ground: its underside is never seen
      crowdRow(axis, sign, f + 0.4, top, len, i, phase + i * 0.9); }
    const fb = f0 + 0.3 + ROWS * TREAD, topY = FRONT - 0.15 + ROWS * RISE;
    B(0.6, topY + 3.2, len + 1.2, fb + 0.3, 0, 0, pal.backWall);                                                                // rear wall, up past the last row
    B(5.5, 0.35, len + 1.2, fb - 2.4, topY + 3.2, 0, pal.roof);                                                                 // roof lip over the back rows
    B(5.5, 0.12, len + 1.2, fb - 2.4, topY + 2.9, 0, pal.roof, 0.7);                                                            // its dark underside
  }
  stand('x', 1, 35, 12.5, 0); stand('x', -1, 35, 12.5, 1.3);                                                                    // the long sides, front rows outside noTall (|x| >= 12)
  stand('z', 1, 23, 18.5, 2.6); stand('z', -1, 23, 18.5, 3.9);                                                                  // the ends (|z| >= 18): the far one is the play camera's whole backdrop
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) box(10.8, 2.6, 10.8, sx * 17.9, 0, sz * 23.9, pal.cornerBlock);          // corner blocks close the bowl; the masts rise out of them
  { const m = new THREE.Mesh(S.merge(standG), new THREE.MeshLambertMaterial({ vertexColors: true })); m.name = 'stands'; m.frustumCulled = false; group.add(m); }

  // ---------------------------------------------------------------- crowd: dark rows, dotted heads, one time-driven sway per row -----
  // The texture is one row of 16 seats (2 cm per px); heads are mid-value, bodies dark, some seats empty. The sway moves a whole row's
  // heads together along the row (3 cm, two slow sines) in the vertex shader: no per-head work, no allocation, a function of uTime.
  const crowdTex = S.tex(512, 64, (c, w, h) => { const r = S.rng(77), rr = (x, y, ww, hh, rad) => { c.beginPath(); c.roundRect(x, y, ww, hh, rad); c.fill(); };
    for (let x = 0; x < w; x += 32) { c.fillStyle = (x / 32) % 2 ? pal.seatAlt : pal.seat; c.fillRect(x, 0, 32, h); }
    c.fillStyle = 'rgba(0,0,0,0.35)'; c.fillRect(0, 0, w, 5);                                                                  // shadow under the row above
    for (let k = 0; k < HEADS; k++) { if (r() < 0.2) continue; const x = k * 32 + 16 + (r() - 0.5) * 12, y = 17 + (r() - 0.5) * 8, hr = 3.6 + r() * 1.6, dim = 0.55 + 0.4 * r();   // no grid: every seat its own place, size and value
      c.fillStyle = pal.crowdBody[(r() * pal.crowdBody.length) | 0]; rr(x - 8, y + hr - 1, 16 + r() * 4, h - (y + hr - 1), 6);      // shoulders down to the seat foot
      tmp.set(pal.crowdHead[(r() * pal.crowdHead.length) | 0]).multiplyScalar(dim); c.fillStyle = '#' + tmp.getHexString(); c.beginPath(); c.arc(x, y, hr, 0, 2 * PI); c.fill();
      if (r() < 0.3) { c.fillStyle = pal.crowdBody[(r() * pal.crowdBody.length) | 0]; c.beginPath(); c.arc(x, y - 0.5, hr, PI, 2 * PI); c.fill(); } } }, { repeat: [1, 1], aniso: 8 });   // a cap or hood
  { const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(cP, 3)); g.setAttribute('uv', new THREE.Float32BufferAttribute(cUV, 2)); g.setAttribute('color', new THREE.Float32BufferAttribute(cC, 3)); g.setAttribute('aSw', new THREE.Float32BufferAttribute(cSw, 4));
    const mat = S.sway(new THREE.MeshBasicMaterial({ map: crowdTex, vertexColors: true, side: THREE.DoubleSide }), 'P.xz += aSw.xy * aSw.z * (0.03 * sin(uTime * 0.8 + aSw.w) + 0.012 * sin(uTime * 1.9 + aSw.w * 2.1));', 'attribute vec4 aSw;\n');
    mat.customProgramCacheKey = () => 'stadium-crowd';
    const m = new THREE.Mesh(g, mat); m.name = 'crowd'; m.frustumCulled = false; group.add(m); }

  // ---------------------------------------------------------------- floodlight masts: four corners, lamp banks facing the court ------
  const MASTS = [], H = 18, mastG = [], lampG = [], glowP = [];
  for (const sx of [-1, 1]) for (const sz of [-1, 1]) MASTS.push([sx * 16, sz * 22]);                                           // outside the corridor (corridorHalf(22) = 10.8), inside the corner blocks
  for (const [x, z] of MASTS) {
    const pole = new THREE.CylinderGeometry(0.13, 0.26, H, 8, 1, true); pole.translate(x, H / 2, z); pole.deleteAttribute('uv'); mastG.push(S.paint(pole, (px, py, pz, i, out) => out.copy(col(pal.mast)).multiplyScalar(0.55 + 0.45 * S.smoothstep(0, 14, py))));
    const yaw = Math.atan2(-x, -z), face = new THREE.Matrix4().makeRotationY(yaw), tilt = new THREE.Matrix4().makeRotationX(-0.55), M = new THREE.Matrix4().multiplyMatrices(face, tilt);   // bank faces the centre, tipped 32 deg down
    const frame = new THREE.BoxGeometry(3.2, 1.9, 0.2); frame.translate(0, 0, -0.18); frame.deleteAttribute('uv'); frame.applyMatrix4(M); frame.translate(x, H - 1.1, z); mastG.push(S.paint(frame, pal.lampFrame));
    for (let r = 0; r < 2; r++) for (let k = 0; k < 4; k++) { const g = new THREE.BoxGeometry(0.62, 0.72, 0.22); g.translate(-1.2 + k * 0.8, 0.45 - r * 0.9, 0); g.deleteAttribute('uv'); g.deleteAttribute('normal'); g.applyMatrix4(M); g.translate(x, H - 1.1, z); lampG.push(g); }
    glowP.push(x, H - 1.1, z);
  }
  { const m = new THREE.Mesh(S.merge(mastG), new THREE.MeshLambertMaterial({ vertexColors: true })); m.name = 'masts'; m.frustumCulled = false; group.add(m);
    const l = new THREE.Mesh(S.merge(lampG), new THREE.MeshBasicMaterial({ color: col(pal.lamp), fog: false })); l.name = 'lamps'; l.frustumCulled = false; group.add(l);
    const gt = S.tex(64, 64, (c, w) => { const gr = c.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,0.9)'); gr.addColorStop(0.25, 'rgba(255,255,255,0.35)'); gr.addColorStop(0.6, 'rgba(255,255,255,0.08)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); c.fillStyle = gr; c.fillRect(0, 0, w, w); });
    const gg = new THREE.BufferGeometry(); gg.setAttribute('position', new THREE.Float32BufferAttribute(glowP, 3));
    const glow = new THREE.Points(gg, new THREE.PointsMaterial({ map: gt, size: 9, color: col(pal.lamp), transparent: true, depthWrite: false, fog: false, blending: THREE.AdditiveBlending, opacity: 0.85 }));   // the bloom round each bank: one draw
    glow.name = 'glow'; glow.frustumCulled = false; glow.renderOrder = 3; group.add(glow); }

  // ---------------------------------------------------------------- light cones: additive, brighter at the source and along the rim ----
  if (hi) { const geos = [], q = new THREE.Quaternion(), down = new THREE.Vector3(0, -1, 0), d = new THREE.Vector3();
    for (const [x, z] of MASTS) for (const [tx, tz] of [[x * 0.12, z * 0.16], [-x * 0.1, z * 0.4]]) {                          // two per mast: the near half and across the court
      const L = d.set(tx - x, -(H - 1.1), tz - z).length(), g = new THREE.ConeGeometry(3.4, L, 12, 1, true); g.translate(0, -L / 2, 0); g.deleteAttribute('uv');
      const p = g.attributes.position, aT = new Float32Array(p.count); for (let i = 0; i < p.count; i++) aT[i] = -p.getY(i) / L;    // 0 at the lamp, 1 on the ground
      g.setAttribute('aT', new THREE.BufferAttribute(aT, 1)); g.applyQuaternion(q.setFromUnitVectors(down, d.normalize())); g.translate(x, H - 1.1, z); geos.push(g); }
    const m = new THREE.Mesh(S.merge(geos), new THREE.ShaderMaterial({ transparent: true, depthWrite: false, side: THREE.DoubleSide, fog: false, blending: THREE.AdditiveBlending, forceSinglePass: true,
      uniforms: { cBeam: { value: col(pal.beam) }, uA: { value: 0.14 } },
      vertexShader: `attribute float aT; varying float vT; varying float vRim; void main() { vT = aT; vec3 n = normalize(normalMatrix * normal); vec4 mv = modelViewMatrix * vec4(position, 1.0); vRim = 1.0 - abs(dot(n, normalize(-mv.xyz))); gl_Position = projectionMatrix * mv; }`,
      fragmentShader: /* glsl */`
        uniform vec3 cBeam; uniform float uA; varying float vT; varying float vRim;
        void main() { float a = uA * (0.3 + 0.7 * vRim * vRim) / (0.3 + 2.4 * vT) * smoothstep(1.0, 0.5, vT) * smoothstep(0.0, 0.12, vT);   // 1/r haze, fading out before the ground, rim brighter (more beam along the eye)
          gl_FragColor = vec4(cBeam, a);
          #include <colorspace_fragment>
        }` }));
    m.name = 'cones'; m.frustumCulled = false; m.renderOrder = 2; group.add(m); }

  return { group, sky: true, update(dt, t, camera) { skyG.position.copy(camera.position); } };
}
