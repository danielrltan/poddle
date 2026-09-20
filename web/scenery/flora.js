// Flora: the LA silhouette. Mexican fan palms in street rows (skinny curved trunk, dead-frond skirt, pom-pom of folded fan blades),
// fuller date palms at the court corners, a ficus bowl + far tree band + jacarandas as instanced blobs, hedge with bougainvillea.
// Contract: docs/SCENERY.md. Everything is GEOMETRY with vertex colours (no alpha cards: the head-coupled camera exposes cards and
// blended fronds shimmer), Lambert + scene fog, and all motion is S.sway in the vertex shader off the ONE shared wind field, so a
// gust front visibly ripples down a row and arrives with wind.js's breeze lines. Budget 8 draws / 45k tris: we use 6 / 44.5k (low 5 / 23.8k).
// What the play camera can actually see (top of frame = 8.8 deg): the corner dates, trunks, the ficus line and the far SKYLINE row. Near crowns are for the menu.
export function create(THREE, S) {
  const group = new THREE.Group(), pal = S.pal, C = S.color, V = (x, y, z) => new THREE.Vector3(x, y, z), lerp = (a, b, k) => a + (b - a) * k;
  const grey = (c, k) => { const l = 0.3 * c.r + 0.59 * c.g + 0.11 * c.b; return c.lerp(new THREE.Color(l, l, l * 1.04), k); };   // Washingtonia bark is grey-brown; the warm sun re-tans it
  const mix = (a, b, k) => new THREE.Color().lerpColors(C(a), C(b), S.clamp(k, 0, 1)), GOLD = 2.39996;

  // ---- triangle soup -> geometry. Vertex = { p: Vector3, c: Color, f: Vector3 | undefined }. `f` becomes aFr: the direction from the
  // crown centre scaled by 0..1 "tipness" (0 = rigid), which is all the shader needs to flutter, lift and stream a frond.
  const soupGeo = (tris, mode, centre) => {   // mode: 'smooth' (v.n given) | 'leaf' (soft crown normals, see below) | undefined (flat facets)
    const n = tris.length, pos = new Float32Array(n * 3), col = new Float32Array(n * 3), fr = new Float32Array(n * 3), g = new THREE.BufferGeometry();
    tris.forEach((v, i) => { pos.set([v.p.x, v.p.y, v.p.z], i * 3); col.set([v.c.r, v.c.g, v.c.b], i * 3); if (v.f) fr.set([v.f.x, v.f.y, v.f.z], i * 3); });
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3)); g.setAttribute('color', new THREE.BufferAttribute(col, 3)); g.setAttribute('aFr', new THREE.BufferAttribute(fr, 3));
    if (mode === 'smooth') g.setAttribute('normal', new THREE.BufferAttribute(new Float32Array(tris.flatMap(v => [v.n.x, v.n.y, v.n.z])), 3)); else g.computeVertexNormals();   // non-indexed: flat facets
    // 'leaf': a crown shades as ONE soft sunlit ball (outward + up) with a little facet left for sparkle. leafMat stops three flipping
    // these on back faces, so a frond seen from underneath glows like a backlit leaf instead of going black, and the crown holds its
    // shape when blurred behind the menu.
    if (mode === 'leaf') { const nn = g.attributes.normal, o = new THREE.Vector3(), fn = new THREE.Vector3();
      tris.forEach((v, i) => { o.copy(v.p).sub(centre).normalize(); o.y += 0.55; fn.fromBufferAttribute(nn, i); if (fn.dot(o) < 0) fn.negate(); o.multiplyScalar(0.6).addScaledVector(fn, 0.4).normalize(); nn.setXYZ(i, o.x, o.y, o.z); }); }
    return g;
  };
  // tube through rings [{ c: centre, r, col }], smooth radial normals (a faceted 6-gon trunk flickers as the head moves)
  const tube = (rings, sides, out = []) => {
    const pt = (k, a) => { const R = rings[k], n = V(Math.cos(a), 0, Math.sin(a)); return { p: R.c.clone().addScaledVector(n, R.r), c: R.col, n, f: R.f }; };
    for (let k = 0; k < rings.length - 1; k++) for (let i = 0; i < sides; i++) {
      const a0 = i / sides * 6.2832, a1 = (i + 1) / sides * 6.2832, A = pt(k, a0), B = pt(k, a1), D = pt(k + 1, a0), E = pt(k + 1, a1); out.push(A, D, B, B, D, E);
    }
    return out;
  };
  const tipF = (p, centre, tip) => p.clone().sub(centre).normalize().multiplyScalar(tip);

  // ---- Mexican fan palm (Washingtonia robusta), unit = 16 m to the crown top. Instance scale is uniform, so girth scales with it:
  // the trunk is modelled thin. Blades: petiole sliver + a pleated fan with alternating long/short ribs, so the crown edge is spiky
  // (that spikiness is what says "fan palm" in silhouette and survives a blur as a soft burr), drooping more the lower they sit.
  const fanPalm = (nBlades, fanPts, sides, rnd) => {
    const bend = y => 0.85 * (y / 16) * (y / 16), ctr = y => V(bend(y), y, 0), crown = ctr(14.2), tris = [];
    const trunkRings = [[0, 0.36], [0.9, 0.235], [4, 0.215], [7.6, 0.195], [11, 0.175], [14.3, 0.16]].map(([y, r], k) => ({ c: ctr(y), r, col: grey(mix(pal.trunkDark, pal.trunkLit, 0.15 + 0.85 * y / 14 - (k % 2) * 0.12), 0.4) }));
    const trunk = soupGeo(tube(sides > 5 ? trunkRings : [trunkRings[0], trunkRings[1], trunkRings[3], trunkRings[5]], sides), 'smooth');
    // the skirt: a petticoat of dead fronds hanging under the crown. THE authentic tell of an untrimmed LA street palm.
    const skirt = soupGeo(tube([[11.9, 0.18, 1], [12.7, 0.36, 0.85], [13.6, 0.5, 0.6], [14.2, 0.3, 0.4]].map(([y, r, k]) => ({ c: ctr(y), r, col: mix(pal.skirt, pal.skirtDark, k) })), sides), 'smooth');
    for (let i = 0; i < nBlades; i++) {
      const k = i / (nBlades - 1), az = i * GOLD + rnd() * 0.5, dead = k > 0.9, el = dead ? -1.2 : Math.asin(lerp(0.97, -0.62, k / 0.9)) + (rnd() - 0.5) * 0.2;   // even over the sphere: a ball, not a bouquet
      const d = V(Math.cos(el) * Math.cos(az), Math.sin(el), Math.cos(el) * Math.sin(az)), s = V(-Math.sin(az), 0, Math.cos(az)), n = new THREE.Vector3().crossVectors(s, d);
      const pet = lerp(0.85, 1.15, k), R = lerp(1.6, 2.0, rnd()) * (dead ? 0.55 : 1), span = lerp(2.6, 3.1, rnd()), droop = lerp(0.1, 1.25, k * k), full = pet + R;
      const cIn = dead ? mix(pal.skirtDark, pal.skirt, 0.3) : mix(pal.fanDark, pal.fanMid, 0.6 - 0.6 * k), cOut = dead ? C(pal.skirt) : mix(pal.fanLit, pal.fanMid, k * 1.15 - 0.1 + rnd() * 0.2);
      const mk = (p, c) => { const t = S.clamp(p.distanceTo(crown) / full, 0, 1); p.y -= droop * t * t; return { p, c, f: tipF(p, crown, t) }; };
      const p1 = crown.clone().addScaledVector(d, pet), hub = () => mk(p1.clone(), cIn), rim = [];
      for (let j = 0; j < fanPts; j++) { const a = (j / (fanPts - 1) - 0.5) * span, r = R * (j % 2 ? 0.52 : 1) * (1 - 0.1 * Math.abs(a));
        rim.push(mk(p1.clone().addScaledVector(d, Math.cos(a) * r).addScaledVector(s, Math.sin(a) * r).addScaledVector(n, (j % 2 ? -0.16 : 0.1) * R), j % 2 ? mix(pal.fanMid, pal.fanDark, 0.3 + 0.5 * k) : cOut)); }
      if (dead) rim.forEach(v => { v.c = mix(pal.skirt, pal.skirtDark, rnd() * 0.6); });
      tris.push(mk(crown.clone().addScaledVector(s, -0.09), cIn), mk(crown.clone().addScaledVector(s, 0.09), cIn), hub());
      for (let j = 0; j < fanPts - 1; j++) tris.push(hub(), rim[j], rim[j + 1]);
    }
    return S.merge([trunk, skirt, soupGeo(tris, 'leaf', crown)]);
  };

  // ---- date palm (Phoenix), unit = 9 m. Thick banded trunk, pineapple boss, and a full BALL of many narrow feather fronds: each a
  // V-folded strip (dark rib, light leaflet edges) that arches hard and hangs its tip, its width saw-toothing every segment so the
  // outline is leaflets, not a strap. (A dozen wide floppy fronds read as a banana plant; count + narrowness + droop is the whole tell.)
  const datePalm = (nFronds, segs, rnd) => {
    const crown = V(0, 6.0, 0), tris = [], rings = [];
    for (let k = 0; k <= 8; k++) { const y = k / 8 * 5.7; rings.push({ c: V(0.12 * Math.sin(y * 0.5), y, 0), r: (k === 0 ? 0.56 : 0.43 - 0.006 * y) * (k % 2 ? 1.06 : 1), col: mix(pal.trunkDark, pal.trunkLit, (k % 2 ? 0.75 : 0.25) + 0.03 * y) }); }
    const trunk = soupGeo(tube(rings, 8), 'smooth'), boss = new THREE.IcosahedronGeometry(0.72, 1); boss.scale(1, 1.15, 1); boss.translate(rings[8].c.x, 6.05, 0);
    S.paint(boss, (x, y, z, i, c) => c.lerpColors(C(pal.skirtDark), C(pal.skirt), S.clamp((y - 5.4) / 1.3, 0, 1))); boss.setAttribute('aFr', new THREE.BufferAttribute(new Float32Array(boss.attributes.position.count * 3), 3));
    for (let i = 0; i < nFronds; i++) {
      const k = i / (nFronds - 1), az = i * GOLD + rnd() * 0.4, e0 = Math.asin(lerp(0.98, -0.45, k)) + (rnd() - 0.5) * 0.12, arc = lerp(1.25, 1.9, k) + rnd() * 0.3, L = lerp(3.7, 4.6, rnd()) * lerp(0.85, 1, Math.sin(Math.PI * Math.min(1, k * 1.15))), roll = (rnd() - 0.5) * 0.7, W = lerp(0.62, 0.82, rnd());
      const r = V(Math.cos(az), 0, Math.sin(az)), s0 = V(-Math.sin(az), 0, Math.cos(az)), p = crown.clone().addScaledVector(r, 0.3), row = [];
      for (let j = 0; j <= segs; j++) {
        const u = j / segs, pitch = e0 - arc * Math.pow(u, 1.5), t = r.clone().multiplyScalar(Math.cos(pitch)).setY(Math.sin(pitch)), n0 = new THREE.Vector3().crossVectors(s0, t);
        const s = s0.clone().multiplyScalar(Math.cos(roll)).addScaledVector(n0, Math.sin(roll)), n = n0.clone().multiplyScalar(Math.cos(roll)).addScaledVector(s0, -Math.sin(roll));
        const w = j === segs ? 0 : W * Math.max(0.12, Math.pow(Math.sin(Math.PI * Math.pow(u, 0.7)), 0.6)) * (j % 2 ? 1 : 0.42), shade = 0.2 + 0.8 * k;
        const f = tipF(p, crown, u), mkv = (q, c) => ({ p: q, c, f });
        row.push([mkv(p.clone().addScaledVector(s, -w / 2).addScaledVector(n, w * 0.35), mix(pal.dateLit, pal.dateDark, shade * 0.8 - 0.2 * u)), mkv(p.clone(), mix(pal.dateLit, pal.dateDark, 0.55 + 0.45 * shade)), mkv(p.clone().addScaledVector(s, w / 2).addScaledVector(n, w * 0.35), mix(pal.dateLit, pal.dateDark, shade - 0.2 * u))]);
        p.addScaledVector(t, L / segs);
      }
      for (let j = 0; j < segs; j++) { const [a, b, c] = row[j], [d, e, g] = row[j + 1]; tris.push(a, b, e, b, c, e); if (j < segs - 1) tris.push(a, e, d, c, g, e); }
    }
    return S.merge([trunk, boss, soupGeo(tris, 'leaf', V(0, 4.8, 0))]);
  };

  // ---- sway. Trunk bends with h^2 along the wind, breathing at its own phase; fronds (aFr) stream downwind, the windward ones lift,
  // and everything with tipness flutters at ~3 Hz with a wave running out along the frond. Gust comes from the instance ORIGIN so a
  // whole tree moves as one and the front travels tree to tree.
  const DECL = 'attribute vec3 aFr;\n';
  const palmSway = (H, bendK, reach) => `
    float calm = mix(0.3, 1.0, smoothstep(0.0, 10.0, abs(O.x) - (9.0 + 0.2 * max(0.0, abs(O.z) - 13.0))));                 // palms that stand at the calm corridor's edge are in the ball band's outer columns: they only stir
    float h = position.y / ${H.toFixed(1)}, w = sWind(O.xz) * calm, g = sGust(O.xz) * calm, ph = 6.283 * sHash(O.xz);
    P.xz += uWind.xy * (w * ${(bendK * H).toFixed(3)} * sScale * h * h * (0.6 + 0.4 * sin(1.3 * uTime + ph)));
    float tip = length(aFr);
    if (tip > 0.001) { vec3 fd = normalize(mat3(modelMatrix) * (mat3(instanceMatrix) * aFr)); float t2 = tip * tip * sScale, along = dot(fd.xz, uWind.xy);
      float fl = sin(18.85 * uTime + ph + 9.0 * tip + 5.0 * fd.x + 3.0 * fd.z), slow = sin(2.1 * uTime + ph * 1.7 + 4.0 * fd.z);
      P.xz += uWind.xy * (t2 * ${reach.toFixed(2)} * (0.25 * g + 0.05 * w * slow + 0.016 * w * fl));
      P.y += t2 * ${reach.toFixed(2)} * ((0.06 - 0.25 * along) * g + 0.05 * w * slow + 0.028 * w * fl); }`;
  const leafMat = mat => { const sway = mat.onBeforeCompile, key = mat.customProgramCacheKey();   // DoubleSide WITHOUT the back-face normal flip (x faceDirection twice = identity)
    mat.onBeforeCompile = sh => { sway(sh); sh.fragmentShader = sh.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n#ifdef DOUBLE_SIDED\n normal *= faceDirection;\n#endif'); };
    mat.customProgramCacheKey = () => key + ':leaf'; return mat; };
  const palmMat = (H, bendK, reach) => leafMat(S.sway(new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide }), palmSway(H, bendK, reach), DECL));

  // ---- placement. Every spot passes the layout rules; tall things keep their whole crown (radius cr) out of the calm corridor.
  const M = new THREE.Matrix4(), Q = new THREE.Quaternion(), Q2 = new THREE.Quaternion(), AX = new THREE.Vector3(), P = new THREE.Vector3(), SC = new THREE.Vector3(), palms = [];
  const clear = (x, z, tall, cr) => !S.keepOut(x, z, cr * 0.5) && !(tall > 2.4 && S.noTall(x, z)) && !(tall > 5 && S.inCorridor(Math.abs(x) - cr, z)) && Math.hypot(x, z) <= 200;
  const instanced = (geo, mat, spots, rnd, leanMax) => {
    const im = new THREE.InstancedMesh(geo, mat, spots.length);
    spots.forEach(([x, z, sc, toward], i) => { const a = toward === undefined ? rnd() * 6.2832 : toward + (rnd() - 0.5) * 0.5;      // lean TOWARD azimuth a (axis = a rotated -90 deg about y)
      Q.setFromAxisAngle(AX.set(Math.sin(a), 0, -Math.cos(a)), toward === undefined ? lerp(0.035, leanMax, rnd()) : leanMax); Q2.setFromAxisAngle(AX.set(0, 1, 0), rnd() * 6.2832);
      im.setMatrixAt(i, M.compose(P.set(x, -0.05, z), Q.multiply(Q2), SC.set(sc, sc, sc))); });
    im.frustumCulled = false; group.add(im); return im;                      // rows span the whole world: one bounding sphere would never cull anyway
  };

  const rndP = S.rng(4107), near = [], far = [];
  const row = (list, fixed, along0, along1, step, alongIsZ, sMin, sMax, cr, off = 0) => {
    for (let a = along0 + off; a <= along1 + 1e-6; a += step) {
      const j = (rndP() - 0.5) * 1.6, x = alongIsZ ? fixed + (rndP() - 0.5) * 0.8 : a + j, z = alongIsZ ? a + j : fixed + (rndP() - 0.5) * 0.8, sc = lerp(sMin, sMax, rndP()), gap = rndP() < 0.08;
      if (!gap && clear(x, z, 16 * sc, cr * sc)) { list.push([x, z, sc]); palms.push({ x, z, h: 16 * sc, crown: cr * sc, kind: 'fan' }); }
    }
  };
  row(near, 17, -70, 70, 10, true, 0.8, 1.2, 2.6); row(near, 27, -70, 70, 10, true, 0.8, 1.2, 2.6, 5); row(near, -32, -80, 80, 10, true, 0.8, 1.2, 2.6);   // street rows + the west lawn row
  row(far, 62, -198, 198, 11, true, 1.4, 1.6, 2.6);                                                                                                   // the hero boulevard: crowns converge into frame
  for (const z of [-120, 120]) { row(far, z, 38, 140, 12, false, 0.85, 1.2, 2.6); row(far, z, -46, -34, 12, false, 0.85, 1.2, 2.6); }                   // cross streets (skips x = 62: the hero row owns that corner)
  for (const [cx, cz] of [[-46, -48], [-47, 13], [-45.5, 67]]) for (let i = 0; i < 3; i++) {                                                           // loose clumps where the lawn meets the sand, like the Palisades bluff
    const x = cx + (rndP() - 0.5) * 7, z = cz + (rndP() - 0.5) * 12, sc = lerp(0.75, 1.15, rndP()); if (clear(x, z, 16 * sc, 2.6)) { far.push([x, z, sc]); palms.push({ x, z, h: 16 * sc, crown: 2.6 * sc, kind: 'fan' }); } }
  const farUsed = far.filter((s, i) => Math.abs(s[0] - 62) > 5 || Math.abs(Math.abs(s[1]) - 120) > 6 || s[2] > 1.3).filter((s, i) => !S.low || i % 2 === 0);

  const fanMat = palmMat(16, 0.035, 2.6), farGeo = fanPalm(20, S.pick(7, 5), 5, S.rng(77));
  if (S.low) instanced(farGeo, fanMat, near.concat(farUsed), S.rng(9), 0.09);   // low: one LOD, one draw
  else { instanced(fanPalm(24, 9, 6, S.rng(76)), fanMat, near, S.rng(9), 0.09); instanced(farGeo, fanMat, farUsed, S.rng(10), 0.08); }

  // date palms: four corner heroes whose drooping crowns frame the top corners of the play view, + a cluster of 3 on the west lawn. The
  // spec's cluster box (x -20..-26) is where the neighbour courts stand, and beside the shade sails they filled the one open wedge of the
  // play frame (30-36 deg off axis), so the cluster stands just west of the courts' windscreen: out of the play frame, in every wide one.
  const dates = [[13.2, 18.4, 1.0], [13.2, -18.4, 0.94], [-14.2, 18.4, 0.92], [-14.2, -18.4, 1.04], [-29.6, -5.2, 0.9], [-29.9, 5, 1.0], [-30.3, 15.2, 1.05]].filter(([x, z, sc]) => clear(x, z, 9 * sc, 0))
    .map(([x, z, sc], i) => [x, z, sc, i < 4 ? Math.atan2(z, x) : undefined]);   // corner heroes lean away from the court and stand at x +13.2 / -14.2: seen from a baseline the crown then spans ~17-31 deg off axis (its inner
    // fronds only just reach the ball band's outer edge, and date fronds are stiff: reach 1.4), which leaves the
    // outer 30-36 deg of the frame open sky at BOTH top corners: the only air the play camera has for wind.js's breeze lines outside the fx ban
  dates.forEach(([x, z, sc]) => palms.push({ x, z, h: 9 * sc, crown: 4.2 * sc, kind: 'date' }));
  instanced(datePalm(S.pick(42, 24), S.pick(7, 5), S.rng(31)), palmMat(9, 0.012, 1.4), dates, S.rng(32), 0.085);

  // ---- the skyline row: skinny fan palms 150-185 m beyond each baseline, right across the centre gap, crowns 3-5.5 deg up. From the
  // play camera (top of frame ~8 deg) every nearer crown is out of shot, so THIS row is the palm silhouette the player and the blurred
  // menu actually see. It may stand in the calm corridor because it is what the rule allows there: static (no sway at all), far, and
  // held at a hazed mid value by its own blue-grey aerial haze (scene fog would bleach it to cream against the sky).
  { const spots = [], rr = S.rng(6021);
    for (const sg of [-1, 1]) for (let x = -58; x <= 112; x += lerp(7, 13, rr())) { const z = sg * lerp(150, 185, rr()), sc = lerp(0.78, 1.22, rr()) * (rr() < 0.2 ? 0.8 : 1);
      if (Math.hypot(x, z) > 198 || Math.abs(x - 62) < 6 || rr() < 0.1) continue; spots.push([x, z, sc]); }   // the hero row owns x = 62; west of x -58 is open sand
    const used = spots.filter((p, i) => !S.low || i % 2 === 0), haze = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide, fog: false });
    haze.onBeforeCompile = sh => { sh.uniforms.uHaze = { value: C('#9fb4c9') };
      sh.fragmentShader = 'uniform vec3 uHaze;\n' + sh.fragmentShader.replace('#include <normal_fragment_begin>', '#include <normal_fragment_begin>\n#ifdef DOUBLE_SIDED\n normal *= faceDirection;\n#endif').replace('#include <opaque_fragment>', '#include <opaque_fragment>\n gl_FragColor.rgb = mix(gl_FragColor.rgb, uHaze, 0.45);'); };
    haze.customProgramCacheKey = () => 'flora-skyline';
    const geo = fanPalm(16, 5, 4, S.rng(78)), mesh = group.children.length; instanced(geo, haze, used, S.rng(11), 0.07); group.children[mesh].name = 'skyline'; }

  // ---- broadleaf trees: 2-3 overlapping faceted lobes on a short trunk, greyscale vertex shade x instanceColor. Lit tops, dark
  // undersides, per-facet tone so a canopy breaks up like foliage instead of shining like a gumdrop; heights vary so the top edge is a
  // tree line, not a row of equal domes. Ficus bowl (kept <= 5 m, a step darker and perfectly still inside the calm corridor: it is
  // the mid-green step of the value ladder behind the far fence), street trees, the far tree-mass band (outside the corridor only), jacarandas.
  const blobGeo = new THREE.IcosahedronGeometry(1, 1), bp = blobGeo.attributes.position, bn = blobGeo.attributes.normal;
  for (let i = 0; i < bp.count; i++) { const x = bp.getX(i), y = bp.getY(i), z = bp.getZ(i), l = 1 + 0.2 * Math.sin(7.3 * x + 1.7) * Math.sin(6.1 * y + 0.4) * Math.sin(8.2 * z + 2.9) + 0.09 * Math.sin(13 * x * y + 9 * z);   // position-keyed: shared corners stay welded
    bp.setXYZ(i, x * l, (Math.max(y * l, -0.3) + 0.3) / 1.35, z * l); }
  blobGeo.computeVertexNormals();                                                                                           // non-indexed: facet normals
  { const col = new Float32Array(bp.count * 3), o = new THREE.Vector3(), f = new THREE.Vector3(), rf = S.rng(88);
    for (let t = 0; t < bp.count; t += 3) { const cy = (bp.getY(t) + bp.getY(t + 1) + bp.getY(t + 2)) / 3, tone = lerp(0.5, 1.1, S.smoothstep(0.05, 0.9, cy)) * lerp(0.9, 1.08, rf());
      for (let i = t; i < t + 3; i++) { o.fromBufferAttribute(bp, i); o.y = o.y * 1.35 + 0.1; o.normalize(); f.fromBufferAttribute(bn, i); o.multiplyScalar(0.5).addScaledVector(f, 0.5).normalize(); bn.setXYZ(i, o.x, o.y, o.z);   // half facet, half dome: faceted like the palms and clouds, still one soft sunlit mass
        col[i * 3] = col[i * 3 + 1] = col[i * 3 + 2] = tone; } }
    blobGeo.setAttribute('color', new THREE.BufferAttribute(col, 3)); }
  const blobs = [], sticks = [], rndB = S.rng(5150);
  const blob = (x, y, z, w, h, col) => blobs.push([x, y, z, w, h, col]);
  const tree = (x, z, w, h, col, trunkH) => { if (!clear(x, z, h + trunkH, w * 0.3)) return; const calm = S.inCorridor(Math.abs(x) - w, z), lobes = calm ? 2 : rndB() < 0.5 ? 3 : 2, a0 = rndB() * 6.2832;
    blob(x, trunkH, z, w, h, col);                                                                                          // the canopy starts at the top of a bare trunk: a band of shade under every tree
    for (let k = 1; k < lobes; k++) { const a = a0 + k * 2.4 + rndB(), d = w * lerp(0.3, 0.42, rndB());
      blob(x + Math.cos(a) * d, trunkH + h * lerp(0.0, 0.18, rndB()), z + Math.sin(a) * d, w * lerp(0.55, 0.75, rndB()), h * lerp(0.6, 0.85, rndB()), col.clone().multiplyScalar(lerp(0.88, 1.06, rndB()))); }
    sticks.push([x, z, trunkH + h * 0.4, 0.13 + 0.03 * h]); };
  for (const sg of [-1, 1]) {
    for (let r = 0; r < 2; r++) for (let x = -29 + r * 2.6; x <= 13.5; x += 5.2) {                                  // ficus bowl, two staggered rows
      const z = sg * (24.5 + r * 8.5 + rndB() * 3), xx = x + (rndB() - 0.5) * 1.5, edge = Math.abs(xx) - S.corridorHalf(z), k = S.smoothstep(0, 9, edge), hv = rndB(), wv = rndB(), cv = rndB(), tv = rndB();
      if (Math.hypot(xx + 15, z - sg * 32) < 5.5 || (r === 0 && Math.abs(xx + 12) < 3.4)) continue;                        // leave the jacarandas their sky, and park.js's garden walk its way through the front row
      if (xx < -17.5) continue;                                                                                             // the beach side is left OPEN: lawn, palm trunks, sand, sea, the pier wheel (walled in, it was the darkest, heaviest third of the side-1 frame)
      const trunk = lerp(1.3, 1.9, tv) + (edge > 2 ? 0.5 : 0), total = Math.min(lerp(3.6 + r * 0.5, 4.95, hv) + k * lerp(0.6, 2.2, rndB()), edge < 1.5 ? 4.95 : 99);   // <= 5 m anywhere near the corridor (the layout rule), and never two the same
      tree(xx, z, lerp(6.4, 8.4, wv), total - trunk, mix(pal.leafLit, pal.leafDark, lerp(0.8, 0.35, k) + 0.4 * cv).multiplyScalar(lerp(0.74, 1, k)), trunk);   // behind the ball: a step DARKER than it (measured ratio 1.28 at 0.86), and calm
    }
    for (let z = 12, n = 0; z <= 90; z += 19.5, n++) { const jac = (n + (sg > 0 ? 1 : 0)) % 3 === 1;                                                // boulevard street trees in park.js's x 44-48 sidewalk, every third a jacaranda
      tree(46 + (rndB() - 0.5), sg * (z + rndB() * 5), lerp(5.2, 6.4, rndB()), lerp(3.4, 4.4, rndB()), jac ? mix(pal.jacaranda, pal.jacarandaLit, rndB() * 0.6) : mix(pal.leafLit, pal.leafDark, 0.3 + 0.7 * rndB()), 2.8); }
    if (!S.low) for (let r = 0; r < 2; r++) for (let x = -25 + r * 8; x <= 124; x += 16) {                                // far tree-mass band (low: gone, it is pure fill)
      const z = sg * (134 + r * 22 + rndB() * 8), xx = x + (rndB() - 0.5) * 5, w = lerp(19, 26, rndB()), edge = Math.abs(xx) - w * 0.4 - S.corridorHalf(z);
      if (edge < 0 || Math.hypot(xx, z) > 196) continue;
      blob(xx, -1, z, w, lerp(7, lerp(10, 15, rndB()), S.smoothstep(0, 28, edge)), mix(pal.treeMassFar, pal.leafDark, rndB() * 0.25));
    }
  }
  for (const [x, z, away] of [[-14, -30, -1], [-16, 34, -1], [-40, 22, 1]]) {                                          // jacarandas: lilac clouds on a forked trunk, leaning away from the corridor
    const h = lerp(3.0, 3.6, rndB()); sticks.push([x, z, h + 1.2, 0.2]);
    blob(x + away * 0.6, h - 0.4, z, 5.6, 3.6, mix(pal.jacaranda, pal.jacarandaLit, 0.3));                                 // a bumpy cloud of small domes, not one boulder
    for (let i = 0; i < 4; i++) { const a = i * 1.57 + rndB(), d = lerp(1.9, 2.7, rndB()); blob(x + away * 0.6 + Math.cos(a) * d, h - 0.2 + rndB() * 1.3, z + Math.sin(a) * d, lerp(3.0, 4.0, rndB()), lerp(2.2, 3.0, rndB()), mix(pal.jacaranda, pal.jacarandaLit, rndB())); }
  }
  const isJac = b => b[5].b > b[5].g, used = blobs.filter((b, i) => !S.low || i % 2 === 0 || isJac(b) || S.inCorridor(b[0], b[2]));                   // low: half the blobs, but jacarandas stay whole
  const blobMat = S.sway(new THREE.MeshLambertMaterial({ vertexColors: true }), `
    float calm = smoothstep(0.0, 4.0, abs(O.x) - (9.0 + 0.2 * max(0.0, abs(O.z) - 13.0)) - 4.0);                         // dead still anywhere near the ball's backdrop
    P.xz += uWind.xy * (calm * position.y * position.y * sScale * (0.035 * sWind(O.xz) + 0.012 * sin(1.7 * uTime + 6.283 * sHash(O.xz) + 3.0 * position.x)));`);
  { const sway = blobMat.onBeforeCompile; blobMat.onBeforeCompile = sh => { sway(sh);   // blossom is translucent: a backlit jacaranda (side 1 looks into the sun) must stay lilac, not go to a dark violet lump
      sh.fragmentShader = sh.fragmentShader.replace('#include <emissivemap_fragment>', '#include <emissivemap_fragment>\n totalEmissiveRadiance += diffuseColor.rgb * 0.4 * smoothstep(0.0, 0.12, diffuseColor.b - diffuseColor.g);'); };
    blobMat.customProgramCacheKey = () => 'flora-blobs'; }
  const bim = new THREE.InstancedMesh(blobGeo, blobMat, used.length);
  used.forEach(([x, y, z, w, h, col], i) => { Q.setFromAxisAngle(AX.set(0, 1, 0), rndB() * 6.2832); bim.setMatrixAt(i, M.compose(P.set(x, y, z), Q, SC.set(w / 2, h, w / 2 * lerp(0.85, 1.1, rndB())))); bim.setColorAt(i, col); });
  bim.frustumCulled = false; group.add(bim);

  // ---- static merged mesh: hedges at |x| = 10.4 (1.6 m: under the 2.4 m cap, peeking over the side fences), 3 bougainvillea clumps
  // per side (magenta is nowhere near the ball's yellow-white-orange, and it never moves), and the trunks of the blob trees.
  const parts = [], rndH = S.rng(808), prof = [[-0.5, 0], [-0.58, 1.05], [-0.28, 1.58], [0.28, 1.6], [0.58, 1.05], [0.5, 0]];
  const hedge = (x, z0, z1) => {
    const n = Math.round((z1 - z0) / 1.7), st = [], tris = [];
    for (let k = 0; k <= n; k++) { const sw = 1 + (rndH() - 0.5) * 0.18, sh = 1 + (rndH() - 0.5) * 0.12, z = lerp(z0, z1, k / n); st.push(prof.map(([px, py]) => ({ p: V(x + px * sw, py * sh, z), c: mix(pal.fanDark, pal.hedge, 0.2 + py * 0.75).lerp(C(pal.leafLit), py > 1.5 ? 0.3 : 0) }))); }
    for (let k = 0; k < n; k++) for (let j = 0; j < prof.length - 1; j++) { const a = st[k][j], b = st[k][j + 1], c = st[k + 1][j], d = st[k + 1][j + 1]; tris.push(a, c, b, b, c, d); }
    for (const e of [st[0], st[n]]) for (let j = 1; j < prof.length - 1; j++) tris.push(e[0], e[j], e[j + 1], e[0], e[j + 1], e[j]);
    const g = soupGeo(tris); g.deleteAttribute('aFr'); parts.push(g);
  };
  hedge(10.4, -13.4, 13.4); hedge(-10.4, -13.4, -1.3); hedge(-10.4, 1.3, 13.4);                                            // the west gap is the way through to the shade sails
  const clump = (x, y, z, r) => { const g = new THREE.IcosahedronGeometry(r, 1), p = g.attributes.position, c = new Float32Array(p.count * 3), t = new THREE.Color();
    for (let i = 0; i < p.count; i++) { const a = p.getX(i), b = p.getY(i), d = p.getZ(i), hsh = Math.sin(a * 37.1 + b * 53.7 + d * 29.3) * 43758.5, l = 0.8 + 0.55 * (hsh - Math.floor(hsh)); p.setXYZ(i, a * l, b * l * 0.9, d * l * 1.25); }   // position-keyed spikes (shared corners agree): sprays of bracts, not a pebble
    // whole FACETS of colour, never a blend across one: a magenta-to-green gradient over a big triangle is a watermelon. Two magentas, and
    // about one facet in seven is leaf; the hedge supplies the rest of the green. Kept dark: the 3.35 sun bleaches magenta to candy pink.
    for (let f = 0; f < p.count; f += 3) { const cy = (p.getY(f) + p.getY(f + 1) + p.getY(f + 2)) / 3, up = S.clamp(cy / r * 0.5 + 0.5, 0, 1), k = rndH();
      if (k < 0.14) t.lerpColors(C(pal.fanDark), C(pal.hedge), up); else t.copy(C(k < 0.6 ? pal.bougainvillea : pal.bougainvilleaLit)).multiplyScalar(lerp(0.5, 0.85, up));
      for (let i = f; i < f + 3; i++) c.set([t.r, t.g, t.b], i * 3); }
    g.setAttribute('color', new THREE.BufferAttribute(c, 3)); g.computeVertexNormals(); g.translate(x, y, z); g.deleteAttribute('uv'); parts.push(g); };
  for (const [sx, zs] of [[1, [-9, 0.5, 8.5]], [-1, [-8, -3.2, 9.5]]]) for (const z of zs) { const x = sx * 10.75; if (S.keepOut(x, z, 1.2)) continue;
    clump(x, 1.4, z, 0.78); clump(x + sx * 0.2, 1.05, z + 1.1, 0.6); clump(x - sx * 0.15, 1.6, z - 0.95, 0.5); }
  for (const [x, z, h, r] of sticks) { const g = new THREE.CylinderGeometry(r * 0.7, r * 1.25, h, 5, 1, true); g.translate(x, h / 2, z); g.deleteAttribute('uv'); S.paint(g, (px, py, pz, i, c) => c.lerpColors(C(pal.trunkDark), C(pal.trunkLit), py / h * 0.5)); parts.push(g); }
  const stat = new THREE.Mesh(S.merge(parts), new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide })); stat.frustumCulled = false; group.add(stat);

  group.userData.palms = palms;   // park.js may read this for painted shadows: [{ x, z, h, crown, kind }]
  return { group, update() {} };  // all motion lives in the shared uniforms index.js ticks: nothing to do, nothing allocated
}
