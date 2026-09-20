# Scenery: everything beyond the fences (web/scenery/)

The brief, in the player's words: "make the surroundings beyond the court nicer ... a more authentic LA scene, palm
trees, some wind breeze lines here and there, nice sky". It is also the backdrop of the main menu, where the live court
is shown **blurred** behind the buttons: big shapes, strong silhouettes and colour matter more than fine detail.

## How it plugs in (already wired, do not edit web/scene.js)
`scene.js` does `import('./scenery/index.js')` and calls
`createScenery(THREE, ctx)` once, then `scenery.update(dt, timeS, camera)` every frame.

    ctx = { scene, renderer, camera, sun /* the one DirectionalLight, casts the court's shadows */, hemi /* HemisphereLight */,
            fog /* scene.fog, THREE.Fog */, plainSky /* [mesh, ...] the old gradient dome + sphere clouds: hide them if you
            replace them */, court: () => ({ halfW, halfL, ... }), side: () => 0 | 1 /* which end the local player is at */ }
    returns { update(dt, timeS, camera) }

`THREE` is the r160 UMD global, passed in. No imports from a CDN, no network, no image/model files: geometry is built in
code and textures are drawn on a canvas (the whole game is original assets and loads offline).

## Modules (one owner each, all under web/scenery/)
- `index.js`   createScenery: builds the shared context, calls the four modules, applies lighting/fog, hides plainSky, fans out update().
- `shared.js`  palette, seeded rng, `wind(x, z, t) -> { x, z, gust }` (ONE wind field: palms, breeze lines, clouds and leaves all
               lean the same way at the same moment), canvas-texture helper, quality switch.
- `sky.js`     sky dome, sun disc and glow, clouds that drift, horizon haze, the far distance (hills, a downtown skyline).
- `flora.js`   palms (tall skinny Mexican fan palms in street rows are THE LA silhouette, plus fuller date palms), hedges, flowers.
- `park.js`    the ground and built things between the fences and the distance: grass, paths, neighbouring courts, benches,
               lamp posts, low walls, whatever the art direction calls for.
- `wind.js`    breeze lines (the curling white streaks of a stylised game wind), drifting leaves, a few distant birds.
Each module exports `create(THREE, S) -> { group, update(dt, t, camera) }` where `S` is the shared context from index.js
(`S.ctx`, `S.pal`, `S.rng(seed)`, `S.wind`, `S.tex`, `S.quality`).

## Rules that protect the game
- **The ball must stay readable.** It is small, yellow-white, with a white/yellow/orange/red trail. From either end the
  player looks down the court at the far baseline and its dark green windscreen fence: that fence stays. Behind and above
  it, up to about 7 m, keep things calm: mid values, large shapes, no small bright or high-contrast detail, nothing
  yellow/white/orange that moves. Palm crowns belong higher than that or off to the sides.
- **Both ends are played.** Side 0 looks toward -z, side 1 toward +z, and the camera is head-coupled (it slides and the
  projection skews). Dress all four directions; nothing may be a flat card that gives itself away when the camera moves.
- **Keep clear:** |x| < 9 and |z| < 13 is court, run-off and fences. Nothing of yours inside it, nothing casting real
  shadows into it (`castShadow = false` everywhere; the sun's shadow frustum is fitted to the court). Painted/fake
  shadows on your own ground are welcome.
- **Budget** for the whole of web/scenery/: <= 40 draw calls, <= 90k triangles, <= 8 MB of textures, no allocation in
  update(), sway done in the vertex shader or on a handful of instance matrices. A MacBook runs this next to a webcam
  pose model at 60 fps and must keep doing so. `S.quality` 'low' must halve the cost.
- **Lighting** may shift (warmer sun, new fog and hemisphere colours) but the court, lines, paddles and ball must keep
  their contrast, and the sun must stay high enough that court shadows stay short and readable.
- Deterministic: seeded rng only, animation driven by the `t` passed in (the preview harness freezes time for screenshots).

## Seeing it
`test/scene-preview.html` renders the real scene with a fake rally: `?side=0|1`, `&t=<s>` freezes time,
`&look=px,py,pz,tx,ty,tz[,fov]` places a debug camera. Serve the repo root over http on your own port.
