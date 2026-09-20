// Sky and the far distance: dome, sun, drifting clouds, marine bank, hills, downtown, pier wheel. Spec: the lead's FINAL SPEC, rules:
// docs/SCENERY.md. Budget 7 draws / 9k tris / 0.5 MB (low: 4 / 4.5k); this file uses 6 draws, ~8.5k tris, 0.43 MB (low: 3 draws, ~3.8k, 0 MB).
// Compass: azimuth `a` is degrees EAST OF NORTH, north = -z: (x, z) = r (sin a, -cos a). Sun in the SW (a ~ 218), downtown NNE.
// Everything is fog:false: distance is painted (each layer fades top -> hazy base -> the horizon cream), so layers keep their hue
// instead of going fog-white, and the value ladder behind the far baseline stays fence < ficus < sage foothill < lilac ridge < blue.
import { WIND } from './shared.js';   // the PREVAILING heading: clouds ride it, not the veering uWind (at t = 1000 s a veer would swing a 2.5 km offset)

const DITHER = /* glsl */`c += (fract(sin(dot(gl_FragCoord.xy, vec2(12.9898, 78.233))) * 43758.5453) - 0.5) / 255.0;`;   // 8-bit output bands a slow gradient; +-half a level of noise hides it

export function create(THREE, S) {
  const group = new THREE.Group(), pal = S.pal, D = Math.PI / 180, TAU = Math.PI * 2, col = S.color, tmp = new THREE.Color();
  const sunAz = Math.atan2(S.sunDir.x, -S.sunDir.z), sunH = new THREE.Vector2(S.sunDir.x, S.sunDir.z).normalize();
  const wrap = d => Math.atan2(Math.sin(d), Math.cos(d));                                     // azimuth difference in (-pi, pi]: no seam at a = 0
  const bell = (a, mid, half, soft) => 1 - S.smoothstep(half - soft, half + soft, Math.abs(wrap(a - mid * D)) / D);
  const polar = (a, r) => [Math.sin(a) * r, -Math.cos(a) * r];

  // ---- dome. The gradient is evaluated PER PIXEL from the view direction (vertex-colour rings leave Mach bands along every ring and
  // a 48-gon sun glow); it rides with the camera like a real sky so the wide debug cameras never push its far side past camera.far.
  // Below 1.2 deg it is exactly the fog colour at every azimuth (the sun glow starts above that), so the ground seam vanishes.
  const dome = new THREE.Mesh(new THREE.SphereGeometry(S.world.domeR, 16, 10), new THREE.ShaderMaterial({
    side: THREE.BackSide, fog: false, depthWrite: false, depthTest: false,
    uniforms: { cH: { value: col(pal.horizon) }, c2: { value: col(pal.sky2) }, c6: { value: col(pal.sky6) }, c12: { value: col(pal.sky12) }, c6S: { value: col(pal.sky6Sun) }, c12S: { value: col(pal.sky12Sun) }, c40: { value: col(pal.sky40) },
      cZ: { value: col(pal.skyZenith) }, cGlow: { value: col(pal.sunGlow) }, uSun: { value: sunH } },
    vertexShader: `varying vec3 vDir; void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      uniform vec3 cH, c2, c6, c12, c6S, c12S, c40, cZ, cGlow; uniform vec2 uSun; varying vec3 vDir;
      float seg(float e, float a, float b) { float t = clamp((e - a) / (b - a), 0.0, 1.0); return mix(t, t * t * (3.0 - 2.0 * t), 0.5); }   // half-eased: no hard kink at a stop, no flat shelf either
      void main() {
        vec3 d = normalize(vDir); float e = degrees(asin(clamp(d.y, -1.0, 1.0)));
        vec2 h = normalize(d.xz + vec2(1e-5)); float toSun = dot(h, uSun), s = smoothstep(0.64, 0.97, h.y), e6 = mix(4.5, 6.0, s);   // milky only in the ~+-40 deg looking SOUTH, where side 1
        // sees the ball's shaded face (shared.js); deep blue everywhere else, top corners of side 1's frame included, so cream breeze lines read against it
        vec3 c = mix(cH, c2, seg(e, 1.2, 2.5)); c = mix(c, mix(c6, c6S, s), seg(e, 2.5, e6)); c = mix(c, mix(c12, c12S, s), seg(e, e6, 12.0)); c = mix(c, c40, seg(e, 12.0, 40.0)); c = mix(c, cZ, seg(e, 40.0, 90.0));
        float az = degrees(acos(clamp(toSun, -1.0, 1.0)));
        ${S.low ? '' : 'c = mix(c, cGlow, 0.35 * smoothstep(50.0, 0.0, az) * smoothstep(1.2, 3.0, e) * smoothstep(8.0, 3.5, e));'}
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
        ${S.low ? '' : 'c = gl_FragColor.rgb; ' + DITHER + ' gl_FragColor.rgb = c;'}                              // low: the dome is the biggest fill in the frame, so no glow branch, no dither
      }` }));
  dome.renderOrder = -10; dome.frustumCulled = false; group.add(dome);

  // ---- far layers: ONE merged vertex-colour mesh. Hills are curtains on a circle with a sum-of-sines skyline (integer frequencies
  // = periodic, no seam), three rows each: crest colour, hazy base colour, horizon cream at the foot.
  const geos = [], SEG = S.pick(224, 64), lift = col('#fff0d8'), cream = col(pal.horizon);
  const noise = seed => { const r = S.rng(seed), F = [2, 3, 5, 8, 13, 21, 34, 55].filter(f => f * 5 <= SEG), G = [3, 4, 7, 11, 18, 29, 47].filter(f => f * 5 <= SEG), ph = F.map(() => r() * TAU), ph2 = G.map(() => r() * TAU);
    const sum = (a, fr, p) => { let v = 0, w = 0; fr.forEach((f, i) => { const k = 1 / Math.pow(f, 0.62); v += k * Math.sin(a * f + p[i]); w += k * k; }); return v / Math.sqrt(w); };   // ~unit variance. INTEGER frequencies only: periodic, so no seam at a = 0
    return a => S.clamp(0.35 + 0.22 * sum(a, F, ph) + 0.4 * (0.8 - Math.abs(sum(a, G, ph2))), 0, 1); };               // rolling mass + ridged peaks
  function curtain(r, height, topHex, baseHex) {                                                                          // height(a) -> metres, <= 0 means "no hill here"
    const P = [], C = [], top = topHex.isColor ? topHex : col(topHex), base = col(baseHex), push = (x, y, z, c) => { P.push(x, y, z); C.push(c.r, c.g, c.b); };
    const cols = i => { const a = i / SEG * TAU, h = height(a), [x, z] = polar(a, r), slope = (height(a + 0.012) - height(a - 0.012)) / (0.024 * r);
      // a crest that climbs toward the sun's side faces away from it: shade it a touch, light the other flank (toy-like form, same value band)
      const facing = S.clamp(-slope * Math.sign(wrap(sunAz - a) || 1) * 3.5, -1, 1), t = new THREE.Color().copy(top);
      if (facing > 0) t.lerp(lift, 0.2 * facing); else t.multiplyScalar(1 + 0.14 * facing);
      return { x, z, h, t, m: new THREE.Color().copy(top).lerp(base, 0.55), b: new THREE.Color().copy(base).lerp(cream, 0.6) }; };
    for (let i = 0; i < SEG; i++) { const A = cols(i), B = cols(i + 1); if (A.h <= 0.05 && B.h <= 0.05) continue;
      for (const [y0, k0, y1, k1] of [[-6, 'b', 0.35, 'm'], [0.35, 'm', 1, 't']]) {                                        // y as a fraction of the crest; the foot sits under the slab
        const ya = y0 < 0 ? y0 : y0 * A.h, yb = y0 < 0 ? y0 : y0 * B.h;
        push(A.x, ya, A.z, A[k0]); push(B.x, yb, B.z, B[k0]); push(B.x, y1 * B.h, B.z, B[k1]); push(A.x, ya, A.z, A[k0]); push(B.x, y1 * B.h, B.z, B[k1]); push(A.x, y1 * A.h, A.z, A[k1]); } }
    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.Float32BufferAttribute(P, 3)); g.setAttribute('color', new THREE.Float32BufferAttribute(C, 3)); geos.push(g);
  }
  const nFar = noise(11), nRidge = noise(23), nFoot = noise(37), nEast = noise(41), nHead = noise(53), nSpur = noise(67);
  const ridgeH = a => Math.max(bell(a, -4, 76, 18) * (14 + 13 * nRidge(a)), bell(a, 23, 16, 7) * (22 + 5 * nRidge(a)));  // never below the skyline's 18 m tops (3.6 deg at r290 vs 4 deg here)
  const footH = a => bell(a, -8, 64, 16) * (6 + 6 * nFoot(a));
  curtain(380, a => bell(a, 50, 40, 18) * (25 + 13 * nFar(a)), pal.farRange, pal.farRangeBase);                            // San Gabriels, NE, palest
  curtain(340, ridgeH, pal.ridge, pal.ridgeBase);                                                                         // Santa Monicas / Hollywood hills, running into the sea in the NW
  curtain(334, a => ridgeH(a) * (0.42 + 0.3 * nSpur(a)) * bell(a, -4, 70, 14), new THREE.Color().copy(col(pal.ridge)).lerp(col(pal.foothill), 0.4), pal.ridgeBase);                           // nearer spurs of the same range, one haze step darker: depth without detail
  curtain(345, a => bell(a, 108, 44, 16) * (8.5 + 6 * nEast(a)), pal.farRange, pal.farRangeBase);                          // low east hills, 1.5-2.5 deg
  curtain(340, a => bell(a, 168, 30, 12) * (5 + 7.5 * nHead(a)), pal.headland, pal.ridgeBase);                             // south headland, <= 2.2 deg, ends before the wheel: west is open sea
  curtain(300, footH, pal.foothill, pal.foothillBase);

  // boxes with the haze baked in: sun-facing walls + roof `lit`, the rest `shade`, every foot fading to `base`
  function box(w, h, d, x, y0, z, rotY, litHex, shadeHex, baseHex, fade = 0.85) {
    const g = new THREE.BoxGeometry(w, h, d).toNonIndexed(); g.translate(0, h / 2, 0); g.rotateY(rotY); const p = g.attributes.position, n = g.attributes.normal, C = new Float32Array(p.count * 3);
    for (let i = 0; i < p.count; i++) { const sunny = n.getY(i) > 0.5 || n.getX(i) * sunH.x + n.getZ(i) * sunH.y > 0.15;
      tmp.copy(col(sunny ? litHex : shadeHex)).lerp(col(baseHex), fade * (1 - p.getY(i) / h) * (n.getY(i) > 0.5 ? 0 : 1)); C.set([tmp.r, tmp.g, tmp.b], i * 3); }
    g.setAttribute('color', new THREE.BufferAttribute(C, 3)); g.deleteAttribute('uv'); g.deleteAttribute('normal'); g.translate(x, y0, z); geos.push(g);
  }
  { // downtown, a = 14..33 deg, r ~ 290, tops <= 18 m. The street grid really is turned ~36 deg off north, which is also what shows TWO
    // faces of every tower from the court (a lit SW wall and a shaded SE one). No window lights: it is 3:30 pm and this is behind play.
    const r = S.rng(77), sk = (a, rad, w, h, d) => { const [x, z] = polar(a * D, rad); box(w, h, d, x, -1, z, -36 * D + (r() - 0.5) * 0.12, pal.skylineLit, pal.skylineShade, pal.skylineBase, 0.5); };
    const N = 20; for (let i = 0; i < N; i++) { const a = 14.5 + 18 * (i + 0.15 + 0.7 * r()) / N, k = bell(a * D, 24, 5, 5.5), h = 5.5 + 9.5 * k * (0.55 + 0.45 * r()) + 2 * r(); sk(a, 284 + 12 * r(), 3.2 + 2.6 * r(), h, 3.2 + 2.2 * r()); }
    for (const [a, h, w, cap] of [[22.2, 15, 4.6, 3.6], [25.4, 13.6, 4.2, 2.2], [19.6, 12.4, 5.2, 1.6], [28.3, 11.6, 4.4, 0]]) { sk(a, 281, w, h + 1, w); if (cap) sk(a, 281, w * 0.55, h + 1 + cap, w * 0.55); }   // the named towers: stepped crowns
  }
  { // observatory on the foothill crest, NNW: three domes on a plinth, the one landmark west of the corridor
    const a = -19 * D, [x, z] = polar(a, 295), y = footH(a) - 1.2, rot = -a;
    box(15, 2.6, 5, x, y, z, rot, pal.observatory, pal.skylineShade, pal.foothillBase, 0.3);
    for (const [off, rad] of [[0, 2.9], [-6, 1.7], [6, 1.7]]) { const g = new THREE.SphereGeometry(rad, 8, 4, 0, TAU, 0, Math.PI / 2).toNonIndexed(), p = g.attributes.position, n = g.attributes.normal, C = new Float32Array(p.count * 3);
      for (let i = 0; i < p.count; i++) { tmp.copy(col(pal.skylineShade)).lerp(col(pal.observatory), S.smoothstep(-0.3, 0.5, n.getX(i) * sunH.x + n.getZ(i) * sunH.y + 0.6 * n.getY(i))); C.set([tmp.r, tmp.g, tmp.b], i * 3); }
      g.setAttribute('color', new THREE.BufferAttribute(C, 3)); g.deleteAttribute('uv'); g.deleteAttribute('normal'); g.translate(x + Math.cos(a) * off, y + 2.6, z + Math.sin(a) * off); geos.push(g); }
  }
  // pier + wheel, SW, at the end of a pier over the surf line like the real one. 226 m out (290 m left it a pink ghost in the haze): side 1
  // sees it ~32 deg right of the play axis, through the beach-side gap in flora's ficus bowl and under the corner date palm, against the marine bank.
  const wheelAt = polar(213.6 * D, 226), HUB = 11.5;
  if (!S.low) {
    const [wx, wz] = wheelAt, face = Math.atan2(wx, wz);                                                                  // the wheel's axle points at the court
    box(46, 1.1, 5, wx + 1, 2.4, wz, 0, pal.skylineLit, pal.skylineShade, pal.skylineShade, 0);                             // deck: from the sand (x -101) across the surf line (x ~ -120) to x = -147
    for (let i = 0; i < 5; i++) box(0.8, 3.6, 0.8, wx - 19 + i * 10, -1, wz + 1.5, 0, pal.skylineShade, pal.skylineShade, pal.skylineBase, 0.5);   // pilings
    for (const s of [-1, 1]) { const g0 = geos.length; box(0.7, HUB - 2.6, 0.7, 0, 0, 0, 0, pal.wheel, pal.skylineShade, pal.skylineShade, 0); const leg = geos[g0];
      leg.translate(0, -(HUB - 2.6), 0); leg.rotateZ(s * 0.3); leg.rotateY(face); leg.translate(wx, HUB, wz - 0.6); }      // A-frame, hung from the hub
    box(9, 2.2, 4, wx + 14, 3.5, wz, 0, pal.skylineLit, pal.skylineShade, pal.skylineShade, 0);                            // arcade shed
  }
  const far = new THREE.Mesh(S.merge(geos), new THREE.MeshBasicMaterial({ vertexColors: true, fog: false, side: THREE.DoubleSide })); far.frustumCulled = false; group.add(far);

  let wheel = null;
  if (!S.low) { // ~270 tris, one mesh, turning once every two minutes: alive, but slower than anything the eye tracks
    const w = [new THREE.TorusGeometry(7, 0.34, 4, 28), new THREE.TorusGeometry(1, 0.4, 4, 8)];
    for (let i = 0; i < 8; i++) { const a = i / 8 * TAU, s = new THREE.PlaneGeometry(0.42, 7); s.translate(0, 3.5, 0); s.rotateZ(a); w.push(s);
      const c = new THREE.OctahedronGeometry(0.95); c.scale(1, 1.1, 0.8); c.translate(Math.sin(a + 0.39) * 7, Math.cos(a + 0.39) * 7, 0); w.push(c); }
    wheel = new THREE.Mesh(S.merge(w), new THREE.MeshBasicMaterial({ color: col(pal.wheel), fog: false, side: THREE.DoubleSide }));
    wheel.position.set(wheelAt[0], HUB, wheelAt[1]); wheel.rotation.order = 'YXZ'; wheel.rotation.y = Math.atan2(wheelAt[0], wheelAt[1]); group.add(wheel);
  }

  // ---- clouds: one InstancedMesh of flat-bottomed puffs. A cloud lives in the WIND frame (s along the prevailing heading, c across)
  // and the vertex shader moves s: pure function of uTime, so a frozen or jumped clock renders the same sky. Each lane wraps at the
  // r = 370 circle and the whole cloud scales to 0 over the last <= 80 m before the wrap: nothing pops, nothing leaves r <= 400.
  // Lanes stay >= 150 m off the court (toy clouds this low would hang in the wide cameras' faces) and every cloud is lifted as it
  // crosses the play axis (measured: a 40 m / sigma 90 m lift still left cream cloud bases in the ball band 31-41 % of the time), so the
  // <= 9 deg band straight down the court stays plain blue for the ball from both ends.
  const puffGeo = new THREE.IcosahedronGeometry(1, 1); { const p = puffGeo.attributes.position; for (let i = 0; i < p.count; i++) if (p.getY(i) < -0.28) p.setY(i, -0.28); }   // flat base; normals stay spherical so it shades dark
  const nCloud = S.pick(9, 4), perCloud = 6, nBank = S.pick(8, 6), N = nCloud * perCloud + nBank, aC = new Float32Array(N * 4), aKind = new Float32Array(N);
  const clouds = new THREE.InstancedMesh(puffGeo, null, N), M = new THREE.Matrix4(), Q = new THREE.Quaternion(), V = new THREE.Vector3(), SC = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0), r = S.rng(2025);
  const LANES = [[-320, 34, 30], [-280, 46, 26], [-225, 66, 22], [-160, 96, 19], [165, 104, 18], [215, 74, 21], [262, 52, 25], [300, 40, 28], [325, 33, 30]];   // [c, base y, puff radius]; near lanes ride high for the menu's upward look
  let n = 0;
  for (let ci = 0; ci < nCloud; ci++) { const [c, y, sz] = LANES[S.low ? ci * 2 + 1 : ci], L = Math.sqrt(370 * 370 - c * c), s0 = (r() * 2 - 1) * L, ang = (r() - 0.5) * 0.9 + WIND.theta0, big = 0.9 + 0.3 * r();
    for (let k = 0; k < perCloud; k++) { const top = k === perCloud - 1, u = top ? (r() - 0.5) * 0.8 : k - 2, rad = sz * big * (top ? 0.78 : 1.05 - 0.2 * Math.abs(u)) * (0.85 + 0.3 * r()), ry = rad * (0.6 + 0.12 * r());
      V.set(Math.cos(ang) * u * sz * 0.95, 0.28 * ry + (top ? ry * 0.55 : 0), Math.sin(ang) * u * sz * 0.95 + (r() - 0.5) * sz * 0.5); SC.set(rad * 1.15, ry, rad * 0.9);
      clouds.setMatrixAt(n, M.compose(V, Q.setFromAxisAngle(UP, -ang), SC)); aC.set([s0, y, c, L], n * 4); aKind[n++] = 0; } }
  // marine layer: three separate banks parked over the sea from SSW round to WNW (one wall-to-wall slab read as a white fence),
  // each a tall middle with lower shoulders, 0.6-3.4 deg, carrying the warm glow. Static: a bank, not a cloud. Bases melt into the haze (shader).
  { const BANKS = [[219, 3, 1.0], [247, 3, 1.25], [279, 2, 0.8]]; let k = 0;
    for (const [mid, cnt, tall] of BANKS) for (let j = 0; j < cnt && k < nBank; j++, k++) { const u = cnt > 1 ? j / (cnt - 1) - 0.5 : 0, a = (mid + u * 11 + (r() - 0.5) * 2) * D, [x, z] = polar(a, 372), rad = (30 - 10 * Math.abs(u)) * (0.9 + 0.3 * r()), ry = (9 + 9 * (1 - 2 * Math.abs(u)) + 4 * r()) * tall;
      V.set(0, 0.28 * ry, 0); SC.set(rad * 1.25, ry, rad * 0.55); clouds.setMatrixAt(n, M.compose(V, Q.setFromAxisAngle(UP, -a), SC)); aC.set([x, 3, z, 0], n * 4); aKind[n++] = 1; }
    clouds.count = n; }
  puffGeo.setAttribute('aC', new THREE.InstancedBufferAttribute(aC, 4)); puffGeo.setAttribute('aKind', new THREE.InstancedBufferAttribute(aKind, 1));
  clouds.material = new THREE.ShaderMaterial({ fog: false,
    uniforms: { uTime: S.uniforms.uTime, uDrift: { value: new THREE.Vector3(Math.cos(WIND.theta0), Math.sin(WIND.theta0), 2.5) }, uSun: { value: S.sunDir },
      uLit: { value: col(pal.cloudLit) }, uMid: { value: col(pal.cloudMid) }, uShade: { value: col(pal.cloudShade) }, uMLit: { value: col(pal.marineLit) }, uMShade: { value: col(pal.marineShade) },
      uGlow: { value: col(pal.sunGlow) }, uHaze: { value: col(pal.sky2) }, uHorizon: { value: col(pal.horizon) } },
    vertexShader: /* glsl */`
      attribute vec4 aC; attribute float aKind; uniform float uTime; uniform vec3 uDrift; varying vec3 vN; varying vec3 vK;
      void main() {
        float L = aC.w, s = aC.x, grow = 1.0; vec2 d = uDrift.xy, c = aC.xz;
        if (L > 0.0) { s = mod(aC.x + uDrift.z * uTime + L, 2.0 * L) - L; grow = smoothstep(0.0, min(80.0, 0.3 * L), L - abs(s)); c = d * s + vec2(-d.y, d.x) * aC.z; }
        float y = aC.y + (L > 0.0 ? 86.0 * exp(-(c.x * c.x) / 19600.0) : 0.0);                      // up and over the play axis: sigma 140 m, because the far lanes (300 m out) cross the +-17 deg ball band at |x| up to 95 m
        mat3 m = mat3(instanceMatrix); vN = normalize(m * (normal / vec3(dot(m[0], m[0]), dot(m[1], m[1]), dot(m[2], m[2]))));
        vec3 P = vec3(c.x, y, c.y) + (instanceMatrix * vec4(position, 1.0)).xyz * grow;
        vK = vec3(aKind, smoothstep(170.0, 420.0, length(P.xz - cameraPosition.xz)), position.y);
        gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
      }`,
    fragmentShader: /* glsl */`
      uniform vec3 uSun, uLit, uMid, uShade, uMLit, uMShade, uGlow, uHaze, uHorizon; varying vec3 vN; varying vec3 vK;
      void main() {
        vec3 n = normalize(vN); float k = 0.72 * n.y + 0.42 * dot(n, uSun);
        vec3 c = mix(uShade, uMid, smoothstep(-0.45, 0.1, k)); c = mix(c, uLit, smoothstep(0.05, 0.6, k));          // three soft tones, never pure white: the ball owns white
        vec3 m = mix(uMShade, uMLit, smoothstep(-0.2, 0.6, n.y)); m = mix(m, uGlow, 0.25 * smoothstep(0.0, 0.8, dot(n.xz, normalize(uSun.xz))));
        m = mix(uHorizon, m, smoothstep(-0.28, 0.3, vK.z));                                                         // no ruler-straight base: the bank rises out of the horizon haze
        c = mix(mix(c, uHaze, 0.38 * vK.y), m, vK.x);                                                              // distance is painted: far clouds sink toward the low-sky blue
        gl_FragColor = vec4(c, 1.0);
        #include <colorspace_fragment>
        c = gl_FragColor.rgb; ${DITHER} gl_FragColor.rgb = c;
      }` });
  clouds.frustumCulled = false; clouds.renderOrder = -8; group.add(clouds);

  // ---- sun: disc + halo sprite along S.sunDir, 54 deg up: only the menu, portrait windows and debug cameras ever look that high
  let sun = null;
  if (!S.low) {
    const t = S.tex(256, 256, (g, w) => { const h = w / 2, rnd = S.rng(9), gr = g.createRadialGradient(h, h, 0, h, h, h), st = (o, hex, al) => gr.addColorStop(o, `rgba(${parseInt(hex.slice(1, 3), 16)},${parseInt(hex.slice(3, 5), 16)},${parseInt(hex.slice(5, 7), 16)},${al})`);
      st(0, pal.sunDisc, 1); st(0.085, pal.sunDisc, 1); st(0.105, pal.sunHalo, 0.6); st(0.2, pal.sunHalo, 0.3); st(0.45, pal.sunGlow, 0.1); st(1, pal.sunGlow, 0); g.fillStyle = gr; g.fillRect(0, 0, w, w);
      const im = g.getImageData(0, 0, w, w), d = im.data; for (let i = 3; i < d.length; i += 4) if (d[i] > 0 && d[i] < 250) d[i] = S.clamp(d[i] + (rnd() * 2 - 1) * 1.2, 0, 255); g.putImageData(im, 0, 0); });   // dithered alpha: a 300 px halo out of 8 bits would ring
    sun = new THREE.Sprite(new THREE.SpriteMaterial({ map: t, fog: false, depthWrite: false, transparent: true })); sun.scale.setScalar(300); sun.renderOrder = -9; sun.frustumCulled = false; group.add(sun);
  }

  // ---- cirrus: a few combed-out streaks high on the dome (>= 22 deg up, so never in the play frame: the menu and portrait windows get
  // them). They ride with the camera like the dome, so a card here has no parallax to give itself away.
  let cirrus = null;
  if (!S.low) {
    const t = S.tex(256, 64, (g, w, h) => { const rnd = S.rng(31); g.fillStyle = '#fff';
      for (let i = 0; i < 70; i++) { const x = w * (0.22 + 0.56 * rnd()), y = h * (0.32 + 0.36 * rnd()), rx = w * (0.1 + 0.12 * rnd()), ry = h * (0.04 + 0.1 * rnd());
        g.save(); g.translate(x, y); g.rotate((rnd() - 0.5) * 0.1); g.scale(1, ry / rx); const gr = g.createRadialGradient(0, 0, 0, 0, 0, rx); gr.addColorStop(0, 'rgba(255,255,255,0.11)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(-rx, -rx, 2 * rx, 2 * rx); g.restore(); } });
    const gs = [], R = S.world.domeR - 12, c = new THREE.Vector3(), T = new THREE.Vector3(), B = new THREE.Vector3(), rr = S.rng(404);
    for (const [az, el, len, ht] of [[-38, 30, 46, 9], [24, 44, 38, 8], [70, 26, 40, 7], [150, 34, 50, 9], [205, 50, 36, 8], [262, 28, 44, 8], [318, 56, 34, 7]]) {
      const [x, z] = polar(az * D, Math.cos(el * D)), bow = (rr() - 0.5) * 0.5; c.set(x, Math.sin(el * D), z);
      T.set(Math.cos(WIND.theta0 + 0.5), 0.0, Math.sin(WIND.theta0 + 0.5)).addScaledVector(c, -T.dot(c)).normalize(); B.crossVectors(T, c);   // all combed ONE way in the world (upper wind, backed a little off the surface breeze), so perspective fans them like real cirrus
      const g = new THREE.PlaneGeometry(2, 2, 10, 1), p = g.attributes.position;
      for (let i = 0; i < p.count; i++) { const u = p.getX(i) * Math.tan(len * D / 2), v = p.getY(i) * Math.tan(ht * D / 2) * (1 + 0.5 * p.getX(i) * p.getX(i)) + bow * Math.tan(ht * D) * p.getX(i) * p.getX(i); V.copy(c).addScaledVector(T, u).addScaledVector(B, v).normalize().multiplyScalar(R); p.setXYZ(i, V.x, V.y, V.z); }
      g.deleteAttribute('normal'); gs.push(g); }
    cirrus = new THREE.Mesh(S.merge(gs), new THREE.MeshBasicMaterial({ map: t, color: col(pal.cloudLit), transparent: true, opacity: 0.7, fog: false, depthWrite: false, side: THREE.DoubleSide, forceSinglePass: true }));   // r160 draws transparent DoubleSide twice and re-keys the program each pass: order cannot matter here
    cirrus.renderOrder = -9.5; cirrus.frustumCulled = false; group.add(cirrus);
  }

  return { group, update(dt, t, camera) {
    dome.position.copy(camera.position);
    if (sun) sun.position.copy(camera.position).addScaledVector(S.sunDir, 400);
    if (cirrus) { cirrus.position.copy(camera.position); cirrus.rotation.y = -0.0015 * t; }                                // high cloud creeps east, a fraction of the cumulus' pace
    if (wheel) wheel.rotation.z = 0.05 * t;
  } };
}
