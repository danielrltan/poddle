// Records the live AirPod stream (read-only client) with an arrival timestamp `at` (ms). Usage: node test/record.mjs <out.jsonl> [seconds] [ws url]
import fs from 'fs';
const out = process.argv[2] || 'data/live-play.jsonl', secs = +(process.argv[3] || 60), url = process.argv[4] || 'ws://localhost:8787';
const ws = new WebSocket(url), f = fs.createWriteStream(new URL('../' + out, import.meta.url)); let n = 0;
ws.onmessage = e => { try { const s = JSON.parse(e.data); if (!s.q || !s.r) return; s.at = performance.timeOrigin + performance.now(); f.write(JSON.stringify(s) + '\n'); n++; } catch {} };
ws.onerror = () => { console.log('no stream at ' + url); process.exit(1); };
setTimeout(() => { ws.close(); f.end(() => { console.log(n + ' samples -> ' + out); process.exit(0); }); }, secs * 1000);
