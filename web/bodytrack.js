// Real sideways tracking: the laptop webcam watches you. The AirPod can't sense position, the camera can.
// Works at any distance as long as you're in frame: the court maps onto the camera's view, not onto metres.
// From wherever you calibrated, moving REACH of the frame width to either side (less if an edge is nearer) = sideline.
// Close up a fast face detector finds you; further back, or with your head turned, a body-pose model takes over.
function oneEuro(minCut, beta) {
  let x = null, dx = 0, t0 = 0; const al = (cut, dt) => 1 / (1 + 1 / (2 * Math.PI * cut * dt));
  return (v, t) => { if (x == null) { x = v; t0 = t; return x; }
    const dt = Math.max(1e-3, (t - t0) / 1000); t0 = t;
    dx += ((v - x) / dt - dx) * al(1.0, dt);
    x += (v - x) * al(minCut + beta * Math.abs(dx), dt); return x; };
}
const EDGE = 0.08;                                    // keep this much of the frame as margin so you never have to leave it

export async function createBodyTracker(video, canvas) {
  const T = { ready: false, error: null, reach: 0.3, reachY: 0.14, seenAt: 0, cx: 0.5, cx0: 0.5, cy: 0.5, cy0: 0.5, fw: 0, fw0: 0, fps: 0, via: '-' };
  const fx = oneEuro(0.7, 9), fy = oneEuro(0.7, 9), fw = oneEuro(0.35, 4);        // face size is noisier: smooth it harder
  let detector, poser, ctx = canvas.getContext('2d'), lastT = 0, lastPose = 0;
  T.seen = () => T.ready && performance.now() - T.seenAt < 400;
  // here is centre
  T.center = () => { T.cx0 = T.cx; T.cy0 = T.cy; T.fw0 = T.fw; };
  // local court metres, + = your right. The camera faces you, so your right is the image's left.
  const span = dir => Math.max(0.05, Math.min(T.reach, dir < 0 ? T.cx0 - EDGE : 1 - EDGE - T.cx0));    // frame fraction available on that side
  T.x = () => { const d = T.cx - T.cx0; return -d / span(d) * 3.0; };
  // Depth: your face gets bigger as you step toward the laptop. distance ~ 1/size, so size0/size - 1 is how much
  // further (+) or closer (-) you are than where you calibrated. 30% closer = up at the kitchen line; 20% back = baseline.
  // Returns distance from the net in metres (6.5 = where you calibrated), or null when only the body model sees you.
  T.z = () => { if (!T.fw0 || !T.fw || T.via !== 'face') return null; const rel = T.fw0 / T.fw - 1; return 6.5 + (rel < 0 ? rel * 13 : rel * 3.5); };
  // paddle height, metres: standing as calibrated = 1.0; duck to go low, stretch up to go high (image y grows downward)
  T.y = () => 1.0 - (T.cy - T.cy0) / T.reachY * 0.8;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 360, facingMode: 'user', frameRate: { ideal: 60 } }, audio: false });
    video.srcObject = stream; await video.play();
    const { FilesetResolver, FaceDetector, PoseLandmarker } = await import('./vendor/mp/vision_bundle.js');
    const files = await FilesetResolver.forVisionTasks('./vendor/mp/wasm');
    detector = await FaceDetector.createFromOptions(files, { baseOptions: { modelAssetPath: './vendor/mp/face.tflite', delegate: 'GPU' }, runningMode: 'VIDEO', minDetectionConfidence: 0.5 });
    poser = await PoseLandmarker.createFromOptions(files, { baseOptions: { modelAssetPath: './vendor/mp/pose.task', delegate: 'GPU' }, runningMode: 'VIDEO', numPoses: 1 }).catch(() => null);
    T.ready = true;
  } catch (e) { T.error = e.message || String(e); return T; }

  function frame() {
    const now = performance.now();
    if (video.readyState >= 2 && now - lastT > 12) {
      const res = detector.detectForVideo(video, now), d = res.detections && res.detections[0], W = video.videoWidth || 640;
      let cx = null, cy = null; const Hh = video.videoHeight || 360;
      if (d) {                                                         // keypoints (eyes, nose, mouth, ears) are steadier than the box
        const K = d.keypoints || [];
        if (K.length >= 4) { cx = K.reduce((a, k) => a + k.x, 0) / K.length; cy = K.reduce((a, k) => a + k.y, 0) / K.length; }
        else { cx = (d.boundingBox.originX + d.boundingBox.width / 2) / W; cy = (d.boundingBox.originY + d.boundingBox.height / 2) / Hh; }
        T.via = 'face'; T.fw = fw(d.boundingBox.width / W, now); }
      else if (poser && now - lastPose > 50) {                       // heavier model: only when the face is lost, and at most 20 Hz
        lastPose = now;
        const L = (poser.detectForVideo(video, now).landmarks || [])[0];
        if (L) { const vis = i => (L[i].visibility == null ? 1 : L[i].visibility);
          if (vis(0) > 0.5) { cx = L[0].x; cy = L[0].y; } else if (vis(11) > 0.5 && vis(12) > 0.5) { cx = (L[11].x + L[12].x) / 2; cy = (L[11].y + L[12].y) / 2 - 0.12; }
          if (cx != null) T.via = 'body'; }
      }
      if (cx != null) {
        if (now - T.seenAt > 500) { T.cx = cx; T.cy = cy; }               // just came back into view: don't glide in from the old spot
        T.cx = fx(cx, now); T.cy = fy(cy, now);
        T.fps += (1000 / Math.max(1, now - lastT) - T.fps) * 0.05; T.seenAt = now;
      }
      lastT = now; draw(now);
    }
    (video.requestVideoFrameCallback ? video.requestVideoFrameCallback.bind(video) : requestAnimationFrame)(frame);
  }
  function draw(now) {
    const w = canvas.width, h = canvas.height, ok = now - T.seenAt < 300;
    ctx.save(); ctx.translate(w, 0); ctx.scale(-1, 1); ctx.drawImage(video, 0, 0, w, h); ctx.restore();          // mirrored, like a mirror
    ctx.strokeStyle = 'rgba(255,255,255,.55)'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo((1 - T.cx0) * w, 0); ctx.lineTo((1 - T.cx0) * w, h); ctx.stroke(); ctx.setLineDash([]);
    ctx.fillStyle = ok ? '#4ade80' : '#ff6b6b'; ctx.beginPath(); ctx.arc((1 - T.cx) * w, T.cy * h, 6, 0, 7); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,.4)'; ctx.setLineDash([4, 4]); ctx.beginPath(); ctx.moveTo(0, T.cy0 * h); ctx.lineTo(w, T.cy0 * h); ctx.stroke(); ctx.setLineDash([]);
    ctx.strokeStyle = '#ffe066';                                                                                    // where the sidelines are
    for (const dir of [-1, 1]) { const x = (1 - (T.cx0 + dir * span(dir))) * w; ctx.beginPath(); ctx.moveTo(x, h * 0.2); ctx.lineTo(x, h * 0.8); ctx.stroke(); }
  }
  frame();
  return T;
}
