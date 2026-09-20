// Real sideways tracking: the laptop webcam watches you. The AirPod can't sense position, the camera can.
// Works at any distance as long as you're in frame: the court maps onto the camera's view, not onto metres.
// From wherever you calibrated, moving REACH of the frame width to either side (less if an edge is nearer) = sideline.
// Close up a fast face detector finds you; further back, or with your head turned, a body-pose model takes over.
const EDGE = 0.08;                                    // keep this much of the frame as margin so you never have to leave it

export async function createBodyTracker(video, canvas) {
  const T = { ready: false, error: null, reach: 0.3, seenAt: 0, cx: 0.5, cx0: 0.5, fps: 0, via: '-' };
  let detector, poser, ctx = canvas.getContext('2d'), lastT = 0, lastPose = 0;
  T.seen = () => T.ready && performance.now() - T.seenAt < 400;
  // here is centre
  T.center = () => { T.cx0 = T.cx; };
  // local court metres, + = your right. The camera faces you, so your right is the image's left.
  const span = dir => Math.max(0.05, Math.min(T.reach, dir < 0 ? T.cx0 - EDGE : 1 - EDGE - T.cx0));    // frame fraction available on that side
  T.x = () => { const d = T.cx - T.cx0; return -d / span(d) * 3.0; };
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
      let cx = null;
      if (d) { cx = (d.boundingBox.originX + d.boundingBox.width / 2) / W; T.via = 'face'; }
      else if (poser && now - lastPose > 50) {                       // heavier model: only when the face is lost, and at most 20 Hz
        lastPose = now;
        const L = (poser.detectForVideo(video, now).landmarks || [])[0];
        if (L) { const vis = i => (L[i].visibility == null ? 1 : L[i].visibility);
          if (vis(0) > 0.5) cx = L[0].x; else if (vis(11) > 0.5 && vis(12) > 0.5) cx = (L[11].x + L[12].x) / 2;
          if (cx != null) T.via = 'body'; }
      }
      if (cx != null) {
        const a = Math.min(0.9, 0.3 + Math.abs(cx - T.cx) * 25);            // calm when still, quick when you move
        T.cx += (cx - T.cx) * a;
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
    ctx.fillStyle = ok ? '#4ade80' : '#ff6b6b'; ctx.beginPath(); ctx.arc((1 - T.cx) * w, h * 0.45, 6, 0, 7); ctx.fill();
    ctx.strokeStyle = '#ffe066';                                                                                    // where the sidelines are
    for (const dir of [-1, 1]) { const x = (1 - (T.cx0 + dir * span(dir))) * w; ctx.beginPath(); ctx.moveTo(x, h * 0.2); ctx.lineTo(x, h * 0.8); ctx.stroke(); }
  }
  frame();
  return T;
}
