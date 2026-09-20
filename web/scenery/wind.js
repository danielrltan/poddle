// Wind fx: breeze lines, a few tumbling leaves, a handful of far birds. Charm, not weather. Contract: docs/SCENERY.md + the lead's spec.
// 3 draws / 598 tris / no textures (low: the ribbon mesh only, 5 ribbons, 240 tris). Everything is a pure function of (t, player's end):
// positions live in the vertex shaders, and the only JS "state" is a cache of per-cycle ribbon parameters rebuilt from (i, k, side)
// alone, so a frozen or jumped t renders identically. NOTHING here ever enters S.inFxBan: the ball owns the middle of the screen.
// Where the spec's numbers lost to what the screenshots showed: lines are ~2x the spec's width (at 40 m the spec's 0.14 m ribbon was a
// 2 px hair) and they are staged for the PLAY camera, not the map: between the fx ban (+-22 deg) and the 16:9 frame edge (+-35.7 deg) the
// only open air is 45-100 m out, 3.5-7 deg up (nearer, the wedge is a few metres wide and the corner date palms own it), so most lines
// fly there, ACROSS the view: east over the stucco roofs among the fan-palm crowns, west over the open beach side against ridge and sky.
const LIFE = 3.8, WIN = 0.62, SEG = 24, MARGIN = 2.2, ADV = 0.35;   // ADV: downwind drift of the loop per radian, in radii (so a path ends 2.2 r past its straight length)   // s a line lives; share of the path lit at once; MARGIN covers meander + helix + width

export function create(THREE, S) {
  const group = new THREE.Group(), pal = S.pal, U = S.uniforms, fogU = THREE.UniformsUtils.clone(THREE.UniformsLib.fog);
  const ban = z => 14 + 0.3 * Math.max(0, Math.abs(z) - 13);   // S.inFxBan's edge, needed as a number to place things just outside it
  const FOG_V = '\n#include <fog_pars_vertex>\n', FOG_F = '\n#include <fog_pars_fragment>\n', CS = '\n#include <colorspace_fragment>\n', OUT = CS + '#include <fog_fragment>\n';   // three only expands #include at a line start

  // ---- breeze lines: ONE mesh, N ribbons. The path is fixed in space (a run along the wind at birth, one vertical loop 55-70 % along);
  // a ~60 % window slides down it, so the read is streak - curl - streak: the run is 3-4x the loop's circumference and head and
  // tail hold their width and alpha (a short window over a fat loop left a lone white 'C', like a loading spinner).
  const N = S.pick(10, 5), nv = N * (SEG + 1) * 2, aU = new Float32Array(nv), aSide = new Float32Array(nv), aId = new Float32Array(nv), idx = [];
  for (let i = 0, v = 0; i < N; i++) for (let j = 0; j <= SEG; j++) for (let s = -1; s <= 1; s += 2, v++) {
    aU[v] = j / SEG; aSide[v] = s; aId[v] = i; if (s === 1 && j < SEG) idx.push(v - 1, v, v + 1, v, v + 2, v + 1);
  }
  const rgeo = new THREE.BufferGeometry(); rgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array(nv * 3), 3));
  rgeo.setAttribute('aU', new THREE.BufferAttribute(aU, 1)); rgeo.setAttribute('aSide', new THREE.BufferAttribute(aSide, 1)); rgeo.setAttribute('aId', new THREE.BufferAttribute(aId, 1)); rgeo.setIndex(idx);
  const A = new Float32Array(N * 4), B = new Float32Array(N * 4), C = new Float32Array(N * 4);   // origin xyz + arc length | dir xz, loop r, loop start | birth, alpha gate, phase, hand
  const ribbons = new THREE.Mesh(rgeo, new THREE.ShaderMaterial({
    transparent: true, depthWrite: false, side: THREE.DoubleSide,
    uniforms: { uTime: U.uTime, uWind: U.uWind, uA: { value: A }, uB: { value: B }, uC: { value: C }, uCol: { value: S.color(pal.breeze) } },
    vertexShader: `${S.windGLSL}
      attribute float aU, aSide, aId; uniform vec4 uA[${N}], uB[${N}], uC[${N}]; varying float vA, vS;
      vec3 path(float s, vec4 a, vec4 b, vec4 c) {                     // s = metres of arc from the origin
        float r = b.z, ph = clamp((s - b.w) / r, 0.0, 6.2832), along = min(s, b.w) + max(0.0, s - b.w - 6.2832 * r) + r * sin(ph) + ${ADV.toFixed(2)} * r * ph;   // the loop drifts downwind as it turns: an open script curl, where a closed circle seen side-on is an 'O'
        float lat = c.w * (0.6 * r * smoothstep(0.0, 6.2832, ph) + 0.3 * sin(along * 0.32 + c.z));   // the loop is a helix, never a flat coin
        return vec3(a.x + b.x * along - b.y * lat, a.y + r * (1.0 - cos(ph)) + 0.3 * sin(along * 0.5 + c.z * 2.0), a.z + b.y * along + b.x * lat);
      }
      void main() {
        int i = int(aId + 0.5); vec4 a = uA[i], b = uB[i], c = uC[i];
        float tau = (uTime - c.x) / ${LIFE.toFixed(1)}, on = step(0.0, tau) * step(tau, 1.0) * step(0.001, c.y), f = clamp(tau * ${(1 + WIN).toFixed(2)} - ${WIN.toFixed(2)} * (1.0 - aU), 0.0, 1.0), s = f * a.w;
        vec3 P = path(s, a, b, c), T = normalize(path(s + 0.12, a, b, c) - path(s - 0.12, a, b, c)), V = cameraPosition - P;
        float w = max(0.3, 0.0095 * length(V)) * pow(aU, 0.22) * (1.0 - pow(aU, 8.0)) * smoothstep(0.0, 0.06, f) * (1.0 - smoothstep(0.94, 1.0, f)) * on;   // fat behind the head, pointed both ends
        P += normalize(cross(T, V)) * aSide * w;
        vA = 0.55 * c.y * on * smoothstep(0.0, 0.1, tau) * (1.0 - smoothstep(0.78, 1.0, tau)) * smoothstep(0.0, 0.1, aU); vS = aSide;
        gl_Position = projectionMatrix * viewMatrix * vec4(P, 1.0);
      }`,
    fragmentShader: `uniform vec3 uCol; varying float vA, vS;
      void main() { gl_FragColor = vec4(uCol, vA * (1.0 - smoothstep(0.6, 1.0, abs(vS)))); ${CS} }`,   // soft edges: no fog (it is fog-coloured already)
  }));
  ribbons.frustumCulled = false; ribbons.renderOrder = 1; group.add(ribbons);   // below the net's 2: a line never draws over the net

  // per-ribbon timing: 2 lobes x N/2 slots that share a period and are spread evenly through it, so at most 2 lines per lobe overlap
  // by construction (no state needed); the gust gate and a hashed skip break up the rhythm. Period and phase are tabled once: update()
  // only indexes typed arrays (calling period(i)/nLobe(i) ten times a frame boxed ~100 B of heap numbers per frame).
  const east = i => i % 2 === 0, PER = new Float64Array(N), OFF = new Float64Array(N);
  for (let i = 0; i < N; i++) { const n = east(i) ? Math.ceil(N / 2) : Math.floor(N / 2); PER[i] = (east(i) ? 12.7 : 13.9) * (S.low ? 0.65 : 1); OFF[i] = (Math.floor(i / 2) + 0.5) * PER[i] / n; }   // NOT near 15 s / n: the gust period would alias and the same slots would win every time
  const lastK = new Int32Array(N).fill(-2147483648), w = { x: 0, z: 0, gust: 0, dx: 0, dz: 0 };
  let seed = 1; const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 4294967296;   // S.rng's LCG without the closure: no allocation in update
  function cycle(i, k, side) {
    const o = i * 4, sx = east(i) ? 1 : -1, tb = k * PER[i] - OFF[i];
    seed = S.hash(i, k) || 1; const born = tb + rnd() * 0.2, skip = rnd() < 0.3;   // charm, not weather: from either baseline a line is in frame a bit under half the time
    C[o] = born; C[o + 1] = 0; if (skip) return;
    for (let c = 0; c < 4; c++) {
      // 80 % of lines are born ahead of the local player, where the play camera can see them. Stages (d = distance ahead of that camera):
      //   far  (70 %): d 55-105, 3.5-6.5 deg up. East that is over the roofs (>= 9.8 m) among the fan-palm crowns; west it is over the
      //                open beach side, above the marine bank's 3.4 deg, against the ridge and the blue.
      //   near (30 %): east the street canyon (x < 28.5: further out is inside the stucco), west a low pass over the lawn. Mostly for
      //                the head-offset, menu and wide cameras; the play frame only catches their outer ends.
      const fwd = (rnd() < 0.8 ? 1 : -1) * (side === 0 ? -1 : 1), zr = rnd(), u = rnd(), r0 = 0.9 + 0.4 * rnd(), sf = 0.5 + 0.12 * rnd(), ph = rnd() * 6.283, hand = rnd() < 0.5 ? -1 : 1, yr = rnd(), far = rnd() < 0.7, dr = rnd();
      const z0 = fwd * (far ? 43 + 50 * zr : sx > 0 ? 8 + 26 * Math.sqrt(zr) : 26 + 34 * zr), d = Math.abs(z0) + 12.1, big = far ? 1.35 : 1;
      const y = far ? Math.max(sx > 0 ? 9.8 : 5, 3.1 + d * (0.062 + 0.05 * yr)) : sx > 0 ? 3.4 + 2.8 * yr : 1.5 + 1.6 * yr, palm = !far && Math.abs(Math.abs(z0) - 17.5) < 5 ? 4.5 : 0;   // the corner date palms' crowns reach ~4 m past the ban edge
      let D = (far ? 17 + 8 * dr : 12 + 5 * dr);
      const x0 = sx * (ban(z0) + MARGIN + (far ? 0.04 * Math.abs(z0) : 0) + palm + u * u *   /* far: the ban edge alone tends to 17 deg off axis with distance; this holds >= 21.5 */ (far ? 7 : sx > 0 ? Math.max(0, 19.5 - ban(z0) - palm) : 5)); S.wind(x0, z0, born, w); const gate = S.smoothstep(0.36, 0.56, w.gust);   // no gust here, no line: they turn up where the palms are bending
      // east lines START just outside the ban and blow away from it; west lines END just outside it (they travel toward the court, never into it)
      let ox, oz, ex, ez;
      const r = r0 * big, reach = ADV * 6.2832 * r;
      if (sx > 0) { ox = x0; oz = z0; if (!far) D = Math.min(D, (28.5 - ox) / w.dx - reach); if (D < 7.5) continue; ex = ox + w.dx * (D + reach); ez = oz + w.dz * (D + reach); }   // stop short of the stucco fronts at x = 30
      else { ez = z0; ex = x0; ox = ex - w.dx * (D + reach); oz = ez - w.dz * (D + reach); }
      const s0 = sf * D, lim = far ? 78 : 47, limZ = far ? 108 : 66;                                                // far lines stop short of the hero row (x 62 + its crowns are above them) and the cross streets
      const ok = gate > 0.02 && Math.abs(ox) <= lim && Math.abs(ex) <= lim && Math.abs(oz) <= limZ && Math.abs(ez) <= limZ && ox * sx > 0 && ex * sx > 0
        && Math.abs(ox) >= ban(oz) + MARGIN - 0.01 && Math.abs(ex) >= ban(ez) + MARGIN - 0.01;   // the far side of the ban edge is convex: both ends out = all of it out
      if (!ok) continue;
      A[o] = ox; A[o + 1] = y; A[o + 2] = oz; A[o + 3] = D + 6.2832 * r; B[o] = w.dx; B[o + 1] = w.dz; B[o + 2] = r; B[o + 3] = s0; C[o + 1] = gate; C[o + 2] = ph; C[o + 3] = hand; return;
    }
  }

  // ---- leaves + petals: 24 tumbling diamonds, low over the side lawns and the street. Position = f(id, uTime) in the shader.
  let leaves = null, birds = null;
  if (!S.low) {
    const NL = 24, L0 = new Float32Array(NL * 4), L1 = new Float32Array(NL * 4), r = S.rng(7331);
    for (let i = 0; i < NL; i++) {
      // anchor = where the path touches the ban edge (east: its start, west: its end); moving downwind from/upwind of it only gets further out
      const e = i % 2 === 0, z0 = (r() * 2 - 1) * 34, ax = ban(z0) + 1.5 + r() * 6, room = e ? 29.5 - ax : (Math.abs(z0) < 19 ? 27 - ax : 44 - ax);   // east stops at the stucco fronts, west at the neighbour courts' windscreen
      const span = Math.max(6, Math.min(26, room) * (0.6 + 0.4 * r())), speed = 2.2 + 1.8 * r();
      L0.set([e ? ax : -ax, z0, r(), span / speed], i * 4); L1.set([span, i % 5 === 4 ? 2 : r() < 0.55 ? 0 : 1, 2.5 + 3 * r(), 0.5 + 0.25 * r()], i * 4);   // span, kind, spin rad/s, size m: stylised big, they are only ever seen from 20 m+
    }
    const lgeo = new THREE.BufferGeometry(); lgeo.setAttribute('position', new THREE.BufferAttribute(new Float32Array([0, 0, -0.5, 0.3, 0.06, 0, 0, 0, 0.5, -0.3, 0.06, 0]), 3)); lgeo.setIndex([0, 1, 2, 0, 2, 3]);
    lgeo.setAttribute('aL0', new THREE.InstancedBufferAttribute(L0, 4)); lgeo.setAttribute('aL1', new THREE.InstancedBufferAttribute(L1, 4));
    leaves = new THREE.InstancedMesh(lgeo, new THREE.ShaderMaterial({
      side: THREE.DoubleSide, fog: true,
      uniforms: { ...fogU, uTime: U.uTime, uWind: U.uWind, uC0: { value: S.color(pal.leafGreen) }, uC1: { value: S.color(pal.leafBrown) }, uC2: { value: S.color(pal.jacarandaLit) } },
      vertexShader: `${S.windGLSL} ${FOG_V}
        attribute vec4 aL0, aL1; uniform vec3 uC0, uC1, uC2; varying vec3 vC;
        void main() {
          float f = fract(uTime / aL0.w + aL0.z), west = step(aL0.x, 0.0), ph = aL0.z * 6.2832, a = uTime * aL1.z + ph, b = a * 0.63;
          vec2 d = uWind.xy, xz = aL0.xy + d * aL1.x * (f - west) + vec2(-d.y, d.x) * 0.7 * sin(uTime * 1.3 + ph);
          float hop = (0.2 + 0.8 * sGust(xz)) * pow(0.5 + 0.5 * sin(uTime * (0.9 + 0.5 * aL0.z) + ph * 3.0), 1.5);   // lifted by the gust, touching down between
          vec3 p = position * aL1.w * smoothstep(0.0, 0.08, f) * (1.0 - smoothstep(0.92, 1.0, f));              // shrink to nothing at the wrap: no pop
          p.yz = mat2(cos(a), sin(a), -sin(a), cos(a)) * p.yz; p.xz = mat2(cos(b), sin(b), -sin(b), cos(b)) * p.xz;
          vC = mix(mix(uC0, uC1, step(0.5, aL1.y)), uC2, step(1.5, aL1.y)) * (0.72 + 0.26 * abs(cos(a)));         // flashes as it tumbles
          vec4 mvPosition = viewMatrix * vec4(p + vec3(xz.x, 0.3 + 2.7 * hop, xz.y), 1.0); gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `${FOG_F}\n varying vec3 vC; void main() { gl_FragColor = vec4(vC, 1.0); ${OUT} }`,
    }), NL);
    leaves.frustumCulled = false; group.add(leaves);

    // ---- birds: 7 slate "M"s. A line of 3 pelicans gliding up the shore (the LA beach tell), and two pairs of gulls wheeling far NE and SW
    // so either end has something in a top corner. 10 tris each; flap, glide, bank and travel are all in the shader.
    const flock = [   // cx, y, cz, R | speed m/s (sign = sense), phase, mode 0 line / 1 circle, half-span m
      [-98, 15, 0, 0, -8, 0, 0, 2.6], [-101, 15.8, 0, 0, -8, 9, 0, 2.6], [-104, 16.6, 0, 0, -8, 18, 0, 2.6],
      [112, 30, -115, 48, 7, 0, 1, 2.2], [114, 36, -117, 60, -6.5, 2.1, 1, 2.0], [-112, 29, 115, 48, 7, 1, 1, 2.2], [-114, 35, 117, 60, -6.5, 4, 1, 2.0]];   // circles stay inside ~200 m: further out the fog bleaches slate to a white speck
    const pos = [], q0 = [], q1 = [];
    for (const b of flock) {
      // per wing: root (chord .5) -> wrist -> tip, as two tapering quads; x = along the span in half-spans, z = forward. Plus a body diamond.
      const V = [], quad = (p, q, r2, s) => V.push(p, q, r2, p, r2, s);
      for (const sg of [-1, 1]) { const R0 = [0, 0, 0.3], R1 = [0, 0, -0.22], W0 = [sg * 0.5, 0, 0.22], W1 = [sg * 0.5, 0, -0.16], Tp = [sg, 0, -0.12], Tq = [sg, 0, -0.2];
        quad(R0, W0, W1, R1); quad(W0, Tp, Tq, W1); }
      quad([0, 0, 0.62], [0.09, 0, 0.1], [0, 0, -0.5], [-0.09, 0, 0.1]);
      for (const v of V) { pos.push(v[0], v[1], v[2]); q0.push(b[0], b[1], b[2], b[3]); q1.push(b[4], b[5], b[6], b[7]); }
    }
    const bgeo = new THREE.BufferGeometry(); bgeo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    bgeo.setAttribute('aB0', new THREE.Float32BufferAttribute(q0, 4)); bgeo.setAttribute('aB1', new THREE.Float32BufferAttribute(q1, 4));
    birds = new THREE.Mesh(bgeo, new THREE.ShaderMaterial({
      side: THREE.DoubleSide, fog: true, uniforms: { ...fogU, uTime: U.uTime, uCol: { value: S.color(pal.bird) } },
      vertexShader: `uniform float uTime; ${FOG_V}
        attribute vec4 aB0, aB1;
        void main() {
          float u = abs(position.x), sp = aB1.x, ph = aB1.y, hs = aB1.w, k = 1.0; vec3 c; vec2 fw;
          if (aB1.z < 0.5) { float z = mod(sp * uTime - ph + 210.0, 420.0) - 210.0; k = smoothstep(0.0, 30.0, 210.0 - abs(z));   // up the coast, fading out at both ends of the run
            c = vec3(aB0.x + 5.0 * sin(z * 0.025), aB0.y + 0.8 * sin(z * 0.06 + ph), z); fw = vec2(0.125 * cos(z * 0.025), 1.0) * sign(sp); }
          else { float an = sp * uTime / aB0.w + ph; c = vec3(aB0.x + aB0.w * cos(an), aB0.y + 3.0 * sin(an * 0.7 + ph), aB0.z + aB0.w * sin(an)); fw = vec2(-sin(an), cos(an)) * sign(sp); }
          fw = normalize(fw); vec2 rt = vec2(fw.y, -fw.x);
          float beat = smoothstep(-0.2, 0.5, sin(uTime * 0.45 + ph * 1.7)), fl = sin(uTime * (5.0 - aB1.z) + ph * 2.3) * beat;   // a few beats, then a long glide
          // the "M": wrist above the shoulder, tip drooping below the wrist; the flap swings the whole wing about the root
          float y = hs * (0.34 * min(u, 0.5) - 0.42 * max(0.0, u - 0.5) + u * (0.1 + 0.36 * fl)), bank = aB1.z * 0.35 * sign(sp);
          vec3 l = vec3(position.x * hs * (1.0 - 0.12 * abs(fl)), y, position.z * hs); l.y += l.x * bank;                     // lean into the turn
          vec4 mvPosition = viewMatrix * vec4(c + k * (rt.x * l.x + fw.x * l.z) * vec3(1, 0, 0) + k * vec3(0, l.y, 0) + k * (rt.y * l.x + fw.y * l.z) * vec3(0, 0, 1), 1.0);
          gl_Position = projectionMatrix * mvPosition;
          #include <fog_vertex>
        }`,
      fragmentShader: `${FOG_F}\n uniform vec3 uCol; void main() { gl_FragColor = vec4(uCol, 1.0); ${CS}
        #ifdef USE_FOG
          gl_FragColor.rgb = mix(gl_FragColor.rgb, fogColor, 0.55 * smoothstep(fogNear, fogFar, vFogDepth));   // partial fog: a bird must stay a DARK mark, never a pale one
        #endif
      }`,
    }));
    birds.frustumCulled = false; group.add(birds);
  }

  let lastSide = -1;
  return { group, update(dt, t) {
    let side = 0; try { side = S.ctx.side() ? 1 : 0; } catch (e) {}
    if (side !== lastSide) { lastSide = side; lastK.fill(-2147483648); }   // the cache key is (i, k, side): what is drawn depends on t and the player's end, never on history
    for (let i = 0; i < N; i++) { const k = Math.floor((t + OFF[i]) / PER[i]); if (k !== lastK[i]) { lastK[i] = k; cycle(i, k, side); } }
  } };
}
